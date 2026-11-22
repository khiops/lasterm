//! Downloads from a terminal's host (#840): the shell asks where with its
//! native dialog, then streams the hub's bytes to disk itself; the page gets
//! progress and the outcome, never the bytes.
//!
//! A file is written to a hidden partial beside its target,
//! `.<name>.<16 hex>.lasterm-download`, created exclusively, and placed only
//! once whole: over the target when the dialog asked about replacing it and
//! the target is still the one it was then, otherwise without replacing
//! (a hard link, or an exclusive copy where hard links are unsupported). A
//! name taken meanwhile is never replaced: the partial is kept and named.
//!
//! Nothing here logs a path or a name: they are the user's.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// The most bytes a name may hold, as most file systems allow.
pub(crate) const MAX_NAME_BYTES: usize = 255;

/// How often the page hears of one download's progress.
pub(crate) const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// How long a download waits for the hub's next bytes before it fails.
pub(crate) const IDLE_LIMIT: Duration = Duration::from_secs(60);

/// How long the download client waits to connect to the hub.
pub(crate) const CONNECT_LIMIT: Duration = Duration::from_secs(10);

/// How many times a placement retries a file another program holds.
pub(crate) const PLACE_ATTEMPTS: u32 = 3;

/// The pause between those attempts.
pub(crate) const PLACE_RETRY_PAUSE: Duration = Duration::from_millis(100);

/// The bytes one write takes from the hub's response.
const CHUNK_BYTES: usize = 256 * 1024;

/// What a file was when the dialog returned: kept to tell later whether it is
/// still the one the person agreed to replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub size: u64,
    pub modified: Option<SystemTime>,
    /// A regular file; otherwise a link, a folder or anything else under that name.
    pub is_file: bool,
}

/// How a download ended, as the page hears it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "outcome")]
pub(crate) enum Outcome {
    Done {
        final_name: String,
        /// The partial that could not be removed once the file was placed, left beside it.
        kept_partial: Option<String>,
    },
    Failed {
        error: String,
        code: Option<String>,
    },
    Cancelled,
}

/// The file system operations a placement uses, so that tests can make them fail.
pub(crate) trait PlaceOps: Send + Sync {
    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn copy_new(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn remove(&self, path: &Path) -> std::io::Result<()>;
    fn pause(&self, duration: Duration);
}

/// The real file system.
pub(crate) struct RealOps;

impl PlaceOps for RealOps {
    #[expect(
        clippy::disallowed_methods,
        reason = "places a download the person chose a folder for, never a protected file"
    )]
    fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::hard_link(from, to)
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "places a download the person chose a folder for, never a protected file"
    )]
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "copies a download into a folder the person chose, never a protected file"
    )]
    fn copy_new(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        let mut source = File::open(from)?;
        let mut target = OpenOptions::new().write(true).create_new(true).open(to)?;
        let copied = std::io::copy(&mut source, &mut target).and_then(|_| target.sync_all());
        if let Err(error) = copied {
            drop(target);
            let _ = std::fs::remove_file(to);
            return Err(error);
        }
        Ok(())
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "removes a partial download the shell created itself"
    )]
    fn remove(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// `name` cut at a character boundary to at most `bytes` UTF-8 bytes, keeping at least one character.
fn cut_to_bytes(name: &str, bytes: usize) -> &str {
    let mut end = 0;
    for (index, character) in name.char_indices() {
        let next = index + character.len_utf8();
        if next > bytes {
            break;
        }
        end = next;
    }
    if end == 0 {
        let first = name.chars().next().map_or(0, char::len_utf8);
        return &name[..first];
    }
    &name[..end]
}

/// The partial a file is written to beside its target: `.<name>.<16 hex>.lasterm-download`,
/// the name cut so the whole fits `MAX_NAME_BYTES`, as the hub's upload temporaries are.
pub(crate) fn partial_name(name: &str, hex: &str) -> String {
    let tail = format!(".{hex}.lasterm-download");
    let room = MAX_NAME_BYTES.saturating_sub(1 + tail.len());
    format!(".{}{tail}", cut_to_bytes(name, room))
}

/// 16 random hex digits.
pub(crate) fn random_hex() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap_or_else(|_| {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        bytes.copy_from_slice(&(nanos as u64).to_le_bytes());
    });
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What is at `path` now, not following a link; None when nothing is there or it cannot be read.
#[expect(
    clippy::disallowed_methods,
    reason = "looks at a download's target in a folder the person chose"
)]
pub(crate) fn identity_of(path: &Path) -> Option<Identity> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    Some(Identity {
        size: metadata.len(),
        modified: metadata.modified().ok(),
        is_file: metadata.is_file(),
    })
}

