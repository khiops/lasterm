//! A folder to open in a new local terminal, handed over by File Explorer's
//! **Open in lasterm** (#1236, EXPLORER-OPEN-IN in docs/decisions.md).
//!
//! The package's Explorer command starts `lasterm-desktop.exe --open-folder
//! <path>`. That process validates the folder; when another desktop holds the
//! instance lock it sends `open-v1 <path>\n` on the raise endpoint, else it
//! becomes the primary with the folder queued. The primary queues what it
//! accepts; the page takes the queue and opens one terminal per folder.

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
#[cfg(any(windows, test))]
use std::io::Read;
#[cfg(windows)]
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The request a second start sends for a folder.
pub(crate) const OPEN_REQUEST_PREFIX: &[u8] = b"open-v1 ";

/// The longest `open-v1` request: the prefix, a folder of at most
/// `MAX_FOLDER_UNITS` UTF-16 units (3 UTF-8 bytes each at most) and `\n`.
pub(crate) const INSTANCE_OPEN_MAX_BYTES: usize =
    OPEN_REQUEST_PREFIX.len() + 3 * lasterm_explorer_command::rule::MAX_FOLDER_UNITS + 1;

/// How long a second start with a folder keeps trying to deliver it: the
/// hub's 15 s to start (a primary publishes its endpoint once it is up) and a
/// margin.
pub(crate) const INSTANCE_OPEN_HANDOFF_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the second start waits for the reply once the request is written:
/// the primary may be checking a slow drive.
pub(crate) const INSTANCE_OPEN_REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// The longest single wait for the pipe within one attempt.
const OPEN_ATTEMPT_WAIT: Duration = Duration::from_secs(2);

/// The pause between two attempts.
const OPEN_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// How many folders the primary holds for its page at most.
pub(crate) const OPEN_QUEUE_CAPACITY: usize = 16;

/// How often the primary tells its page again while folders wait.
pub(crate) const OPEN_REEMIT_INTERVAL: Duration = Duration::from_secs(2);

/// The event that tells the page folders wait (no payload).
pub(crate) const OPEN_FOLDER_EVENT: &str = "open-folder-requested";

pub(crate) const OPEN_REFUSED: &str = "The running Lasterm instance could not open the folder.";
pub(crate) const OPEN_UNCONFIRMED: &str = "The running Lasterm instance did not confirm that it will open the folder. If an older Lasterm is running, close it and try again.";
pub(crate) const OPEN_NOT_ANSWERED: &str =
    "A running Lasterm instance did not answer the request to open the folder.";

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FolderArgument {
    /// No `--open-folder`: start as before.
    None,
    /// `--open-folder <path>`, exactly.
    Open(OsString),
    /// `--open-folder` with another number of arguments.
    Invalid,
}

/// `[exe, "--open-folder", path]` is a folder to open; any other argv whose
/// element 1 is `--open-folder` is refused; anything else leaves startup as it
/// was.
pub(crate) fn open_folder_argument(args: &[OsString]) -> FolderArgument {
    if args.get(1).map(OsString::as_os_str) != Some(OsStr::new("--open-folder")) {
        return FolderArgument::None;
    }
    match args {
        [_, _, path] => FolderArgument::Open(path.clone()),
        _ => FolderArgument::Invalid,
    }
}

/// What startup does with the command line.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupDecision {
    Normal,
    /// A valid folder: open it, here or in the running instance.
    Open(String),
    /// A refused `--open-folder`: leave with this code before anything starts.
    Exit(i32),
}

pub(crate) fn startup_decision(args: &[OsString]) -> StartupDecision {
    match open_folder_argument(args) {
        FolderArgument::None => StartupDecision::Normal,
        FolderArgument::Invalid => StartupDecision::Exit(2),
        FolderArgument::Open(path) => match validate_open_folder(&path) {
            Some(path) => StartupDecision::Open(path),
            None => StartupDecision::Exit(2),
        },
    }
}

/// The folder as given, when it is valid Unicode, has the form of
/// `rule::lexically_acceptable` and names an existing directory (links
/// followed). Never normalised: the string checked is the string the shell
/// starts in. Off Windows, nothing is accepted: the feature is File
/// Explorer's.
pub(crate) fn validate_open_folder(value: &OsStr) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let path = value.to_str()?;
    if !lasterm_explorer_command::rule::lexically_acceptable(path) {
        return None;
    }
    #[expect(
        clippy::disallowed_methods,
        reason = "reads whether a folder the user chose in File Explorer is a directory, not a protected file"
    )]
    let metadata = std::fs::metadata(path).ok()?;
    metadata.is_dir().then(|| path.to_string())
}

/// A request read from the raise endpoint.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InstanceRequest {
    Raise,
    /// `open-v1 <path>`; `None` when the body is not UTF-8.
    Open(Option<String>),
}

/// The request in `message` (with its `\n`), or `None` for anything else,
/// which gets no reply.
pub(crate) fn parse_instance_request(message: &[u8], raise: &[u8]) -> Option<InstanceRequest> {
    if message == raise {
        return Some(InstanceRequest::Raise);
    }
    let body = message
        .strip_prefix(OPEN_REQUEST_PREFIX)?
        .strip_suffix(b"\n")?;
    Some(InstanceRequest::Open(String::from_utf8(body.to_vec()).ok()))
}

