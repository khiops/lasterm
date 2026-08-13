use lasterm_process_lock::ProcessLock;
pub mod tls_identity;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::error::Error;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, Url, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// The hub port, once the launch path resolved it. Zero until then.
///
/// Deliberately not 4100. An initial value that looks like a real port would be
/// handed to the client by any path that reached the window without resolving,
/// and the client would talk to whatever holds it — the shape of the defect this
/// file exists to remove. Zero cannot be dialled, so a miss is loud.
static HUB_PORT: AtomicU16 = AtomicU16::new(0);
static HUB_CONNECTION: Mutex<Option<HubConnection>> = Mutex::new(None);
static NEXT_RELAY_ID: AtomicU64 = AtomicU64::new(1);
static HUB_UPLOADS: OnceLock<Mutex<HashMap<u64, HubUpload>>> = OnceLock::new();
static RELAY_RESPONSE_ACKS: OnceLock<Mutex<HashMap<u64, mpsc::SyncSender<bool>>>> = OnceLock::new();
static HUB_WS_RELAYS: OnceLock<Mutex<HashMap<u64, HubWsRelay>>> = OnceLock::new();
/// What the launched sidecar has told us, as one value.
///
/// This was three atomics — announced port, exited flag, exit code — and no reader
/// of three independent cells can be sure it saw a consistent pair: the setup thread
/// could read a published port while a termination event was still queued, and both
/// of its exit checks would pass. One cell holding one state makes that unreadable
/// combination unrepresentable. Only the event task writes it, so an exit can never
/// be overtaken by a stale announcement.
///
/// Gated where it is read: only the release path launches a sidecar, and an ungated
/// declaration fails the dev build as dead code.
/// Not gated to the release cfg, unlike the launch path that uses it: `cargo test`
/// runs with `dev` set, and the supersession rule below is the whole reason this type
/// exists — a rule no test job could reach would be a rule nobody checks.
#[cfg_attr(dev, allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum HubState {
    /// Launched, nothing said yet.
    Starting,
    /// It announced this port on its own stdout, with nothing queued to contradict it.
    Serving(HubAnnouncement),
    /// It is gone. `None` means signalled, or the event stream ended without saying.
    Exited(Option<i32>),
}

#[cfg_attr(dev, allow(dead_code))]
static HUB_STATE: Mutex<HubState> = Mutex::new(HubState::Starting);

/// Publish a state, keeping an exit final: a late announcement must not resurrect a
/// child that has already gone.
#[cfg_attr(dev, allow(dead_code))]
fn publish_hub_state(next: HubState) {
    let Ok(mut state) = HUB_STATE.lock() else {
        eprintln!("[lasterm] hub state lock poisoned; treating the child as gone");
        return;
    };
    if matches!(&*state, HubState::Exited(_)) && !matches!(&next, HubState::Exited(_)) {
        return;
    }
    *state = next;
}

#[cfg_attr(dev, allow(dead_code))]
fn hub_state() -> HubState {
    match HUB_STATE.lock() {
        Ok(state) => state.clone(),
        // A poisoned lock means the writer panicked; the child's fate is unknown and
        // "still starting" is the one reading that would hang startup on it.
        Err(_) => HubState::Exited(None),
    }
}
/// The hub exits with this when another process already holds the single-hub lock.
///
/// It is the only proof available here that the thing occupying the port is our
/// own hub: `hub.lock` is 0600 in the user's state directory, so a process
/// belonging to another user cannot hold it. A health probe cannot establish
/// that — any local listener can answer 200 — which is why adoption is decided by
/// this code and not by a request (#170).
#[cfg(not(dev))]
const HUB_LOCK_HELD_EXIT_CODE: i32 = 73;
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_CALLER_CLIENT_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static QUIT_COORDINATOR: OnceLock<Mutex<QuitCoordinator>> = OnceLock::new();
static WINDOW_CLOSE_COORDINATOR: OnceLock<Mutex<WindowCloseCoordinator>> = OnceLock::new();
static CLOSE_BEHAVIOR_TEMP_COUNTER: AtomicU16 = AtomicU16::new(0);
// These mirror the bounds in the hub. A request can take the full client
// timeout, then the hub's agent stopper can use its bound, then graceful
// shutdown has its own bound before it deletes runtime.json.
const HUB_AGENT_STOP_TIMEOUT_MS: u64 = 12_000;
/// The user-visible quit request gets 25 s: enough for the hub's 12 s agent
/// stopper and scheduling slack, but finite when the peer sends no headers.
const HUB_QUIT_REQUEST_TIMEOUT_MS: u64 = 25_000;
/// Covers TLS, request headers, and body transfer. A connected but silent hub
/// must not retain a desktop request or quit path indefinitely.
const HUB_REQUEST_TIMEOUT: Duration = Duration::from_millis(HUB_QUIT_REQUEST_TIMEOUT_MS);
const HUB_GRACEFUL_SHUTDOWN_TIMEOUT_MS: u64 = 10_000;
const HUB_QUIT_OBSERVE_TIMEOUT: Duration = Duration::from_millis(
    HUB_QUIT_REQUEST_TIMEOUT_MS + HUB_AGENT_STOP_TIMEOUT_MS + HUB_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
);
const HUB_QUIT_OBSERVE_POLL: Duration = Duration::from_millis(50);
const WINDOW_CLOSE_PRESENTATION_ACK_TIMEOUT: Duration = Duration::from_secs(1);
const WINDOW_CLOSE_ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_AGENT_BINARY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_AGENT_MANIFEST_BYTES: u64 = 1024 * 1024;
/// One fixed IPC frame keeps a multipart file out of a JavaScript string and
/// bounds the native hand-off independently of the route's file-size cap.
const RELAY_CHUNK_BYTES: usize = 256 * 1024;
const RELAY_UPLOAD_QUEUE_CHUNKS: usize = 2;
const MAX_ACTIVE_RELAY_UPLOADS: usize = 4;
/// A hub OUTPUT batch is at most 256 KiB before MessagePack metadata. This cap
/// leaves room for that envelope while keeping one native WebSocket message
/// bounded independently of whether the webview drains its IPC channel.
const HUB_WS_MAX_MESSAGE_BYTES: usize = RELAY_CHUNK_BYTES * 2;
/// One capped WebSocket message plus the one IPC frame awaiting its ACK.
#[cfg(test)]
const HUB_WS_OUTPUT_BUFFERED_BYTES: usize = HUB_WS_MAX_MESSAGE_BYTES + RELAY_CHUNK_BYTES + 1;
/// At most this many unsent webview-to-hub messages exist in native memory.
const HUB_WS_INPUT_QUEUE_MESSAGES: usize = 2;
const INSTANCE_ACQUIRE_RETRY_INTERVAL: Duration = Duration::from_millis(100);
const INSTANCE_HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);
const INSTANCE_RAISE_TIMEOUT: Duration = Duration::from_secs(2);
const INSTANCE_RAISE_REQUEST: &[u8] = b"raise-v1\n";
const INSTANCE_RAISE_SUCCESS: &[u8] = b"ok\n";
const INSTANCE_RAISE_FAILURE: &[u8] = b"error\n";
const INSTANCE_RAISE_MAX_BYTES: usize = 64;

/// One parsed origin rather than a URL prefix. In particular, matching the host
/// exactly rejects lookalikes such as `tauri.localhost.example.com`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WebviewOrigin {
    scheme: &'static str,
    host: &'static str,
    port: Option<u16>,
}

// Wry serves Tauri's custom protocol through an HTTP localhost workaround on
// Windows. Other desktop platforms keep Tauri's native custom protocol.
#[cfg(windows)]
const PACKAGED_WEBVIEW_ORIGIN: WebviewOrigin = WebviewOrigin {
    scheme: "http",
    host: "tauri.localhost",
    port: Some(80),
};
#[cfg(not(windows))]
const PACKAGED_WEBVIEW_ORIGIN: WebviewOrigin = WebviewOrigin {
    scheme: "tauri",
    host: "localhost",
    port: None,
};

const VITE_WEBVIEW_ORIGIN: WebviewOrigin = WebviewOrigin {
    scheme: "http",
    host: "localhost",
    port: Some(5173),
};

fn has_webview_origin(url: &Url, origin: WebviewOrigin) -> bool {
    url.scheme() == origin.scheme
        && url.host_str() == Some(origin.host)
        && url.port_or_known_default() == origin.port
}

/// The only documents a Lasterm webview may load. This is deliberately a
/// plain predicate so its security boundary is testable without a running
/// renderer.
fn allows_webview_navigation(url: &Url, development_build: bool) -> bool {
    has_webview_origin(url, PACKAGED_WEBVIEW_ORIGIN)
        || (development_build && has_webview_origin(url, VITE_WEBVIEW_ORIGIN))
}

fn allows_current_webview_navigation(url: &Url) -> bool {
    allows_webview_navigation(url, cfg!(dev))
}

/// A renderer never gets another native browsing context. This remains a plain
/// predicate so popup refusal is testable without a running renderer.
fn allows_webview_new_window(_url: &Url) -> bool {
    false
}
#[cfg(any(target_os = "windows", test))]
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
#[cfg(any(target_os = "windows", test))]
const ERROR_PROC_NOT_FOUND: u32 = 127;
#[cfg(any(target_os = "windows", test))]
const APPMODEL_ERROR_NO_PACKAGE: u32 = 15_700;

/// The package-identity probe must explicitly establish either state before
/// changing updater behavior. Unexpected API statuses remain fail-closed.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageIdentityProbe {
    Packaged { status: u32 },
    Unpackaged,
    Inconclusive { status: u32 },
}

#[cfg(any(target_os = "windows", test))]
fn classify_package_identity_status(status: u32) -> PackageIdentityProbe {
    match status {
        APPMODEL_ERROR_NO_PACKAGE => PackageIdentityProbe::Unpackaged,
        0 | ERROR_INSUFFICIENT_BUFFER => PackageIdentityProbe::Packaged { status },
        _ => PackageIdentityProbe::Inconclusive { status },
    }
}

#[cfg(any(target_os = "windows", test))]
fn classify_package_identity_lookup_error(error: u32) -> PackageIdentityProbe {
    match error {
        // GetCurrentPackageFullName does not exist on Windows 7. A missing
        // symbol therefore establishes that this process is unpackaged.
        ERROR_PROC_NOT_FOUND => PackageIdentityProbe::Unpackaged,
        _ => PackageIdentityProbe::Inconclusive { status: error },
    }
}

#[cfg(target_os = "windows")]
fn current_package_identity_probe() -> PackageIdentityProbe {
    type Hmodule = *mut std::ffi::c_void;
    type GetCurrentPackageFullName = unsafe extern "system" fn(*mut u32, *mut u16) -> u32;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(module_name: *const u16) -> Hmodule;
        fn GetProcAddress(module: Hmodule, procedure_name: *const u8) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }

    // GetCurrentPackageFullName was introduced after Windows 7. Resolving it
    // dynamically keeps the executable loadable there; no symbol means this
    // process cannot be packaged as MSIX, so the updater remains available.
    let kernel32_name: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
    let kernel32 = unsafe { GetModuleHandleW(kernel32_name.as_ptr()) };
    if kernel32.is_null() {
        return PackageIdentityProbe::Inconclusive {
            status: std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default() as u32,
        };
    }
    let procedure =
        unsafe { GetProcAddress(kernel32, c"GetCurrentPackageFullName".as_ptr().cast()) };
    if procedure.is_null() {
        // GetProcAddress sets the thread's last-error code. Read it before any
        // other operation can overwrite it, then fail closed unless the symbol
        // is genuinely absent (as on Windows 7).
        let error = unsafe { GetLastError() };
        return classify_package_identity_lookup_error(error);
    }

    let get_current_package_full_name: GetCurrentPackageFullName =
        unsafe { std::mem::transmute(procedure) };
    let mut package_full_name_length = 0;
    let status = unsafe {
        get_current_package_full_name(&mut package_full_name_length, std::ptr::null_mut())
    };
    classify_package_identity_status(status)
}

#[cfg(not(target_os = "windows"))]
fn current_package_identity_probe() -> PackageIdentityProbe {
    PackageIdentityProbe::Unpackaged
}

#[derive(Clone, Copy)]
enum AgentFileKind {
    Binary,
    Manifest,
}

impl AgentFileKind {
    fn max_bytes(self) -> u64 {
        match self {
            Self::Binary => MAX_AGENT_BINARY_BYTES,
            Self::Manifest => MAX_AGENT_MANIFEST_BYTES,
        }
    }
}

impl TryFrom<&str> for AgentFileKind {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "binary" => Ok(Self::Binary),
            "manifest" => Ok(Self::Manifest),
            _ => Err("INVALID_KIND: expected \"binary\" or \"manifest\"".to_string()),
        }
    }
}

#[derive(Serialize)]
struct PickedAgentFile {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Deserialize)]
struct RuntimeInfo {
    pid: Option<u32>,
    port: u16,
    #[serde(rename = "instanceId")]
    instance_id: Option<String>,
    #[serde(rename = "ownerToken")]
    owner_token: Option<String>,
    /// Base64 DER SubjectPublicKeyInfo for the TLS listener named by `port`.
    spki: Option<String>,
}

/// The one endpoint and public key this desktop has authorised for the current
/// process. It is established once at startup and never reconstructed from a
/// mutable discovery record while credentials are being relayed.
#[derive(Clone, Debug)]
struct HubConnection {
    port: u16,
    expected_spki: Vec<u8>,
    client: reqwest::blocking::Client,
}

/// The complete ready line written to a launched child's stdout. The port is
/// deliberately separate from the pin: it changes on every OS-assigned launch,
/// while the loopback hub identity does not.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HubAnnouncement {
    port: u16,
    spki: Vec<u8>,
}

#[derive(Default, Deserialize, Serialize)]
struct HubPinStore {
    pins: HashMap<String, String>,
}

const LOOPBACK_HUB_PIN_KEY: &str = "https://127.0.0.1";
const HUB_PIN_STORE_FILE: &str = "known_hubs.json";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayHubRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayHubHead {
    id: u64,
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
}

/// The two bounded queues which make an in-progress multipart upload a pipe,
/// not a `Vec` containing the file.
struct HubUpload {
    sender: mpsc::SyncSender<Vec<u8>>,
    response: mpsc::Receiver<Result<reqwest::blocking::Response, String>>,
}

/// State owned by one IPC-backed hub WebSocket. The input and acknowledgement
/// queues are deliberately bounded: neither direction may turn a stopped
/// webview into an unbounded native queue.
struct HubWsRelay {
    input: tokio::sync::mpsc::Sender<Vec<u8>>,
    acknowledgement: tokio::sync::mpsc::Sender<()>,
    acknowledgement_pending: Arc<AtomicBool>,
    close: tokio::sync::mpsc::UnboundedSender<()>,
}

struct HubUploadReader {
    receiver: mpsc::Receiver<Vec<u8>>,
    current: std::io::Cursor<Vec<u8>>,
}

impl Read for HubUploadReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = self.current.read(output)?;
            if read != 0 {
                return Ok(read);
            }
            match self.receiver.recv() {
                Ok(next) => self.current = std::io::Cursor::new(next),
                Err(_) => return Ok(0),
            }
        }
    }
}

enum RuntimeLoadResult {
    Absent,
    Present(RuntimeInfo),
    Unreadable(String),
}

#[derive(Deserialize)]
struct QuitResponseBody {
    message: Option<String>,
    others: Option<usize>,
}

/// A desktop-owned authority.
///
/// This lives in a host-local runtime directory rather than the configurable state
/// directory. `flock` semantics on network-backed state filesystems are too variable
/// to claim single-instance correctness, and state storage is user-configurable.
struct DesktopInstance {
    _lock: ProcessLock,
    endpoint: DesktopRaiseEndpoint,
    raise_listener: Option<DesktopRaiseListener>,
}

impl Drop for DesktopInstance {
    fn drop(&mut self) {
        // Stop and unlink the endpoint before releasing the authority lock. A
        // successor may bind as soon as that lock is free, so reversing this
        // order would briefly leave two listeners reachable on different
        // socket inodes.
        self.raise_listener.take();
    }
}

enum DesktopInstanceStartup {
    Primary(DesktopInstance),
    Secondary,
}

/// The only local endpoint through which a second desktop process may ask the
/// lock holder to raise its main window. The endpoint is deliberately separate
/// from the lock: its presence never decides whether an instance is running.
#[derive(Clone, Debug)]
struct DesktopRaiseEndpoint {
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(windows)]
    pipe_name: String,
}

/// Owns the cleanup signal for the rare single-message listener.
struct DesktopRaiseListener {
    stop: Arc<AtomicBool>,
    #[cfg(unix)]
    path: PathBuf,
}

impl Drop for DesktopRaiseListener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        #[cfg(unix)]
        {
            if let Err(error) = std::fs::remove_file(&self.path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "[lasterm] failed to remove desktop raise socket {}: {error}",
                        self.path.display()
                    );
                }
            }
        }
    }
}

fn desktop_instance_lock_path() -> Result<PathBuf, String> {
    #[cfg(unix)]
    {
        // XDG_RUNTIME_DIR is intentionally not consulted. A graphical launcher
        // exports it while a bare shell often does not, which used to create two
        // different authorities for the same uid. The sticky /tmp parent lets this
        // uid-owned, mode-0700 child remain private and stable across both launches.
        let uid = unsafe { libc::getuid() };
        let xdg_runtime_dir = std::env::var_os("XDG_RUNTIME_DIR");
        let runtime_dir = unix_desktop_runtime_dir_for_environment(uid, xdg_runtime_dir.as_deref());
        prepare_runtime_dir(&runtime_dir)?;
        Ok(runtime_dir.join("desktop-instance.lock"))
    }
    #[cfg(windows)]
    {
        windows_desktop_instance_lock_path(std::env::var_os("LOCALAPPDATA"))
    }
}

#[cfg(unix)]
fn unix_desktop_runtime_dir(uid: u32) -> PathBuf {
    unix_desktop_runtime_dir_for_environment_at(Path::new("/tmp"), uid, None)
}

#[cfg(unix)]
fn unix_desktop_runtime_dir_for_environment(
    uid: u32,
    _xdg_runtime_dir: Option<&std::ffi::OsStr>,
) -> PathBuf {
    unix_desktop_runtime_dir(uid)
}

#[cfg(unix)]
fn unix_desktop_runtime_dir_for_environment_at(
    base: &Path,
    uid: u32,
    _xdg_runtime_dir: Option<&std::ffi::OsStr>,
) -> PathBuf {
    base.join(format!("lasterm-{uid}"))
}

#[cfg(unix)]
fn desktop_raise_endpoint(lock_path: &Path) -> Result<DesktopRaiseEndpoint, String> {
    let runtime_dir = lock_path.parent().ok_or_else(|| {
        format!(
            "cannot establish desktop raise endpoint for lock without parent: {}",
            lock_path.display()
        )
    })?;
    Ok(DesktopRaiseEndpoint {
        path: runtime_dir.join("desktop-raise.sock"),
    })
}

#[cfg(windows)]
fn desktop_raise_endpoint(_: &Path) -> Result<DesktopRaiseEndpoint, String> {
    // Named pipes are machine-global. Match the agent daemon's user-scoped
    // naming, while the owner-only DACL below is the actual access boundary.
    let username = std::env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    Ok(DesktopRaiseEndpoint {
        pipe_name: format!(r"\\.\pipe\lasterm-desktop-raise-{username}"),
    })
}

#[cfg(any(target_os = "windows", test))]
fn windows_desktop_instance_lock_path(
    local_app_data: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    let local_app_data = local_app_data
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            "cannot establish the desktop single-instance lock: LOCALAPPDATA is absent or empty"
                .to_string()
        })?;

    let local_app_data_path = PathBuf::from(&local_app_data);
    if is_windows_unc_path(&local_app_data_path) {
        return Err(format!(
            "refusing desktop runtime directory {}: LOCALAPPDATA must be host-local, not UNC",
            local_app_data_path.display()
        ));
    }

    // LOCALAPPDATA is the non-roaming application-data location, so this runtime
    // authority remains host-local. It is under the user's profile, whose default
    // ACL already excludes other users; a full ACL audit is intentionally out of
    // scope here. get_state_dir() already uses LOCALAPPDATA for Windows state, so
    // this does not introduce a new environment convention.
    let runtime_dir = local_app_data_path.join("lasterm").join("runtime");
    prepare_windows_runtime_dir(&runtime_dir)?;
    Ok(runtime_dir.join("desktop-instance.lock"))
}

#[cfg(any(target_os = "windows", test))]
fn is_windows_unc_path(path: &Path) -> bool {
    let path = path.as_os_str().to_string_lossy();
    path.starts_with(r"\\") || path.starts_with("//")
}

#[cfg(any(target_os = "windows", test))]
fn prepare_windows_runtime_dir(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "refusing desktop runtime directory {}: it is not absolute",
            path.display()
        ));
    }

    std::fs::create_dir_all(path).map_err(|error| {
        format!(
            "cannot create desktop runtime directory {}: {error}",
            path.display()
        )
    })?;
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "refusing desktop runtime directory {}: {error}",
            path.display()
        )
    })?;
    validate_windows_runtime_dir(
        path,
        &metadata,
        windows_metadata_is_reparse_point(&metadata),
    )
}