/// `path` in the form a long path needs on Windows (`\\?\C:\…`); unchanged elsewhere.
pub(crate) fn long_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.as_os_str().to_string_lossy();
        if text.starts_with(r"\\?\") {
            return path.to_path_buf();
        }
        if let Some(share) = text.strip_prefix(r"\\") {
            return PathBuf::from(format!(r"\\?\UNC\{share}"));
        }
        if path.is_absolute() {
            return PathBuf::from(format!(r"\\?\{text}"));
        }
    }
    path.to_path_buf()
}

/// The bytes a download reads, and what the hub said of them.
pub(crate) trait Source: Read {
    fn status(&self) -> u16;
    fn content_length(&self) -> Option<u64>;
    /// The response's ETag, for the page to record.
    fn etag(&self) -> Option<String> {
        None
    }
    /// The error code the hub's JSON refusal names, in either of its shapes:
    /// `{ error: { code } }` from a route, `{ error: "<code>" }` from the auth hook.
    fn error_code(&mut self) -> Option<String> {
        let mut body = Vec::new();
        let _ = self.take(64 * 1024).read_to_end(&mut body);
        let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
        let error = value.get("error")?;
        error
            .get("code")
            .and_then(|code| code.as_str())
            .or_else(|| error.as_str())
            .map(str::to_string)
    }
}

impl Source for reqwest::blocking::Response {
    fn status(&self) -> u16 {
        reqwest::blocking::Response::status(self).as_u16()
    }

    fn content_length(&self) -> Option<u64> {
        reqwest::blocking::Response::content_length(self)
    }

    fn etag(&self) -> Option<String> {
        self.headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    }
}

/// One file to write.
pub(crate) struct FileJob {
    /// The folder the file goes in.
    pub dir: PathBuf,
    /// Its name there.
    pub name: String,
    /// The partial's name; a fresh one when None.
    pub partial: Option<String>,
    /// What the target was when the dialog returned, if anything was there.
    pub existing_at_dialog: Option<Identity>,
}

/// Write `source` to `job`'s target through its partial, telling `progress`
/// the bytes written at most every `PROGRESS_EVERY`, and stopping when
/// `cancel` is set.
pub(crate) fn write_file(
    job: &FileJob,
    mut source: impl Source,
    cancel: &AtomicBool,
    started: impl FnOnce(Option<String>, u64),
    mut progress: impl FnMut(u64, Option<u64>),
    ops: &dyn PlaceOps,
) -> Outcome {
    // A cancel that came while the request waited for its answer.
    if cancel.load(Ordering::SeqCst) {
        return Outcome::Cancelled;
    }
    let status = source.status();
    if status != 200 {
        let code = source.error_code();
        return Outcome::Failed {
            error: format!(
                "The hub refused the download ({})",
                code.as_deref().unwrap_or("no reason given")
            ),
            code,
        };
    }
    let Some(total) = source.content_length() else {
        return Outcome::Failed {
            error: "The hub did not say how long the file is".to_string(),
            code: None,
        };
    };
    started(source.etag(), total);
    let partial_name = job
        .partial
        .clone()
        .unwrap_or_else(|| partial_name(&job.name, &random_hex()));
    let partial = long_path(&job.dir.join(&partial_name));
    let target = long_path(&job.dir.join(&job.name));
    let mut file = match create_partial(&partial) {
        Ok(file) => file,
        Err(error) => {
            return Outcome::Failed {
                error: format!("The file could not be created: {error}"),
                code: None,
            }
        }
    };
    let fail = |error: String| {
        let _ = ops.remove(&partial);
        Outcome::Failed { error, code: None }
    };
    let mut written: u64 = 0;
    let mut told = Instant::now() - PROGRESS_EVERY;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = ops.remove(&partial);
            return Outcome::Cancelled;
        }
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) if cancel.load(Ordering::SeqCst) => {
                drop(file);
                let _ = ops.remove(&partial);
                return Outcome::Cancelled;
            }
            Err(error) => return fail(format!("The download stopped: {error}")),
        };
        if let Err(error) = file.write_all(&buffer[..read]) {
            return fail(format!("The file could not be written: {error}"));
        }
        written += read as u64;
        if told.elapsed() >= PROGRESS_EVERY {
            told = Instant::now();
            progress(written, Some(total));
        }
    }
    if written != total {
        return fail(format!(
            "The download ended early: {written} of {total} bytes came"
        ));
    }
    if let Err(error) = file.sync_all() {
        return fail(format!("The file could not be written: {error}"));
    }
    drop(file);
    // The last chance to cancel: nothing is placed after it.
    if cancel.load(Ordering::SeqCst) {
        let _ = ops.remove(&partial);
        return Outcome::Cancelled;
    }
    place(
        &partial,
        &partial_name,
        &target,
        &job.name,
        job.existing_at_dialog,
        ops,
    )
}