/// The folders the primary holds for its page, and the last batch it handed
/// over, kept with the page's token so a call repeated after a lost reply gets
/// it again.
#[derive(Default)]
pub(crate) struct OpenFolderQueue {
    state: Mutex<QueueState>,
}

#[derive(Default)]
struct QueueState {
    entries: VecDeque<String>,
    reserved: usize,
    last: Option<(String, Vec<String>)>,
    reemitting: bool,
}

/// A place held in the queue while the window is raised.
#[must_use]
pub(crate) struct Reservation(());

impl OpenFolderQueue {
    pub(crate) fn with_initial(folder: Option<String>) -> Self {
        let queue = Self::default();
        if let Some(folder) = folder {
            queue.lock().entries.push_back(folder);
        }
        queue
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Holds a place when admission is open and the queue has room.
    pub(crate) fn reserve(&self, admission_open: impl FnOnce() -> bool) -> Option<Reservation> {
        let mut state = self.lock();
        if !admission_open() || state.entries.len() + state.reserved >= OPEN_QUEUE_CAPACITY {
            return None;
        }
        state.reserved += 1;
        Some(Reservation(()))
    }

    pub(crate) fn release(&self, _reservation: Reservation) {
        let mut state = self.lock();
        state.reserved = state.reserved.saturating_sub(1);
    }

    /// Turns the place into the folder, unless admission closed meanwhile.
    pub(crate) fn commit(
        &self,
        _reservation: Reservation,
        folder: String,
        admission_open: impl FnOnce() -> bool,
    ) -> bool {
        let mut state = self.lock();
        state.reserved = state.reserved.saturating_sub(1);
        if !admission_open() {
            return false;
        }
        state.entries.push_back(folder);
        true
    }

    /// Every folder held, in order, removed; or, for the token of the previous
    /// call, that call's batch again, with nothing removed.
    pub(crate) fn take(&self, token: &str) -> Vec<String> {
        let mut state = self.lock();
        if let Some((last_token, batch)) = &state.last {
            if last_token == token {
                return batch.clone();
            }
        }
        let batch: Vec<String> = state.entries.drain(..).collect();
        state.last = Some((token.to_string(), batch.clone()));
        batch
    }

    pub(crate) fn has(&self) -> bool {
        !self.lock().entries.is_empty()
    }

    /// Claims the re-emitting loop; false when one already runs.
    pub(crate) fn start_reemitting(&self) -> bool {
        let mut state = self.lock();
        !std::mem::replace(&mut state.reemitting, true)
    }

    /// While folders wait: true. Once the queue is empty, the loop stops (and
    /// a later push starts another).
    fn keep_reemitting(&self) -> bool {
        let mut state = self.lock();
        if state.entries.is_empty() {
            state.reemitting = false;
            return false;
        }
        true
    }
}

/// Tells the page every `OPEN_REEMIT_INTERVAL` that folders wait, for as long
/// as they do, so an event lost on the way is told again. Run only by the
/// caller `start_reemitting` answered true. `sleep` is the interval's wait (a
/// test passes one of its own).
pub(crate) fn reemit_while_queued(
    queue: &OpenFolderQueue,
    emit: impl Fn(),
    sleep: impl Fn(Duration),
) {
    loop {
        sleep(OPEN_REEMIT_INTERVAL);
        if !queue.keep_reemitting() {
            return;
        }
        emit();
    }
}

/// The primary's answer to `open-v1`: true (reply `ok`) once the folder is
/// queued in a window that is on screen. In order: the folder's validity; a
/// place in the queue (admission open, room left); the raise, which must
/// leave the window visible and not minimized; then the folder enters the
/// queue if admission is still open, and the page is told.
pub(crate) fn accept_open_folder(
    folder: &str,
    queue: &OpenFolderQueue,
    admission_open: impl Fn() -> bool,
    raise_on_screen: impl FnOnce() -> Result<(), String>,
    told: impl FnOnce(),
) -> bool {
    let Some(folder) = validate_open_folder(OsStr::new(folder)) else {
        return false;
    };
    let Some(reservation) = queue.reserve(&admission_open) else {
        return false;
    };
    if let Err(error) = raise_on_screen() {
        eprintln!("[lasterm] desktop raise for a folder failed: {error}");
        queue.release(reservation);
        return false;
    }
    if !queue.commit(reservation, folder, &admission_open) {
        return false;
    }
    told();
    true
}

/// The primary's answer to `open-v1`, its body decoded or not: a body that is
/// not UTF-8 is refused without any action.
pub(crate) fn answer_open(
    folder: Option<&str>,
    queue: &OpenFolderQueue,
    admission_open: impl Fn() -> bool,
    raise_on_screen: impl FnOnce() -> Result<(), String>,
    told: impl FnOnce(),
) -> bool {
    match folder {
        None => false,
        Some(folder) => accept_open_folder(folder, queue, admission_open, raise_on_screen, told),
    }
}

/// What became of a request a second start sent.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OpenOutcome {
    /// Not written in full: another attempt may follow.
    NotDelivered,
    /// Written in full: the request is never sent again.
    Written(OpenReply),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OpenReply {
    Ok,
    Error,
    /// Closed, another reply, or none before the deadline.
    None,
}

/// A connected endpoint, as the send path uses it.
pub(crate) trait OpenStream {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()>;
    fn flush(&mut self) -> std::io::Result<()>;
    /// One reply line (with its `\n`), at most `INSTANCE_RAISE_MAX_BYTES`, read
    /// until `deadline`.
    fn read_reply(&mut self, deadline: Instant) -> std::io::Result<Option<Vec<u8>>>;
}

/// The request for `folder`.
pub(crate) fn open_request(folder: &str) -> Vec<u8> {
    let mut frame = OPEN_REQUEST_PREFIX.to_vec();
    frame.extend_from_slice(folder.as_bytes());
    frame.push(b'\n');
    frame
}

/// Sends `frame` once the endpoint's server is known to be this user's: the
/// whole frame written is the point of no return; the reply is read until 10 s
/// after it. A flush that fails after it, or a reply that only comes once the
/// deadline has passed (a reader resumed late, finding it waiting), is no
/// confirmation.
pub(crate) fn deliver_open<S: OpenStream>(
    check_server: impl FnOnce() -> Result<(), String>,
    stream: &mut S,
    frame: &[u8],
    now: impl Fn() -> Instant,
    ok: &[u8],
    error: &[u8],
) -> OpenOutcome {
    if let Err(message) = check_server() {
        eprintln!("[lasterm] refusing the desktop endpoint: {message}");
        return OpenOutcome::NotDelivered;
    }
    if stream.write_all(frame).is_err() {
        return OpenOutcome::NotDelivered;
    }
    let deadline = now() + INSTANCE_OPEN_REPLY_TIMEOUT;
    if stream.flush().is_err() {
        return OpenOutcome::Written(OpenReply::None);
    }
    let reply = stream.read_reply(deadline);
    if now() > deadline {
        return OpenOutcome::Written(OpenReply::None);
    }
    OpenOutcome::Written(match reply {
        Ok(Some(reply)) if reply == ok => OpenReply::Ok,
        Ok(Some(reply)) if reply == error => OpenReply::Error,
        _ => OpenReply::None,
    })
}

/// Time, as the handoff loop sees it: a test passes a clock of its own.
pub(crate) trait Clock {
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
}

pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// How a second start with a folder ended.
#[derive(Debug)]
pub(crate) enum OpenHandoff<L> {
    /// The lock was free, or freed: this process is the primary.
    Primary(L),
    /// The running instance queued the folder.
    Delivered,
}

/// Tries the lock, then the endpoint, until `INSTANCE_OPEN_HANDOFF_TIMEOUT`:
/// an attempt's pipe wait gets the time left, at most `OPEN_ATTEMPT_WAIT`; no
/// attempt starts after the deadline; a request written in full is never sent
/// again.
pub(crate) fn hand_off_open<L>(
    mut try_lock: impl FnMut() -> Result<Option<L>, String>,
    mut send: impl FnMut(Duration) -> OpenOutcome,
    clock: &impl Clock,
) -> Result<OpenHandoff<L>, String> {
    let deadline = clock.now() + INSTANCE_OPEN_HANDOFF_TIMEOUT;
    loop {
        if let Some(lock) = try_lock()? {
            return Ok(OpenHandoff::Primary(lock));
        }
        let left = deadline.saturating_duration_since(clock.now());
        if left.is_zero() {
            return Err(OPEN_NOT_ANSWERED.to_string());
        }
        match send(left.min(OPEN_ATTEMPT_WAIT)) {
            OpenOutcome::NotDelivered => {}
            OpenOutcome::Written(OpenReply::Ok) => return Ok(OpenHandoff::Delivered),
            OpenOutcome::Written(OpenReply::Error) => return Err(OPEN_REFUSED.to_string()),
            OpenOutcome::Written(OpenReply::None) => return Err(OPEN_UNCONFIRMED.to_string()),
        }
        let left = deadline.saturating_duration_since(clock.now());
        if left.is_zero() {
            return Err(OPEN_NOT_ANSWERED.to_string());
        }
        clock.sleep(left.min(OPEN_RETRY_INTERVAL));
        if clock.now() >= deadline {
            return Err(OPEN_NOT_ANSWERED.to_string());
        }
    }
}

/// One reply line, `\n` included: no byte past `INSTANCE_RAISE_MAX_BYTES` is
/// read, and a reply that reaches it without `\n` is none.
#[cfg(any(windows, test))]
pub(crate) fn read_open_reply<R: Read>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    crate::read_delimited_raise_message(reader, crate::INSTANCE_RAISE_MAX_BYTES)
}

