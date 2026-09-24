use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

use crate::batch::{batch_loop, BatchedEvent, ChannelEvent, ChannelEventSender};
use crate::framing::{encode_frame, FrameReader};
use crate::handler::{handle_message, FrameSender, SnapshotSenders};
use crate::owner::{ct_eq, OwnerId};
use crate::platform_dirs::{lasterm_dir, DirKind};
use crate::protocol::{error_codes, AgentToHub, HubToAgent};
use crate::pty::{DestroyAllSummary, PtyManager};

#[cfg(unix)]
const BIND_RETRY_MAX: u32 = 3;
#[cfg(unix)]
const BIND_RETRY_DELAY_MS: u64 = 300;
/// How many frames each hub's queue keeps while that hub has no connection.
const MAX_FRAME_QUEUE: usize = 1000;
/// How long a daemon with a token waits for AUTH before dropping a connection.
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a daemon without a token waits for the frame after HELLO.
///
/// A hub from before #127 sends nothing to a daemon without a token: it waits
/// for the channel state, and gives up after 5 s. Past this wait such a
/// connection is taken for one of them, as `legacy`, with time to spare. A
/// current hub sends AUTH as soon as it reads HELLO, one round trip, well
/// within it.
const LEGACY_FIRST_FRAME_WAIT: Duration = Duration::from_secs(2);
static CONNECTION_SEQ: AtomicU64 = AtomicU64::new(0);

/// The daemon's end of its shutdown channel. The accept loop waits on it, and
/// a hub's STOP asks through it: a STOP takes the path a signal takes.
#[derive(Clone)]
pub(crate) struct ShutdownReceiver {
    requested: watch::Receiver<bool>,
    request: watch::Sender<bool>,
}

/// Build the shutdown request channel shared by the platform-specific accept
/// loops. The signal task holds the sender; the loop owns teardown.
pub(crate) fn shutdown_channel() -> (watch::Sender<bool>, ShutdownReceiver) {
    let (request, requested) = watch::channel(false);
    (request.clone(), ShutdownReceiver { requested, request })
}

impl ShutdownReceiver {
    /// Ask for the daemon to stop, as a signal does.
    fn request(&self) {
        self.request.send_replace(true);
    }

    /// Wait until a shutdown has been requested. A closed channel is not a
    /// request: a daemon must not stop by surprise. (It holds a sender itself,
    /// so its channel does not close while it runs.)
    async fn requested(&mut self) {
        if self
            .requested
            .wait_for(|requested| *requested)
            .await
            .is_err()
        {
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

/// Tells a connection's reader and writer to end. Unlike a `Notify`, a
/// cancellation sent while either is busy is not lost: it is a state.
type Cancel = watch::Sender<bool>;

/// Wait until a connection is cancelled, or nothing is left that could.
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    let _ = cancel.wait_for(|cancelled| *cancelled).await;
}

/// A hub's current connection, which a newer one of the same hub replaces.
struct ActiveConnection {
    /// Daemon-local sequence id for diagnostics.
    connection_id: u64,
    /// Set when this connection should be terminated (displaced).
    cancel: Cancel,
    /// Channel to send encoded frames to the connection's writer task.
    frame_tx: FrameSender,
}

/// Where each hub's frames go: its current connection, or while it has none,
/// its own queue. One hub's frames never reach another (#127).
#[derive(Default)]
struct HubRoutes {
    connections: HashMap<OwnerId, ActiveConnection>,
    queues: HashMap<OwnerId, VecDeque<Vec<u8>>>,
}

type Routes = Arc<Mutex<HubRoutes>>;

impl HubRoutes {
    /// Send a frame to `owner`'s connection, or keep it for the next one.
    fn route(&mut self, owner: &OwnerId, frame: Vec<u8>) {
        let frame = match self.connections.get(owner) {
            Some(active) => match active.frame_tx.send(frame) {
                Ok(()) => return,
                // Its writer is gone while it is still registered: the hub
                // went away and the read loop has not seen it yet.
                Err(mpsc::error::SendError(frame)) => frame,
            },
            None => frame,
        };
        let queue = self.queues.entry(owner.clone()).or_default();
        if queue.len() >= MAX_FRAME_QUEUE {
            queue.pop_front();
        }
        queue.push_back(frame);
    }
}

/// What every connection of one daemon shares.
#[derive(Clone)]
struct DaemonShared {
    pty_manager: Arc<Mutex<PtyManager>>,
    /// Per-channel command senders (snapshot/resize).
    cmd_senders: SnapshotSenders,
    /// The pipeline every channel reader writes to.
    channel_events: ChannelEventSender,
    routes: Routes,
    /// `None` on a first run: no token, AUTH is not checked.
    expected_token: Option<String>,
    /// What a hub's STOP asks through.
    shutdown: ShutdownReceiver,
}

impl DaemonShared {
    /// Read the token, and start the pipeline that carries every channel's
    /// output and events: reader tasks → batch loop → router → the connection
    /// of the channel's owner, or that owner's queue.
    async fn start(
        config_dir: &str,
        state_dir: &std::path::Path,
        pty_manager: Arc<Mutex<PtyManager>>,
        shutdown: ShutdownReceiver,
    ) -> Self {
        // Load auth token once at startup (None → first-run, skip auth)
        let expected_token = read_auth_token_with_state_dir(config_dir, state_dir).await;
        if expected_token.is_some() {
            tracing::info!("auth token loaded — connections will be authenticated");
        } else {
            tracing::info!(
                "no auth token found — connections accepted without authentication (first-run)"
            );
        }

        let (channel_events, channel_events_rx) = mpsc::unbounded_channel::<ChannelEvent>();
        let (batched_tx, batched_rx) = mpsc::unbounded_channel::<BatchedEvent>();
        tokio::spawn(batch_loop(channel_events_rx, batched_tx));
        let routes: Routes = Arc::new(Mutex::new(HubRoutes::default()));
        spawn_output_router(batched_rx, Arc::clone(&routes));

        Self {
            pty_manager,
            cmd_senders: Arc::new(Mutex::new(HashMap::new())),
            channel_events,
            routes,
            expected_token,
            shutdown,
        }
    }

    /// Whether nobody uses this daemon: no hub connected, no terminal held.
    #[cfg(unix)]
    async fn unused(&self) -> bool {
        self.routes.lock().await.connections.is_empty()
            && self.pty_manager.lock().await.channel_ids().is_empty()
    }
}

/// End every hub connection, once the terminals are torn down. What each
/// already has queued goes out first; a hub reads the close that follows as
/// the acknowledgement of its STOP.
async fn disconnect_all(routes: &Routes) {
    let mut routes = routes.lock().await;
    for (_, active) in routes.connections.drain() {
        active.cancel.send_replace(true);
    }
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
/// Listens on a Unix domain socket. Serves several hubs at once, one
/// connection each: a hub's newest authenticated connection replaces its
/// previous one, and never another hub's (#127). PTY channels persist across
/// hub reconnections.
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

    let daemon = DaemonShared::start(
        &config_dir,
        &state_dir,
        Arc::clone(&pty_manager),
        shutdown.clone(),
    )
    .await;

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
            _ = shutdown.requested() => {
                tracing::info!("daemon shutdown requested; tearing down terminals");
                // Stop routing new work before teardown can block on a slow
                // terminal. Existing connection handlers may finish their own
                // cancellation paths while the manager is swept.
                drop(listener.take());
                let summary = teardown_daemon_terminals(&pty_manager).await;
                disconnect_all(&daemon.routes).await;
                break Ok(summary);
            }
            _ = idle_check.tick(), if idle_timeout.is_some() => {
                if !daemon.unused().await {
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

                // The connection becomes its hub's current one, replacing that
                // hub's previous one, only once it has authenticated: see
                // `register_active`. Spawned, so as not to block the accept loop.
                tokio::spawn(handle_connection_inner(stream, daemon.clone(), connection_id));
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
/// Listens on a Windows named pipe. Serves several hubs at once, one
/// connection each: a hub's newest authenticated connection replaces its
/// previous one, and never another hub's (#127). PTY channels persist across
/// hub reconnections.
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

    // Shared PTY manager — channels survive hub disconnections
    let pty_manager = Arc::new(Mutex::new(PtyManager::new()));

    let daemon = DaemonShared::start(
        &config_dir,
        &state_dir,
        Arc::clone(&pty_manager),
        shutdown.clone(),
    )
    .await;

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
            _ = shutdown.requested() => {
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

        // The connection becomes its hub's current one, replacing that hub's
        // previous one, only once it has authenticated: see `register_active`.
        // Spawned, so as not to block the accept loop.
        tokio::spawn(handle_connection_inner(
            connected,
            daemon.clone(),
            connection_id,
        ));
    };

    // Every loop exit, including a replacement pipe creation failure, sweeps
    // the manager before this daemon reports its result to the caller.
    let summary = teardown_daemon_terminals(&pty_manager).await;
    disconnect_all(&daemon.routes).await;
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

/// Read from `reader` until at least one message is decoded. Every message
/// decoded goes into `pending`, in order; a partial frame stays in `frames`.
async fn read_messages<R: AsyncRead + Unpin>(
    reader: &mut R,
    frames: &mut FrameReader,
    pending: &mut VecDeque<HubToAgent>,
) -> std::io::Result<()> {
    let mut buf = vec![0u8; 8192];
    while pending.is_empty() {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "client disconnected before AUTH",
            ));
        }
        let messages = frames
            .push(&buf[..n])
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        pending.extend(messages);
    }
    Ok(())
}

/// Read the frame that follows HELLO and say whose connection this is.
///
/// - `Ok(Some(owner))`: accepted. With AUTH, the owner comes from its
///   `hub_key`, or is `legacy` without one. What the hub sent after its AUTH
///   stays in `pending`, to be processed once the connection is registered.
/// - `Ok(None)`: refused. A token is configured, and the first frame is not
///   AUTH or carries another token.
/// - `Err`: the connection ended, or sent nothing in time while a token is
///   configured.
///
/// Without a token (a first run, or a remote machine with no hub of its own),
/// the frame is read all the same: it is where a hub names itself (#127). A
/// first frame that is not AUTH comes from a hub from before #127, which is
/// `legacy`, and that frame stays in `pending` to be processed normally; so
/// does a connection that sends nothing within `LEGACY_FIRST_FRAME_WAIT`.
///
/// No key is logged, ever.
async fn handshake<R: AsyncRead + Unpin>(
    reader: &mut R,
    frames: &mut FrameReader,
    pending: &mut VecDeque<HubToAgent>,
    expected_token: Option<&str>,
    legacy_wait: Duration,
) -> std::io::Result<Option<OwnerId>> {
    let wait = match expected_token {
        Some(_) => AUTH_TIMEOUT,
        None => legacy_wait,
    };
    match tokio::time::timeout(wait, read_messages(reader, frames, pending)).await {
        Ok(read) => read?,
        Err(_elapsed) => {
            return match expected_token {
                Some(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "AUTH frame not received within 5s",
                )),
                // A hub from before #127 talking to a daemon without a token
                // sends nothing until it has the channel state.
                None => Ok(Some(OwnerId::legacy())),
            };
        }
    }

    if !matches!(pending.front(), Some(HubToAgent::Auth { .. })) {
        return Ok(match expected_token {
            Some(_) => {
                tracing::warn!(
                    "expected AUTH message as first frame, got a different message type"
                );
                None
            }
            None => Some(OwnerId::legacy()),
        });
    }
    let Some(HubToAgent::Auth { token, hub_key }) = pending.pop_front() else {
        unreachable!("the first pending message was just seen to be AUTH");
    };
    if let Some(expected) = expected_token {
        // An empty expected token marks an auth.json that is missing beside a
        // meta.db, unreadable or malformed: nothing may pass, not even an
        // empty token, which is what a hub sends to a daemon it holds no
        // token for (#127).
        if expected.is_empty() || !ct_eq(expected.as_bytes(), token.as_bytes()) {
            return Ok(None);
        }
    }
    Ok(Some(OwnerId::from_auth(hub_key.as_deref())))
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

/// Handle one hub connection:
/// 1. spawn the writer task (drains the frame channel to the stream);
/// 2. send HELLO, then read the frame after it: who the hub is (`handshake`);
/// 3. register the connection as its hub's current one, send that hub's
///    channel state;
/// 4. read loop, until EOF, error, or a newer connection of the same hub.
///
/// Used by both the Unix UDS path and the Windows named-pipe path.
async fn handle_connection_inner<S>(stream: S, daemon: DaemonShared, connection_id: u64)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut read_half, mut write_half) = tokio::io::split(stream);
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (cancel, _) = watch::channel(false);

