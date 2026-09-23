//! `hub.log`: the hub's output, as the desktop keeps it.
//!
//! The desktop writes every line its hub prints to `hub.log` in the application
//! data directory, for as long as the app runs, and nothing used to bound it:
//! one maintainer's had reached 23 MB (#512). It now moves aside at a size, as
//! `logs/hub.jsonl` does in the hub: the current file becomes `hub.log.old`,
//! replacing the one before it, and a new `hub.log` starts. That is two files at
//! most, neither over the limit.
//!
//! The size is checked before each line, not only when the app starts, because
//! a desktop left running for weeks is the case that grew. And one writer serves
//! the whole process: a hub restarted after it died (#143) is launched while the
//! reader of the previous one may still be writing its last lines. With a file
//! and a count each, both readers would move the file aside, the second throwing
//! away what the first had just kept.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The size `hub.log` moves aside at: the one `logs/hub.jsonl` rotates at.
pub const HUB_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Where the desktop keeps the hub's output, in the application data directory.
pub const HUB_LOG_FILE: &str = "hub.log";

/// Where the file before it is kept, until the next one replaces it.
pub const HUB_LOG_PREVIOUS_FILE: &str = "hub.log.old";

/// A handle on `hub.log`. Clones write to one file, under one count.
#[derive(Clone)]
pub struct HubLog(Arc<Mutex<Writer>>);

struct Writer {
    path: PathBuf,
    previous: PathBuf,
    max_bytes: u64,
    /// `None` while the file cannot be opened; each line tries it again.
    file: Option<File>,
    /// How large the file `file` writes to is.
    len: u64,
    /// Each failure is said once, until the operation next succeeds.
    open_failing: bool,
    rotation_failing: bool,
}

/// The writer every launch of the hub in this process shares.
pub fn for_this_process(dir: &Path) -> HubLog {
    static LOG: OnceLock<HubLog> = OnceLock::new();
    shared(&LOG, dir, HUB_LOG_MAX_BYTES)
}

/// The writer `slot` holds, opened by the first launch that asks.
fn shared(slot: &OnceLock<HubLog>, dir: &Path, max_bytes: u64) -> HubLog {
    slot.get_or_init(|| HubLog::open(dir, max_bytes)).clone()
}

impl HubLog {
    /// `hub.log` in `dir`. A file that cannot be opened is not a failure to
    /// launch: its lines go to standard error meanwhile, as they always did.
    pub fn open(dir: &Path, max_bytes: u64) -> HubLog {
        let mut writer = Writer {
            path: dir.join(HUB_LOG_FILE),
            previous: dir.join(HUB_LOG_PREVIOUS_FILE),
            max_bytes,
            file: None,
            len: 0,
            open_failing: false,
            rotation_failing: false,
        };
        writer.reopen();
        HubLog(Arc::new(Mutex::new(writer)))
    }

    /// Append one line. If it would take the file past the limit, the file is
    /// moved aside first, so a line is never split between the two.
    pub fn record(&self, line: &str) {
        // A panic elsewhere while holding the lock leaves a writer that is still
        // whole: every field is updated after the operation it describes.
        let mut writer = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        writer.record(line);
    }
}

impl Writer {
    fn record(&mut self, line: &str) {
        let mut entry = String::with_capacity(line.len() + 1);
        entry.push_str(line);
        entry.push('\n');
        let bytes = entry.len() as u64;

        if self.file.is_none() {
            self.reopen();
        }
        // A file holding nothing yet takes the line whatever its size: moving an
        // empty file aside would only lose the previous one.
        if self.file.is_some() && self.len > 0 && self.len.saturating_add(bytes) > self.max_bytes {
            self.rotate();
        }
        match self.file.as_mut() {
            // One write per line: appends from one call are never interleaved.
            Some(file) => {
                if file.write_all(entry.as_bytes()).is_ok() {
                    self.len = self.len.saturating_add(bytes);
                }
            }
            None => eprint!("[lasterm] {entry}"),
        }
    }

