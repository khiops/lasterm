//! The files of the agent's host, read for the hub's files panel (#1201):
//! FILES_LIST lists a folder, FILES_STAT says what a path is, each entry with
//! its POSIX mode or its Windows attributes, its owner and its group.
//!
//! Agent-wide, as ENV_QUERY: any hub authenticated on this agent may read
//! what the account reads, as it can over SFTP. The work runs off the dispatch
//! loop, at most `REQUESTS_AT_ONCE` requests at a time, and a request's frames
//! hold its permits until the connection's writer has written them, which
//! bounds what the requests leave queued.
//!
//! A path, a name, an owner or a group is the user's: nothing here logs one,
//! at any level.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::framing::encode_frame;
use crate::handler::{FrameSender, Outgoing};
use crate::protocol::AgentToHub;

/// The most entries in one FILES_ENTRIES.
pub(crate) const BATCH_ENTRIES: usize = 1_000;
/// A FILES_ENTRIES ends once its entries' text (names, link targets, owners,
/// groups) reaches this many bytes.
pub(crate) const BATCH_TEXT: usize = 1 << 20;
/// File requests that may run, their frames still queued included, agent-wide.
const REQUESTS_AT_ONCE: usize = 4;
/// Frames of one request that may wait for the connection's writer.
const FRAMES_IN_FLIGHT: usize = 2;
/// How long a name, or the absence of one, is reused.
pub(crate) const NAME_TTL: Duration = Duration::from_secs(5 * 60);
/// The most names kept agent-wide; the cache is emptied when full.
pub(crate) const NAME_CACHE_KEYS: usize = 4_096;
/// Threads reading the security descriptors of a batch's entries.
#[cfg(windows)]
const DESCRIPTOR_THREADS: usize = 8;

static REQUESTS: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(REQUESTS_AT_ONCE)));

static SHARED_NAMES: LazyLock<Mutex<SharedNames>> =
    LazyLock::new(|| Mutex::new(SharedNames::default()));

/// One entry as FILES_ENTRIES carries it. Every key but the link's two is
/// always on the wire, `null` when unknown.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct FileEntry {
    pub(crate) name: String,
    pub(crate) kind: &'static str,
    pub(crate) size: Option<u64>,
    pub(crate) mtime_ms: Option<i64>,
    pub(crate) mode: Option<u32>,
    pub(crate) attributes: Option<u32>,
    pub(crate) owner: Option<String>,
    pub(crate) group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) link_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) link_kind: Option<&'static str>,
}

impl FileEntry {
    /// The bytes of its text, which bound a frame.
    fn text(&self) -> usize {
        self.name.len()
            + self.link_target.as_ref().map_or(0, String::len)
            + self.owner.as_ref().map_or(0, String::len)
            + self.group.as_ref().map_or(0, String::len)
    }
}

/// A request from the hub.
pub(crate) enum Request {
    List {
        request_id: String,
        path: String,
        hidden: bool,
    },
    Stat {
        request_id: String,
        path: String,
    },
}

/// Answer `request` off the dispatch loop, once one of the agent's request
/// permits is free.
pub(crate) fn start(request: Request, frame_tx: FrameSender) {
    let dispatch = tracing::dispatcher::get_default(|current| current.clone());
    let requests = Arc::clone(&REQUESTS);
    tokio::spawn(async move {
        let Ok(permit) = requests.acquire_owned().await else {
            return;
        };
        let handle = tokio::runtime::Handle::current();
        let _ = tokio::task::spawn_blocking(move || {
            tracing::dispatcher::with_default(&dispatch, || {
                let mut out = Sender::new(frame_tx, Some(permit), handle);
                answer(request, &mut out, &dispatch);
            });
        })
        .await;
    });
}

/// What sends one request's frames: each waits for one of the request's
/// frame permits, and the last also holds the request's own permit. It waits
/// on a blocking thread: never on the runtime's own.
pub(crate) struct Sender {
    tx: FrameSender,
    request: Option<OwnedSemaphorePermit>,
    frames: Arc<Semaphore>,
    handle: tokio::runtime::Handle,
    /// Frames and entries queued so far: counts only, for the log.
    sent: (usize, usize),
}

impl Sender {
    pub(crate) fn new(
        tx: FrameSender,
        request: Option<OwnedSemaphorePermit>,
        handle: tokio::runtime::Handle,
    ) -> Self {
        Self {
            tx,
            request,
            frames: Arc::new(Semaphore::new(FRAMES_IN_FLIGHT)),
            handle,
            sent: (0, 0),
        }
    }

    /// Queue `message`; false once the connection is gone.
    fn send(&mut self, message: &AgentToHub, last: bool) -> bool {
        let frame = match encode_frame(message) {
            Ok(frame) => frame,
            Err(error) => {
                tracing::warn!(error = %error, "a file answer could not be encoded");
                return false;
            }
        };
        let Ok(slot) = self
            .handle
            .block_on(Arc::clone(&self.frames).acquire_owned())
        else {
            return false;
        };
        let mut permits = vec![slot];
        if last {
            permits.extend(self.request.take());
        }
        self.sent.0 += 1;
        if let AgentToHub::FilesEntries { entries, .. } = message {
            self.sent.1 += entries.len();
        }
        self.tx.send(Outgoing::holding(frame, permits)).is_ok()
    }
}

fn answer(request: Request, out: &mut Sender, dispatch: &tracing::Dispatch) {
    let mut names = ListingNames::default();
    match request {
        Request::Stat { request_id, path } => match stat(&path) {
            Ok(raw) => {
                let entries = resolve(vec![raw], &mut names, dispatch);
                out.send(
                    &AgentToHub::FilesEntries {
                        request_id,
                        entries,
                        done: true,
                    },
                    true,
                );
            }
            Err(error) => {
                out.send(&failure(request_id, &error), true);
            }
        },
        Request::List {
            request_id,
            path,
            hidden,
        } => match read_folder(&path, hidden, dispatch) {
            Ok(items) => send_listing(&request_id, items, out, &mut names, dispatch),
            Err(error) => {
                out.send(&failure(request_id, &error), true);
            }
        },
    }
    // Counts only: a path, a name, an owner or a group is the user's.
    tracing::debug!(
        frames = out.sent.0,
        entries = out.sent.1,
        "file request answered"
    );
}

/// The FILES_ERR for `error`, by its kind. Its text names no path.
fn failure(request_id: String, error: &io::Error) -> AgentToHub {
    AgentToHub::FilesErr {
        request_id,
        code: code_of(error).to_string(),
        message: error.to_string(),
    }
}

pub(crate) fn code_of(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "NOT_FOUND",
        io::ErrorKind::NotADirectory => "NOT_A_DIRECTORY",
        io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        _ => "FILE_ACCESS_FAILED",
    }
}

/// An entry read from the file system, its owner and group not named yet.
pub(crate) struct Raw {
    entry: FileEntry,
    ids: Ids,
}

/// What names an entry's owner and group.
enum Ids {
    /// Nothing to name: the drives' root on Windows.
    #[cfg_attr(not(windows), allow(dead_code))]
    None,
    #[cfg(unix)]
    Unix { uid: u32, gid: u32 },
    #[cfg(windows)]
    Descriptor(std::path::PathBuf),
}

