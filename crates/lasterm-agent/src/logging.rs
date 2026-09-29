//! The daemon's log: one file per day, and a number of them kept (#646).
//!
//! The daemon used to append to `<state>/logs/agent-daemon.jsonl` for as long
//! as it ran, and nothing bounded it: a remote daemon left for months, as on a
//! Raspberry Pi, grew it for as long. It now writes one file per day (UTC), as
//! `tracing-appender`'s daily rotation names them:
//! `agent-daemon.2026-09-29.jsonl`. A day with nothing to log has no file.
//!
//! **No file is ever renamed.** Moving a file aside at a size, as the hub's
//! logs do, has a failure that brings the growth back: a rename refused (on
//! Windows, by anything holding the file without sharing deletion) leaves the
//! daemon appending to the full file until it can. A new day's file is a new
//! name, which nothing can hold.
//!
//! **What is kept is a number of files**, the most recent days with activity:
//! seven by default, all of them with `0`. The hub passes the number it was
//! given (`[logging] agent_files_kept`) as `--log-files-kept`. Older files are
//! deleted when the daemon starts and when a new day's file starts. A file that
//! cannot be deleted is said in a warning, and tried again on the next of those
//! occasions. Only `agent-daemon.YYYY-MM-DD.jsonl` files are deleted, and the
//! file this replaced (below): anything else in the directory is not ours.
//!
//! The cap counts files, not bytes. What bounds one day's size is the level:
//! at INFO the daemon logs its lifecycle and little else (CLAUDE.md, Logging).
//!
//! **The file before this, `agent-daemon.jsonl`**, which an earlier daemon
//! grew, counts as one more file, dated by its last write. It goes once as many
//! newer days have their own file as are kept, as a daily file of that day
//! would. It is never renamed or rewritten, and a daemon from before this
//! change may still be appending to it while it is replaced.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use tracing_appender::rolling::{RollingFileAppender, RollingWriter, Rotation};

use crate::platform_dirs::{lasterm_dir, DirKind};

/// `agent-daemon.YYYY-MM-DD.jsonl`: the name the daily rotation gives a file.
const FILE_PREFIX: &str = "agent-daemon";
const FILE_SUFFIX: &str = "jsonl";

/// The file the daemon wrote before one per day, never rotated.
const LEGACY_FILE: &str = "agent-daemon.jsonl";

/// Files kept when nothing says otherwise: a week of days with activity, which
/// covers "it started on Monday". `0` keeps them all.
pub const DEFAULT_FILES_KEPT: u32 = 7;

