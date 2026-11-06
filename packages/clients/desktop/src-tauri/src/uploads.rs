//! This window's uploads, as the desktop shell sees them (#837).
//!
//! The page holds the uploads: their files, their handles, their progress. The
//! shell only hears a summary, on every change, and uses it for three things:
//!
//! - **Quitting asks** while some run: quit now and resume them at the next
//!   start, quit once they end, or cancel. "Once they end" is a quit that waits
//!   here, in [`QuitGate`], until the page reports none left.
//! - **The tray says how they go**, in its tooltip and in the first line of its
//!   menu (Linux shows no tray tooltips): [`tray_text`], changed at most once a
//!   second by [`TrayTextThrottle`].
//! - **Nothing else.** While the page reports no upload, which is always the
//!   case while `[experimental] file_transfer` is off, every quit proceeds as it
//!   did, and the tray keeps its "Lasterm" and its menu.
//!
//! Everything here is plain state, so that the rules are testable without a
//! window; `lib.rs` carries the answers out.

use serde::Serialize;
use std::time::{Duration, Instant};

/// The tray's text while no upload runs: the one it was built with.
pub const TRAY_TEXT_IDLE: &str = "Lasterm";

/// The longest tooltip a Windows notification-area icon shows: 128 UTF-16
/// units, its terminating null included. [`tray_text`] stays within it.
#[cfg(test)]
pub const TRAY_TOOLTIP_MAX_UTF16: usize = 127;

/// The tray's text changes at most this often, so a fast upload does not
/// redraw it with every chunk.
pub const TRAY_TEXT_MIN_INTERVAL: Duration = Duration::from_secs(1);

/// What the page last said about the uploads this window sends.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UploadsReport {
    /// Uploads that have not ended: queued, sending, verifying, or waiting
    /// for an answer.
    pub in_progress: u32,
    /// Of those, the ones stopped on a conflict until someone answers.
    pub waiting: u32,
    /// Uploads that ended failed and are still listed. Said in the tray while
    /// others run; they keep nothing open.
    pub failed: u32,
    /// How far the bytes of those in progress are, in whole percent.
    pub percent: Option<u8>,
}

impl UploadsReport {
    /// The page's numbers, made consistent: no more waiting than in progress,
    /// a percentage floored into 0–100 (99.6 % is not done), and none for a
    /// value that is not a number.
    pub fn from_page(in_progress: u32, waiting: u32, failed: u32, percent: Option<f64>) -> Self {
        Self {
            in_progress,
            waiting: waiting.min(in_progress),
            failed,
            percent: percent
                .filter(|value| value.is_finite())
                .map(|value| value.clamp(0.0, 100.0).floor() as u8),
        }
    }

    /// Uploads still moving bytes, or queued to.
    fn moving(&self) -> u32 {
        self.in_progress - self.waiting
    }
}

/// What a waiting quit does once the uploads end: quit, or the restart a
/// window background asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Ending {
    Quit,
    Restart,
}

/// The three answers to "N uploads in progress".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Quit (or restart) now; the uploads are offered again at the next start.
    ResumeLater,
    /// Quit (or restart) once every upload of this window has ended.
    WhenFinished,
    /// Keep everything as it was.
    Cancel,
}

/// What a quit gesture does, given the uploads.
#[derive(Debug, PartialEq, Eq)]
pub enum Start {
    /// No upload runs: quit as before, asking nothing.
    Proceed,
    /// Ask, naming how many run.
    Ask { in_progress: u32 },
    /// The question is already on screen; it answers this gesture too.
    AlreadyAsking,
}

/// What the shell must do after an answer, a report or a cancel.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Quit (or restart) now.
    End(Ending),
    /// The quit (or restart) now waits for the uploads. A quit hides the
    /// window; `notify` counts the uploads already waiting for an answer, which
    /// nobody sees in a hidden window unless told.
    Wait {
        ending: Ending,
        notify: Option<u32>,
    },
    /// While a quit waits, more uploads stopped on a question in the hidden
    /// window: tell someone, once, since the app cannot end until they are
    /// answered.
    Notify {
        waiting: u32,
    },
}

