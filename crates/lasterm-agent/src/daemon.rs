use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch, Mutex, Notify};

#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

use crate::batch::{batch_loop, BatchedEvent, ChannelEvent, ChannelEventSender};
use crate::framing::{encode_frame, FrameReader};
use crate::handler::{handle_message, FrameSender, SnapshotSenders};
use crate::platform_dirs::{lasterm_dir, DirKind};
use crate::protocol::AgentToHub;
use crate::pty::{DestroyAllSummary, PtyManager};

#[cfg(unix)]
const BIND_RETRY_MAX: u32 = 3;
#[cfg(unix)]
const BIND_RETRY_DELAY_MS: u64 = 300;
const MAX_FRAME_QUEUE: usize = 1000;
static CONNECTION_SEQ: AtomicU64 = AtomicU64::new(0);

/// Receiver held by each daemon accept loop. `true` means it must stop
/// accepting connections and tear down every terminal it owns.
pub(crate) type ShutdownReceiver = watch::Receiver<bool>;

/// Build the one-way shutdown request channel shared by the platform-specific
/// accept loops. The signal task owns the sender; the loop owns teardown.
pub(crate) fn shutdown_channel() -> (watch::Sender<bool>, ShutdownReceiver) {
    watch::channel(false)
}

/// Wait until a shutdown has been requested. A dropped sender is not a
/// shutdown request: it can happen in a test that intentionally has no signal
/// task, and must not make a daemon stop by surprise.
async fn shutdown_requested(shutdown: &mut ShutdownReceiver) {
    loop {
        if *shutdown.borrow_and_update() {
            return;
        }
        if shutdown.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Tear down the manager owned by the accept loop and make the result usable
/// to an operator investigating a blocked update.
async fn teardown_daemon_terminals(pty_manager: &Arc<Mutex<PtyManager>>) -> DestroyAllSummary {
    // Mark refusal and collect the sweep while holding the same manager lock:
    // detached handlers cannot register a workload after this sweep begins.
    let summary = {
        let mut manager = pty_manager.lock().await;
        manager.begin_shutdown();
        manager.destroy_all().await
    };
    if summary.unresolved.is_empty() {
        tracing::info!(
            confirmed_shell_exits = summary.confirmed_shell_exits,
            unresolved_channels = 0,
            "daemon terminal teardown complete"
        );
    } else {
        tracing::warn!(
            confirmed_shell_exits = summary.confirmed_shell_exits,
            unresolved_channels = summary.unresolved.len(),
            "daemon terminal teardown complete with unresolved channels"
        );
    }
    for unresolved in &summary.unresolved {
        tracing::warn!(
            channel_id = %unresolved.channel_id,
            pid = unresolved.pid,
            reason = ?unresolved.reason,
            "daemon terminal teardown unresolved channel"
        );
    }
    summary
}

/// A completed agent mode exits successfully only when every terminal present
/// at shutdown was confirmed gone. Startup and runtime errors are mapped by
/// the top-level process as failures before this function is called.
pub(crate) fn teardown_exit_status(summary: &DestroyAllSummary) -> i32 {
    if summary.unresolved.is_empty() {
        0
    } else {
        1
    }
}

/// Tracks the active hub connection so it can be displaced by a new one.
struct ActiveConnection {
    /// Daemon-local sequence id for diagnostics.
    connection_id: u64,
    /// Notified when this connection should be terminated (displaced).
    cancel: Arc<Notify>,
    /// Channel to send encoded frames to the active connection's writer task.
    frame_tx: FrameSender,
}

fn next_connection_id() -> u64 {
    CONNECTION_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

/// The directory holding `auth.json`, the hub's, not the socket or state
/// directory. A daemon that cannot locate it refuses to start: guessing one
/// would find no token there and run as a first start, unauthenticated.
fn config_dir() -> std::io::Result<String> {
    Ok(lasterm_dir(DirKind::Config)?.to_string_lossy().into_owned())
}

/// The directory holding `meta.db` and `spool.db`.
fn state_dir() -> std::io::Result<std::path::PathBuf> {
    lasterm_dir(DirKind::State)
}

/// Run the agent in daemon mode.
///
/// Listens on a Unix domain socket. Handles one connection at a time
/// (the latest authenticated connection wins and displaces the previous one).
/// PTY channels persist across hub reconnections.
#[cfg(unix)]
pub(crate) async fn run_daemon(
    socket_path: String,
    shutdown: ShutdownReceiver,
    bound: Option<oneshot::Sender<()>>,
    idle_timeout: Option<std::time::Duration>,
) -> std::io::Result<DestroyAllSummary> {
    run_daemon_impl(
        socket_path,
        config_dir()?,
        state_dir()?,
        shutdown,
        bound,
        idle_timeout,
    )
    .await
}

/// Internal implementation — takes an explicit config_dir so tests can inject a temp dir
/// without mutating process-global environment variables.
#[cfg(unix)]
async fn run_daemon_impl(
    socket_path: String,
    config_dir: String,
    state_dir: PathBuf,
    shutdown: ShutdownReceiver,
    bound: Option<oneshot::Sender<()>>,
    idle_timeout: Option<std::time::Duration>,
) -> std::io::Result<DestroyAllSummary> {
    run_daemon_impl_with_manager(
        socket_path,
        config_dir,
        state_dir,
        shutdown,
        Arc::new(Mutex::new(PtyManager::new())),
        bound,
        idle_timeout,
    )
    .await
}

/// Internal test seam for exercising daemon teardown with a short confirmation
/// bound, without changing the production shutdown deadline.
/// How often an idle daemon asks itself whether it is still needed.
#[cfg(unix)]
const IDLE_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(unix)]
async fn run_daemon_impl_with_manager(
    socket_path: String,
    config_dir: String,
    state_dir: PathBuf,
    mut shutdown: ShutdownReceiver,
    pty_manager: Arc<Mutex<PtyManager>>,
    bound: Option<oneshot::Sender<()>>,
    // How long to stay up holding nothing, for nobody. `None` never exits,
    // which is what a daemon started beside its hub wants.
    idle_timeout: Option<std::time::Duration>,
) -> std::io::Result<DestroyAllSummary> {
    let path = PathBuf::from(&socket_path);

    // Validate path length (Unix socket limit: 104-108 bytes depending on platform)
    if path.as_os_str().len() > 100 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "socket path too long: {} bytes (max 100)",
                path.as_os_str().len()
            ),
        ));
    }

    // A socket file left by a daemon that died is cleaned up; one a daemon is
    // still serving is not touched. Removing it would bind this process in its
    // place and leave the first holding terminals nobody can reach (#454).
    if path.exists() {
        if someone_is_listening(&path).await {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!(
                    "another agent daemon is already listening on {}",
                    path.display()
                ),
            ));
        }
        std::fs::remove_file(&path)?;
    }

    // Bind with retry (handles transient EADDRINUSE after cleanup)
    let mut listener = Some(bind_with_retry(&path).await?);

    // What this process bound, so that whatever happens next removes this
    // socket and not a replacement's (#116).
    let bound_as = socket_identity(&path);

    // Set socket permissions to 0600 (owner-only). Giving up here without
    // taking the endpoint down would leave a path nobody serves and nobody
    // cleans up — the rule that the listener's owner removes its endpoint has
    // to hold for a setup that fails too, not only for a shutdown.
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        {
            drop(listener.take());
            remove_own_socket(&path, bound_as);
            return Err(error);
        }
    }

    tracing::info!("daemon listening on {:?}", path);
    if let Some(bound) = bound {
        let _ = bound.send(());
    }

    // Load auth token once at startup (None → first-run, skip auth)
    let expected_token = read_auth_token_with_state_dir(&config_dir, &state_dir).await;
    if expected_token.is_some() {
        tracing::info!("auth token loaded — connections will be authenticated");
    } else {
        tracing::info!(
            "no auth token found — connections accepted without authentication (first-run)"
        );
    }

    // Per-channel command senders (snapshot/resize) — shared across connections
    let cmd_senders: SnapshotSenders = Arc::new(Mutex::new(std::collections::HashMap::new()));

    // Batch channels — single batch loop for the daemon lifetime
    // Output and events flow: PTY reader tasks → batch_loop → output_router → active connection
    let (channel_events, channel_events_rx) = mpsc::unbounded_channel::<ChannelEvent>();
    let (batched_tx, batched_rx) = mpsc::unbounded_channel::<BatchedEvent>();
    tokio::spawn(batch_loop(channel_events_rx, batched_tx));

    // Active connection state — shared between accept loop and output router
    let active_conn: Arc<Mutex<Option<ActiveConnection>>> = Arc::new(Mutex::new(None));

    // Output router: drains batched frames, forwards to active connection (or buffers)
    spawn_output_router(batched_rx, Arc::clone(&active_conn));

    // A daemon nobody is using, and that holds nothing, should not outlive its
    // purpose. Both conditions matter: a daemon with terminals waits however
    // long it takes for someone to come back for them, and one with a hub
    // connected is in use even while it holds nothing yet.
    let mut idle_since: Option<std::time::Instant> = None;
    // A short timeout is checked at its own pace, so a caller asking for a
    // second does not wait ten.
    let mut idle_check = tokio::time::interval(
        idle_timeout.map_or(IDLE_CHECK_EVERY, |limit| limit.min(IDLE_CHECK_EVERY)),
    );
    idle_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Accept loop — spawn each connection handler so we can accept the next immediately.
    let result = loop {
        tokio::select! {
            biased;
            _ = shutdown_requested(&mut shutdown) => {
                tracing::info!("daemon shutdown requested; tearing down terminals");
                // Stop routing new work before teardown can block on a slow
                // terminal. Existing connection handlers may finish their own
                // cancellation paths while the manager is swept.
                drop(listener.take());
                break Ok(teardown_daemon_terminals(&pty_manager).await);
            }
            _ = idle_check.tick(), if idle_timeout.is_some() => {
                let unused = active_conn.lock().await.is_none()
                    && pty_manager.lock().await.channel_ids().is_empty();
                if !unused {
                    idle_since = None;
                    continue;
                }
                let since = *idle_since.get_or_insert_with(std::time::Instant::now);
                let waited = since.elapsed();
                if let Some(limit) = idle_timeout {
                    if waited >= limit {
                        tracing::info!(
                            waited_secs = waited.as_secs(),
                            "daemon idle with no terminals and no hub; exiting"
                        );
                        drop(listener.take());
                        break Ok(teardown_daemon_terminals(&pty_manager).await);
                    }
                }
            }
            accepted = listener.as_ref().expect("listener remains live until shutdown").accept() => match accepted {
            Ok((stream, _addr)) => {
                let connection_id = next_connection_id();
                tracing::debug!(connection_id, "hub connection accepted");

                // Create cancellation notifier for this connection
                let cancel = Arc::new(Notify::new());

                // Create per-connection frame channel
                let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();

                // The connection becomes the active hub, displacing the previous
                // one, only once it has authenticated: see `register_active`.

                // Spawn the connection handler — does NOT block the accept loop
                tokio::spawn(handle_connection(
                    stream,
                    Arc::clone(&pty_manager),
                    Arc::clone(&cmd_senders),
                    channel_events.clone(),
                    frame_tx,
                    frame_rx,
                    Arc::clone(&active_conn),
                    cancel,
                    expected_token.clone(),
                    connection_id,
                ));
            }
            Err(e) => {
                tracing::error!("accept error: {}", e);
            }
            }
        }
    };

    // The listener owner removes its endpoint after it has stopped accepting.
    // Pathname removal cannot prove this still refers to
    // the inode we bound if another process interfered with the socket path.
    drop(listener);
    remove_own_socket(&path, bound_as);
    result
}