/// The daemon log's directory, `<state>/logs`, created: in the state directory
/// the hub uses (`$XDG_STATE_HOME/lasterm` or `~/.local/state/lasterm`,
/// `%LOCALAPPDATA%\lasterm`).
pub fn daemon_log_dir() -> io::Result<PathBuf> {
    let dir = log_dir_under(&lasterm_dir(DirKind::State)?);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn log_dir_under(state_dir: &Path) -> PathBuf {
    state_dir.join("logs")
}

/// The daemon's log: the day's file, and the pruning of the older ones.
pub struct DaemonLog {
    appender: RollingFileAppender,
    dir: PathBuf,
    keep: u32,
    /// The last day a line was written, in days since the epoch (UTC, as the
    /// daily rotation counts them).
    day: AtomicU64,
    /// Today, in the same count. Only tests set another clock.
    today: Box<dyn Fn() -> u64 + Send + Sync>,
}

impl DaemonLog {
    /// Open today's file in `dir`, creating the directory. Nothing is pruned
    /// yet: [`DaemonLog::prune`] does, once the caller can say what failed.
    pub fn open(dir: &Path, keep: u32) -> io::Result<DaemonLog> {
        Self::open_with_clock(dir, keep, Box::new(utc_day))
    }

    fn open_with_clock(
        dir: &Path,
        keep: u32,
        today: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> io::Result<DaemonLog> {
        // Created here, so that a directory that cannot be is an error now
        // rather than a log that writes nowhere.
        std::fs::create_dir_all(dir)?;
        let appender = RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix(FILE_PREFIX)
            .filename_suffix(FILE_SUFFIX)
            // No `max_log_files`: it keeps files by creation time and counts any
            // name with the prefix and the suffix, `agent-daemon.jsonl` included,
            // and it reports on stderr. The pruning below goes by the day in the
            // name and says what it could not delete in the log.
            .build(dir)
            .map_err(io::Error::other)?;
        Ok(DaemonLog {
            appender,
            dir: dir.to_path_buf(),
            keep,
            day: AtomicU64::new(today()),
            today,
        })
    }

    /// Where the files are.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Delete the files beyond the ones kept. Returns what could not be done,
    /// for the caller to say: the next occasion tries again.
    pub fn prune(&self) -> Vec<PruneFailure> {
        prune_dir(&self.dir, self.keep, |path| std::fs::remove_file(path))
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for DaemonLog {
    type Writer = RollingWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        // The day is read before the file: if it has turned, the appender, which
        // reads its clock after, has turned too, and the new day's file exists
        // when the pruning below counts it among those kept.
        let today = (self.today)();
        let file = self.appender.make_writer();
        // `fetch_max`, not a swap: two lines written across midnight by two
        // threads prune once, and a clock set back does not prune again.
        if self.day.fetch_max(today, Ordering::Relaxed) < today {
            let failures = self.prune();
            if !failures.is_empty() {
                // Not from here: this runs inside a write, holding the file.
                // The warning is a line like any other, and goes through the
                // writer on a thread of its own. If none can be started, the
                // next occasion tries the files again, and says it then.
                let _ = std::thread::Builder::new()
                    .name("daemon-log-prune".into())
                    .spawn(move || warn_not_deleted(&failures));
            }
        }
        file
    }
}

/// What a pruning could not do.
#[derive(Debug)]
pub struct PruneFailure {
    /// The file not deleted, or `None` when the directory could not be read.
    file: Option<String>,
    error: io::Error,
}

/// Say, in the log, what a pruning could not do. Called once a subscriber is
/// in place: at start, the pruning runs before it.
pub fn warn_not_deleted(failures: &[PruneFailure]) {
    for failure in failures {
        match &failure.file {
            Some(file) => tracing::warn!(
                file = %file,
                error = %failure.error,
                "old daemon log file not deleted; tried again when the next day's file starts or the daemon starts"
            ),
            None => tracing::warn!(
                error = %failure.error,
                "daemon log directory not read; old files not deleted"
            ),
        }
    }
}

/// Days since the epoch, in UTC like the daily rotation.
fn utc_day() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() / 86_400)
}

/// A file the pruning may delete, and the day it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    name: String,
    /// `YYYY-MM-DD`, which sorts as the days do.
    day: String,
    /// `agent-daemon.jsonl`, the file before one per day.
    legacy: bool,
}

/// The day a daily file's name covers: `agent-daemon.YYYY-MM-DD.jsonl`.
fn day_in_name(name: &str) -> Option<&str> {
    let day = name
        .strip_prefix(FILE_PREFIX)?
        .strip_prefix('.')?
        .strip_suffix(FILE_SUFFIX)?
        .strip_suffix('.')?;
    let shaped = day.len() == 10
        && day.char_indices().all(|(i, c)| match i {
            4 | 7 => c == '-',
            _ => c.is_ascii_digit(),
        });
    shaped.then_some(day)
}