#[expect(
    clippy::disallowed_methods,
    reason = "creates a partial download in a folder the person chose"
)]
fn create_partial(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Whether `error` is a file another program holds, which a moment may free.
fn held_elsewhere(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ResourceBusy
    ) || matches!(error.raw_os_error(), Some(32 | 33)) // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
}

/// Run `operation`, retrying it while another program holds the file.
fn with_retries(
    ops: &dyn PlaceOps,
    mut operation: impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut attempt = 1;
    loop {
        match operation() {
            Err(error) if held_elsewhere(&error) && attempt < PLACE_ATTEMPTS => {
                attempt += 1;
                ops.pause(PLACE_RETRY_PAUSE);
            }
            other => return other,
        }
    }
}

/// Put the whole partial under its name (Destruction rule of the spec).
fn place(
    partial: &Path,
    partial_name: &str,
    target: &Path,
    name: &str,
    existing_at_dialog: Option<Identity>,
    ops: &dyn PlaceOps,
) -> Outcome {
    let kept = |why: String| Outcome::Failed {
        error: format!("{why}; kept as {partial_name}"),
        code: None,
    };
    let done = |removed: bool| Outcome::Done {
        final_name: name.to_string(),
        kept_partial: (!removed).then(|| partial_name.to_string()),
    };
    // What a name taken at placement is: something the dialog saw that is no
    // plain file, or something that appeared meanwhile.
    let taken = || match existing_at_dialog {
        Some(seen) if !seen.is_file => kept(format!("{name} is not a plain file")),
        _ => kept(format!("{name} appeared meanwhile")),
    };
    // The dialog asked about replacing it, and it is still that file.
    if let Some(agreed) = existing_at_dialog {
        if agreed.is_file && identity_of(target) == Some(agreed) {
            return match with_retries(ops, || ops.rename(partial, target)) {
                Ok(()) => done(true),
                Err(error) => kept(format!("{name} could not be placed: {error}")),
            };
        }
    }
    match with_retries(ops, || ops.hard_link(partial, target)) {
        Ok(()) => done(with_retries(ops, || ops.remove(partial)).is_ok()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => taken(),
        Err(error) if link_unsupported(&error) => {
            match with_retries(ops, || ops.copy_new(partial, target)) {
                Ok(()) => done(with_retries(ops, || ops.remove(partial)).is_ok()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => taken(),
                Err(error) => kept(format!("{name} could not be placed: {error}")),
            }
        }
        Err(error) => kept(format!("{name} could not be placed: {error}")),
    }
}

/// Whether a hard link failed because the file system has none (FAT, exFAT).
fn link_unsupported(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::Unsupported || matches!(error.raw_os_error(), Some(1 | 50))
    // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED
}

/// A running download, as the shell holds it.
pub(crate) struct Running {
    pub cancel: Arc<AtomicBool>,
}

/// The download client: the hub's pinned TLS, no total time limit, a 60 s limit on each wait for bytes.
pub(crate) fn download_client(
    config: rustls::ClientConfig,
    redirects: reqwest::redirect::Policy,
    idle: Duration,
) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        // The blocking client applies this to each wait, the connection and
        // every read of the body: a steady download never meets it.
        .timeout(idle)
        .connect_timeout(CONNECT_LIMIT)
        .redirect(redirects)
        .use_preconfigured_tls(config)
        .build()
        .map_err(|error| format!("failed to build the download client: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Bytes {
        status: u16,
        length: Option<u64>,
        body: std::io::Cursor<Vec<u8>>,
    }

    impl Read for Bytes {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.body.read(buf)
        }
    }

    impl Source for Bytes {
        fn status(&self) -> u16 {
            self.status
        }
        fn content_length(&self) -> Option<u64> {
            self.length
        }
    }

    fn ok(body: &[u8]) -> Bytes {
        Bytes {
            status: 200,
            length: Some(body.len() as u64),
            body: std::io::Cursor::new(body.to_vec()),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lasterm-840-{tag}-{}", random_hex()));
        #[expect(clippy::disallowed_methods, reason = "a test's own folder")]
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        #[expect(clippy::disallowed_methods, reason = "a test's own folder")]
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[expect(clippy::disallowed_methods, reason = "a test's own folder")]
    fn read(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap()
    }

    #[expect(clippy::disallowed_methods, reason = "a test's own folder")]
    fn write(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
    }

    fn job(dir: &Path, name: &str) -> FileJob {
        FileJob {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            partial: None,
            existing_at_dialog: identity_of(&dir.join(name)),
        }
    }

    /// The real file system, with a hook that runs before each placement step and can fail it.
    struct HookedOps {
        before_link: Mutex<Option<Box<dyn FnMut() + Send>>>,
        link_error: Option<std::io::ErrorKind>,
        link_raw: Option<i32>,
        copy_fails: bool,
        rename_raw: Option<i32>,
        attempts: Mutex<u32>,
        pauses: Mutex<Vec<Duration>>,
    }

    impl HookedOps {
        fn new() -> Self {
            Self {
                before_link: Mutex::new(None),
                link_error: None,
                link_raw: None,
                copy_fails: false,
                rename_raw: None,
                attempts: Mutex::new(0),
                pauses: Mutex::new(Vec::new()),
            }
        }
    }

    impl PlaceOps for HookedOps {
        fn hard_link(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            if let Some(hook) = self.before_link.lock().unwrap().as_mut() {
                hook();
            }
            if let Some(raw) = self.link_raw {
                return Err(std::io::Error::from_raw_os_error(raw));
            }
            if let Some(kind) = self.link_error {
                return Err(std::io::Error::from(kind));
            }
            RealOps.hard_link(from, to)
        }
        fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            *self.attempts.lock().unwrap() += 1;
            if let Some(raw) = self.rename_raw {
                return Err(std::io::Error::from_raw_os_error(raw));
            }
            RealOps.rename(from, to)
        }
        fn copy_new(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            if self.copy_fails {
                // A half copy that the failing copy removes, as the real one does.
                write(to, b"half");
                RealOps.remove(to)?;
                return Err(std::io::Error::other("the disk went away"));
            }
            RealOps.copy_new(from, to)
        }
        fn remove(&self, path: &Path) -> std::io::Result<()> {
            RealOps.remove(path)
        }
        fn pause(&self, duration: Duration) {
            self.pauses.lock().unwrap().push(duration);
        }
    }

    #[test]
    fn download_writes_through_partial() {
        let dir = temp_dir("write");
        let body = vec![7u8; 600_000];
        let mut seen = Vec::new();
        let outcome = write_file(
            &job(&dir, "report.pdf"),
            ok(&body),
            &AtomicBool::new(false),
            |_, _| {},
            |written, total| seen.push((written, total)),
            &RealOps,
        );
        assert_eq!(
            outcome,
            Outcome::Done {
                final_name: "report.pdf".into(),
                kept_partial: None,
            }
        );
        assert_eq!(read(&dir.join("report.pdf")), body);
        assert_eq!(entries(&dir), vec!["report.pdf"], "no partial is left");
        // Told when the first chunk is written; the end is the ended event's.
        assert_eq!(seen.len(), 1);
    }

    #[test]
    fn download_progress_is_throttled() {
        let dir = temp_dir("throttle");
        let body = vec![1u8; 4 * 1024 * 1024];
        let mut seen = 0;
        write_file(
            &job(&dir, "big.bin"),
            ok(&body),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| seen += 1,
            &RealOps,
        );
        // Sixteen chunks written well within 250 ms: the first and the last are told.
        assert!(seen <= 3, "told {seen} times");
    }

    /// Bytes that set `cancel` once their first chunk was read.
    struct CancelAfterFirst<'a> {
        inner: Bytes,
        cancel: &'a AtomicBool,
        reads: &'a std::cell::Cell<usize>,
    }

    impl Read for CancelAfterFirst<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let end = buf.len().min(1000);
            let read = self.inner.read(&mut buf[..end])?;
            self.reads.set(self.reads.get() + 1);
            self.cancel.store(true, Ordering::SeqCst);
            Ok(read)
        }
    }

    impl Source for CancelAfterFirst<'_> {
        fn status(&self) -> u16 {
            200
        }
        fn content_length(&self) -> Option<u64> {
            self.inner.length
        }
    }

    #[test]
    fn download_cancel_mid_stream_removes_partial() {
        let dir = temp_dir("cancel-mid");
        let cancel = AtomicBool::new(false);
        let reads = std::cell::Cell::new(0);
        let source = CancelAfterFirst {
            inner: ok(&vec![5u8; 100_000]),
            cancel: &cancel,
            reads: &reads,
        };
        let outcome = write_file(
            &job(&dir, "f.bin"),
            source,
            &cancel,
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert_eq!(outcome, Outcome::Cancelled);
        // Stopped at the next chunk, not after reading the rest.
        assert_eq!(reads.get(), 1);
        assert!(
            entries(&dir).is_empty(),
            "nothing left: {:?}",
            entries(&dir)
        );
    }

    /// Bytes that set `cancel` when they end.
    struct CancelAtEnd<'a> {
        inner: Bytes,
        cancel: &'a AtomicBool,
    }

    impl Read for CancelAtEnd<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buf)?;
            if read == 0 {
                self.cancel.store(true, Ordering::SeqCst);
            }
            Ok(read)
        }
    }

    impl Source for CancelAtEnd<'_> {
        fn status(&self) -> u16 {
            200
        }
        fn content_length(&self) -> Option<u64> {
            self.inner.length
        }
    }

    #[test]
    fn download_cancel_after_the_last_byte_places_nothing() {
        let dir = temp_dir("cancel-end");
        let cancel = AtomicBool::new(false);
        let source = CancelAtEnd {
            inner: ok(b"whole"),
            cancel: &cancel,
        };
        let outcome = write_file(
            &job(&dir, "f.bin"),
            source,
            &cancel,
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert_eq!(outcome, Outcome::Cancelled);
        assert!(
            entries(&dir).is_empty(),
            "nothing placed: {:?}",
            entries(&dir)
        );
    }

    #[test]
    fn download_tells_its_start_once() {
        let dir = temp_dir("started");
        let mut seen = Vec::new();
        write_file(
            &job(&dir, "f.bin"),
            ok(b"abc"),
            &AtomicBool::new(false),
            |etag, total| seen.push((etag, total)),
            |_, _| {},
            &RealOps,
        );
        assert_eq!(seen, vec![(None, 3)]);
    }

    #[test]
    fn download_over_a_name_that_is_no_plain_file() {
        // The dialog saw a folder under that name: nothing replaced, said as it is.
        let dir = temp_dir("not-plain");
        #[expect(clippy::disallowed_methods, reason = "a test's own folder")]
        std::fs::create_dir(dir.join("f.txt")).unwrap();
        let outcome = write_file(
            &job(&dir, "f.txt"),
            ok(b"data"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(
            matches!(&outcome, Outcome::Failed { error, .. } if error.contains("is not a plain file")),
            "{outcome:?}"
        );
    }

    #[test]
    fn download_cancel_removes_partial() {
        let dir = temp_dir("cancel");
        let cancel = AtomicBool::new(true);
        let outcome = write_file(
            &job(&dir, "f.bin"),
            ok(b"abc"),
            &cancel,
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert_eq!(outcome, Outcome::Cancelled);
        assert!(
            entries(&dir).is_empty(),
            "nothing left: {:?}",
            entries(&dir)
        );
    }

    #[test]
    fn download_short_body_fails() {
        let dir = temp_dir("short");
        let source = Bytes {
            status: 200,
            length: Some(10),
            body: std::io::Cursor::new(b"12345".to_vec()),
        };
        let outcome = write_file(
            &job(&dir, "f.bin"),
            source,
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(matches!(outcome, Outcome::Failed { .. }), "{outcome:?}");
        assert!(entries(&dir).is_empty());
    }

    #[test]
    fn download_refuses_error_status() {
        let dir = temp_dir("refused");
        let route = br#"{"error":{"code":"NOT_FOUND","message":"x"}}"#;
        let source = Bytes {
            status: 404,
            length: Some(route.len() as u64),
            body: std::io::Cursor::new(route.to_vec()),
        };
        let outcome = write_file(
            &job(&dir, "f.bin"),
            source,
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(
            matches!(&outcome, Outcome::Failed { code: Some(code), .. } if code == "NOT_FOUND"),
            "{outcome:?}"
        );
        let hook = br#"{"error":"UNAUTHORIZED","message":"x"}"#;
        let source = Bytes {
            status: 401,
            length: Some(hook.len() as u64),
            body: std::io::Cursor::new(hook.to_vec()),
        };
        let outcome = write_file(
            &job(&dir, "f.bin"),
            source,
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(
            matches!(&outcome, Outcome::Failed { code: Some(code), .. } if code == "UNAUTHORIZED"),
            "{outcome:?}"
        );
        assert!(entries(&dir).is_empty(), "nothing written");
    }

    #[test]
    fn download_replaces_only_what_the_dialog_agreed_to() {
        let dir = temp_dir("replace");
        write(&dir.join("f.txt"), b"old");
        let agreed = job(&dir, "f.txt");
        assert!(agreed.existing_at_dialog.is_some());
        let outcome = write_file(
            &agreed,
            ok(b"new"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(matches!(outcome, Outcome::Done { .. }), "{outcome:?}");
        assert_eq!(read(&dir.join("f.txt")), b"new");
        assert_eq!(entries(&dir), vec!["f.txt"]);
    }

    #[test]
    fn download_does_not_replace_a_file_that_appeared() {
        // Nothing there at dialog time; a file appears before placement.
        let dir = temp_dir("appeared");
        let ops = HookedOps::new();
        let target = dir.join("f.txt");
        *ops.before_link.lock().unwrap() = Some(Box::new(move || write(&target, b"theirs")));
        let outcome = write_file(
            &job(&dir, "f.txt"),
            ok(b"mine"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &ops,
        );
        assert!(
            matches!(&outcome, Outcome::Failed { error, .. } if error.contains("appeared meanwhile") && error.contains("kept as")),
            "{outcome:?}"
        );
        assert_eq!(read(&dir.join("f.txt")), b"theirs");
        assert_eq!(entries(&dir).len(), 2, "the partial is kept");

        // There at dialog time, then changed before placement: not the agreed file.
        let dir = temp_dir("changed");
        write(&dir.join("f.txt"), b"old");
        let agreed = job(&dir, "f.txt");
        write(&dir.join("f.txt"), b"changed!");
        let outcome = write_file(
            &agreed,
            ok(b"mine"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(matches!(outcome, Outcome::Failed { .. }), "{outcome:?}");
        assert_eq!(read(&dir.join("f.txt")), b"changed!");
    }

    #[test]
    fn download_places_by_copy_without_hard_links() {
        let dir = temp_dir("copy");
        let mut ops = HookedOps::new();
        ops.link_error = Some(std::io::ErrorKind::Unsupported);
        let outcome = write_file(
            &job(&dir, "f.txt"),
            ok(b"data"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &ops,
        );
        assert!(matches!(outcome, Outcome::Done { .. }), "{outcome:?}");
        assert_eq!(read(&dir.join("f.txt")), b"data");
        assert_eq!(entries(&dir), vec!["f.txt"]);

        let dir = temp_dir("copy-fails");
        let mut ops = HookedOps::new();
        ops.link_error = Some(std::io::ErrorKind::Unsupported);
        ops.copy_fails = true;
        let outcome = write_file(
            &job(&dir, "f.txt"),
            ok(b"data"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &ops,
        );
        assert!(
            matches!(&outcome, Outcome::Failed { error, .. } if error.contains("kept as")),
            "{outcome:?}"
        );
        let left = entries(&dir);
        assert_eq!(left.len(), 1, "only the partial: {left:?}");
        assert!(left[0].ends_with(".lasterm-download"));
    }

    #[test]
    fn placement_retries_a_held_file_three_times() {
        let dir = temp_dir("held");
        write(&dir.join("f.txt"), b"old");
        let agreed = job(&dir, "f.txt");
        let mut ops = HookedOps::new();
        ops.rename_raw = Some(32); // ERROR_SHARING_VIOLATION
        let outcome = write_file(
            &agreed,
            ok(b"new"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &ops,
        );
        assert!(
            matches!(&outcome, Outcome::Failed { error, .. } if error.contains("kept as")),
            "{outcome:?}"
        );
        assert_eq!(*ops.attempts.lock().unwrap(), 3);
        assert_eq!(*ops.pauses.lock().unwrap(), vec![PLACE_RETRY_PAUSE; 2]);
        assert_eq!(read(&dir.join("f.txt")), b"old");
    }

    /// A one-request HTTP server that sends `total` bytes in `pieces`, `gap` apart.
    fn trickling_server(total: usize, pieces: usize, gap: Duration) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            let head = format!(
                "HTTP/1.1 200 OK
Content-Length: {total}
Connection: close

"
            );
            socket.write_all(head.as_bytes()).unwrap();
            let piece = vec![9u8; total / pieces];
            for _ in 0..pieces {
                std::thread::sleep(gap);
                if socket.write_all(&piece).is_err() {
                    return;
                }
            }
        });
        format!("http://{address}/api/channels/01K840CHAN0000000000000001/files/content?path=x")
    }

    fn plain_client(idle: Duration) -> reqwest::blocking::Client {
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth();
        download_client(config, reqwest::redirect::Policy::none(), idle).unwrap()
    }

    #[test]
    fn download_has_no_total_timeout() {
        // Four pieces 400 ms apart: 1.6 s in all, past a 1 s limit on each wait.
        let dir = temp_dir("steady");
        let url = trickling_server(4000, 4, Duration::from_millis(400));
        let response = plain_client(Duration::from_secs(1))
            .get(&url)
            .send()
            .unwrap();
        let outcome = write_file(
            &job(&dir, "f.bin"),
            response,
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(matches!(outcome, Outcome::Done { .. }), "{outcome:?}");

        // One piece after 1.5 s of silence: the wait for bytes gives up.
        let dir = temp_dir("idle");
        let url = trickling_server(4000, 1, Duration::from_millis(1500));
        let outcome = match plain_client(Duration::from_secs(1)).get(&url).send() {
            Ok(response) => write_file(
                &job(&dir, "f.bin"),
                response,
                &AtomicBool::new(false),
                |_, _| {},
                |_, _| {},
                &RealOps,
            ),
            Err(error) => Outcome::Failed {
                error: error.to_string(),
                code: None,
            },
        };
        assert!(matches!(outcome, Outcome::Failed { .. }), "{outcome:?}");
        assert!(entries(&dir).is_empty(), "the partial went");
    }

    #[test]
    fn partial_name_fits_255_bytes() {
        let long = "é".repeat(200); // 400 bytes
        let name = partial_name(&long, "0123456789abcdef");
        assert!(name.len() <= MAX_NAME_BYTES, "{} bytes", name.len());
        assert!(name.starts_with(".é"));
        assert!(name.ends_with(".0123456789abcdef.lasterm-download"));
        let dir = temp_dir("long-name");
        let ascii = "a".repeat(255);
        let outcome = write_file(
            &job(&dir, &ascii),
            ok(b"x"),
            &AtomicBool::new(false),
            |_, _| {},
            |_, _| {},
            &RealOps,
        );
        assert!(matches!(outcome, Outcome::Done { .. }), "{outcome:?}");
    }
}