/// A quit that waits for the uploads to end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pending {
    ending: Ending,
    /// How many waiting uploads were already told about. Lowered when one is
    /// answered, so the next one to wait is told about too.
    waiting_told: u32,
}

/// The question asked when quitting while uploads run, and the quit that
/// waits for them.
#[derive(Debug, Default)]
pub struct QuitGate {
    report: UploadsReport,
    seq: u64,
    asking: Option<Ending>,
    pending: Option<Pending>,
}

impl QuitGate {
    /// A quit (or restart) gesture.
    pub fn request(&mut self, ending: Ending) -> Start {
        if self.asking.is_some() {
            return Start::AlreadyAsking;
        }
        if self.report.in_progress == 0 {
            return Start::Proceed;
        }
        self.asking = Some(ending);
        Start::Ask {
            in_progress: self.report.in_progress,
        }
    }

    /// The answer to the question [`Self::request`] asked for.
    pub fn answer(&mut self, answer: Answer) -> Step {
        let Some(ending) = self.asking.take() else {
            return Step::Nothing;
        };
        match answer {
            // A quit already waiting keeps waiting: Cancel changes nothing.
            Answer::Cancel => Step::Nothing,
            Answer::ResumeLater => {
                self.pending = None;
                Step::End(ending)
            }
            // They may all have ended while the question was on screen.
            Answer::WhenFinished if self.report.in_progress == 0 => {
                self.pending = None;
                Step::End(ending)
            }
            Answer::WhenFinished => {
                let waiting = self.report.waiting;
                self.pending = Some(Pending {
                    ending,
                    waiting_told: waiting,
                });
                Step::Wait {
                    ending,
                    // A restart keeps its window on screen, question and all.
                    notify: (ending == Ending::Quit && waiting > 0).then_some(waiting),
                }
            }
        }
    }

    /// A report from the page. `seq` grows with each report a page sends; one
    /// that is not above the last arrived out of order and is dropped, since
    /// the page's calls run concurrently and a stale "1 in progress" landing
    /// after the final "0" would hold a waiting quit open for ever.
    pub fn report(&mut self, seq: u64, report: UploadsReport) -> Step {
        if seq <= self.seq {
            return Step::Nothing;
        }
        self.seq = seq;
        self.report = report;
        let Some(pending) = self.pending.as_mut() else {
            return Step::Nothing;
        };
        if report.in_progress == 0 {
            let ending = pending.ending;
            self.pending = None;
            return Step::End(ending);
        }
        let told = pending.waiting_told;
        pending.waiting_told = report.waiting;
        if pending.ending == Ending::Quit && report.waiting > told {
            Step::Notify {
                waiting: report.waiting,
            }
        } else {
            Step::Nothing
        }
    }

    /// A new document in the window: it holds no uploads yet, and numbers its
    /// reports from the start again. A quit waiting on the old document's
    /// uploads ends now, since they went with it.
    pub fn page_started(&mut self) -> Step {
        self.seq = 0;
        self.report = UploadsReport::default();
        match self.pending.take() {
            Some(pending) => Step::End(pending.ending),
            None => Step::Nothing,
        }
    }

    /// Cancel the quit that waits, from the tray or the page. True when there
    /// was one.
    pub fn cancel_pending(&mut self) -> bool {
        self.pending.take().is_some()
    }

    pub fn pending(&self) -> Option<Ending> {
        self.pending.map(|pending| pending.ending)
    }

    pub fn uploads(&self) -> UploadsReport {
        self.report
    }
}