#[cfg(any(target_os = "windows", test))]
/// Windows validation is deliberately narrower than the Unix branch's, and the
/// difference is a decision rather than an omission.
///
/// On Unix the runtime directory can sit under `/tmp`, which every user can write,
/// so ownership and mode have to be checked: the location proves nothing. On Windows
/// it sits under `%LOCALAPPDATA%`, inside the user's profile, whose ACL already
/// excludes other users — **the location is the property**, and re-deriving it from
/// an ACL audit would restate what the profile already guarantees while adding a
/// dependency and a second thing to keep correct.
///
/// So no ACL is read here, and no ancestor chain is walked. What is checked is that
/// the final component is a real directory rather than a reparse point, because a
/// junction is the one way a path under the profile can lead somewhere else.
///
/// The limit that leaves: an ancestor replaced between this check and the lock's
/// open would go unnoticed. Closing it needs a descent that opens each component and
/// re-verifies by handle, which the risk here does not justify.
fn validate_windows_runtime_dir(
    path: &Path,
    metadata: &std::fs::Metadata,
    is_reparse_point: bool,
) -> Result<(), String> {
    if is_reparse_point || metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "refusing desktop runtime directory {}: it is not a real directory",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(all(not(target_os = "windows"), test))]
fn windows_metadata_is_reparse_point(_: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn prepare_runtime_dir(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "refusing desktop runtime directory {}: it is not absolute",
            path.display()
        ));
    }

    match std::fs::symlink_metadata(path) {
        Ok(metadata) => validate_runtime_dir(path, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .recursive(true)
                // This is deliberately part of creation. A later chmod could follow
                // a symlink substituted after the create and change another path.
                .mode(0o700)
                .create(path)
                .map_err(|error| {
                    format!(
                        "cannot create desktop runtime directory {}: {error}",
                        path.display()
                    )
                })?;
            let metadata = std::fs::symlink_metadata(path).map_err(|error| {
                format!(
                    "refusing desktop runtime directory {}: {error}",
                    path.display()
                )
            })?;
            validate_runtime_dir(path, &metadata)
        }
        Err(error) => Err(format!(
            "refusing desktop runtime directory {}: {error}",
            path.display()
        )),
    }
}

#[cfg(unix)]
fn validate_runtime_dir(path: &Path, metadata: &std::fs::Metadata) -> Result<(), String> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "refusing desktop runtime directory {}: it is not a real directory",
            path.display()
        ));
    }
    let uid = unsafe { libc::getuid() };
    if metadata.uid() != uid {
        return Err(format!(
            "refusing desktop runtime directory {}: it is not owned by the current user",
            path.display()
        ));
    }
    if metadata.mode() & 0o022 != 0 {
        return Err(format!(
            "refusing desktop runtime directory {}: group or other may write it",
            path.display()
        ));
    }
    Ok(())
}

fn acquire_desktop_instance() -> Result<DesktopInstanceStartup, String> {
    let lock_path = desktop_instance_lock_path()?;
    let endpoint = desktop_raise_endpoint(&lock_path)?;
    acquire_desktop_instance_at(&lock_path, &endpoint)
}

fn acquire_desktop_instance_at(
    lock_path: &Path,
    endpoint: &DesktopRaiseEndpoint,
) -> Result<DesktopInstanceStartup, String> {
    acquire_desktop_instance_at_with_raise(lock_path, endpoint, request_desktop_raise)
}

fn acquire_desktop_instance_at_with_raise<R>(
    lock_path: &Path,
    endpoint: &DesktopRaiseEndpoint,
    request_raise: R,
) -> Result<DesktopInstanceStartup, String>
where
    R: Fn(&DesktopRaiseEndpoint) -> RaiseRequestResult,
{
    match ProcessLock::try_acquire(lock_path).map_err(|error| {
        format!(
            "cannot acquire desktop lock {}: {error}",
            lock_path.display()
        )
    })? {
        Some(lock) => Ok(DesktopInstanceStartup::Primary(DesktopInstance {
            _lock: lock,
            endpoint: endpoint.clone(),
            raise_listener: None,
        })),
        None => {
            let deadline = Instant::now() + INSTANCE_HANDOFF_TIMEOUT;
            loop {
                // The primary may still be in setup and deliberately has no
                // listener yet. Keep retrying the endpoint for the entire
                // handoff budget rather than treating the first refusal as its
                // final state.
                match request_raise(endpoint) {
                    RaiseRequestResult::Raised => return Ok(DesktopInstanceStartup::Secondary),
                    RaiseRequestResult::Failed => {
                        return Err(
                            "The running Lasterm instance could not show its window.".to_string()
                        )
                    }
                    RaiseRequestResult::Unanswered => {}
                }
                if let Some(lock) = ProcessLock::try_acquire(lock_path).map_err(|error| {
                    format!(
                        "cannot acquire desktop lock {}: {error}",
                        lock_path.display()
                    )
                })? {
                    return Ok(DesktopInstanceStartup::Primary(DesktopInstance {
                        _lock: lock,
                        endpoint: endpoint.clone(),
                        raise_listener: None,
                    }));
                }
                if Instant::now() >= deadline {
                    return Err(
                        "A running Lasterm instance did not answer the request to show its window."
                            .to_string(),
                    );
                }
                std::thread::sleep(INSTANCE_ACQUIRE_RETRY_INTERVAL);
            }
        }
    }
}

enum RaiseRequestResult {
    Raised,
    Failed,
    Unanswered,
}

/// Dispatch UI work to the Tauri main thread and wait for that work, rather
/// than merely waiting for it to be queued. This is the acknowledgement P2
/// needs: success reaches the peer only after both native calls completed.
fn run_after_main_thread_action<S, A>(schedule: S, action: A) -> Result<(), String>
where
    S: FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), String>,
    A: FnOnce() -> Result<(), String> + Send + 'static,
{
    let (completed_tx, completed_rx) = mpsc::sync_channel(1);
    schedule(Box::new(move || {
        let _ = completed_tx.send(action());
    }))?;
    completed_rx
        .recv_timeout(INSTANCE_RAISE_TIMEOUT)
        .map_err(|error| format!("the main-thread window raise did not complete: {error}"))?
}

trait WindowRaiseTarget {
    fn label(&self) -> &str;
    fn unminimize(&self) -> Result<(), String>;
    fn show(&self) -> Result<(), String>;
    fn focus(&self) -> Result<(), String>;
}

/// The outcomes of presenting the main window at startup.
///
/// A failure to find or show the window leaves the application without any
/// usable UI and is fatal. Focus is helpful but not required to use a shown
/// window, so its error is retained for reporting while startup continues.
#[derive(Debug, PartialEq, Eq)]
enum MainWindowStartupOutcome {
    Fatal(String),
    Shown { focus_error: Option<String> },
}

trait WindowStartupTarget {
    fn show(&self) -> Result<(), String>;
    fn focus(&self) -> Result<(), String>;
}

impl<R: tauri::Runtime> WindowStartupTarget for tauri::WebviewWindow<R> {
    fn show(&self) -> Result<(), String> {
        self.show().map_err(|error| error.to_string())
    }

    fn focus(&self) -> Result<(), String> {
        self.set_focus().map_err(|error| error.to_string())
    }
}

fn present_main_window_at_startup(
    window: Option<&impl WindowStartupTarget>,
) -> MainWindowStartupOutcome {
    let Some(window) = window else {
        return MainWindowStartupOutcome::Fatal("The main window is unavailable.".to_string());
    };

    if let Err(error) = window.show() {
        return MainWindowStartupOutcome::Fatal(format!(
            "The main window could not be shown: {error}"
        ));
    }

    MainWindowStartupOutcome::Shown {
        focus_error: window.focus().err(),
    }
}

impl<R: tauri::Runtime> WindowRaiseTarget for tauri::WebviewWindow<R> {
    fn label(&self) -> &str {
        self.label()
    }

    fn unminimize(&self) -> Result<(), String> {
        self.unminimize().map_err(|error| error.to_string())
    }

    fn show(&self) -> Result<(), String> {
        self.show().map_err(|error| error.to_string())
    }

    fn focus(&self) -> Result<(), String> {
        self.set_focus().map_err(|error| error.to_string())
    }
}

fn run_window_raise_actions(window: &impl WindowRaiseTarget) -> Result<(), String> {
    let label = window.label();
    let mut show_error = None;
    for (operation, result) in [
        ("unminimize", window.unminimize()),
        ("show", window.show()),
        ("focus", window.focus()),
    ] {
        if let Err(error) = result {
            eprintln!("[lasterm] WARN: cannot {operation} window {label}: {error}");
            if operation == "show" {
                show_error = Some(error);
            }
        }
    }

    show_error.map_or(Ok(()), |error| {
        Err(format!("cannot show window {label}: {error}"))
    })
}

fn raise_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let main_thread_app = app.clone();
    run_after_main_thread_action(
        move |action| {
            app.run_on_main_thread(action)
                .map_err(|error| format!("cannot schedule the main-window raise: {error}"))
        },
        move || {
            let window = main_thread_app
                .get_webview_window("main")
                .ok_or_else(|| "the main window is unavailable".to_string())?;
            run_window_raise_actions(&window)
        },
    )
}

fn read_delimited_raise_message<S: Read>(stream: &mut S) -> std::io::Result<Option<Vec<u8>>> {
    let mut message = Vec::with_capacity(INSTANCE_RAISE_MAX_BYTES);
    let mut byte = [0_u8; 1];
    while message.len() < INSTANCE_RAISE_MAX_BYTES {
        match stream.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => {
                message.push(byte[0]);
                if byte[0] == b'\n' {
                    return Ok(Some(message));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn handle_desktop_raise_connection<S, Raise>(stream: &mut S, raise: Raise)
where
    S: Read + Write,
    Raise: FnOnce() -> Result<(), String>,
{
    let Ok(Some(request)) = read_delimited_raise_message(stream) else {
        return;
    };
    if request != INSTANCE_RAISE_REQUEST {
        return;
    }
    let reply = match raise() {
        Ok(()) => INSTANCE_RAISE_SUCCESS,
        Err(error) => {
            eprintln!("[lasterm] desktop raise failed: {error}");
            INSTANCE_RAISE_FAILURE
        }
    };
    let _ = stream.write_all(reply);
}

#[cfg(unix)]
fn request_desktop_raise(endpoint: &DesktopRaiseEndpoint) -> RaiseRequestResult {
    let mut stream = match UnixStream::connect(&endpoint.path) {
        Ok(stream) => stream,
        Err(_) => return RaiseRequestResult::Unanswered,
    };
    if stream
        .set_read_timeout(Some(INSTANCE_RAISE_TIMEOUT))
        .is_err()
        || stream
            .set_write_timeout(Some(INSTANCE_RAISE_TIMEOUT))
            .is_err()
        || stream.write_all(INSTANCE_RAISE_REQUEST).is_err()
        || stream.shutdown(std::net::Shutdown::Write).is_err()
    {
        return RaiseRequestResult::Unanswered;
    }
    match read_delimited_raise_message(&mut stream) {
        Ok(Some(reply)) if reply == INSTANCE_RAISE_SUCCESS => RaiseRequestResult::Raised,
        Ok(Some(reply)) if reply == INSTANCE_RAISE_FAILURE => RaiseRequestResult::Failed,
        _ => RaiseRequestResult::Unanswered,
    }
}

#[cfg(unix)]
fn bind_desktop_raise_socket(path: &Path) -> Result<UnixListener, String> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "cannot remove stale desktop raise socket {}: {error}",
                path.display()
            ))
        }
    }
    UnixListener::bind(path).map_err(|error| {
        format!(
            "cannot bind desktop raise socket {}: {error}",
            path.display()
        )
    })
}

#[cfg(unix)]
fn start_desktop_raise_listener(
    app: tauri::AppHandle,
    endpoint: &DesktopRaiseEndpoint,
) -> Result<DesktopRaiseListener, String> {
    let listener = bind_desktop_raise_socket(&endpoint.path)?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("cannot configure desktop raise listener: {error}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    std::thread::spawn({
        let endpoint = endpoint.clone();
        move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(INSTANCE_RAISE_TIMEOUT));
                        let _ = stream.set_write_timeout(Some(INSTANCE_RAISE_TIMEOUT));
                        let raise_app = app.clone();
                        handle_desktop_raise_connection(&mut stream, move || {
                            raise_main_window(raise_app)
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    Err(error) => {
                        eprintln!(
                            "[lasterm] desktop raise listener {} stopped: {error}",
                            endpoint.path.display()
                        );
                        break;
                    }
                }
            }
        }
    });
    Ok(DesktopRaiseListener {
        stop,
        path: endpoint.path.clone(),
    })
}

#[cfg(windows)]
fn create_desktop_raise_pipe(name: &str) -> std::io::Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{LocalFree, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    // Only the creating user may connect. The pipe namespace is global, so a
    // user-scoped name alone would not be a sufficient boundary.
    let sddl: Vec<u16> = "D:(A;;GA;;;OW)\0".encode_utf16().collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0.cast()) };
            }
        }
    }
    let _descriptor = Descriptor(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            INSTANCE_RAISE_MAX_BYTES as u32,
            INSTANCE_RAISE_MAX_BYTES as u32,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
struct WindowsPipeReader<'a> {
    stream: &'a std::fs::File,
    deadline: Instant,
}

#[cfg(windows)]
impl Read for WindowsPipeReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, std::io::Error> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;

        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let mut available = 0;
            let ok = unsafe {
                PeekNamedPipe(
                    self.stream.as_raw_handle(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    &mut available,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            if available > 0 {
                let mut stream = self.stream;
                return stream.read(&mut buffer[..1]);
            }
            if Instant::now() >= self.deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "timed out waiting for a desktop raise message",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
impl Write for WindowsPipeReader<'_> {
    fn write(&mut self, buffer: &[u8]) -> Result<usize, std::io::Error> {
        let mut stream = self.stream;
        stream.write(buffer)
    }

    fn flush(&mut self) -> Result<(), std::io::Error> {
        let mut stream = self.stream;
        stream.flush()
    }
}

#[cfg(windows)]
fn read_windows_pipe_message(stream: &std::fs::File) -> Result<Option<Vec<u8>>, std::io::Error> {
    let mut reader = WindowsPipeReader {
        stream,
        deadline: Instant::now() + INSTANCE_RAISE_TIMEOUT,
    };
    read_delimited_raise_message(&mut reader)
}

#[cfg(windows)]
fn request_desktop_raise(endpoint: &DesktopRaiseEndpoint) -> RaiseRequestResult {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FlushFileBuffers, OPEN_EXISTING};
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    let name: Vec<u16> = endpoint.pipe_name.encode_utf16().chain(Some(0)).collect();
    if unsafe { WaitNamedPipeW(name.as_ptr(), INSTANCE_RAISE_TIMEOUT.as_millis() as u32) } == 0 {
        return RaiseRequestResult::Unanswered;
    }
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return RaiseRequestResult::Unanswered;
    }
    let mut stream = unsafe { std::fs::File::from_raw_handle(handle) };
    if stream.write_all(INSTANCE_RAISE_REQUEST).is_err()
        || unsafe { FlushFileBuffers(std::os::windows::io::AsRawHandle::as_raw_handle(&stream)) }
            == 0
    {
        return RaiseRequestResult::Unanswered;
    }
    match read_windows_pipe_message(&stream) {
        Ok(Some(reply)) if reply == INSTANCE_RAISE_SUCCESS => RaiseRequestResult::Raised,
        Ok(Some(reply)) if reply == INSTANCE_RAISE_FAILURE => RaiseRequestResult::Failed,
        _ => RaiseRequestResult::Unanswered,
    }
}

#[cfg(windows)]
fn start_desktop_raise_listener(
    app: tauri::AppHandle,
    endpoint: &DesktopRaiseEndpoint,
) -> Result<DesktopRaiseListener, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let pipe_name = endpoint.pipe_name.clone();
    std::thread::spawn(move || {
        while !thread_stop.load(Ordering::Relaxed) {
            let stream = match create_desktop_raise_pipe(&pipe_name) {
                Ok(stream) => stream,
                Err(error) => {
                    eprintln!("[lasterm] cannot create desktop raise pipe {pipe_name}: {error}");
                    break;
                }
            };
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED;
            use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
            let connected =
                unsafe { ConnectNamedPipe(stream.as_raw_handle(), std::ptr::null_mut()) };
            if connected == 0
                && std::io::Error::last_os_error().raw_os_error()
                    != Some(ERROR_PIPE_CONNECTED as i32)
            {
                continue;
            }
            let raise_app = app.clone();
            std::thread::spawn(move || {
                let mut stream = WindowsPipeReader {
                    stream: &stream,
                    deadline: Instant::now() + INSTANCE_RAISE_TIMEOUT,
                };
                handle_desktop_raise_connection(&mut stream, move || raise_main_window(raise_app));
            });
        }
    });
    Ok(DesktopRaiseListener { stop })
}

#[cfg(dev)]
fn show_desktop_instance_failure_then_exit(app: tauri::AppHandle, message: String) {
    eprintln!("[lasterm] startup stopped: {message}");
    app.dialog()
        .message(message)
        .title("Lasterm cannot start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.exit(1));
}

#[cfg(not(dev))]
fn show_instance_failure_then_exit(app: tauri::AppHandle, message: String) {
    show_startup_failure_then_exit(app, message);
}

#[cfg(dev)]
fn show_instance_failure_then_exit(app: tauri::AppHandle, message: String) {
    show_desktop_instance_failure_then_exit(app, message);
}

#[derive(Clone)]
struct HubQuitTarget {
    pid: u32,
    instance_id: String,
}

/// A quit is longer lived than the gesture which began it. Keeping its identity
/// here prevents a cancelled presentation or an old network callback from
/// completing a newer (or no longer active) attempt.
#[derive(Debug, PartialEq, Eq)]
enum QuitAttemptState {
    Requested { force: bool },
    WaitingForNativeConsent,
    ConfirmingHubGone,
}

#[derive(Debug, PartialEq, Eq)]
struct QuitAttempt {
    id: u64,
    state: QuitAttemptState,
}

#[derive(Default)]
struct QuitCoordinator {
    next_id: u64,
    active: Option<QuitAttempt>,
}

enum QuitStart {
    Started(u64),
    InProgress,
}

enum QuitRequestResult {
    Committed {
        target: HubQuitTarget,
        diagnostic: Option<String>,
    },
    Conflict(Option<usize>),
    Unobserved(HubQuitTarget),
    Failed(String),
}

enum QuitAction {
    AskNative {
        others: Option<usize>,
    },
    SendForced {
        attempt_id: u64,
    },
    Observe {
        attempt_id: u64,
        target: HubQuitTarget,
        diagnostic: Option<String>,
    },
    Exit,
    ExitWithDiagnostic(String),
    Failed(String),
    Ignore,
}

impl QuitCoordinator {
    fn begin(&mut self) -> QuitStart {
        if self.active.is_some() {
            return QuitStart::InProgress;
        }
        self.next_id += 1;
        let id = self.next_id;
        self.active = Some(QuitAttempt {
            id,
            state: QuitAttemptState::Requested { force: false },
        });
        QuitStart::Started(id)
    }

    fn request_finished(&mut self, id: u64, force: bool, result: QuitRequestResult) -> QuitAction {
        let Some(attempt) = self.active.as_mut() else {
            return QuitAction::Ignore;
        };
        if attempt.id != id
            || !matches!(attempt.state, QuitAttemptState::Requested { force: expected } if expected == force)
        {
            return QuitAction::Ignore;
        }

        match result {
            QuitRequestResult::Conflict(others) if !force => {
                attempt.state = QuitAttemptState::WaitingForNativeConsent;
                QuitAction::AskNative { others }
            }
            QuitRequestResult::Conflict(_) => {
                self.active = None;
                QuitAction::Failed("Quit was refused again; nothing was stopped.".to_string())
            }
            QuitRequestResult::Committed { target, diagnostic } => {
                attempt.state = QuitAttemptState::ConfirmingHubGone;
                QuitAction::Observe {
                    attempt_id: id,
                    target,
                    diagnostic,
                }
            }
            QuitRequestResult::Unobserved(target) => {
                attempt.state = QuitAttemptState::ConfirmingHubGone;
                QuitAction::Observe {
                    attempt_id: id,
                    target,
                    diagnostic: None,
                }
            }
            QuitRequestResult::Failed(message) => {
                self.active = None;
                QuitAction::Failed(message)
            }
        }
    }

    fn resolve_native_consent(&mut self, confirmed: bool) -> QuitAction {
        let Some(attempt) = self.active.as_mut() else {
            return QuitAction::Ignore;
        };
        if !matches!(attempt.state, QuitAttemptState::WaitingForNativeConsent) {
            return QuitAction::Ignore;
        }
        if !confirmed {
            // A refusal ends this attempt. Any callback which carries its id is
            // stale from this point on and therefore cannot exit the app.
            self.active = None;
            return QuitAction::Ignore;
        }
        attempt.state = QuitAttemptState::Requested { force: true };
        QuitAction::SendForced {
            attempt_id: attempt.id,
        }
    }

    fn observation_finished(
        &mut self,
        id: u64,
        observed: Result<(), String>,
        diagnostic: Option<String>,
    ) -> QuitAction {
        let Some(attempt) = self.active.as_ref() else {
            return QuitAction::Ignore;
        };
        if attempt.id != id || attempt.state != QuitAttemptState::ConfirmingHubGone {
            return QuitAction::Ignore;
        }
        self.active = None;
        match observed {
            Ok(()) => diagnostic.map_or(QuitAction::Exit, QuitAction::ExitWithDiagnostic),
            Err(message) => QuitAction::Failed(message),
        }
    }
}

fn quit_coordinator() -> &'static Mutex<QuitCoordinator> {
    QUIT_COORDINATOR.get_or_init(|| Mutex::new(QuitCoordinator::default()))
}

