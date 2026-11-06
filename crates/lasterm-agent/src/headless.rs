use std::num::NonZeroU16;
use std::ops::RangeInclusive;
use std::time::Instant;

/// What vt100 hands back through callbacks rather than keeping on the screen:
/// the window title (OSC 0 and OSC 2), and the OSC sequences it does not
/// handle itself, which is where notifications (OSC 9) arrive. The parser
/// keeps its state from one chunk to the next, so a sequence split across two
/// reads of the PTY arrives whole.
#[derive(Default)]
struct MirrorCallbacks {
    title: String,
    /// The first notification of the chunk being processed.
    notification: Option<String>,
}

impl vt100::Callbacks for MirrorCallbacks {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        // A title that is not UTF-8 is ignored, as vt100 did before it moved
        // titles to callbacks.
        if let Ok(title) = std::str::from_utf8(title) {
            self.title = title.to_string();
        }
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if let Some(Osc::Notification(message)) = parse_osc(params) {
            self.notification.get_or_insert(message);
        }
    }
}

/// Terminal state mirror backed by vt100::Parser.
/// Tracks screen content, cursor, title, bell, and notifications.
pub struct HeadlessMirror {
    parser: vt100::Parser<MirrorCallbacks>,
    current_title: String,
    last_bell: Option<Instant>,
    last_notification: Option<Instant>,
    pending_title_change: Option<String>,
    pending_bell: bool,
    pending_notification: Option<String>,
}

const BELL_THROTTLE_MS: u128 = 100;
const NOTIFICATION_THROTTLE_MS: u128 = 500;
const MAX_NOTIFICATION_LEN: usize = 256;
/// ConEmu's and Windows Terminal's OSC 9 sub-commands, `9;1` to `9;12`: `9;4`
/// is progress, `9;9` the shell's directory. None of them is a notification.
const CONEMU_SUBCOMMANDS: RangeInclusive<u32> = 1..=12;

impl HeadlessMirror {
    /// Create a new headless terminal mirror.
    /// scrollback: number of scrollback lines (default 1000)
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        let parser = vt100::Parser::new_with_callbacks(
            dimension(rows),
            dimension(cols),
            scrollback,
            MirrorCallbacks::default(),
        );
        Self {
            parser,
            current_title: String::new(),
            last_bell: None,
            last_notification: None,
            pending_title_change: None,
            pending_bell: false,
            pending_notification: None,
        }
    }

    /// Feed raw PTY output into the terminal parser.
    /// Call this with every chunk of data from the PTY.
    /// After calling, check pending_* fields for events.
    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);

        // Check for title change (OSC 0/2)
        let new_title = &self.parser.callbacks().title;
        if *new_title != self.current_title {
            self.current_title = new_title.clone();
            self.pending_title_change = Some(new_title.clone());
        }

        // Check for bell.
        // vt100 doesn't expose bell directly. We scan for \x07 in the raw data.
        // BUT: \x07 inside an OSC sequence is the terminator, not a bell.
        // Simple heuristic: if \x07 appears outside an escape sequence context,
        // it's a bell. For accuracy, check if data contains bare \x07 not preceded
        // by \x1b] (OSC start).
        if contains_bell(data) {
            let now = Instant::now();
            let should_fire = match self.last_bell {
                Some(last) => now.duration_since(last).as_millis() >= BELL_THROTTLE_MS,
                None => true,
            };
            if should_fire {
                self.pending_bell = true;
                self.last_bell = Some(now);
            }
        }

        // A plain OSC 9 is a notification; its sub-commands are not (#829).
        if let Some(msg) = self.parser.callbacks_mut().notification.take() {
            let now = Instant::now();
            let should_fire = match self.last_notification {
                Some(last) => now.duration_since(last).as_millis() >= NOTIFICATION_THROTTLE_MS,
                None => true,
            };
            if should_fire {
                // Sanitize: strip control chars, limit length
                let sanitized = sanitize_notification(&msg);
                self.pending_notification = Some(sanitized);
                self.last_notification = Some(now);
            }
        }
    }

    /// Resize the terminal mirror.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.set_size(dimension(rows), dimension(cols));
    }

    /// Produce a snapshot of the current terminal state.
    /// Returns ANSI escape sequences that reconstruct the screen content.
    pub fn snapshot(&self) -> SnapshotInfo {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        SnapshotInfo {
            // The screen content with ANSI formatting.
            serialized: screen.contents_formatted(),
            cols: cols.get(),
            rows: rows.get(),
            cursor_x: screen.cursor_position().1,
            cursor_y: screen.cursor_position().0,
        }
    }

    /// Take pending title change event (if any).
    pub fn take_title_change(&mut self) -> Option<String> {
        self.pending_title_change.take()
    }

    /// Take pending bell event (if any).
    pub fn take_bell(&mut self) -> bool {
        let v = self.pending_bell;
        self.pending_bell = false;
        v
    }

    /// Take pending notification event (if any).
    pub fn take_notification(&mut self) -> Option<String> {
        self.pending_notification.take()
    }
}

