use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Stores the resolved hub port after startup (default 4100).
static HUB_PORT: AtomicU16 = AtomicU16::new(4100);
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_CALLER_CLIENT_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static QUIT_COORDINATOR: OnceLock<Mutex<QuitCoordinator>> = OnceLock::new();
static WINDOW_CLOSE_COORDINATOR: OnceLock<Mutex<WindowCloseCoordinator>> = OnceLock::new();
static CLOSE_BEHAVIOR_TEMP_COUNTER: AtomicU16 = AtomicU16::new(0);
// These mirror the bounds in the hub. A request can take the full client
// timeout, then the hub's agent stopper can use its bound, then graceful
// shutdown has its own bound before it deletes runtime.json.
const HUB_AGENT_STOP_TIMEOUT_MS: u64 = 12_000;
const HUB_QUIT_RESPONSE_SLACK_MS: u64 = 3_000;
const HUB_QUIT_REQUEST_TIMEOUT_MS: u64 = HUB_AGENT_STOP_TIMEOUT_MS + HUB_QUIT_RESPONSE_SLACK_MS;
const HUB_QUIT_REQUEST_TIMEOUT: Duration = Duration::from_millis(HUB_QUIT_REQUEST_TIMEOUT_MS);
const HUB_GRACEFUL_SHUTDOWN_TIMEOUT_MS: u64 = 10_000;
const HUB_QUIT_OBSERVE_TIMEOUT: Duration = Duration::from_millis(
    HUB_QUIT_REQUEST_TIMEOUT_MS + HUB_AGENT_STOP_TIMEOUT_MS + HUB_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
);
const HUB_QUIT_OBSERVE_POLL: Duration = Duration::from_millis(50);
const WINDOW_CLOSE_PRESENTATION_ACK_TIMEOUT: Duration = Duration::from_secs(1);
const WINDOW_CLOSE_ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_AGENT_BINARY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_AGENT_MANIFEST_BYTES: u64 = 1024 * 1024;
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

/// Resolves the per-user Termora configuration directory.
fn termora_config_dir() -> Option<PathBuf> {
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

    Some(config_dir.join("termora"))
}

/// Resolves the hub config directory and reads the auth token from auth.json.
/// Returns `Some(token)` only if the token is a valid 64-char lowercase hex string.
fn read_hub_auth_token() -> Option<String> {
    let config_dir = termora_config_dir()?;

    let auth_path = config_dir.join("auth.json");
    eprintln!("[termora] checking auth.json at: {}", auth_path.display());
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
    termora_config_dir().map(|config_dir| config_dir.join("close-behavior.json"))
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

/// Resolves the termora state directory:
/// - Linux/macOS: $XDG_STATE_HOME/termora or ~/.local/state/termora
/// - Windows: %LOCALAPPDATA%\termora
fn get_state_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|p| std::path::PathBuf::from(p).join("termora"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("XDG_STATE_HOME")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
            .map(|p| p.join("termora"))
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
    let runtime_path = state_dir.join("runtime.json");
    let contents = match std::fs::read_to_string(&runtime_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return RuntimeLoadResult::Absent
        }
        Err(error) => return RuntimeLoadResult::Unreadable(error.to_string()),
    };
    match serde_json::from_str(&contents) {
        Ok(runtime) => RuntimeLoadResult::Present(runtime),
        Err(error) => RuntimeLoadResult::Unreadable(error.to_string()),
    }
}

fn shutdown_caller_client_id() -> &'static Mutex<Option<String>> {
    SHUTDOWN_CALLER_CLIENT_ID.get_or_init(|| Mutex::new(None))
}

fn current_shutdown_caller_client_id() -> Option<String> {
    shutdown_caller_client_id().lock().ok()?.clone()
}

/// Reads the hub port from runtime.json in the state dir.
#[cfg(not(dev))]
fn read_runtime_port() -> Option<u16> {
    match load_runtime_info() {
        RuntimeLoadResult::Present(runtime) => Some(runtime.port),
        RuntimeLoadResult::Absent | RuntimeLoadResult::Unreadable(_) => None,
    }
}

/// Checks whether a hub is alive by probing its /api/health endpoint.
#[cfg(not(dev))]
fn is_hub_alive(port: u16) -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    matches!(
        client.get(format!("http://localhost:{}/api/health", port)).send(),
        Ok(resp) if resp.status().is_success()
    )
}