fn plural(count: u32, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The tray's tooltip, and its menu's first line: "Lasterm — 2 uploads · 64 %
/// · 1 failed", "Lasterm — 1 waiting for an answer", "Lasterm — quits when 2
/// uploads finish · 64 %", or "Lasterm" when none runs.
pub fn tray_text(uploads: &UploadsReport, pending: Option<Ending>) -> String {
    if uploads.in_progress == 0 {
        return TRAY_TEXT_IDLE.to_string();
    }
    let mut parts = Vec::with_capacity(4);
    let all_waiting = uploads.moving() == 0;
    parts.push(match pending {
        Some(ending) => format!(
            "{} when {} {}",
            match ending {
                Ending::Quit => "quits",
                Ending::Restart => "restarts",
            },
            plural(uploads.in_progress, "upload", "uploads"),
            if uploads.in_progress == 1 {
                "finishes"
            } else {
                "finish"
            },
        ),
        None if all_waiting => format!("{} waiting for an answer", uploads.waiting),
        None => plural(uploads.in_progress, "upload", "uploads"),
    });
    if let Some(percent) = uploads.percent.filter(|_| !all_waiting) {
        parts.push(format!("{percent} %"));
    }
    if uploads.waiting > 0 && !(all_waiting && pending.is_none()) {
        parts.push(format!("{} waiting for an answer", uploads.waiting));
    }
    if uploads.failed > 0 {
        parts.push(format!("{} failed", uploads.failed));
    }
    format!("{TRAY_TEXT_IDLE} — {}", parts.join(" · "))
}

/// What to do with a new tray text.
#[derive(Debug, PartialEq, Eq)]
pub enum TrayTextStep {
    /// Show it now: [`TrayTextThrottle::shown`] is the text to show.
    Show,
    /// Too soon after the last change: offer it again after this delay, by
    /// [`TrayTextThrottle::timer_fired`].
    Later(Duration),
    /// Nothing to change, or a timer is already set for it.
    Keep,
}

/// Keeps the tray's text changing at most once a second, and only when it
/// differs. The latest text wins: one offered while a change waits for its
/// slot replaces the one that waited.
#[derive(Debug)]
pub struct TrayTextThrottle {
    shown: String,
    shown_at: Option<Instant>,
    queued: Option<String>,
    timer_set: bool,
}

impl Default for TrayTextThrottle {
    fn default() -> Self {
        Self {
            shown: TRAY_TEXT_IDLE.to_string(),
            shown_at: None,
            queued: None,
            timer_set: false,
        }
    }
}

impl TrayTextThrottle {
    pub fn offer(&mut self, text: String, now: Instant) -> TrayTextStep {
        if text == self.shown {
            // Back to what is shown: whatever waited is no longer news.
            self.queued = None;
            return TrayTextStep::Keep;
        }
        if let Some(at) = self.shown_at {
            let since = now.saturating_duration_since(at);
            if since < TRAY_TEXT_MIN_INTERVAL {
                self.queued = Some(text);
                if self.timer_set {
                    return TrayTextStep::Keep;
                }
                self.timer_set = true;
                return TrayTextStep::Later(TRAY_TEXT_MIN_INTERVAL - since);
            }
        }
        self.shown = text;
        self.shown_at = Some(now);
        self.queued = None;
        TrayTextStep::Show
    }

    /// The delay [`TrayTextStep::Later`] asked for has passed.
    pub fn timer_fired(&mut self, now: Instant) -> TrayTextStep {
        self.timer_set = false;
        match self.queued.take() {
            Some(text) => self.offer(text, now),
            None => TrayTextStep::Keep,
        }
    }

    pub fn shown(&self) -> &str {
        &self.shown
    }
}

/// The tray menu's lines above "Show Lasterm" and "Quit", which exist only
/// while there is something to say: none while no upload runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TrayMenuTop {
    /// The tray's text as a disabled first line.
    pub status: bool,
    /// "Cancel quit when finished" (or restart), while one waits.
    pub cancel: Option<Ending>,
}

impl TrayMenuTop {
    pub fn for_state(shown: &str, pending: Option<Ending>) -> Self {
        Self {
            status: shown != TRAY_TEXT_IDLE,
            cancel: pending,
        }
    }

    pub fn is_empty(&self) -> bool {
        !self.status && self.cancel.is_none()
    }
}

/// The words of the tray menu's line that cancels a waiting quit.
pub fn cancel_pending_label(ending: Ending) -> &'static str {
    match ending {
        Ending::Quit => "Cancel quit when finished",
        Ending::Restart => "Cancel restart when finished",
    }
}

