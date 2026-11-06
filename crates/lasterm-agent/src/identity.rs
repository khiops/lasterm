//! Per-daemon identity and safe local stop support.
//!
//! An identity record names exactly one process. A reader must confirm the
//! recorded pid, creation-time fingerprint, and executable all still describe
//! one live process before it sends a stop request. `--stop` therefore stops
//! the process the record describes; it does not prove that process still owns
//! the endpoint. Two concurrent stops both send SIGTERM; the second is the
//! daemon's forced-exit request, which cuts teardown short and leaves no exit
//! record.
//!
//! A crash, a kill, or a Windows stop (which terminates the daemon) leaves the
//! live record behind. A record whose process is verifiably gone is stale: the
//! stopper removes it and answers `not running` when nothing listens on the
//! endpoint either (#871). A record that names a different live process, a
//! reused pid or another executable, is not proof of anything and stays, with
//! `record does not match a live process`. Removing a record never signals a
//! process; the worst a wrong removal can do is leave a daemon that a later stop
//! refuses with `no record`.
//!
//! The record is published only after the endpoint binds, so a stop in that
//! small interval finds the endpoint taken and no record naming a live daemon:
//! it answers `no record` and refuses to act. A daemon that has been started
//! but has not bound its endpoint yet is not seen at all, and the stop answers
//! `not running`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const FORMAT_VERSION: u32 = 2;
const LIVE_RECORD_PREFIX: &str = "agent.identity";
const EXIT_RECORD_PREFIX: &str = "agent.exit";
const MAX_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct IdentityRecord {
    pub format_version: u32,
    pub pid: u32,
    pub creation_time: String,
    pub executable: PathBuf,
    pub executable_file_identity: Option<FileIdentity>,
    /// The normalized endpoint this record belongs to. This is checked by a
    /// stopper as well as being part of the record filename.
    pub socket: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct FileIdentity {
    device: u64,
    inode: u64,
}

/// Written only after a graceful daemon shutdown. On Windows, `--stop`
/// terminates the process, so it cannot leave this record; Ctrl+C can still
/// take the graceful path and write one.
#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct ExitRecord {
    #[serde(flatten)]
    pub identity: IdentityRecord,
    pub stop_requested: bool,
    pub forced: bool,
    pub outcome: String,
    pub unconfirmed_terminals: Vec<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum StopOutcome {
    /// The recorded daemon was live, and is gone now.
    Stopped,
    /// No daemon to stop: no record names a live process (there is none, or
    /// the one there named a process that is gone, and was removed), and
    /// nothing listens on the endpoint.
    NotRunning,
    StillRunningAtBound,
    /// Something listens on the endpoint, but no record names a live process:
    /// in practice a daemon between binding and publishing its record.
    NoRecord,
    /// The record is malformed, names another endpoint, or names a process
    /// that is live but not the one recorded. It is kept.
    RecordDoesNotMatchLiveProcess,
}

impl StopOutcome {
    pub(crate) fn words(&self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::NotRunning => "not running",
            Self::StillRunningAtBound => "still running at the bound",
            Self::NoRecord => "no record",
            Self::RecordDoesNotMatchLiveProcess => "record does not match a live process",
        }
    }

    /// Whether `--stop` exits 0: no daemon is left on the endpoint that a
    /// record named.
    pub(crate) fn succeeded(&self) -> bool {
        matches!(self, Self::Stopped | Self::NotRunning)
    }
}

/// Return the record directory for an already-normalized endpoint identity.
pub(crate) fn state_dir_for_socket(socket_identity: &str) -> io::Result<PathBuf> {
    #[cfg(unix)]
    {
        match Path::new(socket_identity)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            Some(parent) => Ok(parent.to_path_buf()),
            None => default_state_dir(),
        }
    }
    #[cfg(windows)]
    {
        let _ = socket_identity;
        default_state_dir()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = socket_identity;
        default_state_dir()
    }
}

/// The endpoint name is identity data, not merely a hint for finding the
/// record. Unix paths are made absolute and lexically normalized; Windows
/// pipe names are case-insensitive.
pub(crate) fn socket_identity(socket: &str) -> String {
    #[cfg(unix)]
    {
        let path = Path::new(socket);
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        };
        let mut normalized = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                _ => normalized.push(component.as_os_str()),
            }
        }
        normalized.to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        socket.to_lowercase()
    }
    #[cfg(not(any(unix, windows)))]
    {
        socket.to_owned()
    }
}