/// A Windows pipe as the send path uses it, the reply read byte by byte until
/// the deadline.
#[cfg(windows)]
pub(crate) struct PipeStream(pub(crate) std::fs::File);

#[cfg(windows)]
impl OpenStream for PipeStream {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        Write::write_all(&mut self.0, bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::FlushFileBuffers;
        // SAFETY: the handle is the open pipe this value owns.
        if unsafe { FlushFileBuffers(self.0.as_raw_handle()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn read_reply(&mut self, deadline: Instant) -> std::io::Result<Option<Vec<u8>>> {
        let mut reader = crate::WindowsPipeReader {
            stream: &self.0,
            deadline,
        };
        read_open_reply(&mut reader)
    }
}

/// The user SID of `process`, as the bytes Windows compares.
#[cfg(windows)]
fn process_user_sid(process: windows_sys::Win32::Foundation::HANDLE) -> Result<Vec<u8>, String> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    let mut token = std::ptr::null_mut();
    // SAFETY: `process` is a live process handle; `token` a local of this frame.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: OpenProcessToken returned a handle this function now owns.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut needed = 0u32;
    // SAFETY: a size query: no buffer, the size written to `needed`.
    unsafe {
        GetTokenInformation(
            std::os::windows::io::AsRawHandle::as_raw_handle(&token),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if needed == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // u64 words keep the buffer aligned for TOKEN_USER.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: the buffer holds at least `needed` bytes.
    if unsafe {
        GetTokenInformation(
            std::os::windows::io::AsRawHandle::as_raw_handle(&token),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // SAFETY: GetTokenInformation filled a TOKEN_USER at the buffer's start,
    // whose SID points inside the same buffer.
    unsafe {
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let sid = user.User.Sid;
        let length = GetLengthSid(sid) as usize;
        Ok(std::slice::from_raw_parts(sid as *const u8, length).to_vec())
    }
}

/// This process's user SID.
#[cfg(windows)]
pub(crate) fn own_user_sid() -> Result<Vec<u8>, String> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: the pseudo-handle of the current process needs no closing.
    process_user_sid(unsafe { GetCurrentProcess() })
}

/// The process serving `pipe` must run as `expected`.
#[cfg(windows)]
pub(crate) fn verify_pipe_server_runs_as(
    pipe: &std::fs::File,
    expected: &[u8],
) -> Result<(), String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let mut pid = 0u32;
    // SAFETY: `pipe` is a live handle and `pid` a local of this frame.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) } == 0 {
        return Err(format!(
            "cannot tell which process serves the desktop endpoint: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: plain call; a null result is checked below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(format!(
            "cannot open process {pid}, which serves the desktop endpoint: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: OpenProcess returned a handle this function now owns.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let server = process_user_sid(process.as_raw_handle())?;
    if server != expected {
        return Err(format!(
            "the desktop endpoint is served by process {pid}, which runs as another user"
        ));
    }
    Ok(())
}

/// One attempt to deliver `folder` on the Windows endpoint: wait for the pipe
/// at most `wait`, connect at identification level, require the server to run
/// as this user, then send.
#[cfg(windows)]
pub(crate) fn send_open_request(pipe_name: &str, folder: &str, wait: Duration) -> OpenOutcome {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, OPEN_EXISTING, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    };
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    let name: Vec<u16> = pipe_name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: `name` is NUL-terminated.
    if unsafe { WaitNamedPipeW(name.as_ptr(), wait.as_millis().max(1) as u32) } == 0 {
        return OpenOutcome::NotDelivered;
    }
    #[expect(
        clippy::disallowed_methods,
        reason = "opens the Windows named pipe, not a filesystem object"
    )]
    // SAFETY: `name` is NUL-terminated; the result is checked below.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return OpenOutcome::NotDelivered;
    }
    // SAFETY: CreateFileW returned a handle this value now owns.
    let mut stream = PipeStream(unsafe { std::fs::File::from_raw_handle(handle) });
    let check_server = || {
        let own = own_user_sid()?;
        verify_pipe_server_runs_as(&stream.0, &own)
    };
    let checked = check_server();
    deliver_open(
        || checked,
        &mut stream,
        &open_request(folder),
        Instant::now,
        crate::INSTANCE_RAISE_SUCCESS,
        crate::INSTANCE_RAISE_FAILURE,
    )
}

/// Off Windows no folder is ever accepted (`validate_open_folder`), so no
/// second start sends one.
#[cfg(not(windows))]
pub(crate) fn send_open_request(_endpoint: &str, _folder: &str, _wait: Duration) -> OpenOutcome {
    OpenOutcome::NotDelivered
}

#[cfg(test)]
#[expect(
    clippy::disallowed_methods,
    reason = "the tests build their fixtures by pathname, in temporary directories of their own"
)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    /// The spec's values, written out rather than read from the constants
    /// under test.
    const CAPACITY: usize = 16;
    const REEMIT_EVERY: Duration = Duration::from_secs(2);
    const HANDOFF_BUDGET: Duration = Duration::from_secs(20);
    const ATTEMPT_WAIT_MAX: Duration = Duration::from_secs(2);
    const REPLY_DEADLINE: Duration = Duration::from_secs(10);
    const REFUSED: &str = "The running Lasterm instance could not open the folder.";
    const UNCONFIRMED: &str = "The running Lasterm instance did not confirm that it will open the folder. If an older Lasterm is running, close it and try again.";
    const NOT_ANSWERED: &str =
        "A running Lasterm instance did not answer the request to open the folder.";