/// The words of the question, and of its three buttons.
#[derive(Debug, PartialEq, Eq)]
pub struct Question {
    pub title: &'static str,
    pub message: String,
    pub resume_later: &'static str,
    pub when_finished: &'static str,
    pub cancel: &'static str,
}

pub fn question(ending: Ending, in_progress: u32) -> Question {
    let uploads = plural(in_progress, "upload", "uploads");
    // One upload is resumed as "it", and ends; several as "them", and end.
    let (them, they_end) = if in_progress == 1 {
        ("it", "it ends")
    } else {
        ("them", "they end")
    };
    match ending {
        Ending::Quit => Question {
            title: "Quit Lasterm",
            message: format!(
                "{uploads} in progress.\n\nQuit now and resume {them} at the next start, or keep \
                 Lasterm running hidden and quit once {they_end}."
            ),
            resume_later: "Quit and resume later",
            when_finished: "Quit when finished",
            cancel: "Cancel",
        },
        Ending::Restart => Question {
            title: "Restart Lasterm",
            message: format!(
                "{uploads} in progress.\n\nRestart now and resume {them} after the restart, or \
                 restart once {they_end}."
            ),
            resume_later: "Restart and resume later",
            when_finished: "Restart when finished",
            cancel: "Cancel",
        },
    }
}

/// The answer a pressed button's label gives. Anything else, the dialog closed
/// by Esc or its close box included, is Cancel.
pub fn answer_for_label(question: &Question, label: &str) -> Answer {
    if label == question.resume_later {
        Answer::ResumeLater
    } else if label == question.when_finished {
        Answer::WhenFinished
    } else {
        Answer::Cancel
    }
}