fn default_state_dir() -> io::Result<PathBuf> {
    crate::platform_dirs::lasterm_dir(crate::platform_dirs::DirKind::State)
}

pub(crate) fn live_record_path(state_dir: &Path, socket: &str) -> PathBuf {
    record_path(state_dir, LIVE_RECORD_PREFIX, socket)
}

pub(crate) fn exit_record_path(state_dir: &Path, socket: &str) -> PathBuf {
    record_path(state_dir, EXIT_RECORD_PREFIX, socket)
}

fn record_path(state_dir: &Path, prefix: &str, socket: &str) -> PathBuf {
    // A filename cannot safely contain an arbitrary pipe name. The complete
    // socket identity remains in the record and is checked after reading, so a
    // theoretical hash collision is a no-action mismatch, never cross-socket
    // signalling.
    state_dir.join(format!("{prefix}-{:016x}.json", socket_hash(socket)))
}

fn socket_hash(socket: &str) -> u64 {
    socket
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

pub(crate) fn create_identity(socket: String) -> io::Result<IdentityRecord> {
    let current = current_process_details()?;
    Ok(IdentityRecord {
        format_version: FORMAT_VERSION,
        pid: std::process::id(),
        creation_time: current.creation_time,
        executable: current.executable,
        executable_file_identity: current.executable_file_identity,
        socket,
    })
}

pub(crate) fn write_live_record(state_dir: &Path, record: &IdentityRecord) -> io::Result<()> {
    write_json_atomically(&live_record_path(state_dir, &record.socket), record)
}

/// Ensure another account cannot replace an identity record between a daemon
/// publishing it and its owner later using it to stop a process. A sticky
/// directory (such as `/tmp`) permits writing a record because only a file's
/// owner may unlink it, unlike a plain writable directory. This is a guard,
/// not a boundary: before the daemon publishes, an attacker can still create
/// the predictable record filename, leaving a reader to encounter a record
/// the daemon never wrote. An owner check on the open handle would close that,
/// and only matters once local users are a trust boundary (#121).
#[cfg(unix)]
pub(crate) fn ensure_private_state_dir(state_dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(state_dir)?.permissions().mode();
    if mode & 0o022 != 0 && mode & 0o1000 == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "refusing to publish daemon identity in group- or world-writable directory {} (mode {:o})",
                state_dir.display(),
                mode & 0o7777
            ),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn ensure_private_state_dir(_state_dir: &Path) -> io::Result<()> {
    Ok(())
}

pub(crate) fn write_exit_record(state_dir: &Path, record: &ExitRecord) -> io::Result<()> {
    write_json_atomically(
        &exit_record_path(state_dir, &record.identity.socket),
        record,
    )
}

pub(crate) fn remove_live_record(state_dir: &Path, expected: &IdentityRecord) -> io::Result<()> {
    let path = live_record_path(state_dir, &expected.socket);
    match read_live_record_at(&path)? {
        Some(record) if same_identity(&record, expected) => {}
        Some(_) => return Ok(()),
        None => return Ok(()),
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "identity record path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}-{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        ulid::Ulid::generate()
    ));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let publish_result = (|| {
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    drop(file);
    match publish_result {
        Ok(()) => match sync_parent(parent) {
            Ok(()) => Ok(()),
            // The rename has completed, so the record is already visible.
            // Directory sync only determines whether that namespace change is
            // durable across a crash; do not claim it was never published.
            Err(error) => Err(io::Error::new(
                error.kind(),
                format!(
                    "identity record was published at {} but its parent directory could not be synced: {error}",
                    path.display()
                ),
            )),
        },
        Err(write_error) => match fs::remove_file(&temporary) {
            Ok(()) => Err(write_error),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Err(write_error),
            Err(cleanup_error) => Err(io::Error::new(
                write_error.kind(),
                format!(
                    "failed to write identity record: {write_error}; failed to remove temporary {}: {cleanup_error}",
                    temporary.display()
                ),
            )),
        },
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

fn same_identity(left: &IdentityRecord, right: &IdentityRecord) -> bool {
    left.format_version == right.format_version
        && left.pid == right.pid
        && left.creation_time == right.creation_time
        && left.executable == right.executable
        && left.executable_file_identity == right.executable_file_identity
        && left.socket == right.socket
}

fn read_live_record_at(path: &Path) -> io::Result<Option<IdentityRecord>> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "identity record path has no parent",
        )
    })?;
    // The reader sends the signal, so it must enforce the same ownership
    // boundary as the publisher. A planted record in a writable directory is
    // never safe to read as a signal target.
    if !parent.exists() {
        return Ok(None);
    }
    ensure_private_state_dir(parent)?;
    match open_record_no_follow(path) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            Read::by_ref(&mut file)
                .take(MAX_RECORD_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_RECORD_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "identity record exceeds maximum size",
                ));
            }
            serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn open_record_no_follow(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    options.open(path)
}

