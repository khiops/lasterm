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
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Stores the resolved hub port after startup (default 4100).
static HUB_PORT: AtomicU16 = AtomicU16::new(4100);
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_CALLER_CLIENT_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static CLOSE_BEHAVIOR_TEMP_COUNTER: AtomicU16 = AtomicU16::new(0);
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

#[derive(Deserialize)]
struct RuntimeInfo {
    pid: Option<u32>,
    port: u16,
    #[serde(rename = "ownerToken")]
    owner_token: Option<String>,
}

#[derive(Serialize)]
struct HubRuntime {
    pid: Option<u32>,
    port: u16,
}

#[derive(Serialize)]
struct StopHubCommandResult {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    others: Option<usize>,
}

#[derive(Deserialize)]
struct ShutdownConflictBody {
    others: Option<usize>,
}

enum ShutdownRequestResult {
    Stopped,
    Conflict(usize),
    HubUnavailable,
    Failed(String),
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

/// Reads runtime.json in the state dir.
fn read_runtime_info() -> Option<RuntimeInfo> {
    let state_dir = get_state_dir()?;
    let runtime_path = state_dir.join("runtime.json");
    let contents = std::fs::read_to_string(&runtime_path).ok()?;
    serde_json::from_str(&contents).ok()
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
    read_runtime_info().map(|runtime| runtime.port)
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
fn get_hub_runtime() -> HubRuntime {
    match read_runtime_info() {
        Some(runtime) => HubRuntime {
            pid: runtime.pid,
            port: runtime.port,
        },
        None => HubRuntime {
            pid: None,
            port: HUB_PORT.load(Ordering::Relaxed),
        },
    }
}

#[tauri::command]
fn is_tray_available() -> bool {
    TRAY_AVAILABLE.load(Ordering::Relaxed)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
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

#[tauri::command]
fn stop_legacy_hub() -> Result<bool, String> {
    let Some(runtime) = read_runtime_info() else {
        return Ok(true);
    };

    match stop_legacy_hub_from_runtime(&runtime) {
        ShutdownRequestResult::Stopped | ShutdownRequestResult::HubUnavailable => Ok(true),
        ShutdownRequestResult::Conflict(_) => {
            Err("legacy hub shutdown unexpectedly conflicted".to_string())
        }
        ShutdownRequestResult::Failed(message) => Err(message),
    }
}

#[tauri::command]
fn stop_hub(force: bool) -> Result<StopHubCommandResult, String> {
    match request_hub_shutdown(force) {
        ShutdownRequestResult::Stopped | ShutdownRequestResult::HubUnavailable => {
            Ok(StopHubCommandResult {
                status: "stopped",
                others: None,
            })
        }
        ShutdownRequestResult::Conflict(others) => Ok(StopHubCommandResult {
            status: "conflict",
            others: Some(others),
        }),
        ShutdownRequestResult::Failed(message) => Err(message),
    }
}

fn request_hub_shutdown(force: bool) -> ShutdownRequestResult {
    let Some(runtime) = read_runtime_info() else {
        return ShutdownRequestResult::HubUnavailable;
    };
    let Some(owner_token) = runtime.owner_token.clone() else {
        return stop_legacy_hub_from_runtime(&runtime);
    };

    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(error) => return ShutdownRequestResult::Failed(error.to_string()),
    };
    let force_query = if force { "?force=1" } else { "" };
    let url = format!(
        "http://127.0.0.1:{}/api/shutdown{}",
        runtime.port, force_query
    );
    let mut request = client.post(url).header("X-Termora-Owner", owner_token);
    if let Some(client_id) = current_shutdown_caller_client_id() {
        request = request.header("X-Termora-Client-Id", client_id);
    }

    let response = match request.send() {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "[termora] owner-token shutdown request failed; refusing PID fallback: {}",
                error
            );
            return owner_token_shutdown_failed(&runtime, error.to_string());
        }
    };

    if response.status().is_success() {
        return confirm_hub_stopped_or_kill(&runtime);
    }

    if response.status().as_u16() == 409 {
        let body_text = response.text().unwrap_or_else(|error| {
            eprintln!(
                "[termora] failed to read shutdown conflict response: {}",
                error
            );
            String::new()
        });
        let others = match serde_json::from_str::<ShutdownConflictBody>(&body_text) {
            Ok(body) => body.others.unwrap_or_else(|| {
                eprintln!(
                    "[termora] shutdown conflict response missing others count: {}",
                    body_text
                );
                1
            }),
            Err(error) => {
                eprintln!(
                    "[termora] malformed shutdown conflict response: {}; body={}",
                    error, body_text
                );
                1
            }
        };
        return ShutdownRequestResult::Conflict(others);
    }