/// The UTC day of a moment, `YYYY-MM-DD`.
fn day_of(moment: SystemTime) -> String {
    let date = time::OffsetDateTime::from(moment).date();
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// The files beyond the `keep` most recent, which the pruning deletes; `0`
/// keeps them all. The most recent is the latest day; on the same day, the
/// daily file is more recent than the one before it.
fn beyond(mut candidates: Vec<Candidate>, keep: u32) -> Vec<String> {
    if keep == 0 {
        return Vec::new();
    }
    candidates.sort_by(|a, b| (&b.day, !b.legacy).cmp(&(&a.day, !a.legacy)));
    candidates
        .into_iter()
        .skip(keep as usize)
        .map(|candidate| candidate.name)
        .collect()
}

/// What in `dir` the pruning may delete. Only regular files: a directory or a
/// link bearing one of the names is not something the daemon wrote. The file
/// before one per day is dated by its last write, and left alone when that
/// cannot be read: nothing is deleted on a date it does not have.
fn candidates(dir: &Path) -> io::Result<Vec<Candidate>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if let Some(day) = day_in_name(&name) {
            found.push(Candidate {
                day: day.to_string(),
                name,
                legacy: false,
            });
        } else if name == LEGACY_FILE {
            if let Ok(written) = entry.metadata().and_then(|meta| meta.modified()) {
                found.push(Candidate {
                    day: day_of(written),
                    name,
                    legacy: true,
                });
            }
        }
    }
    Ok(found)
}