#[cfg(windows)]
fn open_record_no_follow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_record_no_follow(path: &Path) -> io::Result<File> {
    File::open(path)
}

#[derive(Debug)]
struct ProcessDetails {
    creation_time: String,
    executable: PathBuf,
    executable_file_identity: Option<FileIdentity>,
}

fn details_match(record: &IdentityRecord, live: &ProcessDetails) -> bool {
    record.creation_time == live.creation_time
        && match (
            record.executable_file_identity.as_ref(),
            live.executable_file_identity.as_ref(),
        ) {
            // On Linux this identifies the already-running executable inode,
            // which remains stable when its pathname is atomically replaced.
            (Some(record), Some(live)) => record == live,
            _ => paths_match(&live.executable, &record.executable),
        }
}

fn paths_match(left: &Path, right: &Path) -> bool {
    let left = fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

enum Validation {
    Gone,
    Mismatch,
    Matching(ProcessReference),
}

enum ProcessStatus {
    Gone,
    Mismatch,
    Matching,
}

pub(crate) fn stop(
    state_dir: &Path,
    socket: &str,
    wait_bound: Duration,
) -> io::Result<StopOutcome> {
    let path = live_record_path(state_dir, socket);
    let record = match read_live_record_at(&path) {
        Ok(Some(record)) => record,
        Ok(None) => return Ok(without_live_record(socket)),
        // A malformed record is stale state, not an undocumented CLI error.
        // Nothing says what it named, so it is not removed.
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            return Ok(StopOutcome::RecordDoesNotMatchLiveProcess);
        }
        Err(error) => return Err(error),
    };
    if record.socket != socket {
        return Ok(StopOutcome::RecordDoesNotMatchLiveProcess);
    }
    let outcome = stop_record(&record, wait_bound)?;
    if outcome.succeeded() {
        // The process the record names is gone, as the kernel says through a
        // reference to it: never merely a different process at its pid, which
        // is a mismatch and keeps the record. A daemon removes its own record
        // when it exits cleanly; a crash, a kill, or a Windows stop leaves it,
        // and a later pid reuse would turn it into a mismatch that fails every
        // stop after it (#871). Only a record still naming this identity goes:
        // one a new daemon published meanwhile stays.
        if let Err(error) = remove_live_record(state_dir, &record) {
            tracing::warn!(%error, "the record of a daemon that is gone could not be removed");
        }
    }
    Ok(match outcome {
        // The recorded daemon was gone before anything was sent. Whether
        // another one has bound the endpoint since is the endpoint's to say.
        StopOutcome::NotRunning => without_live_record(socket),
        outcome => outcome,
    })
}