    /// A temporary directory of the test's own, removed when it goes, a failed
    /// assertion included.
    struct Scratch(std::path::PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = std::path::Path;
        fn deref(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!(
            "lasterm-open-folder-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn open_folder_argument_takes_exactly_the_flag_and_one_path() {
        let d = "C:\\x";
        assert_eq!(
            open_folder_argument(&args(&["exe", "--open-folder", d])),
            FolderArgument::Open(OsString::from(d))
        );
        assert_eq!(
            open_folder_argument(&args(&["exe", "--open-folder"])),
            FolderArgument::Invalid
        );
        assert_eq!(
            open_folder_argument(&args(&["exe", "--open-folder", d, "x"])),
            FolderArgument::Invalid
        );
        assert_eq!(open_folder_argument(&args(&["exe"])), FolderArgument::None);
        assert_eq!(
            open_folder_argument(&args(&["exe", "--reset-hub-pin"])),
            FolderArgument::None
        );
        assert_eq!(
            open_folder_argument(&args(&["exe", "--other", d])),
            FolderArgument::None
        );
    }

    /// An existing directory reached through `..`, with spaces and non-ASCII
    /// characters (the folder AC2, AC3, AC6d and the page share).
    #[cfg(windows)]
    fn folder_through_dot_dot(root: &std::path::Path) -> String {
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let target = root.join("dossier é 漢 x");
        std::fs::create_dir_all(&target).unwrap();
        format!("{}\\sub\\..\\dossier é 漢 x", root.display())
    }

    #[cfg(windows)]
    #[test]
    fn validate_open_folder_accepts_an_existing_directory_unchanged() {
        let root = scratch("accept");
        let folder = folder_through_dot_dot(&root);
        assert_eq!(
            validate_open_folder(OsStr::new(&folder)),
            Some(folder.clone())
        );
    }

    #[test]
    fn validate_open_folder_refuses_every_other_form() {
        let root = scratch("refuse");
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;

            // Lexically refused, though the directory exists: the rule is applied.
            let variable = root.join("${X}");
            std::fs::create_dir_all(&variable).unwrap();
            assert_eq!(validate_open_folder(variable.as_os_str()), None);

            assert_eq!(validate_open_folder(root.join("missing").as_os_str()), None);
            let file = root.join("file.txt");
            std::fs::write(&file, b"").unwrap();
            assert_eq!(validate_open_folder(file.as_os_str()), None);

            // A lone surrogate: a lossy conversion would name this directory.
            std::fs::create_dir_all(root.join("\u{FFFD}")).unwrap();
            let mut wide: Vec<u16> = format!("{}\\", root.display()).encode_utf16().collect();
            wide.push(0xD800);
            assert_eq!(validate_open_folder(&OsString::from_wide(&wide)), None);
        }
        #[cfg(not(windows))]
        assert_eq!(validate_open_folder(root.as_os_str()), None);
    }

    #[test]
    fn the_startup_decision_queues_a_valid_folder_and_exits_on_an_invalid_one() {
        let root = scratch("decision");
        let valid = root.display().to_string();
        let expected_valid = if cfg!(windows) {
            StartupDecision::Open(valid.clone())
        } else {
            StartupDecision::Exit(2)
        };
        assert_eq!(
            startup_decision(&args(&["exe", "--open-folder", &valid])),
            expected_valid
        );
        assert_eq!(
            startup_decision(&args(&["exe", "--open-folder"])),
            StartupDecision::Exit(2)
        );
        let missing = root.join("missing").display().to_string();
        assert_eq!(
            startup_decision(&args(&["exe", "--open-folder", &missing])),
            StartupDecision::Exit(2)
        );
        assert_eq!(startup_decision(&args(&["exe"])), StartupDecision::Normal);
    }

    #[test]
    fn taking_open_folder_requests_is_repeatable_for_one_token() {
        let queue = OpenFolderQueue::default();
        for folder in ["A", "B", "C"] {
            let slot = queue.reserve(|| true).unwrap();
            assert!(queue.commit(slot, folder.to_string(), || true));
        }
        assert_eq!(queue.take("t1"), ["A", "B", "C"]);
        let slot = queue.reserve(|| true).unwrap();
        assert!(queue.commit(slot, "D".to_string(), || true));
        assert_eq!(queue.take("t1"), ["A", "B", "C"]);
        assert!(queue.has());
        assert_eq!(queue.take("t2"), ["D"]);
        assert!(queue.take("t3").is_empty());
        assert!(!queue.has());
    }

    #[test]
    fn open_request_beyond_the_queue_capacity_is_refused() {
        let queue = OpenFolderQueue::default();
        for index in 0..CAPACITY {
            let slot = queue.reserve(|| true).unwrap();
            assert!(queue.commit(slot, format!("F{index}"), || true));
        }
        assert!(queue.reserve(|| true).is_none());
        let expected: Vec<String> = (0..CAPACITY).map(|i| format!("F{i}")).collect();
        assert_eq!(queue.take("t"), expected);
    }

    /// What `accept_open_folder` did, for one call.
    #[derive(Default)]
    struct Effects {
        raised: AtomicBool,
        told: AtomicBool,
        queued_when_told: AtomicUsize,
    }

    #[cfg(windows)]
    #[test]
    fn open_request_queues_the_folder_raises_and_replies_ok() {
        let root = scratch("accept-ok");
        let folder = folder_through_dot_dot(&root);
        assert!(folder.len() > 64);
        let queue = OpenFolderQueue::default();
        let effects = Effects::default();
        let accepted = accept_open_folder(
            &folder,
            &queue,
            || true,
            || {
                effects.raised.store(true, Ordering::SeqCst);
                Ok(())
            },
            || {
                effects.told.store(true, Ordering::SeqCst);
                effects
                    .queued_when_told
                    .store(usize::from(queue.has()), Ordering::SeqCst);
            },
        );
        assert!(accepted);
        assert!(effects.raised.load(Ordering::SeqCst));
        assert!(effects.told.load(Ordering::SeqCst));
        assert_eq!(effects.queued_when_told.load(Ordering::SeqCst), 1);
        assert_eq!(queue.take("t"), [folder]);
    }

    #[cfg(windows)]
    #[test]
    fn open_request_whose_raise_fails_is_refused() {
        let root = scratch("accept-raise");
        let folder = root.display().to_string();
        let queue = OpenFolderQueue::default();
        let told = AtomicBool::new(false);
        let accepted = accept_open_folder(
            &folder,
            &queue,
            || true,
            || Err("the window stays minimized".to_string()),
            || told.store(true, Ordering::SeqCst),
        );
        assert!(!accepted);
        assert!(!told.load(Ordering::SeqCst));
        assert!(!queue.has());
        // The released place is free again.
        for _ in 0..CAPACITY {
            let _ = queue.reserve(|| true).expect("a free place");
        }
    }

    #[cfg(windows)]
    #[test]
    fn open_request_while_quitting_is_refused() {
        let root = scratch("accept-quit");
        let folder = root.display().to_string();
        let queue = OpenFolderQueue::default();
        let raised = AtomicBool::new(false);

        // Admission closed before: no raise, nothing queued.
        assert!(!accept_open_folder(
            &folder,
            &queue,
            || false,
            || {
                raised.store(true, Ordering::SeqCst);
                Ok(())
            },
            || panic!("told")
        ));
        assert!(!raised.load(Ordering::SeqCst));
        assert!(!queue.has());

        // Admission closing during the raise (a quit decided meanwhile).
        let open = AtomicBool::new(true);
        assert!(!accept_open_folder(
            &folder,
            &queue,
            || open.load(Ordering::SeqCst),
            || {
                open.store(false, Ordering::SeqCst);
                Ok(())
            },
            || panic!("told")
        ));
        assert!(!queue.has());

        // Open again (a quit abandoned): queued.
        assert!(accept_open_folder(
            &folder,
            &queue,
            || true,
            || Ok(()),
            || {}
        ));
        assert!(queue.has());
    }

    #[test]
    fn open_request_with_an_invalid_folder_is_refused_without_action() {
        let root = scratch("accept-invalid");
        let queue = OpenFolderQueue::default();
        let missing = root.join("missing").display().to_string();
        assert!(!accept_open_folder(
            &missing,
            &queue,
            || true,
            || panic!("raised"),
            || panic!("told")
        ));
        assert!(!queue.has());
        // `open-v1` whose body is not UTF-8.
        assert!(!answer_open(
            None,
            &queue,
            || true,
            || panic!("raised"),
            || panic!("told")
        ));
        assert!(!queue.has());
    }

    #[test]
    fn the_open_folder_event_repeats_while_the_queue_holds_an_entry() {
        let queue = OpenFolderQueue::with_initial(Some("D".to_string()));
        let emitted = Cell::new(0u32);
        let slept = Cell::new(0u32);
        assert!(queue.start_reemitting());
        assert!(!queue.start_reemitting(), "one loop at a time");
        reemit_while_queued(
            &queue,
            || emitted.set(emitted.get() + 1),
            |interval| {
                assert_eq!(interval, REEMIT_EVERY);
                slept.set(slept.get() + 1);
                if slept.get() == 3 {
                    // The page takes the folder before the third tick.
                    let _ = queue.take("t");
                }
            },
        );
        assert_eq!(emitted.get(), 2, "two ticks while queued, none once empty");
        assert_eq!(slept.get(), 3);
        // A later folder starts another loop.
        let slot = queue.reserve(|| true).unwrap();
        assert!(queue.commit(slot, "E".to_string(), || true));
        let again = Cell::new(0u32);
        assert!(
            queue.start_reemitting(),
            "the ended loop let go of its claim"
        );
        reemit_while_queued(
            &queue,
            || {},
            |_| {
                again.set(again.get() + 1);
                if again.get() == 1 {
                    let _ = queue.take("t2");
                }
            },
        );
        assert_eq!(again.get(), 1);
    }

    /// A clock whose time moves only when told.
    struct FakeClock {
        now: Cell<Instant>,
    }

    impl FakeClock {
        fn new() -> Self {
            FakeClock {
                now: Cell::new(Instant::now()),
            }
        }
        fn advance(&self, by: Duration) {
            self.now.set(self.now.get() + by);
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.now.get()
        }
        fn sleep(&self, duration: Duration) {
            self.advance(duration);
        }
    }

    #[test]
    fn second_start_with_a_folder_asks_to_open_it() {
        for (reply, expected) in [
            (OpenReply::Ok, Ok(())),
            (OpenReply::Error, Err(REFUSED)),
            (OpenReply::None, Err(UNCONFIRMED)),
        ] {
            let clock = FakeClock::new();
            let mut reply = Some(reply);
            let result = hand_off_open::<()>(
                || Ok(None),
                |_| OpenOutcome::Written(reply.take().expect("one send")),
                &clock,
            );
            match expected {
                Ok(()) => assert!(matches!(result, Ok(OpenHandoff::Delivered))),
                Err(message) => assert_eq!(result.unwrap_err(), message),
            }
        }
    }

    #[test]
    fn second_start_never_sends_a_written_open_request_twice() {
        let clock = FakeClock::new();
        let mut answers = vec![
            OpenOutcome::NotDelivered,
            OpenOutcome::NotDelivered,
            OpenOutcome::Written(OpenReply::None),
        ]
        .into_iter();
        let sends = Cell::new(0);
        let result = hand_off_open::<()>(
            || Ok(None),
            |_| {
                sends.set(sends.get() + 1);
                answers
                    .next()
                    .unwrap_or(OpenOutcome::Written(OpenReply::Ok))
            },
            &clock,
        );
        assert_eq!(result.unwrap_err(), UNCONFIRMED);
        assert_eq!(sends.get(), 3);
    }

    #[test]
    fn an_open_request_waits_for_a_primary_still_starting() {
        // A primary that answers after 8 s.
        let clock = FakeClock::new();
        let start = clock.now();
        let result = hand_off_open::<()>(
            || Ok(None),
            |wait| {
                if clock.now() - start >= Duration::from_secs(8) {
                    OpenOutcome::Written(OpenReply::Ok)
                } else {
                    clock.advance(wait);
                    OpenOutcome::NotDelivered
                }
            },
            &clock,
        );
        assert!(matches!(result, Ok(OpenHandoff::Delivered)));

        // No delivery: no attempt after 20 s, waits never longer than 2 s nor
        // than the time left, and the end between 19.9 s and 20.2 s.
        let clock = FakeClock::new();
        let start = clock.now();
        let waits = RefCell::new(Vec::new());
        let result = hand_off_open::<()>(
            || Ok(None),
            |wait| {
                assert!(clock.now() - start < HANDOFF_BUDGET);
                waits.borrow_mut().push((clock.now() - start, wait));
                clock.advance(wait);
                OpenOutcome::NotDelivered
            },
            &clock,
        );
        assert_eq!(result.unwrap_err(), NOT_ANSWERED);
        let ended = clock.now() - start;
        assert!(
            ended >= Duration::from_millis(19_900) && ended <= Duration::from_millis(20_200),
            "{ended:?}"
        );
        for (at, wait) in waits.borrow().iter() {
            assert!(*wait <= ATTEMPT_WAIT_MAX);
            assert!(*at + *wait <= HANDOFF_BUDGET);
        }
        assert!(
            waits.borrow().last().unwrap().1 < ATTEMPT_WAIT_MAX,
            "the last wait is the time left"
        );

        // The lock freeing at 3 s: this process becomes the primary.
        let clock = FakeClock::new();
        let start = clock.now();
        let result = hand_off_open(
            || Ok((clock.now() - start >= Duration::from_secs(3)).then_some("lock")),
            |wait| {
                clock.advance(wait);
                OpenOutcome::NotDelivered
            },
            &clock,
        );
        assert!(matches!(result, Ok(OpenHandoff::Primary("lock"))));

        // The lock freeing during the last pause, at the deadline: no attempt
        // starts after it, the lock's included.
        let clock = FakeClock::new();
        let start = clock.now();
        let result = hand_off_open(
            || Ok((clock.now() - start >= Duration::from_secs(20)).then_some("lock")),
            |wait| {
                let left = Duration::from_millis(19_950).saturating_sub(clock.now() - start);
                clock.advance(wait.min(left));
                OpenOutcome::NotDelivered
            },
            &clock,
        );
        assert_eq!(result.unwrap_err(), NOT_ANSWERED);
    }

    /// A stream whose writes, flush and reply a test decides, on a fake clock.
    struct FakeStream<'a> {
        clock: &'a FakeClock,
        written: Vec<u8>,
        write_fails_after: Option<usize>,
        flush_fails: bool,
        /// Time spent between the flush and the read.
        delay_before_read: Duration,
        /// The reply, and how long after the read starts it arrives.
        reply: Option<(Vec<u8>, Duration)>,
        /// Time that passes after the reply was found, before the read returns.
        read_returns_after: Duration,
        deadline_seen: Option<Instant>,
    }