    fn reopen(&mut self) {
        let opened = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|file| Ok((file.metadata()?.len(), file)));
        match opened {
            Ok((len, file)) => {
                self.file = Some(file);
                self.len = len;
                self.open_failing = false;
            }
            Err(error) => {
                self.file = None;
                if !self.open_failing {
                    self.open_failing = true;
                    eprintln!("[lasterm] cannot open {}: {error}", self.path.display());
                }
            }
        }
    }

    /// Move `hub.log` to `hub.log.old` and start a new one. The handle is still
    /// open during the rename: the standard library opens files sharing delete
    /// access on Windows, which is what lets the rename through, and elsewhere a
    /// rename never minds an open file.
    fn rotate(&mut self) {
        match std::fs::rename(&self.path, &self.previous) {
            Ok(()) => {
                self.rotation_failing = false;
                // That handle now writes to the previous file, which is full.
                self.file = None;
                self.reopen();
            }
            // Removed from under the writer: there is nothing to move, and the
            // handle writes to a file nobody can read.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.file = None;
                self.reopen();
            }
            // Held by something that does not share delete access, such as a
            // viewer following the file. Nothing is lost: the line is appended,
            // and the next one tries again.
            Err(error) => {
                if !self.rotation_failing {
                    self.rotation_failing = true;
                    eprintln!(
                        "[lasterm] cannot move {} aside: {error}",
                        self.path.display()
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_DIR_COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A directory of its own, removed when the test ends.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> TestDir {
            let path = std::env::temp_dir().join(format!(
                "lasterm-hub-log-{name}-{}-{}",
                std::process::id(),
                TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("create the test directory");
            TestDir(path)
        }

        fn read(&self, file: &str) -> String {
            std::fs::read_to_string(self.0.join(file)).unwrap_or_default()
        }

        fn size(&self, file: &str) -> u64 {
            std::fs::metadata(self.0.join(file)).map_or(0, |m| m.len())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const LIMIT: u64 = 256;

    fn line(n: usize) -> String {
        format!("[hub:stdout] line {n:04} of the hub's output")
    }

    /// The numbers of the lines the two files hold, the previous file first.
    fn kept(dir: &TestDir) -> Vec<usize> {
        let text = dir.read(HUB_LOG_PREVIOUS_FILE) + &dir.read(HUB_LOG_FILE);
        text.lines()
            .map(|l| {
                l.split_whitespace()
                    .nth(2)
                    .and_then(|n| n.parse().ok())
                    .unwrap_or_else(|| panic!("not a line this test wrote: {l:?}"))
            })
            .collect()
    }

    /// What was kept is the end of what was written, in order and without a gap.
    fn assert_kept_tail(dir: &TestDir, written: usize) {
        let kept = kept(dir);
        assert!(!kept.is_empty(), "the log keeps the latest lines");
        let first = written - kept.len();
        assert_eq!(kept, (first..written).collect::<Vec<_>>());
    }

    #[test]
    fn a_log_that_reaches_the_limit_is_moved_aside_and_started_again() {
        let dir = TestDir::new("limit");
        let log = HubLog::open(&dir.0, LIMIT);
        let written = 40;
        for n in 0..written {
            log.record(&line(n));
        }

        assert!(
            dir.size(HUB_LOG_FILE) <= LIMIT,
            "hub.log stays under the limit"
        );
        assert!(
            dir.size(HUB_LOG_PREVIOUS_FILE) > 0,
            "the lines before it are kept once"
        );
        assert!(dir.size(HUB_LOG_PREVIOUS_FILE) <= LIMIT);
        assert_kept_tail(&dir, written);
    }

    #[test]
    fn a_log_already_past_the_limit_is_moved_aside_before_its_next_line() {
        let dir = TestDir::new("inherited");
        let inherited = "x".repeat(4 * LIMIT as usize);
        std::fs::write(dir.0.join(HUB_LOG_FILE), &inherited).expect("an existing hub.log");

        let log = HubLog::open(&dir.0, LIMIT);
        log.record(&line(0));

        assert_eq!(dir.read(HUB_LOG_FILE), format!("{}\n", line(0)));
        assert_eq!(dir.read(HUB_LOG_PREVIOUS_FILE), inherited);
    }

    /// A hub restarted after it died is launched while the reader of the one
    /// before may still be writing: the two must not each move the file aside.
    #[test]
    fn launches_that_overlap_share_one_log_and_lose_nothing() {
        let dir = TestDir::new("overlap");
        let slot = OnceLock::new();
        let dying = shared(&slot, &dir.0, LIMIT);
        let restarted = shared(&slot, &dir.0, LIMIT);
        let written = 60;
        for n in 0..written {
            let launch = if n % 2 == 0 { &dying } else { &restarted };
            launch.record(&line(n));
        }

        assert!(
            dir.size(HUB_LOG_FILE) <= LIMIT,
            "hub.log stays under the limit"
        );
        assert!(dir.size(HUB_LOG_PREVIOUS_FILE) <= LIMIT);
        assert_kept_tail(&dir, written);
    }

    /// Something holding the file, a viewer following it say, can refuse the
    /// rename for a while. The hub goes on printing all the same.
    #[test]
    fn a_log_that_cannot_be_moved_aside_keeps_every_line_until_it_can() {
        let dir = TestDir::new("held");
        // A directory where the previous file goes: no rename can replace it.
        let blocker = dir.0.join(HUB_LOG_PREVIOUS_FILE);
        std::fs::create_dir(&blocker).expect("block the rename");
        let log = HubLog::open(&dir.0, LIMIT);
        let held = 20;
        for n in 0..held {
            log.record(&line(n));
        }
        let all: Vec<String> = (0..held).map(line).collect();
        let lines = |text: String| text.lines().map(str::to_string).collect::<Vec<_>>();
        assert_eq!(lines(dir.read(HUB_LOG_FILE)), all, "no line is lost");

        std::fs::remove_dir(&blocker).expect("unblock the rename");
        log.record(&line(held));

        assert_eq!(lines(dir.read(HUB_LOG_PREVIOUS_FILE)), all);
        assert_eq!(dir.read(HUB_LOG_FILE), format!("{}\n", line(held)));
    }
}