/// A native close is never owned by the webview. The webview may render the
/// choice, but acknowledgement and expiry are native so a dead renderer cannot
/// permanently hold the close gesture.
#[derive(Debug, PartialEq, Eq)]
enum WindowCloseState {
    WaitingForPresentation,
    WaitingForAnswer,
}

#[derive(Default)]
struct WindowCloseCoordinator {
    next_id: u64,
    active: Option<(u64, WindowCloseState)>,
}

enum WindowCloseStart {
    Started(u64),
    InProgress,
}

impl WindowCloseCoordinator {
    fn begin(&mut self) -> WindowCloseStart {
        if self.active.is_some() {
            return WindowCloseStart::InProgress;
        }
        self.next_id += 1;
        let id = self.next_id;
        self.active = Some((id, WindowCloseState::WaitingForPresentation));
        WindowCloseStart::Started(id)
    }

    fn acknowledged(&mut self, id: u64) -> bool {
        let Some((active_id, state)) = self.active.as_mut() else {
            return false;
        };
        if *active_id != id || *state != WindowCloseState::WaitingForPresentation {
            return false;
        }
        *state = WindowCloseState::WaitingForAnswer;
        true
    }

    /// Returns true only when the presentation was never acknowledged, so the
    /// native fallback must be shown. An unanswered acknowledged presentation
    /// simply expires, making a later gesture startable again.
    fn timed_out(&mut self, id: u64) -> bool {
        let Some((active_id, state)) = self.active.as_ref() else {
            return false;
        };
        if *active_id != id {
            return false;
        }
        let unacknowledged = *state == WindowCloseState::WaitingForPresentation;
        if unacknowledged {
            self.active = None;
        }
        unacknowledged
    }

    fn answer_timed_out(&mut self, id: u64) -> bool {
        let Some((active_id, state)) = self.active.as_ref() else {
            return false;
        };
        if *active_id != id || *state != WindowCloseState::WaitingForAnswer {
            return false;
        }
        self.active = None;
        true
    }

    fn answer(&mut self, id: u64) -> bool {
        let Some((active_id, state)) = self.active.as_ref() else {
            return false;
        };
        if *active_id != id || *state != WindowCloseState::WaitingForAnswer {
            return false;
        }
        self.active = None;
        true
    }
}

fn window_close_coordinator() -> &'static Mutex<WindowCloseCoordinator> {
    WINDOW_CLOSE_COORDINATOR.get_or_init(|| Mutex::new(WindowCloseCoordinator::default()))
}

#[derive(Clone, Serialize)]
struct WindowCloseRequest {
    #[serde(rename = "attemptId")]
    attempt_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WindowCloseChoice {
    Quit,
    Tray,
}

/// Resolves the per-user Lasterm configuration directory.
fn lasterm_config_dir() -> Option<PathBuf> {
    let config_dir = {
        #[cfg(target_os = "windows")]
        {
            std::env::var("APPDATA")
                .ok()
                .map(std::path::PathBuf::from)
                .or_else(dirs::config_dir)?
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::var("XDG_CONFIG_HOME")
                .ok()
                .map(std::path::PathBuf::from)
                .or_else(|| dirs::home_dir().map(|h| h.join(".config")))?
        }
    };

    Some(config_dir.join("lasterm"))
}

/// Resolves the hub config directory and reads the auth token from auth.json.
/// Returns `Some(token)` only if the token is a valid 64-char lowercase hex string.
fn read_hub_auth_token() -> Option<String> {
    let config_dir = lasterm_config_dir()?;

    let auth_path = config_dir.join("auth.json");
    eprintln!("[lasterm] checking auth.json at: {}", auth_path.display());
    let contents = std::fs::read_to_string(&auth_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let token = parsed.get("token")?.as_str()?.to_string();

    // Only inject if it looks like a valid 64-char lowercase hex string
    let valid = token.len() == 64 && token.chars().all(|c| matches!(c, 'a'..='f' | '0'..='9'));
    if valid {
        Some(token)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CloseBehavior {
    Ask,
    #[serde(alias = "tray")]
    Hide,
    Quit,
}

#[derive(Deserialize, Serialize)]
struct CloseBehaviorConfig {
    #[serde(rename = "closeBehavior")]
    close_behavior: CloseBehavior,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseBehaviorConfigState {
    Missing,
    Stored(CloseBehavior),
    Unreadable,
}

fn close_behavior_command_result(state: CloseBehaviorConfigState) -> Result<CloseBehavior, String> {
    match state {
        CloseBehaviorConfigState::Stored(behavior) => Ok(behavior),
        CloseBehaviorConfigState::Missing => Ok(CloseBehavior::Ask),
        CloseBehaviorConfigState::Unreadable => Err("failed to read close preference".to_string()),
    }
}

fn close_behavior_config_path() -> Option<PathBuf> {
    lasterm_config_dir().map(|config_dir| config_dir.join("close-behavior.json"))
}

fn read_close_behavior_from_path(path: &std::path::Path) -> CloseBehaviorConfigState {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CloseBehaviorConfigState::Missing;
        }
        Err(_) => return CloseBehaviorConfigState::Unreadable,
    };

    match serde_json::from_str::<CloseBehaviorConfig>(&contents) {
        Ok(config) => CloseBehaviorConfigState::Stored(config.close_behavior),
        Err(_) => CloseBehaviorConfigState::Unreadable,
    }
}

fn read_close_behavior() -> CloseBehaviorConfigState {
    let Some(path) = close_behavior_config_path() else {
        return CloseBehaviorConfigState::Unreadable;
    };
    read_close_behavior_from_path(&path)
}

fn write_close_behavior_to_path(
    path: &std::path::Path,
    behavior: CloseBehavior,
) -> Result<(), String> {
    write_close_behavior_to_path_with_replace(path, behavior, |source, target| {
        std::fs::rename(source, target)
    })
}

fn write_close_behavior_to_path_with_replace<F>(
    path: &std::path::Path,
    behavior: CloseBehavior,
    replace: F,
) -> Result<(), String>
where
    F: FnOnce(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "close preference path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create close preference directory: {error}"))?;
    let contents = serde_json::to_string(&CloseBehaviorConfig {
        close_behavior: behavior,
    })
    .map_err(|error| format!("failed to serialize close preference: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "close preference path has no file name".to_string())?;

    let (mut temp_file, temp_path) = (0..32)
        .find_map(|_| {
            let suffix = CLOSE_BEHAVIOR_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(
                ".{file_name}.{}.{}.tmp",
                std::process::id(),
                suffix
            ));
            match std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((file, candidate))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!(
                    "failed to create close preference temporary file: {error}"
                ))),
            }
        })
        .ok_or_else(|| "failed to allocate close preference temporary file".to_string())??;

    let write_result = (|| -> Result<(), String> {
        temp_file
            .write_all(contents.as_bytes())
            .map_err(|error| format!("failed to write close preference: {error}"))?;
        #[cfg(unix)]
        temp_file
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to set close preference permissions: {error}"))?;
        temp_file
            .sync_all()
            .map_err(|error| format!("failed to flush close preference: {error}"))
    })();
    drop(temp_file);

    let result = write_result.and_then(|()| {
        replace(&temp_path, path)
            .map_err(|error| format!("failed to replace close preference: {error}"))
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

#[tauri::command]
fn get_close_behavior() -> Result<CloseBehavior, String> {
    close_behavior_command_result(read_close_behavior())
}

#[tauri::command]
fn set_close_behavior(behavior: CloseBehavior) -> Result<(), String> {
    let path = close_behavior_config_path()
        .ok_or_else(|| "failed to resolve close preference directory".to_string())?;
    write_close_behavior_to_path(&path, behavior)
}

/// Resolves the lasterm state directory:
/// - Linux/macOS: $XDG_STATE_HOME/lasterm or ~/.local/state/lasterm
/// - Windows: %LOCALAPPDATA%\lasterm
fn get_state_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| std::path::PathBuf::from(p).join("lasterm"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("XDG_STATE_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
            .map(|p| p.join("lasterm"))
    }
}

/// Mirrors the hub CLI's three-way runtime observation: absence, a usable
/// record, and every failure to read or parse it are deliberately distinct.
fn load_runtime_info() -> RuntimeLoadResult {
    let Some(state_dir) = get_state_dir() else {
        return RuntimeLoadResult::Unreadable(
            "failed to resolve the hub state directory".to_string(),
        );
    };
    load_runtime_info_at(&state_dir.join("runtime.json"))
}

/// `runtime.json` is discovery, but it can authorise a first pin in the dev /
/// externally launched path. Read it only through this owner-and-mode checked
/// open, never through a path-following convenience read.
fn load_runtime_info_at(runtime_path: &Path) -> RuntimeLoadResult {
    let contents = match read_protected_file(runtime_path) {
        Ok(Some(contents)) => contents,
        Ok(None) => return RuntimeLoadResult::Absent,
        Err(error) => return RuntimeLoadResult::Unreadable(error),
    };
    match serde_json::from_str(&contents) {
        Ok(runtime) => RuntimeLoadResult::Present(runtime),
        Err(error) => RuntimeLoadResult::Unreadable(error.to_string()),
    }
}

#[cfg(unix)]
fn read_protected_file(path: &Path) -> Result<Option<String>, String> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let parent = path
        .parent()
        .ok_or_else(|| format!("refusing protected file {} without a parent", path.display()))?;
    refuse_symlinked_ancestors(parent)?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        format!(
            "refusing protected file {} because its parent {} cannot be inspected: {error}",
            path.display(),
            parent.display()
        )
    })?;
    validate_runtime_dir(parent, &parent_metadata)?;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|error| format!("refusing protected file path with an interior NUL: {error}"))?;
    // O_NOFOLLOW rejects a final symlink before it can change what this read
    // authorises. The file descriptor, not a second pathname lookup, is then
    // inspected and read.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(format!("refusing protected file: {error}"));
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file
        .metadata()
        .map_err(|error| format!("refusing protected file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("refusing protected path that is not a regular file".to_string());
    }
    let current_user = unsafe { libc::geteuid() };
    if metadata.uid() != current_user {
        return Err("protected file is not owned by the current user".to_string());
    }
    if metadata.mode() & 0o077 != 0 {
        return Err("protected file grants group or other permissions".to_string());
    }
    let mut contents = String::new();
    file.read_to_string(&mut contents)
        .map_err(|error| format!("cannot read protected file: {error}"))?;
    Ok(Some(contents))
}

#[cfg(unix)]
fn refuse_symlinked_ancestors(path: &Path) -> Result<(), String> {
    for component in path.ancestors() {
        let metadata = std::fs::symlink_metadata(component).map_err(|error| {
            format!(
                "refusing protected file path because {} cannot be inspected: {error}",
                component.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "refusing protected file path because {} is a symlink",
                component.display()
            ));
        }
    }
    Ok(())
}

fn hub_pin_store_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        // Keep the authority under its own 0700 leaf, not beside hub.log: the
        // log directory is intentionally ordinary application storage.
        .map(|path| path.join("lasterm").join("identity").join(HUB_PIN_STORE_FILE))
        .ok_or_else(|| "failed to resolve the desktop pin-store directory".to_string())
}

/// SSH-known-hosts shape: the stable identity names one entry, its first public
/// key is recorded, and a different later key is a refusal -- never an update.
///
/// This is called only after the first-use TLS proof. Existing pins can be
/// matched without a connection; an absent pin must not reach this function
/// until `prove_announced_hub_key` has completed.
fn record_or_match_hub_pin_after_proof_at(
    path: &Path,
    identity: &str,
    presented_spki: &[u8],
) -> Result<Vec<u8>, String> {
    use base64::Engine;

    if presented_spki.is_empty() {
        return Err("refusing an empty hub TLS SPKI".to_string());
    }
    let mut store = load_hub_pin_store(path)?;
    if let Some(encoded) = store.pins.get(identity) {
        let stored = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("desktop hub pin store contains invalid SPKI: {error}"))?;
        if stored.is_empty() {
            return Err("desktop hub pin store contains an empty SPKI".to_string());
        }
        if stored != presented_spki {
            return Err(format!(
                "Hub identity changed for {identity}; refusing to send credentials. Stop the hub, verify its replacement, then run `lasterm-desktop --reset-hub-pin` and start Lasterm again."
            ));
        }
        return Ok(stored);
    }

    store.pins.insert(
        identity.to_string(),
        base64::engine::general_purpose::STANDARD.encode(presented_spki),
    );
    write_hub_pin_store(path, &store)?;
    Ok(presented_spki.to_vec())
}

/// Reads an existing pin without creating the store directory. The absence of
/// the directory is normal on first use, and must stay non-durable until the
/// announced peer has completed its TLS proof.
fn load_existing_hub_pin_store(path: &Path) -> Result<Option<HubPinStore>, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("pin store path {} has no parent", path.display()))?;
    match std::fs::symlink_metadata(parent) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cannot inspect desktop pin-store directory {}: {error}",
                parent.display()
            ));
        }
        Ok(_) => {}
    }
    match read_protected_file(path)? {
        Some(contents) => serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| format!("desktop hub pin store is invalid: {error}")),
        None => Ok(None),
    }
}

fn existing_hub_pin_at(path: &Path, identity: &str) -> Result<Option<Vec<u8>>, String> {
    use base64::Engine;

    let Some(store) = load_existing_hub_pin_store(path)? else {
        return Ok(None);
    };
    let Some(encoded) = store.pins.get(identity) else {
        return Ok(None);
    };
    let stored = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("desktop hub pin store contains invalid SPKI: {error}"))?;
    if stored.is_empty() {
        return Err("desktop hub pin store contains an empty SPKI".to_string());
    }
    Ok(Some(stored))
}

fn match_existing_hub_pin(stored_spki: Vec<u8>, presented_spki: &[u8]) -> Result<Vec<u8>, String> {
    if stored_spki != presented_spki {
        return Err(format!(
            "Hub identity changed for {LOOPBACK_HUB_PIN_KEY}; refusing to send credentials. Stop the hub, verify its replacement, then run `lasterm-desktop --reset-hub-pin` and start Lasterm again."
        ));
    }
    Ok(stored_spki)
}

fn load_hub_pin_store(path: &Path) -> Result<HubPinStore, String> {
    prepare_hub_pin_store_dir(
        path.parent()
            .ok_or_else(|| format!("pin store path {} has no parent", path.display()))?,
    )?;
    match read_protected_file(path)? {
        Some(contents) => serde_json::from_str(&contents)
            .map_err(|error| format!("desktop hub pin store is invalid: {error}")),
        None => Ok(HubPinStore::default()),
    }
}

fn write_hub_pin_store(path: &Path, store: &HubPinStore) -> Result<(), String> {
    use std::sync::atomic::AtomicU64;
    static PIN_STORE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| format!("pin store path {} has no parent", path.display()))?;
    prepare_hub_pin_store_dir(parent)?;
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("cannot encode desktop hub pin store: {error}"))?;
    for _ in 0..128 {
        let temporary = parent.join(format!(
            ".{}.{}.{}.tmp",
            path.file_name().and_then(|name| name.to_str()).unwrap_or("known_hubs"),
            std::process::id(),
            PIN_STORE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        match create_owner_only_file(&temporary, &bytes) {
            Ok(()) => match std::fs::rename(&temporary, path) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary);
                    return Err(format!("cannot atomically replace desktop hub pin store: {error}"));
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("cannot create desktop hub pin store: {error}")),
        }
    }
    Err("could not allocate a temporary desktop hub pin-store file".to_string())
}

#[cfg(unix)]
fn prepare_hub_pin_store_dir(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => validate_owner_only_pin_store_dir(path, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path)
                .map_err(|error| format!("cannot create desktop pin-store directory {}: {error}", path.display()))?;
            let metadata = std::fs::symlink_metadata(path)
                .map_err(|error| format!("cannot inspect desktop pin-store directory {}: {error}", path.display()))?;
            validate_owner_only_pin_store_dir(path, &metadata)
        }
        Err(error) => Err(format!("cannot inspect desktop pin-store directory {}: {error}", path.display())),
    }
}

#[cfg(unix)]
fn validate_owner_only_pin_store_dir(path: &Path, metadata: &std::fs::Metadata) -> Result<(), String> {
    validate_runtime_dir(path, metadata)?;
    if metadata.mode() & 0o077 != 0 {
        return Err(format!(
            "refusing desktop pin-store directory {}: it grants group or other permissions",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn prepare_hub_pin_store_dir(path: &Path) -> Result<(), String> {
    prepare_windows_runtime_dir(path)
}

#[cfg(unix)]
fn create_owner_only_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(windows)]
fn create_owner_only_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::fs::OpenOptions;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn reset_loopback_hub_pin() -> Result<(), String> {
    let path = hub_pin_store_path()?;
    let mut store = load_hub_pin_store(&path)?;
    if store.pins.remove(LOOPBACK_HUB_PIN_KEY).is_none() {
        return Err("there is no stored loopback hub pin to reset".to_string());
    }
    write_hub_pin_store(&path, &store)
}

/// Print the recovery result and return the process status used by the command.
/// Keeping this result explicit lets scripts distinguish a completed recovery
/// from a missing, unreadable, or unwritable pin store.
fn report_reset_hub_pin_result(result: Result<(), String>) -> i32 {
    match result {
        Ok(()) => {
            println!("Removed the stored loopback hub pin. Start Lasterm to trust the next hub deliberately.");
            0
        }
        Err(error) => {
            eprintln!("Could not reset the stored loopback hub pin: {error}");
            1
        }
    }
}

fn establish_hub_connection(port: u16, presented_spki: &[u8]) -> Result<(), String> {
    let pin_store_path = hub_pin_store_path()?;
    establish_hub_connection_at(&pin_store_path, port, presented_spki)
}

/// Establishes the connection the shell uses after a hub announcement. A known
/// pin is still matched before any request. On first use, the pinned client
/// performs an unauthenticated TLS probe before the key can enter the store.
fn establish_hub_connection_at(
    pin_store_path: &Path,
    port: u16,
    presented_spki: &[u8],
) -> Result<(), String> {
    let (expected_spki, client) = match existing_hub_pin_at(pin_store_path, LOOPBACK_HUB_PIN_KEY)? {
        Some(stored_spki) => {
            let expected_spki = match_existing_hub_pin(stored_spki, presented_spki)?;
            let client = build_pinned_hub_client(expected_spki.clone())?;
            (expected_spki, client)
        }
        None => {
            validate_announced_hub_spki(presented_spki)?;
            let client = build_pinned_hub_client(presented_spki.to_vec())?;
            prove_announced_hub_key(&client, port)?;
            let expected_spki = record_or_match_hub_pin_after_proof_at(
                pin_store_path,
                LOOPBACK_HUB_PIN_KEY,
                presented_spki,
            )?;
            (expected_spki, client)
        }
    };
    let mut connection = HUB_CONNECTION
        .lock()
        .map_err(|_| "hub connection lock poisoned".to_string())?;
    *connection = Some(HubConnection {
        port,
        expected_spki,
        client,
    });
    HUB_PORT.store(port, Ordering::Relaxed);
    Ok(())
}

fn established_hub_connection() -> Result<HubConnection, String> {
    HUB_CONNECTION
        .lock()
        .map_err(|_| "hub connection lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "the hub identity was never established; refusing to relay credentials".to_string())
}

// The Windows profile-root ACL audit is intentionally outside this issue's P11
// slice. Still reject reparse points so this reader never silently follows a
// substituted final component on platforms where that metadata is available.
#[cfg(windows)]
fn read_protected_file(path: &Path) -> Result<Option<String>, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("refusing protected file {} without a parent", path.display()))?;
    let parent_metadata = std::fs::symlink_metadata(parent)
        .map_err(|error| format!("refusing protected file parent: {error}"))?;
    validate_windows_runtime_dir(
        parent,
        &parent_metadata,
        windows_metadata_is_reparse_point(&parent_metadata),
    )?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        // A protected store is created only after its first successful use. Its
        // absence is therefore normal; every other metadata failure is a
        // refusal, before any open can follow a substituted path.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("refusing protected file metadata: {error}")),
    };
    if metadata.file_type().is_symlink() || windows_metadata_is_reparse_point(&metadata) || !metadata.is_file() {
        return Err("refusing protected path that is not a regular file".to_string());
    }
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("refusing protected file: {error}")),
    }
}

fn shutdown_caller_client_id() -> &'static Mutex<Option<String>> {
    SHUTDOWN_CALLER_CLIENT_ID.get_or_init(|| Mutex::new(None))
}

fn current_shutdown_caller_client_id() -> Option<String> {
    shutdown_caller_client_id().lock().ok()?.clone()
}

// `read_runtime_port` used to live here and returned a port from any record it could
// parse. Startup no longer wants that: a record whose process is gone is a leftover,
// and adopting its port is what pointed this client at a stranger. `await_live_runtime_port`
// replaces it and checks the recorded pid.