/// Delete, with `remove`, the files of `dir` beyond the `keep` most recent.
/// One that cannot be deleted does not stop the others. One already gone was
/// deleted by someone else, a daemon replacing this one say, and is no failure.
fn prune_dir(
    dir: &Path,
    keep: u32,
    mut remove: impl FnMut(&Path) -> io::Result<()>,
) -> Vec<PruneFailure> {
    if keep == 0 {
        return Vec::new();
    }
    let found = match candidates(dir) {
        Ok(found) => found,
        Err(error) => return vec![PruneFailure { file: None, error }],
    };
    beyond(found, keep)
        .into_iter()
        .filter_map(|name| match remove(&dir.join(&name)) {
            Ok(()) => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => Some(PruneFailure {
                file: Some(name),
                error,
            }),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::AtomicU32;
    use std::sync::Arc;
    use std::time::Duration;
    use tracing_subscriber::fmt::MakeWriter;

    static TEST_DIR_COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A directory of its own, removed when the test ends.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let path = std::env::temp_dir().join(format!(
                "lasterm-daemon-log-{name}-{}-{}",
                std::process::id(),
                TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("create the test directory");
            TestDir(path)
        }

        fn touch(&self, name: &str) {
            std::fs::write(self.0.join(name), "{}\n").expect("write a log file");
        }

        /// The names in the directory, sorted.
        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(&self.0)
                .expect("read the test directory")
                .map(|entry| entry.expect("an entry").file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn daily(day: &str) -> String {
        format!("agent-daemon.{day}.jsonl")
    }

    fn candidate(day: &str) -> Candidate {
        Candidate {
            name: daily(day),
            day: day.to_string(),
            legacy: false,
        }
    }

    #[test]
    fn the_log_is_in_the_state_logs_directory() {
        // Which state directory is platform_dirs' concern and tested there;
        // resolving it here would read, and create inside, the real profile.
        let state = PathBuf::from("state-root").join("lasterm");
        assert_eq!(log_dir_under(&state), state.join("logs"));
    }

    #[test]
    fn only_a_daily_file_name_carries_a_day() {
        assert_eq!(
            day_in_name("agent-daemon.2026-09-29.jsonl"),
            Some("2026-09-29")
        );
        for other in [
            "agent-daemon.jsonl",
            "agent-daemon.2026-9-29.jsonl",
            "agent-daemon.2026-09-29.log",
            "agent-daemon.2026-09-29.jsonl.old",
            "agent-daemon.2026-09-29-10.jsonl",
            "agent-daemon.20260929xx.jsonl",
            "hub.2026-09-29.jsonl",
            "agent-daemon.log",
            "agent-daemon.legacy.jsonl",
        ] {
            assert_eq!(day_in_name(other), None, "{other}");
        }
    }

    #[test]
    fn the_newest_days_are_kept_and_zero_keeps_them_all() {
        let found = || {
            [
                "2026-09-12",
                "2026-09-14",
                "2026-09-13",
                "2026-09-11",
                "2025-12-31",
            ]
            .map(candidate)
            .to_vec()
        };
        assert_eq!(
            beyond(found(), 2),
            [
                daily("2026-09-12"),
                daily("2026-09-11"),
                daily("2025-12-31")
            ]
        );
        assert!(beyond(found(), 5).is_empty());
        assert!(beyond(found(), 50).is_empty());
        assert!(beyond(found(), 0).is_empty());
    }

    #[test]
    fn the_file_before_one_per_day_counts_as_the_day_it_was_last_written() {
        let legacy = |day: &str| Candidate {
            name: LEGACY_FILE.to_string(),
            day: day.to_string(),
            legacy: true,
        };
        // Last written before every daily file: the oldest.
        let found = vec![
            candidate("2026-09-28"),
            legacy("2026-09-20"),
            candidate("2026-09-29"),
        ];
        assert_eq!(beyond(found, 2), [LEGACY_FILE]);
        // Last written the same day as the first daily file: older than it.
        let found = vec![candidate("2026-09-29"), legacy("2026-09-29")];
        assert_eq!(beyond(found, 1), [LEGACY_FILE]);
        // Written again since, by an older daemon: kept among the recent ones.
        let found = vec![
            candidate("2026-09-01"),
            candidate("2026-09-02"),
            legacy("2026-09-29"),
        ];
        assert_eq!(beyond(found, 2), [daily("2026-09-01")]);
    }

    #[test]
    fn pruning_deletes_only_the_old_daily_files() {
        let dir = TestDir::new("prune");
        for day in ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"] {
            dir.touch(&daily(day));
        }
        // Not ours, or not a daily file: never deleted.
        for other in [
            "hub.jsonl",
            "agent-daemon.log",
            "notes.txt",
            "agent-daemon.2020-1-1.jsonl",
        ] {
            dir.touch(other);
        }
        // A directory bearing a daily file's name is not something we wrote.
        std::fs::create_dir(dir.0.join(daily("2019-01-01"))).unwrap();

        let failures = prune_dir(&dir.0, 2, |path| std::fs::remove_file(path));

        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(
            dir.names(),
            [
                daily("2019-01-01"),
                daily("2020-01-03"),
                daily("2020-01-04"),
                "agent-daemon.2020-1-1.jsonl".to_string(),
                "agent-daemon.log".to_string(),
                "hub.jsonl".to_string(),
                "notes.txt".to_string(),
            ]
        );
        assert!(prune_dir(&dir.0, 0, |_| panic!("0 keeps them all")).is_empty());
    }

    #[test]
    fn the_file_before_one_per_day_goes_once_enough_newer_days_have_a_file() {
        let dir = TestDir::new("legacy");
        dir.touch(LEGACY_FILE);
        let legacy = std::fs::File::options()
            .write(true)
            .open(dir.0.join(LEGACY_FILE))
            .unwrap();
        // Last written on 2026-09-20.
        legacy
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(20_716 * 86_400 + 3_600))
            .unwrap();
        drop(legacy);
        dir.touch(&daily("2026-09-28"));

        assert!(prune_dir(&dir.0, 2, |path| std::fs::remove_file(path)).is_empty());
        assert!(dir.names().contains(&LEGACY_FILE.to_string()), "kept");

        dir.touch(&daily("2026-09-29"));
        assert!(prune_dir(&dir.0, 2, |path| std::fs::remove_file(path)).is_empty());
        assert_eq!(dir.names(), [daily("2026-09-28"), daily("2026-09-29")]);
    }

    #[test]
    fn a_file_that_cannot_be_deleted_is_reported_and_tried_again_next_time() {
        let dir = TestDir::new("refused");
        for day in ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"] {
            dir.touch(&daily(day));
        }
        let held = daily("2020-01-01");
        let refuse_held = |path: &Path| {
            if path.ends_with(&held) {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "held by another process",
                ))
            } else {
                std::fs::remove_file(path)
            }
        };

        let failures = prune_dir(&dir.0, 2, refuse_held);

        assert_eq!(failures.len(), 1, "{failures:?}");
        assert_eq!(failures[0].file.as_deref(), Some(held.as_str()));
        // The one after it went all the same.
        assert_eq!(
            dir.names(),
            [held.clone(), daily("2020-01-03"), daily("2020-01-04")]
        );
        // Saying it does not panic without a subscriber either.
        warn_not_deleted(&failures);

        // The next occasion tries again.
        assert!(prune_dir(&dir.0, 2, |path| std::fs::remove_file(path)).is_empty());
        assert_eq!(dir.names(), [daily("2020-01-03"), daily("2020-01-04")]);
    }

    #[test]
    fn a_directory_that_cannot_be_read_is_reported() {
        let dir = TestDir::new("missing");
        let failures = prune_dir(&dir.0.join("gone"), 2, |_| Ok(()));
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].file, None);
    }

    /// Something holding a file without sharing its deletion, as a viewer can on
    /// Windows, refuses the delete. The daemon goes on, and deletes it later.
    #[cfg(windows)]
    #[test]
    fn a_file_held_open_on_windows_is_deleted_at_the_next_occasion() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = TestDir::new("held");
        for day in ["2020-01-01", "2020-01-02", "2020-01-03"] {
            dir.touch(&daily(day));
        }
        // FILE_SHARE_READ | FILE_SHARE_WRITE, not FILE_SHARE_DELETE.
        let viewer = std::fs::File::options()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(dir.0.join(daily("2020-01-01")))
            .unwrap();

        let failures = prune_dir(&dir.0, 2, |path| std::fs::remove_file(path));
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert_eq!(dir.names().len(), 3);

        drop(viewer);
        assert!(prune_dir(&dir.0, 2, |path| std::fs::remove_file(path)).is_empty());
        assert_eq!(dir.names(), [daily("2020-01-02"), daily("2020-01-03")]);
    }

    #[test]
    fn the_log_writes_to_the_day_s_file_in_a_directory_it_creates() {
        let root = TestDir::new("open");
        let dir = root.0.join("logs");
        assert!(!dir.exists(), "the test would no longer check the creation");

        let log = DaemonLog::open(&dir, DEFAULT_FILES_KEPT).expect("open the log");
        log.make_writer()
            .write_all(b"{\"msg\":\"a line\"}\n")
            .unwrap();

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, [daily(&day_of(SystemTime::now()))], "{names:?}");
        assert_eq!(
            std::fs::read_to_string(dir.join(&names[0])).unwrap(),
            "{\"msg\":\"a line\"}\n"
        );
        assert_eq!(log.dir(), dir);
    }

    #[test]
    fn a_new_day_prunes_the_files_beyond_those_kept() {
        let dir = TestDir::new("new-day");
        for day in ["2020-01-01", "2020-01-02", "2020-01-03"] {
            dir.touch(&daily(day));
        }
        let clock = Arc::new(AtomicU64::new(utc_day()));
        let read = Arc::clone(&clock);
        let log =
            DaemonLog::open_with_clock(&dir.0, 2, Box::new(move || read.load(Ordering::Relaxed)))
                .unwrap();
        let today = daily(&day_of(SystemTime::now()));

        log.make_writer().write_all(b"{}\n").unwrap();
        assert_eq!(dir.names().len(), 4, "the same day prunes nothing");

        clock.fetch_add(1, Ordering::Relaxed);
        log.make_writer().write_all(b"{}\n").unwrap();
        assert_eq!(dir.names(), [daily("2020-01-03"), today.clone()]);

        // A clock set back does not count as another new day.
        dir.touch(&daily("2020-01-02"));
        clock.fetch_sub(1, Ordering::Relaxed);
        log.make_writer().write_all(b"{}\n").unwrap();
        assert_eq!(dir.names().len(), 3);
    }

    #[test]
    fn a_tracing_event_is_one_line_of_the_day_s_file() {
        let dir = TestDir::new("tracing");
        let log = DaemonLog::open(&dir.0, DEFAULT_FILES_KEPT).unwrap();
        let path = dir.0.join(daily(&day_of(SystemTime::now())));
        let subscriber = tracing_subscriber::fmt().json().with_writer(log).finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(channels = 2, "daemon started");
        });

        let text = std::fs::read_to_string(path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1, "{text}");
        let line: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(line["fields"]["message"], "daemon started");
    }
}