    // Spawn writer task — drains frame_rx to the write half
    let mut cancel_rx = cancel.subscribe();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancelled(&mut cancel_rx) => {
                    // Displaced, or the daemon is stopping. What is already
                    // queued goes out first — the notice saying why this
                    // connection is ending is enqueued immediately before the
                    // cancellation, and a writer that stopped here would drop
                    // the only thing that explains the EOF the other end is
                    // about to read (#127).
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
    if send_encoded(&frame_tx, &crate::handler::build_hello(true)).is_err() {
        return;
    }
    tracing::debug!(connection_id, "HELLO sent");

    // --- Step 2: Who is this? AUTH, checked against the token if one is set ---
    let mut frames = FrameReader::new();
    let mut pending: VecDeque<HubToAgent> = VecDeque::new();
    let owner = match handshake(
        &mut read_half,
        &mut frames,
        &mut pending,
        daemon.expected_token.as_deref(),
        LEGACY_FIRST_FRAME_WAIT,
    )
    .await
    {
        Ok(Some(owner)) => owner,
        Ok(None) => {
            tracing::warn!(
                connection_id,
                "auth handshake failed: token mismatch — dropping connection"
            );
            return;
        }
        Err(e) => {
            tracing::warn!(connection_id, error = %e, "auth handshake error — dropping connection");
            return;
        }
    };
    tracing::debug!(
        connection_id,
        owner = owner.short(),
        "auth handshake succeeded"
    );
    register_active(&daemon.routes, &owner, connection_id, &cancel, &frame_tx).await;

    // --- Step 3: this hub's channels, and how many other hubs hold ---
    let (states, other_owner_channels) = {
        let mgr = daemon.pty_manager.lock().await;
        let states: Vec<AgentToHub> = mgr
            .channels
            .iter()
            .filter(|(_, channel)| channel.owner() == &owner)
            .map(|(id, channel)| AgentToHub::AgentChannelState {
                channel_id: id.clone(),
                title: String::new(),
                pid: channel.process.pid(),
                alive: true,
            })
            .collect();
        (states, mgr.held_by_others(&owner))
    };
    for state in &states {
        if send_encoded(&frame_tx, state).is_err() {
            clear_active_if_ours(&daemon.routes, &owner, &cancel).await;
            return;
        }
    }
    tracing::debug!(
        connection_id,
        channel_state_count = states.len(),
        other_owner_channels,
        "about to send CHANNEL_STATE_END"
    );
    if send_encoded(
        &frame_tx,
        &AgentToHub::ChannelStateEnd {
            other_owner_channels,
        },
    )
    .is_err()
    {
        tracing::warn!(connection_id, "CHANNEL_STATE_END send failed (writer gone)");
        clear_active_if_ours(&daemon.routes, &owner, &cancel).await;
        return;
    }
    tracing::debug!(connection_id, "CHANNEL_STATE_END sent");

    // --- Step 4: read loop with displacement cancellation. What the handshake
    // read beyond AUTH, or a first frame that was not AUTH, goes first. ---
    let mut cancel_rx = cancel.subscribe();
    let mut buf = vec![0u8; 8192];
    'connection: loop {
        while let Some(msg) = pending.pop_front() {
            if let Err(e) = dispatch(msg, &daemon, &owner, &frame_tx, connection_id).await {
                tracing::error!("message dispatch error: {}", e);
                // What arrived with the message that failed is dropped with it.
                pending.clear();
            }
        }
        tokio::select! {
            _ = cancelled(&mut cancel_rx) => {
                tracing::debug!(connection_id, "connection displaced by a newer one of its hub");
                break 'connection;
            }
            result = read_half.read(&mut buf) => {
                match result {
                    Ok(0) => {
                        tracing::debug!(connection_id, "hub disconnected (EOF)");
                        break 'connection;
                    }
                    Ok(n) => match frames.push(&buf[..n]) {
                        Ok(messages) => pending.extend(messages),
                        Err(e) => {
                            tracing::error!("frame parse error: {}", e);
                            break 'connection;
                        }
                    },
                    Err(e) => {
                        tracing::error!("read error: {}", e);
                        break 'connection;
                    }
                }
            }
        }
    }