// `is_hub_alive` used to live here, and startup adopted whatever answered its
// probe. A successful HTTP response proves only that something is listening, so
// any local process — including one belonging to another user, which cannot read
// this user's auth.json — could receive this client's bearer token by binding the
// port named in a stale runtime.json (#170). Ownership of the single-hub lock is
// the property that actually distinguishes our hub, and the launch path reads it
// from the sidecar's exit code instead.

/// How a launched sidecar resolved.
#[cfg(not(dev))]
enum HubStartOutcome {
    /// It announced a listening endpoint and SPKI on its own stdout.
    Serving(HubAnnouncement),
    /// It exited. `None` means signalled, or the stream ended without saying.
    Exited(Option<i32>),
    /// Neither, within the window.
    Silent,
}

/// The endpoint and SPKI from the hub's own announcement, `lasterm hub
/// listening on https://127.0.0.1:PORT (spki: BASE64) (build: …)`.
///
/// Parsed from a pipe only our child writes to, which is what makes it trustworthy;
/// the value is used to talk to that child and nothing else.
///
/// Deliberately not behind `#[cfg(not(dev))]` like its caller: a plain `cargo test`
/// runs with `dev` set, so gating it would put the one piece of parsing in this path
/// beyond the reach of every test job. Only the `dev` library has no caller, hence
/// the narrow allowance rather than a cfg that would take the tests with it.
#[cfg_attr(dev, allow(dead_code))]
fn parse_listening_announcement(line: &str) -> Option<HubAnnouncement> {
    use base64::Engine;

    const PREFIX: &str = "lasterm hub listening on https://127.0.0.1:";
    let rest = line
        .strip_suffix('\n')
        .unwrap_or(line)
        .strip_prefix(PREFIX)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let after = &rest[digits.len()..];
    let spki_and_build = after.strip_prefix(" (spki: ")?.strip_suffix(')')?;
    let (encoded_spki, build) = spki_and_build.rsplit_once(") (build: ")?;
    if encoded_spki.is_empty() || build.is_empty() || encoded_spki.contains(' ') || build.contains(' ') {
        return None;
    }
    let port = digits.parse::<u16>().ok().filter(|port| *port != 0)?;
    let spki = base64::engine::general_purpose::STANDARD.decode(encoded_spki).ok()?;
    if spki.is_empty() {
        return None;
    }
    Some(HubAnnouncement { port, spki })
}

#[cfg_attr(dev, allow(dead_code))]
fn parse_listening_port(line: &str) -> Option<u16> {
    parse_listening_announcement(line).map(|announcement| announcement.port)
}

// `await_live_runtime_port` used to live here and answered "which port may I trust"
// from `runtime.json` plus a pid liveness probe. Neither binds the record to whoever
// is on that port: a leftover from a crashed hub names a port anyone may bind, pids
// are reused, another user's process answers the same probe, and the Windows probe
// answers "alive" when it cannot tell — correct for the quit path it was written
// for, inverted here. Attaching to a hub this process did not launch needs that hub
// to prove it holds the record's `ownerToken`, and no endpoint offers that yet: #183.

#[tauri::command]
fn get_hub_auth_token() -> Option<String> {
    let result = read_hub_auth_token();
    match &result {
        Some(_) => eprintln!("[lasterm] auto-auth: token found in auth.json"),
        None => eprintln!("[lasterm] auto-auth: no valid token in auth.json"),
    }
    result
}

/// The resolved hub port, or a failure the client shows rather than dials.
///
/// The launch path stores this before the window is shown, so an unresolved value
/// here is a bug in that path — one the client must not paper over by contacting a
/// plausible port.
#[tauri::command]
fn get_hub_port() -> Result<u16, String> {
    match HUB_PORT.load(Ordering::Relaxed) {
        0 => Err("the hub port was never resolved; startup did not complete".to_string()),
        port => Ok(port),
    }
}

fn hub_uploads() -> &'static Mutex<HashMap<u64, HubUpload>> {
    HUB_UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn relay_response_acks() -> &'static Mutex<HashMap<u64, mpsc::SyncSender<bool>>> {
    RELAY_RESPONSE_ACKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hub_ws_relays() -> &'static Mutex<HashMap<u64, HubWsRelay>> {
    HUB_WS_RELAYS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Builds the pinned TLS configuration shared by the REST, WebSocket, and quit
/// paths. The verifier's sole decision uses the durable desktop pin, never a
/// fresh key from runtime.json.
fn pinned_hub_tls_config(expected_spki: Vec<u8>) -> Result<rustls::ClientConfig, String> {
    use std::sync::Arc;

    if expected_spki.is_empty() {
        return Err("desktop hub pin is empty".to_string());
    }
    Ok(rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(tls_identity::SpkiPinVerifier::new(expected_spki)))
        .with_no_client_auth())
}

/// Reject malformed announcements before allocating a TLS client. This checks
/// that the bytes are one complete DER SubjectPublicKeyInfo, not merely a
/// non-empty base64 payload.
fn validate_announced_hub_spki(spki: &[u8]) -> Result<(), String> {
    if spki.is_empty() {
        return Err("The hub runtime record has an empty TLS SPKI; refusing to trust it".to_string());
    }
    let spki_der = rustls::pki_types::SubjectPublicKeyInfoDer::from(spki);
    webpki::RawPublicKeyEntity::try_from(&spki_der).map_err(|error| {
        format!("The hub runtime record has a malformed TLS SPKI; refusing to trust it: {error}")
    })?;
    Ok(())
}

/// Build the pinned REST client once when a hub connection is established.
/// `reqwest::Client` clones retain this client's connection pool. Its only
/// server-identity predicate is the SPKI published beside the listener.
fn build_pinned_hub_client(expected_spki: Vec<u8>) -> Result<reqwest::blocking::Client, String> {
    let config = pinned_hub_tls_config(expected_spki)?;
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(HUB_REQUEST_TIMEOUT)
        .use_preconfigured_tls(config)
        .build()
        .map_err(|error| format!("failed to build the pinned hub client: {error}"))
}

/// The first-use probe deliberately carries no hub credential. Any HTTP status
/// proves enough here: the TLS handshake already verified that the endpoint
/// possesses the private key for the announced SPKI.
fn prove_announced_hub_key(client: &reqwest::blocking::Client, port: u16) -> Result<(), String> {
    client
        .get(relay_hub_url(port, "/")?)
        .send()
        .map(|_| ())
        .map_err(|error| {
            if tls_peer_presented_another_key(&error) {
                "The announced hub peer presented another TLS key; refusing to trust it. Stop the hub, verify its replacement, then run `lasterm-desktop --reset-hub-pin` and start Lasterm again.".to_string()
            } else {
                format!(
                    "The announced hub peer could not be reached to prove its TLS key: {error}"
                )
            }
        })
}

fn tls_peer_presented_another_key(error: &reqwest::Error) -> bool {
    error_chain_has_spki_mismatch(error)
}

fn error_chain_has_spki_mismatch(error: &(dyn Error + 'static)) -> bool {
    if matches!(
        error.downcast_ref::<rustls::Error>(),
        Some(rustls::Error::InvalidCertificate(
            rustls::CertificateError::ApplicationVerificationFailure
        ))
    ) {
        return true;
    }
    // Hyper wraps Rustls failures in `io::Error`; its source chain stops at
    // that wrapper, so inspect its retained inner error explicitly.
    if let Some(io_error) = error.downcast_ref::<std::io::Error>() {
        if let Some(inner) = io_error.get_ref() {
            if error_chain_has_spki_mismatch(inner) {
                return true;
            }
        }
    }
    error
        .source()
        .is_some_and(error_chain_has_spki_mismatch)
}

fn relay_hub_url(port: u16, path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains("://") || path.contains('\n') || path.contains('\r')
    {
        return Err("relay request has an invalid hub path".to_string());
    }
    Ok(format!("https://127.0.0.1:{port}{path}"))
}

fn send_relay_hub_request(
    request: &RelayHubRequest,
    body: Option<reqwest::blocking::Body>,
) -> Result<reqwest::blocking::Response, String> {
    let connection = established_hub_connection()?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|error| format!("relay request has an invalid HTTP method: {error}"))?;
    let mut builder = connection
        .client
        .request(method, relay_hub_url(connection.port, &request.path)?);
    for (name, value) in &request.headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| format!("relay request has an invalid header name: {error}"))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|error| format!("relay request has an invalid header value: {error}"))?;
        builder = builder.header(name, value);
    }
    if let Some(body) = body {
        builder = builder.body(body);
    } else if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    builder
        .send()
        .map_err(|error| format!("pinned hub request failed: {error}"))
}

fn response_head(response: &reqwest::blocking::Response, id: u64) -> RelayHubHead {
    RelayHubHead {
        id,
        status: response.status().as_u16(),
        status_text: response
            .status()
            .canonical_reason()
            .unwrap_or_default()
            .to_string(),
        headers: response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string()))
            })
            .collect(),
    }
}

/// Push at most one response frame past the hub socket until the webview has
/// accepted the preceding frame. If it stops reading, this thread stops reading
/// too and TCP carries lossless backpressure to the hub.
fn relay_response(
    mut response: reqwest::blocking::Response,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> RelayHubHead {
    let id = NEXT_RELAY_ID.fetch_add(1, Ordering::Relaxed);
    let head = response_head(&response, id);
    let (ack_sender, ack_receiver) = mpsc::sync_channel(0);
    relay_response_acks()
        .lock()
        .expect("relay acknowledgement map lock poisoned")
        .insert(id, ack_sender);
    std::thread::spawn(move || {
        let mut buffer = vec![0_u8; RELAY_CHUNK_BYTES];
        loop {
            let read = match response.read(&mut buffer) {
                Ok(read) => read,
                Err(error) => {
                    let message = serde_json::json!({ "error": format!("pinned hub response failed: {error}") });
                    let _ = channel.send(tauri::ipc::InvokeResponseBody::Json(message.to_string()));
                    break;
                }
            };
            if read == 0 {
                let _ = channel.send(tauri::ipc::InvokeResponseBody::Raw(Vec::new()));
                break;
            }
            if channel
                .send(tauri::ipc::InvokeResponseBody::Raw(buffer[..read].to_vec()))
                .is_err()
            {
                break;
            }
            match ack_receiver.recv() {
                Ok(false) => {}
                Ok(true) | Err(_) => break,
            }
        }
        let _ = relay_response_acks()
            .lock()
            .expect("relay acknowledgement map lock poisoned")
            .remove(&id);
    });
    head
}

#[tauri::command]
fn relay_hub_request(
    request: RelayHubRequest,
    response: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<RelayHubHead, String> {
    let hub_response = send_relay_hub_request(&request, None)?;
    Ok(relay_response(hub_response, response))
}

#[tauri::command]
fn relay_hub_upload_start(request: RelayHubRequest) -> Result<u64, String> {
    if request.body.is_some() {
        return Err("multipart relay request must stream its body".to_string());
    }
    let mut uploads = hub_uploads()
        .lock()
        .map_err(|_| "relay upload map lock poisoned".to_string())?;
    if uploads.len() >= MAX_ACTIVE_RELAY_UPLOADS {
        return Err("too many active hub uploads".to_string());
    }
    let id = NEXT_RELAY_ID.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::sync_channel(RELAY_UPLOAD_QUEUE_CHUNKS);
    let (response_sender, response_receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let body = reqwest::blocking::Body::new(HubUploadReader {
            receiver,
            current: std::io::Cursor::new(Vec::new()),
        });
        let _ = response_sender.send(send_relay_hub_request(&request, Some(body)));
    });
    uploads.insert(
        id,
        HubUpload {
            sender,
            response: response_receiver,
        },
    );
    Ok(id)
}

#[tauri::command]
fn relay_hub_upload_chunk(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let upload_id = request
        .headers()
        .get("X-Lasterm-Upload-Id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "multipart relay chunk is missing its upload id".to_string())?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes)
            if !bytes.is_empty() && bytes.len() <= RELAY_CHUNK_BYTES =>
        {
            bytes
        }
        tauri::ipc::InvokeBody::Raw(_) => {
            return Err("multipart relay chunk exceeds the bounded IPC frame size".to_string())
        }
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("multipart relay chunk must use Tauri raw IPC bytes".to_string())
        }
    };
    send_hub_upload_chunk(upload_id, bytes.clone())
}

/// A broken upload reader means its background request has finished. Release
/// the map entry as part of that failed chunk, not at a later upload attempt.
fn send_hub_upload_chunk(upload_id: u64, bytes: Vec<u8>) -> Result<(), String> {
    let sender = hub_uploads()
        .lock()
        .map_err(|_| "relay upload map lock poisoned".to_string())?
        .get(&upload_id)
        .map(|upload| upload.sender.clone())
        .ok_or_else(|| "multipart relay upload is no longer active".to_string())?;
    if sender.send(bytes).is_err() {
        release_hub_upload(upload_id);
        return Err("multipart relay upload stopped before its body completed".to_string());
    }
    Ok(())
}

#[tauri::command]
fn relay_hub_upload_finish(
    upload_id: u64,
    response: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<RelayHubHead, String> {
    let upload = take_hub_upload(upload_id)?
        .ok_or_else(|| "multipart relay upload is no longer active".to_string())?;
    drop(upload.sender);
    let hub_response = upload.response.recv().map_err(|_| {
        "multipart relay upload stopped before receiving a hub response".to_string()
    })??;
    Ok(relay_response(hub_response, response))
}

/// Idempotent: `finish` may have won the failure race and already removed it.
#[tauri::command]
fn relay_hub_upload_cancel(upload_id: u64) {
    release_hub_upload(upload_id);
}

fn take_hub_upload(upload_id: u64) -> Result<Option<HubUpload>, String> {
    let mut uploads = hub_uploads()
        .lock()
        .map_err(|_| "relay upload map lock poisoned".to_string())?;
    Ok(uploads.remove(&upload_id))
}

fn release_hub_upload(upload_id: u64) {
    let upload = hub_uploads()
        .lock()
        .ok()
        .and_then(|mut uploads| uploads.remove(&upload_id));
    drop(upload);
}

#[tauri::command]
fn relay_hub_response_ack(response_id: u64, cancel: bool) {
    let sender = relay_response_acks()
        .lock()
        .ok()
        .and_then(|acks| acks.get(&response_id).cloned());
    if let Some(sender) = sender {
        let _ = sender.send(cancel);
    }
}

fn relay_hub_ws_url(port: u16) -> String {
    format!("wss://127.0.0.1:{port}/ws")
}

fn send_hub_ws_event(
    channel: &tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    event: &str,
    message: Option<String>,
) {
    let body = serde_json::json!({ "event": event, "message": message });
    let _ = channel.send(tauri::ipc::InvokeResponseBody::Json(body.to_string()));
}

enum HubWsRelayEnd {
    Closed,
    Stopped,
    TransportFailure(String),
}

/// Forwards one native WebSocket message in fixed-size raw IPC frames. Crucially,
/// the next chunk (and therefore the next socket read) waits for the webview's
/// acknowledgement. `Channel::send` itself is push-only and provides no such
/// flow control.
async fn relay_hub_ws_binary(
    bytes: Vec<u8>,
    channel: &tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    acknowledgement: &mut tokio::sync::mpsc::Receiver<()>,
    acknowledgement_pending: &Arc<AtomicBool>,
    close: &mut tokio::sync::mpsc::UnboundedReceiver<()>,
) -> HubWsRelayEnd {
    if bytes.len() > HUB_WS_MAX_MESSAGE_BYTES {
        return HubWsRelayEnd::TransportFailure(format!(
            "hub WebSocket message exceeds the {} byte relay limit",
            HUB_WS_MAX_MESSAGE_BYTES
        ));
    }

    // `bytes` has one bounded owner here. We do not call `read.next()` again
    // until every one of its frames has been acknowledged by the webview.
    let chunk_count = bytes.len().div_ceil(RELAY_CHUNK_BYTES);
    for (index, chunk) in bytes.chunks(RELAY_CHUNK_BYTES).enumerate() {
        // The first byte identifies the end of this one WebSocket message. IPC
        // frames stay raw bytes; the desktop client reassembles them before its
        // normal MessagePack decode.
        let mut frame = Vec::with_capacity(chunk.len() + 1);
        frame.push(u8::from(index + 1 == chunk_count));
        frame.extend_from_slice(chunk);
        // An ACK is meaningful only after this frame has become outstanding.
        // Clearing before queueing it makes early and duplicate ACKs inert.
        acknowledgement_pending.store(true, Ordering::Release);
        if channel
            .send(tauri::ipc::InvokeResponseBody::Raw(frame))
            .is_err()
        {
            acknowledgement_pending.store(false, Ordering::Release);
            return HubWsRelayEnd::Stopped;
        }
        tokio::select! {
            acknowledged = acknowledgement.recv() => {
                if acknowledged.is_none() {
                    return HubWsRelayEnd::Stopped;
                }
            }
            _ = close.recv() => return HubWsRelayEnd::Stopped,
        }
    }
    HubWsRelayEnd::Closed
}

async fn relay_hub_ws_stream(
    socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    mut input: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut acknowledgement: tokio::sync::mpsc::Receiver<()>,
    acknowledgement_pending: Arc<AtomicBool>,
    mut close: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    let (mut writer, mut reader) = socket.split();
    loop {
        tokio::select! {
            _ = close.recv() => break,
            input = input.recv() => {
                let Some(input) = input else { break };
                if let Err(error) = writer.send(tokio_tungstenite::tungstenite::Message::Binary(input.into())).await {
                    send_hub_ws_event(&channel, "transport_error", Some(format!("pinned hub WebSocket write failed: {error}")));
                    break;
                }
            }
            received = reader.next() => match received {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(bytes))) => {
                    match relay_hub_ws_binary(bytes.to_vec(), &channel, &mut acknowledgement, &acknowledgement_pending, &mut close).await {
                        HubWsRelayEnd::Closed => {},
                        HubWsRelayEnd::Stopped => break,
                        HubWsRelayEnd::TransportFailure(error) => {
                            send_hub_ws_event(&channel, "transport_error", Some(error));
                            break;
                        }
                    }
                }
                Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(payload))) => {
                    if let Err(error) = writer.send(tokio_tungstenite::tungstenite::Message::Pong(payload)).await {
                        send_hub_ws_event(&channel, "transport_error", Some(format!("pinned hub WebSocket pong failed: {error}")));
                        break;
                    }
                }
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                    send_hub_ws_event(&channel, "closed", None);
                    break;
                }
                Some(Ok(_)) => {},
                Some(Err(error)) => {
                    send_hub_ws_event(&channel, "transport_error", Some(format!("pinned hub WebSocket read failed: {error}")));
                    break;
                }
                None => {
                    send_hub_ws_event(&channel, "transport_error", Some("pinned hub WebSocket ended without a close frame".to_string()));
                    break;
                }
            }
        }
    }
}

#[tauri::command]
async fn relay_hub_ws_connect(
    stream: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<u64, String> {
    let connection = established_hub_connection()?;
    let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(HUB_WS_MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(HUB_WS_MAX_MESSAGE_BYTES);
    let (socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        relay_hub_ws_url(connection.port),
        Some(config),
        false,
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(
            pinned_hub_tls_config(connection.expected_spki)?,
        ))),
    )
    .await
    .map_err(|error| format!("pinned hub WebSocket connection failed: {error}"))?;

    let id = NEXT_RELAY_ID.fetch_add(1, Ordering::Relaxed);
    let (input_sender, input) = tokio::sync::mpsc::channel(HUB_WS_INPUT_QUEUE_MESSAGES);
    let (acknowledgement_sender, acknowledgement) = tokio::sync::mpsc::channel(1);
    let acknowledgement_pending = Arc::new(AtomicBool::new(false));
    let (close_sender, close) = tokio::sync::mpsc::unbounded_channel();
    hub_ws_relays()
        .lock()
        .map_err(|_| "hub WebSocket relay map lock poisoned".to_string())?
        .insert(
            id,
            HubWsRelay {
                input: input_sender,
                acknowledgement: acknowledgement_sender,
                acknowledgement_pending: acknowledgement_pending.clone(),
                close: close_sender,
            },
        );
    tauri::async_runtime::spawn(async move {
        relay_hub_ws_stream(socket, stream, input, acknowledgement, acknowledgement_pending, close).await;
        let _ = hub_ws_relays().lock().map(|mut relays| relays.remove(&id));
    });
    Ok(id)
}

/// Receives one raw MessagePack frame from the webview. Awaiting the bounded
/// queue provides native backpressure; the TypeScript client serializes calls.
#[tauri::command]
async fn relay_hub_ws_send(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let relay_id = request
        .headers()
        .get("X-Lasterm-Ws-Id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "WebSocket input is missing its relay id".to_string())?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes)
            if !bytes.is_empty() && bytes.len() <= HUB_WS_MAX_MESSAGE_BYTES =>
        {
            bytes.clone()
        }
        tauri::ipc::InvokeBody::Raw(_) => {
            close_hub_ws_relay(relay_id);
            return Err("WebSocket input exceeds the bounded relay message size".to_string());
        }
        tauri::ipc::InvokeBody::Json(_) => {
            close_hub_ws_relay(relay_id);
            return Err("WebSocket input must use Tauri raw IPC bytes".to_string());
        }
    };
    let input = hub_ws_relays()
        .lock()
        .map_err(|_| "hub WebSocket relay map lock poisoned".to_string())?
        .get(&relay_id)
        .map(|relay| relay.input.clone())
        .ok_or_else(|| "WebSocket relay is no longer active".to_string())?;
    input
        .send(bytes)
        .await
        .map_err(|_| "WebSocket relay is no longer active".to_string())
}