    eprintln!(
        "[termora] owner-token shutdown failed with HTTP {}; refusing PID fallback",
        response.status()
    );
    owner_token_shutdown_failed(&runtime, format!("HTTP {}", response.status()))
}

fn owner_token_shutdown_failed(runtime: &RuntimeInfo, reason: String) -> ShutdownRequestResult {
    if let Some(pid) = runtime.pid {
        if pid != 0 && pid != std::process::id() && !is_pid_alive(pid) {
            eprintln!(
                "[termora] hub pid {} is already stopped after owner-token shutdown failure",
                pid
            );
            return ShutdownRequestResult::HubUnavailable;
        }
    }

    ShutdownRequestResult::Failed(format!(
        "owner-token shutdown request failed; refusing PID fallback: {}",
        reason
    ))
}

fn stop_legacy_hub_from_runtime(runtime: &RuntimeInfo) -> ShutdownRequestResult {
    let Some(pid) = runtime.pid else {
        return ShutdownRequestResult::Failed("legacy runtime.json is missing pid".to_string());
    };

    if pid == 0 || pid == std::process::id() {
        return ShutdownRequestResult::Failed(format!("refusing to kill invalid hub pid {}", pid));
    }

    if !is_pid_alive(pid) {
        return ShutdownRequestResult::HubUnavailable;
    }

    if let Err(message) = validate_hub_process_identity(pid) {
        return ShutdownRequestResult::Failed(message);
    }

    match signal_hub_pid(pid) {
        Ok(()) => {
            if wait_for_pid_exit(pid, Duration::from_secs(5)) {
                ShutdownRequestResult::Stopped
            } else {
                ShutdownRequestResult::Failed(format!(
                    "hub pid {} is still alive after PID-kill fallback",
                    pid
                ))
            }
        }
        Err(message) => {
            if !is_pid_alive(pid) {
                ShutdownRequestResult::Stopped
            } else {
                ShutdownRequestResult::Failed(message)
            }
        }
    }
}

fn confirm_hub_stopped_or_kill(runtime: &RuntimeInfo) -> ShutdownRequestResult {
    let Some(pid) = runtime.pid else {
        return ShutdownRequestResult::Failed(
            "runtime.json is missing pid; cannot confirm hub stopped".to_string(),
        );
    };

    if pid == 0 || pid == std::process::id() {
        return ShutdownRequestResult::Failed(format!("refusing to kill invalid hub pid {}", pid));
    }

    if wait_for_pid_exit(pid, Duration::from_secs(10)) {
        eprintln!("[termora] confirmed hub pid {} is stopped", pid);
        return ShutdownRequestResult::Stopped;
    }

    if let Err(message) = validate_hub_process_identity(pid) {
        return ShutdownRequestResult::Failed(message);
    }

    eprintln!(
        "[termora] hub pid {} still alive after graceful shutdown; killing by PID",
        pid
    );
    match signal_hub_pid(pid) {
        Ok(()) => {
            if wait_for_pid_exit(pid, Duration::from_secs(5)) {
                eprintln!(
                    "[termora] confirmed hub pid {} is stopped after PID kill",
                    pid
                );
                ShutdownRequestResult::Stopped
            } else {
                ShutdownRequestResult::Failed(format!(
                    "hub pid {} is still alive after PID-kill fallback",
                    pid
                ))
            }
        }
        Err(message) => {
            if !is_pid_alive(pid) {
                ShutdownRequestResult::Stopped
            } else {
                ShutdownRequestResult::Failed(message)
            }
        }
    }
}

fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !is_pid_alive(pid) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let remaining = deadline.saturating_duration_since(now);
        std::thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

fn validate_hub_process_identity(pid: u32) -> Result<(), String> {
    let Some(command) = read_process_command_line(pid) else {
        return Err(format!(
            "refusing to kill hub pid {} because process identity could not be verified",
            pid
        ));
    };

    if command_looks_like_termora_hub(&command) {
        return Ok(());
    }

    Err(format!(
        "refusing to kill hub pid {} because process does not look like termora-hub: {}",
        pid,
        summarize_command(&command)
    ))
}