/// Stop the process `record` names. `NotRunning` means it was gone before
/// anything was sent to it.
fn stop_record(record: &IdentityRecord, wait_bound: Duration) -> io::Result<StopOutcome> {
    let process = match validate_process(record)? {
        Validation::Matching(process) => process,
        Validation::Gone => return Ok(StopOutcome::NotRunning),
        Validation::Mismatch => return Ok(StopOutcome::RecordDoesNotMatchLiveProcess),
    };
    if let Err(error) = process.send_stop(record) {
        return match process.status(record)? {
            ProcessStatus::Gone => Ok(StopOutcome::Stopped),
            ProcessStatus::Mismatch => Ok(StopOutcome::RecordDoesNotMatchLiveProcess),
            ProcessStatus::Matching => Err(error),
        };
    }

    let deadline = Instant::now() + wait_bound;
    loop {
        match process.status(record)? {
            ProcessStatus::Gone => return Ok(StopOutcome::Stopped),
            ProcessStatus::Mismatch => return Ok(StopOutcome::RecordDoesNotMatchLiveProcess),
            ProcessStatus::Matching if Instant::now() >= deadline => {
                return Ok(StopOutcome::StillRunningAtBound);
            }
            ProcessStatus::Matching => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

/// What a stop answers when no record names a live daemon: `not running` when
/// nothing listens on the endpoint either, `no record` when something does.
/// Nothing is signalled either way.
fn without_live_record(socket: &str) -> StopOutcome {
    if endpoint_is_free(socket) {
        StopOutcome::NotRunning
    } else {
        StopOutcome::NoRecord
    }
}

/// Whether nothing listens on the endpoint. Only a plain "nobody there" counts:
/// any other answer is taken for a listener, so a doubt never becomes
/// `not running`.
#[cfg(unix)]
fn endpoint_is_free(socket: &str) -> bool {
    // Connecting is what tells a listening daemon from a socket file a dead one
    // left behind, as the daemon's own bind does. A daemon that listens sees a
    // connection that closes before its AUTH.
    match std::os::unix::net::UnixStream::connect(socket) {
        Ok(_) => false,
        Err(error) => matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
        ),
    }
}

#[cfg(windows)]
fn endpoint_is_free(socket: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    if socket.contains('\0') {
        return false;
    }
    let name: Vec<u16> = std::ffi::OsStr::new(socket)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // Waits for an instance of the pipe without connecting to it. With no
    // instance of that name at all, it fails at once with
    // ERROR_FILE_NOT_FOUND, whatever the timeout.
    if unsafe { WaitNamedPipeW(name.as_ptr(), 1) } != 0 {
        return false;
    }
    io::Error::last_os_error().raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32)
}

#[cfg(not(any(unix, windows)))]
fn endpoint_is_free(_socket: &str) -> bool {
    false
}

fn validate_process(record: &IdentityRecord) -> io::Result<Validation> {
    if record.format_version != FORMAT_VERSION {
        return Ok(Validation::Mismatch);
    }
    match ProcessReference::open(record.pid)? {
        Some(process) => process.validate(record),
        None => Ok(Validation::Gone),
    }
}

#[cfg(target_os = "linux")]
struct LinuxProcessReference {
    pidfd: std::os::fd::OwnedFd,
    proc_dir: File,
}

#[cfg(target_os = "linux")]
enum ProcessReference {
    Linux(LinuxProcessReference),
}

#[cfg(target_os = "macos")]
enum ProcessReference {
    // Darwin has no pidfd-equivalent. The validation and kill syscalls retain a
    // residual pid-reuse window which cannot be closed with its public APIs.
    Macos { pid: u32 },
}

#[cfg(windows)]
struct WindowsProcessReference(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WindowsProcessReference {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(windows)]
enum ProcessReference {
    Windows(WindowsProcessReference),
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
enum ProcessReference {}

impl ProcessReference {
    fn open(pid: u32) -> io::Result<Option<Self>> {
        #[cfg(target_os = "linux")]
        {
            let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
            if pidfd < 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            // SAFETY: pidfd is newly returned by the kernel and uniquely owned.
            let pidfd = unsafe { std::os::fd::OwnedFd::from_raw_fd(pidfd as _) };
            let proc_dir = match open_linux_proc_dir(pid) {
                Ok(dir) => dir,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            Ok(Some(Self::Linux(LinuxProcessReference { pidfd, proc_dir })))
        }
        #[cfg(target_os = "macos")]
        {
            return Ok(process_details(pid)?.map(|_| Self::Macos { pid }));
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                PROCESS_TERMINATE,
            };
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                let error = io::Error::last_os_error();
                return if matches!(error.raw_os_error(), Some(87) | Some(1168)) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            Ok(Some(Self::Windows(WindowsProcessReference(handle))))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        {
            let _ = pid;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "safe process references are unavailable",
            ))
        }
    }

    fn validate(self, record: &IdentityRecord) -> io::Result<Validation> {
        match self.status(record)? {
            ProcessStatus::Matching => Ok(Validation::Matching(self)),
            ProcessStatus::Gone => Ok(Validation::Gone),
            ProcessStatus::Mismatch => Ok(Validation::Mismatch),
        }
    }

    fn status(&self, record: &IdentityRecord) -> io::Result<ProcessStatus> {
        #[cfg(target_os = "linux")]
        {
            let Self::Linux(process) = self;
            let mut pollfd = libc::pollfd {
                fd: process.pidfd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut pollfd, 1, 0) };
            if ready < 0 {
                return Err(io::Error::last_os_error());
            }
            if ready != 0 {
                return Ok(ProcessStatus::Gone);
            }
            let details = match linux_process_details(&process.proc_dir) {
                Ok(details) => details,
                Err(error) if process_disappeared(&error) => return Ok(ProcessStatus::Gone),
                Err(error) => return Err(error),
            };
            Ok(if details_match(record, &details) {
                ProcessStatus::Matching
            } else {
                ProcessStatus::Mismatch
            })
        }
        #[cfg(target_os = "macos")]
        {
            let Self::Macos { pid } = self;
            return Ok(match process_details(*pid)? {
                None => ProcessStatus::Gone,
                Some(details) if details_match(record, &details) => ProcessStatus::Matching,
                Some(_) => ProcessStatus::Mismatch,
            });
        }
        #[cfg(windows)]
        {
            let Self::Windows(process) = self;
            Ok(match windows_process_details(process.0)? {
                None => ProcessStatus::Gone,
                Some(details) if details_match(record, &details) => ProcessStatus::Matching,
                Some(_) => ProcessStatus::Mismatch,
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        match *self {}
    }

    fn send_stop(&self, record: &IdentityRecord) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            let _ = record;
            let Self::Linux(process) = self;
            let result = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    process.pidfd.as_raw_fd(),
                    libc::SIGTERM,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
        #[cfg(target_os = "macos")]
        {
            let Self::Macos { pid } = self;
            // No stable Darwin process handle exists; see ProcessReference.
            let result = unsafe { libc::kill(*pid as libc::pid_t, libc::SIGTERM) };
            return if result == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            };
        }
        #[cfg(windows)]
        {
            let _ = record;
            let Self::Windows(process) = self;
            if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.0, 1) } == 0
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        match *self {}
    }
}

fn current_process_details() -> io::Result<ProcessDetails> {
    process_details(std::process::id())?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "current process cannot be identified",
        )
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn process_disappeared(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT))
        || error.kind() == io::ErrorKind::NotFound
}