// ─── Windows (named pipe) implementation ──────────────────────────────────────

/// Returns the named pipe path for this agent instance.
///
/// Format: `\\.\pipe\lasterm-agent-<username>`
#[cfg(windows)]
fn get_pipe_name() -> String {
    let username = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!(r"\\.\pipe\lasterm-agent-{}", username)
}

/// Run the agent in daemon mode (Windows named pipe).
///
/// Listens on a Windows named pipe. Handles one connection at a time
/// (the latest authenticated connection wins and displaces the previous one).
/// PTY channels persist across hub reconnections.
#[cfg(windows)]
pub(crate) async fn run_daemon(
    socket_path: String,
    shutdown: ShutdownReceiver,
    bound: Option<oneshot::Sender<()>>,
    idle_timeout: Option<std::time::Duration>,
) -> std::io::Result<DestroyAllSummary> {
    // A Windows daemon is only ever started beside its own hub: no SSH channel
    // carries a named pipe, so nothing reaches one from another machine and
    // none is ever left behind. Saying so beats honouring a timeout here that
    // nothing would ever exercise.
    if idle_timeout.is_some() {
        tracing::warn!("--idle-timeout is ignored on Windows: a daemon here is never a remote one");
    }
    // auth.json lives in the hub's configuration directory, %APPDATA%\lasterm.
    run_daemon_impl(socket_path, config_dir()?, state_dir()?, shutdown, bound).await
}

/// Internal implementation — takes explicit directories, as on Unix, so tests
/// can run a daemon without reading the user's profile.
#[cfg(windows)]
async fn run_daemon_impl(
    socket_path: String,
    config_dir: String,
    state_dir: std::path::PathBuf,
    mut shutdown: ShutdownReceiver,
    bound: Option<oneshot::Sender<()>>,
) -> std::io::Result<DestroyAllSummary> {
    let pipe_name = if socket_path.starts_with(r"\\.\pipe\") {
        socket_path.clone()
    } else {
        // Caller passed a non-pipe path (e.g. legacy XDG path on wrong OS) — use canonical name
        get_pipe_name()
    };

    tracing::info!("daemon listening on {}", pipe_name);

    // Load auth token once at startup (None → first-run, skip auth)
    let expected_token = read_auth_token_with_state_dir(&config_dir, &state_dir).await;
    if expected_token.is_some() {
        tracing::info!("auth token loaded — connections will be authenticated");
    } else {
        tracing::info!(
            "no auth token found — connections accepted without authentication (first-run)"
        );
    }

    // Shared PTY manager — channels survive hub disconnections
    let pty_manager = Arc::new(Mutex::new(PtyManager::new()));

    // Per-channel command senders (snapshot/resize) — shared across connections
    let cmd_senders: SnapshotSenders = Arc::new(Mutex::new(std::collections::HashMap::new()));

    // Batch channels — single batch loop for the daemon lifetime
    // Output and events flow: PTY reader tasks → batch_loop → output_router → active connection
    let (channel_events, channel_events_rx) = mpsc::unbounded_channel::<ChannelEvent>();
    let (batched_tx, batched_rx) = mpsc::unbounded_channel::<BatchedEvent>();
    tokio::spawn(batch_loop(channel_events_rx, batched_tx));

    // Active connection state — shared between accept loop and output router
    let active_conn: Arc<Mutex<Option<ActiveConnection>>> = Arc::new(Mutex::new(None));

    // Output router: drains batched frames, forwards to active connection (or buffers)
    spawn_output_router(batched_rx, Arc::clone(&active_conn));

    // Named pipe accept loop using owner-only ACL (SDDL "D:(A;;GA;;;OW)"):
    //   1. Create first server instance with secure DACL
    //   2. Wait for client to connect
    //   3. Create next server instance BEFORE handing off the current pipe
    //   4. Spawn handler task, repeat
    let mut server = Some(create_secure_pipe(&pipe_name, true)?);
    if let Some(bound) = bound {
        let _ = bound.send(());
    }

    let result = loop {
        // Block until a client connects to this pipe instance
        // Use match instead of ? to avoid crashing the daemon on transient OS errors
        let connected_result = tokio::select! {
            biased;
            _ = shutdown_requested(&mut shutdown) => {
                tracing::info!("daemon shutdown requested");
                drop(server.take());
                break Ok(());
            }
            result = server.as_mut().expect("pipe server remains live until shutdown").connect() => result,
        };
        if let Err(e) = connected_result {
            tracing::warn!("named pipe connect error: {} — retrying", e);
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            continue;
        }
        let connection_id = next_connection_id();
        tracing::debug!(connection_id, "hub connection accepted (named pipe)");

        // Swap in the next server instance so the pipe name stays open for future clients
        let connected = {
            let next = match create_secure_pipe(&pipe_name, false) {
                Ok(next) => next,
                Err(error) => break Err(error),
            };
            std::mem::replace(server.as_mut().expect("pipe server remains live"), next)
        };

        // Create cancellation notifier for this connection
        let cancel = Arc::new(Notify::new());

        // Create per-connection frame channel
        let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        // The connection becomes the active hub, displacing the previous one,
        // only once it has authenticated: see `register_active`.

        // Spawn the connection handler — does NOT block the accept loop
        tokio::spawn(handle_connection_inner(
            connected,
            Arc::clone(&pty_manager),
            Arc::clone(&cmd_senders),
            channel_events.clone(),
            frame_tx,
            frame_rx,
            Arc::clone(&active_conn),
            cancel,
            expected_token.clone(),
            connection_id,
        ));
    };

    // Every loop exit, including a replacement pipe creation failure, sweeps
    // the manager before this daemon reports its result to the caller.
    let summary = teardown_daemon_terminals(&pty_manager).await;
    result?;
    Ok(summary)
}

// ─── Shared connection logic ──────────────────────────────────────────────────

// Core connection handler, generic over any AsyncRead + AsyncWrite stream.
// Handles one hub connection: sends HELLO + channel state, then runs the
// read/write loop until EOF, error, or displacement by a new connection.
// Used by both the Unix UDS path and the Windows named-pipe path.

// ── Auth helpers ──────────────────────────────────────────────────────────────

/// Read the auth token from `{config_dir}/auth.json`.
/// Returns `None` if the file is absent AND meta.db does not exist (true first-run: no auth required).
/// Returns `Some(String::new())` if auth.json is absent but meta.db exists (fail-closed: auth bypass refused).
/// Returns `Some(String::new())` if the file exists but is unreadable or malformed (fail-closed).
/// Returns `Some(token)` on success.
///
/// The first-run answer is only as good as the two directories: both must be
/// the hub's, which is why they come from the shared rule and a daemon that
/// cannot resolve them does not start.
async fn read_auth_token_with_state_dir(
    config_dir: &str,
    state_dir: &std::path::Path,
) -> Option<String> {
    let path = format!("{}/auth.json", config_dir);

    // File doesn't exist — check whether this is truly a first run
    if !std::path::Path::new(&path).exists() {
        let meta_db = state_dir.join("meta.db");
        if meta_db.exists() {
            // State data exists but auth.json is gone — this is NOT a first run.
            // Refusing to start without authentication to prevent silent auth bypass.
            tracing::error!(
				"auth.json is missing but meta.db exists — refusing to start without authentication. \
				Restore auth.json or re-initialize."
			);
            return Some(String::new()); // empty token = nothing will match = fail-closed
        }
        // True first run — no state data, no auth.json
        tracing::info!(
            "First run: no auth.json found, connections accepted without authentication"
        );
        return None;
    }

    // File exists but can't be read → security error, fail-closed
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(
                "auth.json exists but unreadable: {} — connections will be rejected",
                e
            );
            return Some(String::new()); // empty token = nothing will match = fail-closed
        }
    };

    // File exists but malformed → fail-closed
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(v) => v
            .get("token")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                tracing::error!("auth.json missing 'token' field — connections will be rejected");
                Some(String::new()) // fail-closed
            }),
        Err(e) => {
            tracing::error!("auth.json malformed: {} — connections will be rejected", e);
            Some(String::new()) // fail-closed
        }
    }
}

/// Constant-time byte comparison — prevents timing attacks on token validation.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// Read the first framed message from `reader` (5 s timeout).
/// Expects `{ "type": "AUTH", "token": "<hex>" }`.
/// Returns `Ok(true)` on match, `Ok(false)` on mismatch, `Err` on timeout/IO.
/// Read the first framed message from `reader` (5 s timeout).
/// Expects the first message to be `HubToAgent::Auth { token }`.
/// Returns `Ok(true)` on match, `Ok(false)` on mismatch, `Err` on timeout/IO.
async fn validate_auth<R: AsyncRead + Unpin>(
    reader: &mut R,
    expected_token: &str,
) -> std::io::Result<bool> {
    use crate::protocol::HubToAgent;
    use tokio::time::{timeout, Duration};

    // 5-second deadline for the AUTH frame
    let first_msg = timeout(Duration::from_secs(5), async {
        let mut frame_reader = FrameReader::new();
        let mut buf = vec![0u8; 4096];
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "client disconnected before AUTH",
                ));
            }
            let msgs = frame_reader
                .push(&buf[..n])
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            if let Some(msg) = msgs.into_iter().next() {
                return Ok(msg);
            }
        }
    })
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "AUTH frame not received within 5s",
        )
    })??;

    // Match the decoded message — only HubToAgent::Auth passes
    match first_msg {
        HubToAgent::Auth { token } => Ok(ct_eq(expected_token.as_bytes(), token.as_bytes())),
        _other => {
            tracing::warn!("expected AUTH message as first frame, got a different message type");
            Ok(false)
        }
    }
}

// ── Windows secure pipe ───────────────────────────────────────────────────────