#[cfg(target_os = "windows")]
fn read_process_command_line(pid: u32) -> Option<String> {
    let script = format!(
        "(Get-CimInstance Win32_Process -Filter \"ProcessId = {}\" | Select-Object -ExpandProperty CommandLine)",
        pid
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if command.is_empty() {
        None
    } else {
        Some(command)
    }
}

#[cfg(not(target_os = "windows"))]
fn read_process_command_line(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(raw) = std::fs::read(format!("/proc/{}/cmdline", pid)) {
            let command = String::from_utf8_lossy(&raw)
                .replace('\0', " ")
                .trim()
                .to_string();
            if !command.is_empty() {
                return Some(command);
            }
        }
    }

    let pid_text = pid.to_string();
    let output = std::process::Command::new("ps")
        .args(["-p", pid_text.as_str(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if command.is_empty() {
        None
    } else {
        Some(command)
    }
}

fn command_looks_like_termora_hub(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.contains("termora-hub")
        || normalized.contains("termora_hub")
        || normalized.contains("@termora/hub")
        || normalized.contains("packages/hub/src")
        || normalized.contains("packages\\hub\\src")
}

fn summarize_command(command: &str) -> String {
    const MAX_COMMAND_CHARS: usize = 160;
    if command.chars().count() <= MAX_COMMAND_CHARS {
        return command.to_string();
    }

    let mut summary = command
        .chars()
        .take(MAX_COMMAND_CHARS.saturating_sub(3))
        .collect::<String>();
    summary.push_str("...");
    summary
}

#[cfg(target_os = "windows")]
fn is_pid_alive(pid: u32) -> bool {
    let filter = format!("PID eq {}", pid);
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let expected = pid.to_string();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split(',').nth(1))
        .any(|field| field.trim().trim_matches('"') == expected)
}

#[cfg(not(target_os = "windows"))]
fn is_pid_alive(pid: u32) -> bool {
    matches!(
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status(),
        Ok(status) if status.success()
    )
}

#[cfg(target_os = "windows")]
fn signal_hub_pid(pid: u32) -> Result<(), String> {
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|error| {
            format!(
                "failed to run taskkill for legacy hub pid {}: {}",
                pid, error
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill failed for legacy hub pid {}: {}",
            pid, status
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn signal_hub_pid(pid: u32) -> Result<(), String> {
    let status = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .map_err(|error| format!("failed to signal legacy hub pid {}: {}", pid, error))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill failed for legacy hub pid {}: {}",
            pid, status
        ))
    }
}

fn show_shutdown_error(app: &tauri::AppHandle, message: String) {
    app.dialog()
        .message(message)
        .title("Quit Failed")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

fn handle_tray_quit(app: tauri::AppHandle) {
    std::thread::spawn(move || match request_hub_shutdown(false) {
        ShutdownRequestResult::Stopped | ShutdownRequestResult::HubUnavailable => {
            app.exit(0);
        }
        ShutdownRequestResult::Conflict(others) => {
            let suffix = if others == 1 {
                "client is"
            } else {
                "clients are"
            };
            let confirmed = app
                .dialog()
                .message(format!(
                    "{} other {} connected. Stop the hub anyway?",
                    others, suffix
                ))
                .title("Other Clients Connected")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Stop anyway".to_string(),
                    "Cancel".to_string(),
                ))
                .blocking_show();
            if !confirmed {
                return;
            }

            match request_hub_shutdown(true) {
                ShutdownRequestResult::Stopped | ShutdownRequestResult::HubUnavailable => {
                    app.exit(0);
                }
                ShutdownRequestResult::Conflict(_) => {
                    show_shutdown_error(
                        &app,
                        "The hub still reports other connected clients.".to_string(),
                    );
                }
                ShutdownRequestResult::Failed(message) => {
                    show_shutdown_error(&app, message);
                }
            }
        }
        ShutdownRequestResult::Failed(message) => {
            show_shutdown_error(&app, message);
        }
    });
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
            get_hub_runtime,
            is_tray_available,
            get_close_behavior,
            set_close_behavior,
            exit_app,
            set_shutdown_caller_client_id,
            stop_hub,
            stop_legacy_hub,
            pick_and_read_agent_file
        ])
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
    fn command_looks_like_termora_hub_matches_known_hub_invocations() {
        assert!(command_looks_like_termora_hub("termora-hub --port 4130"));
        assert!(command_looks_like_termora_hub(
            "TERMORA_HUB.exe --port 4130"
        ));
        assert!(command_looks_like_termora_hub(
            "node packages/hub/src/index.ts"
        ));
        assert!(command_looks_like_termora_hub(
            "node packages\\hub\\src\\index.ts"
        ));
        assert!(command_looks_like_termora_hub(
            "pnpm --filter @termora/hub dev"
        ));
    }

    #[test]
    fn command_looks_like_termora_hub_rejects_unrelated_commands() {
        assert!(!command_looks_like_termora_hub(""));
        assert!(!command_looks_like_termora_hub("termora-agent --version"));
        assert!(!command_looks_like_termora_hub(
            "node packages/web/src/main.ts"
        ));
    }

    #[test]
    fn summarize_command_keeps_short_commands_unchanged() {
        let command = "termora-hub --port 4130";

        assert_eq!(summarize_command(command), command);
    }

    #[test]
    fn summarize_command_truncates_long_commands_with_ellipsis() {
        let command = "a".repeat(161);
        let summary = summarize_command(&command);

        assert_eq!(summary.chars().count(), 160);
        assert_eq!(summary, format!("{}...", "a".repeat(157)));
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
}