#[cfg(target_os = "linux")]
fn process_details(pid: u32) -> io::Result<Option<ProcessDetails>> {
    let proc_dir = match open_linux_proc_dir(pid) {
        Ok(dir) => dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    linux_process_details(&proc_dir).map(Some)
}

#[cfg(target_os = "linux")]
fn open_linux_proc_dir(pid: u32) -> io::Result<File> {
    use std::ffi::CString;
    let path = CString::new(format!("/proc/{pid}")).expect("proc path has no NUL");
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `open` returned an owned file descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn linux_process_details(proc_dir: &File) -> io::Result<ProcessDetails> {
    let stat = {
        let mut file = openat(proc_dir, c"stat", libc::O_RDONLY | libc::O_CLOEXEC)?;
        let mut stat = String::new();
        file.read_to_string(&mut stat)?;
        stat
    };
    let fields = stat
        .rsplit_once(')')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed /proc stat"))?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    let creation_time = fields
        .get(19)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing /proc start time"))?
        .to_string();
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    let executable_name = c"exe";
    let executable_file = openat(proc_dir, executable_name, libc::O_RDONLY | libc::O_CLOEXEC)?;
    let metadata = executable_file.metadata()?;
    use std::os::unix::fs::MetadataExt;
    let mut target = vec![0u8; 4096];
    let length = unsafe {
        libc::readlinkat(
            proc_dir.as_raw_fd(),
            executable_name.as_ptr(),
            target.as_mut_ptr().cast(),
            target.len(),
        )
    };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize == target.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "/proc executable path was truncated",
        ));
    }
    let executable =
        PathBuf::from(String::from_utf8_lossy(&target[..length as usize]).into_owned());
    Ok(ProcessDetails {
        creation_time: format!("{}:{creation_time}", boot_id.trim()),
        executable,
        executable_file_identity: Some(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }),
    })
}