/// vt100 takes no zero dimension: the hub never sends one (`isValidDimensions`),
/// and a zero that reaches the agent anyway becomes 1 rather than a panic.
fn dimension(value: u16) -> NonZeroU16 {
    NonZeroU16::new(value).unwrap_or(NonZeroU16::MIN)
}

pub struct SnapshotInfo {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
}

/// Check if data contains a bare bell (\x07) not part of an OSC terminator.
fn contains_bell(data: &[u8]) -> bool {
    // Simple scan: look for \x07 that is NOT preceded by \x1b] ... context
    // A proper approach would track parser state, but for throttled bell detection
    // a simple check is sufficient — false positives are harmless (extra bell event)
    let mut in_osc = false;
    for (i, &byte) in data.iter().enumerate() {
        if byte == 0x1b && data.get(i + 1) == Some(&b']') {
            in_osc = true;
        } else if in_osc && byte == 0x07 {
            in_osc = false; // OSC terminator, not a bell
        } else if byte == 0x07 {
            return true; // Bare bell
        } else if in_osc && byte == 0x1b && data.get(i + 1) == Some(&b'\\') {
            in_osc = false; // ST terminator
        }
    }
    false
}

/// What an OSC sequence vt100 left alone says.
#[derive(Debug, PartialEq, Eq)]
enum Osc {
    /// OSC 9 ; <message>: a desktop notification.
    Notification(String),
}

/// An OSC's parameters joined back with the `;` the parser split them at: a
/// message can hold one.
fn joined(params: &[&[u8]]) -> Vec<u8> {
    params.join(&b';')
}

fn parse_osc(params: &[&[u8]]) -> Option<Osc> {
    let (number, rest) = params.split_first()?;
    match *number {
        b"9" => osc9(rest),
        _ => None,
    }
}

/// OSC 9: a notification, unless it is one of ConEmu's sub-commands.
fn osc9(rest: &[&[u8]]) -> Option<Osc> {
    let first = rest.first()?;
    if subcommand(first).is_some() {
        return None;
    }
    let message = String::from_utf8_lossy(&joined(rest)).into_owned();
    (!message.is_empty()).then_some(Osc::Notification(message))
}

/// The number of a ConEmu sub-command, when `param` is one.
fn subcommand(param: &[u8]) -> Option<u32> {
    if param.is_empty() || param.len() > 2 || !param.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let number: u32 = std::str::from_utf8(param).ok()?.parse().ok()?;
    CONEMU_SUBCOMMANDS.contains(&number).then_some(number)
}