#[tauri::command]
fn get_hub_auth_token() -> Option<String> {
    let result = read_hub_auth_token();
    match &result {
        Some(_) => eprintln!("[termora] auto-auth: token found in auth.json"),
        None => eprintln!("[termora] auto-auth: no valid token in auth.json"),
    }
    result
}

/// Returns the resolved hub port (set at startup, cached in HUB_PORT).
#[tauri::command]
fn get_hub_port() -> u16 {
    HUB_PORT.load(Ordering::Relaxed)
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

    let client = match reqwest::blocking::Client::builder()
        .timeout(HUB_QUIT_REQUEST_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return QuitRequestResult::Failed(error.to_string()),
    };
    let owner_header = match owner_token.parse::<reqwest::header::HeaderValue>() {
        Ok(header) => header,
        Err(error) => {
            return QuitRequestResult::Failed(format!(
                "quit request was not sent because its owner header is invalid: {error}"
            ))
        }
    };
    let url = hub_quit_url(runtime.port, force);
    let mut request = client.post(url).header("X-Termora-Owner", owner_header);
    if let Some(client_id) = current_shutdown_caller_client_id() {
        request = request.header("X-Termora-Client-Id", client_id);
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
    eprintln!("[termora] quit response was not observed: {error}");
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
    format!("http://127.0.0.1:{port}/api/quit{force_query}")
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
        .message(format!("{subject} are connected. Quit Termora anyway?"))
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
        .message("Quit Termora completely?")
        .title("Quit Termora")
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
    // System tray
    let show = MenuItemBuilder::with_id("show", "Show Termora").build(app)?;
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
            eprintln!("[termora] failed to initialize tray: {}", error);
        }
    }

    // In release mode, spawn the hub sidecar
    #[cfg(not(dev))]
    {
        use tauri_plugin_shell::ShellExt;

        // Check if a hub is already running by reading runtime.json.
        // The hub writes this file with the actual listening port after bind.
        let mut hub_port: u16 = 4100;
        let mut need_spawn = true;

        if let Some(port) = read_runtime_port() {
            if is_hub_alive(port) {
                eprintln!(
                    "[termora] found existing hub on port {} (from runtime.json)",
                    port
                );
                hub_port = port;
                need_spawn = false;
            }
        }

        if need_spawn {
            let sidecar = app.shell().sidecar("termora-hub").unwrap().args(["start"]);
            let (mut rx, _child) = sidecar.spawn().expect("failed to spawn hub sidecar");

            // Store the child handle so it stays alive for the app's lifetime
            // (dropping it would kill the sidecar)
            app.manage(_child);

            // Capture sidecar stdout/stderr to a log file
            let log_dir = dirs::data_local_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join("termora");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join("hub.log");

            tauri::async_runtime::spawn(async move {
                let mut file = match std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                {
                    Ok(f) => f,
                    Err(_) => return,
                };

                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let _ =
                                writeln!(file, "[hub:stdout] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            let _ =
                                writeln!(file, "[hub:stderr] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(payload) => {
                            let _ = writeln!(
                                file,
                                "[hub:exit] code={:?} signal={:?}",
                                payload.code, payload.signal
                            );
                            break;
                        }
                        CommandEvent::Error(err) => {
                            let _ = writeln!(file, "[hub:error] {}", err);
                        }
                        _ => {}
                    }
                }
            });

            // Wait for hub to be ready (poll /api/health)
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap();

            let mut ready = false;
            for _ in 0..30 {
                // 30 attempts × 500ms = 15s max wait
                match client
                    .get(format!("http://localhost:{}/api/health", hub_port))
                    .send()
                {
                    Ok(resp) if resp.status().is_success() => {
                        ready = true;
                        break;
                    }
                    _ => std::thread::sleep(std::time::Duration::from_millis(500)),
                }
            }

            if !ready {
                eprintln!("Hub sidecar did not become ready within 15 seconds");
            } else {
                // Read actual port from runtime.json (hub may have used zero_conf)
                // First check runtime.json for a known port
                if let Some(port) = read_runtime_port() {
                    hub_port = port;
                }
            }
        }

        HUB_PORT.store(hub_port, Ordering::Relaxed);
        eprintln!("[termora] hub port resolved to {}", hub_port);
    }

    // Show the main window (hidden by default in config)
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        set_windows_transparent_background(&window)?;

        // Enable DevTools in debug builds only
        #[cfg(debug_assertions)]
        window.open_devtools();
        let _ = window.show();
        let _ = window.set_focus();
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init());
    let builder = match current_package_identity_probe() {
        PackageIdentityProbe::Unpackaged => {
            builder.plugin(tauri_plugin_updater::Builder::new().build())
        }
        PackageIdentityProbe::Packaged { status } => {
            eprintln!(
                "[termora] updater disabled: application has an MSIX package identity (GetCurrentPackageFullName status {status})"
            );
            builder
        }
        PackageIdentityProbe::Inconclusive { status } => {
            eprintln!(
                "[termora] updater disabled: package identity probe was inconclusive (Windows error {status})"
            );
            builder
        }
    };

    builder
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_hub_auth_token,
            get_hub_port,
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
        .expect("error while running termora");
}