#[cfg(target_os = "linux")]
fn openat(proc_dir: &File, name: &std::ffi::CStr, flags: libc::c_int) -> io::Result<File> {
    let fd = unsafe { libc::openat(proc_dir.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `openat` returned an owned file descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "macos")]
fn process_details(pid: u32) -> io::Result<Option<ProcessDetails>> {
    // KERN_PROC_PID is the kernel's liveness query.  Do not replace it with a
    // bare pid check: a zero-length/ESRCH response means this record cannot be
    // validated. `libc` deliberately does not expose Darwin's unstable
    // `kinfo_proc` layout, so proc_pidinfo supplies the same process start
    // timestamp from its stable public proc_bsdinfo ABI after this sysctl.
    // Darwin exposes no pidfd-like stable reference, so these reads retain the
    // same unavoidable pid-reuse window as the later signal operation.
    let mut size = 0usize;
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PID,
        pid as libc::c_int,
    ];
    let result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as u32,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT)) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    if size == 0 {
        return Ok(None);
    }
    let mut process: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let count = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut process as *mut libc::proc_bsdinfo).cast(),
            std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int,
        )
    };
    if count == 0 {
        let error = io::Error::last_os_error();
        return if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT)) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    if count as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
        return Ok(None);
    }
    let mut executable = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            executable.as_mut_ptr().cast(),
            executable.len() as u32,
        )
    };
    if length <= 0 {
        let error = io::Error::last_os_error();
        return if process_disappeared(&error) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    executable.truncate(length as usize);
    Ok(Some(ProcessDetails {
        creation_time: format!("{}.{}", process.pbi_start_tvsec, process.pbi_start_tvusec),
        executable: PathBuf::from(String::from_utf8_lossy(&executable).into_owned()),
        executable_file_identity: None,
    }))
}