    clear_active_if_ours(&daemon.routes, &owner, &cancel).await;
}

/// Act on one message from a registered connection. STOP is the daemon's to
/// answer; everything else is shared with stdio.
async fn dispatch(
    msg: HubToAgent,
    daemon: &DaemonShared,
    owner: &OwnerId,
    frame_tx: &FrameSender,
    connection_id: u64,
) -> std::io::Result<()> {
    match msg {
        HubToAgent::Stop { force } => {
            handle_stop(daemon, owner, force, frame_tx, connection_id).await;
            Ok(())
        }
        msg => {
            handle_message(
                msg,
                owner,
                Arc::clone(&daemon.pty_manager),
                frame_tx.clone(),
                daemon.channel_events.clone(),
                Arc::clone(&daemon.cmd_senders),
            )
            .await
        }
    }
}

/// STOP from a hub (#127). Without `force`, the daemon refuses while other
/// hubs hold channels, and nothing stops. Otherwise it asks for the shutdown a
/// signal asks for; the connection closes once the terminals are torn down,
/// which is the hub's acknowledgement.
async fn handle_stop(
    daemon: &DaemonShared,
    owner: &OwnerId,
    force: bool,
    frame_tx: &FrameSender,
    connection_id: u64,
) {
    let mut mgr = daemon.pty_manager.lock().await;
    let others = mgr.held_by_others(owner);
    if !force && others > 0 {
        drop(mgr);
        tracing::info!(
            connection_id,
            owner = owner.short(),
            other_owner_channels = others,
            "STOP refused: other hubs hold terminals on this agent"
        );
        let _ = send_encoded(frame_tx, &stop_refusal(others));
        return;
    }
    // Refuse any new terminal from here, under the lock the count was taken
    // under: none can start between the count and the teardown, and be ended
    // by a STOP that was only allowed because it was not there yet.
    mgr.begin_shutdown();
    drop(mgr);
    tracing::info!(
        connection_id,
        owner = owner.short(),
        force,
        other_owner_channels = others,
        "STOP accepted: shutting the daemon down"
    );
    daemon.shutdown.request();
}