impl Raw {
    fn text(&self) -> usize {
        self.entry.text()
    }

    #[cfg(test)]
    pub(crate) fn named(name: &str) -> Self {
        Raw {
            entry: FileEntry {
                name: name.to_string(),
                kind: "file",
                size: Some(0),
                mtime_ms: None,
                mode: None,
                attributes: None,
                owner: None,
                group: None,
                link_target: None,
                link_kind: None,
            },
            ids: Ids::None,
        }
    }
}

/// An item of a folder's read: an entry, one left out (`None`), or the read
/// itself failing.
type Item = io::Result<Option<Raw>>;

/// Send a folder's entries a batch at a time; the last frame says `done`. An
/// error of the read itself ends the listing with FILES_ERR in place of
/// `done`.
pub(crate) fn send_listing(
    request_id: &str,
    items: impl Iterator<Item = Item>,
    out: &mut Sender,
    names: &mut ListingNames,
    dispatch: &tracing::Dispatch,
) {
    let mut batch: Vec<Raw> = Vec::new();
    let mut text = 0usize;
    for item in items {
        let raw = match item {
            Ok(Some(raw)) => raw,
            Ok(None) => continue,
            Err(error) => {
                out.send(
                    &AgentToHub::FilesErr {
                        request_id: request_id.to_string(),
                        code: "FILE_ACCESS_FAILED".into(),
                        message: error.to_string(),
                    },
                    true,
                );
                return;
            }
        };
        if batch.len() >= BATCH_ENTRIES || text >= BATCH_TEXT {
            if !flush(
                request_id,
                std::mem::take(&mut batch),
                false,
                out,
                names,
                dispatch,
            ) {
                return;
            }
            text = 0;
        }
        text += raw.text();
        batch.push(raw);
    }
    flush(request_id, batch, true, out, names, dispatch);
}

/// Name a batch's owners and groups and send it, cut again where its full
/// text reaches `BATCH_TEXT`. False once the connection is gone.
fn flush(
    request_id: &str,
    batch: Vec<Raw>,
    done: bool,
    out: &mut Sender,
    names: &mut ListingNames,
    dispatch: &tracing::Dispatch,
) -> bool {
    let frames = split_by_text(resolve(batch, names, dispatch));
    let count = frames.len();
    for (index, entries) in frames.into_iter().enumerate() {
        let last = done && index + 1 == count;
        let sent = out.send(
            &AgentToHub::FilesEntries {
                request_id: request_id.to_string(),
                entries,
                done: last,
            },
            last,
        );
        if !sent {
            return false;
        }
    }
    true
}

/// Entries in frames, each ended once its text reaches `BATCH_TEXT`; one
/// frame, maybe empty, at least.
fn split_by_text(entries: Vec<FileEntry>) -> Vec<Vec<FileEntry>> {
    let mut frames = vec![Vec::new()];
    let mut text = 0usize;
    for entry in entries {
        if text >= BATCH_TEXT {
            frames.push(Vec::new());
            text = 0;
        }
        text += entry.text();
        frames.last_mut().expect("one frame at least").push(entry);
    }
    frames
}

/// The entries of `path`, read lazily, hidden names left out unless
/// `hidden`. Fails only when the folder cannot be opened.
fn read_folder(
    path: &str,
    hidden: bool,
    dispatch: &tracing::Dispatch,
) -> io::Result<Box<dyn Iterator<Item = Item>>> {
    #[cfg(windows)]
    if path == "/" {
        return Ok(Box::new(
            drives(dispatch).into_iter().map(|raw| Ok(Some(raw))),
        ));
    }
    #[cfg(not(windows))]
    let _ = dispatch;
    let read = std::fs::read_dir(path)?;
    Ok(Box::new(read.map(move |item| {
        let dirent = item?;
        let name = dirent.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') {
            return Ok(None);
        }
        // Windows gives the metadata with the folder's read; Unix asks
        // `lstat`. An entry whose own metadata cannot be read is left out.
        #[cfg(windows)]
        let metadata = dirent.metadata();
        #[cfg(not(windows))]
        let metadata = std::fs::symlink_metadata(dirent.path());
        Ok(metadata
            .ok()
            .map(|metadata| raw_entry(&dirent.path(), name, &metadata)))
    })))
}

/// What `path` is, a link not followed.
fn stat(path: &str) -> io::Result<Raw> {
    #[cfg(windows)]
    if path == "/" {
        return Ok(Raw {
            entry: FileEntry {
                name: "/".into(),
                kind: "directory",
                size: None,
                mtime_ms: None,
                mode: None,
                attributes: None,
                owner: None,
                group: None,
                link_target: None,
                link_kind: None,
            },
            ids: Ids::None,
        });
    }
    let path = Path::new(path);
    let metadata = std::fs::symlink_metadata(path)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    Ok(raw_entry(path, name, &metadata))
}

fn raw_entry(path: &Path, name: String, metadata: &std::fs::Metadata) -> Raw {
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_file() {
        "file"
    } else {
        "other"
    };
    let (link_target, link_kind) = if kind == "symlink" {
        let target = std::fs::read_link(path)
            .ok()
            .map(|target| target.to_string_lossy().into_owned());
        let followed = match std::fs::metadata(path) {
            Ok(followed) if followed.is_dir() => "directory",
            Ok(followed) if followed.is_file() => "file",
            Ok(_) => "other",
            Err(_) => "missing",
        };
        (target, Some(followed))
    } else {
        (None, None)
    };
    #[cfg(unix)]
    let (mode, attributes, ids) = {
        use std::os::unix::fs::MetadataExt;
        (
            Some(metadata.mode()),
            None,
            Ids::Unix {
                uid: metadata.uid(),
                gid: metadata.gid(),
            },
        )
    };
    #[cfg(windows)]
    let (mode, attributes, ids) = {
        use std::os::windows::fs::MetadataExt;
        (
            None,
            Some(metadata.file_attributes()),
            Ids::Descriptor(path.to_path_buf()),
        )
    };
    Raw {
        entry: FileEntry {
            name,
            kind,
            size: (kind != "directory").then_some(metadata.len()),
            mtime_ms: metadata.modified().ok().map(millis_since_epoch),
            mode,
            attributes,
            owner: None,
            group: None,
            link_target,
            link_kind,
        },
        ids,
    }
}

fn millis_since_epoch(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

/// The drives of this Windows machine, each letter whose root answers, probed
/// at once: the listing costs the slowest drive.
#[cfg(windows)]
fn drives(dispatch: &tracing::Dispatch) -> Vec<Raw> {
    // SAFETY: GetLogicalDrives takes nothing and returns a bit mask.
    let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    let letters: Vec<char> = (0..26u8)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| char::from(b'A' + bit))
        .collect();
    std::thread::scope(|scope| {
        let probes: Vec<_> = letters
            .iter()
            .map(|letter| {
                scope.spawn(move || {
                    tracing::dispatcher::with_default(dispatch, || {
                        tracing::trace!("drive root probed");
                        let root = format!("{letter}:\\");
                        std::fs::symlink_metadata(&root).ok().map(|metadata| {
                            raw_entry(Path::new(&root), format!("{letter}:"), &metadata)
                        })
                    })
                })
            })
            .collect();
        probes
            .into_iter()
            .filter_map(|probe| probe.join().ok().flatten())
            .map(|mut raw| {
                // A root is a folder, whatever its metadata says.
                raw.entry.kind = "directory";
                raw.entry.size = None;
                raw
            })
            .collect()
    })
}