#[cfg(windows)]
fn process_details(pid: u32) -> io::Result<Option<ProcessDetails>> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(87) || error.raw_os_error() == Some(1168) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let result = windows_process_details(handle);
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(windows)]
fn windows_process_details(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<Option<ProcessDetails>> {
    use windows_sys::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    };
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_TIMEOUT => {}
        WAIT_OBJECT_0 => return Ok(None),
        WAIT_FAILED => return Err(io::Error::last_os_error()),
        _ => {
            return Err(io::Error::other("unexpected process wait result"));
        }
    }
    // FILETIME is a plain pair of integer fields; zero is a valid initial
    // out-buffer value for GetProcessTimes.
    let mut creation = unsafe { std::mem::zeroed() };
    let mut exit = unsafe { std::mem::zeroed() };
    let mut kernel = unsafe { std::mem::zeroed() };
    let mut user = unsafe { std::mem::zeroed() };
    let times_ok =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    if times_ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    let path_ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut length)
    };
    if path_ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let creation_time =
        ((creation.dwHighDateTime as u64) << 32 | creation.dwLowDateTime as u64).to_string();
    Ok(Some(ProcessDetails {
        creation_time,
        executable: PathBuf::from(String::from_utf16_lossy(&path[..length as usize])),
        executable_file_identity: None,
    }))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_details(_pid: u32) -> io::Result<Option<ProcessDetails>> {
    // No bare-pid fallback: without a creation fingerprint validation must
    // refuse to act, because a recycled pid could identify another process.
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process creation time is unavailable on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("lasterm-identity-test-{}", ulid::Ulid::generate()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;

            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&path)
                .expect("create private identity fixture directory");
        }
        // Stays recursive: on Windows the temp path comes from TMP or TEMP and
        // is not checked for existence, so a configured but absent hierarchy
        // must still be created, as it was before the Unix branch was added.
        #[cfg(not(unix))]
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// An endpoint name of this platform's kind, which nothing listens on.
    fn test_socket(label: &str) -> String {
        let name = format!("identity-test-{label}-{}", ulid::Ulid::generate());
        #[cfg(windows)]
        let name = format!(r"\\.\pipe\{name}");
        socket_identity(&name)
    }

    /// An endpoint something listens on, for as long as the guard lives: a
    /// socket in `dir` on Unix, a named pipe on Windows.
    #[cfg(unix)]
    fn listening_endpoint(dir: &Path) -> (String, std::os::unix::net::UnixListener) {
        let socket = socket_identity(&dir.join("agent.socket").to_string_lossy());
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        (socket, listener)
    }

    #[cfg(windows)]
    struct PipeInstance(windows_sys::Win32::Foundation::HANDLE);

    #[cfg(windows)]
    impl Drop for PipeInstance {
        fn drop(&mut self) {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
        }
    }

    #[cfg(windows)]
    fn listening_endpoint(_dir: &Path) -> (String, PipeInstance) {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT};

        let socket = test_socket("listening");
        let name: Vec<u16> = std::ffi::OsStr::new(&socket)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(
            handle,
            INVALID_HANDLE_VALUE,
            "create a pipe instance: {}",
            io::Error::last_os_error()
        );
        (socket, PipeInstance(handle))
    }

    /// A process that has exited. On Windows the returned handle keeps its pid
    /// from being reused while the test runs; on Linux it is reaped, and pids
    /// are handed out in sequence.
    fn exited_process() -> std::process::Child {
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/C", "exit 0"]);
            command
        } else {
            let mut command = std::process::Command::new("/bin/sh");
            command.args(["-c", "exit 0"]);
            command
        };
        let mut child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        child.wait().unwrap();
        child
    }

    /// A process that runs for a minute unless it is stopped, and the record
    /// that names it.
    fn running_process(socket: String) -> (std::process::Child, IdentityRecord) {
        let mut command = if cfg!(windows) {
            let mut command = std::process::Command::new("ping.exe");
            command.args(["-n", "60", "127.0.0.1"]);
            command
        } else {
            let mut command = std::process::Command::new("sleep");
            command.arg("60");
            command
        };
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let details = process_details(child.id())
            .unwrap()
            .expect("the child runs");
        let record = IdentityRecord {
            format_version: FORMAT_VERSION,
            pid: child.id(),
            creation_time: details.creation_time,
            executable: details.executable,
            executable_file_identity: details.executable_file_identity,
            socket,
        };
        (child, record)
    }

    #[test]
    fn identity_round_trips_with_owner_only_live_file() {
        let state_dir = temp_dir();
        let identity = create_identity(test_socket("round-trip")).unwrap();
        write_live_record(&state_dir, &identity).unwrap();
        assert_eq!(
            read_live_record_at(&live_record_path(&state_dir, &identity.socket))
                .unwrap()
                .unwrap()
                .pid,
            identity.pid
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(live_record_path(&state_dir, &identity.socket))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: bypassing the atomic owner-only writer permits a
        // torn or world-readable identity record.
    }

    #[cfg(unix)]
    #[test]
    fn sticky_state_dir_is_accepted_but_plain_writable_dir_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let state_dir = temp_dir();
        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o1777)).unwrap();
        assert!(ensure_private_state_dir(&state_dir).is_ok());

        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            ensure_private_state_dir(&state_dir).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir_all(state_dir).unwrap();
    }

    #[test]
    fn missing_record_with_nothing_listening_reports_not_running() {
        let state_dir = temp_dir();
        let socket = test_socket("missing");
        assert_eq!(
            stop(&state_dir, &socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::NotRunning
        );
        assert!(StopOutcome::NotRunning.succeeded());
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: answering `no record` for an endpoint nobody serves
        // fails every quit that follows a clean one, or a removed stale record
        // (#871).
    }

    #[test]
    fn an_endpoint_someone_listens_on_without_a_live_record_is_refused() {
        let state_dir = temp_dir();
        let (socket, listener) = listening_endpoint(&state_dir);
        assert_eq!(
            stop(&state_dir, &socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::NoRecord
        );

        // A record of a process that is gone does not vouch for the listener
        // either. It is still stale, so it goes.
        let exited = exited_process();
        let mut stale = create_identity(socket.clone()).unwrap();
        stale.pid = exited.id();
        write_live_record(&state_dir, &stale).unwrap();
        assert_eq!(
            stop(&state_dir, &socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::NoRecord
        );
        assert!(!live_record_path(&state_dir, &socket).exists());
        assert!(!StopOutcome::NoRecord.succeeded());

        drop(listener);
        drop(exited);
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: reading a missing or stale record as "not running"
        // without asking the endpoint reports success while a daemon that has
        // bound and not yet published its record keeps running.
    }

    #[test]
    fn a_record_whose_process_is_gone_reports_not_running_and_is_removed() {
        let state_dir = temp_dir();
        let socket = test_socket("gone");
        let exited = exited_process();
        let mut stale = create_identity(socket.clone()).unwrap();
        stale.pid = exited.id();
        write_live_record(&state_dir, &stale).unwrap();

        assert_eq!(
            stop(&state_dir, &socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::NotRunning
        );
        assert!(!live_record_path(&state_dir, &socket).exists());
        // And the stop after it finds nothing to refuse.
        assert_eq!(
            stop(&state_dir, &socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::NotRunning
        );

        drop(exited);
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: mapping a recorded process that no longer exists to
        // `record does not match a live process` fails every quit after a crash
        // or a forced stop of the daemon, until one starts again (#871).
    }

    #[test]
    fn a_stopped_process_leaves_no_record() {
        let state_dir = temp_dir();
        let socket = test_socket("stopped");
        let (mut child, record) = running_process(socket.clone());
        write_live_record(&state_dir, &record).unwrap();

        assert_eq!(
            stop(&state_dir, &socket, Duration::from_secs(10)).unwrap(),
            StopOutcome::Stopped
        );
        assert!(!live_record_path(&state_dir, &socket).exists());

        child.wait().unwrap();
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: keeping the record of a process the stop confirmed
        // gone. On Windows the stop terminates the daemon, which cannot remove
        // it, and a reuse of its pid later makes the record a mismatch.
    }

    #[test]
    fn a_record_naming_a_reused_pid_is_refused_and_kept() {
        let state_dir = temp_dir();
        let mut identity = create_identity(test_socket("reused-pid")).unwrap();
        // This process, live, but not the one the record says started then.
        identity.creation_time.push_str("-earlier");
        write_live_record(&state_dir, &identity).unwrap();

        assert_eq!(
            stop(&state_dir, &identity.socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::RecordDoesNotMatchLiveProcess
        );
        assert!(live_record_path(&state_dir, &identity.socket).exists());

        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: treating a mismatch like a process that is gone,
        // which reports success and removes the record on a fingerprint that
        // disagrees, rather than on the kernel's word that the process ended.
    }

    #[test]
    fn socket_scoped_record_never_crosses_to_a_sibling_socket() {
        let state_dir = temp_dir();
        let first = create_identity(test_socket("first")).unwrap();
        let second = create_identity(test_socket("second")).unwrap();
        write_live_record(&state_dir, &first).unwrap();
        write_live_record(&state_dir, &second).unwrap();
        assert_ne!(
            live_record_path(&state_dir, &first.socket),
            live_record_path(&state_dir, &second.socket)
        );
        assert_eq!(
            stop(&state_dir, &test_socket("third"), Duration::from_millis(1)).unwrap(),
            StopOutcome::NotRunning
        );
        // Both records name this very process, which is still running.
        assert!(live_record_path(&state_dir, &first.socket).exists());
        assert!(live_record_path(&state_dir, &second.socket).exists());
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: a fixed agent.identity.json lets a stop for one
        // sibling socket act on whichever daemon wrote last.
    }

    #[test]
    fn stopper_refuses_a_record_that_names_another_socket() {
        let state_dir = temp_dir();
        let requested_socket = test_socket("requested");
        let record = create_identity(test_socket("other")).unwrap();
        write_json_atomically(&live_record_path(&state_dir, &requested_socket), &record).unwrap();
        assert_eq!(
            stop(&state_dir, &requested_socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::RecordDoesNotMatchLiveProcess
        );
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: looking up a socket-qualified filename without
        // checking the record's endpoint can still signal a hash collision or
        // incorrectly placed record.
    }

    #[test]
    fn validation_refuses_executable_mutation() {
        let state_dir = temp_dir();
        let mut identity = create_identity(test_socket("executable-mismatch")).unwrap();
        identity.executable = PathBuf::from("definitely-not-the-agent-executable");
        identity.executable_file_identity = None;
        write_live_record(&state_dir, &identity).unwrap();
        assert_eq!(
            stop(&state_dir, &identity.socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::RecordDoesNotMatchLiveProcess
        );
        assert!(live_record_path(&state_dir, &identity.socket).exists());
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: omitting executable validation accepts another
        // executable with the same pid and creation fingerprint record.
    }

    #[test]
    fn malformed_record_is_a_documented_stale_outcome() {
        let state_dir = temp_dir();
        let socket = test_socket("malformed");
        fs::write(live_record_path(&state_dir, &socket), b"not JSON").unwrap();
        assert_eq!(
            stop(&state_dir, &socket, Duration::from_millis(1)).unwrap(),
            StopOutcome::RecordDoesNotMatchLiveProcess
        );
        assert!(live_record_path(&state_dir, &socket).exists());
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: leaking InvalidData from --stop creates an
        // undocumented outcome.
    }

    #[test]
    fn removal_keeps_a_replaced_daemon_record() {
        let state_dir = temp_dir();
        let identity = create_identity(test_socket("remove")).unwrap();
        write_live_record(&state_dir, &identity).unwrap();
        let mut replacement = identity.clone();
        replacement.creation_time.push_str("-replacement");
        write_live_record(&state_dir, &replacement).unwrap();
        remove_live_record(&state_dir, &identity).unwrap();
        assert_eq!(
            read_live_record_at(&live_record_path(&state_dir, &identity.socket))
                .unwrap()
                .unwrap()
                .creation_time,
            replacement.creation_time
        );
        fs::remove_dir_all(state_dir).unwrap();
        // Mutation caught: unconditional cleanup can unlink the record of a
        // daemon that replaced the exiting daemon on the same endpoint.
    }
}