#[tauri::command]
fn relay_hub_ws_ack(relay_id: u64) {
    let relay = hub_ws_relays().lock().ok().and_then(|relays| {
        relays
            .get(&relay_id)
            .map(|relay| (relay.acknowledgement.clone(), relay.acknowledgement_pending.clone()))
    });
    if let Some((sender, pending)) = relay {
        accept_hub_ws_ack(&sender, &pending);
    }
}

fn accept_hub_ws_ack(sender: &tokio::sync::mpsc::Sender<()>, pending: &AtomicBool) {
    if pending.swap(false, Ordering::AcqRel) {
        let _ = sender.try_send(());
    }
}

#[tauri::command]
fn relay_hub_ws_close(relay_id: u64) {
    close_hub_ws_relay(relay_id);
}

fn close_hub_ws_relay(relay_id: u64) {
    let sender = hub_ws_relays()
        .lock()
        .ok()
        .and_then(|relays| relays.get(&relay_id).map(|relay| relay.close.clone()));
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

#[tauri::command]
fn is_tray_available() -> bool {
    TRAY_AVAILABLE.load(Ordering::Relaxed)
}

#[allow(non_snake_case)]
#[tauri::command]
fn set_shutdown_caller_client_id(clientId: Option<String>) {
    if let Ok(mut stored) = shutdown_caller_client_id().lock() {
        *stored = clientId.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        });
    }
}

/// Requests the hub-owned quit sequence. This
/// never repairs a successful request by killing a PID: `/api/quit` owns the
/// agent and terminal teardown, and a missing response is only observed.
fn request_hub_quit(force: bool) -> QuitRequestResult {
    let runtime = match load_runtime_info() {
        RuntimeLoadResult::Absent => return missing_runtime_record_quit_result(),
        RuntimeLoadResult::Unreadable(error) => {
            return QuitRequestResult::Failed(format!(
                "cannot determine whether the hub stopped because runtime.json cannot be read: {error}"
            ));
        }
        RuntimeLoadResult::Present(runtime) => runtime,
    };
    let Some(owner_token) = runtime.owner_token.clone() else {
        return QuitRequestResult::Failed(
            "the running hub does not support the authenticated quit endpoint".to_string(),
        );
    };
    let Some(pid) = runtime
        .pid
        .filter(|pid| *pid != 0 && *pid != std::process::id())
    else {
        return QuitRequestResult::Failed("runtime.json is missing a valid hub pid".to_string());
    };
    let Some(instance_id) = runtime.instance_id.clone() else {
        return QuitRequestResult::Failed(
            "runtime.json is missing the hub instance identity; refusing an unobservable quit"
                .to_string(),
        );
    };
    let target = HubQuitTarget { pid, instance_id };

    let connection = match established_hub_connection() {
        Ok(connection) => connection,
        Err(error) => return QuitRequestResult::Failed(error),
    };
    let owner_header = match owner_token.parse::<reqwest::header::HeaderValue>() {
        Ok(header) => header,
        Err(error) => {
            return QuitRequestResult::Failed(format!(
                "quit request was not sent because its owner header is invalid: {error}"
            ))
        }
    };
    let url = hub_quit_url(connection.port, force);
    let mut request = connection.client.post(url).header("X-Lasterm-Owner", owner_header);
    if let Some(client_id) = current_shutdown_caller_client_id() {
        request = request.header("X-Lasterm-Client-Id", client_id);
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(error) => return classify_quit_transport_error(error, target),
    };
    if response.status().is_success() {
        return QuitRequestResult::Committed {
            target,
            diagnostic: None,
        };
    }
    let status = response.status().as_u16();
    let body = response.text().unwrap_or_default();
    classify_quit_response(status, &body, target)
}

fn missing_runtime_record_quit_result() -> QuitRequestResult {
    QuitRequestResult::Failed("cannot quit because the hub runtime record is missing".to_string())
}

fn classify_quit_transport_error(
    error: reqwest::Error,
    target: HubQuitTarget,
) -> QuitRequestResult {
    // A connect or request-build error happens before an HTTP request exists.
    // Timeouts and read failures can happen after the hub accepted it, so only
    // those remain ambiguous and must be observed.
    if error.is_connect() || error.is_builder() {
        return QuitRequestResult::Failed(format!("quit request was not sent: {error}"));
    }
    eprintln!("[lasterm] quit response was not observed: {error}");
    QuitRequestResult::Unobserved(target)
}

fn classify_quit_response(status: u16, body: &str, target: HubQuitTarget) -> QuitRequestResult {
    if status == 409 {
        let others = serde_json::from_str::<QuitResponseBody>(body)
            .ok()
            .and_then(|body| body.others)
            .filter(|others| *others > 0);
        return QuitRequestResult::Conflict(others);
    }
    if status == 503 {
        let diagnostic = serde_json::from_str::<QuitResponseBody>(body)
            .ok()
            .and_then(|body| body.message)
            .unwrap_or_else(|| "The local agent was not confirmed stopped.".to_string());
        // /api/quit schedules teardown after it sends this 503. The stopped
        // agent is uncertain; the hub teardown is not, so observe first.
        return QuitRequestResult::Committed {
            target,
            diagnostic: Some(diagnostic),
        };
    }
    QuitRequestResult::Failed(format!("quit request failed with HTTP {status}"))
}

fn hub_quit_url(port: u16, force: bool) -> String {
    let force_query = if force { "?force=1" } else { "" };
    format!("https://127.0.0.1:{port}/api/quit{force_query}")
}

fn observe_hub_quit(target: &HubQuitTarget) -> Result<(), String> {
    observe_hub_quit_with(
        target,
        load_runtime_info,
        is_pid_alive,
        HUB_QUIT_OBSERVE_TIMEOUT,
    )
}

fn observe_hub_quit_with<Load, Alive>(
    target: &HubQuitTarget,
    load_runtime: Load,
    is_pid_alive: Alive,
    timeout: Duration,
) -> Result<(), String>
where
    Load: Fn() -> RuntimeLoadResult,
    Alive: Fn(u32) -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        let current = load_runtime();
        match &current {
            RuntimeLoadResult::Unreadable(error) => {
                return Err(format!(
                    "Hub teardown could not be confirmed because runtime.json cannot be read: {error}"
                ));
            }
            RuntimeLoadResult::Present(runtime)
                if runtime.instance_id.as_deref() != Some(&target.instance_id) =>
            {
                return Err(
                    "Hub quit target exited, but runtime.json now belongs to a replacement hub"
                        .to_string(),
                );
            }
            RuntimeLoadResult::Absent if !is_pid_alive(target.pid) => {
                // Re-read after liveness so an absent record and dead PID from
                // different moments cannot prove a replacement has gone too.
                match load_runtime() {
                    RuntimeLoadResult::Absent => return Ok(()),
                    RuntimeLoadResult::Unreadable(error) => return Err(format!(
                        "Hub teardown could not be confirmed because runtime.json cannot be read: {error}"
                    )),
                    RuntimeLoadResult::Present(runtime)
                        if runtime.instance_id.as_deref() != Some(&target.instance_id) =>
                    {
                        return Err("Hub quit target exited, but runtime.json now belongs to a replacement hub".to_string());
                    }
                    RuntimeLoadResult::Present(_) => {}
                }
            }
            RuntimeLoadResult::Absent | RuntimeLoadResult::Present(_) => {}
        }
        if Instant::now() >= deadline {
            let detail = match current {
                RuntimeLoadResult::Absent => "runtime record was removed but its PID remains live",
                RuntimeLoadResult::Present(_) => "runtime record remains",
                RuntimeLoadResult::Unreadable(_) => unreachable!(),
            };
            return Err(format!(
                "Hub teardown was not confirmed within {}ms: {detail}",
                timeout.as_millis()
            ));
        }
        std::thread::sleep(HUB_QUIT_OBSERVE_POLL);
    }
}

#[cfg(target_os = "windows")]
fn is_pid_alive(pid: u32) -> bool {
    let filter = format!("PID eq {}", pid);
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    let expected = pid.to_string();
    let mut parsed_a_row = false;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some(field) = line.split(',').nth(1) else {
            continue;
        };
        parsed_a_row = true;
        if field.trim().trim_matches('"') == expected {
            return true;
        }
    }
    // A command failure, localized no-match text, or malformed CSV cannot
    // establish ESRCH's equivalent. Only a successfully parsed task list does.
    !parsed_a_row
}

#[cfg(not(target_os = "windows"))]
fn is_pid_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    // POSIX reserves signal 0 for existence/permission probing. ESRCH is the
    // only definite absence; EPERM and every other error fail closed as live,
    // matching packages/hub/src/cli.ts:isPidAlive.
    let result = unsafe { kill(pid as i32, 0) };
    let probe = if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().raw_os_error())
    };
    pid_probe_reports_alive(probe)
}

/// Converts a POSIX PID probe to liveness. Only ESRCH establishes absence; an
/// unavailable probe, EPERM, and every other error remain live.
///
/// Unix only, because Windows has no errno to read: there the same rule is
/// expressed over `tasklist` output, where only a successfully parsed listing
/// that does not contain the pid can mean it is gone.
#[cfg(not(target_os = "windows"))]
fn pid_probe_reports_alive(probe: Result<(), Option<i32>>) -> bool {
    !matches!(probe, Err(Some(3)))
}

fn show_shutdown_error(app: &tauri::AppHandle, message: String) {
    app.dialog()
        .message(message)
        .title("Quit Failed")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

/// Report a startup that cannot continue, then leave.
///
/// Returning `Err` from Tauri's `setup` hook panics, so a condition this code
/// expects — a hub already running, a sidecar that refused — would reach the user
/// as a crash with no explanation. The main window is still hidden at that point,
/// which leaves a dialog as the only surface, and the app exits when it is
/// dismissed rather than continuing without a hub.
#[cfg(not(dev))]
fn show_startup_failure_then_exit(app: tauri::AppHandle, message: String) {
    eprintln!("[lasterm] startup stopped: {message}");
    app.dialog()
        .message(message)
        .title("Lasterm cannot start")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.exit(1));
}

#[cfg(dev)]
fn show_startup_failure_then_exit(app: tauri::AppHandle, message: String) {
    show_desktop_instance_failure_then_exit(app, message);
}

fn show_quit_diagnostic_then_exit(app: tauri::AppHandle, diagnostic: String) {
    app.dialog()
        .message(format!(
            "The hub shut down, but the local agent was not confirmed stopped: {diagnostic}"
        ))
        .title("Agent Stop Not Confirmed")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.exit(0));
}

fn present_native_quit_consent(app: tauri::AppHandle, others: Option<usize>) {
    let subject = match others {
        Some(1) => "1 other client".to_string(),
        Some(others) => format!("{others} other clients"),
        None => "other connected clients (the hub did not provide a count)".to_string(),
    };
    let confirmed = app
        .dialog()
        .message(format!("{subject} are connected. Quit Lasterm anyway?"))
        .title("Other Clients Connected")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();
    if confirmed {
        let action = quit_coordinator()
            .lock()
            .expect("quit coordinator lock poisoned")
            .resolve_native_consent(true);
        apply_quit_action(app, action);
    } else {
        let action = quit_coordinator()
            .lock()
            .expect("quit coordinator lock poisoned")
            .resolve_native_consent(false);
        apply_quit_action(app, action);
    }
}

fn apply_quit_action(app: tauri::AppHandle, action: QuitAction) {
    match action {
        QuitAction::AskNative { others } => present_native_quit_consent(app, others),
        QuitAction::SendForced { attempt_id } => {
            std::thread::spawn(move || {
                let result = request_hub_quit(true);
                let action = quit_coordinator()
                    .lock()
                    .expect("quit coordinator lock poisoned")
                    .request_finished(attempt_id, true, result);
                apply_quit_action(app, action);
            });
        }
        QuitAction::Observe {
            attempt_id,
            target,
            diagnostic,
        } => {
            std::thread::spawn(move || {
                let observed = observe_hub_quit(&target);
                let action = quit_coordinator()
                    .lock()
                    .expect("quit coordinator lock poisoned")
                    .observation_finished(attempt_id, observed, diagnostic);
                apply_quit_action(app, action);
            });
        }
        QuitAction::Exit => app.exit(0),
        QuitAction::ExitWithDiagnostic(diagnostic) => {
            show_quit_diagnostic_then_exit(app, diagnostic)
        }
        QuitAction::Failed(message) => show_shutdown_error(&app, message),
        QuitAction::Ignore => {}
    }
}

fn request_app_quit(app: tauri::AppHandle) {
    let started = quit_coordinator()
        .lock()
        .expect("quit coordinator lock poisoned")
        .begin();
    match started {
        QuitStart::Started(attempt_id) => {
            let request_app = app.clone();
            std::thread::spawn(move || {
                let result = request_hub_quit(false);
                let action = quit_coordinator()
                    .lock()
                    .expect("quit coordinator lock poisoned")
                    .request_finished(attempt_id, false, result);
                apply_quit_action(request_app, action);
            });
        }
        QuitStart::InProgress => {
            // The native dialog is synchronous, so there is no renderer-owned
            // acknowledgement or expiry path to manage here.
        }
    }
}

fn handle_tray_quit(app: tauri::AppHandle) {
    request_app_quit(app);
}

fn hide_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if TRAY_AVAILABLE.load(Ordering::Relaxed) {
        let _ = window.hide();
    } else {
        let _ = window.minimize();
    }
}

fn present_native_window_close_choice(app: tauri::AppHandle) {
    let confirmed = app
        .dialog()
        .message("Quit Lasterm completely?")
        .title("Quit Lasterm")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit completely".to_string(),
            "Keep running".to_string(),
        ))
        .blocking_show();
    if confirmed {
        request_app_quit(app);
    }
}

fn expire_window_close_presentation(app: tauri::AppHandle, attempt_id: u64) {
    let fallback = window_close_coordinator()
        .lock()
        .expect("window close coordinator lock poisoned")
        .timed_out(attempt_id);
    if fallback {
        present_native_window_close_choice(app);
    }
}

fn begin_window_close_presentation(app: tauri::AppHandle) {
    let started = window_close_coordinator()
        .lock()
        .expect("window close coordinator lock poisoned")
        .begin();
    let WindowCloseStart::Started(attempt_id) = started else {
        return;
    };
    let delivered = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
        && app
            .emit("desktop-close-requested", WindowCloseRequest { attempt_id })
            .is_ok();
    if !delivered {
        expire_window_close_presentation(app, attempt_id);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(WINDOW_CLOSE_PRESENTATION_ACK_TIMEOUT);
        expire_window_close_presentation(app, attempt_id);
    });
}

fn handle_native_window_close(app: tauri::AppHandle) {
    match close_behavior_command_result(read_close_behavior()) {
        Ok(CloseBehavior::Hide) => hide_main_window(&app),
        Ok(CloseBehavior::Quit) => {
            request_app_quit(app);
        }
        Ok(CloseBehavior::Ask) => begin_window_close_presentation(app),
        Err(message) => show_shutdown_error(
            &app,
            format!("Close preference could not be loaded: {message}"),
        ),
    }
}

#[tauri::command]
fn acknowledge_desktop_close(app: tauri::AppHandle, attempt_id: u64) {
    let acknowledged = window_close_coordinator()
        .lock()
        .expect("window close coordinator lock poisoned")
        .acknowledged(attempt_id);
    if acknowledged {
        std::thread::spawn(move || {
            std::thread::sleep(WINDOW_CLOSE_ANSWER_TIMEOUT);
            let expired = window_close_coordinator()
                .lock()
                .expect("window close coordinator lock poisoned")
                .answer_timed_out(attempt_id);
            if expired {
                let _ = app.emit("desktop-close-expired", WindowCloseRequest { attempt_id });
            }
        });
    }
}

#[tauri::command]
fn answer_desktop_close(
    app: tauri::AppHandle,
    attempt_id: u64,
    action: WindowCloseChoice,
    remember: bool,
) -> Result<(), String> {
    let accepted = window_close_coordinator()
        .lock()
        .expect("window close coordinator lock poisoned")
        .answer(attempt_id);
    if !accepted {
        return Ok(());
    }
    if remember {
        let behavior = match action {
            WindowCloseChoice::Quit => CloseBehavior::Quit,
            WindowCloseChoice::Tray => CloseBehavior::Hide,
        };
        set_close_behavior(behavior)?;
    }
    match action {
        WindowCloseChoice::Quit => {
            request_app_quit(app);
        }
        WindowCloseChoice::Tray => hide_main_window(&app),
    }
    Ok(())
}

#[tauri::command]
fn cancel_desktop_close(attempt_id: u64) {
    let _ = window_close_coordinator()
        .lock()
        .expect("window close coordinator lock poisoned")
        .answer(attempt_id);
}

#[tauri::command]
async fn pick_and_read_agent_file(
    app: tauri::AppHandle,
    kind: String,
) -> Result<Option<PickedAgentFile>, String> {
    let kind = AgentFileKind::try_from(kind.as_str())?;
    let mut dialog = app.dialog().file().set_can_create_directories(false);

    dialog = match kind {
        AgentFileKind::Binary => dialog
            .set_title("Select agent binary")
            .add_filter("All files", &["*"]),
        AgentFileKind::Manifest => dialog
            .set_title("Select SHA256SUMS manifest")
            .add_filter("SHA256SUMS manifests", &["txt"])
            .add_filter("All files", &["*"]),
    };

    let (tx, mut rx) = tauri::async_runtime::channel(1);
    dialog.pick_file(move |file_path| {
        let _ = tx.blocking_send(file_path);
    });

    let Some(selected) = rx.recv().await else {
        return Err("DIALOG_CLOSED: file dialog did not return a selection".to_string());
    };
    let Some(path) = selected else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|error| format!("INVALID_PATH: {}", error))?;
    let max_bytes = kind.max_bytes();

    tauri::async_runtime::spawn_blocking(move || read_picked_agent_file(path, max_bytes))
        .await
        .map_err(|error| error.to_string())?
        .map(Some)
}

fn read_picked_agent_file(path: PathBuf, max_bytes: u64) -> Result<PickedAgentFile, String> {
    let selected_metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("INVALID_PATH: failed to inspect selected file: {}", error))?;
    if selected_metadata.file_type().is_symlink() {
        return Err("SYMLINK_NOT_ALLOWED: selected file must not be a symlink".to_string());
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("INVALID_PATH: failed to resolve selected file: {}", error))?;
    let canonical_metadata = std::fs::symlink_metadata(&canonical_path)
        .map_err(|error| format!("INVALID_PATH: failed to inspect selected file: {}", error))?;
    if canonical_metadata.file_type().is_symlink() {
        return Err("SYMLINK_NOT_ALLOWED: selected file must not be a symlink".to_string());
    }

    let file = std::fs::File::open(&canonical_path)
        .map_err(|error| format!("READ_FAILED: failed to open selected file: {}", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("INVALID_PATH: failed to inspect selected file: {}", error))?;
    if !metadata.is_file() {
        return Err("NOT_REGULAR_FILE: selected path must be a regular file".to_string());
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "TOO_LARGE: selected file is {} bytes, maximum is {} bytes",
            metadata.len(),
            max_bytes
        ));
    }

    let name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "INVALID_PATH: selected file has no usable name".to_string())?
        .to_string();
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut reader = file.take(max_bytes.saturating_add(1));
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("READ_FAILED: failed to read selected file: {}", error))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "TOO_LARGE: selected file is larger than {} bytes",
            max_bytes
        ));
    }

    Ok(PickedAgentFile { name, bytes })
}

#[cfg(target_os = "windows")]
fn set_windows_transparent_background(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
}