/// Name every entry's owner and group.
#[cfg(unix)]
fn resolve(
    batch: Vec<Raw>,
    names: &mut ListingNames,
    _dispatch: &tracing::Dispatch,
) -> Vec<FileEntry> {
    // Each name is judged at the time it is asked: a batch may take a while.
    batch
        .into_iter()
        .map(|Raw { mut entry, ids }| {
            if let Ids::Unix { uid, gid } = ids {
                let user = NameKey::User(uid);
                entry.owner = Some(names.name(user, Instant::now(), &SHARED_NAMES, &lookup));
                let group = NameKey::Group(gid);
                entry.group = Some(names.name(group, Instant::now(), &SHARED_NAMES, &lookup));
            }
            entry
        })
        .collect()
}

/// Name every entry's owner and group, read from its own descriptor.
#[cfg(windows)]
fn resolve(
    batch: Vec<Raw>,
    names: &mut ListingNames,
    dispatch: &tracing::Dispatch,
) -> Vec<FileEntry> {
    let sids = descriptor_sids(&batch, dispatch);
    // Each name is judged at the time it is asked: a batch may take a while.
    let mut name = |sid| names.name(NameKey::Sid(sid), Instant::now(), &SHARED_NAMES, &lookup);
    batch
        .into_iter()
        .zip(sids)
        .map(|(Raw { mut entry, .. }, sids)| {
            if let Some((owner, group)) = sids {
                entry.owner = owner.map(&mut name);
                entry.group = group.map(&mut name);
            }
            entry
        })
        .collect()
}

/// The owner and group SIDs of each entry's own descriptor, `None` where it
/// cannot be read, on up to `DESCRIPTOR_THREADS` threads.
#[cfg(windows)]
fn descriptor_sids(
    batch: &[Raw],
    dispatch: &tracing::Dispatch,
) -> Vec<Option<(Option<String>, Option<String>)>> {
    let paths: Vec<Option<&Path>> = batch
        .iter()
        .map(|raw| match &raw.ids {
            Ids::Descriptor(path) => Some(path.as_path()),
            Ids::None => None,
        })
        .collect();
    if paths.is_empty() {
        return Vec::new();
    }
    let chunk = paths.len().div_ceil(DESCRIPTOR_THREADS);
    std::thread::scope(|scope| {
        let readers: Vec<_> = paths
            .chunks(chunk)
            .map(|part| {
                let reader = scope.spawn(move || {
                    tracing::dispatcher::with_default(dispatch, || {
                        tracing::trace!(entries = part.len(), "descriptors read");
                        part.iter()
                            .map(|path| path.and_then(windows::owner_and_group))
                            .collect::<Vec<_>>()
                    })
                });
                (part.len(), reader)
            })
            .collect();
        readers
            .into_iter()
            .flat_map(|(count, reader)| reader.join().unwrap_or_else(|_| vec![None; count]))
            .collect()
    })
}

/// What a name is looked up by. A uid and a gid of the same number are two
/// keys: they live in two spaces.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum NameKey {
    #[cfg_attr(windows, allow(dead_code))]
    User(u32),
    #[cfg_attr(windows, allow(dead_code))]
    Group(u32),
    #[cfg_attr(unix, allow(dead_code))]
    Sid(String),
}

impl NameKey {
    /// What stands for the name when the system has none: the id itself.
    fn fallback(&self) -> String {
        match self {
            NameKey::User(id) | NameKey::Group(id) => id.to_string(),
            NameKey::Sid(sid) => sid.clone(),
        }
    }
}

/// Names known agent-wide: the system's answer, a name or none, with when it
/// was asked.
#[derive(Default)]
pub(crate) struct SharedNames {
    names: HashMap<NameKey, (Option<String>, Instant)>,
}

impl SharedNames {
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.names.len()
    }
}

/// The names one listing has used, each with when the system gave it: a
/// listing asks for a key once while its answer is under `NAME_TTL` old,
/// whatever the shared cache holds.
#[derive(Default)]
pub(crate) struct ListingNames {
    names: HashMap<NameKey, (Option<String>, Instant)>,
}

impl ListingNames {
    /// The name of `key`, or the id when the system has none.
    pub(crate) fn name(
        &mut self,
        key: NameKey,
        now: Instant,
        shared: &Mutex<SharedNames>,
        lookup: &dyn Fn(&NameKey) -> Option<String>,
    ) -> String {
        let fresh = |at: Instant| now.saturating_duration_since(at) < NAME_TTL;
        if let Some((name, at)) = self.names.get(&key) {
            if fresh(*at) {
                return name.clone().unwrap_or_else(|| key.fallback());
            }
        }
        let cached = {
            let shared = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            shared.names.get(&key).filter(|(_, at)| fresh(*at)).cloned()
        };
        let (name, at) = match cached {
            Some(known) => known,
            None => {
                let name = lookup(&key);
                let mut shared = shared
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if !shared.names.contains_key(&key) && shared.names.len() >= NAME_CACHE_KEYS {
                    shared.names.clear();
                }
                shared.names.insert(key.clone(), (name.clone(), now));
                (name, now)
            }
        };
        self.names.insert(key.clone(), (name.clone(), at));
        name.unwrap_or_else(|| key.fallback())
    }
}