    impl<'a> FakeStream<'a> {
        fn new(clock: &'a FakeClock) -> Self {
            FakeStream {
                clock,
                written: Vec::new(),
                write_fails_after: None,
                flush_fails: false,
                delay_before_read: Duration::ZERO,
                reply: None,
                read_returns_after: Duration::ZERO,
                deadline_seen: None,
            }
        }
    }

    impl OpenStream for FakeStream<'_> {
        fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
            if let Some(limit) = self.write_fails_after {
                self.written
                    .extend_from_slice(&bytes[..limit.min(bytes.len())]);
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            self.written.extend_from_slice(bytes);
            Ok(())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.clock.advance(self.delay_before_read);
            if self.flush_fails {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            Ok(())
        }
        fn read_reply(&mut self, deadline: Instant) -> std::io::Result<Option<Vec<u8>>> {
            self.deadline_seen = Some(deadline);
            let returns_after = self.read_returns_after;
            let _late = Advance(self.clock, returns_after);
            match self.reply.take() {
                Some((reply, after)) if self.clock.now() + after <= deadline => {
                    if reply.len() > crate::INSTANCE_RAISE_MAX_BYTES {
                        return Ok(None);
                    }
                    Ok(Some(reply))
                }
                Some(_) => Err(std::io::Error::from(std::io::ErrorKind::TimedOut)),
                None => Ok(None),
            }
        }
    }