/// In release builds, spawn the hub sidecar and wait for it to become ready.
/// In dev builds, the hub is already running externally — just show the window.
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // This is deliberately first: no second desktop may spawn a sidecar, initialise
    // a tray, or show a window. The managed guard keeps its non-inheritable handle
    // alive until this desktop process exits.
    let mut instance = match acquire_desktop_instance() {
        Ok(DesktopInstanceStartup::Primary(instance)) => instance,
        Ok(DesktopInstanceStartup::Secondary) => {
            // The primary acknowledged after `show()` and `set_focus()` completed.
            // There is nothing for this process to initialise or display.
            app.handle().exit(0);
            return Ok(());
        }
        Err(error) => {
            show_instance_failure_then_exit(app.handle().clone(), error);
            return Ok(());
        }
    };

    // `create: false` keeps the main window config in tauri.conf.json while
    // letting us install the builder-only new-window boundary. Construct it
    // before any startup path can look it up by label.
    let main_window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or("tauri.conf.json is missing the main window configuration")?;
    tauri::WebviewWindowBuilder::from_config(app.handle(), main_window_config)?
        .on_new_window(|url, _features| {
            if !allows_webview_new_window(&url) {
                eprintln!("[lasterm] refused webview new-window request to {url}");
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;

    // System tray
    let show = MenuItemBuilder::with_id("show", "Show Lasterm").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let tray = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                handle_tray_quit(app.clone());
            }
            _ => {}
        })
        .build(app);

    match tray {
        Ok(tray) => {
            TRAY_AVAILABLE.store(true, Ordering::Relaxed);
            app.manage(tray);
        }
        Err(error) => {
            TRAY_AVAILABLE.store(false, Ordering::Relaxed);
            eprintln!("[lasterm] failed to initialize tray: {}", error);
        }
    }

    // In release mode, spawn the hub sidecar
    #[cfg(not(dev))]
    {
        use tauri_plugin_shell::ShellExt;

        // Nothing here probes a port to decide anything. The desktop launches the
        // sidecar, so the only facts it needs come from a process it owns and from
        // files only this user can read:
        //
        //   * the child's own stdout announces the port it bound. Another user
        //     cannot write to our child's pipe, so this cannot be forged — whereas
        //     an unauthenticated `/api/health` can be answered by anyone who binds
        //     the port first, which is how a stale record used to hand this client's
        //     bearer token to a stranger (#170).
        //   * exit 73 means a hub of this user already holds `hub.lock`. That file is
        //     0600 in the user's state directory, so no other user can hold it.
        //   * `runtime.json` is 0600 and written by the lock holder after it binds.
        //
        // Readiness is therefore observed, never polled, and the wait ends the moment
        // the child resolves either way (#171).
        // A missing bundle, a permissions error or an OS refusal used to panic here,
        // which bypasses the failure dialog entirely — the one path where the user most
        // needs to be told what is wrong, since nothing they can see explains it.
        let sidecar = match app.shell().sidecar("lasterm-hub") {
            Ok(sidecar) => sidecar.args(["start"]),
            Err(error) => {
                show_startup_failure_then_exit(
                    app.handle().clone(),
                    format!("The hub program could not be located in this build: {error}"),
                );
                return Ok(());
            }
        };
        let (mut rx, child) = match sidecar.spawn() {
            Ok(pair) => pair,
            Err(error) => {
                show_startup_failure_then_exit(
                    app.handle().clone(),
                    format!("The hub could not be started: {error}"),
                );
                return Ok(());
            }
        };

        let log_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("lasterm");
        if let Err(error) = std::fs::create_dir_all(&log_dir) {
            eprintln!("[lasterm] cannot create {}: {error}", log_dir.display());
        }
        let log_path = log_dir.join("hub.log");

        tauri::async_runtime::spawn(async move {
            // A log this task cannot open must not stop it consuming events: the
            // outcome of startup is decided by what arrives here, and an unread
            // channel would also leave a chatty child blocked on a full pipe.
            let mut file = match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                Ok(f) => Some(f),
                Err(error) => {
                    eprintln!("[lasterm] cannot open {}: {error}", log_path.display());
                    None
                }
            };
            let mut record = |line: String| match file.as_mut() {
                Some(f) => {
                    let _ = writeln!(f, "{line}");
                }
                None => eprintln!("[lasterm] {line}"),
            };

            use tauri_plugin_shell::process::CommandEvent;
            // Held back until nothing else is waiting to contradict it. Publishing a
            // port the instant it is parsed is what let startup succeed against a
            // child whose termination event was already queued behind that line.
            let mut announced: Option<HubAnnouncement> = None;
            let mut exited = false;
            loop {
                // Anything already queued is taken first, so a pending exit is seen
                // before an announcement is believed. `Empty` means the child has
                // said all it has to say for now, which is when a port becomes usable.
                let event = match rx.try_recv() {
                    Ok(event) => event,
                    // Empty or disconnected, treated the same and deliberately: on a
                    // closed channel the await below returns immediately, and the tail
                    // of this task then publishes the exit, which supersedes a port.
                    // Naming the two apart would need tokio as a direct dependency for
                    // no behavioural difference.
                    Err(_) => {
                        if let Some(announcement) = announced.take() {
                            publish_hub_state(HubState::Serving(announcement));
                        }
                        match rx.recv().await {
                            Some(event) => event,
                            None => break,
                        }
                    }
                };

                match event {
                    CommandEvent::Stdout(line) => {
                        let text = String::from_utf8_lossy(&line).to_string();
                        if let Some(announcement) = parse_listening_announcement(&text) {
                            announced = Some(announcement);
                        }
                        record(format!("[hub:stdout] {text}"));
                    }
                    CommandEvent::Stderr(line) => {
                        record(format!("[hub:stderr] {}", String::from_utf8_lossy(&line)));
                    }
                    CommandEvent::Terminated(payload) => {
                        record(format!(
                            "[hub:exit] code={:?} signal={:?}",
                            payload.code, payload.signal
                        ));
                        publish_hub_state(HubState::Exited(payload.code));
                        exited = true;
                        break;
                    }
                    CommandEvent::Error(err) => record(format!("[hub:error] {err}")),
                    _ => {}
                }
            }
            // The stream ending without a `Terminated` event leaves the child's fate
            // unknown, which must not read as "still starting" for ever.
            if !exited {
                record("[hub:exit] event stream ended without a termination event".to_string());
                publish_hub_state(HubState::Exited(None));
            }
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        // One read of one state, so there is no pair of cells to see out of step.
        let outcome = loop {
            match hub_state() {
                HubState::Serving(announcement) => break HubStartOutcome::Serving(announcement),
                HubState::Exited(code) => break HubStartOutcome::Exited(code),
                HubState::Starting if std::time::Instant::now() >= deadline => {
                    break HubStartOutcome::Silent;
                }
                HubState::Starting => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        };

        let hub_port = match outcome {
            HubStartOutcome::Serving(announcement) => {
                // No second look, and none possible: `Serving` is published only when
                // the event queue was momentarily empty, and an exit supersedes it, so
                // there is no pair of readings to disagree. A child dying a moment after
                // this is #184, which nothing here can see.
                if let Err(error) = establish_hub_connection(announcement.port, &announcement.spki) {
                    if let Err(kill_error) = child.kill() {
                        eprintln!("[lasterm] could not stop hub after pin refusal: {kill_error}");
                    }
                    show_startup_failure_then_exit(app.handle().clone(), error);
                    return Ok(());
                }
                app.manage(child);
                announcement.port
            }
            HubStartOutcome::Exited(Some(code)) if code == HUB_LOCK_HELD_EXIT_CODE => {
                // A hub of this user is already running, and this build will not attach
                // to it. Finding its port would mean trusting `runtime.json`, and a
                // record proves nothing about who is on the port it names: a leftover
                // from a crashed hub names a port anyone may bind, and the recorded pid
                // cannot settle it — pids are reused, another user's process answers
                // the same probe, and the Windows probe deliberately answers "alive"
                // when it cannot tell, which is right for the quit path that owns it
                // and wrong here. Attaching safely needs the hub to prove it holds the
                // record's `ownerToken`, which no endpoint offers yet: #183.
                show_startup_failure_then_exit(
                    app.handle().clone(),
                    "A hub of this user is already running. Lasterm will not attach to it \
                     yet (#183): stop that hub, or open its address in a browser."
                        .to_string(),
                );
                return Ok(());
            }
            HubStartOutcome::Exited(code) => {
                // The stream can end with the child still alive, and this branch is
                // where that arrives. Killing it here is what keeps an untracked hub
                // from holding the lock after this launch is gone; a child that had
                // already exited makes this a no-op.
                if code.is_none() {
                    if let Err(error) = child.kill() {
                        eprintln!("[lasterm] could not stop a hub whose fate is unknown: {error}");
                    }
                }
                // `None` is a signal, or a stream that ended without a termination
                // event. It is described rather than printed as a number the operating
                // system never produced.
                let how = match code {
                    Some(code) => format!("exited with code {code}"),
                    None => "was signalled, or its output stream ended without reporting an exit"
                        .to_string(),
                };
                show_startup_failure_then_exit(
                    app.handle().clone(),
                    format!(
                        "The hub {how} instead of serving. Its output is in hub.log in the \
                         application data directory."
                    ),
                );
                return Ok(());
            }
            HubStartOutcome::Silent => {
                // Neither serving nor exited. The child must not be left behind to bind
                // a port and hold the lock after this launch gave up, and a kill that
                // fails must be said rather than dropped: the next launch would meet a
                // holder nobody knows about.
                let message = match child.kill() {
                    Ok(()) => "The hub neither reported a listening port nor exited within 15 \
                               seconds, and was stopped. Its output is in hub.log in the \
                               application data directory."
                        .to_string(),
                    Err(error) => format!(
                        "The hub neither reported a listening port nor exited within 15 seconds, \
                         and stopping it failed ({error}). It may still be holding the hub lock; \
                         its output is in hub.log in the application data directory."
                    ),
                };
                show_startup_failure_then_exit(app.handle().clone(), message);
                return Ok(());
            }
        };

        eprintln!("[lasterm] hub port resolved to {}", hub_port);
    }

    // Under `tauri dev` no sidecar is launched: `pnpm dev` runs the hub separately, so
    // there is no child to announce a port. The record that hub wrote is the only thing
    // that knows which port it took — `zero_conf` moves it to 4101-4199 when 4100 is
    // occupied, and assuming 4100 pointed this window at whatever held that port.
    //
    // Reading the record is acceptable here and nowhere else: no sidecar is being
    // adopted, the hub is the developer's own, and a dev build has no cross-user threat
    // model to defend. The release path deliberately does not trust it (#183).
    #[cfg(dev)]
    {
        let runtime = match load_runtime_info() {
            RuntimeLoadResult::Present(runtime) => {
                eprintln!(
                    "[lasterm] dev build: using port {} from the hub's runtime record",
                    runtime.port
                );
                runtime
            }
            RuntimeLoadResult::Absent => {
                return Err(
                    "The dev hub runtime record is missing; refusing to trust an unpinned hub."
                        .into(),
                );
            }
            RuntimeLoadResult::Unreadable(error) => {
                return Err(format!("The dev hub runtime record is not defensible: {error}").into());
            }
        };
        let spki = runtime.spki.as_deref().ok_or_else(|| {
            "The dev hub runtime record is missing its TLS SPKI; refusing to trust it".to_string()
        })?;
        use base64::Engine;
        let spki = base64::engine::general_purpose::STANDARD
            .decode(spki)
            .map_err(|error| format!("The dev hub runtime record has an invalid TLS SPKI: {error}"))?;
        establish_hub_connection(runtime.port, &spki)?;
    }

    // Show the main window (hidden by default in config).
    let main_window = app.get_webview_window("main");
    if let Some(window) = main_window.as_ref() {
        #[cfg(target_os = "windows")]
        set_windows_transparent_background(window)?;

        // Enable DevTools in debug builds only
        #[cfg(debug_assertions)]
        window.open_devtools();
    }
    match present_main_window_at_startup(main_window.as_ref()) {
        MainWindowStartupOutcome::Fatal(message) => {
            show_startup_failure_then_exit(app.handle().clone(), message);
            return Ok(());
        }
        MainWindowStartupOutcome::Shown {
            focus_error: Some(error),
        } => {
            eprintln!("[lasterm] could not focus the shown main window: {error}");
        }
        MainWindowStartupOutcome::Shown {
            focus_error: None,
        } => {}
    }

    // Publish the handoff endpoint only after primary setup is complete. Until
    // then a secondary retries the lock and endpoint, so a queued main-thread
    // raise can never time out and run only after its failure was reported.
    instance.raise_listener =
        match start_desktop_raise_listener(app.handle().clone(), &instance.endpoint) {
            Ok(listener) => Some(listener),
            Err(error) => {
                show_instance_failure_then_exit(app.handle().clone(), error);
                return Ok(());
            }
        };
    app.manage(instance);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Deliberate recovery only. A mismatch never reaches this path by itself;
    // the user must run the command after independently verifying the new hub.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--reset-hub-pin")) {
        std::process::exit(report_reset_hub_pin_result(reset_loopback_hub_pin()));
    }
    let builder = tauri::Builder::default()
        // Install the navigation boundary before setup_app constructs the main
        // window from its configuration. It then also applies to every later
        // webview the application creates.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("webview-navigation-boundary")
                .on_navigation(|webview, url| {
                    let allowed = allows_current_webview_navigation(url);
                    if !allowed {
                        eprintln!(
                            "[lasterm] refused webview navigation from {} to {}",
                            webview.label(),
                            url
                        );
                    }
                    allowed
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init());
    let builder = match current_package_identity_probe() {
        PackageIdentityProbe::Unpackaged => {
            builder.plugin(tauri_plugin_updater::Builder::new().build())
        }
        PackageIdentityProbe::Packaged { status } => {
            eprintln!(
                "[lasterm] updater disabled: application has an MSIX package identity (GetCurrentPackageFullName status {status})"
            );
            builder
        }
        PackageIdentityProbe::Inconclusive { status } => {
            eprintln!(
                "[lasterm] updater disabled: package identity probe was inconclusive (Windows error {status})"
            );
            builder
        }
    };

    builder
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_hub_auth_token,
            get_hub_port,
            relay_hub_request,
            relay_hub_upload_start,
            relay_hub_upload_chunk,
            relay_hub_upload_finish,
            relay_hub_upload_cancel,
            relay_hub_response_ack,
            relay_hub_ws_connect,
            relay_hub_ws_send,
            relay_hub_ws_ack,
            relay_hub_ws_close,
            is_tray_available,
            get_close_behavior,
            set_close_behavior,
            set_shutdown_caller_client_id,
            acknowledge_desktop_close,
            answer_desktop_close,
            cancel_desktop_close,
            pick_and_read_agent_file
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    handle_native_window_close(window.app_handle().clone());
                }
            }
        })
        .setup(setup_app)
        .run(tauri::generate_context!())
        .expect("error while running lasterm");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;

    static INSTANCE_TEST_COUNTER: AtomicU16 = AtomicU16::new(0);

    #[test]
    fn reset_hub_pin_failure_returns_a_non_zero_command_status() {
        assert_eq!(
            report_reset_hub_pin_result(Err("store is unreadable".to_string())),
            1
        );
    }

    #[test]
    fn packaged_navigation_stays_on_the_parsed_app_origin() {
        #[cfg(windows)]
        let packaged_url = "http://tauri.localhost/";
        #[cfg(not(windows))]
        let packaged_url = "tauri://localhost/";

        assert!(allows_webview_navigation(
            &Url::parse(packaged_url).unwrap(),
            false
        ));

        for url in [
            "https://127.0.0.1:4100/",
            "https://tauri.localhost.example.com/",
            "https://evil.example/",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "http://localhost:5173/",
        ] {
            assert!(
                !allows_webview_navigation(&Url::parse(url).unwrap(), false),
                "packaged build accepted {url}"
            );
        }
    }

    #[test]
    fn development_navigation_adds_only_the_configured_vite_origin() {
        assert!(allows_webview_navigation(
            &Url::parse("http://localhost:5173/").unwrap(),
            true
        ));
        assert!(!allows_webview_navigation(
            &Url::parse("http://localhost:5174/").unwrap(),
            true
        ));
        assert!(!allows_webview_navigation(
            &Url::parse("http://localhost.evil.example:5173/").unwrap(),
            true
        ));
    }

    #[test]
    fn shell_navigation_predicate_uses_the_current_build_policy() {
        assert_eq!(
            allows_current_webview_navigation(&Url::parse("http://localhost:5173/").unwrap()),
            cfg!(dev)
        );
    }

    #[test]
    fn shell_new_window_policy_denies_every_target() {
        #[cfg(windows)]
        let packaged_url = "http://tauri.localhost/";
        #[cfg(not(windows))]
        let packaged_url = "tauri://localhost/";

        for url in [
            packaged_url,
            "https://evil.example/",
            "https://127.0.0.1:4100/",
            "about:blank",
        ] {
            assert!(
                !allows_webview_new_window(&Url::parse(url).unwrap()),
                "new-window policy accepted {url}"
            );
        }
    }

    struct TestWindowRaiseTarget {
        label: &'static str,
        unminimize_result: Result<(), String>,
        show_result: Result<(), String>,
        focus_result: Result<(), String>,
        attempts: Mutex<Vec<&'static str>>,
    }

    impl TestWindowRaiseTarget {
        fn new(
            unminimize_result: Result<(), String>,
            show_result: Result<(), String>,
            focus_result: Result<(), String>,
        ) -> Self {
            Self {
                label: "main",
                unminimize_result,
                show_result,
                focus_result,
                attempts: Mutex::new(Vec::new()),
            }
        }

        fn attempts(&self) -> Vec<&'static str> {
            self.attempts.lock().unwrap().clone()
        }
    }

    impl WindowRaiseTarget for TestWindowRaiseTarget {
        fn label(&self) -> &str {
            self.label
        }

        fn unminimize(&self) -> Result<(), String> {
            self.attempts.lock().unwrap().push("unminimize");
            self.unminimize_result.clone()
        }

        fn show(&self) -> Result<(), String> {
            self.attempts.lock().unwrap().push("show");
            self.show_result.clone()
        }

        fn focus(&self) -> Result<(), String> {
            self.attempts.lock().unwrap().push("focus");
            self.focus_result.clone()
        }
    }

    struct FragmentedReader {
        fragments: VecDeque<Vec<u8>>,
    }

    impl FragmentedReader {
        fn new(fragments: impl IntoIterator<Item = Vec<u8>>) -> Self {
            Self {
                fragments: fragments.into_iter().collect(),
            }
        }
    }

    impl Read for FragmentedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let Some(fragment) = self.fragments.pop_front() else {
                return Ok(0);
            };
            let used = buffer.len().min(fragment.len());
            buffer[..used].copy_from_slice(&fragment[..used]);
            if used < fragment.len() {
                self.fragments.push_front(fragment[used..].to_vec());
            }
            Ok(used)
        }
    }

    struct InstanceTestDir(PathBuf);

    impl std::ops::Deref for InstanceTestDir {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl AsRef<Path> for InstanceTestDir {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl InstanceTestDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for InstanceTestDir {
        fn drop(&mut self) {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "[lasterm] could not remove test directory {}: {error}",
                        self.0.display()
                    );
                }
            }
        }
    }

    fn instance_test_dir(name: &str) -> InstanceTestDir {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        let start = INSTANCE_TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        for attempt in 0..1024 {
            let path = base.join(format!(
                "lasterm-desktop-instance-{name}-{pid}-{start}-{attempt}"
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => return InstanceTestDir(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("could not create {}: {error}", path.display()),
            }
        }
        panic!(
            "could not allocate a unique test directory under {}",
            base.display()
        );
    }

    static HUB_CONNECTION_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct TestTlsPeer {
        port: u16,
        received_http_request: std::sync::mpsc::Receiver<bool>,
        thread: std::thread::JoinHandle<()>,
    }

    impl TestTlsPeer {
        fn start(key_pair: &rcgen::KeyPair) -> Self {
            use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
            use rustls::{ServerConfig, ServerConnection, StreamOwned};
            use std::io::{Read, Write};
            use std::net::TcpListener;

            let certificate = rcgen::CertificateParams::new(Vec::<String>::new())
                .unwrap()
                .self_signed(key_pair)
                .unwrap()
                .der()
                .clone();
            let private_key = key_pair.serialize_der();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let (received_http_request_sender, received_http_request) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                let config = ServerConfig::builder()
                    .with_no_client_auth()
                    .with_single_cert(
                        vec![certificate],
                        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(private_key)),
                    )
                    .unwrap();
                let (socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let connection = ServerConnection::new(Arc::new(config)).unwrap();
                let mut tls = StreamOwned::new(connection, socket);
                let mut request = [0_u8; 1024];
                let received = matches!(tls.read(&mut request), Ok(read) if read > 0);
                received_http_request_sender.send(received).unwrap();
                if received {
                    tls.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .unwrap();
                    tls.flush().unwrap();
                }
            });
            Self {
                port,
                received_http_request,
                thread,
            }
        }

        fn assert_http_request(self) {
            assert!(
                self.received_http_request
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap(),
                "the peer never received the unauthenticated first-use probe"
            );
            self.thread.join().unwrap();
        }

        fn assert_no_http_request(self) {
            assert!(
                !self
                    .received_http_request
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap(),
                "a peer with another key received HTTP bytes after TLS rejection"
            );
            self.thread.join().unwrap();
        }
    }

    fn unused_loopback_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[cfg(unix)]
    #[test]
    fn group_writable_runtime_directory_is_refused_with_its_path() {
        let dir = instance_test_dir("group-writable");
        let mut permissions = std::fs::metadata(&dir).unwrap().permissions();
        permissions.set_mode(0o770);
        std::fs::set_permissions(&dir, permissions).unwrap();

        let error = prepare_runtime_dir(&dir).unwrap_err();
        assert!(error.contains(&dir.display().to_string()));
        assert!(error.contains("group or other may write"));
    }

    #[cfg(unix)]
    #[test]
    fn relative_runtime_directory_is_refused_and_absent_directory_is_created_securely() {
        assert!(prepare_runtime_dir(Path::new("relative-runtime")).is_err());
        let dir = instance_test_dir("absent");
        let absent = dir.join("missing").join("lasterm");
        prepare_runtime_dir(&absent).unwrap();
        let metadata = std::fs::metadata(&absent).unwrap();
        assert!(metadata.is_dir());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn pin_survives_desktop_and_hub_restart_when_port_changes() {
        let _guard = HUB_CONNECTION_TEST_LOCK.lock().unwrap();
        let directory = instance_test_dir("pin-restart");
        let store_path = directory.join("desktop-state").join(HUB_PIN_STORE_FILE);
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let announced_spki = key_pair.public_key_der();
        let first_hub = TestTlsPeer::start(&key_pair);
        let first_port = first_hub.port;

        establish_hub_connection_at(&store_path, first_port, &announced_spki).unwrap();
        first_hub.assert_http_request();
        *HUB_CONNECTION.lock().unwrap() = None;
        HUB_PORT.store(0, Ordering::Relaxed);

        let restarted_hub = TestTlsPeer::start(&key_pair);
        assert_ne!(first_port, restarted_hub.port);
        establish_hub_connection_at(&store_path, restarted_hub.port, &announced_spki).unwrap();
        let response = send_relay_hub_request(
            &RelayHubRequest {
                method: "GET".to_string(),
                path: "/".to_string(),
                headers: Vec::new(),
                body: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(response.status().as_u16(), 204);
        restarted_hub.assert_http_request();

        let store = load_existing_hub_pin_store(&store_path).unwrap().unwrap();
        assert_eq!(store.pins.len(), 1, "the port never contributes to the pin key");
        assert_eq!(
            existing_hub_pin_at(&store_path, LOOPBACK_HUB_PIN_KEY).unwrap(),
            Some(announced_spki)
        );
        *HUB_CONNECTION.lock().unwrap() = None;
        HUB_PORT.store(0, Ordering::Relaxed);
    }

    #[test]
    fn first_pin_is_persisted_only_after_a_live_peer_proves_the_announced_key() {
        let _guard = HUB_CONNECTION_TEST_LOCK.lock().unwrap();
        let directory = instance_test_dir("first-pin-live-peer");
        let store_path = directory.join("desktop-state").join(HUB_PIN_STORE_FILE);
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let peer = TestTlsPeer::start(&key_pair);
        let announced_spki = key_pair.public_key_der();

        establish_hub_connection_at(&store_path, peer.port, &announced_spki).unwrap();
        peer.assert_http_request();

        let store = load_existing_hub_pin_store(&store_path).unwrap().unwrap();
        assert_eq!(store.pins.len(), 1, "the successful first use writes one pin");
        assert_eq!(
            existing_hub_pin_at(&store_path, LOOPBACK_HUB_PIN_KEY).unwrap(),
            Some(announced_spki)
        );
        *HUB_CONNECTION.lock().unwrap() = None;
        HUB_PORT.store(0, Ordering::Relaxed);
    }

    #[test]
    fn unreachable_first_use_leaves_the_store_empty() {
        let directory = instance_test_dir("first-pin-unreachable");
        let store_path = directory.join("desktop-state").join(HUB_PIN_STORE_FILE);
        let announced_spki = rcgen::KeyPair::generate().unwrap().public_key_der();

        let error = establish_hub_connection_at(&store_path, unused_loopback_port(), &announced_spki)
            .unwrap_err();

        assert!(error.contains("could not be reached"), "error: {error}");
        assert!(
            !store_path.exists() && !store_path.parent().unwrap().exists(),
            "an unreachable peer must not cause a durable pin-store write"
        );
    }

    #[test]
    fn different_first_use_peer_leaves_the_store_empty() {
        let directory = instance_test_dir("first-pin-different-peer");
        let store_path = directory.join("desktop-state").join(HUB_PIN_STORE_FILE);
        let announced_key_pair = rcgen::KeyPair::generate().unwrap();
        let peer_key_pair = rcgen::KeyPair::generate().unwrap();
        let peer = TestTlsPeer::start(&peer_key_pair);

        let error = establish_hub_connection_at(
            &store_path,
            peer.port,
            &announced_key_pair.public_key_der(),
        )
        .unwrap_err();

        assert!(
            error.contains("presented another TLS key"),
            "error: {error}; debug: {error:?}"
        );
        assert!(
            !store_path.exists() && !store_path.parent().unwrap().exists(),
            "a different peer key must not enter the pin store"
        );
        peer.assert_no_http_request();
    }

    #[test]
    fn malformed_first_use_record_leaves_the_store_empty() {
        let directory = instance_test_dir("first-pin-malformed-record");
        let store_path = directory.join("desktop-state").join(HUB_PIN_STORE_FILE);

        let error = establish_hub_connection_at(&store_path, 4444, &[1, 2, 3]).unwrap_err();

        assert!(error.contains("runtime record has a malformed TLS SPKI"), "error: {error}");
        assert!(
            !store_path.exists() && !store_path.parent().unwrap().exists(),
            "a malformed record must not create a pin store"
        );
    }

    #[cfg(unix)]
    #[test]
    fn writable_runtime_parent_authorizes_no_pin_or_connection() {
        let directory = instance_test_dir("runtime-writable-parent");
        let state_dir = directory.join("state");
        std::fs::create_dir(&state_dir).unwrap();
        std::fs::write(
            state_dir.join("runtime.json"),
            r#"{"port":4100,"spki":"AQID"}"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&state_dir).unwrap().permissions();
        permissions.set_mode(0o777);
        std::fs::set_permissions(&state_dir, permissions).unwrap();

        assert!(matches!(
            load_runtime_info_at(&state_dir.join("runtime.json")),
            RuntimeLoadResult::Unreadable(_)
        ));
        // The rejected record never gets as far as the first-use TLS proof;
        // no desktop pin-store directory exists and no connection can be set.
        assert!(!directory.join("desktop-state").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_runtime_record_authorizes_no_pin_or_connection() {
        use std::os::unix::fs::symlink;

        let directory = instance_test_dir("runtime-symlink");
        let state_dir = directory.join("state");
        std::fs::create_dir(&state_dir).unwrap();
        let target = directory.join("runtime-target.json");
        std::fs::write(&target, r#"{"port":4100,"spki":"AQID"}"#).unwrap();
        let mut target_permissions = std::fs::metadata(&target).unwrap().permissions();
        target_permissions.set_mode(0o600);
        std::fs::set_permissions(&target, target_permissions).unwrap();
        symlink(&target, state_dir.join("runtime.json")).unwrap();

        assert!(matches!(
            load_runtime_info_at(&state_dir.join("runtime.json")),
            RuntimeLoadResult::Unreadable(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_path_through_a_symlinked_parent_authorizes_no_pin_or_connection() {
        use std::os::unix::fs::symlink;

        let directory = instance_test_dir("runtime-parent-symlink");
        let state_dir = directory.join("state");
        std::fs::create_dir(&state_dir).unwrap();
        let runtime = state_dir.join("runtime.json");
        std::fs::write(&runtime, r#"{"port":4100,"spki":"AQID"}"#).unwrap();
        let mut permissions = std::fs::metadata(&runtime).unwrap().permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&runtime, permissions).unwrap();
        let linked_state_dir = directory.join("state-link");
        symlink(&state_dir, &linked_state_dir).unwrap();

        assert!(matches!(
            load_runtime_info_at(&linked_state_dir.join("runtime.json")),
            RuntimeLoadResult::Unreadable(_)
        ));
    }

    #[test]
    fn windows_local_app_data_absent_or_empty_is_refused() {
        for local_app_data in [None, Some(std::ffi::OsString::new())] {
            let error = windows_desktop_instance_lock_path(local_app_data).unwrap_err();
            assert!(error.contains("LOCALAPPDATA"));
        }
    }

    #[test]
    fn windows_relative_local_app_data_is_refused() {
        let error = windows_desktop_instance_lock_path(Some(std::ffi::OsString::from("relative")))
            .unwrap_err();
        assert!(error.contains("not absolute"));
        assert!(error.contains("relative"));
    }

    #[test]
    fn windows_local_app_data_creates_the_runtime_paths() {
        let local_app_data = instance_test_dir("windows-local-app-data");
        let lock_path =
            windows_desktop_instance_lock_path(Some(local_app_data.path().to_path_buf().into()))
                .unwrap();
        let runtime_dir = local_app_data.join("lasterm").join("runtime");

        assert_eq!(lock_path, runtime_dir.join("desktop-instance.lock"));
        assert!(runtime_dir.is_dir());
    }

    #[test]
    fn windows_local_app_data_that_is_not_a_directory_is_refused() {
        let dir = instance_test_dir("windows-local-app-data-file");
        let path = dir.join("not-a-directory");
        std::fs::write(&path, "not a directory").unwrap();

        let error = windows_desktop_instance_lock_path(Some(path.clone().into())).unwrap_err();
        assert!(error.contains(&path.display().to_string()));
    }

    #[test]
    fn windows_unc_local_app_data_is_refused_with_its_value() {
        let unc = r"\\server\share";
        let error =
            windows_desktop_instance_lock_path(Some(std::ffi::OsString::from(unc))).unwrap_err();
        assert!(error.contains(unc));
        assert!(error.contains("host-local"));
    }

    #[test]
    fn windows_runtime_validation_rejects_reparse_points() {
        let path = instance_test_dir("windows-reparse-point");
        let metadata = std::fs::symlink_metadata(&path).unwrap();

        let error = validate_windows_runtime_dir(&path, &metadata, true).unwrap_err();
        assert!(error.contains(&path.display().to_string()));
        assert!(error.contains("not a real directory"));
    }

    #[test]
    fn secondary_becomes_primary_when_the_holder_releases_during_retry() {
        let dir = instance_test_dir("handoff");
        let lock_path = dir.join("desktop.lock");
        let endpoint = desktop_raise_endpoint(&lock_path).unwrap();
        let holder = ProcessLock::try_acquire(&lock_path).unwrap().unwrap();
        let waiter = std::thread::spawn({
            let lock_path = lock_path.clone();
            move || acquire_desktop_instance_at(&lock_path, &endpoint)
        });

        std::thread::sleep(Duration::from_millis(150));
        drop(holder);
        assert!(matches!(
            waiter.join().unwrap().unwrap(),
            DesktopInstanceStartup::Primary(_)
        ));
    }

    /// A primary only binds its endpoint once setup has completed, so an early
    /// refusal must not prevent a later successful raise within the handoff
    /// budget.
    #[test]
    fn handoff_retries_the_endpoint_until_a_later_raise_succeeds() {
        let dir = instance_test_dir("handoff-retries-endpoint");
        let lock_path = dir.join("desktop.lock");
        let endpoint = desktop_raise_endpoint(&lock_path).unwrap();
        let _holder = ProcessLock::try_acquire(&lock_path).unwrap().unwrap();
        let attempts = Arc::new(AtomicU16::new(0));

        let result = acquire_desktop_instance_at_with_raise(&lock_path, &endpoint, {
            let attempts = attempts.clone();
            move |_| {
                if attempts.fetch_add(1, Ordering::Relaxed) == 0 {
                    RaiseRequestResult::Unanswered
                } else {
                    RaiseRequestResult::Raised
                }
            }
        });

        assert!(matches!(result.unwrap(), DesktopInstanceStartup::Secondary));
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
    }

    /// Kills the mutation that removes unminimize from a raise, leaving a
    /// normally tray-less-minimized main window unable to be restored.
    #[test]
    fn raise_unminimizes_before_showing_and_focusing() {
        let window = TestWindowRaiseTarget::new(Ok(()), Ok(()), Ok(()));

        run_window_raise_actions(&window).unwrap();

        assert_eq!(window.attempts(), ["unminimize", "show", "focus"]);
    }

    /// Kills the mutation that returns after the first failing operation and
    /// skips later raise operations. It also proves only `show()` establishes
    /// a successful raise: a no-op unminimize is not enough to make a hidden
    /// window visible.
    #[test]
    fn raise_continues_after_failures_and_requires_show() {
        let partial_success = TestWindowRaiseTarget::new(
            Err("unminimize failed".to_string()),
            Ok(()),
            Err("focus failed".to_string()),
        );

        assert!(run_window_raise_actions(&partial_success).is_ok());
        assert_eq!(partial_success.attempts(), ["unminimize", "show", "focus"]);

        let show_failed =
            TestWindowRaiseTarget::new(Ok(()), Err("show failed".to_string()), Ok(()));
        let error = run_window_raise_actions(&show_failed).unwrap_err();

        assert!(error.contains("cannot show window main"));
        assert_eq!(show_failed.attempts(), ["unminimize", "show", "focus"]);
    }

    struct TestWindowStartupTarget {
        show_result: Result<(), String>,
        focus_result: Result<(), String>,
        attempts: Mutex<Vec<&'static str>>,
    }

    impl TestWindowStartupTarget {
        fn new(show_result: Result<(), String>, focus_result: Result<(), String>) -> Self {
            Self {
                show_result,
                focus_result,
                attempts: Mutex::new(Vec::new()),
            }
        }

        fn attempts(&self) -> Vec<&'static str> {
            self.attempts.lock().unwrap().clone()
        }
    }

    impl WindowStartupTarget for TestWindowStartupTarget {
        fn show(&self) -> Result<(), String> {
            self.attempts.lock().unwrap().push("show");
            self.show_result.clone()
        }

        fn focus(&self) -> Result<(), String> {
            self.attempts.lock().unwrap().push("focus");
            self.focus_result.clone()
        }
    }

    /// A startup without a main window cannot end silently with no visible UI.
    #[test]
    fn startup_reports_a_missing_main_window_as_fatal() {
        assert_eq!(
            present_main_window_at_startup(None::<&TestWindowStartupTarget>),
            MainWindowStartupOutcome::Fatal("The main window is unavailable.".to_string())
        );
    }

    /// A native show error is fatal and retains the native diagnostic rather
    /// than leaving the application hidden without an explanation.
    #[test]
    fn startup_reports_a_native_show_error_as_fatal() {
        let window = TestWindowStartupTarget::new(
            Err("native compositor refused the window".to_string()),
            Ok(()),
        );

        assert_eq!(
            present_main_window_at_startup(Some(&window)),
            MainWindowStartupOutcome::Fatal(
                "The main window could not be shown: native compositor refused the window"
                    .to_string()
            )
        );
        assert_eq!(window.attempts(), ["show"]);
    }

    /// Focus does not make an already shown window unusable, but its failure is
    /// returned to the caller so startup logs it instead of discarding it.
    #[test]
    fn startup_reports_focus_failure_but_keeps_the_shown_window_usable() {
        let window = TestWindowStartupTarget::new(
            Ok(()),
            Err("native focus denied".to_string()),
        );

        assert_eq!(
            present_main_window_at_startup(Some(&window)),
            MainWindowStartupOutcome::Shown {
                focus_error: Some("native focus denied".to_string())
            }
        );
        assert_eq!(window.attempts(), ["show", "focus"]);
    }

    /// Kills the P1 mutation that selects a different authority when a shell
    /// lacks XDG_RUNTIME_DIR than when a desktop launcher exports it.
    #[cfg(unix)]
    #[test]
    fn desktop_lock_authority_is_identical_with_and_without_xdg_runtime_dir() {
        let base = instance_test_dir("stable-authority");
        let uid = 42_424;
        let graphical = unix_desktop_runtime_dir_for_environment_at(
            base.path(),
            uid,
            Some(std::ffi::OsStr::new("/run/user/1000")),
        );
        let shell = unix_desktop_runtime_dir_for_environment_at(base.path(), uid, None);
        assert_eq!(graphical, shell);

        std::fs::create_dir(&graphical).unwrap();
        let first = ProcessLock::try_acquire(&graphical.join("desktop-instance.lock"))
            .unwrap()
            .unwrap();
        assert!(
            ProcessLock::try_acquire(&shell.join("desktop-instance.lock"))
                .unwrap()
                .is_none()
        );
        drop(first);
    }

    /// Kills the P2 mutation that sends success immediately after queueing UI
    /// work rather than after the main thread has performed it.
    #[cfg(unix)]
    #[test]
    fn raise_reply_is_sent_only_after_the_main_thread_action_runs() {
        let dir = instance_test_dir("raise-completion");
        let path = dir.join("desktop-raise.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (queued_tx, queued_rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handle_desktop_raise_connection(&mut stream, move || {
                run_after_main_thread_action(
                    move |action| queued_tx.send(action).map_err(|error| error.to_string()),
                    || Ok(()),
                )
            });
        });
        let (reply_tx, reply_rx) = mpsc::channel();
        let client = std::thread::spawn(move || {
            let mut stream = UnixStream::connect(path).unwrap();
            stream.write_all(INSTANCE_RAISE_REQUEST).unwrap();
            stream.shutdown(std::net::Shutdown::Write).unwrap();
            let mut reply = Vec::new();
            stream.read_to_end(&mut reply).unwrap();
            reply_tx.send(reply).unwrap();
        });

        let action = queued_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(reply_rx.recv_timeout(Duration::from_millis(50)).is_err());
        action();
        assert_eq!(
            reply_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            INSTANCE_RAISE_SUCCESS
        );
        client.join().unwrap();
        server.join().unwrap();
    }

    /// Kills the P3 mutation that treats a primary's explicit failure response
    /// as if it were a successful raise and exits this process with status 0.
    #[cfg(unix)]
    #[test]
    fn failure_reply_from_the_primary_is_reported() {
        let dir = instance_test_dir("raise-failure");
        let lock_path = dir.join("desktop.lock");
        let endpoint = desktop_raise_endpoint(&lock_path).unwrap();
        let listener = UnixListener::bind(&endpoint.path).unwrap();
        let holder = ProcessLock::try_acquire(&lock_path).unwrap().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handle_desktop_raise_connection(&mut stream, || Err("window unavailable".to_string()));
        });

        let error = match acquire_desktop_instance_at(&lock_path, &endpoint) {
            Err(error) => error,
            Ok(_) => panic!("a failure reply must not be treated as a successful secondary"),
        };
        assert!(error.contains("could not show its window"));
        drop(holder);
        server.join().unwrap();
    }

    /// Kills the P3 mutation that exits after an unanswered connection instead
    /// of retrying the lock, which is the handoff race after a dead primary.
    #[cfg(unix)]
    #[test]
    fn no_reply_retries_the_lock_and_becomes_primary() {
        let dir = instance_test_dir("raise-no-reply");
        let lock_path = dir.join("desktop.lock");
        let endpoint = desktop_raise_endpoint(&lock_path).unwrap();
        let listener = UnixListener::bind(&endpoint.path).unwrap();
        let holder = ProcessLock::try_acquire(&lock_path).unwrap().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            std::thread::sleep(INSTANCE_RAISE_TIMEOUT + Duration::from_millis(50));
        });
        let waiter = std::thread::spawn({
            let lock_path = lock_path.clone();
            let endpoint = endpoint.clone();
            move || acquire_desktop_instance_at(&lock_path, &endpoint)
        });

        std::thread::sleep(Duration::from_millis(100));
        drop(holder);
        assert!(matches!(
            waiter.join().unwrap().unwrap(),
            DesktopInstanceStartup::Primary(_)
        ));
        server.join().unwrap();
    }

    /// Kills the P5 mutation that leaves a stale Unix socket preventing the
    /// next lock holder from binding its listener.
    #[cfg(unix)]
    #[test]
    fn stale_desktop_raise_socket_is_replaced_by_the_next_primary() {
        let dir = instance_test_dir("stale-raise-socket");
        let path = dir.join("desktop-raise.sock");
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        let listener = bind_desktop_raise_socket(&path).unwrap();
        assert!(path.exists());
        drop(listener);
    }

    /// Kills the P5 mutation that releases the lock while leaving the socket
    /// name behind after a normal primary shutdown.
    #[cfg(unix)]
    #[test]
    fn desktop_raise_listener_cleanup_removes_its_socket_before_lock_release() {
        let dir = instance_test_dir("raise-listener-cleanup");
        let path = dir.join("desktop-raise.sock");
        drop(UnixListener::bind(&path).unwrap());
        let listener = DesktopRaiseListener {
            stop: Arc::new(AtomicBool::new(false)),
            path: path.clone(),
        };
        drop(listener);
        assert!(!path.exists());
    }

    /// Kills the P4 mutation that accepts an arbitrary local socket payload as
    /// a raise request. Invalid bytes receive no response and never invoke UI.
    #[test]
    fn unknown_or_oversized_raise_request_is_rejected_without_action() {
        let oversized = vec![b'x'; INSTANCE_RAISE_MAX_BYTES];
        for request in [b"unknown\n".as_slice(), oversized.as_slice()] {
            let mut stream = std::io::Cursor::new(request.to_vec());
            let invoked = Arc::new(AtomicBool::new(false));
            let action_invoked = invoked.clone();
            handle_desktop_raise_connection(&mut stream, move || {
                action_invoked.store(true, Ordering::Relaxed);
                Ok(())
            });
            assert!(!invoked.load(Ordering::Relaxed));
            assert_eq!(stream.into_inner(), request);
        }
    }

    #[test]
    fn fragmented_raise_message_is_read_to_its_delimiter() {
        let mut reader = FragmentedReader::new([b"raise-".to_vec(), b"v1\n".to_vec()]);

        assert_eq!(
            read_delimited_raise_message(&mut reader).unwrap(),
            Some(INSTANCE_RAISE_REQUEST.to_vec())
        );
    }

    #[test]
    fn unterminated_raise_message_at_the_byte_cap_is_refused() {
        let mut reader = FragmentedReader::new([vec![b'x'; INSTANCE_RAISE_MAX_BYTES]]);

        assert_eq!(read_delimited_raise_message(&mut reader).unwrap(), None);
    }

    /// The complete first-use anchor written by the hub: the child-owned stdout
    /// carries both its OS-assigned port and the public key to pin.
    #[test]
    fn listening_port_comes_from_the_hub_announcement() {
        assert_eq!(
            parse_listening_port(
                "lasterm hub listening on https://127.0.0.1:45999 (spki: AQID) (build: 5c31e75)"
            ),
            Some(45999)
        );
        assert_eq!(
            parse_listening_announcement(
                "lasterm hub listening on https://127.0.0.1:45999 (spki: AQID) (build: 5c31e75)"
            ),
            Some(HubAnnouncement { port: 45999, spki: vec![1, 2, 3] })
        );
    }

    #[test]
    fn a_line_that_does_not_announce_a_port_yields_none() {
        // Startup treats `None` as "not ready yet", so anything this accepts by
        // mistake becomes the port the client talks to.
        for line in [
            "",
            "lasterm hub listening on http://127.0.0.1:",
            "lasterm hub listening on http://127.0.0.1:0",
            "lasterm hub listening on http://127.0.0.1:99999", // beyond u16
            "lasterm hub listening on http://10.0.0.5:4100",   // not loopback
            "Config dir : /home/someone/.config/lasterm",
            "listening on http://127.0.0.1", // no colon, no port
            // Prose that contains the announcement rather than being it. A substring
            // match read 4444 out of each of these.
            "warning: not listening on http://127.0.0.1:4444 because unavailable",
            "retrying: lasterm hub listening on http://127.0.0.1:4444 failed",
            "lasterm hub listening on http://127.0.0.1:4444garbage",
            "lasterm hub listening on http://127.0.0.1:4444/api",
            // A leading space defeated the start anchor while a trailing word passed
            // the end one, so the whole line parsed as an announcement.
            " lasterm hub listening on http://127.0.0.1:4444 failed",
            "lasterm hub listening on http://127.0.0.1:4444 failed",
            "lasterm hub listening on http://127.0.0.1:4444 (retrying)",
            // Malformed tails that begin with the allowed prefix.
            "lasterm hub listening on http://127.0.0.1:4444 (build:",
            "lasterm hub listening on http://127.0.0.1:4444 (build: failed) not serving",
            "lasterm hub listening on http://127.0.0.1:4444 (build: a b)",
            // These were valid before the SPKI travelled on the trusted pipe.
            "lasterm hub listening on https://127.0.0.1:4100",
            "lasterm hub listening on https://127.0.0.1:4100 (build: old)",
            "lasterm hub listening on https://127.0.0.1:4100 (spki: ) (build: new)",
            "lasterm hub listening on https://127.0.0.1:4100 (spki: not-base64) (build: new)",
            "lasterm hub listening on https://127.0.0.1:4100 (spki: AQID) (build: new) trailing",
        ] {
            assert_eq!(parse_listening_port(line), None, "line: {line:?}");
        }
    }

    /// An exit is final: a stdout line arriving after termination must not put the
    /// child back into service. The launch path reads one cell and acts on it, so a
    /// resurrected `Serving` would send the client at a port whose process is gone.
    #[test]
    fn an_exit_is_never_overwritten_by_a_late_announcement() {
        // Serialised by the shared static this test drives; the launch path does not
        // run under `cargo test`, so nothing else writes it.
        let first = HubAnnouncement {
            port: 4137,
            spki: vec![1],
        };
        publish_hub_state(HubState::Serving(first.clone()));
        assert_eq!(hub_state(), HubState::Serving(first));

        publish_hub_state(HubState::Exited(Some(73)));
        assert_eq!(hub_state(), HubState::Exited(Some(73)));

        publish_hub_state(HubState::Serving(HubAnnouncement {
            port: 4200,
            spki: vec![2],
        }));
        assert_eq!(
            hub_state(),
            HubState::Exited(Some(73)),
            "a late announcement resurrected a child that had already gone"
        );

        // A later exit still replaces an earlier one: the last word on how it went.
        publish_hub_state(HubState::Exited(None));
        assert_eq!(hub_state(), HubState::Exited(None));
    }

    static CLOSE_BEHAVIOR_TEST_COUNTER: AtomicU16 = AtomicU16::new(0);

    struct CloseBehaviorTestFixture(PathBuf);

    impl CloseBehaviorTestFixture {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for CloseBehaviorTestFixture {
        fn drop(&mut self) {
            let Some(parent) = self.0.parent() else {
                return;
            };
            if let Err(error) = std::fs::remove_dir_all(parent) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "[lasterm] could not remove test directory {}: {error}",
                        parent.display()
                    );
                }
            }
        }
    }

    fn close_behavior_test_path(name: &str) -> CloseBehaviorTestFixture {
        let unique = format!(
            "lasterm-close-behavior-{name}-{}-{}",
            std::process::id(),
            CLOSE_BEHAVIOR_TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        CloseBehaviorTestFixture(
            std::env::temp_dir()
                .join(unique)
                .join("close-behavior.json"),
        )
    }

    #[test]
    fn stored_tray_behavior_reads_as_hide() {
        let fixture = close_behavior_test_path("tray");
        let path = fixture.path();
        std::fs::create_dir_all(path.parent().expect("test path parent")).expect("create test dir");
        std::fs::write(path, r#"{"closeBehavior":"tray"}"#).expect("write test config");

        assert_eq!(
            read_close_behavior_from_path(path),
            CloseBehaviorConfigState::Stored(CloseBehavior::Hide)
        );
    }

    #[test]
    fn unknown_or_unreadable_close_behavior_is_not_a_decision() {
        let fixture = close_behavior_test_path("invalid");
        let path = fixture.path();
        std::fs::create_dir_all(path.parent().expect("test path parent")).expect("create test dir");
        std::fs::write(path, r#"{"closeBehavior":"destroy"}"#).expect("write test config");

        assert_eq!(
            read_close_behavior_from_path(path),
            CloseBehaviorConfigState::Unreadable
        );
        assert_eq!(
            close_behavior_command_result(read_close_behavior_from_path(path)),
            Err("failed to read close preference".to_string())
        );

        std::fs::remove_file(path).expect("remove test config");
        assert_eq!(
            read_close_behavior_from_path(path),
            CloseBehaviorConfigState::Missing
        );
        assert_eq!(
            close_behavior_command_result(read_close_behavior_from_path(path)),
            Ok(CloseBehavior::Ask)
        );
    }

    #[test]
    fn written_close_behavior_is_readable_without_a_window() {
        let fixture = close_behavior_test_path("round-trip");
        let path = fixture.path();

        write_close_behavior_to_path(path, CloseBehavior::Quit).expect("write close preference");

        assert_eq!(
            read_close_behavior_from_path(path),
            CloseBehaviorConfigState::Stored(CloseBehavior::Quit)
        );
    }

    #[test]
    fn interrupted_close_behavior_replace_keeps_the_previous_preference() {
        let fixture = close_behavior_test_path("interrupted-replace");
        let path = fixture.path();
        write_close_behavior_to_path(path, CloseBehavior::Ask).expect("write initial preference");

        let error = write_close_behavior_to_path_with_replace(path, CloseBehavior::Quit, |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "simulated interrupted replace",
            ))
        })
        .expect_err("interrupted replace must fail");

        assert!(error.contains("failed to replace close preference"));
        assert_eq!(
            read_close_behavior_from_path(path),
            CloseBehaviorConfigState::Stored(CloseBehavior::Ask)
        );
    }

    #[test]
    fn msix_package_identity_statuses_are_classified_fail_closed() {
        assert_eq!(
            classify_package_identity_status(ERROR_INSUFFICIENT_BUFFER),
            PackageIdentityProbe::Packaged {
                status: ERROR_INSUFFICIENT_BUFFER
            }
        );
        assert_eq!(
            classify_package_identity_status(0),
            PackageIdentityProbe::Packaged { status: 0 }
        );
        // APPMODEL_ERROR_NO_PACKAGE: an unpackaged Win32 process.
        assert_eq!(
            classify_package_identity_status(APPMODEL_ERROR_NO_PACKAGE),
            PackageIdentityProbe::Unpackaged
        );
        assert_eq!(
            classify_package_identity_status(5),
            PackageIdentityProbe::Inconclusive { status: 5 }
        );
    }

    #[test]
    fn missing_package_identity_symbol_is_unpacked_for_windows_7_support() {
        assert_eq!(
            classify_package_identity_lookup_error(ERROR_PROC_NOT_FOUND),
            PackageIdentityProbe::Unpackaged
        );
    }

    #[test]
    fn unexpected_package_identity_lookup_failure_is_inconclusive() {
        assert_eq!(
            classify_package_identity_lookup_error(5),
            PackageIdentityProbe::Inconclusive { status: 5 }
        );
    }

    fn test_target() -> HubQuitTarget {
        HubQuitTarget {
            pid: 42,
            instance_id: "target".to_string(),
        }
    }

    #[test]
    fn declined_native_conflict_keeps_the_hub_and_app_open() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(id) = coordinator.begin() else {
            panic!("first gesture must start an attempt");
        };
        assert!(matches!(
            coordinator.request_finished(id, false, QuitRequestResult::Conflict(Some(2))),
            QuitAction::AskNative { others: Some(2) }
        ));

        assert!(matches!(
            coordinator.resolve_native_consent(false),
            QuitAction::Ignore
        ));
        assert!(matches!(
            coordinator.request_finished(
                id,
                false,
                QuitRequestResult::Committed {
                    target: test_target(),
                    diagnostic: None
                }
            ),
            QuitAction::Ignore
        ));
        assert!(coordinator.active.is_none());
    }

    #[test]
    fn a_second_gesture_joins_the_active_attempt() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(_) = coordinator.begin() else {
            panic!("first gesture must start an attempt");
        };
        assert!(matches!(coordinator.begin(), QuitStart::InProgress));
        assert_eq!(coordinator.next_id, 1);
    }

    #[test]
    fn native_conflict_confirmation_sends_the_override() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(id) = coordinator.begin() else {
            panic!("first gesture must start an attempt");
        };
        assert!(matches!(
            coordinator.resolve_native_consent(true),
            QuitAction::Ignore
        ));
        assert!(matches!(
            coordinator.request_finished(id, false, QuitRequestResult::Conflict(Some(3))),
            QuitAction::AskNative { others: Some(3) }
        ));
        assert!(matches!(
            coordinator.resolve_native_consent(true),
            QuitAction::SendForced { attempt_id } if attempt_id == id
        ));
    }

    #[test]
    fn lost_quit_response_is_observed_instead_of_reported_as_a_failure() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(id) = coordinator.begin() else {
            panic!("first gesture must start an attempt");
        };

        assert!(matches!(
            coordinator.request_finished(id, false, QuitRequestResult::Unobserved(test_target())),
            QuitAction::Observe { attempt_id, .. } if attempt_id == id
        ));
    }

    #[test]
    fn missing_runtime_record_fails_instead_of_exiting_the_app() {
        assert!(matches!(
            missing_runtime_record_quit_result(),
            QuitRequestResult::Failed(message) if message.contains("runtime record is missing")
        ));
    }

    #[test]
    fn desktop_quit_uses_the_hub_quit_endpoint_that_ends_the_agent() {
        assert_eq!(hub_quit_url(4100, false), "https://127.0.0.1:4100/api/quit");
        assert_eq!(
            hub_quit_url(4100, true),
            "https://127.0.0.1:4100/api/quit?force=1"
        );
    }

    #[test]
    fn unreadable_runtime_never_proves_the_hub_stopped() {
        let error = observe_hub_quit_with(
            &test_target(),
            || RuntimeLoadResult::Unreadable("corrupt JSON".to_string()),
            |_| false,
            Duration::ZERO,
        )
        .expect_err("unreadable runtime must fail observation");
        assert!(error.contains("cannot be read"));
    }

    // Unix only: the helper it exercises is the POSIX errno rule. Windows
    // expresses the same fail-closed rule over parsed `tasklist` output.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn inconclusive_pid_probe_never_proves_the_hub_stopped() {
        assert!(pid_probe_reports_alive(Err(None)));
        let error = observe_hub_quit_with(
            &test_target(),
            || RuntimeLoadResult::Absent,
            |_| true,
            Duration::ZERO,
        )
        .expect_err("a probe error is live, not proof of teardown");
        assert!(error.contains("PID remains live"));
    }

    #[test]
    fn connection_refusal_is_reported_as_a_transport_failure_not_observation() {
        let error = reqwest::blocking::Client::builder()
            .build()
            .expect("client")
            .post("http://127.0.0.1:0/api/quit")
            .send()
            .expect_err("port zero refuses connections");
        assert!(matches!(
            classify_quit_transport_error(error, test_target()),
            QuitRequestResult::Failed(message) if message.contains("was not sent")
        ));
    }

    #[test]
    fn observation_window_covers_request_stopper_and_graceful_shutdown_bounds() {
        assert_eq!(
            HUB_QUIT_OBSERVE_TIMEOUT,
            Duration::from_millis(HUB_QUIT_REQUEST_TIMEOUT_MS)
                + Duration::from_millis(HUB_AGENT_STOP_TIMEOUT_MS)
                + Duration::from_millis(HUB_GRACEFUL_SHUTDOWN_TIMEOUT_MS)
        );
    }

    #[test]
    fn replacement_hub_is_not_the_target_having_stopped() {
        let error = observe_hub_quit_with(
            &test_target(),
            || {
                RuntimeLoadResult::Present(RuntimeInfo {
                    pid: Some(99),
                    port: 4101,
                    instance_id: Some("replacement".to_string()),
                    owner_token: None,
                    spki: None,
                })
            },
            |_| false,
            Duration::ZERO,
        )
        .expect_err("replacement must fail observation");
        assert!(error.contains("replacement hub"));
    }

    #[test]
    fn a_503_observes_teardown_then_reports_the_hub_diagnostic() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(id) = coordinator.begin() else {
            panic!("starts")
        };
        let result = classify_quit_response(
            503,
            r#"{"message":"agent socket did not answer"}"#,
            test_target(),
        );
        let action = coordinator.request_finished(id, false, result);
        let QuitAction::Observe { diagnostic, .. } = action else {
            panic!("must observe")
        };
        assert_eq!(diagnostic.as_deref(), Some("agent socket did not answer"));
        assert!(matches!(
            coordinator.observation_finished(id, Ok(()), diagnostic),
            QuitAction::ExitWithDiagnostic(message) if message == "agent socket did not answer"
        ));
    }

    #[test]
    fn forced_refusal_fails_instead_of_asking_a_second_time() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(id) = coordinator.begin() else {
            panic!("starts")
        };
        let _ = coordinator.request_finished(id, false, QuitRequestResult::Conflict(None));
        let _ = coordinator.resolve_native_consent(true);
        assert!(matches!(
            coordinator.request_finished(id, true, QuitRequestResult::Conflict(None)),
            QuitAction::Failed(message) if message.contains("refused again")
        ));
    }

    #[test]
    fn native_close_has_an_attempt_before_any_webview_acknowledges_it() {
        let mut coordinator = WindowCloseCoordinator::default();
        assert!(matches!(coordinator.begin(), WindowCloseStart::Started(1)));
        assert!(matches!(coordinator.begin(), WindowCloseStart::InProgress));
    }

    #[test]
    fn tray_quit_without_a_window_uses_native_dialog_flow() {
        let mut coordinator = QuitCoordinator::default();
        let QuitStart::Started(id) = coordinator.begin() else {
            panic!("starts")
        };
        assert!(matches!(
            coordinator.request_finished(id, false, QuitRequestResult::Conflict(None)),
            QuitAction::AskNative { others: None }
        ));
        assert!(matches!(
            coordinator.resolve_native_consent(true),
            QuitAction::SendForced { attempt_id } if attempt_id == id
        ));
    }

    #[test]
    fn unacknowledged_webview_stops_before_the_next_hub_message() {
        let read_count = Arc::new(AtomicUsize::new(0));
        let (second_read_sender, second_read_received) = mpsc::channel();
        let delivered = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let delivered_for_channel = delivered.clone();
        let (first_frame_sender, first_frame_received) = mpsc::channel();
        let channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody> =
            tauri::ipc::Channel::new(move |body| {
                let tauri::ipc::InvokeResponseBody::Raw(bytes) = body else {
                    panic!("the relay must send raw binary IPC frames");
                };
                delivered_for_channel.lock().unwrap().push(bytes);
                let _ = first_frame_sender.send(());
                Ok(())
            });
        let (hub_sender, mut hub_receiver) = tokio::sync::mpsc::channel(2);
        hub_sender
            .try_send(vec![1; HUB_WS_MAX_MESSAGE_BYTES])
            .expect("queue first hub message");
        hub_sender
            .try_send(vec![2; HUB_WS_MAX_MESSAGE_BYTES])
            .expect("queue second hub message");
        let (_ack_sender, mut acknowledgements) = tokio::sync::mpsc::channel(1);
        let acknowledgement_pending = Arc::new(AtomicBool::new(false));
        let (_close_sender, mut close) = tokio::sync::mpsc::unbounded_channel();
        let reads = read_count.clone();

        let task = tauri::async_runtime::spawn(async move {
            while let Some(message) = hub_receiver.recv().await {
                if reads.fetch_add(1, Ordering::SeqCst) == 1 {
                    let _ = second_read_sender.send(());
                }
                let end =
                    relay_hub_ws_binary(message, &channel, &mut acknowledgements, &acknowledgement_pending, &mut close).await;
                if !matches!(end, HubWsRelayEnd::Closed) {
                    break;
                }
            }
        });
        first_frame_received
            .recv_timeout(Duration::from_secs(1))
            .expect("the first relay frame reaches the webview");

        // The second hub message is already queued. Wait for the loop to prove
        // it read that message before tearing it down: with the acknowledgement
        // wait removed, this event arrives immediately; with it present, the
        // bounded wait expires while the first IPC frame remains unacknowledged.
        assert!(matches!(
            second_read_received.recv_timeout(Duration::from_millis(250)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        task.abort();

        assert_eq!(
            read_count.load(Ordering::SeqCst),
            1,
            "without an ACK the relay must not read a second hub message"
        );
        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1, "only one IPC frame may await an ACK");
        assert!(
            delivered[0].len() <= RELAY_CHUNK_BYTES + 1,
            "the one pending IPC frame is bounded to its marker plus 256 KiB"
        );
        assert!(
            HUB_WS_MAX_MESSAGE_BYTES + delivered[0].len() <= HUB_WS_OUTPUT_BUFFERED_BYTES,
            "the native output relay holds at most one 512 KiB WebSocket message and one 256 KiB IPC frame"
        );
    }

    #[test]
    fn failed_upload_chunk_releases_its_slot() {
        let before = hub_uploads().lock().unwrap().len();
        let id = NEXT_RELAY_ID.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let (_response_sender, response) = mpsc::channel();
        hub_uploads().lock().unwrap().insert(id, HubUpload { sender, response });

        assert!(send_hub_upload_chunk(id, vec![1]).is_err());
        let after = hub_uploads().lock().unwrap().len();
        assert_eq!(before, after, "a rejected chunk must release its upload slot");
    }

    #[test]
    fn acknowledgement_requires_an_outstanding_frame() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let pending = AtomicBool::new(false);

        accept_hub_ws_ack(&sender, &pending);
        assert!(receiver.try_recv().is_err(), "an early ACK must be discarded");

        pending.store(true, Ordering::Release);
        accept_hub_ws_ack(&sender, &pending);
        accept_hub_ws_ack(&sender, &pending);
        assert!(receiver.try_recv().is_ok(), "the outstanding frame gets one ACK");
        assert!(receiver.try_recv().is_err(), "a duplicate ACK must be discarded");
    }

    #[test]
    fn acknowledged_webview_reads_the_next_hub_message() {
        let read_count = Arc::new(AtomicUsize::new(0));
        let (second_read_sender, second_read_received) = mpsc::channel();
        let (frame_sender, frame_received) = mpsc::channel();
        let channel: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody> =
            tauri::ipc::Channel::new(move |body| {
                let tauri::ipc::InvokeResponseBody::Raw(_) = body else {
                    panic!("the relay must send raw binary IPC frames");
                };
                let _ = frame_sender.send(());
                Ok(())
            });
        let (hub_sender, mut hub_receiver) = tokio::sync::mpsc::channel(2);
        hub_sender
            .try_send(vec![1; HUB_WS_MAX_MESSAGE_BYTES])
            .expect("queue first hub message");
        hub_sender
            .try_send(vec![2; HUB_WS_MAX_MESSAGE_BYTES])
            .expect("queue second hub message");
        let (ack_sender, mut acknowledgements) = tokio::sync::mpsc::channel(1);
        let acknowledgement_pending = Arc::new(AtomicBool::new(false));
        let (_close_sender, mut close) = tokio::sync::mpsc::unbounded_channel();
        let reads = read_count.clone();

        let task = tauri::async_runtime::spawn(async move {
            while let Some(message) = hub_receiver.recv().await {
                if reads.fetch_add(1, Ordering::SeqCst) == 1 {
                    let _ = second_read_sender.send(());
                }
                let end =
                    relay_hub_ws_binary(message, &channel, &mut acknowledgements, &acknowledgement_pending, &mut close).await;
                if !matches!(end, HubWsRelayEnd::Closed) {
                    break;
                }
            }
        });

        for _ in 0..2 {
            frame_received
                .recv_timeout(Duration::from_secs(1))
                .expect("the first hub message reaches the webview in bounded frames");
            ack_sender
                .try_send(())
                .expect("acknowledge the delivered IPC frame");
        }
        second_read_received
            .recv_timeout(Duration::from_secs(1))
            .expect("acknowledging every first-message frame lets the relay read the second");
        task.abort();

        assert_eq!(
            read_count.load(Ordering::SeqCst),
            2,
            "after its first message is acknowledged the relay reads the queued second message"
        );
    }
}