/// The system's name for `key`, none when it has none.
fn lookup(key: &NameKey) -> Option<String> {
    match key {
        #[cfg(unix)]
        NameKey::User(uid) => unix::user_name(*uid),
        #[cfg(unix)]
        NameKey::Group(gid) => unix::group_name(*gid),
        #[cfg(windows)]
        NameKey::Sid(sid) => windows::account_name(sid),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

#[cfg(unix)]
mod unix {
    use std::ffi::CStr;

    /// The buffer `getpw*_r` and `getgr*_r` may grow to.
    const MAX_BUFFER: usize = 1 << 20;

    pub(super) fn user_name(uid: u32) -> Option<String> {
        let mut buffer = vec![0u8; 1024];
        loop {
            // SAFETY: zeroed passwd is a valid out-parameter for getpwuid_r.
            let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
            let mut found: *mut libc::passwd = std::ptr::null_mut();
            // SAFETY: every pointer is valid for the call; the buffer's
            // length is passed with it.
            let status = unsafe {
                libc::getpwuid_r(
                    uid,
                    &mut entry,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut found,
                )
            };
            if status == libc::ERANGE && buffer.len() < MAX_BUFFER {
                buffer.resize(buffer.len() * 2, 0);
                continue;
            }
            if status != 0 || found.is_null() || entry.pw_name.is_null() {
                return None;
            }
            // SAFETY: getpwuid_r set pw_name to a NUL-terminated string in
            // `buffer`, which lives until this function returns.
            return Some(
                unsafe { CStr::from_ptr(entry.pw_name) }
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }

    pub(super) fn group_name(gid: u32) -> Option<String> {
        let mut buffer = vec![0u8; 1024];
        loop {
            // SAFETY: zeroed group is a valid out-parameter for getgrgid_r.
            let mut entry: libc::group = unsafe { std::mem::zeroed() };
            let mut found: *mut libc::group = std::ptr::null_mut();
            // SAFETY: every pointer is valid for the call; the buffer's
            // length is passed with it.
            let status = unsafe {
                libc::getgrgid_r(
                    gid,
                    &mut entry,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut found,
                )
            };
            if status == libc::ERANGE && buffer.len() < MAX_BUFFER {
                buffer.resize(buffer.len() * 2, 0);
                continue;
            }
            if status != 0 || found.is_null() || entry.gr_name.is_null() {
                return None;
            }
            // SAFETY: as for the user, in `buffer`.
            return Some(
                unsafe { CStr::from_ptr(entry.gr_name) }
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSidToSidW, GetSecurityInfo, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        LookupAccountSidW, GROUP_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL,
    };

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }

    /// `path` as a verbatim path, NUL-terminated: `\\?\C:\…`, `\\?\UNC\server\share\…`.
    /// Win32 would otherwise refuse a path past `MAX_PATH`, and drop a last
    /// name's trailing dots and spaces (`report.` read as `report`), as std's
    /// own calls avoid by the same prefix.
    pub(super) fn verbatim(path: &Path) -> Vec<u16> {
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        let slash = u16::from(b'\\');
        let prefix: Vec<u16> = if units.starts_with(&[slash, slash, u16::from(b'?'), slash]) {
            Vec::new()
        } else if units.starts_with(&[slash, slash]) {
            let mut unc: Vec<u16> = "\\\\?\\UNC".encode_utf16().collect();
            unc.extend_from_slice(&units[1..]);
            return unc.into_iter().chain(Some(0)).collect();
        } else if units.get(1) == Some(&u16::from(b':')) {
            "\\\\?\\".encode_utf16().collect()
        } else {
            Vec::new()
        };
        prefix.into_iter().chain(units).chain(Some(0)).collect()
    }

    /// The owner and group SIDs of `path`'s own descriptor (a link's own, as
    /// `lstat`); `None` when it cannot be read.
    pub(super) fn owner_and_group(path: &Path) -> Option<(Option<String>, Option<String>)> {
        let name = verbatim(path);
        // SAFETY: `name` is NUL-terminated; the handle is closed below.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut owner: PSID = std::ptr::null_mut();
        let mut group: PSID = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: the out-pointers are valid; on success `descriptor` owns
        // the memory `owner` and `group` point into, freed below.
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION,
                &mut owner,
                &mut group,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        // SAFETY: `handle` is open and closed once.
        unsafe { CloseHandle(handle) };
        if status != 0 {
            return None;
        }
        let sids = (sid_string(owner), sid_string(group));
        // SAFETY: `descriptor` was allocated by GetSecurityInfo.
        unsafe { LocalFree(descriptor) };
        Some(sids)
    }

    /// A SID as `S-1-…`; `None` for a null one.
    fn sid_string(sid: PSID) -> Option<String> {
        if sid.is_null() {
            return None;
        }
        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` points into a live descriptor; `text` is freed below.
        if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
            return None;
        }
        let mut length = 0;
        // SAFETY: ConvertSidToStringSidW wrote a NUL-terminated string.
        while unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        // SAFETY: `length` units are valid at `text`.
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
        // SAFETY: allocated by ConvertSidToStringSidW.
        unsafe { LocalFree(text.cast()) };
        Some(sid)
    }

    /// `DOMAIN\name` for a SID, the name alone when the domain is empty;
    /// `None` when the system cannot name it.
    pub(super) fn account_name(sid: &str) -> Option<String> {
        let text = wide(std::ffi::OsStr::new(sid));
        let mut binary: PSID = std::ptr::null_mut();
        // SAFETY: `text` is NUL-terminated; `binary` is freed below.
        if unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut binary) } == 0 {
            return None;
        }
        let named = lookup(binary);
        // SAFETY: allocated by ConvertStringSidToSidW.
        unsafe { LocalFree(binary) };
        named
    }

    fn lookup(sid: PSID) -> Option<String> {
        let (mut name_len, mut domain_len) = (256u32, 256u32);
        loop {
            let mut name = vec![0u16; name_len as usize];
            let mut domain = vec![0u16; domain_len as usize];
            let mut kind = 0;
            // SAFETY: the buffers' lengths are passed with them.
            let found = unsafe {
                LookupAccountSidW(
                    std::ptr::null(),
                    sid,
                    name.as_mut_ptr(),
                    &mut name_len,
                    domain.as_mut_ptr(),
                    &mut domain_len,
                    &mut kind,
                )
            };
            if found == 0 {
                // SAFETY: reads this thread's last error.
                if unsafe { GetLastError() } == ERROR_INSUFFICIENT_BUFFER {
                    continue;
                }
                return None;
            }
            let name = String::from_utf16_lossy(&name[..name_len as usize]);
            let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
            return Some(if domain.is_empty() {
                name
            } else {
                format!("{domain}\\{name}")
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::batch::ChannelEventSender;
    use crate::flow::Flows;
    use crate::handler::{handle_message, ConnectionRef};
    use crate::owner::OwnerId;
    use crate::protocol::HubToAgent;
    use crate::pty::PtyManager;
    use serde_json::Value;
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use tokio::sync::mpsc;

    /// File requests share the agent's permits: the tests that count them
    /// run one at a time, and so do the others, which would take them.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A folder of its own, removed afterwards.
    struct Folder(PathBuf);

    impl Folder {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("lasterm-files-{label}-{}", ulid::Ulid::generate()));
            std::fs::create_dir_all(&path).unwrap();
            Folder(path)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = make_removable(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn make_removable(path: &Path) -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        for entry in std::fs::read_dir(path)?.flatten() {
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o755))?;
                make_removable(&entry.path())?;
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    fn make_removable(path: &Path) -> io::Result<()> {
        for entry in std::fs::read_dir(path)?.flatten() {
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                std::fs::remove_dir(entry.path())
                    .or_else(|_| std::fs::remove_file(entry.path()))?;
            } else if metadata.is_file() {
                set_attributes(&entry.path(), 0x80);
            } else if metadata.is_dir() {
                make_removable(&entry.path())?;
            }
        }
        Ok(())
    }

    #[cfg(windows)]
    fn set_attributes(path: &Path, attributes: u32) {
        // Verbatim: a long path, or a name with a trailing dot, as the tests make.
        let name = super::windows::verbatim(path);
        // SAFETY: `name` is NUL-terminated.
        let done = unsafe {
            windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(name.as_ptr(), attributes)
        };
        assert_ne!(done, 0, "attributes set");
    }

    fn list(path: &str, hidden: bool) -> HubToAgent {
        HubToAgent::FilesList {
            request_id: format!("list-{}", ulid::Ulid::generate()),
            path: path.to_string(),
            hidden,
        }
    }

    fn stat(path: &str) -> HubToAgent {
        HubToAgent::FilesStat {
            request_id: format!("stat-{}", ulid::Ulid::generate()),
            path: path.to_string(),
        }
    }

    async fn ask(message: HubToAgent, frame_tx: FrameSender) {
        let (channel_events, _events) = ChannelEventSender::new(Flows::default());
        handle_message(
            message,
            &OwnerId::stdio(),
            &ConnectionRef::stdio(),
            Arc::new(tokio::sync::Mutex::new(PtyManager::new())),
            frame_tx,
            channel_events,
            Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        )
        .await
        .expect("a file request is taken");
    }

    fn decode(frame: &Outgoing) -> Value {
        rmp_serde::from_slice(&frame.frame[4..]).expect("a MessagePack frame")
    }

    async fn next(frames: &mut mpsc::UnboundedReceiver<Outgoing>) -> Outgoing {
        tokio::time::timeout(Duration::from_secs(60), frames.recv())
            .await
            .expect("an answer in time")
            .expect("the channel stays open")
    }

    /// Every frame answering `message`, up to its `done` or its FILES_ERR.
    async fn answer_of(message: HubToAgent) -> Vec<Value> {
        let (frame_tx, mut frames) = mpsc::unbounded_channel();
        ask(message, frame_tx).await;
        let mut answer = Vec::new();
        loop {
            let frame = decode(&next(&mut frames).await);
            let end = frame["type"] == "FILES_ERR" || frame["done"] == true;
            answer.push(frame);
            if end {
                return answer;
            }
        }
    }

    fn entries(frames: &[Value]) -> Vec<Value> {
        frames
            .iter()
            .flat_map(|frame| frame["entries"].as_array().cloned().unwrap_or_default())
            .collect()
    }

    fn named<'a>(entries: &'a [Value], name: &str) -> &'a Value {
        entries
            .iter()
            .find(|entry| entry["name"] == name)
            .unwrap_or_else(|| panic!("{name} listed in {entries:?}"))
    }

    #[cfg(unix)]
    fn command_line(program: &str, args: &[&str]) -> String {
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{program} {args:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lists_a_folder_with_mode_owner_and_group() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("unix");
        std::fs::create_dir(folder.join("sub")).unwrap();
        std::fs::set_permissions(folder.join("sub"), std::fs::Permissions::from_mode(0o750))
            .unwrap();
        std::fs::create_dir(folder.join("shared")).unwrap();
        std::fs::set_permissions(
            folder.join("shared"),
            std::fs::Permissions::from_mode(0o2750),
        )
        .unwrap();
        std::fs::write(folder.join("f.txt"), "abc").unwrap();
        std::fs::set_permissions(folder.join("f.txt"), std::fs::Permissions::from_mode(0o640))
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(folder.join("f.txt"))
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000))
            .unwrap();
        std::fs::write(folder.join(".h"), "").unwrap();
        symlink("sub", folder.join("l")).unwrap();
        symlink("nowhere", folder.join("gone")).unwrap();
        symlink("/etc/passwd", folder.join("pw")).unwrap();
        let user = command_line("id", &["-un"]);
        let group = command_line("id", &["-gn"]);

        let message = list(&folder.path(), false);
        let HubToAgent::FilesList { request_id, .. } = &message else {
            unreachable!()
        };
        let request_id = request_id.clone();
        let frames = answer_of(message).await;
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["type"], "FILES_ENTRIES");
        assert_eq!(frames[0]["request_id"], request_id.as_str());
        assert_eq!(frames[0]["done"], true);
        let listed = entries(&frames);
        let names: HashSet<&str> = listed
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            HashSet::from(["sub", "shared", "f.txt", "l", "gone", "pw"])
        );
        let sub = named(&listed, "sub");
        assert_eq!(sub["kind"], "directory");
        assert_eq!(sub["size"], Value::Null);
        assert_eq!(sub["mode"], 16872);
        assert_eq!(sub["attributes"], Value::Null);
        assert_eq!(named(&listed, "shared")["mode"], 17896);
        let file = named(&listed, "f.txt");
        assert_eq!(file["kind"], "file");
        assert_eq!(file["size"], 3);
        assert_eq!(file["mode"], 33184);
        assert_eq!(file["mtime_ms"], 1_700_000_000_000i64);
        let link = named(&listed, "l");
        assert_eq!(link["kind"], "symlink");
        assert_eq!(link["link_target"], "sub");
        assert_eq!(link["link_kind"], "directory");
        assert_eq!(named(&listed, "gone")["link_kind"], "missing");
        let passwd = named(&listed, "pw");
        assert_eq!(passwd["kind"], "symlink");
        assert_eq!(passwd["link_kind"], "file");
        for entry in &listed {
            assert_eq!(entry["owner"], user.as_str(), "{entry}");
            assert_eq!(entry["group"], group.as_str(), "{entry}");
        }

        let hidden = entries(&answer_of(list(&folder.path(), true)).await);
        assert!(
            hidden.iter().any(|entry| entry["name"] == ".h"),
            "{hidden:?}"
        );
    }

    /// The owner and group `Get-Acl` reads (the group's SID when it prints no
    /// name), each line marked: a descriptor may have no group at all.
    #[cfg(windows)]
    fn get_acl(path: &Path) -> (String, Option<String>) {
        let script = format!(
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $a = Get-Acl -LiteralPath '{}'; 'OWNER=' + $a.Owner; $g = $a.Group; if (-not $g) {{ $s = $a.GetGroup([Security.Principal.SecurityIdentifier]); if ($s) {{ $g = $s.Value }} }}; 'GROUP=' + $g",
            path.display()
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .unwrap();
        assert!(output.status.success(), "Get-Acl");
        let text = String::from_utf8(output.stdout).unwrap();
        let field = |key: &str| {
            text.lines()
                .find_map(|line| line.trim().strip_prefix(key).map(str::to_string))
                .unwrap_or_else(|| panic!("{key} in {text:?}"))
        };
        let group = field("GROUP=");
        (field("OWNER="), (!group.is_empty()).then_some(group))
    }

    #[cfg(windows)]
    fn system_root() -> PathBuf {
        PathBuf::from(std::env::var("SystemRoot").expect("SystemRoot is set"))
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn lists_a_folder_with_attributes_owner_and_group() {
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("windows");
        std::fs::create_dir(folder.join("sub")).unwrap();
        for name in ["f.txt", "ro.txt", "h.txt", "x.txt"] {
            std::fs::write(folder.join(name), "x").unwrap();
        }
        set_attributes(&folder.join("ro.txt"), 0x21);
        set_attributes(&folder.join("h.txt"), 0x22);
        set_attributes(&folder.join("x.txt"), 0x2001);
        let target = system_root().join("System32");
        let made = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(folder.join("j"))
            .arg(&target)
            .output()
            .unwrap();
        assert!(made.status.success(), "junction made");
        let (owner, group) = get_acl(&folder.join("f.txt"));

        let listed = entries(&answer_of(list(&folder.path(), true)).await);
        assert_eq!(named(&listed, "x.txt")["attributes"], 8193);
        let spelled = |name: &str| named(&listed, name)["attributes"].as_u64().unwrap() & 0x437;
        assert_eq!(spelled("sub"), 0x10);
        assert_eq!(spelled("f.txt"), 0x20);
        assert_eq!(spelled("ro.txt"), 0x21);
        assert_eq!(spelled("h.txt"), 0x22);
        assert_eq!(spelled("j"), 0x410);
        let junction = named(&listed, "j");
        assert_eq!(junction["kind"], "symlink");
        assert_eq!(junction["link_kind"], "directory");
        for entry in &listed {
            assert_eq!(entry["mode"], Value::Null, "{entry}");
            assert_eq!(entry["owner"], owner.as_str(), "{entry}");
            assert_ne!(entry["owner"], "NT SERVICE\\TrustedInstaller", "{entry}");
        }
        let file = named(&listed, "f.txt");
        match &group {
            Some(group) => {
                assert_eq!(file["group"], group.as_str());
                assert_ne!(file["group"], file["owner"]);
            }
            None => assert_eq!(file["group"], Value::Null),
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn reads_each_entry_own_descriptor() {
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("long");
        std::fs::write(folder.join("short.txt"), "x").unwrap();
        // A name Win32 would read without its trailing dot, as `report`, which
        // does not exist: only a verbatim path reaches its descriptor.
        let odd = format!(r"\\?\{}", folder.join("report.").display());
        std::fs::write(&odd, "x").unwrap();
        let mut deep = folder.0.clone();
        for index in 0..5 {
            deep.push(format!("{index}-{}", "d".repeat(60)));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("far.txt"), "x").unwrap();
        assert!(deep.join("far.txt").as_os_str().len() > 260);
        let (owner, _) = get_acl(&folder.join("short.txt"));
        let beside = entries(&answer_of(list(&folder.path(), false)).await);
        assert_eq!(named(&beside, "report.")["owner"], owner.as_str());

        let listed = entries(&answer_of(list(&deep.to_string_lossy(), false)).await);
        assert_eq!(named(&listed, "far.txt")["owner"], owner.as_str());
        let stated = entries(&answer_of(stat(&deep.join("far.txt").to_string_lossy())).await);
        assert_eq!(stated[0]["owner"], owner.as_str());
    }

    #[tokio::test]
    async fn stats_one_path() {
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("stat");
        std::fs::write(folder.join("f.txt"), "abc").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("f.txt", folder.join("l")).unwrap();
        #[cfg(windows)]
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(folder.join("l"))
            .arg(&folder.0)
            .output()
            .unwrap();

        let listed = entries(&answer_of(list(&folder.path(), false)).await);
        let frames = answer_of(stat(&folder.join("f.txt").to_string_lossy())).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["done"], true);
        let stated = entries(&frames);
        assert_eq!(stated.len(), 1);
        assert_eq!(&stated[0], named(&listed, "f.txt"));
        let link = entries(&answer_of(stat(&folder.join("l").to_string_lossy())).await);
        assert_eq!(link[0]["kind"], "symlink");
        let missing = answer_of(stat(&folder.join("nope").to_string_lossy())).await;
        assert_eq!(missing[0]["type"], "FILES_ERR");
        assert_eq!(missing[0]["code"], "NOT_FOUND");

        #[cfg(unix)]
        {
            let passwd = entries(&answer_of(stat("/etc/passwd")).await);
            assert_eq!(passwd[0]["owner"], "root");
            assert_eq!(passwd[0]["group"], "root");
        }
        #[cfg(windows)]
        {
            let cmd = system_root().join("System32").join("cmd.exe");
            let shell = entries(&answer_of(stat(&cmd.to_string_lossy())).await);
            assert_eq!(shell[0]["owner"], "NT SERVICE\\TrustedInstaller");
            assert_eq!(shell[0]["group"], "NT SERVICE\\TrustedInstaller");
        }
    }

    #[tokio::test]
    async fn sends_a_large_folder_in_batches() {
        let _serial = SERIAL.lock().await;
        let many = Folder::new("many");
        for index in 0..2_500 {
            std::fs::write(many.join(&format!("f{index:04}")), "").unwrap();
        }
        let frames = answer_of(list(&many.path(), false)).await;
        let sizes: Vec<usize> = frames
            .iter()
            .map(|frame| frame["entries"].as_array().unwrap().len())
            .collect();
        assert_eq!(sizes, vec![1_000, 1_000, 500]);
        let done: Vec<bool> = frames
            .iter()
            .map(|frame| frame["done"].as_bool().unwrap())
            .collect();
        assert_eq!(done, vec![false, false, true]);
        let names: HashSet<String> = entries(&frames)
            .iter()
            .map(|entry| entry["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names.len(), 2_500);

        let exact = Folder::new("exact");
        for index in 0..1_000 {
            std::fs::write(exact.join(&format!("f{index:04}")), "").unwrap();
        }
        let frames = answer_of(list(&exact.path(), false)).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["entries"].as_array().unwrap().len(), 1_000);
        assert_eq!(frames[0]["done"], true);

        let empty = Folder::new("empty");
        let frames = answer_of(list(&empty.path(), false)).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["entries"], Value::Array(Vec::new()));
        assert_eq!(frames[0]["done"], true);

        #[cfg(unix)]
        {
            let long = Folder::new("long");
            let target = "x".repeat(2_048);
            for index in 0..1_000 {
                std::os::unix::fs::symlink(&target, long.join(&format!("l{index:04}"))).unwrap();
            }
            let frames = answer_of(list(&long.path(), false)).await;
            assert!(frames.len() >= 2, "{} frames", frames.len());
            let largest = entries(&frames).iter().map(text_of).max().unwrap();
            for (index, frame) in frames.iter().enumerate() {
                let text: usize = frame["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(text_of)
                    .sum();
                assert!(text <= BATCH_TEXT + largest, "frame {index}: {text} bytes");
                assert_eq!(frame["done"], index + 1 == frames.len());
            }
            let names: HashSet<String> = entries(&frames)
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(names.len(), 1_000);
        }
    }

    #[cfg(unix)]
    fn text_of(entry: &Value) -> usize {
        ["name", "link_target", "owner", "group"]
            .iter()
            .map(|key| entry[*key].as_str().map_or(0, str::len))
            .sum()
    }

    #[cfg(unix)]
    fn is_root() -> bool {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() == 0 }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaves_out_entries_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        if is_root() {
            return;
        }
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("untraversable");
        let shut = folder.join("shut");
        std::fs::create_dir(&shut).unwrap();
        std::fs::write(shut.join("a"), "").unwrap();
        std::fs::write(shut.join("b"), "").unwrap();
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o444)).unwrap();
        let frames = answer_of(list(&shut.to_string_lossy(), false)).await;
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["type"], "FILES_ENTRIES");
        assert_eq!(frames[0]["entries"], Value::Array(Vec::new()));
        assert_eq!(frames[0]["done"], true);
    }

    #[tokio::test]
    async fn answers_each_failure_by_its_code() {
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("failures");
        std::fs::write(folder.join("f.txt"), "").unwrap();
        let marker = folder.0.file_name().unwrap().to_string_lossy().into_owned();
        #[cfg_attr(windows, allow(unused_mut))]
        let mut cases = vec![
            (
                folder.join("missing").to_string_lossy().into_owned(),
                "NOT_FOUND",
            ),
            (
                folder.join("f.txt").to_string_lossy().into_owned(),
                "NOT_A_DIRECTORY",
            ),
        ];
        #[cfg(unix)]
        if !is_root() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir(folder.join("closed")).unwrap();
            std::fs::set_permissions(
                folder.join("closed"),
                std::fs::Permissions::from_mode(0o000),
            )
            .unwrap();
            cases.push((
                folder.join("closed").to_string_lossy().into_owned(),
                "PERMISSION_DENIED",
            ));
        }
        for (path, code) in cases {
            let frames = answer_of(list(&path, false)).await;
            assert_eq!(frames.len(), 1, "{path}: {frames:?}");
            assert_eq!(frames[0]["type"], "FILES_ERR", "{path}");
            assert_eq!(frames[0]["code"], code, "{path}");
            let message = frames[0]["message"].as_str().unwrap();
            assert!(!message.contains(&marker), "no path in {message:?}");
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn reads_a_name_that_is_not_utf8_lossily() {
        use std::os::unix::ffi::OsStrExt;
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("bytes");
        std::fs::write(folder.0.join(std::ffi::OsStr::from_bytes(b"a\xffb")), "").unwrap();
        let listed = entries(&answer_of(list(&folder.path(), false)).await);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "a\u{FFFD}b");
    }

    #[test]
    fn names_an_id_without_a_name_by_the_id() {
        let shared = Mutex::new(SharedNames::default());
        let now = Instant::now();
        #[cfg(unix)]
        {
            let absent = |database: &str| {
                !std::process::Command::new("getent")
                    .args([database, "2147483646"])
                    .output()
                    .is_ok_and(|output| output.status.success())
            };
            if absent("passwd") && absent("group") {
                let mut names = ListingNames::default();
                assert_eq!(
                    names.name(NameKey::User(2_147_483_646), now, &shared, &lookup),
                    "2147483646"
                );
                assert_eq!(
                    names.name(NameKey::Group(2_147_483_646), now, &shared, &lookup),
                    "2147483646"
                );
            }
        }
        #[cfg(windows)]
        {
            let mut names = ListingNames::default();
            let sid = "S-1-5-21-1-2-3-4242";
            assert_eq!(
                names.name(NameKey::Sid(sid.into()), now, &shared, &lookup),
                sid
            );
        }
    }

    #[test]
    fn looks_each_id_up_once_while_cached() {
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        let asked: RefCell<HashMap<NameKey, u32>> = RefCell::new(HashMap::new());
        let answers: RefCell<HashMap<NameKey, Option<String>>> = RefCell::new(HashMap::new());
        let counting = |key: &NameKey| {
            *asked.borrow_mut().entry(key.clone()).or_default() += 1;
            answers.borrow().get(key).cloned().flatten()
        };
        let count = |key: &NameKey| asked.borrow().get(key).copied().unwrap_or(0);

        // Once while cached, across listings; again once 5 minutes have gone.
        let shared = Mutex::new(SharedNames::default());
        for id in 1..=3 {
            answers
                .borrow_mut()
                .insert(NameKey::User(id), Some(format!("u{id}")));
        }
        for when in [0, 1] {
            let mut names = ListingNames::default();
            for id in 1..=3 {
                assert_eq!(
                    names.name(NameKey::User(id), at(when), &shared, &counting),
                    format!("u{id}")
                );
            }
        }
        assert!((1..=3).all(|id| count(&NameKey::User(id)) == 1));
        let mut later = ListingNames::default();
        for id in 1..=3 {
            later.name(NameKey::User(id), at(301), &shared, &counting);
        }
        assert!((1..=3).all(|id| count(&NameKey::User(id)) == 2));

        // A uid and a gid of one number are two keys.
        let shared = Mutex::new(SharedNames::default());
        answers
            .borrow_mut()
            .insert(NameKey::User(1000), Some("alice".into()));
        answers
            .borrow_mut()
            .insert(NameKey::Group(1000), Some("staff".into()));
        let mut names = ListingNames::default();
        assert_eq!(
            names.name(NameKey::User(1000), at(0), &shared, &counting),
            "alice"
        );
        assert_eq!(
            names.name(NameKey::Group(1000), at(0), &shared, &counting),
            "staff"
        );

        // No name is cached too, as long, then asked again.
        let shared = Mutex::new(SharedNames::default());
        let key = NameKey::User(7000);
        assert_eq!(
            ListingNames::default().name(key.clone(), at(0), &shared, &counting),
            "7000"
        );
        answers.borrow_mut().insert(key.clone(), Some("bob".into()));
        assert_eq!(
            ListingNames::default().name(key.clone(), at(100), &shared, &counting),
            "7000"
        );
        assert_eq!(count(&key), 1);
        assert_eq!(
            ListingNames::default().name(key.clone(), at(301), &shared, &counting),
            "bob"
        );

        // The shared cache never holds more than its bound: emptied when full.
        let shared = Mutex::new(SharedNames::default());
        let mut names = ListingNames::default();
        for id in 0..NAME_CACHE_KEYS as u32 {
            names.name(NameKey::Group(100_000 + id), at(0), &shared, &counting);
        }
        assert_eq!(shared.lock().unwrap().len(), NAME_CACHE_KEYS);
        ListingNames::default().name(NameKey::Group(200_000), at(0), &shared, &counting);
        assert_eq!(shared.lock().unwrap().len(), 1);

        // One listing asks each key once, whatever the shared cache dropped.
        let shared = Mutex::new(SharedNames::default());
        let before: u32 = asked.borrow().values().sum();
        let mut names = ListingNames::default();
        for id in 0..=NAME_CACHE_KEYS as u32 {
            names.name(NameKey::User(300_000 + id), at(0), &shared, &counting);
        }
        names.name(NameKey::User(300_000), at(0), &shared, &counting);
        let after: u32 = asked.borrow().values().sum();
        assert_eq!(after - before, NAME_CACHE_KEYS as u32 + 1);

        // A listing's own map ages as the shared cache does.
        let shared = Mutex::new(SharedNames::default());
        let key = NameKey::User(9000);
        answers
            .borrow_mut()
            .insert(key.clone(), Some("alice".into()));
        ListingNames::default().name(key.clone(), at(0), &shared, &counting);
        answers.borrow_mut().insert(key.clone(), Some("bob".into()));
        let mut names = ListingNames::default();
        assert_eq!(
            names.name(key.clone(), at(299), &shared, &counting),
            "alice"
        );
        assert_eq!(names.name(key.clone(), at(301), &shared, &counting), "bob");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn lists_the_drives_at_the_root() {
        let _serial = SERIAL.lock().await;
        let system = std::env::var("SystemDrive").expect("SystemDrive is set");
        let drives = entries(&answer_of(list("/", false)).await);
        let drive = named(&drives, &system);
        assert_eq!(drive["kind"], "directory");
        assert!(drive["attributes"].is_u64(), "{drive}");
        let root = entries(&answer_of(stat("/")).await);
        assert_eq!(
            root[0],
            serde_json::json!({
                "name": "/", "kind": "directory", "size": null, "mtime_ms": null,
                "mode": null, "attributes": null, "owner": null, "group": null,
            })
        );
    }

    #[tokio::test]
    async fn waits_for_a_permit_outside_the_dispatch_loop() {
        let _serial = SERIAL.lock().await;
        let folder = Folder::new("permits");
        let held = Arc::clone(&REQUESTS)
            .acquire_many_owned(REQUESTS_AT_ONCE as u32)
            .await
            .unwrap();
        let (frame_tx, mut frames) = mpsc::unbounded_channel();
        tokio::time::timeout(
            Duration::from_secs(1),
            ask(list(&folder.path(), false), frame_tx),
        )
        .await
        .expect("handle_message returns while every permit is held");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            frames.try_recv().is_err(),
            "no answer while every permit is held"
        );
        drop(held);
        assert_eq!(decode(&next(&mut frames).await)["done"], true);
    }

    #[tokio::test]
    async fn queues_at_most_two_frames_per_listing() {
        let _serial = SERIAL.lock().await;
        // One listing: two frames wait for the writer, then the rest follow.
        let folder = Folder::new("queue");
        for index in 0..5_000 {
            std::fs::write(folder.join(&format!("f{index:04}")), "").unwrap();
        }
        let (frame_tx, mut frames) = mpsc::unbounded_channel();
        ask(list(&folder.path(), false), frame_tx).await;
        let first = next(&mut frames).await;
        let second = next(&mut frames).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(frames.try_recv().is_err(), "a third frame waits");
        drop((first, second));
        let mut rest = Vec::new();
        for _ in 0..3 {
            rest.push(decode(&next(&mut frames).await));
        }
        assert_eq!(rest[2]["done"], true);

        // Six requests, lists and stats, on two connections: four frames wait
        // in all, until they are written.
        let small: Vec<Folder> = (0..3)
            .map(|index| Folder::new(&format!("small{index}")))
            .collect();
        for folder in &small {
            std::fs::write(folder.join("f"), "").unwrap();
        }
        let file = small[0].join("f").to_string_lossy().into_owned();
        let (one_tx, mut one) = mpsc::unbounded_channel();
        let (two_tx, mut two) = mpsc::unbounded_channel();
        ask(list(&small[0].path(), false), one_tx.clone()).await;
        ask(stat(&file), two_tx.clone()).await;
        ask(stat(&file), one_tx.clone()).await;
        ask(list(&small[1].path(), false), two_tx.clone()).await;
        ask(list(&small[2].path(), false), one_tx).await;
        ask(stat(&file), two_tx).await;
        let mut queued = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        while queued.len() < REQUESTS_AT_ONCE && Instant::now() < deadline {
            if let Ok(frame) = one.try_recv() {
                queued.push(frame);
            } else if let Ok(frame) = two.try_recv() {
                queued.push(frame);
            } else {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        assert_eq!(queued.len(), REQUESTS_AT_ONCE);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            one.try_recv().is_err() && two.try_recv().is_err(),
            "two requests wait for a permit"
        );
        drop(queued);
        let mut later = 0;
        let deadline = Instant::now() + Duration::from_secs(60);
        while later < 2 && Instant::now() < deadline {
            if one.try_recv().is_ok() || two.try_recv().is_ok() {
                later += 1;
            } else {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        assert_eq!(later, 2);
    }

    #[tokio::test]
    async fn ends_a_listing_whose_read_fails_midway() {
        let _serial = SERIAL.lock().await;
        let (frame_tx, mut frames) = mpsc::unbounded_channel();
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let mut out = Sender::new(frame_tx, None, handle);
            let items = (0..1_500)
                .map(|index| Ok(Some(Raw::named(&format!("f{index:04}")))))
                .chain(std::iter::once(Err(io::Error::other(
                    "the share went away",
                ))));
            let dispatch = tracing::dispatcher::get_default(|current| current.clone());
            send_listing(
                "midway",
                items,
                &mut out,
                &mut ListingNames::default(),
                &dispatch,
            );
        })
        .await
        .unwrap();
        let first = decode(&next(&mut frames).await);
        assert_eq!(first["type"], "FILES_ENTRIES");
        assert_eq!(first["entries"].as_array().unwrap().len(), 1_000);
        assert_eq!(first["done"], false);
        let second = decode(&next(&mut frames).await);
        assert_eq!(second["type"], "FILES_ERR");
        assert_eq!(second["code"], "FILE_ACCESS_FAILED");
        assert!(frames.try_recv().is_err(), "nothing after the error");
    }

    #[tokio::test]
    async fn logs_no_path_name_owner_or_group() {
        use crate::handler::stdio_tests::LogCapture;
        let _serial = SERIAL.lock().await;
        let folder_marker = format!("secret-folder-{}", ulid::Ulid::generate());
        let name_marker = format!("secret-name-{}", ulid::Ulid::generate());
        let folder = Folder::new(&folder_marker);
        std::fs::write(folder.join(&name_marker), "").unwrap();
        let capture = LogCapture(Arc::new(std::sync::Mutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(capture.clone())
            .finish();
        // As the spawn test: a second dispatch keeps tracing from caching
        // "never" for a callsite a parallel test reached first.
        let _parallel_dispatch = tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_writer(std::io::sink)
                .finish(),
        );
        let dispatch = tracing::Dispatch::new(subscriber);
        let _subscriber = tracing::dispatcher::set_default(&dispatch);

        let listed = entries(&answer_of(list(&folder.path(), false)).await);
        let stated = entries(&answer_of(stat(&folder.join(&name_marker).to_string_lossy())).await);
        #[cfg(windows)]
        answer_of(list("/", false)).await;
        let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        // The task's own line, and on Windows its threads': the capture reaches them.
        assert!(
            logs.contains("file request answered"),
            "the task's line captured: {logs}"
        );
        #[cfg(windows)]
        {
            assert!(
                logs.contains("descriptors read"),
                "a descriptor thread's line captured"
            );
            assert!(
                logs.contains("drive root probed"),
                "a drive probe's line captured"
            );
        }
        assert!(
            logs.contains("FILES_LIST"),
            "the listing's summary captured: {logs}"
        );
        assert!(
            logs.contains("FILES_STAT"),
            "the stat's summary captured: {logs}"
        );
        assert!(!logs.contains(&folder_marker), "no path in the log");
        assert!(!logs.contains(&name_marker), "no name in the log");
        // Each part of a name: a log line may escape `DOMAIN\name` as `DOMAIN\\name`.
        for entry in listed.iter().chain(stated.iter()) {
            for key in ["owner", "group"] {
                if let Some(value) = entry[key].as_str() {
                    for part in value.split('\\').filter(|part| part.len() >= 3) {
                        assert!(!logs.contains(part), "no {key} in the log");
                    }
                }
            }
        }
    }
}