    /// Moves the clock when dropped: after the read has chosen its answer.
    struct Advance<'a>(&'a FakeClock, Duration);

    impl Drop for Advance<'_> {
        fn drop(&mut self) {
            self.0.advance(self.1);
        }
    }

    fn deliver(
        stream: &mut FakeStream<'_>,
        check: Result<(), String>,
        frame: &[u8],
    ) -> OpenOutcome {
        let clock = stream.clock;
        deliver_open(
            || check,
            stream,
            frame,
            || clock.now(),
            crate::INSTANCE_RAISE_SUCCESS,
            crate::INSTANCE_RAISE_FAILURE,
        )
    }

    #[cfg(windows)]
    #[test]
    fn the_open_send_path_decides_once_the_frame_is_written() {
        let root = scratch("send-path");
        let folder = folder_through_dot_dot(&root);
        let frame = open_request(&folder);
        let mut expected = b"open-v1 ".to_vec();
        expected.extend_from_slice(folder.as_bytes());
        expected.push(b'\n');
        assert_eq!(frame, expected);
        let clock = FakeClock::new();

        let mut refused = FakeStream::new(&clock);
        assert_eq!(
            deliver(&mut refused, Err("another user".into()), &frame),
            OpenOutcome::NotDelivered
        );
        assert!(
            refused.written.is_empty(),
            "nothing written before the server is checked"
        );

        let mut partial = FakeStream::new(&clock);
        partial.write_fails_after = Some(5);
        assert_eq!(
            deliver(&mut partial, Ok(()), &frame),
            OpenOutcome::NotDelivered
        );

        let mut flush_fails = FakeStream::new(&clock);
        flush_fails.flush_fails = true;
        flush_fails.reply = Some((b"ok\n".to_vec(), Duration::ZERO));
        assert_eq!(
            deliver(&mut flush_fails, Ok(()), &frame),
            OpenOutcome::Written(OpenReply::None)
        );
        assert_eq!(flush_fails.written, frame, "one frame written");

        for (reply, outcome) in [
            (b"ok\n".to_vec(), OpenReply::Ok),
            (b"error\n".to_vec(), OpenReply::Error),
            (b"zz\n".to_vec(), OpenReply::None),
            (vec![b'x'; 80], OpenReply::None),
        ] {
            let mut stream = FakeStream::new(&clock);
            stream.reply = Some((reply, Duration::ZERO));
            assert_eq!(
                deliver(&mut stream, Ok(()), &frame),
                OpenOutcome::Written(outcome)
            );
            assert_eq!(stream.written, frame);
        }
        let mut closed = FakeStream::new(&clock);
        assert_eq!(
            deliver(&mut closed, Ok(()), &frame),
            OpenOutcome::Written(OpenReply::None)
        );

        // The deadline counts from the complete write: 8 s pass before the
        // read starts, and a reply 3 s into the read is too late.
        let mut late = FakeStream::new(&clock);
        late.delay_before_read = Duration::from_secs(8);
        late.reply = Some((b"ok\n".to_vec(), Duration::from_secs(3)));
        let written_at = clock.now();
        assert_eq!(
            deliver(&mut late, Ok(()), &frame),
            OpenOutcome::Written(OpenReply::None)
        );
        assert_eq!(late.deadline_seen, Some(written_at + REPLY_DEADLINE));
        assert_eq!(late.written, frame, "not sent again");

        // `ok` found waiting by a reader that resumed after the deadline.
        let mut resumed_late = FakeStream::new(&clock);
        resumed_late.reply = Some((b"ok\n".to_vec(), Duration::ZERO));
        resumed_late.read_returns_after = Duration::from_secs(11);
        assert_eq!(
            deliver(&mut resumed_late, Ok(()), &frame),
            OpenOutcome::Written(OpenReply::None)
        );
    }

    /// A reader of `x` bytes that fails the test on a read past `budget`.
    struct BoundedReader {
        budget: usize,
        read: usize,
    }

    impl Read for BoundedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            assert!(self.read < self.budget, "read past the reply's 64 bytes");
            let n = buffer.len().min(self.budget - self.read);
            buffer[..n].fill(b'x');
            self.read += n;
            Ok(n)
        }
    }

    #[test]
    fn the_reply_read_stops_at_64_bytes() {
        let mut reader = BoundedReader {
            budget: 64,
            read: 0,
        };
        assert_eq!(read_open_reply(&mut reader).unwrap(), None);
        assert_eq!(reader.read, 64);
    }

    #[cfg(windows)]
    #[test]
    fn the_open_request_goes_only_to_a_server_of_this_user() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};

        let name = format!(r"\\.\pipe\lasterm-open-folder-test-{}", std::process::id());
        let server = crate::create_desktop_raise_pipe(&name).expect("create the pipe");
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        #[expect(clippy::disallowed_methods, reason = "opens a named pipe of this test")]
        // SAFETY: `wide` is NUL-terminated; the result is checked below.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE);
        // SAFETY: CreateFileW returned a handle this value owns.
        let client = unsafe { std::fs::File::from_raw_handle(handle) };
        let own = own_user_sid().unwrap();
        assert!(verify_pipe_server_runs_as(&client, &own).is_ok());
        // LocalSystem, S-1-5-18: not this test's user.
        let system: [u8; 12] = [1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
        assert_ne!(own.as_slice(), system.as_slice());
        assert!(verify_pipe_server_runs_as(&client, &system).is_err());
        let _ = server.as_raw_handle();
    }

    #[test]
    fn instance_requests_are_parsed_strictly() {
        let raise = crate::INSTANCE_RAISE_REQUEST;
        assert_eq!(
            parse_instance_request(raise, raise),
            Some(InstanceRequest::Raise)
        );
        assert_eq!(
            parse_instance_request(b"open-v1 C:\\x\n", raise),
            Some(InstanceRequest::Open(Some("C:\\x".to_string())))
        );
        assert_eq!(
            parse_instance_request(b"open-v1 \xff\n", raise),
            Some(InstanceRequest::Open(None))
        );
        assert_eq!(parse_instance_request(b"open-v1C:\\x\n", raise), None);
        assert_eq!(parse_instance_request(b"unknown\n", raise), None);
    }
}