/// Create a named pipe restricted to the current user via SDDL `"D:(A;;GA;;;OW)"`.
///
/// SDDL breakdown:
///   D  = DACL (discretionary access control list)
///   A  = Allow ACE
///   GA = GENERIC_ALL
///   OW = Owner (the SID of the process owner)
///
/// This means only the user who created the pipe (the agent process owner) may
/// connect to it — other local users are denied by the implicit "deny all else"
/// that follows an explicit DACL.
#[cfg(windows)]
fn create_secure_pipe(
    name: &str,
    first: bool,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::NamedPipeServer;
    use windows_sys::Win32::Foundation::{LocalFree, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    // SDDL: Allow Generic All to the pipe owner (OW = owner SID).
    // The implicit default-deny covers all other users.
    let sddl: Vec<u16> = "D:(A;;GA;;;OW)\0".encode_utf16().collect();

    let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut psd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: psd is heap-allocated by the Windows API via LocalAlloc;
    // LocalFree is the correct deallocator. The guard ensures cleanup on error.
    struct PsdGuard(PSECURITY_DESCRIPTOR);
    impl Drop for PsdGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0 as _) };
            }
        }
    }
    let _guard = PsdGuard(psd);

    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd,
        bInheritHandle: 0,
    };

    // Encode pipe name as UTF-16 NUL-terminated
    let name_wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();

    let flags = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };

    let handle = unsafe {
        CreateNamedPipeW(
            name_wide.as_ptr(),
            flags,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            65536,
            65536,
            0,
            std::ptr::from_ref(&sa).cast_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }

    // SAFETY: `handle` is a valid overlapped pipe handle created above.
    // tokio::NamedPipeServer::from_raw_handle registers it with the IOCP.
    unsafe { NamedPipeServer::from_raw_handle(handle as _) }
}