/// The words of the notice that asks for an answer a waiting quit needs. Other
/// uploads may run beside the ones waiting, or none: "any other uploads".
pub fn waiting_notice(waiting: u32) -> String {
    if waiting == 1 {
        "An upload is waiting for your answer. Lasterm will quit once it is answered and any \
         other uploads end."
            .to_string()
    } else {
        format!(
            "{waiting} uploads are waiting for your answer. Lasterm will quit once they are \
             answered and any other uploads end."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(in_progress: u32) -> UploadsReport {
        UploadsReport {
            in_progress,
            ..UploadsReport::default()
        }
    }

    fn gate_with(report: UploadsReport) -> QuitGate {
        let mut gate = QuitGate::default();
        assert_eq!(gate.report(1, report), Step::Nothing);
        gate
    }

    #[test]
    fn a_quit_with_no_upload_reported_asks_nothing() {
        // The page never reports while file transfer is off: every quit is as
        // it was.
        let mut gate = QuitGate::default();
        assert_eq!(gate.request(Ending::Quit), Start::Proceed);
        assert_eq!(gate.request(Ending::Restart), Start::Proceed);

        let mut gate = gate_with(running(0));
        assert_eq!(gate.request(Ending::Quit), Start::Proceed);
    }

    #[test]
    fn a_quit_while_uploads_run_asks_once_with_their_count() {
        let mut gate = gate_with(running(2));
        assert_eq!(gate.request(Ending::Quit), Start::Ask { in_progress: 2 });
        // A second gesture while the question is up does not ask again.
        assert_eq!(gate.request(Ending::Quit), Start::AlreadyAsking);
    }

    #[test]
    fn quit_and_resume_later_quits_now() {
        let mut gate = gate_with(running(2));
        gate.request(Ending::Quit);
        assert_eq!(gate.answer(Answer::ResumeLater), Step::End(Ending::Quit));
        assert_eq!(gate.pending(), None);
    }

    #[test]
    fn cancel_keeps_everything_as_it_was() {
        let mut gate = gate_with(running(2));
        gate.request(Ending::Quit);
        assert_eq!(gate.answer(Answer::Cancel), Step::Nothing);
        assert_eq!(gate.pending(), None);
        // And the next gesture asks again.
        assert_eq!(gate.request(Ending::Quit), Start::Ask { in_progress: 2 });
    }

    #[test]
    fn an_answer_nobody_asked_for_does_nothing() {
        let mut gate = gate_with(running(2));
        assert_eq!(gate.answer(Answer::ResumeLater), Step::Nothing);
    }

    #[test]
    fn quit_when_finished_waits_then_quits_when_the_last_upload_ends() {
        let mut gate = gate_with(running(2));
        gate.request(Ending::Quit);
        assert_eq!(
            gate.answer(Answer::WhenFinished),
            Step::Wait {
                ending: Ending::Quit,
                notify: None
            }
        );
        assert_eq!(gate.pending(), Some(Ending::Quit));

        // One ends, failed or placed: the other still runs.
        let one_left = UploadsReport {
            in_progress: 1,
            failed: 1,
            ..UploadsReport::default()
        };
        assert_eq!(gate.report(2, one_left), Step::Nothing);
        assert_eq!(gate.pending(), Some(Ending::Quit));

        // The last one fails: failures keep nothing open.
        let none_left = UploadsReport {
            failed: 2,
            ..UploadsReport::default()
        };
        assert_eq!(gate.report(3, none_left), Step::End(Ending::Quit));
        assert_eq!(gate.pending(), None);
    }

    #[test]
    fn quit_when_finished_quits_at_once_when_they_ended_during_the_question() {
        let mut gate = gate_with(running(1));
        gate.request(Ending::Quit);
        assert_eq!(gate.report(2, running(0)), Step::Nothing);
        assert_eq!(gate.answer(Answer::WhenFinished), Step::End(Ending::Quit));
    }

    #[test]
    fn an_upload_waiting_for_an_answer_keeps_the_app_open_and_is_told_once() {
        let mut gate = gate_with(running(2));
        gate.request(Ending::Quit);
        gate.answer(Answer::WhenFinished);

        let one_waits = UploadsReport {
            in_progress: 1,
            waiting: 1,
            ..UploadsReport::default()
        };
        assert_eq!(gate.report(2, one_waits), Step::Notify { waiting: 1 });
        // The same upload still waiting: no second notice, and no quit.
        let progress_elsewhere = UploadsReport {
            percent: Some(80),
            ..one_waits
        };
        assert_eq!(gate.report(3, progress_elsewhere), Step::Nothing);
        assert_eq!(gate.pending(), Some(Ending::Quit));

        // Answered, it runs again; another one later is told about too.
        assert_eq!(gate.report(4, running(1)), Step::Nothing);
        assert_eq!(gate.report(5, one_waits), Step::Notify { waiting: 1 });
        // Then it ends, and so does the app.
        assert_eq!(gate.report(6, running(0)), Step::End(Ending::Quit));
    }

    #[test]
    fn a_quit_decided_while_an_upload_already_waits_tells_at_once() {
        let mut gate = gate_with(UploadsReport {
            in_progress: 3,
            waiting: 2,
            ..UploadsReport::default()
        });
        gate.request(Ending::Quit);
        assert_eq!(
            gate.answer(Answer::WhenFinished),
            Step::Wait {
                ending: Ending::Quit,
                notify: Some(2)
            }
        );
        // Those two are not told about again.
        assert_eq!(
            gate.report(
                2,
                UploadsReport {
                    in_progress: 2,
                    waiting: 2,
                    ..UploadsReport::default()
                }
            ),
            Step::Nothing
        );
    }

    #[test]
    fn the_waiting_quit_is_cancelled_from_the_tray_or_the_page() {
        let mut gate = gate_with(running(1));
        gate.request(Ending::Quit);
        gate.answer(Answer::WhenFinished);
        assert!(gate.cancel_pending());
        assert_eq!(gate.pending(), None);
        assert!(!gate.cancel_pending());
        // Cancelled, the uploads ending no longer quits.
        assert_eq!(gate.report(2, running(0)), Step::Nothing);
    }

    #[test]
    fn asking_again_while_a_quit_waits_can_quit_now_or_keep_it() {
        let mut gate = gate_with(running(1));
        gate.request(Ending::Quit);
        gate.answer(Answer::WhenFinished);

        // The tray's Quit, while it waits: Cancel keeps the waiting quit.
        assert_eq!(gate.request(Ending::Quit), Start::Ask { in_progress: 1 });
        assert_eq!(gate.answer(Answer::Cancel), Step::Nothing);
        assert_eq!(gate.pending(), Some(Ending::Quit));

        // Resume later quits now.
        gate.request(Ending::Quit);
        assert_eq!(gate.answer(Answer::ResumeLater), Step::End(Ending::Quit));
        assert_eq!(gate.pending(), None);
    }

    #[test]
    fn a_restart_asks_the_same_and_waits_the_same() {
        let mut gate = gate_with(running(1));
        assert_eq!(gate.request(Ending::Restart), Start::Ask { in_progress: 1 });
        assert_eq!(
            gate.answer(Answer::WhenFinished),
            Step::Wait {
                ending: Ending::Restart,
                notify: None
            }
        );
        assert_eq!(gate.report(2, running(0)), Step::End(Ending::Restart));
    }

    #[test]
    fn a_waiting_restart_keeps_its_window_and_needs_no_notice() {
        let one_waits = UploadsReport {
            in_progress: 2,
            waiting: 1,
            ..UploadsReport::default()
        };
        let mut gate = gate_with(one_waits);
        gate.request(Ending::Restart);
        assert_eq!(
            gate.answer(Answer::WhenFinished),
            Step::Wait {
                ending: Ending::Restart,
                notify: None
            }
        );
        let both_wait = UploadsReport {
            waiting: 2,
            ..one_waits
        };
        assert_eq!(gate.report(2, both_wait), Step::Nothing);
        assert_eq!(gate.pending(), Some(Ending::Restart));
    }

    #[test]
    fn a_report_that_arrives_late_is_dropped() {
        let mut gate = gate_with(running(1));
        gate.request(Ending::Quit);
        gate.answer(Answer::WhenFinished);
        assert_eq!(gate.report(3, running(0)), Step::End(Ending::Quit));
        // The "1 in progress" sent before it lands after it.
        assert_eq!(gate.report(2, running(1)), Step::Nothing);
        assert_eq!(gate.uploads(), running(0));
    }

    #[test]
    fn a_new_document_holds_no_uploads_and_ends_a_waiting_quit() {
        let mut gate = gate_with(running(1));
        assert_eq!(gate.page_started(), Step::Nothing);
        assert_eq!(gate.request(Ending::Quit), Start::Proceed);

        let mut gate = gate_with(running(1));
        gate.request(Ending::Quit);
        gate.answer(Answer::WhenFinished);
        assert_eq!(gate.page_started(), Step::End(Ending::Quit));
        // Its reports count from the start again.
        assert_eq!(gate.report(1, running(2)), Step::Nothing);
        assert_eq!(gate.uploads(), running(2));
    }

    #[test]
    fn the_page_numbers_are_made_consistent() {
        assert_eq!(
            UploadsReport::from_page(2, 5, 1, Some(64.9)),
            UploadsReport {
                in_progress: 2,
                waiting: 2,
                failed: 1,
                percent: Some(64)
            }
        );
        assert_eq!(
            UploadsReport::from_page(1, 0, 0, Some(99.99)).percent,
            Some(99)
        );
        assert_eq!(
            UploadsReport::from_page(1, 0, 0, Some(140.0)).percent,
            Some(100)
        );
        assert_eq!(
            UploadsReport::from_page(1, 0, 0, Some(-3.0)).percent,
            Some(0)
        );
        assert_eq!(
            UploadsReport::from_page(1, 0, 0, Some(f64::NAN)).percent,
            None
        );
        assert_eq!(UploadsReport::from_page(1, 0, 0, None).percent, None);
    }

    fn report(in_progress: u32, waiting: u32, failed: u32, percent: Option<u8>) -> UploadsReport {
        UploadsReport {
            in_progress,
            waiting,
            failed,
            percent,
        }
    }

    #[test]
    fn the_tray_text_says_how_the_uploads_go() {
        assert_eq!(tray_text(&UploadsReport::default(), None), "Lasterm");
        // Failures alone keep nothing running, and the tray goes back to its name.
        assert_eq!(tray_text(&report(0, 0, 3, None), None), "Lasterm");
        assert_eq!(
            tray_text(&report(2, 0, 1, Some(64)), None),
            "Lasterm — 2 uploads · 64 % · 1 failed"
        );
        assert_eq!(
            tray_text(&report(1, 0, 0, None), None),
            "Lasterm — 1 upload"
        );
        assert_eq!(
            tray_text(&report(1, 1, 0, Some(30)), None),
            "Lasterm — 1 waiting for an answer"
        );
        assert_eq!(
            tray_text(&report(3, 1, 2, Some(40)), None),
            "Lasterm — 3 uploads · 40 % · 1 waiting for an answer · 2 failed"
        );
    }

    #[test]
    fn the_tray_text_says_the_quit_that_waits() {
        assert_eq!(
            tray_text(&report(2, 0, 0, Some(64)), Some(Ending::Quit)),
            "Lasterm — quits when 2 uploads finish · 64 %"
        );
        assert_eq!(
            tray_text(&report(1, 0, 0, Some(5)), Some(Ending::Restart)),
            "Lasterm — restarts when 1 upload finishes · 5 %"
        );
        assert_eq!(
            tray_text(&report(1, 1, 0, Some(5)), Some(Ending::Quit)),
            "Lasterm — quits when 1 upload finishes · 1 waiting for an answer"
        );
        assert_eq!(
            tray_text(&report(0, 0, 1, None), Some(Ending::Quit)),
            "Lasterm"
        );
    }

    #[test]
    fn the_longest_tray_text_fits_a_windows_tooltip() {
        for pending in [None, Some(Ending::Quit), Some(Ending::Restart)] {
            for waiting in [0, 1, u32::MAX - 1, u32::MAX] {
                let text = tray_text(&report(u32::MAX, waiting, u32::MAX, Some(100)), pending);
                let units = text.encode_utf16().count();
                assert!(
                    units <= TRAY_TOOLTIP_MAX_UTF16,
                    "{units} UTF-16 units: {text}"
                );
            }
        }
    }

    #[test]
    fn the_tray_text_changes_at_once_then_at_most_once_a_second() {
        let start = Instant::now();
        let mut throttle = TrayTextThrottle::default();
        assert_eq!(throttle.shown(), "Lasterm");

        // The first change shows at once.
        assert_eq!(throttle.offer("A".into(), start), TrayTextStep::Show);
        assert_eq!(throttle.shown(), "A");

        // The next, 300 ms later, waits for the rest of the second.
        let soon = start + Duration::from_millis(300);
        assert_eq!(
            throttle.offer("B".into(), soon),
            TrayTextStep::Later(Duration::from_millis(700))
        );
        assert_eq!(throttle.shown(), "A");
        // A newer one replaces it without a second timer.
        assert_eq!(
            throttle.offer("C".into(), start + Duration::from_millis(600)),
            TrayTextStep::Keep
        );
        assert_eq!(throttle.shown(), "A");

        // When the second is up, the latest shows.
        let second = start + TRAY_TEXT_MIN_INTERVAL;
        assert_eq!(throttle.timer_fired(second), TrayTextStep::Show);
        assert_eq!(throttle.shown(), "C");
        assert_eq!(throttle.timer_fired(second), TrayTextStep::Keep);
    }

    #[test]
    fn the_tray_text_is_set_only_when_it_changes() {
        let start = Instant::now();
        let mut throttle = TrayTextThrottle::default();
        // "Lasterm" again, as every report says while none runs: nothing to set.
        assert_eq!(throttle.offer("Lasterm".into(), start), TrayTextStep::Keep);

        assert_eq!(throttle.offer("A".into(), start), TrayTextStep::Show);
        let later = start + Duration::from_secs(5);
        assert_eq!(throttle.offer("A".into(), later), TrayTextStep::Keep);

        // A change that came back before its slot is dropped.
        assert_eq!(throttle.offer("B".into(), later), TrayTextStep::Show);
        let soon = later + Duration::from_millis(100);
        assert!(matches!(
            throttle.offer("A".into(), soon),
            TrayTextStep::Later(_)
        ));
        assert_eq!(throttle.offer("B".into(), soon), TrayTextStep::Keep);
        assert_eq!(
            throttle.timer_fired(later + TRAY_TEXT_MIN_INTERVAL),
            TrayTextStep::Keep
        );
        assert_eq!(throttle.shown(), "B");
    }

    #[test]
    fn a_timer_that_fires_early_waits_again() {
        let start = Instant::now();
        let mut throttle = TrayTextThrottle::default();
        throttle.offer("A".into(), start);
        throttle.offer("B".into(), start + Duration::from_millis(200));
        assert_eq!(
            throttle.timer_fired(start + Duration::from_millis(900)),
            TrayTextStep::Later(Duration::from_millis(100))
        );
        assert_eq!(throttle.shown(), "A");
    }

    #[test]
    fn the_tray_menu_gains_lines_only_while_there_is_something_to_say() {
        assert!(TrayMenuTop::for_state("Lasterm", None).is_empty());
        assert_eq!(
            TrayMenuTop::for_state("Lasterm — 1 upload", None),
            TrayMenuTop {
                status: true,
                cancel: None
            }
        );
        assert_eq!(
            TrayMenuTop::for_state("Lasterm — quits when 1 upload finishes", Some(Ending::Quit)),
            TrayMenuTop {
                status: true,
                cancel: Some(Ending::Quit)
            }
        );
    }

    #[test]
    fn each_button_gives_its_answer_and_anything_else_cancels() {
        for ending in [Ending::Quit, Ending::Restart] {
            let question = question(ending, 2);
            assert!(question.message.starts_with("2 uploads in progress."));
            assert_eq!(
                answer_for_label(&question, question.resume_later),
                Answer::ResumeLater
            );
            assert_eq!(
                answer_for_label(&question, question.when_finished),
                Answer::WhenFinished
            );
            assert_eq!(answer_for_label(&question, question.cancel), Answer::Cancel);
            assert_eq!(answer_for_label(&question, ""), Answer::Cancel);
        }
        assert!(question(Ending::Quit, 1)
            .message
            .starts_with("1 upload in progress."));
    }

    // One upload is "it", several "them" (#874): "resume them" was said of one.
    #[test]
    fn the_question_says_it_of_one_upload_and_them_of_several() {
        assert_eq!(
            question(Ending::Quit, 1).message,
            "1 upload in progress.\n\nQuit now and resume it at the next start, or keep Lasterm \
             running hidden and quit once it ends."
        );
        assert_eq!(
            question(Ending::Quit, 2).message,
            "2 uploads in progress.\n\nQuit now and resume them at the next start, or keep \
             Lasterm running hidden and quit once they end."
        );
        assert_eq!(
            question(Ending::Restart, 1).message,
            "1 upload in progress.\n\nRestart now and resume it after the restart, or restart \
             once it ends."
        );
        assert_eq!(
            question(Ending::Restart, 2).message,
            "2 uploads in progress.\n\nRestart now and resume them after the restart, or \
             restart once they end."
        );
    }

    #[test]
    fn the_tray_text_counts_one_upload_and_several() {
        assert_eq!(
            tray_text(&report(1, 0, 1, Some(10)), None),
            "Lasterm — 1 upload · 10 % · 1 failed"
        );
        assert_eq!(
            tray_text(&report(1, 0, 0, None), Some(Ending::Quit)),
            "Lasterm — quits when 1 upload finishes"
        );
        assert_eq!(
            tray_text(&report(2, 0, 0, None), Some(Ending::Restart)),
            "Lasterm — restarts when 2 uploads finish"
        );
        assert_eq!(
            tray_text(&report(2, 2, 0, None), None),
            "Lasterm — 2 waiting for an answer"
        );
    }

    // The uploads waiting may be all there are: "the other uploads" said there
    // were more.
    #[test]
    fn the_waiting_notice_counts_one_upload_and_several() {
        assert_eq!(
            waiting_notice(1),
            "An upload is waiting for your answer. Lasterm will quit once it is answered and any \
             other uploads end."
        );
        assert_eq!(
            waiting_notice(2),
            "2 uploads are waiting for your answer. Lasterm will quit once they are answered and \
             any other uploads end."
        );
    }
}