/// Sanitize a notification message: strip control chars, limit length.
fn sanitize_notification(msg: &str) -> String {
    let cleaned: String = msg
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NOTIFICATION_LEN)
        .collect();
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snapshot_basic() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"hello world");
        let snap = mirror.snapshot();
        assert!(snap.serialized.contains("hello world"));
        assert_eq!(snap.cols, 80);
        assert_eq!(snap.rows, 24);
    }

    #[test]
    fn test_title_change_osc0() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]0;My Title\x07");
        let title = mirror.take_title_change();
        assert_eq!(title, Some("My Title".to_string()));
    }

    #[test]
    fn test_title_change_osc2() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]2;Window Title\x07");
        let title = mirror.take_title_change();
        assert_eq!(title, Some("Window Title".to_string()));
    }

    #[test]
    fn test_same_title_again_is_not_a_change() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]2;Build\x07");
        assert_eq!(mirror.take_title_change(), Some("Build".to_string()));
        mirror.process(b"\x1b]2;Build\x07");
        assert_eq!(mirror.take_title_change(), None);
    }

    #[test]
    fn test_title_not_utf8_is_ignored() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]2;Kept\x07");
        assert_eq!(mirror.take_title_change(), Some("Kept".to_string()));
        mirror.process(b"\x1b]2;\xff\xfe\x07");
        assert_eq!(mirror.take_title_change(), None);
    }

    #[test]
    fn test_bell_detection() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x07");
        assert!(mirror.take_bell());
    }

    #[test]
    fn test_bell_throttle() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x07");
        assert!(mirror.take_bell());
        // Immediately again — should be throttled
        mirror.process(b"\x07");
        assert!(!mirror.take_bell());
    }

    #[test]
    fn test_osc9_notification() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"\x1b]9;Build complete\x07");
        let notif = mirror.take_notification();
        assert_eq!(notif, Some("Build complete".to_string()));
    }

    #[test]
    fn test_notification_sanitized() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        // Notification with control chars
        mirror.process(b"\x1b]9;Hello\x01World\x07");
        let notif = mirror.take_notification().unwrap();
        assert!(!notif.contains('\x01'));
        assert!(notif.contains("HelloWorld"));
    }

    /// ConEmu's and Windows Terminal's OSC 9 sub-commands are not
    /// notifications: progress from winget or a prompt, the directory from a
    /// PowerShell prompt set up for Windows Terminal (#829).
    #[test]
    fn osc9_sub_commands_are_not_notifications() {
        for sequence in [
            &b"\x1b]9;4;1;50\x07"[..],
            b"\x1b]9;4;0\x1b\\",
            b"\x1b]9;9;\"C:\\Users\\me\"\x1b\\",
            b"\x1b]9;9;/home/me\x07",
            b"\x1b]9;1;500\x07",
            b"\x1b]9;12\x07",
        ] {
            let mut mirror = HeadlessMirror::new(80, 24, 1000);
            mirror.process(sequence);
            assert_eq!(
                mirror.take_notification(),
                None,
                "{}",
                String::from_utf8_lossy(sequence)
            );
        }
    }

    /// A plain message is one, semicolons, digits and all.
    #[test]
    fn a_plain_osc9_message_is_a_notification() {
        for (sequence, message) in [
            (&b"\x1b]9;Build; done\x07"[..], "Build; done"),
            (b"\x1b]9;100% done\x07", "100% done"),
            (b"\x1b]9;42;answer\x07", "42;answer"),
        ] {
            let mut mirror = HeadlessMirror::new(80, 24, 1000);
            mirror.process(sequence);
            assert_eq!(mirror.take_notification().as_deref(), Some(message));
        }
    }

    #[test]
    fn a_notification_split_across_reads_arrives_whole() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.process(b"output\x1b]9;Build co");
        assert_eq!(mirror.take_notification(), None);
        mirror.process(b"mplete\x07more");
        assert_eq!(
            mirror.take_notification().as_deref(),
            Some("Build complete")
        );
    }

    #[test]
    fn test_resize_mirror() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        mirror.resize(120, 40);
        let snap = mirror.snapshot();
        assert_eq!(snap.cols, 120);
        assert_eq!(snap.rows, 40);
    }

    #[test]
    fn test_zero_size_becomes_one() {
        let mut mirror = HeadlessMirror::new(0, 0, 1000);
        let snap = mirror.snapshot();
        assert_eq!((snap.cols, snap.rows), (1, 1));
        mirror.resize(0, 40);
        let snap = mirror.snapshot();
        assert_eq!((snap.cols, snap.rows), (1, 40));
    }

    #[test]
    fn test_snapshot_cursor_position() {
        let mut mirror = HeadlessMirror::new(80, 24, 1000);
        // Move cursor to row 5, col 10
        mirror.process(b"\x1b[5;10H");
        let snap = mirror.snapshot();
        // vt100 uses 0-indexed, escape sequence is 1-indexed
        assert_eq!(snap.cursor_y, 4);
        assert_eq!(snap.cursor_x, 9);
    }
}