/// Used by both the Unix UDS path and the Windows named-pipe path.
#[allow(clippy::too_many_arguments)]
async fn handle_connection_inner<S>(
    stream: S,
    pty_manager: Arc<Mutex<PtyManager>>,
    cmd_senders: SnapshotSenders,
    channel_events: ChannelEventSender,
    frame_tx: FrameSender,
    mut frame_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    active_conn: Arc<Mutex<Option<ActiveConnection>>>,
    cancel: Arc<Notify>,
    expected_token: Option<String>,
    connection_id: u64,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut read_half, mut write_half) = tokio::io::split(stream);

    // Spawn writer task — drains frame_rx to the write half
    let cancel_writer = Arc::clone(&cancel);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_writer.notified() => {
                    // Displaced. What is already queued goes out first — the
                    // notice saying why this connection is ending is enqueued
                    // immediately before the cancellation, and a writer that
                    // stopped here would drop the only thing that explains the
                    // EOF the other end is about to read (#127).
                    while let Ok(data) = frame_rx.try_recv() {
                        if write_half.write_all(&data).await.is_err() {
                            break;
                        }
                        if write_half.flush().await.is_err() {
                            break;
                        }
                    }
                    // Dropping write_half sends EOF to the client.
                    break;
                }
                frame = frame_rx.recv() => {
                    match frame {
                        Some(data) => {
                            if write_half.write_all(&data).await.is_err() {
                                break;
                            }
                            if write_half.flush().await.is_err() {
                                break;
                            }
                        }
                        None => break, // frame_tx dropped
                    }
                }
            }
        }
        // write_half dropped here — client read returns 0 (EOF)
    });

    // --- Step 1: Send HELLO first (hub needs to see the agent is alive before sending AUTH) ---
    if send_encoded(&frame_tx, &crate::handler::build_hello()).is_err() {
        clear_active_if_ours(&active_conn, &cancel).await;
        return;
    }
    tracing::debug!(connection_id, "HELLO sent");

    // --- Step 2: Validate AUTH if a token is configured ---
    // If no token is configured (first-run), skip auth entirely.
    if let Some(ref token) = expected_token {
        match validate_auth(&mut read_half, token).await {
            Ok(true) => {
                tracing::debug!(connection_id, "auth handshake succeeded");
            }
            Ok(false) => {
                tracing::warn!(
                    connection_id,
                    "auth handshake failed: token mismatch — dropping connection"
                );
                clear_active_if_ours(&active_conn, &cancel).await;
                return;
            }
            Err(e) => {
                tracing::warn!(connection_id, error = %e, "auth handshake error — dropping connection");
                clear_active_if_ours(&active_conn, &cancel).await;
                return;
            }
        }
    } else {
        tracing::debug!(connection_id, "auth skipped because no token is configured");
    }
    register_active(&active_conn, connection_id, &cancel, &frame_tx).await;

    // Send AGENT_CHANNEL_STATE for each existing channel
    let mut channel_state_count = 0usize;
    {
        let mgr = pty_manager.lock().await;
        for (id, ch) in &mgr.channels {
            let msg = AgentToHub::AgentChannelState {
                channel_id: id.clone(),
                title: String::new(),
                pid: ch.process.pid(),
                alive: true,
            };
            if send_encoded(&frame_tx, &msg).is_err() {
                clear_active_if_ours(&active_conn, &cancel).await;
                return;
            }
            channel_state_count += 1;
        }
    }

    // Send CHANNEL_STATE_END
    tracing::debug!(
        connection_id,
        channel_state_count,
        "about to send CHANNEL_STATE_END"
    );
    if send_encoded(&frame_tx, &AgentToHub::ChannelStateEnd {}).is_err() {
        tracing::warn!(connection_id, "CHANNEL_STATE_END send failed (writer gone)");
        clear_active_if_ours(&active_conn, &cancel).await;
        return;
    }
    tracing::debug!(connection_id, "CHANNEL_STATE_END sent");

    // Read loop with displacement cancellation
    let mut reader = FrameReader::new();
    let mut buf = vec![0u8; 8192];

    loop {
        tokio::select! {
            _ = cancel.notified() => {
                tracing::debug!(connection_id, "connection displaced by new hub");
                break;
            }
            result = read_half.read(&mut buf) => {
                match result {
                    Ok(0) => {
                        tracing::debug!(connection_id, "hub disconnected (EOF)");
                        break;
                    }
                    Ok(n) => {
                        match reader.push(&buf[..n]) {
                            Ok(messages) => {
                                for msg in messages {
                                    if let Err(e) = handle_message(
                                        msg,
                                        Arc::clone(&pty_manager),
                                        frame_tx.clone(),
                                        channel_events.clone(),
                                        Arc::clone(&cmd_senders),
                                    )
                                    .await
                                    {
                                        tracing::error!("message dispatch error: {}", e);
                                        break;
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::error!("frame parse error: {}", e);
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("read error: {}", e);
                        break;
                    }
                }
            }
        }
    }

    clear_active_if_ours(&active_conn, &cancel).await;
}

// ─── Unix (UDS) implementation ────────────────────────────────────────────────

/// Whether a daemon is answering on this socket.
///
/// A socket file that cannot be bound looks the same whether a daemon is
/// serving it or whether it was left behind by one that died. Connecting is
/// what tells them apart: a listener accepts, a leftover file refuses.
#[cfg(unix)]
async fn someone_is_listening(path: &Path) -> bool {
    UnixStream::connect(path).await.is_ok()
}

/// What a socket file is, as the filesystem counts it.
///
/// A path is a name, and names get reused: the socket at a path after a
/// replacement daemon started is not the one this process bound, however
/// identical it looks. The pair `(device, inode)` is what tells them apart.
#[cfg(unix)]
fn socket_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

/// Remove this daemon's socket, and nobody else's.
///
/// On the way out, the path may already carry a replacement's socket: a
/// daemon that started while this one was still tearing terminals down. Taking
/// the name from it would leave it running and unreachable, which is the same
/// harm as taking it at startup (#116).
#[cfg(unix)]
fn remove_own_socket(path: &Path, bound_as: Option<(u64, u64)>) {
    match (socket_identity(path), bound_as) {
        (None, _) => {}
        (Some(now), Some(bound)) if now == bound => {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(%error, path = ?path, "failed to remove daemon socket after shutdown");
                }
            }
        }
        (Some(_), Some(_)) => {
            tracing::info!(
                path = ?path,
                "the socket at this path is not the one this daemon bound; leaving it alone"
            );
        }
        (Some(_), None) => {
            tracing::warn!(
                path = ?path,
                "this daemon never recorded which socket it bound; leaving the path alone"
            );
        }
    }
}

/// Take the socket, or refuse to take it from a daemon that is serving it.
///
/// The bind is retried because a socket this process has just unlinked can
/// still be refused for a moment. What is *not* retried is displacing a live
/// daemon: unlinking its socket would bind this process in its place and leave
/// it holding terminals nobody can reach any more (#454). The hub connects
/// before it ever starts one, so reaching this state means something else did
/// — and the answer is to say so rather than to take over.
#[cfg(unix)]
async fn bind_with_retry(path: &Path) -> std::io::Result<UnixListener> {
    let mut last_err = None;
    for attempt in 0..BIND_RETRY_MAX {
        match UnixListener::bind(path) {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                if someone_is_listening(path).await {
                    tracing::error!(
                        "a daemon is already serving {:?}; refusing to take its socket",
                        path
                    );
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AddrInUse,
                        format!(
                            "another agent daemon is already listening on {}",
                            path.display()
                        ),
                    ));
                }
                tracing::warn!("bind attempt {} failed: {}", attempt + 1, e);
                last_err = Some(e);
                if attempt < BIND_RETRY_MAX - 1 {
                    let delay = BIND_RETRY_DELAY_MS + (attempt as u64 * 100);
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    // Nothing answered on it, so the file is what a dead daemon
                    // left behind.
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
    Err(last_err.unwrap())
}

/// Handle a single hub connection:
/// 1. Spawn writer task (drains frame_rx → stream write half)
/// 2. Send HELLO + AGENT_CHANNEL_STATE* + CHANNEL_STATE_END
/// 3. Read loop with displacement cancellation
#[allow(clippy::too_many_arguments)]
#[cfg(unix)]
async fn handle_connection(
    stream: UnixStream,
    pty_manager: Arc<Mutex<PtyManager>>,
    cmd_senders: SnapshotSenders,
    channel_events: ChannelEventSender,
    frame_tx: FrameSender,
    frame_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    active_conn: Arc<Mutex<Option<ActiveConnection>>>,
    cancel: Arc<Notify>,
    expected_token: Option<String>,
    connection_id: u64,
) {
    handle_connection_inner(
        stream,
        pty_manager,
        cmd_senders,
        channel_events,
        frame_tx,
        frame_rx,
        active_conn,
        cancel,
        expected_token,
        connection_id,
    )
    .await
}

/// Make an authenticated connection the active hub, displacing the previous one.
///
/// Only an authenticated peer gets here. Before this, a connection receives no
/// terminal output (the output router writes to the active connection only)
/// and cannot push the incumbent off: a peer that fails AUTH, such as a second
/// hub holding another token, used to displace a working hub (#127).
async fn register_active(
    active_conn: &Arc<Mutex<Option<ActiveConnection>>>,
    connection_id: u64,
    cancel: &Arc<Notify>,
    frame_tx: &FrameSender,
) {
    let mut conn = active_conn.lock().await;
    if let Some(old) = conn.take() {
        tracing::info!(
            connection_id,
            displaced_connection_id = old.connection_id,
            "displacing previous hub connection"
        );
        // Tell it before cutting it. A hub that is simply cancelled cannot tell
        // "I am no longer the one driving this agent" from "these terminals
        // stopped answering", and writes into a socket nothing reads (#127).
        let notice = AgentToHub::Error {
            code: crate::protocol::error_codes::DISPLACED.into(),
            message: format!("another hub connection (#{connection_id}) has taken over this agent"),
            channel_id: None,
        };
        let _ = send_encoded(&old.frame_tx, &notice);
        // notify_waiters wakes ALL listeners (writer task + read loop)
        old.cancel.notify_waiters();
    }
    *conn = Some(ActiveConnection {
        connection_id,
        cancel: Arc::clone(cancel),
        frame_tx: frame_tx.clone(),
    });
}

/// Clear the active connection slot only if it belongs to this connection.
/// Uses Arc pointer equality on the cancel token to avoid clearing a newer connection.
async fn clear_active_if_ours(
    active_conn: &Arc<Mutex<Option<ActiveConnection>>>,
    our_cancel: &Arc<Notify>,
) {
    let mut conn = active_conn.lock().await;
    if let Some(ref active) = *conn {
        if Arc::ptr_eq(&active.cancel, our_cancel) {
            *conn = None;
        }
    }
}

/// Encode a message and push the frame bytes into the frame channel.
fn send_encoded(tx: &FrameSender, msg: &AgentToHub) -> Result<(), mpsc::error::SendError<Vec<u8>>> {
    match encode_frame(msg) {
        Ok(frame) => tx.send(frame),
        Err(_) => Err(mpsc::error::SendError(vec![])),
    }
}

/// Spawn the output router task.
///
/// Drains what the batch loop hands on — every channel's output, and its exit,
/// title, bell, notification and log frames — and forwards it to the connection
/// active when it is sent, whichever connection spawned the channel (#549).
/// Buffers up to MAX_FRAME_QUEUE frames when no hub is connected (ring buffer, drops oldest).
fn spawn_output_router(
    mut batched_rx: mpsc::UnboundedReceiver<BatchedEvent>,
    active_conn: Arc<Mutex<Option<ActiveConnection>>>,
) {
    tokio::spawn(async move {
        let mut pending: Vec<Vec<u8>> = Vec::new();

        while let Some(event) = batched_rx.recv().await {
            if let Ok(frame) = event.into_frame() {
                let conn = active_conn.lock().await;
                if let Some(ref active) = *conn {
                    // Flush pending buffer first (maintain ordering)
                    for pf in pending.drain(..) {
                        let _ = active.frame_tx.send(pf);
                    }
                    let _ = active.frame_tx.send(frame);
                } else {
                    // No active connection — buffer, drop oldest if full
                    if pending.len() >= MAX_FRAME_QUEUE {
                        pending.remove(0);
                    }
                    pending.push(frame);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_path(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}",
            prefix,
            ulid::Ulid::generate().to_string().to_lowercase()
        ))
    }

    async fn temp_dir(prefix: &str) -> PathBuf {
        let dir = temp_path(prefix);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    fn no_shutdown_request() -> ShutdownReceiver {
        shutdown_channel().1
    }

    /// Verify short socket paths pass the length guard (Unix).
    #[cfg(unix)]
    #[test]
    fn test_socket_path_validation_short() {
        assert!(PathBuf::from("/tmp/test.sock").as_os_str().len() <= 100);
    }

    /// Verify long socket paths would fail the length guard (Unix).
    #[cfg(unix)]
    #[test]
    fn test_socket_path_validation_too_long() {
        let long_path = format!("/tmp/{}/agent.sock", "a".repeat(200));
        assert!(PathBuf::from(&long_path).as_os_str().len() > 100);
    }

    /// Verify the Windows pipe name follows the canonical format.
    #[cfg(windows)]
    #[test]
    fn test_get_pipe_name_format() {
        // One literal for the check, the diagnostic and the trim. It was written three
        // times, and the diagnostic's copy had an unescaped backslash — so the compiler
        // read `\t` as a tab and the message named a prefix nothing uses, which no
        // rename of the product name could reach because the name was no longer in it.
        const EXPECTED_PREFIX: &str = r"\\.\pipe\lasterm-agent-";
        let name = get_pipe_name();
        assert!(
            name.starts_with(EXPECTED_PREFIX),
            "pipe name must start with {EXPECTED_PREFIX}, got: {name}"
        );
        // Must include at least one character of username after the dash
        let suffix = name.trim_start_matches(EXPECTED_PREFIX);
        assert!(!suffix.is_empty(), "pipe name must include username");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_daemon_starts_and_accepts() {
        // Use an empty temp dir as config_dir — no auth.json → no auth required.
        // Pass directly to run_daemon_impl to avoid env var mutation races.
        let empty_config = std::env::temp_dir().join(format!(
            "lasterm-test-cfg-noop-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&empty_config).await.unwrap();
        let config_dir = empty_config.to_string_lossy().to_string();
        let state_dir = temp_dir("lasterm-test-state-noop").await;

        let sock_name = format!(
            "lasterm-test-{}.sock",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let path = std::env::temp_dir().join(&sock_name);
        let path_str = path.to_string_lossy().to_string();

        // Start daemon in background
        let daemon_handle = tokio::spawn(run_daemon_impl(
            path_str.clone(),
            config_dir.clone(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        ));

        // Wait for daemon to bind
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        // Connect
        let mut stream = UnixStream::connect(&path_str).await.unwrap();

        // Should receive framed HELLO
        let mut buf = vec![0u8; 4096];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n >= 4, "expected at least a 4-byte frame header");

        // Decode first frame: 4-byte LE u32 length prefix
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert!(n >= 4 + len, "full HELLO frame not received in single read");
        let payload = &buf[4..4 + len];
        let value: serde_json::Value = rmp_serde::from_slice(payload).unwrap();
        assert_eq!(value["type"], "HELLO", "first message must be HELLO");

        drop(stream);
        daemon_handle.abort();
        let _ = std::fs::remove_file(&path_str);
        let _ = tokio::fs::remove_dir_all(&empty_config).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_connection_displacement() {
        let empty_config = std::env::temp_dir().join(format!(
            "lasterm-test-cfg-disp-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&empty_config).await.unwrap();
        let config_dir = empty_config.to_string_lossy().to_string();
        let state_dir = temp_dir("lasterm-test-state-disp").await;

        let sock_name = format!(
            "lasterm-test-displace-{}.sock",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let path = std::env::temp_dir().join(&sock_name);
        let path_str = path.to_string_lossy().to_string();

        let daemon_handle = tokio::spawn(run_daemon_impl(
            path_str.clone(),
            config_dir.clone(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        // First client connects
        let mut stream1 = UnixStream::connect(&path_str).await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = stream1.read(&mut buf).await.unwrap(); // drain initial frames

        // Second client connects — displaces first
        let mut stream2 = UnixStream::connect(&path_str).await.unwrap();
        let _ = stream2.read(&mut buf).await.unwrap(); // drain initial frames

        // The one being displaced is told so before it is cut. Without that it
        // cannot tell "I am no longer driving this agent" from "these terminals
        // stopped answering", and writes into a socket nothing reads (#127).
        //
        // The frame is MessagePack, which writes strings literally, so looking
        // for the code in the bytes is enough here and does not need a decoder.
        let mut said_displaced = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(
                std::time::Duration::from_millis(500),
                stream1.read(&mut buf),
            )
            .await
            {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    if buf[..n].windows(9).any(|w| w == b"DISPLACED") {
                        said_displaced = true;
                        break;
                    }
                }
                Ok(Err(_)) => break,
                Err(_timeout) => break,
            }
        }
        assert!(
            said_displaced,
            "a displaced connection must be told before it is cut"
        );

        drop(stream1);
        drop(stream2);
        daemon_handle.abort();
        let _ = std::fs::remove_file(&path_str);
        let _ = tokio::fs::remove_dir_all(&empty_config).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_socket_permissions() {
        let empty_config = std::env::temp_dir().join(format!(
            "lasterm-test-cfg-perms-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&empty_config).await.unwrap();
        let config_dir = empty_config.to_string_lossy().to_string();
        let state_dir = temp_dir("lasterm-test-state-perms").await;

        let sock_name = format!(
            "lasterm-test-perms-{}.sock",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let path = std::env::temp_dir().join(&sock_name);
        let path_str = path.to_string_lossy().to_string();

        let daemon_handle = tokio::spawn(run_daemon_impl(
            path_str.clone(),
            config_dir.clone(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&path_str).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "socket must be 0600, got {:o}", mode);
        }

        daemon_handle.abort();
        let _ = std::fs::remove_file(&path_str);
        let _ = tokio::fs::remove_dir_all(&empty_config).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_channel_state_end_sent_on_connect() {
        let empty_config = std::env::temp_dir().join(format!(
            "lasterm-test-cfg-stateend-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&empty_config).await.unwrap();
        let config_dir = empty_config.to_string_lossy().to_string();
        let state_dir = temp_dir("lasterm-test-state-stateend").await;

        let sock_name = format!(
            "lasterm-test-state-end-{}.sock",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let path = std::env::temp_dir().join(&sock_name);
        let path_str = path.to_string_lossy().to_string();

        let daemon_handle = tokio::spawn(run_daemon_impl(
            path_str.clone(),
            config_dir.clone(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mut stream = UnixStream::connect(&path_str).await.unwrap();
        let mut buf = vec![0u8; 65536];
        let mut accumulated: Vec<u8> = Vec::new();
        let mut found_hello = false;
        let mut found_state_end = false;

        // Read frames for up to 500 ms
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), async {
            loop {
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                accumulated.extend_from_slice(&buf[..n]);

                // Parse complete frames
                let mut pos = 0;
                while pos + 4 <= accumulated.len() {
                    let len = u32::from_le_bytes([
                        accumulated[pos],
                        accumulated[pos + 1],
                        accumulated[pos + 2],
                        accumulated[pos + 3],
                    ]) as usize;
                    if pos + 4 + len > accumulated.len() {
                        break;
                    }
                    let payload = &accumulated[pos + 4..pos + 4 + len];
                    if let Ok(v) = rmp_serde::from_slice::<serde_json::Value>(payload) {
                        match v["type"].as_str() {
                            Some("HELLO") => found_hello = true,
                            Some("CHANNEL_STATE_END") => {
                                found_state_end = true;
                                return; // got what we need
                            }
                            _ => {}
                        }
                    }
                    pos += 4 + len;
                }
            }
        })
        .await;

        // Re-parse accumulated in case timeout fired mid-frame
        let mut pos = 0;
        while pos + 4 <= accumulated.len() {
            let len = u32::from_le_bytes([
                accumulated[pos],
                accumulated[pos + 1],
                accumulated[pos + 2],
                accumulated[pos + 3],
            ]) as usize;
            if pos + 4 + len > accumulated.len() {
                break;
            }
            let payload = &accumulated[pos + 4..pos + 4 + len];
            if let Ok(v) = rmp_serde::from_slice::<serde_json::Value>(payload) {
                match v["type"].as_str() {
                    Some("HELLO") => found_hello = true,
                    Some("CHANNEL_STATE_END") => found_state_end = true,
                    _ => {}
                }
            }
            pos += 4 + len;
        }

        assert!(found_hello, "HELLO must be sent on connect");
        assert!(found_state_end, "CHANNEL_STATE_END must be sent on connect");

        drop(stream);
        daemon_handle.abort();
        let _ = std::fs::remove_file(&path_str);
        let _ = tokio::fs::remove_dir_all(&empty_config).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    #[cfg(target_os = "linux")]
    mod daemon_shutdown_tests {
        use std::fs;
        use std::io::{self, Write};
        use std::path::{Path, PathBuf};
        use std::sync::{Arc, Mutex as StdMutex};
        use std::time::{Duration, Instant};

        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixStream;
        use tracing::instrument::WithSubscriber;
        use tracing_subscriber::fmt::MakeWriter;

        use super::*;
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        const FIXTURE_DEADLINE: Duration = Duration::from_secs(3);

        struct ProcessCleanup {
            pid: i32,
            armed: bool,
        }

        impl ProcessCleanup {
            fn disarm(mut self) {
                self.armed = false;
            }
        }

        impl Drop for ProcessCleanup {
            fn drop(&mut self) {
                if self.armed {
                    // SAFETY: `pid` was written by the short-lived shell this
                    // test spawned, and this is test-fixture cleanup only.
                    unsafe {
                        libc::kill(self.pid, libc::SIGKILL);
                    }
                }
            }
        }

        struct TracedProcessCleanup {
            pid: i32,
            armed: bool,
        }

        impl TracedProcessCleanup {
            fn release(mut self) {
                // SAFETY: the test successfully seized this process and has
                // left it stopped at its exit event.
                unsafe {
                    libc::ptrace(
                        libc::PTRACE_CONT,
                        self.pid,
                        std::ptr::null_mut::<libc::c_void>(),
                        std::ptr::null_mut::<libc::c_void>(),
                    );
                    let mut status = 0;
                    libc::waitpid(self.pid, &mut status, 0);
                }
                self.armed = false;
            }
        }

        impl Drop for TracedProcessCleanup {
            fn drop(&mut self) {
                if !self.armed {
                    return;
                }
                // SAFETY: this test owns the seized fixture process. Resume it
                // after SIGKILL so an assertion failure cannot strand it.
                unsafe {
                    libc::kill(self.pid, libc::SIGKILL);
                    libc::ptrace(
                        libc::PTRACE_CONT,
                        self.pid,
                        std::ptr::null_mut::<libc::c_void>(),
                        std::ptr::null_mut::<libc::c_void>(),
                    );
                    let mut status = 0;
                    libc::waitpid(self.pid, &mut status, libc::WNOHANG);
                }
            }
        }

        #[derive(Clone)]
        struct LogCapture(Arc<StdMutex<Vec<u8>>>);

        struct LogCaptureWriter(LogCapture);

        impl Write for LogCaptureWriter {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0 .0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl<'a> MakeWriter<'a> for LogCapture {
            type Writer = LogCaptureWriter;

            fn make_writer(&'a self) -> Self::Writer {
                LogCaptureWriter(self.clone())
            }
        }

        fn pid_file(prefix: &str) -> PathBuf {
            std::env::temp_dir().join(format!(
                "lasterm-daemon-shutdown-{}-{}.pid",
                prefix,
                ulid::Ulid::generate().to_string().to_lowercase()
            ))
        }

        fn shell_quote(value: &str) -> String {
            format!("'{}'", value.replace('\'', "'\\\"'\\\"'"))
        }

        async fn wait_for_pid(path: &Path) -> i32 {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                if let Ok(contents) = fs::read_to_string(path) {
                    if let Ok(pid) = contents.trim().parse() {
                        return pid;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "spawned workload did not write its PID to {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn wait_for_socket(path: &Path) {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                if path.exists() {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "daemon did not bind socket at {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn pid_is_alive(pid: i32) -> bool {
            // SAFETY: signal 0 checks liveness without delivering a signal.
            let result = unsafe { libc::kill(pid, 0) };
            if result == 0 {
                return true;
            }
            io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }

        async fn wait_until_gone(pid: i32) {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            while pid_is_alive(pid).await {
                assert!(
                    Instant::now() < deadline,
                    "terminal workload PID {pid} survived daemon shutdown"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn spawn_sleeping_workload(
            socket_path: &str,
            channel_id: &str,
            pid_path: &Path,
        ) -> (UnixStream, i32) {
            let mut stream = UnixStream::connect(socket_path)
                .await
                .expect("connect to daemon");
            let quoted_pid_path = shell_quote(&pid_path.to_string_lossy());
            let spawn = HubToAgent::Spawn {
                request_id: format!("request-{channel_id}"),
                channel_id: Some(channel_id.to_string()),
                shell: Some("/bin/sh".to_string()),
                args: Some(vec![
                    "-c".to_string(),
                    format!("printf '%s\\n' \"$$\" > {}; exec sleep 30", quoted_pid_path),
                ]),
                cwd: None,
                env: None,
                cols: 80,
                rows: 24,
                direct_process: None,
                elevated: None,
                elevation_secret: None,
                elevation_method: None,
                custom_command: None,
            };
            stream
                .write_all(&encode_frame(&spawn).expect("encode SPAWN"))
                .await
                .expect("send SPAWN");
            let pid = wait_for_pid(pid_path).await;
            (stream, pid)
        }

        async fn daemon_paths(label: &str) -> (String, String, PathBuf) {
            let config_dir = temp_dir(&format!("lasterm-daemon-shutdown-config-{label}")).await;
            let state_dir = temp_dir(&format!("lasterm-daemon-shutdown-state-{label}")).await;
            let socket_path = temp_path(&format!("lasterm-daemon-shutdown-{label}"));
            (
                socket_path.to_string_lossy().to_string(),
                config_dir.to_string_lossy().to_string(),
                state_dir,
            )
        }

        async fn cleanup_paths(socket_path: &str, config_dir: &str, state_dir: &Path) {
            let _ = fs::remove_file(socket_path);
            let _ = tokio::fs::remove_dir_all(config_dir).await;
            let _ = tokio::fs::remove_dir_all(state_dir).await;
        }

        /// A daemon on its way out must not take the name from the socket that
        /// replaced it while it was tearing its terminals down (#116). It is a
        /// path, and paths get reused.
        #[tokio::test]
        async fn a_departing_daemon_leaves_a_replacement_socket_alone() {
            let (socket_path, config_dir, state_dir) = daemon_paths("inode-identity").await;
            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let daemon = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                shutdown_rx,
                None,
                None,
            ));
            wait_for_socket(Path::new(&socket_path)).await;

            // Someone else's socket takes the name while this one is still up.
            let path = Path::new(&socket_path);
            let ours = socket_identity(path).expect("the daemon's own socket");
            std::fs::remove_file(path).expect("take the name");
            let replacement = UnixListener::bind(path).expect("bind a replacement");
            let theirs = socket_identity(path).expect("the replacement's socket");
            assert_ne!(ours, theirs, "the replacement must be a different socket");

            let _ = shutdown_tx.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(10), daemon).await;

            assert_eq!(
                socket_identity(path),
                Some(theirs),
                "the departing daemon removed the socket that had taken its place"
            );
            drop(replacement);
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        /// And the ordinary case: its own socket goes with it, so the next
        /// daemon does not have to clean up after this one.
        #[tokio::test]
        async fn a_departing_daemon_removes_its_own_socket() {
            let (socket_path, config_dir, state_dir) = daemon_paths("inode-own").await;
            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let daemon = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                shutdown_rx,
                None,
                None,
            ));
            wait_for_socket(Path::new(&socket_path)).await;

            let _ = shutdown_tx.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(10), daemon).await;

            assert!(
                !Path::new(&socket_path).exists(),
                "a daemon should take its own socket with it"
            );
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        /// The socket of a daemon that is serving belongs to it. Taking it
        /// would bind this process in its place and leave the first holding
        /// terminals nobody can reach (#454).
        #[tokio::test]
        async fn a_second_daemon_refuses_the_socket_of_one_that_is_serving() {
            let (socket_path, config_dir, state_dir) = daemon_paths("socket-taken").await;
            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let first = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                shutdown_rx,
                None,
                None,
            ));
            wait_for_socket(Path::new(&socket_path)).await;

            let second = run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                no_shutdown_request(),
                None,
                None,
            )
            .await;

            let error = second.expect_err("the second daemon must not take a served socket");
            assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse, "{error}");
            assert!(
                Path::new(&socket_path).exists(),
                "the first daemon's socket must still be there"
            );

            let _ = shutdown_tx.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(10), first).await;
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        /// And the other way: a socket nobody answers on is what a daemon that
        /// died left behind, and starting over means taking it.
        #[tokio::test]
        async fn a_daemon_takes_over_a_socket_nobody_answers_on() {
            let (socket_path, config_dir, state_dir) = daemon_paths("socket-stale").await;
            // A file where the socket goes, with nothing behind it.
            tokio::fs::write(&socket_path, b"")
                .await
                .expect("write a leftover file");

            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let daemon = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                shutdown_rx,
                None,
                None,
            ));
            // The file was there from the start, so its existence proves
            // nothing: wait until something answers on it.
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                if someone_is_listening(Path::new(&socket_path)).await {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "the daemon never took over the leftover socket"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            let _ = shutdown_tx.send(true);
            let ended = tokio::time::timeout(Duration::from_secs(10), daemon).await;
            assert!(
                ended.is_ok(),
                "the daemon should have started on the stale path"
            );
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        /// A daemon left on a machine the hub merely reaches should not outlive
        /// its purpose: nothing to hold, nobody connected, so it goes.
        #[tokio::test]
        async fn an_idle_daemon_holding_nothing_exits_on_its_own() {
            let (socket_path, config_dir, state_dir) = daemon_paths("idle-exit").await;
            let daemon = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                no_shutdown_request(),
                None,
                Some(Duration::from_millis(200)),
            ));
            wait_for_socket(Path::new(&socket_path)).await;

            let ended = tokio::time::timeout(Duration::from_secs(10), daemon).await;
            assert!(
                ended.is_ok(),
                "a daemon with no terminals and no hub should have exited on its own"
            );
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        /// The other half, and the one that matters: a daemon holding a
        /// terminal waits however long it takes for someone to come back for
        /// it. An idle timeout that ended terminals would defeat the daemon.
        #[tokio::test]
        async fn a_daemon_holding_a_terminal_does_not_exit_when_nobody_is_connected() {
            let (socket_path, config_dir, state_dir) = daemon_paths("idle-holds").await;
            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let daemon = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                shutdown_rx,
                None,
                Some(Duration::from_millis(200)),
            ));
            wait_for_socket(Path::new(&socket_path)).await;

            let pid_path = pid_file("idle-holds");
            let (stream, pid) =
                spawn_sleeping_workload(&socket_path, "idle-holds-channel", &pid_path).await;
            let cleanup = ProcessCleanup { pid, armed: true };
            // Nobody is connected any more; the terminal is still there.
            drop(stream);

            tokio::time::sleep(Duration::from_millis(900)).await;
            assert!(
                !daemon.is_finished(),
                "a daemon still holding a terminal must wait, however long nobody comes"
            );

            let _ = shutdown_tx.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(10), daemon).await;
            drop(cleanup);
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        #[tokio::test]
        async fn shutdown_request_runs_destroy_all_for_daemon_owned_channels() {
            let (socket_path, config_dir, state_dir) = daemon_paths("destroy-all").await;
            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let daemon = tokio::spawn(run_daemon_impl(
                socket_path.clone(),
                config_dir.clone(),
                state_dir.clone(),
                shutdown_rx,
                None,
                None,
            ));
            wait_for_socket(Path::new(&socket_path)).await;

            let pid_path = pid_file("destroy-all");
            let (_stream, pid) =
                spawn_sleeping_workload(&socket_path, "destroy-all-daemon-channel", &pid_path)
                    .await;
            let cleanup = ProcessCleanup { pid, armed: true };

            shutdown_tx.send(true).expect("request daemon shutdown");
            tokio::time::timeout(Duration::from_secs(3), daemon)
                .await
                .expect("daemon shutdown must return")
                .expect("daemon task must not panic")
                .expect("daemon shutdown must succeed");
            wait_until_gone(pid).await;
            cleanup.disarm();

            // Mutation caught: removing `destroy_all()` from the daemon
            // shutdown path returns the loop but leaves this PID alive.
            let _ = fs::remove_file(pid_path);
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }

        #[tokio::test]
        async fn shutdown_with_an_unconfirmed_workload_returns_failing_status() {
            let (socket_path, config_dir, state_dir) = daemon_paths("unresolved").await;
            let (shutdown_tx, shutdown_rx) = shutdown_channel();
            let captured = LogCapture(Arc::new(StdMutex::new(Vec::new())));
            let dispatch = tracing::Dispatch::new(
                tracing_subscriber::fmt()
                    .with_ansi(false)
                    .without_time()
                    .with_writer(captured.clone())
                    .finish(),
            );
            let manager = Arc::new(Mutex::new(PtyManager::with_teardown_wait_timeout(
                Duration::from_millis(25),
            )));
            let daemon = tokio::spawn(
                run_daemon_impl_with_manager(
                    socket_path.clone(),
                    config_dir.clone(),
                    state_dir.clone(),
                    shutdown_rx,
                    manager,
                    None,
                    None,
                )
                .with_subscriber(dispatch),
            );
            wait_for_socket(Path::new(&socket_path)).await;

            let pid_path = pid_file("unresolved");
            let (_stream, pid) =
                spawn_sleeping_workload(&socket_path, "unresolved-daemon-channel", &pid_path).await;
            // Keep cleanup armed even if ptrace setup is unavailable or a later
            // assertion fails before the traced-fixture guard takes ownership.
            let cleanup = ProcessCleanup { pid, armed: true };
            // PTRACE_O_TRACEEXIT leaves the fixture stopped after SIGKILL until
            // the test releases it, so destroy_all records the injected wait bound.
            // SAFETY: `pid` belongs to the fixture this test just spawned.
            let seize = unsafe {
                libc::ptrace(
                    libc::PTRACE_SEIZE,
                    pid,
                    std::ptr::null_mut::<libc::c_void>(),
                    libc::PTRACE_O_TRACEEXIT as *mut libc::c_void,
                )
            };
            if seize != 0 {
                let error = io::Error::last_os_error();
                // Containers and seccomp profiles can forbid PTRACE_SEIZE even
                // when teardown is correct, so skip this ptrace-only fixture.
                // `writeln!` writes directly to stderr rather than the test
                // harness's captured output, so a constrained environment
                // reports this as an explicit SKIP instead of a silent pass.
                use std::io::Write;
                let _ = writeln!(
                    std::io::stderr(),
                    "SKIP shutdown_with_an_unconfirmed_workload_returns_failing_status: PTRACE_SEIZE is unavailable: {error}"
                );
                shutdown_tx.send(true).expect("request daemon shutdown");
                tokio::time::timeout(Duration::from_secs(3), daemon)
                    .await
                    .expect("daemon shutdown must return")
                    .expect("daemon task must not panic")
                    .expect("daemon shutdown must succeed");
                wait_until_gone(pid).await;
                cleanup.disarm();
                let _ = fs::remove_file(pid_path);
                cleanup_paths(&socket_path, &config_dir, &state_dir).await;
                return;
            }
            cleanup.disarm();
            let cleanup = TracedProcessCleanup { pid, armed: true };

            shutdown_tx.send(true).expect("request daemon shutdown");
            let summary = tokio::time::timeout(Duration::from_secs(3), daemon)
                .await
                .expect("daemon returns after unresolved workload wait bound")
                .expect("daemon task must not panic")
                .expect("daemon shutdown must succeed");

            assert_eq!(
                teardown_exit_status(&summary),
                1,
                "an unresolved terminal must make daemon shutdown report failure"
            );

            let logs = String::from_utf8(captured.0.lock().unwrap().clone())
                .expect("captured tracing output is UTF-8");
            assert!(logs.contains("daemon terminal teardown complete"), "{logs}");
            assert!(logs.contains("unresolved_channels=1"));
            assert!(logs.contains("daemon terminal teardown unresolved channel"));
            assert!(logs.contains("channel_id=unresolved-daemon-channel"));
            assert!(logs.contains(&format!("pid={pid}")));
            assert!(logs.contains("reason=TimedOut"));

            cleanup.release();
            // Mutation caught: returning success whenever the daemon loop ends
            // makes this unconfirmed workload look clean to the parent process.
            let _ = fs::remove_file(pid_path);
            cleanup_paths(&socket_path, &config_dir, &state_dir).await;
        }
    }

    /// Verify a named pipe server instance can be created successfully on Windows.
    #[cfg(windows)]
    #[tokio::test]
    async fn test_named_pipe_creates_and_accepts() {
        use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

        let pipe_name = format!(
            r"\\.\pipe\lasterm-test-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        );

        // Create server
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("server creation must succeed");

        // Connect client in background (retry briefly until server is ready)
        let pipe_name_c = pipe_name.clone();
        let client_task = tokio::spawn(async move {
            for _ in 0..10u32 {
                match ClientOptions::new().open(&pipe_name_c) {
                    Ok(c) => return c,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                }
            }
            ClientOptions::new().open(&pipe_name_c).unwrap()
        });

        server
            .connect()
            .await
            .expect("connect() must succeed when client connects");

        let _client = client_task.await.expect("client task must succeed");
    }

    // ── Auth helper unit tests (cross-platform) ──────────────────────────────

    /// ct_eq returns true for identical byte slices.
    #[test]
    fn test_ct_eq_match() {
        assert!(ct_eq(b"deadbeef", b"deadbeef"));
    }

    /// ct_eq returns false for different byte slices of equal length.
    #[test]
    fn test_ct_eq_mismatch() {
        assert!(!ct_eq(b"deadbeef", b"deadbee0"));
    }

    /// ct_eq returns false for slices of different lengths.
    #[test]
    fn test_ct_eq_length_mismatch() {
        assert!(!ct_eq(b"short", b"longer"));
    }

    const HUB_TOKEN: &str = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

    /// An active hub connection, and a waiter that records whether it was displaced.
    fn incumbent_hub() -> (Arc<Mutex<Option<ActiveConnection>>>, Arc<Notify>) {
        let cancel = Arc::new(Notify::new());
        let (frame_tx, _frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let active = Arc::new(Mutex::new(Some(ActiveConnection {
            connection_id: 7,
            cancel: Arc::clone(&cancel),
            frame_tx,
        })));
        (active, cancel)
    }

    /// Run the connection handshake over an in-memory stream, sending `token`.
    /// Returns the client end, which keeps the connection open while held.
    async fn connect_with_token(
        active_conn: &Arc<Mutex<Option<ActiveConnection>>>,
        token: &str,
    ) -> (tokio::io::DuplexStream, tokio::task::JoinHandle<()>) {
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let (frame_tx, frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (channel_events, _channel_events_rx) = mpsc::unbounded_channel::<ChannelEvent>();
        let auth = encode_frame(&HubToAgent::Auth {
            token: token.to_string(),
        })
        .expect("encode AUTH");
        let handler = tokio::spawn(handle_connection_inner(
            server,
            Arc::new(Mutex::new(PtyManager::new())),
            Arc::new(Mutex::new(std::collections::HashMap::new())),
            channel_events,
            frame_tx,
            frame_rx,
            Arc::clone(active_conn),
            Arc::new(Notify::new()),
            Some(HUB_TOKEN.to_string()),
            42,
        ));
        client.write_all(&auth).await.expect("send AUTH");
        (client, handler)
    }

    /// A peer that fails AUTH neither displaces the active hub nor becomes it (#127).
    #[tokio::test]
    async fn failed_auth_leaves_the_active_hub_in_place() {
        let (active_conn, incumbent_cancel) = incumbent_hub();
        let displaced = incumbent_cancel.notified();
        tokio::pin!(displaced);
        displaced.as_mut().enable();

        let (_client, handler) = connect_with_token(
            &active_conn,
            "000000def456abc123def456abc123def456abc123def456abc123def456abc1",
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(5), handler)
            .await
            .expect("a refused peer's handler ends")
            .expect("handler does not panic");

        // Mutation caught: registering at accept time made this peer the
        // active connection and cancelled the incumbent before AUTH was read.
        assert_eq!(
            active_conn.lock().await.as_ref().map(|c| c.connection_id),
            Some(7)
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), displaced)
                .await
                .is_err(),
            "the incumbent hub must not be displaced by a peer that failed AUTH"
        );
    }

    /// An authenticated hub takes over from the previous one.
    #[tokio::test]
    async fn authenticated_hub_displaces_the_previous_one() {
        let (active_conn, incumbent_cancel) = incumbent_hub();
        let displaced = incumbent_cancel.notified();
        tokio::pin!(displaced);
        displaced.as_mut().enable();

        let (client, handler) = connect_with_token(&active_conn, HUB_TOKEN).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), displaced)
            .await
            .expect("the previous hub is displaced once the new one authenticates");
        assert_eq!(
            active_conn.lock().await.as_ref().map(|c| c.connection_id),
            Some(42)
        );

        drop(client);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handler).await;
    }

    /// validate_auth accepts a correctly framed AUTH message with the right token.
    #[tokio::test]
    async fn test_validate_auth_correct_token() {
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        let token = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";
        let msg = HubToAgent::Auth {
            token: token.to_string(),
        };
        let frame = encode_frame(&msg).expect("encode must succeed");

        let mut cursor = std::io::Cursor::new(frame);
        let result = validate_auth(&mut cursor, token).await;
        assert!(result.is_ok(), "validate_auth must not error: {:?}", result);
        assert!(result.unwrap(), "correct token must return true");
    }

    /// validate_auth rejects a wrong token.
    #[tokio::test]
    async fn test_validate_auth_wrong_token() {
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        let real_token = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";
        let wrong_token = "000000def456abc123def456abc123def456abc123def456abc123def456abc1";
        let msg = HubToAgent::Auth {
            token: wrong_token.to_string(),
        };
        let frame = encode_frame(&msg).expect("encode must succeed");

        let mut cursor = std::io::Cursor::new(frame);
        let result = validate_auth(&mut cursor, real_token).await;
        assert!(result.is_ok(), "validate_auth must not error on mismatch");
        assert!(!result.unwrap(), "wrong token must return false");
    }

    /// validate_auth returns an error when the stream is empty (no AUTH frame sent).
    #[tokio::test]
    async fn test_validate_auth_empty_stream() {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        let result = validate_auth(&mut cursor, "anytoken").await;
        assert!(result.is_err(), "empty stream must return an error");
    }

    /// validate_auth rejects a frame whose type is not AUTH.
    #[tokio::test]
    async fn test_validate_auth_wrong_message_type() {
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        // Send a HEARTBEAT (any non-AUTH message)
        let msg = HubToAgent::Heartbeat {
            ts: "2026-01-01T00:00:00Z".to_string(),
        };
        let frame = encode_frame(&msg).expect("encode must succeed");

        let mut cursor = std::io::Cursor::new(frame);
        let result = validate_auth(&mut cursor, "anytoken").await;
        assert!(result.is_ok());
        assert!(!result.unwrap(), "non-AUTH message type must return false");
    }

    /// read_auth_token returns None for a non-existent file.
    #[tokio::test]
    async fn test_read_auth_token_missing_file() {
        let state_dir = temp_dir("lasterm-test-state-missing-auth").await;
        let result =
            read_auth_token_with_state_dir("/tmp/lasterm-nonexistent-99999/", &state_dir).await;
        assert!(result.is_none(), "missing file must return None");
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// read_auth_token parses a valid auth.json correctly.
    #[tokio::test]
    async fn test_read_auth_token_valid() {
        let dir = std::env::temp_dir().join(format!(
            "lasterm-auth-test-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let auth_path = dir.join("auth.json");
        tokio::fs::write(&auth_path, r#"{"token":"deadbeef1234"}"#)
            .await
            .unwrap();
        let state_dir = temp_dir("lasterm-auth-state").await;

        let result = read_auth_token_with_state_dir(&dir.to_string_lossy(), &state_dir).await;
        assert_eq!(result, Some("deadbeef1234".to_string()));

        let _ = tokio::fs::remove_dir_all(&dir).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// read_auth_token returns Some("") (fail-closed) for malformed JSON.
    #[tokio::test]
    async fn test_read_auth_token_malformed() {
        let dir = std::env::temp_dir().join(format!(
            "lasterm-auth-bad-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let auth_path = dir.join("auth.json");
        tokio::fs::write(&auth_path, b"not json at all")
            .await
            .unwrap();
        let state_dir = temp_dir("lasterm-auth-bad-state").await;

        let result = read_auth_token_with_state_dir(&dir.to_string_lossy(), &state_dir).await;
        // Fail-closed: file exists but is malformed → Some("") so auth always fails
        assert_eq!(
            result,
            Some(String::new()),
            "malformed JSON must return Some(\"\") to fail-closed"
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// read_auth_token returns Some("") (fail-closed) for JSON missing the 'token' field.
    #[tokio::test]
    async fn test_read_auth_token_missing_token_field() {
        let dir = std::env::temp_dir().join(format!(
            "lasterm-auth-nofield-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let auth_path = dir.join("auth.json");
        tokio::fs::write(&auth_path, br#"{"other":"value"}"#)
            .await
            .unwrap();
        let state_dir = temp_dir("lasterm-auth-nofield-state").await;

        let result = read_auth_token_with_state_dir(&dir.to_string_lossy(), &state_dir).await;
        // Fail-closed: file exists with valid JSON but no 'token' field
        assert_eq!(
            result,
            Some(String::new()),
            "JSON without 'token' field must return Some(\"\") to fail-closed"
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// Daemon rejects a connection when a wrong token is sent.
    /// New flow: connect → receive HELLO → send wrong AUTH → connection closed.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_daemon_rejects_wrong_auth_token() {
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        // Write auth.json to a temp dir and pass it directly as config_dir to run_daemon_impl.
        let config_dir_path = std::env::temp_dir().join(format!(
            "lasterm-test-cfg-auth-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&config_dir_path).await.unwrap();
        let auth_path = config_dir_path.join("auth.json");
        let expected = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        tokio::fs::write(&auth_path, format!(r#"{{"token":"{}"}}"#, expected))
            .await
            .unwrap();
        let config_dir = config_dir_path.to_string_lossy().to_string();
        let state_dir = temp_dir("lasterm-test-state-auth").await;

        let sock_dir = std::env::temp_dir().join(format!(
            "lasterm-daemon-auth-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        let sock_path = sock_dir.join("agent.sock");
        let path_str = sock_path.to_string_lossy().to_string();

        let daemon_handle = tokio::spawn(run_daemon_impl(
            path_str.clone(),
            config_dir.clone(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mut stream = UnixStream::connect(&path_str).await.unwrap();

        // Step 1: Receive HELLO (agent sends it first in new protocol)
        let mut buf = vec![0u8; 4096];
        let n = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buf))
            .await
            .expect("must not timeout waiting for HELLO")
            .expect("must not error reading HELLO");
        assert!(n >= 4, "must receive HELLO frame header");
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let payload = &buf[4..4 + len];
        let value: serde_json::Value = rmp_serde::from_slice(payload).unwrap();
        assert_eq!(value["type"], "HELLO", "first message must be HELLO");

        // Step 2: Send AUTH with wrong token
        let wrong = HubToAgent::Auth {
            token: "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
        };
        let frame = encode_frame(&wrong).unwrap();
        stream.write_all(&frame).await.unwrap();

        // Step 3: Daemon should close the connection — we should get EOF
        let mut buf2 = vec![0u8; 64];
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buf2)).await;
        match result {
            Ok(Ok(0)) => {}  // EOF — expected
            Ok(Err(_)) => {} // IO error — also acceptable
            Ok(Ok(_n)) => panic!("daemon must not send data after wrong auth"),
            Err(_) => panic!("timeout waiting for connection close after wrong auth"),
        }

        daemon_handle.abort();
        let _ = tokio::fs::remove_dir_all(&config_dir_path).await;
        let _ = tokio::fs::remove_dir_all(&sock_dir).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// Daemon accepts a connection when the correct token is sent.
    /// New flow: connect → receive HELLO → send correct AUTH → receive CHANNEL_STATE_END.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_daemon_accepts_correct_auth_token() {
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        let config_dir_path = std::env::temp_dir().join(format!(
            "lasterm-test-cfg-authok-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&config_dir_path).await.unwrap();
        let auth_path = config_dir_path.join("auth.json");
        let token = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        tokio::fs::write(&auth_path, format!(r#"{{"token":"{}"}}"#, token))
            .await
            .unwrap();
        let config_dir = config_dir_path.to_string_lossy().to_string();
        let state_dir = temp_dir("lasterm-test-state-authok").await;

        let sock_dir = std::env::temp_dir().join(format!(
            "lasterm-daemon-authok-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        let sock_path = sock_dir.join("agent.sock");
        let path_str = sock_path.to_string_lossy().to_string();

        let daemon_handle = tokio::spawn(run_daemon_impl(
            path_str.clone(),
            config_dir.clone(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mut stream = UnixStream::connect(&path_str).await.unwrap();

        // Step 1: Receive HELLO (agent sends it first in new protocol)
        let mut buf = vec![0u8; 4096];
        let n = tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buf))
            .await
            .expect("must not timeout waiting for HELLO")
            .expect("must not error reading HELLO");
        assert!(n >= 4, "must receive HELLO frame header");
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let payload = &buf[4..4 + len];
        let value: serde_json::Value = rmp_serde::from_slice(payload).unwrap();
        assert_eq!(value["type"], "HELLO", "first message must be HELLO");

        // Step 2: Send correct AUTH
        let auth_msg = HubToAgent::Auth {
            token: token.to_string(),
        };
        let frame = encode_frame(&auth_msg).unwrap();
        stream.write_all(&frame).await.unwrap();

        // Step 3: Receive more frames (CHANNEL_STATE_END confirms auth succeeded)
        let mut buf2 = vec![0u8; 4096];
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut buf2)).await;
        let n2 = result
            .expect("must not timeout after correct auth")
            .expect("must not error reading post-auth frames");
        assert!(
            n2 >= 4,
            "must receive at least 4-byte frame header after auth"
        );

        daemon_handle.abort();
        let _ = tokio::fs::remove_dir_all(&config_dir_path).await;
        let _ = tokio::fs::remove_dir_all(&sock_dir).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// Windows: create_secure_pipe creates a pipe that can accept connections.
    #[cfg(windows)]
    #[tokio::test]
    async fn test_create_secure_pipe_accepts_connection() {
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe_name = format!(
            r"\\.\pipe\lasterm-test-secure-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        );

        let server =
            create_secure_pipe(&pipe_name, true).expect("secure pipe creation must succeed");

        let pipe_name_c = pipe_name.clone();
        let client_task = tokio::spawn(async move {
            for _ in 0..10u32 {
                match ClientOptions::new().open(&pipe_name_c) {
                    Ok(c) => return c,
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                }
            }
            ClientOptions::new().open(&pipe_name_c).unwrap()
        });

        server
            .connect()
            .await
            .expect("secure pipe connect() must succeed when owner connects");

        let _client = client_task.await.expect("client task must succeed");
    }

    /// Verify run_daemon (Windows) starts and sends a valid HELLO frame over a named pipe.
    #[cfg(windows)]
    #[tokio::test]
    async fn test_named_pipe_daemon_hello() {
        use tokio::io::AsyncReadExt;
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe_name = format!(
            r"\\.\pipe\lasterm-test-hello-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        );

        let daemon_handle = tokio::spawn(run_daemon(
            pipe_name.clone(),
            no_shutdown_request(),
            None,
            None,
        ));

        // Wait for daemon to create the pipe
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mut client = ClientOptions::new()
            .open(&pipe_name)
            .expect("must connect to daemon pipe");

        let mut buf = vec![0u8; 4096];
        let n = client.read(&mut buf).await.expect("must read HELLO frame");
        assert!(n >= 4, "expected at least a 4-byte frame header");

        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert!(n >= 4 + len, "full HELLO frame not received");
        let payload = &buf[4..4 + len];
        let value: serde_json::Value =
            rmp_serde::from_slice(payload).expect("HELLO must be valid msgpack");
        assert_eq!(value["type"], "HELLO", "first message must be HELLO");

        drop(client);
        daemon_handle.abort();
    }

    /// What a terminal has to say reaches the hub connected when it says it,
    /// not the connection that spawned it (#549), and its output reaches that
    /// hub before its exit.
    ///
    /// Every daemon here listens on a socket or pipe of its own and reads its
    /// configuration and state from temp dirs: never the user's agent, never
    /// the user's profile.
    mod channel_event_routing_tests {
        use std::path::PathBuf;
        use std::time::Duration;

        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        use super::*;
        use crate::framing::encode_frame;
        use crate::protocol::HubToAgent;

        const DEADLINE: Duration = Duration::from_secs(10);

        #[cfg(unix)]
        type HubStream = UnixStream;
        #[cfg(windows)]
        type HubStream = tokio::net::windows::named_pipe::NamedPipeClient;

        struct TestDaemon {
            endpoint: String,
            config_dir: PathBuf,
            state_dir: PathBuf,
            shutdown: watch::Sender<bool>,
            task: tokio::task::JoinHandle<std::io::Result<DestroyAllSummary>>,
        }

        impl TestDaemon {
            async fn start(label: &str) -> Self {
                let config_dir = temp_dir(&format!("lasterm-routing-config-{label}")).await;
                let state_dir = temp_dir(&format!("lasterm-routing-state-{label}")).await;
                let config = config_dir.to_string_lossy().into_owned();
                let (shutdown, shutdown_rx) = shutdown_channel();
                let (bound_tx, bound_rx) = oneshot::channel();
                #[cfg(unix)]
                let (endpoint, daemon) = {
                    let endpoint = temp_path(&format!("lasterm-routing-{label}"))
                        .to_string_lossy()
                        .into_owned();
                    let daemon = run_daemon_impl(
                        endpoint.clone(),
                        config,
                        state_dir.clone(),
                        shutdown_rx,
                        Some(bound_tx),
                        None,
                    );
                    (endpoint, daemon)
                };
                #[cfg(windows)]
                let (endpoint, daemon) = {
                    let endpoint = format!(
                        r"\\.\pipe\lasterm-test-routing-{label}-{}",
                        ulid::Ulid::generate().to_string().to_lowercase()
                    );
                    let daemon = run_daemon_impl(
                        endpoint.clone(),
                        config,
                        state_dir.clone(),
                        shutdown_rx,
                        Some(bound_tx),
                    );
                    (endpoint, daemon)
                };
                let task = tokio::spawn(daemon);
                tokio::time::timeout(DEADLINE, bound_rx)
                    .await
                    .expect("the daemon binds in time")
                    .expect("the daemon reports its bind");
                Self {
                    endpoint,
                    config_dir,
                    state_dir,
                    shutdown,
                    task,
                }
            }

            /// Connect as a hub does, and read up to CHANNEL_STATE_END. A
            /// connection becomes the daemon's active one before the channels
            /// are enumerated, so past this point it is the one routed to.
            async fn connect(&self) -> Hub {
                let mut hub = Hub {
                    stream: self.open().await,
                    received: Vec::new(),
                };
                hub.read_until("CHANNEL_STATE_END").await;
                hub
            }

            #[cfg(unix)]
            async fn open(&self) -> HubStream {
                UnixStream::connect(&self.endpoint)
                    .await
                    .expect("connect to the test daemon")
            }

            #[cfg(windows)]
            async fn open(&self) -> HubStream {
                use tokio::net::windows::named_pipe::ClientOptions;
                // The next pipe instance is created once the previous one has
                // a client, so a connection right after another can find none.
                let deadline = std::time::Instant::now() + DEADLINE;
                loop {
                    match ClientOptions::new().open(&self.endpoint) {
                        Ok(client) => return client,
                        Err(error) => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "connect to the test daemon: {error}"
                            );
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    }
                }
            }

            async fn stop(self) {
                let _ = self.shutdown.send(true);
                let _ = tokio::time::timeout(DEADLINE, self.task).await;
                #[cfg(unix)]
                let _ = std::fs::remove_file(&self.endpoint);
                let _ = tokio::fs::remove_dir_all(&self.config_dir).await;
                let _ = tokio::fs::remove_dir_all(&self.state_dir).await;
            }
        }

        /// The hub's end of a connection to the daemon.
        struct Hub {
            stream: HubStream,
            received: Vec<u8>,
        }

        impl Hub {
            async fn send(&mut self, msg: &HubToAgent) {
                let frame = encode_frame(msg).expect("encode a hub frame");
                self.stream
                    .write_all(&frame)
                    .await
                    .expect("write to the daemon");
            }

            /// The next frame from the daemon. Cancelling it loses nothing: a
            /// partial frame stays in `received`.
            async fn next_frame(&mut self) -> rmpv::Value {
                loop {
                    if self.received.len() >= 4 {
                        let len = u32::from_le_bytes(self.received[..4].try_into().unwrap());
                        let end = 4 + len as usize;
                        if self.received.len() >= end {
                            let frame = rmp_serde::from_slice(&self.received[4..end])
                                .expect("decode a daemon frame");
                            self.received.drain(..end);
                            return frame;
                        }
                    }
                    let mut buf = vec![0u8; 8192];
                    let n = self
                        .stream
                        .read(&mut buf)
                        .await
                        .expect("read from the daemon");
                    assert!(n > 0, "the daemon closed this connection");
                    self.received.extend_from_slice(&buf[..n]);
                }
            }

            async fn frame_within(&mut self, limit: Duration) -> Option<rmpv::Value> {
                tokio::time::timeout(limit, self.next_frame()).await.ok()
            }

            /// Read up to the first frame `last` accepts, and return every
            /// frame read, that one included.
            async fn read_through(
                &mut self,
                last: impl Fn(&rmpv::Value) -> bool,
            ) -> Vec<rmpv::Value> {
                let mut frames = Vec::new();
                loop {
                    let Some(frame) = self.frame_within(DEADLINE).await else {
                        panic!(
                            "the frame awaited did not come within {DEADLINE:?}; received {:?}",
                            frames.iter().map(frame_type).collect::<Vec<_>>()
                        );
                    };
                    let done = last(&frame);
                    frames.push(frame);
                    if done {
                        return frames;
                    }
                }
            }

            async fn read_until(&mut self, kind: &str) -> Vec<rmpv::Value> {
                self.read_through(|frame| frame_type(frame) == kind).await
            }
        }

        fn frame_type(frame: &rmpv::Value) -> &str {
            frame["type"].as_str().unwrap_or("")
        }

        fn is_about(frame: &rmpv::Value, kind: &str, channel_id: &str) -> bool {
            frame_type(frame) == kind && frame["channel_id"].as_str() == Some(channel_id)
        }

        /// What the channel printed, as these frames carried it.
        fn output_of(frames: &[rmpv::Value], channel_id: &str) -> String {
            let mut printed = Vec::new();
            for frame in frames.iter().filter(|f| is_about(f, "OUTPUT", channel_id)) {
                if let rmpv::Value::Binary(data) = &frame["data"] {
                    printed.extend_from_slice(data);
                }
            }
            String::from_utf8_lossy(&printed).into_owned()
        }

        /// SPAWN a shell running `command`, then ending.
        fn spawn(channel_id: &str, command: &str) -> HubToAgent {
            let (shell, run) = if cfg!(windows) {
                ("cmd.exe", "/C")
            } else {
                ("/bin/sh", "-c")
            };
            HubToAgent::Spawn {
                request_id: format!("request-{channel_id}"),
                channel_id: Some(channel_id.to_string()),
                shell: Some(shell.to_string()),
                args: Some(vec![run.to_string(), command.to_string()]),
                cwd: None,
                env: None,
                cols: 80,
                rows: 24,
                direct_process: None,
                elevated: None,
                elevation_secret: None,
                elevation_method: None,
                custom_command: None,
            }
        }

        /// The terminal outlives the connection that spawned it, and so must
        /// what it has to say. Its title and its exit used to go to that
        /// connection alone: after a reconnect, a shell that ended left its
        /// pane live on a dead terminal (#549).
        #[tokio::test]
        async fn a_terminal_reports_to_the_hub_connected_now_not_the_one_that_spawned_it() {
            let daemon = TestDaemon::start("reconnect").await;
            let channel_id = "outlives-its-spawner";
            // Waits for a line, then sets its title, rings, and exits with 7.
            // cmd.exe keeps a space before `&` as part of the title.
            let command = if cfg!(windows) {
                "set /p line=& title routed-title& exit 7"
            } else {
                r"read line; printf '\033]0;routed-title\007\a'; exit 7"
            };

            let mut spawner = daemon.connect().await;
            spawner.send(&spawn(channel_id, command)).await;
            spawner.read_until("SPAWN_OK").await;
            drop(spawner);

            let mut hub = daemon.connect().await;
            hub.send(&HubToAgent::Attach {
                channel_id: channel_id.to_string(),
            })
            .await;
            hub.read_until("ATTACH_OK").await;
            let line: &[u8] = if cfg!(windows) { b"go\r" } else { b"go\n" };
            hub.send(&HubToAgent::Input {
                channel_id: channel_id.to_string(),
                data: line.to_vec(),
            })
            .await;

            let frames = hub
                .read_through(|frame| is_about(frame, "CHANNEL_EXIT", channel_id))
                .await;
            let exit = frames.last().expect("CHANNEL_EXIT was read");
            assert_eq!(exit["exit_code"].as_i64(), Some(7), "{exit:?}");
            let titles: Vec<&str> = frames
                .iter()
                .filter(|frame| is_about(frame, "TITLE_CHANGE", channel_id))
                .filter_map(|frame| frame["title"].as_str())
                .collect();
            // An elevated cmd.exe, as on CI runners, prefixes "Administrator:  ".
            assert!(
                titles.iter().any(|title| title.ends_with("routed-title")),
                "the title set after the reconnect must reach the hub connected now; titles {titles:?}"
            );
            if cfg!(unix) {
                assert!(
                    frames.iter().any(|frame| is_about(frame, "BELL", channel_id)),
                    "the bell rung after the reconnect must reach the hub connected now; received {:?}",
                    frames.iter().map(frame_type).collect::<Vec<_>>()
                );
            }

            daemon.stop().await;
        }

        /// A channel's last output reaches the hub before its exit. OUTPUT
        /// waits up to 16 ms in the batch loop, and CHANNEL_EXIT used to go
        /// around it: a shell that printed and ended could be reported gone
        /// before its last output arrived. Ten rounds, since that race was
        /// lost in only some of them.
        #[tokio::test]
        async fn a_channel_delivers_all_its_output_before_its_exit() {
            let daemon = TestDaemon::start("ordering").await;
            let mut hub = daemon.connect().await;
            let mut ended: Vec<String> = Vec::new();

            for round in 0..10 {
                let channel_id = format!("prints-then-ends-{round}");
                let marker = format!("ordering-marker-{round}");
                hub.send(&spawn(&channel_id, &format!("echo {marker}")))
                    .await;
                let frames = hub
                    .read_through(|frame| is_about(frame, "CHANNEL_EXIT", &channel_id))
                    .await;
                for earlier in &ended {
                    assert!(
                        !frames
                            .iter()
                            .any(|frame| is_about(frame, "OUTPUT", earlier)),
                        "OUTPUT for {earlier} arrived after its CHANNEL_EXIT"
                    );
                }
                assert!(
                    output_of(&frames, &channel_id).contains(&marker),
                    "CHANNEL_EXIT for {channel_id} arrived before its output {marker:?}"
                );
                ended.push(channel_id);
            }

            // Well past one batch interval: output still held back would come now.
            while let Some(frame) = hub.frame_within(Duration::from_millis(300)).await {
                for earlier in &ended {
                    assert!(
                        !is_about(&frame, "OUTPUT", earlier),
                        "OUTPUT for {earlier} arrived after its CHANNEL_EXIT"
                    );
                }
            }

            daemon.stop().await;
        }
    }
}