#[cfg(test)]
mod tests {
    use super::*;

    static CLOSE_BEHAVIOR_TEST_COUNTER: AtomicU16 = AtomicU16::new(0);

    fn close_behavior_test_path(name: &str) -> PathBuf {
        let unique = format!(
            "termora-close-behavior-{name}-{}-{}",
            std::process::id(),
            CLOSE_BEHAVIOR_TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        std::env::temp_dir()
            .join(unique)
            .join("close-behavior.json")
    }

    #[test]
    fn stored_tray_behavior_reads_as_hide() {
        let path = close_behavior_test_path("tray");
        std::fs::create_dir_all(path.parent().expect("test path parent")).expect("create test dir");
        std::fs::write(&path, r#"{"closeBehavior":"tray"}"#).expect("write test config");

        assert_eq!(
            read_close_behavior_from_path(&path),
            CloseBehaviorConfigState::Stored(CloseBehavior::Hide)
        );

        std::fs::remove_dir_all(path.parent().expect("test path parent")).expect("remove test dir");
    }

    #[test]
    fn unknown_or_unreadable_close_behavior_is_not_a_decision() {
        let path = close_behavior_test_path("invalid");
        std::fs::create_dir_all(path.parent().expect("test path parent")).expect("create test dir");
        std::fs::write(&path, r#"{"closeBehavior":"destroy"}"#).expect("write test config");

        assert_eq!(
            read_close_behavior_from_path(&path),
            CloseBehaviorConfigState::Unreadable
        );
        assert_eq!(
            close_behavior_command_result(read_close_behavior_from_path(&path)),
            Err("failed to read close preference".to_string())
        );

        std::fs::remove_file(&path).expect("remove test config");
        assert_eq!(
            read_close_behavior_from_path(&path),
            CloseBehaviorConfigState::Missing
        );
        assert_eq!(
            close_behavior_command_result(read_close_behavior_from_path(&path)),
            Ok(CloseBehavior::Ask)
        );

        std::fs::remove_dir_all(path.parent().expect("test path parent")).expect("remove test dir");
    }

    #[test]
    fn written_close_behavior_is_readable_without_a_window() {
        let path = close_behavior_test_path("round-trip");

        write_close_behavior_to_path(&path, CloseBehavior::Quit).expect("write close preference");

        assert_eq!(
            read_close_behavior_from_path(&path),
            CloseBehaviorConfigState::Stored(CloseBehavior::Quit)
        );

        std::fs::remove_dir_all(path.parent().expect("test path parent")).expect("remove test dir");
    }

    #[test]
    fn interrupted_close_behavior_replace_keeps_the_previous_preference() {
        let path = close_behavior_test_path("interrupted-replace");
        write_close_behavior_to_path(&path, CloseBehavior::Ask).expect("write initial preference");

        let error =
            write_close_behavior_to_path_with_replace(&path, CloseBehavior::Quit, |_, _| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "simulated interrupted replace",
                ))
            })
            .expect_err("interrupted replace must fail");

        assert!(error.contains("failed to replace close preference"));
        assert_eq!(
            read_close_behavior_from_path(&path),
            CloseBehaviorConfigState::Stored(CloseBehavior::Ask)
        );

        std::fs::remove_dir_all(path.parent().expect("test path parent")).expect("remove test dir");
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
        assert_eq!(hub_quit_url(4100, false), "http://127.0.0.1:4100/api/quit");
        assert_eq!(
            hub_quit_url(4100, true),
            "http://127.0.0.1:4100/api/quit?force=1"
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
            HUB_QUIT_REQUEST_TIMEOUT
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
}