/// The refusal of a STOP without `force`. The count leads the message, and is
/// also a field of its own, which the hub reads first.
fn stop_refusal(others: u32) -> AgentToHub {
    let held = if others == 1 {
        "1 terminal on this agent belongs to another hub".to_string()
    } else {
        format!("{others} terminals on this agent belong to other hubs")
    };
    AgentToHub::Error {
        code: error_codes::OTHER_HUBS_HOLD_CHANNELS.into(),
        message: format!(
            "{held}; stopping it would end them. Send STOP with force to stop it anyway"
        ),
        channel_id: None,
        other_owner_channels: Some(others),
    }
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

/// Make an authenticated connection its hub's current one, replacing that
/// hub's previous connection, and no other hub's (#127).
///
/// Only an authenticated peer gets here. Before this, a connection receives no
/// terminal output (the router writes to registered connections only) and
/// cannot push anyone off: a peer that fails AUTH, such as a second hub
/// holding another token, used to displace a working hub.
///
/// What the hub's terminals sent while it had no connection goes out now,
/// before anything this connection is answered: a CHANNEL_EXIT queued while
/// the hub was away must not arrive after the SPAWN_OK of the terminal that
/// restarted under the same id. The queue used to drain only when the next
/// item arrived, whenever that was.
async fn register_active(
    routes: &Routes,
    owner: &OwnerId,
    connection_id: u64,
    cancel: &Cancel,
    frame_tx: &FrameSender,
) {
    let mut routes = routes.lock().await;
    if let Some(old) = routes.connections.remove(owner) {
        tracing::info!(
            connection_id,
            displaced_connection_id = old.connection_id,
            owner = owner.short(),
            "a newer connection of this hub replaces its previous one"
        );
        // Tell it before cutting it. A hub that is simply cancelled cannot tell
        // "I am no longer the one driving these terminals" from "these
        // terminals stopped answering", and writes into a socket nothing reads.
        let notice = AgentToHub::Error {
            code: error_codes::DISPLACED.into(),
            message: format!(
                "a newer connection of this hub (#{connection_id}) has replaced this one"
            ),
            channel_id: None,
            other_owner_channels: None,
        };
        let _ = send_encoded(&old.frame_tx, &notice);
        old.cancel.send_replace(true);
    }
    if let Some(queued) = routes.queues.remove(owner) {
        tracing::debug!(
            connection_id,
            owner = owner.short(),
            queued = queued.len(),
            "sending what this hub's terminals said while it was away"
        );
        for frame in queued {
            let _ = frame_tx.send(frame);
        }
    }
    routes.connections.insert(
        owner.clone(),
        ActiveConnection {
            connection_id,
            cancel: cancel.clone(),
            frame_tx: frame_tx.clone(),
        },
    );
}

/// Unregister this connection, if it is still its hub's current one. A newer
/// connection of the same hub has its own cancel sender, and stays.
async fn clear_active_if_ours(routes: &Routes, owner: &OwnerId, our_cancel: &Cancel) {
    let mut routes = routes.lock().await;
    if routes
        .connections
        .get(owner)
        .is_some_and(|active| active.cancel.same_channel(our_cancel))
    {
        routes.connections.remove(owner);
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
/// title, bell, notification and log frames — and forwards each to the current
/// connection of the hub that owns the channel, whichever connection spawned it
/// (#549). While that hub has none, its own queue keeps up to MAX_FRAME_QUEUE
/// frames, dropping the oldest; `register_active` sends them on (#127).
fn spawn_output_router(mut batched_rx: mpsc::UnboundedReceiver<BatchedEvent>, routes: Routes) {
    tokio::spawn(async move {
        while let Some(event) = batched_rx.recv().await {
            let owner = event.owner().clone();
            if let Ok(frame) = event.into_frame() {
                routes.lock().await.route(&owner, frame);
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

        // A hub with no key, as today's: both connections are `legacy`, the
        // same hub, so the second replaces the first.
        let auth = crate::framing::encode_frame(&crate::protocol::HubToAgent::Auth {
            token: String::new(),
            hub_key: None,
        })
        .unwrap();

        // First client connects
        let mut stream1 = UnixStream::connect(&path_str).await.unwrap();
        stream1.write_all(&auth).await.unwrap();
        let mut buf = vec![0u8; 4096];
        let _ = stream1.read(&mut buf).await.unwrap(); // drain initial frames

        // Second client connects — displaces first
        let mut stream2 = UnixStream::connect(&path_str).await.unwrap();
        stream2.write_all(&auth).await.unwrap();
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
        // AUTH, as a hub sends it after HELLO, even to a daemon without a token.
        let auth = crate::framing::encode_frame(&crate::protocol::HubToAgent::Auth {
            token: String::new(),
            hub_key: None,
        })
        .unwrap();
        stream.write_all(&auth).await.unwrap();
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

    // ── Handshake and registration (cross-platform, in memory) ──────────────

    const HUB_TOKEN: &str = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

    /// A daemon's shared state with no listener, for connections over
    /// in-memory streams.
    fn in_memory_daemon(expected_token: Option<&str>) -> DaemonShared {
        let (channel_events, _nobody_reads) = mpsc::unbounded_channel::<ChannelEvent>();
        DaemonShared {
            pty_manager: Arc::new(Mutex::new(PtyManager::new())),
            cmd_senders: Arc::new(Mutex::new(HashMap::new())),
            channel_events,
            routes: Arc::new(Mutex::new(HubRoutes::default())),
            expected_token: expected_token.map(str::to_owned),
            shutdown: shutdown_channel().1,
        }
    }

    /// A connection of `owner` registered earlier, as the daemon keeps it:
    /// what cancels it, and what it would write to its hub.
    struct Incumbent {
        cancelled: watch::Receiver<bool>,
        frames: mpsc::UnboundedReceiver<Vec<u8>>,
    }

    async fn incumbent(daemon: &DaemonShared, owner: &OwnerId, connection_id: u64) -> Incumbent {
        let (cancel, cancelled) = watch::channel(false);
        let (frame_tx, frames) = mpsc::unbounded_channel::<Vec<u8>>();
        register_active(&daemon.routes, owner, connection_id, &cancel, &frame_tx).await;
        Incumbent { cancelled, frames }
    }

    /// Run a connection over an in-memory stream, sending `first` after HELLO.
    /// The client end keeps the connection open while held.
    async fn connect_in_memory(
        daemon: &DaemonShared,
        first: &HubToAgent,
        connection_id: u64,
    ) -> (tokio::io::DuplexStream, tokio::task::JoinHandle<()>) {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let handler = tokio::spawn(handle_connection_inner(
            server,
            daemon.clone(),
            connection_id,
        ));
        client
            .write_all(&encode_frame(first).expect("encode the first frame"))
            .await
            .expect("send the first frame");
        (client, handler)
    }

    fn auth(token: &str, hub_key: Option<&str>) -> HubToAgent {
        HubToAgent::Auth {
            token: token.to_string(),
            hub_key: hub_key.map(str::to_owned),
        }
    }

    async fn current_connection(daemon: &DaemonShared, owner: &OwnerId) -> Option<u64> {
        daemon
            .routes
            .lock()
            .await
            .connections
            .get(owner)
            .map(|active| active.connection_id)
    }

    /// Wait until `owner` has a current connection with this id.
    async fn registered(daemon: &DaemonShared, owner: &OwnerId, connection_id: u64) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while current_connection(daemon, owner).await != Some(connection_id) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the connection registers");
    }

    /// A peer that fails AUTH neither displaces the active hub nor becomes it (#127).
    #[tokio::test]
    async fn failed_auth_leaves_the_active_hub_in_place() {
        let daemon = in_memory_daemon(Some(HUB_TOKEN));
        let legacy = OwnerId::legacy();
        let incumbent = incumbent(&daemon, &legacy, 7).await;

        let wrong = auth(
            "000000def456abc123def456abc123def456abc123def456abc123def456abc1",
            None,
        );
        let (_client, handler) = connect_in_memory(&daemon, &wrong, 42).await;
        tokio::time::timeout(Duration::from_secs(5), handler)
            .await
            .expect("a refused peer's handler ends")
            .expect("handler does not panic");

        // Mutation caught: registering at accept time made this peer the
        // active connection and cancelled the incumbent before AUTH was read.
        assert_eq!(current_connection(&daemon, &legacy).await, Some(7));
        assert!(
            !*incumbent.cancelled.borrow(),
            "the incumbent hub must not be displaced by a peer that failed AUTH"
        );
    }

    /// An authenticated connection of the same hub takes over from the
    /// previous one, and tells it so. Without a key, every hub is the same
    /// one: `legacy`, which keeps today's last-wins rule.
    #[tokio::test]
    async fn authenticated_hub_displaces_the_previous_one() {
        let daemon = in_memory_daemon(Some(HUB_TOKEN));
        let legacy = OwnerId::legacy();
        let mut incumbent = incumbent(&daemon, &legacy, 7).await;

        let (client, handler) = connect_in_memory(&daemon, &auth(HUB_TOKEN, None), 42).await;
        tokio::time::timeout(
            Duration::from_secs(5),
            incumbent.cancelled.wait_for(|cancelled| *cancelled),
        )
        .await
        .expect("the previous connection is displaced once the new one authenticates")
        .expect("the daemon keeps the connection's cancel sender");
        assert_eq!(current_connection(&daemon, &legacy).await, Some(42));
        let notice = incumbent
            .frames
            .try_recv()
            .expect("told why before being cut");
        assert!(notice.windows(9).any(|w| w == b"DISPLACED"));

        drop(client);
        let _ = tokio::time::timeout(Duration::from_secs(5), handler).await;
    }

    /// A hub's connection replaces its own previous one only: another hub,
    /// connected all along, keeps its connection (#127).
    #[tokio::test]
    async fn a_hub_never_displaces_another_hubs_connection() {
        let daemon = in_memory_daemon(Some(HUB_TOKEN));
        let first = OwnerId::from_hub_key("first-hub-key");
        let second = OwnerId::from_hub_key("second-hub-key");
        let mut incumbent = incumbent(&daemon, &first, 7).await;

        let (client, handler) =
            connect_in_memory(&daemon, &auth(HUB_TOKEN, Some("second-hub-key")), 42).await;
        registered(&daemon, &second, 42).await;

        assert_eq!(current_connection(&daemon, &first).await, Some(7));
        assert!(!*incumbent.cancelled.borrow(), "the other hub was cut");
        assert!(
            incumbent.frames.try_recv().is_err(),
            "the other hub was sent something"
        );

        drop(client);
        let _ = tokio::time::timeout(Duration::from_secs(5), handler).await;
    }

    async fn handshake_over(
        bytes: Vec<u8>,
        expected_token: Option<&str>,
    ) -> (std::io::Result<Option<OwnerId>>, VecDeque<HubToAgent>) {
        let mut stream = std::io::Cursor::new(bytes);
        let mut frames = FrameReader::new();
        let mut pending = VecDeque::new();
        let result = handshake(
            &mut stream,
            &mut frames,
            &mut pending,
            expected_token,
            LEGACY_FIRST_FRAME_WAIT,
        )
        .await;
        (result, pending)
    }

    fn frame(msg: &HubToAgent) -> Vec<u8> {
        encode_frame(msg).expect("encode a hub frame")
    }

    fn heartbeat(ts: &str) -> HubToAgent {
        HubToAgent::Heartbeat { ts: ts.to_string() }
    }

    /// The right token is accepted, and the key names the owner.
    #[tokio::test]
    async fn handshake_accepts_the_right_token_and_takes_the_owner_from_the_key() {
        let (result, _) =
            handshake_over(frame(&auth(HUB_TOKEN, Some("hub-key"))), Some(HUB_TOKEN)).await;
        assert_eq!(
            result.expect("no IO error"),
            Some(OwnerId::from_hub_key("hub-key"))
        );

        let (result, _) = handshake_over(frame(&auth(HUB_TOKEN, None)), Some(HUB_TOKEN)).await;
        assert_eq!(result.expect("no IO error"), Some(OwnerId::legacy()));
    }

    #[tokio::test]
    async fn handshake_refuses_a_wrong_token() {
        let wrong = "000000def456abc123def456abc123def456abc123def456abc123def456abc1";
        let (result, _) =
            handshake_over(frame(&auth(wrong, Some("hub-key"))), Some(HUB_TOKEN)).await;
        assert_eq!(result.expect("a mismatch is not an IO error"), None);
    }

    /// An empty stream is an error, token or not.
    #[tokio::test]
    async fn handshake_fails_on_an_empty_stream() {
        assert!(handshake_over(Vec::new(), Some("anytoken"))
            .await
            .0
            .is_err());
        assert!(handshake_over(Vec::new(), None).await.0.is_err());
    }

    /// With a token configured, the first frame must be AUTH.
    #[tokio::test]
    async fn handshake_refuses_another_first_frame_when_a_token_is_set() {
        let (result, _) = handshake_over(frame(&heartbeat("t")), Some("anytoken")).await;
        assert_eq!(result.expect("not an IO error"), None);
    }

    /// An auth.json that is missing beside a meta.db, unreadable or malformed
    /// leaves an empty expected token, which nothing may match. A hub sends an
    /// empty token to a daemon it holds no token for (#127): that used to
    /// match it, and open a daemon that meant to refuse everyone.
    #[tokio::test]
    async fn a_daemon_that_refuses_everyone_refuses_an_empty_token() {
        let (result, _) = handshake_over(frame(&auth("", Some("hub-key"))), Some("")).await;
        assert_eq!(result.expect("not an IO error"), None);
    }

    /// Without a token, AUTH is read all the same, for the key it carries.
    /// A hub sends an empty token to a daemon it holds none for.
    #[tokio::test]
    async fn without_a_token_the_owner_still_comes_from_the_key() {
        let (result, _) = handshake_over(frame(&auth("", Some("hub-key"))), None).await;
        assert_eq!(
            result.expect("no IO error"),
            Some(OwnerId::from_hub_key("hub-key"))
        );
    }

    /// A hub from before #127 talking to a daemon without a token may start
    /// with any request: it is `legacy`, and nothing it sent is lost, what
    /// came in the same read included.
    #[tokio::test]
    async fn without_a_token_another_first_frame_is_legacy_and_kept() {
        let mut bytes = frame(&heartbeat("first"));
        bytes.extend(frame(&heartbeat("second")));
        let (result, pending) = handshake_over(bytes, None).await;
        assert_eq!(result.expect("no IO error"), Some(OwnerId::legacy()));
        let kept: Vec<&str> = pending
            .iter()
            .map(|msg| match msg {
                HubToAgent::Heartbeat { ts } => ts.as_str(),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(kept, ["first", "second"]);
    }

    /// What a hub sends right behind its AUTH is not lost either.
    #[tokio::test]
    async fn a_request_sent_with_auth_is_kept_for_the_connection() {
        let mut bytes = frame(&auth(HUB_TOKEN, Some("hub-key")));
        bytes.extend(frame(&heartbeat("right-behind")));
        let (result, pending) = handshake_over(bytes, Some(HUB_TOKEN)).await;
        assert!(result.expect("no IO error").is_some());
        assert!(matches!(
            pending.front(),
            Some(HubToAgent::Heartbeat { ts }) if ts == "right-behind"
        ));
    }

    /// A hub from before #127 sends nothing to a daemon without a token: it
    /// waits for the channel state, for 5 s. Taking it for `legacy` after a
    /// shorter wait is what lets it still connect.
    #[tokio::test(start_paused = true)]
    async fn without_a_token_a_silent_hub_is_legacy_after_a_wait() {
        let (_client, mut server) = tokio::io::duplex(1024);
        let mut frames = FrameReader::new();
        let mut pending = VecDeque::new();
        let started = tokio::time::Instant::now();
        let result = handshake(
            &mut server,
            &mut frames,
            &mut pending,
            None,
            LEGACY_FIRST_FRAME_WAIT,
        )
        .await;
        assert_eq!(result.expect("no IO error"), Some(OwnerId::legacy()));
        assert_eq!(started.elapsed(), LEGACY_FIRST_FRAME_WAIT);
        assert!(
            LEGACY_FIRST_FRAME_WAIT < Duration::from_secs(5),
            "an old hub gives up on the channel state after 5 s"
        );
    }

    /// With a token, silence ends the connection, as it always did.
    #[tokio::test(start_paused = true)]
    async fn with_a_token_a_silent_peer_is_dropped() {
        let (_client, mut server) = tokio::io::duplex(1024);
        let mut frames = FrameReader::new();
        let mut pending = VecDeque::new();
        let result = handshake(
            &mut server,
            &mut frames,
            &mut pending,
            Some(HUB_TOKEN),
            LEGACY_FIRST_FRAME_WAIT,
        )
        .await;
        assert_eq!(
            result.expect_err("a silent peer is dropped").kind(),
            std::io::ErrorKind::TimedOut
        );
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
            hub_key: None,
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
            hub_key: None,
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

    /// Verify the Windows daemon starts and sends a valid HELLO frame over a named pipe.
    ///
    /// Its configuration and state come from temp dirs: `run_daemon` would
    /// read the user's `%APPDATA%\lasterm`.
    #[cfg(windows)]
    #[tokio::test]
    async fn test_named_pipe_daemon_hello() {
        use tokio::io::AsyncReadExt;
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe_name = format!(
            r"\\.\pipe\lasterm-test-hello-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let config_dir = temp_dir("lasterm-test-config-hello").await;
        let state_dir = temp_dir("lasterm-test-state-hello").await;

        let (bound_tx, bound_rx) = oneshot::channel();
        let daemon_handle = tokio::spawn(run_daemon_impl(
            pipe_name.clone(),
            config_dir.to_string_lossy().into_owned(),
            state_dir.clone(),
            no_shutdown_request(),
            Some(bound_tx),
        ));

        // Wait for daemon to create the pipe
        tokio::time::timeout(std::time::Duration::from_secs(10), bound_rx)
            .await
            .expect("the daemon creates its pipe in time")
            .expect("the daemon reports its pipe");

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

            /// Connect as a hub without a key does, and read up to
            /// CHANNEL_STATE_END. A connection becomes its hub's current one
            /// before the channels are enumerated, so past this point it is
            /// the one routed to.
            async fn connect(&self) -> Hub {
                self.connect_as(None).await.0
            }

            /// Connect as the hub `hub_key` names (or a hub without one),
            /// sending AUTH after HELLO as a hub does. Returns the connection
            /// and every frame read up to CHANNEL_STATE_END, that one included.
            async fn connect_as(&self, hub_key: Option<&str>) -> (Hub, Vec<rmpv::Value>) {
                let mut hub = self.open_silently().await;
                // This daemon has no token: a hub sends an empty one (#127).
                hub.send(&HubToAgent::Auth {
                    token: String::new(),
                    hub_key: hub_key.map(str::to_owned),
                })
                .await;
                let state = hub.read_until("CHANNEL_STATE_END").await;
                (hub, state)
            }

            /// Connect and send nothing, as a hub from before #127 does to a
            /// daemon without a token.
            async fn open_silently(&self) -> Hub {
                Hub {
                    stream: self.open().await,
                    received: Vec::new(),
                }
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

            /// Wait for a daemon that was asked to stop by a hub, and clean up.
            async fn finished(self) -> std::io::Result<DestroyAllSummary> {
                let result = tokio::time::timeout(DEADLINE, self.task)
                    .await
                    .expect("the daemon stops in time")
                    .expect("the daemon task does not panic");
                #[cfg(unix)]
                let _ = std::fs::remove_file(&self.endpoint);
                let _ = tokio::fs::remove_dir_all(&self.config_dir).await;
                let _ = tokio::fs::remove_dir_all(&self.state_dir).await;
                result
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

            /// The next frame's payload, as the daemon wrote it, or `None` once
            /// the daemon has closed this connection. Cancelling it loses
            /// nothing: a partial frame stays in `received`.
            async fn next_payload(&mut self) -> Option<Vec<u8>> {
                loop {
                    if self.received.len() >= 4 {
                        let len = u32::from_le_bytes(self.received[..4].try_into().unwrap());
                        let end = 4 + len as usize;
                        if self.received.len() >= end {
                            let payload = self.received[4..end].to_vec();
                            self.received.drain(..end);
                            return Some(payload);
                        }
                    }
                    let mut buf = vec![0u8; 8192];
                    // A connection the daemon closed may also read as reset.
                    let n = self.stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return None;
                    }
                    self.received.extend_from_slice(&buf[..n]);
                }
            }

            /// The next frame from the daemon. Cancelling it loses nothing.
            async fn next_frame(&mut self) -> rmpv::Value {
                let payload = self
                    .next_payload()
                    .await
                    .expect("the daemon closed this connection");
                rmp_serde::from_slice(&payload).expect("decode a daemon frame")
            }

            /// Every frame until the daemon closes this connection.
            async fn frames_until_closed(&mut self) -> Vec<rmpv::Value> {
                let mut frames = Vec::new();
                loop {
                    match tokio::time::timeout(DEADLINE, self.next_payload()).await {
                        Ok(Some(payload)) => frames.push(
                            rmp_serde::from_slice(&payload).expect("decode a daemon frame"),
                        ),
                        Ok(None) => return frames,
                        Err(_) => panic!(
                            "the daemon did not close this connection within {DEADLINE:?}; received {:?}",
                            frames.iter().map(frame_type).collect::<Vec<_>>()
                        ),
                    }
                }
            }

            /// Whatever arrives until nothing has for `quiet`.
            async fn frames_until_quiet(&mut self, quiet: Duration) -> Vec<rmpv::Value> {
                let mut frames = Vec::new();
                while let Some(frame) = self.frame_within(quiet).await {
                    frames.push(frame);
                }
                frames
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

        /// Several hubs on one daemon (#127): each has its own terminals, its
        /// own connection and its own queue, and learns nothing of another's.
        mod owner_tests {
            use super::*;

            const KEY_A: &str = "hub-a-key";
            const KEY_B: &str = "hub-b-key";

            /// SPAWN an interactive shell, which waits for what it is typed.
            fn interactive(channel_id: &str) -> HubToAgent {
                let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
                HubToAgent::Spawn {
                    request_id: format!("request-{channel_id}"),
                    channel_id: Some(channel_id.to_string()),
                    shell: Some(shell.to_string()),
                    args: None,
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

            async fn spawned(hub: &mut Hub, spawn: HubToAgent) -> Vec<rmpv::Value> {
                let HubToAgent::Spawn {
                    channel_id: Some(channel_id),
                    ..
                } = &spawn
                else {
                    panic!("a SPAWN with a channel id");
                };
                let channel_id = channel_id.clone();
                hub.send(&spawn).await;
                hub.read_through(|frame| is_about(frame, "SPAWN_OK", &channel_id))
                    .await
            }

            /// A line that makes a shell print `text`, which the line itself
            /// does not contain: the terminal echoes what is typed.
            fn prints(text: &str) -> Vec<u8> {
                let (head, tail) = text.split_at(text.len() / 2);
                if cfg!(windows) {
                    format!("echo {head}^{tail}\r").into_bytes()
                } else {
                    format!("echo \"{head}\"\"{tail}\"\n").into_bytes()
                }
            }

            fn input(channel_id: &str, data: Vec<u8>) -> HubToAgent {
                HubToAgent::Input {
                    channel_id: channel_id.to_string(),
                    data,
                }
            }

            /// Have the channel print `text`, and read until it has.
            async fn print(hub: &mut Hub, channel_id: &str, text: &str) -> Vec<rmpv::Value> {
                hub.send(&input(channel_id, prints(text))).await;
                let mut frames = Vec::new();
                while !output_of(&frames, channel_id).contains(text) {
                    let Some(frame) = hub.frame_within(DEADLINE).await else {
                        panic!(
                            "{channel_id} did not print {text:?} within {DEADLINE:?}; it printed {:?}",
                            output_of(&frames, channel_id)
                        );
                    };
                    frames.push(frame);
                }
                frames
            }

            fn mentions(frames: &[rmpv::Value], channel_id: &str) -> Vec<String> {
                frames
                    .iter()
                    .filter(|frame| frame["channel_id"].as_str() == Some(channel_id))
                    .map(|frame| frame_type(frame).to_string())
                    .collect()
            }

            fn errors(frames: &[rmpv::Value]) -> Vec<String> {
                frames
                    .iter()
                    .filter(|frame| frame_type(frame) == "ERROR")
                    .map(|frame| frame["code"].as_str().unwrap_or("").to_string())
                    .collect()
            }

            /// The channels a connection was told it holds, sorted, and the
            /// count CHANNEL_STATE_END gave of other hubs' channels.
            fn state(frames: &[rmpv::Value]) -> (Vec<String>, u64) {
                let mut own: Vec<String> = frames
                    .iter()
                    .filter(|frame| frame_type(frame) == "AGENT_CHANNEL_STATE")
                    .map(|frame| frame["channel_id"].as_str().unwrap_or("").to_string())
                    .collect();
                own.sort();
                let end = frames
                    .iter()
                    .find(|frame| frame_type(frame) == "CHANNEL_STATE_END")
                    .expect("the state ends with CHANNEL_STATE_END");
                let others = end["other_owner_channels"]
                    .as_u64()
                    .expect("CHANNEL_STATE_END counts other hubs' channels");
                (own, others)
            }

            /// Each hub gets its own terminals' output and state, and nothing
            /// of another hub's. All output used to go to whichever hub had
            /// connected last, and the state listed every channel.
            #[tokio::test]
            async fn each_hub_gets_its_own_terminals_and_nothing_of_another_hubs() {
                let daemon = TestDaemon::start("own").await;
                let (mut a, mut seen_by_a) = daemon.connect_as(Some(KEY_A)).await;
                let (mut b, mut seen_by_b) = daemon.connect_as(Some(KEY_B)).await;

                seen_by_a.extend(spawned(&mut a, interactive("own-ch-a")).await);
                seen_by_b.extend(spawned(&mut b, interactive("own-ch-b")).await);
                seen_by_a.extend(print(&mut a, "own-ch-a", "printed-for-a").await);
                seen_by_b.extend(print(&mut b, "own-ch-b", "printed-for-b").await);
                // Anything sent to the wrong hub would have arrived by now.
                seen_by_a.extend(a.frames_until_quiet(Duration::from_millis(300)).await);
                seen_by_b.extend(b.frames_until_quiet(Duration::from_millis(300)).await);

                assert_eq!(mentions(&seen_by_a, "own-ch-b"), Vec::<String>::new());
                assert_eq!(mentions(&seen_by_b, "own-ch-a"), Vec::<String>::new());

                // Coming back, each hub is told of its own terminal only.
                let (_a2, a2_state) = daemon.connect_as(Some(KEY_A)).await;
                assert_eq!(state(&a2_state), (vec!["own-ch-a".to_string()], 1));
                let (_b2, b2_state) = daemon.connect_as(Some(KEY_B)).await;
                assert_eq!(state(&b2_state), (vec!["own-ch-b".to_string()], 1));

                daemon.stop().await;
            }

            /// A hub that goes away costs another hub nothing: it keeps
            /// typing and reading, with nothing lost, and the terminal of the
            /// hub that left keeps running for it.
            #[tokio::test]
            async fn a_hub_that_leaves_costs_another_hub_nothing() {
                let daemon = TestDaemon::start("leaves").await;
                let (mut a, _) = daemon.connect_as(Some(KEY_A)).await;
                let (mut b, _) = daemon.connect_as(Some(KEY_B)).await;
                spawned(&mut a, interactive("leaves-ch-a")).await;
                spawned(&mut b, interactive("leaves-ch-b")).await;

                let mut seen_by_b = print(&mut b, "leaves-ch-b", "before-a-left").await;
                drop(a);
                seen_by_b.extend(print(&mut b, "leaves-ch-b", "after-a-left").await);
                seen_by_b.extend(print(&mut b, "leaves-ch-b", "and-again").await);

                let printed = output_of(&seen_by_b, "leaves-ch-b");
                let at = |text: &str| {
                    printed
                        .find(text)
                        .unwrap_or_else(|| panic!("{text:?} is missing from {printed:?}"))
                };
                assert!(at("before-a-left") < at("after-a-left"));
                assert!(at("after-a-left") < at("and-again"));
                let seqs: Vec<u64> = seen_by_b
                    .iter()
                    .filter(|frame| is_about(frame, "OUTPUT", "leaves-ch-b"))
                    .filter_map(|frame| frame["seq"].as_u64())
                    .collect();
                assert!(
                    seqs.windows(2).all(|pair| pair[0] < pair[1]),
                    "OUTPUT seqs must only grow: {seqs:?}"
                );

                let (mut a2, a2_state) = daemon.connect_as(Some(KEY_A)).await;
                assert_eq!(state(&a2_state).0, vec!["leaves-ch-a".to_string()]);
                print(&mut a2, "leaves-ch-a", "still-running").await;

                daemon.stop().await;
            }

            /// A hub that comes back gets its terminal, and what it printed
            /// while the hub was away; the other hub, there all along, gets
            /// none of it.
            #[tokio::test]
            async fn a_hub_that_comes_back_gets_what_its_terminal_printed_meanwhile() {
                let daemon = TestDaemon::start("back").await;
                let (mut a, _) = daemon.connect_as(Some(KEY_A)).await;
                let (mut b, mut seen_by_b) = daemon.connect_as(Some(KEY_B)).await;
                // Waits for a line, prints a second later, then waits again.
                let command = if cfg!(windows) {
                    "set /p line=& ping -n 2 127.0.0.1 >nul & echo printed-while-^away& set /p done="
                } else {
                    r#"read line; sleep 1; echo "printed-while-""away"; read done"#
                };
                spawned(&mut a, spawn("back-ch-a", command)).await;
                let go: &[u8] = if cfg!(windows) { b"go\r" } else { b"go\n" };
                a.send(&input("back-ch-a", go.to_vec())).await;
                drop(a);
                tokio::time::sleep(Duration::from_millis(2500)).await;

                let (mut a2, mut seen_by_a2) = daemon.connect_as(Some(KEY_A)).await;
                assert_eq!(state(&seen_by_a2), (vec!["back-ch-a".to_string()], 0));
                a2.send(&HubToAgent::Attach {
                    channel_id: "back-ch-a".to_string(),
                })
                .await;
                seen_by_a2.extend(
                    a2.read_through(|frame| is_about(frame, "ATTACH_OK", "back-ch-a"))
                        .await,
                );
                let snapshot = seen_by_a2
                    .last()
                    .and_then(|attached| attached["snapshot"]["serialized"].as_str())
                    .unwrap_or("")
                    .to_string();
                assert!(
                    output_of(&seen_by_a2, "back-ch-a").contains("printed-while-away")
                        || snapshot.contains("printed-while-away"),
                    "what the terminal printed while its hub was away is lost"
                );

                seen_by_b.extend(b.frames_until_quiet(Duration::from_millis(300)).await);
                assert_eq!(mentions(&seen_by_b, "back-ch-a"), Vec::<String>::new());

                daemon.stop().await;
            }

            /// A connection a hub left half-open, a ghost, is replaced by that
            /// hub's next one, and told so before it is cut. Another hub is
            /// left alone.
            #[tokio::test]
            async fn a_ghost_connection_is_replaced_by_its_own_hub_only() {
                let daemon = TestDaemon::start("ghost").await;
                let (mut ghost, _) = daemon.connect_as(Some(KEY_A)).await;
                let (mut b, mut seen_by_b) = daemon.connect_as(Some(KEY_B)).await;
                spawned(&mut ghost, interactive("ghost-ch-a")).await;
                seen_by_b.extend(spawned(&mut b, interactive("ghost-ch-b")).await);

                let (mut a2, a2_state) = daemon.connect_as(Some(KEY_A)).await;
                assert_eq!(state(&a2_state).0, vec!["ghost-ch-a".to_string()]);

                let ghost_saw = ghost.frames_until_closed().await;
                assert!(
                    errors(&ghost_saw).contains(&"DISPLACED".to_string()),
                    "the ghost must be told why it is cut; it received {:?}",
                    ghost_saw.iter().map(frame_type).collect::<Vec<_>>()
                );

                print(&mut a2, "ghost-ch-a", "to-the-new-one").await;
                seen_by_b.extend(print(&mut b, "ghost-ch-b", "b-untouched").await);
                assert_eq!(errors(&seen_by_b), Vec::<String>::new());
                assert_eq!(mentions(&seen_by_b, "ghost-ch-a"), Vec::<String>::new());

                daemon.stop().await;
            }

            /// Every payload up to HEARTBEAT_ACK, which fences the answer to
            /// `msg`: what the daemon wrote, byte for byte.
            async fn answer(hub: &mut Hub, msg: &HubToAgent) -> Vec<Vec<u8>> {
                hub.send(msg).await;
                hub.send(&HubToAgent::Heartbeat {
                    ts: "fence".to_string(),
                })
                .await;
                let mut payloads = Vec::new();
                loop {
                    let payload = tokio::time::timeout(DEADLINE, hub.next_payload())
                        .await
                        .expect("an answer in time")
                        .expect("the connection stays open");
                    let frame: rmpv::Value =
                        rmp_serde::from_slice(&payload).expect("decode a daemon frame");
                    payloads.push(payload);
                    if frame_type(&frame) == "HEARTBEAT_ACK" {
                        return payloads;
                    }
                }
            }

            /// Another hub's terminal is answered exactly as one that does
            /// not exist, whatever is asked of it, and nothing reaches it:
            /// neither what is typed, nor a resize, nor a DESTROY.
            #[tokio::test]
            async fn another_hubs_terminal_is_answered_as_one_that_does_not_exist() {
                // Ids of one length: the answers differ by the id alone.
                const HELD: &str = "isolated-ch-a";
                const NONE: &str = "isolated-ch-x";
                let daemon = TestDaemon::start("isolation").await;
                let (mut a, mut seen_by_a) = daemon.connect_as(Some(KEY_A)).await;
                seen_by_a.extend(spawned(&mut a, interactive(HELD)).await);
                let (mut b, _) = daemon.connect_as(Some(KEY_B)).await;

                type Request = fn(&str) -> HubToAgent;
                let requests: [(&str, Request); 5] = [
                    ("INPUT", |id| input(id, prints("typed-by-b"))),
                    ("RESIZE", |id| HubToAgent::Resize {
                        channel_id: id.to_string(),
                        cols: 100,
                        rows: 40,
                    }),
                    ("ATTACH", |id| HubToAgent::Attach {
                        channel_id: id.to_string(),
                    }),
                    ("SNAPSHOT_REQ", |id| HubToAgent::SnapshotReq {
                        channel_id: id.to_string(),
                    }),
                    ("DESTROY", |id| HubToAgent::Destroy {
                        channel_id: id.to_string(),
                    }),
                ];
                for (name, request) in requests {
                    let held = answer(&mut b, &request(HELD)).await;
                    let none: Vec<Vec<u8>> = answer(&mut b, &request(NONE))
                        .await
                        .into_iter()
                        .map(|payload| replace(&payload, NONE.as_bytes(), HELD.as_bytes()))
                        .collect();
                    assert_eq!(
                        held, none,
                        "{name} on another hub's terminal must read as on one that does not exist"
                    );
                    let kinds: Vec<String> = held
                        .iter()
                        .map(|payload| {
                            let frame: rmpv::Value = rmp_serde::from_slice(payload).unwrap();
                            match frame_type(&frame) {
                                "ERROR" => {
                                    format!("ERROR {}", frame["code"].as_str().unwrap_or(""))
                                }
                                other => other.to_string(),
                            }
                        })
                        .collect();
                    let expected: &[&str] = match name {
                        "DESTROY" | "SNAPSHOT_REQ" => &["HEARTBEAT_ACK"],
                        _ => &["ERROR CHANNEL_NOT_FOUND", "HEARTBEAT_ACK"],
                    };
                    assert_eq!(kinds, expected, "{name}");
                }

                // The terminal is as its hub left it: its size, its input,
                // its life.
                a.send(&HubToAgent::SnapshotReq {
                    channel_id: HELD.to_string(),
                })
                .await;
                let frames = a
                    .read_through(|frame| is_about(frame, "SNAPSHOT_RES", HELD))
                    .await;
                let size = &frames.last().unwrap()["snapshot"];
                assert_eq!(
                    (size["cols"].as_u64(), size["rows"].as_u64()),
                    (Some(80), Some(24))
                );
                seen_by_a.extend(frames);
                seen_by_a.extend(print(&mut a, HELD, "still-its-own").await);
                assert!(
                    !output_of(&seen_by_a, HELD).contains("typed-by-b"),
                    "what another hub typed reached the terminal"
                );
                assert!(!mentions(&seen_by_a, HELD).contains(&"CHANNEL_EXIT".to_string()));

                daemon.stop().await;
            }

            fn replace(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
                assert_eq!(from.len(), to.len());
                let mut out = bytes.to_vec();
                let mut at = 0;
                while at + from.len() <= out.len() {
                    if &out[at..at + from.len()] == from {
                        out[at..at + from.len()].copy_from_slice(to);
                        at += from.len();
                    } else {
                        at += 1;
                    }
                }
                out
            }

            /// What a hub's terminals said while it was away reaches it as it
            /// connects, before anything it is answered. A shell that ended
            /// meanwhile, then restarted under the same id, used to have its
            /// exit arrive after the SPAWN_OK of its replacement, when the
            /// replacement first printed: the hub took the new terminal for
            /// dead.
            #[tokio::test]
            async fn an_exit_while_its_hub_was_away_reaches_it_before_any_reply() {
                let daemon = TestDaemon::start("flush").await;
                let (mut a, _) = daemon.connect_as(Some(KEY_A)).await;
                // Waits for a line, then ends a second later: its hub is gone.
                let command = if cfg!(windows) {
                    "set /p line=& ping -n 2 127.0.0.1 >nul & exit 5"
                } else {
                    "read line; sleep 1; exit 5"
                };
                spawned(&mut a, spawn("flush-restarted", command)).await;
                let go: &[u8] = if cfg!(windows) { b"go\r" } else { b"go\n" };
                a.send(&input("flush-restarted", go.to_vec())).await;
                drop(a);
                tokio::time::sleep(Duration::from_secs(3)).await;

                let (mut a2, mut seen) = daemon.connect_as(Some(KEY_A)).await;
                seen.extend(spawned(&mut a2, interactive("flush-restarted")).await);
                let exit = seen
                    .iter()
                    .position(|frame| is_about(frame, "CHANNEL_EXIT", "flush-restarted"))
                    .unwrap_or_else(|| {
                        panic!(
                            "the exit must come before the SPAWN_OK; received {:?}",
                            seen.iter().map(frame_type).collect::<Vec<_>>()
                        )
                    });
                assert_eq!(seen[exit]["exit_code"].as_i64(), Some(5));
                let later = a2.frames_until_quiet(Duration::from_millis(500)).await;
                assert!(
                    !mentions(&later, "flush-restarted").contains(&"CHANNEL_EXIT".to_string()),
                    "an exit after the SPAWN_OK marks the restarted terminal dead"
                );

                daemon.stop().await;
            }

            fn stop(force: bool) -> HubToAgent {
                HubToAgent::Stop { force }
            }

            /// STOP without force leaves another hub's terminals alone, and
            /// says how many there are. With force, the daemon stops.
            #[tokio::test]
            async fn stop_is_refused_while_another_hub_holds_terminals_unless_forced() {
                let daemon = TestDaemon::start("stop-refused").await;
                let (mut a, _) = daemon.connect_as(Some(KEY_A)).await;
                let (mut b, _) = daemon.connect_as(Some(KEY_B)).await;
                spawned(&mut b, interactive("stop-ch-b")).await;

                a.send(&stop(false)).await;
                let frames = a.read_until("ERROR").await;
                let refusal = frames.last().unwrap();
                assert_eq!(refusal["code"].as_str(), Some("OTHER_HUBS_HOLD_CHANNELS"));
                assert_eq!(refusal["other_owner_channels"].as_u64(), Some(1));
                let message = refusal["message"].as_str().unwrap_or("");
                assert!(message.starts_with("1 "), "{message:?}");
                tokio::time::sleep(Duration::from_millis(300)).await;
                assert!(
                    !daemon.task.is_finished(),
                    "a refused STOP stopped the daemon"
                );
                print(&mut b, "stop-ch-b", "still-here").await;

                a.send(&stop(true)).await;
                // Closing the connection is the acknowledgement.
                a.frames_until_closed().await;
                let summary = daemon.finished().await.expect("a clean stop");
                assert_eq!(summary.confirmed_shell_exits, 1);
            }

            /// STOP from the hub that holds every terminal stops the daemon,
            /// on the path a signal takes: terminals torn down, connection
            /// closed.
            #[tokio::test]
            async fn stop_ends_a_daemon_whose_terminals_are_all_its_callers() {
                let daemon = TestDaemon::start("stop-own").await;
                let (mut a, _) = daemon.connect_as(Some(KEY_A)).await;
                spawned(&mut a, interactive("stop-ch-a")).await;

                a.send(&stop(false)).await;
                let frames = a.frames_until_closed().await;
                assert_eq!(errors(&frames), Vec::<String>::new());
                let summary = daemon.finished().await.expect("a clean stop");
                assert_eq!(summary.confirmed_shell_exits, 1);
            }

            /// Connections without a key are one hub, `legacy`, which keeps
            /// today's rule among its own: the last one wins. A hub with a
            /// key is not part of it.
            #[tokio::test]
            async fn legacy_connections_replace_each_other_and_no_one_else() {
                let daemon = TestDaemon::start("legacy").await;
                let (mut keyed, mut seen_by_keyed) = daemon.connect_as(Some(KEY_A)).await;
                seen_by_keyed.extend(spawned(&mut keyed, interactive("legacy-keyed")).await);
                let (mut first, _) = daemon.connect_as(None).await;
                spawned(&mut first, interactive("legacy-held")).await;

                let (mut second, second_state) = daemon.connect_as(None).await;
                assert_eq!(state(&second_state), (vec!["legacy-held".to_string()], 1));
                let first_saw = first.frames_until_closed().await;
                assert!(errors(&first_saw).contains(&"DISPLACED".to_string()));
                print(&mut second, "legacy-held", "legacy-last-wins").await;

                seen_by_keyed.extend(print(&mut keyed, "legacy-keyed", "keyed-untouched").await);
                assert_eq!(errors(&seen_by_keyed), Vec::<String>::new());
                assert_eq!(
                    mentions(&seen_by_keyed, "legacy-held"),
                    Vec::<String>::new()
                );

                daemon.stop().await;
            }

            /// A hub from before #127 sends nothing to a daemon without a
            /// token: it waits for the channel state, and gives up after 5 s.
            /// It gets that state in time, as `legacy`.
            #[tokio::test]
            async fn a_hub_that_sends_nothing_first_is_legacy_and_gets_its_state_in_time() {
                let daemon = TestDaemon::start("silent").await;
                let (mut first, _) = daemon.connect_as(None).await;
                spawned(&mut first, interactive("silent-held")).await;

                let started = std::time::Instant::now();
                let mut silent = daemon.open_silently().await;
                let frames = silent.read_until("CHANNEL_STATE_END").await;
                assert!(
                    started.elapsed() < Duration::from_secs(4),
                    "an old hub gives up after 5 s; the state took {:?}",
                    started.elapsed()
                );
                assert_eq!(state(&frames), (vec!["silent-held".to_string()], 0));
                print(&mut silent, "silent-held", "old-hub-types").await;

                daemon.stop().await;
            }

            /// CHANNEL_STATE_END counts the channels every other hub holds.
            #[tokio::test]
            async fn channel_state_end_counts_the_channels_other_hubs_hold() {
                let daemon = TestDaemon::start("count").await;
                let (mut a, _) = daemon.connect_as(Some(KEY_A)).await;
                spawned(&mut a, interactive("count-a-1")).await;
                spawned(&mut a, interactive("count-a-2")).await;
                let (mut b, _) = daemon.connect_as(Some(KEY_B)).await;
                spawned(&mut b, interactive("count-b-1")).await;

                let (_a2, a_state) = daemon.connect_as(Some(KEY_A)).await;
                assert_eq!(
                    state(&a_state),
                    (vec!["count-a-1".to_string(), "count-a-2".to_string()], 1)
                );
                let (_b2, b_state) = daemon.connect_as(Some(KEY_B)).await;
                assert_eq!(state(&b_state), (vec!["count-b-1".to_string()], 2));
                let (_c, c_state) = daemon.connect_as(Some("hub-c-key")).await;
                assert_eq!(state(&c_state), (Vec::<String>::new(), 3));
                let (_legacy, legacy_state) = daemon.connect_as(None).await;
                assert_eq!(state(&legacy_state), (Vec::<String>::new(), 3));

                daemon.stop().await;
            }
        }
    }
}
