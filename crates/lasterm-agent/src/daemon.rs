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

use crate::away::AwayQueue;
use crate::batch::{batch_loop, BatchedEvent, ChannelEventSender, Delivery};
use crate::flow::{Flows, InTransit, Marks};
use crate::framing::{encode_frame, FrameReader};
use crate::handler::{handle_message, ConnectionRef, FrameSender, Outgoing, SnapshotSenders};
use crate::owner::{ct_eq, OwnerId};
use crate::platform_dirs::{lasterm_dir, DirKind};
use crate::protocol::{error_codes, AgentToHub, HubToAgent};
use crate::pty::{DestroyAllSummary, PtyManager};

#[cfg(unix)]
const BIND_RETRY_MAX: u32 = 3;
#[cfg(unix)]
const BIND_RETRY_DELAY_MS: u64 = 300;
/// How long a daemon waits for AUTH before dropping a connection. A hub sends
/// it as soon as it reads HELLO, one round trip, well within it.
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
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
///
/// A hub's flow follows its current connection: what that connection has yet
/// to write holds the hub's terminals back, and nothing else does (#553).
#[derive(Default)]
struct HubRoutes {
    connections: HashMap<OwnerId, ActiveConnection>,
    queues: HashMap<OwnerId, AwayQueue>,
    flows: Flows,
    /// Every authenticated connection's writer still running, current or
    /// not (displaced, or its hub gone, with frames still to write): each
    /// closes when its writer task ends, and the shutdown waits on all of
    /// them, so that what was queued, STOP_ACCEPTED included, is written
    /// before the process exits (#700).
    writers: Vec<watch::Receiver<()>>,
}

type Routes = Arc<Mutex<HubRoutes>>;

impl HubRoutes {
    fn new(flows: Flows) -> Self {
        Self {
            connections: HashMap::new(),
            queues: HashMap::new(),
            flows,
            writers: Vec::new(),
        }
    }

    /// Send a frame of `channel_id` to `owner`'s connection, charged to it
    /// until written, or keep it for the next one. A kept frame is charged to
    /// nothing: the away queue has bounds of its own, and a terminal whose hub
    /// is away runs on.
    fn route(
        &mut self,
        owner: &OwnerId,
        channel_id: &str,
        frame: Vec<u8>,
        charge: Option<InTransit>,
    ) {
        let frame = match self.connections.get(owner) {
            Some(active) => {
                let out = Outgoing::charged(frame, charge, active.connection_id);
                match active.frame_tx.send(out) {
                    Ok(()) => return,
                    // Its writer is gone while it is still registered: the hub
                    // went away and the read loop has not seen it yet.
                    Err(mpsc::error::SendError(out)) => out.into_frame(),
                }
            }
            None => frame,
        };
        self.queues
            .entry(owner.clone())
            .or_default()
            .push(channel_id, frame);
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
        Self::with_pipeline(expected_token, pty_manager, shutdown, Marks::DEFAULT)
    }

    /// Start the pipeline, holding a hub's terminals back at `marks`.
    fn with_pipeline(
        expected_token: Option<String>,
        pty_manager: Arc<Mutex<PtyManager>>,
        shutdown: ShutdownReceiver,
        marks: Marks,
    ) -> Self {
        let flows = Flows::new(marks);
        let (channel_events, channel_events_rx) = ChannelEventSender::new(flows.clone());
        let (batched_tx, batched_rx) = mpsc::unbounded_channel::<BatchedEvent>();
        tokio::spawn(batch_loop(channel_events_rx, batched_tx));
        let routes: Routes = Arc::new(Mutex::new(HubRoutes::new(flows)));
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
    async fn unused(&self) -> bool {
        self.routes.lock().await.connections.is_empty()
            && self.pty_manager.lock().await.channel_ids().is_empty()
    }
}

/// How long the shutdown waits, in all, for the hub connections' writers to
/// write what they had queued (#700).
const WRITER_DRAIN_BOUND: Duration = Duration::from_secs(2);

/// End every hub connection, once the terminals are torn down. What each
/// already has queued goes out first, STOP_ACCEPTED included: the shutdown
/// waits for every writer to finish, within one bound for all of them, and
/// abandons those still writing at the bound (#700).
/// How a daemon ends, once its shutdown is asked for: its terminals torn
/// down, then every hub connection ended, what each had queued written first
/// within `WRITER_DRAIN_BOUND` (#700). The caller exits the process after it.
async fn end_daemon(pty_manager: &Arc<Mutex<PtyManager>>, routes: &Routes) -> DestroyAllSummary {
    let summary = teardown_daemon_terminals(pty_manager).await;
    disconnect_all(routes).await;
    summary
}

async fn disconnect_all(routes: &Routes) {
    let bound = WRITER_DRAIN_BOUND;
    let writers = {
        let mut routes = routes.lock().await;
        let ended: Vec<(OwnerId, ActiveConnection)> = routes.connections.drain().collect();
        for (owner, active) in ended {
            routes.flows.of(&owner).detach(active.connection_id);
            active.cancel.send_replace(true);
        }
        std::mem::take(&mut routes.writers)
    };
    let all_written = async {
        for mut done in writers {
            // Err once the writer task has ended and dropped its sender.
            while done.changed().await.is_ok() {}
        }
    };
    if tokio::time::timeout(bound, all_written).await.is_err() {
        tracing::warn!(
            bound_ms = bound.as_millis() as u64,
            "hub connection writers still writing at shutdown; abandoned"
        );
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
const IDLE_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// How often the idle check runs for `idle_timeout`: every `IDLE_CHECK_EVERY`,
/// or sooner for a shorter timeout, so a caller asking for a second does not
/// wait ten. A connection that begins and ends between two checks is not
/// seen.
fn idle_check_period(idle_timeout: Option<std::time::Duration>) -> std::time::Duration {
    idle_timeout.map_or(IDLE_CHECK_EVERY, |limit| limit.min(IDLE_CHECK_EVERY))
}

#[cfg(test)]
mod idle_check_period_tests {
    use super::idle_check_period;
    use std::time::Duration;

    // A long timeout is still checked every ten seconds, on both platforms
    // (#755). Mutation: a period equal to the timeout.
    #[test]
    fn checks_a_long_timeout_every_ten_seconds_and_a_short_one_at_its_pace() {
        assert_eq!(
            idle_check_period(Some(Duration::from_secs(1800))),
            Duration::from_secs(10)
        );
        assert_eq!(
            idle_check_period(Some(Duration::from_secs(2))),
            Duration::from_secs(2)
        );
        assert_eq!(idle_check_period(None), Duration::from_secs(10));
    }
}

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

    // Nothing is looked at, removed or bound in a directory that is not this
    // user's own (socket_dir.rs). A missing one is created 0700.
    crate::socket_dir::ensure_private_socket_dir_for(&path)?;

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
    let mut idle_check = tokio::time::interval(idle_check_period(idle_timeout));
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
                break Ok(end_daemon(&pty_manager, &daemon.routes).await);
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
/// Format: `\\.\pipe\<base>-agent-<username>`, `<base>` following the channel.
#[cfg(windows)]
fn get_pipe_name() -> String {
    let username = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    crate::platform_dirs::default_pipe_name(crate::platform_dirs::channel(), &username)
}

/// Refuses a `--socket` that is not a named pipe (`\\.\pipe\<name>`).
///
/// A filesystem path cannot be listened on here, and the daemon used to listen
/// on the default pipe instead, leaving the hub to connect to the path it was
/// given (#733). The prefix is matched without regard to case, as Windows does.
#[cfg(windows)]
pub(crate) fn require_pipe_name(socket: &str) -> std::io::Result<()> {
    const PREFIX: &str = r"\\.\pipe\";
    let is_pipe = socket.len() > PREFIX.len()
        && socket.is_char_boundary(PREFIX.len())
        && socket[..PREFIX.len()].eq_ignore_ascii_case(PREFIX);
    if is_pipe {
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        format!(
            "--socket {socket:?} is not a named pipe: on Windows it must look like {PREFIX}<name> \
             (leave it out for the default {})",
            get_pipe_name()
        ),
    ))
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
    // auth.json lives in the hub's configuration directory, %APPDATA%\lasterm.
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

/// Internal implementation — takes explicit directories, as on Unix, so tests
/// can run a daemon without reading the user's profile.
#[cfg(windows)]
async fn run_daemon_impl(
    socket_path: String,
    config_dir: String,
    state_dir: std::path::PathBuf,
    mut shutdown: ShutdownReceiver,
    bound: Option<oneshot::Sender<()>>,
    // How long to stay up holding nothing, for nobody, as on Unix: a remote
    // daemon reached through `--attach` (#755). `None` never exits.
    idle_timeout: Option<std::time::Duration>,
) -> std::io::Result<DestroyAllSummary> {
    // Never another pipe than the one asked for: a hub that looks at the path it
    // was given would otherwise reach nothing (#733).
    require_pipe_name(&socket_path)?;
    let pipe_name = socket_path.clone();

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

    // The same idle rule as on Unix: nobody connected and nothing held.
    let mut idle_since: Option<std::time::Instant> = None;
    let mut idle_check = tokio::time::interval(idle_check_period(idle_timeout));
    idle_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
            _ = idle_check.tick(), if idle_timeout.is_some() => {
                if !daemon.unused().await {
                    idle_since = None;
                    continue;
                }
                let since = *idle_since.get_or_insert_with(std::time::Instant::now);
                let waited = since.elapsed();
                if idle_timeout.is_some_and(|limit| waited >= limit) {
                    tracing::info!(
                        waited_secs = waited.as_secs(),
                        "daemon idle with no terminals and no hub; exiting"
                    );
                    drop(server.take());
                    break Ok(());
                }
                continue;
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
    let summary = end_daemon(&pty_manager, &daemon.routes).await;
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

/// Why a connection was refused: the ERROR it is sent before it is closed.
#[derive(Debug, PartialEq, Eq)]
struct Refusal {
    code: &'static str,
    message: String,
}

impl Refusal {
    /// The connection did not open with an AUTH carrying a hub key.
    fn auth_required(detail: Option<&str>) -> Self {
        let message = "a daemon connection must open with AUTH, carrying a hub key";
        Self {
            code: error_codes::AUTH_REQUIRED,
            message: match detail {
                Some(detail) => format!("{message}: {detail}"),
                None => message.to_string(),
            },
        }
    }

    /// The AUTH it opened with names no hub, or carries a token refused.
    fn auth_invalid(message: &str) -> Self {
        Self {
            code: error_codes::AUTH_INVALID,
            message: message.to_string(),
        }
    }

    fn frame(&self) -> AgentToHub {
        AgentToHub::Error {
            code: self.code.to_string(),
            message: self.message.clone(),
            channel_id: None,
            other_owner_channels: None,
            request_id: None,
        }
    }
}

/// Read the AUTH that follows HELLO and say whose connection this is.
///
/// - `Ok(Ok(owner))`: accepted. The owner is named by the AUTH's `hub_key`.
///   What the hub sent after its AUTH stays in `pending`, to be processed once
///   the connection is registered.
/// - `Ok(Err(refusal))`: refused. The first frame is not an AUTH with a hub
///   key, or did not come within `AUTH_TIMEOUT`; or the key is empty; or a
///   token is configured and the AUTH carries another.
/// - `Err`: the connection ended, or sent a frame that cannot be read.
///
/// Every hub opens a daemon connection with AUTH and its key (#127), with or
/// without a token: a daemon with no token (a first run, or a remote machine
/// with no hub of its own) still needs to know whose connection it is.
///
/// No key is logged, ever.
async fn handshake<R: AsyncRead + Unpin>(
    reader: &mut R,
    frames: &mut FrameReader,
    pending: &mut VecDeque<HubToAgent>,
    expected_token: Option<&str>,
) -> std::io::Result<Result<OwnerId, Refusal>> {
    match tokio::time::timeout(AUTH_TIMEOUT, read_messages(reader, frames, pending)).await {
        Ok(read) => read?,
        Err(_elapsed) => {
            return Ok(Err(Refusal::auth_required(Some("none came within 5 s"))));
        }
    }

    let (token, hub_key) = match pending.pop_front() {
        Some(HubToAgent::Auth { token, hub_key }) => (token, hub_key),
        // What the frame reader makes of a frame it cannot decode, such as an
        // AUTH without a hub key.
        Some(HubToAgent::Error { code, message, .. }) if code == error_codes::INVALID_MESSAGE => {
            return Ok(Err(Refusal::auth_required(Some(&message))));
        }
        _ => return Ok(Err(Refusal::auth_required(None))),
    };
    if let Some(expected) = expected_token {
        // An empty expected token marks an auth.json that is missing beside a
        // meta.db, unreadable or malformed: nothing may pass, not even an
        // empty token, which is what a hub sends to a daemon it holds no
        // token for (#127).
        if expected.is_empty() || !ct_eq(expected.as_bytes(), token.as_bytes()) {
            return Ok(Err(Refusal::auth_invalid("the AUTH token was refused")));
        }
    }
    if hub_key.is_empty() {
        return Ok(Err(Refusal::auth_invalid("the AUTH hub key is empty")));
    }
    Ok(Ok(OwnerId::from_hub_key(&hub_key)))
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
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Outgoing>();
    let (cancel, _) = watch::channel(false);
    // Dropped with the writer task: what the shutdown waits on (#700).
    let (writer_alive, writer_done) = watch::channel(());

    // Spawn writer task — drains frame_rx to the write half. A terminal's
    // frame stays charged to its hub until written: a hub that stops reading
    // holds its terminals back here, and only them (#553).
    let mut cancel_rx = cancel.subscribe();
    tokio::spawn(async move {
        let _writer_alive = writer_alive;
        loop {
            tokio::select! {
                _ = cancelled(&mut cancel_rx) => {
                    // Displaced, or the daemon is stopping. What is already
                    // queued goes out first — the notice saying why this
                    // connection is ending is enqueued immediately before the
                    // cancellation, and a writer that stopped here would drop
                    // the only thing that explains the EOF the other end is
                    // about to read (#127).
                    while let Ok(out) = frame_rx.try_recv() {
                        if write_half.write_all(&out.frame).await.is_err() {
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
                        Some(out) => {
                            if write_half.write_all(&out.frame).await.is_err() {
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
    )
    .await
    {
        Ok(Ok(owner)) => owner,
        Ok(Err(refusal)) => {
            tracing::warn!(
                connection_id,
                code = refusal.code,
                "auth handshake refused — dropping connection"
            );
            // Said before the connection closes: the writer sends what is
            // queued before it ends, which is once `frame_tx` is dropped here.
            let _ = send_encoded(&frame_tx, &refusal.frame());
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
    let displaced = register_active(
        &daemon.routes,
        &owner,
        connection_id,
        &cancel,
        &frame_tx,
        Some(writer_done.clone()),
    )
    .await;
    if let Some(displaced) = displaced {
        // Its cancel is set: what it still dispatches is dropped (#1014). Its
        // pastes close now, before this connection dispatches anything, so
        // their end markers precede whatever this one queues.
        close_connection_pastes(&daemon.pty_manager, displaced).await;
    }
    let connection = ConnectionRef::daemon(connection_id, cancel.subscribe());

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
            // Ended, its exit still on its way: listed. Its exit reaches this
            // connection too, before or after this state (#1089).
            .chain(mgr.ending_of(&owner).into_iter().map(|(channel_id, pid)| {
                AgentToHub::AgentChannelState {
                    channel_id,
                    title: String::new(),
                    pid,
                    alive: true,
                }
            }))
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
    // read beyond AUTH goes first. ---
    let mut cancel_rx = cancel.subscribe();
    let mut buf = vec![0u8; 8192];
    'connection: loop {
        while let Some(msg) = pending.pop_front() {
            if let Err(e) = dispatch(msg, &daemon, &owner, &frame_tx, &connection).await {
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
    // However it ended, what it was pasting is closed for the programs
    // (#1014). A displaced connection's pastes were closed when it was
    // displaced; this finds none of them open.
    close_connection_pastes(&daemon.pty_manager, connection_id).await;
}

/// Close every paste `connection_id` still has open, on every terminal: the
/// connection ended or was displaced (#1014).
async fn close_connection_pastes(pty_manager: &Mutex<PtyManager>, connection_id: u64) {
    let mgr = pty_manager.lock().await;
    for channel in mgr.channels.values() {
        channel.input.close_connection(connection_id);
    }
}

/// Act on one message from a registered connection. STOP is the daemon's to
/// answer; everything else is shared with stdio.
async fn dispatch(
    msg: HubToAgent,
    daemon: &DaemonShared,
    owner: &OwnerId,
    frame_tx: &FrameSender,
    connection: &ConnectionRef,
) -> std::io::Result<()> {
    match msg {
        HubToAgent::Stop { force } => {
            handle_stop(daemon, owner, force, frame_tx, connection).await;
            Ok(())
        }
        msg => {
            handle_message(
                msg,
                owner,
                connection,
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
/// hubs hold channels, and nothing stops. Otherwise it says STOP_ACCEPTED and
/// asks for the shutdown a signal asks for; the connection closes once the
/// terminals are torn down (#700).
///
/// A STOP still queued on a connection that a newer one of the same hub has
/// displaced is dropped, as that connection's INPUT is: it was decided before
/// the newer connection, which may have started terminals since. The check is
/// made under the manager lock `begin_shutdown` takes, so no terminal can
/// start between it and the shutdown.
async fn handle_stop(
    daemon: &DaemonShared,
    owner: &OwnerId,
    force: bool,
    frame_tx: &FrameSender,
    connection: &ConnectionRef,
) {
    let connection_id = connection.id;
    let mut mgr = daemon.pty_manager.lock().await;
    if connection.is_displaced() {
        drop(mgr);
        tracing::info!(
            connection_id,
            owner = owner.short(),
            "STOP dropped: its connection was displaced"
        );
        return;
    }
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
    // Queued still under the lock, before the shutdown is asked for: the
    // writer drains it before the end of stream, and the shutdown waits for
    // the writers (#700).
    let _ = send_encoded(frame_tx, &AgentToHub::StopAccepted {});
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
        request_id: None,
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
    writer_done: Option<watch::Receiver<()>>,
) -> Option<u64> {
    let mut routes = routes.lock().await;
    if let Some(done) = writer_done {
        // Kept until its writer ends, whatever becomes of the connection;
        // writers already ended are let go of here (#700).
        routes.writers.retain(|writer| writer.has_changed().is_ok());
        routes.writers.push(done);
    }
    let mut displaced = None;
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
            request_id: None,
        };
        let _ = send_encoded(&old.frame_tx, &notice);
        old.cancel.send_replace(true);
        displaced = Some(old.connection_id);
    }
    // From now on, this connection's queue is what holds the hub's terminals
    // back. Whatever the replaced one still holds, stuck on a socket nobody
    // reads, no longer does (#553).
    let flow = routes.flows.of(owner);
    flow.attach(connection_id);
    if let Some(queued) = routes.queues.remove(owner) {
        let (frames, dropped_bytes) = queued.drain();
        tracing::debug!(
            connection_id,
            owner = owner.short(),
            queued = frames.len(),
            dropped_bytes,
            "sending what this hub's terminals said while it was away"
        );
        for frame in frames {
            let charge = flow.queue(connection_id, frame.len());
            let _ = frame_tx.send(Outgoing::queued(frame, charge));
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
    displaced
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
        if let Some(active) = routes.connections.remove(owner) {
            routes.flows.of(owner).detach(active.connection_id);
        }
    }
}

/// Encode a message and push the frame bytes into the frame channel.
fn send_encoded(
    tx: &FrameSender,
    msg: &AgentToHub,
) -> Result<(), mpsc::error::SendError<Outgoing>> {
    match encode_frame(msg) {
        Ok(frame) => tx.send(Outgoing::reply(frame)),
        Err(_) => Err(mpsc::error::SendError(Outgoing::reply(vec![]))),
    }
}

/// Spawn the output router task.
///
/// Drains what the batch loop hands on — every channel's output, and its exit,
/// title, bell, notification and log frames — and forwards each to the current
/// connection of the hub that owns the channel, whichever connection spawned it
/// (#549), charged to that connection until written (#553). While that hub has
/// none, its own away queue keeps each channel's newest output, within bounds
/// (`away.rs`); `register_active` sends it on (#127). A snapshot reply goes to
/// the connection that asked, in the same order (#931).
fn spawn_output_router(mut batched_rx: mpsc::UnboundedReceiver<BatchedEvent>, routes: Routes) {
    tokio::spawn(async move {
        while let Some(event) = batched_rx.recv().await {
            match event.into_delivery() {
                Ok(Delivery::Owner(routed)) => {
                    #[cfg(test)]
                    if let Some(delay) = crate::pty::route_delay_of(&routed.channel_id)
                        .filter(|_| routed.routed.is_some())
                        .or_else(|| crate::pty::held_route_of(&routed.channel_id))
                    {
                        tokio::time::sleep(delay).await;
                    }
                    routes.lock().await.route(
                        &routed.owner,
                        &routed.channel_id,
                        routed.frame,
                        routed.charge,
                    );
                    // In its hub's queue now: the id it held is free (#1089).
                    drop(routed.routed);
                }
                Ok(Delivery::Asker(reply)) => reply.send(),
                Err(_) => {}
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

    /// Where a test daemon's socket goes: in a directory of its own, which the
    /// daemon creates 0700, as it requires of any socket directory.
    #[cfg(unix)]
    fn socket_path(prefix: &str) -> PathBuf {
        temp_path(prefix).join("agent.sock")
    }

    /// Remove a test socket and the directory `socket_path` put it in.
    #[cfg(unix)]
    fn remove_socket(path: &std::path::Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
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

    /// #733: only `\\.\pipe\<name>` is a Windows endpoint; anything else is refused.
    #[cfg(windows)]
    #[test]
    fn require_pipe_name_accepts_pipes_and_refuses_the_rest() {
        for good in [
            r"\\.\pipe\lasterm-agent-x",
            r"\\.\PIPE\lasterm-agent-x",
            r"\\.\pipe\a",
        ] {
            assert!(require_pipe_name(good).is_ok(), "{good} is a pipe");
        }
        for bad in [
            "",
            "/run/user/1000/lasterm/agent.sock",
            r"C:\Users\x\agent.sock",
            r"\\.\pipe\",
            r"\\server\share\agent",
            "agent.sock",
            "é\u{301}é\u{301}é\u{301}é\u{301}é\u{301}é\u{301}é\u{301}é",
        ] {
            let error = require_pipe_name(bad).expect_err(bad);
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput, "{bad}");
            assert!(error.to_string().contains("not a named pipe"), "{error}");
        }
    }

    /// #733: a daemon given a filesystem path fails, rather than listening on
    /// the default pipe where the hub, looking at that path, would never come.
    #[cfg(windows)]
    #[tokio::test]
    async fn daemon_refuses_a_non_pipe_socket_without_listening() {
        let dir = std::env::temp_dir().join(format!("lasterm-733-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Bounded: a daemon that listens instead of refusing would never return.
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_daemon_impl(
                r"C:\not\a\pipe.sock".into(),
                dir.to_string_lossy().into_owned(),
                dir.clone(),
                no_shutdown_request(),
                None,
                None,
            ),
        )
        .await
        .expect("a non-pipe socket must be refused, not listened on")
        .expect_err("a non-pipe socket must not start a daemon");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        std::fs::remove_dir_all(&dir).ok();
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

        let path = socket_path("lasterm-test");
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
        remove_socket(&path);
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

        let path = socket_path("lasterm-test-displace");
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

        // Both connections carry the same key: one hub, so the second
        // replaces the first.
        let auth = crate::framing::encode_frame(&crate::protocol::HubToAgent::Auth {
            token: String::new(),
            hub_key: "displaced-hub-key".to_string(),
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
        remove_socket(&path);
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

        let path = socket_path("lasterm-test-perms");
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
            // The daemon made the socket's directory, and made it owner-only.
            let dir = std::fs::metadata(path.parent().unwrap()).unwrap();
            let dir_mode = dir.permissions().mode() & 0o777;
            assert_eq!(
                dir_mode, 0o700,
                "socket directory must be 0700, got {dir_mode:o}"
            );
        }

        daemon_handle.abort();
        remove_socket(&path);
        let _ = tokio::fs::remove_dir_all(&empty_config).await;
        let _ = tokio::fs::remove_dir_all(&state_dir).await;
    }

    /// A socket directory open to others is refused before anything is bound
    /// or removed in it, whatever else is there.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_refuses_a_socket_directory_open_to_others() {
        use std::os::unix::fs::PermissionsExt;

        let config_dir = temp_dir("lasterm-test-cfg-opendir").await;
        let state_dir = temp_dir("lasterm-test-state-opendir").await;
        let path = socket_path("lasterm-test-opendir");
        let dir = path.parent().unwrap().to_path_buf();
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Something where the socket goes, which a daemon would otherwise
        // take for a dead daemon's leftover and remove.
        std::fs::write(&path, b"").unwrap();

        let result = run_daemon_impl(
            path.to_string_lossy().into_owned(),
            config_dir.to_string_lossy().into_owned(),
            state_dir.clone(),
            no_shutdown_request(),
            None,
            None,
        )
        .await;

        let error = result.expect_err("a directory open to others must be refused");
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied,
            "{error}"
        );
        assert!(error.to_string().contains("mode 755"), "{error}");
        assert!(
            std::fs::metadata(&path).unwrap().is_file(),
            "nothing in a refused directory is removed or bound"
        );

        remove_socket(&path);
        let _ = tokio::fs::remove_dir_all(&config_dir).await;
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

        let path = socket_path("lasterm-test-state-end");
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
            hub_key: "state-end-hub-key".to_string(),
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
        remove_socket(&path);
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
            // This daemon has no token: a hub sends an empty one, and its key.
            let auth = HubToAgent::Auth {
                token: String::new(),
                hub_key: "shutdown-hub-key".to_string(),
            };
            stream
                .write_all(&encode_frame(&auth).expect("encode AUTH"))
                .await
                .expect("send AUTH");
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
                env_mode: "inherit".to_string(),
                env_unset: None,
                login_shell: None,
                report_directory: None,
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
            let socket_path = super::socket_path(&format!("lasterm-daemon-shutdown-{label}"));
            {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(socket_path.parent().expect("a socket directory"))
                    .expect("create the socket directory");
            }
            (
                socket_path.to_string_lossy().to_string(),
                config_dir.to_string_lossy().to_string(),
                state_dir,
            )
        }

        async fn cleanup_paths(socket_path: &str, config_dir: &str, state_dir: &Path) {
            super::remove_socket(Path::new(socket_path));
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
        let flows = Flows::default();
        let (channel_events, _nobody_reads) = ChannelEventSender::new(flows.clone());
        DaemonShared {
            pty_manager: Arc::new(Mutex::new(PtyManager::new())),
            cmd_senders: Arc::new(Mutex::new(HashMap::new())),
            channel_events,
            routes: Arc::new(Mutex::new(HubRoutes::new(flows))),
            expected_token: expected_token.map(str::to_owned),
            shutdown: shutdown_channel().1,
        }
    }

    /// A connection of `owner` registered earlier, as the daemon keeps it:
    /// what cancels it, and what it would write to its hub.
    struct Incumbent {
        cancelled: watch::Receiver<bool>,
        frames: mpsc::UnboundedReceiver<Outgoing>,
    }

    async fn incumbent(daemon: &DaemonShared, owner: &OwnerId, connection_id: u64) -> Incumbent {
        let (cancel, cancelled) = watch::channel(false);
        let (frame_tx, frames) = mpsc::unbounded_channel::<Outgoing>();
        register_active(
            &daemon.routes,
            owner,
            connection_id,
            &cancel,
            &frame_tx,
            None,
        )
        .await;
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

    fn auth(token: &str, hub_key: &str) -> HubToAgent {
        HubToAgent::Auth {
            token: token.to_string(),
            hub_key: hub_key.to_string(),
        }
    }

    /// Every frame the daemon writes to `client` until it closes the
    /// connection, decoded.
    async fn frames_until_closed(client: &mut tokio::io::DuplexStream) -> Vec<serde_json::Value> {
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), client.read_to_end(&mut bytes))
            .await
            .expect("the daemon closes the connection")
            .expect("read the connection");
        let mut frames = Vec::new();
        let mut rest = bytes.as_slice();
        while rest.len() >= 4 {
            let len = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
            frames.push(rmp_serde::from_slice(&rest[4..4 + len]).expect("decode a frame"));
            rest = &rest[4 + len..];
        }
        assert!(rest.is_empty(), "the connection ends on a whole frame");
        frames
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

    /// A peer that fails AUTH neither displaces the active hub nor becomes it
    /// (#127), even with that hub's key.
    #[tokio::test]
    async fn failed_auth_leaves_the_active_hub_in_place() {
        let daemon = in_memory_daemon(Some(HUB_TOKEN));
        let hub = OwnerId::from_hub_key("hub-key");
        let incumbent = incumbent(&daemon, &hub, 7).await;

        let wrong = auth(
            "000000def456abc123def456abc123def456abc123def456abc123def456abc1",
            "hub-key",
        );
        let (_client, handler) = connect_in_memory(&daemon, &wrong, 42).await;
        tokio::time::timeout(Duration::from_secs(5), handler)
            .await
            .expect("a refused peer's handler ends")
            .expect("handler does not panic");

        // Mutation caught: registering at accept time made this peer the
        // active connection and cancelled the incumbent before AUTH was read.
        assert_eq!(current_connection(&daemon, &hub).await, Some(7));
        assert!(
            !*incumbent.cancelled.borrow(),
            "the incumbent hub must not be displaced by a peer that failed AUTH"
        );
    }

    /// A refused connection is told why, then closed, and learns nothing of
    /// the channels: HELLO, one ERROR, the end.
    #[tokio::test]
    async fn a_refused_connection_is_told_why_and_closed() {
        let wrong = auth(
            "000000def456abc123def456abc123def456abc123def456abc123def456abc1",
            "hub-key",
        );
        let cases = [
            (Some(HUB_TOKEN), heartbeat("first"), "AUTH_REQUIRED"),
            (None, heartbeat("first"), "AUTH_REQUIRED"),
            (Some(HUB_TOKEN), wrong, "AUTH_INVALID"),
            (None, auth("", ""), "AUTH_INVALID"),
        ];
        for (connection_id, (token, first, code)) in (1..).zip(cases) {
            let daemon = in_memory_daemon(token);
            let (mut client, handler) = connect_in_memory(&daemon, &first, connection_id).await;
            let frames = frames_until_closed(&mut client).await;
            let types: Vec<&str> = frames
                .iter()
                .map(|frame| frame["type"].as_str().unwrap_or(""))
                .collect();
            assert_eq!(types, ["HELLO", "ERROR"], "{code}: {frames:?}");
            assert_eq!(frames[1]["code"], code, "{frames:?}");
            assert!(frames[1].get("channel_id").is_none(), "{frames:?}");
            tokio::time::timeout(Duration::from_secs(5), handler)
                .await
                .expect("a refused peer's handler ends")
                .expect("handler does not panic");
            assert!(daemon.routes.lock().await.connections.is_empty());
        }
    }

    /// Like `connect_in_memory`, over a stream that buffers only `buffer`
    /// bytes: a writer the client does not read stays blocked.
    async fn connect_in_memory_buffered(
        daemon: &DaemonShared,
        first: &HubToAgent,
        connection_id: u64,
        buffer: usize,
    ) -> tokio::io::DuplexStream {
        let (mut client, server) = tokio::io::duplex(buffer);
        tokio::spawn(handle_connection_inner(
            server,
            daemon.clone(),
            connection_id,
        ));
        client
            .write_all(&encode_frame(first).expect("encode the first frame"))
            .await
            .expect("send the first frame");
        client
    }

    /// Read whole frames from `client` until one of type `kind`, decoded.
    async fn frames_until_type(
        client: &mut tokio::io::DuplexStream,
        kind: &str,
    ) -> Vec<serde_json::Value> {
        let mut frames = Vec::new();
        loop {
            let mut len = [0u8; 4];
            tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut len))
                .await
                .unwrap_or_else(|_| panic!("a {kind} frame arrives; got {frames:?}"))
                .expect("read a frame length");
            let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
            client.read_exact(&mut body).await.expect("read a frame");
            let frame: serde_json::Value = rmp_serde::from_slice(&body).expect("decode a frame");
            let done = frame["type"] == kind;
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }

    fn frame_types(frames: &[serde_json::Value]) -> Vec<String> {
        frames
            .iter()
            .map(|frame| frame["type"].as_str().unwrap_or("").to_string())
            .collect()
    }

    /// Queue `frame` for `owner`'s current connection.
    async fn queue_frame(daemon: &DaemonShared, owner: &OwnerId, frame: Vec<u8>) {
        let routes = daemon.routes.lock().await;
        let active = routes.connections.get(owner).expect("a current connection");
        let _ = active.frame_tx.send(Outgoing::reply(frame));
    }

    /// Queue more than a small stream buffers for `owner`'s connection, so
    /// that its writer blocks until the client reads.
    async fn block_writer(daemon: &DaemonShared, owner: &OwnerId) {
        let filler = encode_frame(&AgentToHub::Log {
            channel_id: "filler".to_string(),
            level: "debug".to_string(),
            msg: "x".repeat(4096),
        })
        .unwrap();
        queue_frame(daemon, owner, filler).await;
    }

    async fn until_shutdown_requested(daemon: &DaemonShared) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !*daemon.shutdown.requested.borrow() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the STOP is taken");
    }

    /// A STOP still waiting for the terminal manager while a newer connection
    /// of the same hub displaces its own is dropped: no shutdown, no
    /// STOP_ACCEPTED. It was decided before the newer connection, which may
    /// start terminals of its own (#700). A check made only before waiting
    /// for the manager would pass it on.
    #[tokio::test]
    async fn a_stop_whose_connection_is_displaced_while_it_waits_is_dropped() {
        let daemon = in_memory_daemon(None);
        let hub = OwnerId::from_hub_key("hub-key");
        let (mut old, _old_handler) = connect_in_memory(&daemon, &auth("", "hub-key"), 1).await;
        frames_until_type(&mut old, "CHANNEL_STATE_END").await;

        let manager = daemon.pty_manager.lock().await;
        old.write_all(&encode_frame(&HubToAgent::Stop { force: false }).unwrap())
            .await
            .unwrap();
        // Let the STOP reach the manager lock and wait there.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let (_newer, _newer_handler) = connect_in_memory(&daemon, &auth("", "hub-key"), 2).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while current_connection(&daemon, &hub).await != Some(2) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the newer connection displaces the old one");
        drop(manager);

        let seen = frames_until_closed(&mut old).await;
        assert!(
            !frame_types(&seen).contains(&"STOP_ACCEPTED".to_string()),
            "{seen:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !*daemon.shutdown.requested.borrow(),
            "a displaced STOP asked for the shutdown"
        );
    }

    /// The writer of the connection a STOP came on, blocked: the shutdown
    /// waits for it within its bound, and the hub then reads STOP_ACCEPTED
    /// whole (#700).
    #[tokio::test]
    async fn the_shutdown_waits_for_a_blocked_writer_within_its_bound() {
        let daemon = in_memory_daemon(None);
        let hub = OwnerId::from_hub_key("hub-key");
        let mut client = connect_in_memory_buffered(&daemon, &auth("", "hub-key"), 1, 64).await;
        frames_until_type(&mut client, "CHANNEL_STATE_END").await;
        block_writer(&daemon, &hub).await;
        client
            .write_all(&encode_frame(&HubToAgent::Stop { force: false }).unwrap())
            .await
            .unwrap();
        until_shutdown_requested(&daemon).await;

        let (manager, routes) = (Arc::clone(&daemon.pty_manager), Arc::clone(&daemon.routes));
        let disconnected = tokio::spawn(async move { end_daemon(&manager, &routes).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !disconnected.is_finished(),
            "returned while the writer was blocked"
        );

        let rest = frames_until_closed(&mut client).await;
        assert!(
            frame_types(&rest).contains(&"STOP_ACCEPTED".to_string()),
            "{rest:?}"
        );
        tokio::time::timeout(Duration::from_secs(5), disconnected)
            .await
            .expect("returns once the writer is done")
            .unwrap();
    }

    /// The bound the shutdown waits for writers within, as decided (#700).
    #[test]
    fn writers_are_waited_for_two_seconds_in_all() {
        assert_eq!(WRITER_DRAIN_BOUND, Duration::from_secs(2));
    }

    /// A connection displaced while its writer is still held is waited for
    /// too: it is no longer its hub's current one, and its frames are still
    /// owed (#700).
    #[tokio::test]
    async fn the_shutdown_waits_for_a_displaced_connections_writer() {
        let daemon = in_memory_daemon(None);
        let hub = OwnerId::from_hub_key("hub-key");
        let mut old = connect_in_memory_buffered(&daemon, &auth("", "hub-key"), 1, 64).await;
        frames_until_type(&mut old, "CHANNEL_STATE_END").await;
        block_writer(&daemon, &hub).await;
        let (mut newer, _newer_handler) = connect_in_memory(&daemon, &auth("", "hub-key"), 2).await;
        frames_until_type(&mut newer, "CHANNEL_STATE_END").await;
        assert_eq!(current_connection(&daemon, &hub).await, Some(2));

        let (manager, routes) = (Arc::clone(&daemon.pty_manager), Arc::clone(&daemon.routes));
        let disconnected = tokio::spawn(async move { end_daemon(&manager, &routes).await });
        let _ = frames_until_closed(&mut newer).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !disconnected.is_finished(),
            "returned with the displaced connection's writer still held"
        );
        let _ = frames_until_closed(&mut old).await;
        tokio::time::timeout(Duration::from_secs(5), disconnected)
            .await
            .expect("returns once that writer is done")
            .unwrap();
    }

    /// Two writers that stay blocked: one bound of two seconds covers both,
    /// and the shutdown goes on without them (#700).
    #[tokio::test]
    async fn the_shutdown_abandons_blocked_writers_after_one_bound() {
        let daemon = in_memory_daemon(None);
        let mut clients = Vec::new();
        for (id, key) in [(1, "hub-a"), (2, "hub-b")] {
            let mut client = connect_in_memory_buffered(&daemon, &auth("", key), id, 64).await;
            frames_until_type(&mut client, "CHANNEL_STATE_END").await;
            block_writer(&daemon, &OwnerId::from_hub_key(key)).await;
            clients.push(client);
        }
        let started = std::time::Instant::now();
        end_daemon(&daemon.pty_manager, &daemon.routes).await;
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(1900), "{took:?}");
        assert!(
            took < Duration::from_millis(3500),
            "a bound per writer: {took:?}"
        );
        drop(clients);
    }

    /// Two writers, the first done at once, the second blocked then let go
    /// within the bound: the shutdown waits for the second, whose hub reads
    /// what it was owed (#700).
    #[tokio::test]
    async fn the_shutdown_waits_for_every_writer_not_only_the_first() {
        let daemon = in_memory_daemon(None);
        let mut quick = connect_in_memory_buffered(&daemon, &auth("", "hub-a"), 1, 64 * 1024).await;
        frames_until_type(&mut quick, "CHANNEL_STATE_END").await;
        let mut slow = connect_in_memory_buffered(&daemon, &auth("", "hub-b"), 2, 64).await;
        frames_until_type(&mut slow, "CHANNEL_STATE_END").await;
        let slow_hub = OwnerId::from_hub_key("hub-b");
        block_writer(&daemon, &slow_hub).await;
        let owed = encode_frame(&AgentToHub::StopAccepted {}).unwrap();
        queue_frame(&daemon, &slow_hub, owed).await;

        let (manager, routes) = (Arc::clone(&daemon.pty_manager), Arc::clone(&daemon.routes));
        let disconnected = tokio::spawn(async move { end_daemon(&manager, &routes).await });
        let _ = frames_until_closed(&mut quick).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !disconnected.is_finished(),
            "returned after the first writer only"
        );

        let rest = frames_until_closed(&mut slow).await;
        assert!(
            frame_types(&rest).contains(&"STOP_ACCEPTED".to_string()),
            "{rest:?}"
        );
        tokio::time::timeout(Duration::from_secs(5), disconnected)
            .await
            .expect("returns once every writer is done")
            .unwrap();
    }

    /// An authenticated connection of the same hub takes over from the
    /// previous one, and tells it so.
    #[tokio::test]
    async fn authenticated_hub_displaces_the_previous_one() {
        let daemon = in_memory_daemon(Some(HUB_TOKEN));
        let hub = OwnerId::from_hub_key("hub-key");
        let mut incumbent = incumbent(&daemon, &hub, 7).await;

        let (client, handler) = connect_in_memory(&daemon, &auth(HUB_TOKEN, "hub-key"), 42).await;
        tokio::time::timeout(
            Duration::from_secs(5),
            incumbent.cancelled.wait_for(|cancelled| *cancelled),
        )
        .await
        .expect("the previous connection is displaced once the new one authenticates")
        .expect("the daemon keeps the connection's cancel sender");
        assert_eq!(current_connection(&daemon, &hub).await, Some(42));
        let notice = incumbent
            .frames
            .try_recv()
            .expect("told why before being cut");
        assert!(notice.frame.windows(9).any(|w| w == b"DISPLACED"));

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
            connect_in_memory(&daemon, &auth(HUB_TOKEN, "second-hub-key"), 42).await;
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
    ) -> (
        std::io::Result<Result<OwnerId, Refusal>>,
        VecDeque<HubToAgent>,
    ) {
        let mut stream = std::io::Cursor::new(bytes);
        let mut frames = FrameReader::new();
        let mut pending = VecDeque::new();
        let result = handshake(&mut stream, &mut frames, &mut pending, expected_token).await;
        (result, pending)
    }

    /// The code a handshake refused with; panics if it accepted.
    fn refused(result: std::io::Result<Result<OwnerId, Refusal>>) -> &'static str {
        match result.expect("a refusal is not an IO error") {
            Ok(owner) => panic!("accepted as {owner:?}"),
            Err(refusal) => refusal.code,
        }
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
        let (result, _) = handshake_over(frame(&auth(HUB_TOKEN, "hub-key")), Some(HUB_TOKEN)).await;
        assert_eq!(
            result.expect("no IO error"),
            Ok(OwnerId::from_hub_key("hub-key"))
        );
    }

    #[tokio::test]
    async fn handshake_refuses_a_wrong_token() {
        let wrong = "000000def456abc123def456abc123def456abc123def456abc123def456abc1";
        let (result, _) = handshake_over(frame(&auth(wrong, "hub-key")), Some(HUB_TOKEN)).await;
        assert_eq!(refused(result), "AUTH_INVALID");
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

    /// The first frame must be AUTH, token or not: it is where a hub names
    /// itself (#127). What came behind a refused first frame is not acted on.
    #[tokio::test]
    async fn handshake_refuses_another_first_frame_token_or_not() {
        for token in [Some("anytoken"), None] {
            let (result, _) = handshake_over(frame(&heartbeat("t")), token).await;
            assert_eq!(refused(result), "AUTH_REQUIRED", "{token:?}");
        }
    }

    /// An AUTH without a hub key does not decode, and is refused as one that
    /// is not AUTH. One with an empty key names no hub, and is refused too.
    #[tokio::test]
    async fn handshake_refuses_an_auth_without_a_hub_key() {
        let keyless = rmp_serde::to_vec_named(&serde_json::json!({ "type": "AUTH", "token": "" }))
            .expect("encode a keyless AUTH");
        let mut bytes = (keyless.len() as u32).to_le_bytes().to_vec();
        bytes.extend(keyless);
        let (result, _) = handshake_over(bytes, None).await;
        match result.expect("not an IO error") {
            Err(Refusal { code, message }) => {
                assert_eq!(code, "AUTH_REQUIRED");
                assert!(message.contains("hub_key"), "{message}");
            }
            Ok(owner) => panic!("accepted as {owner:?}"),
        }

        let (result, _) = handshake_over(frame(&auth("", "")), None).await;
        assert_eq!(refused(result), "AUTH_INVALID");
        let (result, _) = handshake_over(frame(&auth(HUB_TOKEN, "")), Some(HUB_TOKEN)).await;
        assert_eq!(refused(result), "AUTH_INVALID");
    }

    /// An auth.json that is missing beside a meta.db, unreadable or malformed
    /// leaves an empty expected token, which nothing may match. A hub sends an
    /// empty token to a daemon it holds no token for (#127): that used to
    /// match it, and open a daemon that meant to refuse everyone.
    #[tokio::test]
    async fn a_daemon_that_refuses_everyone_refuses_an_empty_token() {
        let (result, _) = handshake_over(frame(&auth("", "hub-key")), Some("")).await;
        assert_eq!(refused(result), "AUTH_INVALID");
    }

    /// Without a token, AUTH is read all the same, for the key it carries.
    /// A hub sends an empty token to a daemon it holds none for.
    #[tokio::test]
    async fn without_a_token_the_owner_still_comes_from_the_key() {
        let (result, _) = handshake_over(frame(&auth("", "hub-key")), None).await;
        assert_eq!(
            result.expect("no IO error"),
            Ok(OwnerId::from_hub_key("hub-key"))
        );
    }

    /// What a hub sends right behind its AUTH is not lost.
    #[tokio::test]
    async fn a_request_sent_with_auth_is_kept_for_the_connection() {
        let mut bytes = frame(&auth(HUB_TOKEN, "hub-key"));
        bytes.extend(frame(&heartbeat("right-behind")));
        let (result, pending) = handshake_over(bytes, Some(HUB_TOKEN)).await;
        assert!(result.expect("no IO error").is_ok());
        assert!(matches!(
            pending.front(),
            Some(HubToAgent::Heartbeat { ts }) if ts == "right-behind"
        ));
    }

    /// A peer that sends nothing is refused once `AUTH_TIMEOUT` has passed,
    /// token or not.
    #[tokio::test(start_paused = true)]
    async fn a_silent_peer_is_refused_after_the_auth_timeout() {
        for token in [Some(HUB_TOKEN), None] {
            let (_client, mut server) = tokio::io::duplex(1024);
            let mut frames = FrameReader::new();
            let mut pending = VecDeque::new();
            let started = tokio::time::Instant::now();
            let result = handshake(&mut server, &mut frames, &mut pending, token).await;
            assert_eq!(refused(result), "AUTH_REQUIRED", "{token:?}");
            assert_eq!(started.elapsed(), AUTH_TIMEOUT, "{token:?}");
        }
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

        // Not made here: the daemon makes its socket's directory, 0700.
        let sock_dir = std::env::temp_dir().join(format!(
            "lasterm-daemon-auth-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
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
            hub_key: "rejected-hub-key".to_string(),
        };
        let frame = encode_frame(&wrong).unwrap();
        stream.write_all(&frame).await.unwrap();

        // Step 3: the daemon says why, and closes the connection: one ERROR,
        // then EOF, and nothing about its channels.
        let mut rest = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            stream.read_to_end(&mut rest),
        )
        .await
        .expect("the daemon closes the connection after a wrong AUTH")
        .expect("read up to the end of the connection");
        assert!(rest.len() >= 4, "the refusal is said before the end");
        let len = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        assert_eq!(rest.len(), 4 + len, "nothing but the refusal is sent");
        let refusal: serde_json::Value = rmp_serde::from_slice(&rest[4..]).unwrap();
        assert_eq!(refusal["type"], "ERROR");
        assert_eq!(refusal["code"], "AUTH_INVALID");

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

        // Not made here: the daemon makes its socket's directory, 0700.
        let sock_dir = std::env::temp_dir().join(format!(
            "lasterm-daemon-authok-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        ));
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
            hub_key: "accepted-hub-key".to_string(),
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

    /// A SID as `S-1-…`, and the memory it came in freed.
    #[cfg(windows)]
    fn sid_string(sid: windows_sys::Win32::Security::PSID) -> String {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;

        let mut text: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is valid; the text is freed below.
        assert_ne!(
            unsafe { ConvertSidToStringSidW(sid, &mut text) },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        let mut units = 0;
        // SAFETY: ConvertSidToStringSidW NUL-terminates the text.
        while unsafe { *text.add(units) } != 0 {
            units += 1;
        }
        // SAFETY: `units` UTF-16 units precede the terminator.
        let string = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, units) });
        // SAFETY: allocated for this function by ConvertSidToStringSidW.
        unsafe { LocalFree(text as _) };
        string
    }

    /// A kernel object's owner, as `S-1-…`, and its DACL, in SDDL.
    #[cfg(windows)]
    fn owner_and_dacl(handle: std::os::windows::io::RawHandle) -> (String, String) {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
            SE_KERNEL_OBJECT,
        };
        use windows_sys::Win32::Security::{
            DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        };

        let mut owner: PSID = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `handle` is live; the descriptor, which `owner` points
        // into, is freed below.
        let status = unsafe {
            GetSecurityInfo(
                handle as _,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0, "GetSecurityInfo failed with {status}");
        let owner = sid_string(owner);
        let mut text: *mut u16 = std::ptr::null_mut();
        let mut length = 0u32;
        // SAFETY: `descriptor` came from GetSecurityInfo; the text is freed below.
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                &mut length,
            )
        };
        assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
        // SAFETY: `length` UTF-16 units, the terminator included.
        let dacl = String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(text, length.saturating_sub(1) as usize)
        });
        // SAFETY: both were allocated for this function by the calls above.
        unsafe {
            LocalFree(text as _);
            LocalFree(descriptor as _);
        }
        (owner, dacl)
    }

    /// Who owns what this process creates: its token's default owner.
    #[cfg(windows)]
    fn default_owner() -> String {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenOwner, TOKEN_OWNER, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        let mut token = std::ptr::null_mut();
        // SAFETY: the current-process pseudo-handle needs no closing.
        assert_ne!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
            0
        );
        // SAFETY: OpenProcessToken returned a handle this function owns.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut buffer = [0u64; 64];
        let mut length = 0u32;
        // SAFETY: `buffer` holds 512 writable bytes, 8-byte aligned.
        let ok = unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenOwner,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer) as u32,
                &mut length,
            )
        };
        assert_ne!(ok, 0, "{}", std::io::Error::last_os_error());
        // SAFETY: filled with a TOKEN_OWNER whose SID points into `buffer`.
        sid_string(unsafe { (*buffer.as_ptr().cast::<TOKEN_OWNER>()).Owner })
    }

    /// The agent's pipe grants access to its owner and to nobody else, and its
    /// owner is the account the agent runs as.
    #[cfg(windows)]
    #[tokio::test]
    async fn create_secure_pipe_grants_its_owner_alone() {
        use std::os::windows::io::AsRawHandle;

        let pipe_name = format!(
            r"\\.\pipe\lasterm-test-dacl-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let server = create_secure_pipe(&pipe_name, true).expect("create the pipe");

        let (owner, dacl) = owner_and_dacl(server.as_raw_handle());
        // One ACE: allow all file access (what GA maps to on a pipe) to OWNER
        // RIGHTS, and nothing for anyone else.
        assert_eq!(dacl, "D:(A;;FA;;;OW)");
        assert_eq!(owner, default_owner());
    }

    /// The daemon's first instance is created with FILE_FLAG_FIRST_PIPE_INSTANCE:
    /// a name another server already holds is refused, rather than joined as a
    /// further instance of that server's pipe.
    #[cfg(windows)]
    #[tokio::test]
    async fn create_secure_pipe_refuses_a_name_another_server_holds() {
        use tokio::net::windows::named_pipe::ServerOptions;
        use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;

        let pipe_name = format!(
            r"\\.\pipe\lasterm-test-first-{}",
            ulid::Ulid::generate().to_string().to_lowercase()
        );
        let _holder = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .expect("another server takes the name first");

        let error = create_secure_pipe(&pipe_name, true)
            .expect_err("the daemon must not serve as another instance of that pipe");
        assert_eq!(
            error.raw_os_error(),
            Some(ERROR_ACCESS_DENIED as i32),
            "{error}"
        );
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
            None,
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
        /// The key of the hub a test needs only one of.
        const THE_HUB_KEY: &str = "the-hub-key";

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
                    let endpoint = super::socket_path(&format!("lasterm-routing-{label}"))
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
                        None,
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

            /// Connect as `THE_HUB_KEY`'s hub, and read up to
            /// CHANNEL_STATE_END. A connection becomes its hub's current one
            /// before the channels are enumerated, so past this point it is
            /// the one routed to.
            async fn connect(&self) -> Hub {
                self.connect_as(THE_HUB_KEY).await.0
            }

            /// Connect as the hub `hub_key` names, sending AUTH after HELLO as
            /// a hub does. Returns the connection and every frame read up to
            /// CHANNEL_STATE_END, that one included.
            async fn connect_as(&self, hub_key: &str) -> (Hub, Vec<rmpv::Value>) {
                let mut hub = self.open_unauthenticated().await;
                // This daemon has no token: a hub sends an empty one (#127).
                hub.send(&HubToAgent::Auth {
                    token: String::new(),
                    hub_key: hub_key.to_string(),
                })
                .await;
                let state = hub.read_until("CHANNEL_STATE_END").await;
                (hub, state)
            }

            /// Connect and send nothing yet: not even AUTH.
            async fn open_unauthenticated(&self) -> Hub {
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
                super::remove_socket(std::path::Path::new(&self.endpoint));
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
                super::remove_socket(std::path::Path::new(&self.endpoint));
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
                env_mode: "inherit".to_string(),
                env_unset: None,
                login_shell: None,
                report_directory: None,
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
                request_id: None,
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

        /// A snapshot reaches its hub between the output it holds and the
        /// output after it, over a daemon connection as over stdio (#931):
        /// the router puts the reply on the asking connection in pipeline
        /// order. Each round's shell prints a line, waits for one, then prints
        /// another; the test asks for snapshots one answer at a time,
        /// alternating ATTACH and SNAPSHOT_REQ, sends the line once a snapshot
        /// shows the first, and goes on until one shows the second and for
        /// 300 ms more.
        #[tokio::test]
        async fn a_snapshot_reaches_the_hub_between_the_output_it_holds_and_the_output_after_it() {
            let daemon = TestDaemon::start("snapshot-order").await;
            let mut hub = daemon.connect().await;

            for round in 0..10 {
                let channel_id = format!("snapshot-order-{round}");
                let first = format!("snapshot-marker-{round}-a");
                let second = format!("snapshot-marker-{round}-b");
                // Spelt otherwise on the command line: only the output holds
                // the markers.
                let command = if cfg!(windows) {
                    format!(
                        "echo snapshot-mark^er-{round}-a& set /p line=& echo snapshot-mark^er-{round}-b& ping -n 3 127.0.0.1 >nul"
                    )
                } else {
                    format!(
                        "echo snapshot-mark\"\"er-{round}-a; read line; echo snapshot-mark\"\"er-{round}-b; sleep 2"
                    )
                };
                hub.send(&spawn(&channel_id, &command)).await;
                hub.read_through(|frame| is_about(frame, "SPAWN_OK", &channel_id))
                    .await;

                // (is a snapshot, its last_seq or the OUTPUT's seq, its screen or data).
                let mut seen: Vec<(bool, u64, String)> = Vec::new();
                let mut asked: u32 = 0;
                let mut line_sent = false;
                let mut second_shown: Option<std::time::Instant> = None;
                let deadline = std::time::Instant::now() + DEADLINE;
                loop {
                    let ask = if asked.is_multiple_of(2) {
                        HubToAgent::Attach {
                            channel_id: channel_id.clone(),
                            request_id: Some(format!("attach-{round}-{asked}")),
                        }
                    } else {
                        HubToAgent::SnapshotReq {
                            channel_id: channel_id.clone(),
                        }
                    };
                    hub.send(&ask).await;
                    asked += 1;
                    // Read up to its answer, keeping the channel's output.
                    loop {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "{channel_id}: no snapshot showed {second:?} within {DEADLINE:?}"
                        );
                        let Some(frame) = hub.frame_within(DEADLINE).await else {
                            panic!("{channel_id}: no answer came");
                        };
                        if frame["channel_id"].as_str() != Some(channel_id.as_str()) {
                            continue;
                        }
                        match frame_type(&frame) {
                            "OUTPUT" => {
                                let rmpv::Value::Binary(data) = &frame["data"] else {
                                    panic!("OUTPUT without data");
                                };
                                seen.push((
                                    false,
                                    frame["seq"].as_u64().expect("OUTPUT seq"),
                                    String::from_utf8_lossy(data).into_owned(),
                                ));
                            }
                            "ATTACH_OK" | "SNAPSHOT_RES" => {
                                let screen = frame["snapshot"]["serialized"]
                                    .as_str()
                                    .expect("snapshot text")
                                    .to_string();
                                seen.push((
                                    true,
                                    frame["last_seq"].as_u64().expect("last_seq"),
                                    screen,
                                ));
                                break;
                            }
                            "CHANNEL_EXIT" => {
                                panic!("{channel_id} ended before the test was done")
                            }
                            _ => {}
                        }
                    }
                    let screen = &seen.last().expect("the answer was kept").2;
                    if !line_sent && screen.contains(&first) {
                        let line: &[u8] = if cfg!(windows) { b"go\r" } else { b"go\n" };
                        hub.send(&HubToAgent::Input {
                            channel_id: channel_id.clone(),
                            data: line.to_vec(),
                        })
                        .await;
                        line_sent = true;
                    }
                    if second_shown.is_none() && screen.contains(&second) {
                        second_shown = Some(std::time::Instant::now());
                    }
                    if second_shown.is_some_and(|at| at.elapsed() > Duration::from_millis(300)) {
                        break;
                    }
                }
                hub.send(&HubToAgent::Destroy {
                    channel_id: channel_id.clone(),
                })
                .await;

                let first_snapshot = seen
                    .iter()
                    .position(|(snapshot, ..)| *snapshot)
                    .expect("a snapshot came");
                assert!(
                    seen[first_snapshot..]
                        .iter()
                        .any(|(snapshot, ..)| !*snapshot),
                    "{channel_id}: no OUTPUT came after a snapshot"
                );
                for (at, (snapshot, last_seq, screen)) in seen.iter().enumerate() {
                    if !*snapshot {
                        continue;
                    }
                    let before: String = seen[..at]
                        .iter()
                        .filter(|(snapshot, ..)| !*snapshot)
                        .map(|(_, _, data)| data.as_str())
                        .collect();
                    for marker in [&first, &second] {
                        assert!(
                            !screen.contains(marker.as_str()) || before.contains(marker.as_str()),
                            "{channel_id}: a snapshot showed {marker:?} before the OUTPUT that printed it"
                        );
                    }
                    for (seq_at, (other, seq, _)) in seen.iter().enumerate() {
                        if *other {
                            continue;
                        }
                        if seq_at < at {
                            assert!(
                                seq <= last_seq,
                                "{channel_id}: OUTPUT {seq} came before a snapshot whose last_seq is {last_seq}"
                            );
                        } else {
                            assert!(
                                seq > last_seq,
                                "{channel_id}: OUTPUT {seq} came after a snapshot whose last_seq is {last_seq}"
                            );
                        }
                    }
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
                    env_mode: "inherit".to_string(),
                    env_unset: None,
                    login_shell: None,
                    report_directory: None,
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

            /// Wait for a file a shell creates once it has done what the test
            /// waits for.
            async fn until_created(path: &std::path::Path) {
                let deadline = tokio::time::Instant::now() + DEADLINE;
                while !path.exists() {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "{} was not created within {DEADLINE:?}",
                        path.display()
                    );
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }

            /// Wait until the daemon holds no terminal for a hub other than
            /// KEY_B, as KEY_B's CHANNEL_STATE_END counts them: a terminal that
            /// ended is no longer held once the daemon has seen it end.
            async fn until_other_hubs_hold_none(daemon: &TestDaemon) {
                let deadline = tokio::time::Instant::now() + DEADLINE;
                loop {
                    let (probe, frames) = daemon.connect_as(KEY_B).await;
                    drop(probe);
                    let (_, others) = state(&frames);
                    if others == 0 {
                        return;
                    }
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "other hubs still held {others} terminals after {DEADLINE:?}"
                    );
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }

            /// Each hub gets its own terminals' output and state, and nothing
            /// of another hub's. All output used to go to whichever hub had
            /// connected last, and the state listed every channel.
            #[tokio::test]
            async fn each_hub_gets_its_own_terminals_and_nothing_of_another_hubs() {
                let daemon = TestDaemon::start("own").await;
                let (mut a, mut seen_by_a) = daemon.connect_as(KEY_A).await;
                let (mut b, mut seen_by_b) = daemon.connect_as(KEY_B).await;

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
                let (_a2, a2_state) = daemon.connect_as(KEY_A).await;
                assert_eq!(state(&a2_state), (vec!["own-ch-a".to_string()], 1));
                let (_b2, b2_state) = daemon.connect_as(KEY_B).await;
                assert_eq!(state(&b2_state), (vec!["own-ch-b".to_string()], 1));

                daemon.stop().await;
            }

            /// A hub that goes away costs another hub nothing: it keeps
            /// typing and reading, with nothing lost, and the terminal of the
            /// hub that left keeps running for it.
            #[tokio::test]
            async fn a_hub_that_leaves_costs_another_hub_nothing() {
                let daemon = TestDaemon::start("leaves").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                let (mut b, _) = daemon.connect_as(KEY_B).await;
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

                let (mut a2, a2_state) = daemon.connect_as(KEY_A).await;
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
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                let (mut b, mut seen_by_b) = daemon.connect_as(KEY_B).await;
                // Waits for a line, prints a second later, marks that it has in
                // its working directory, then waits again.
                let command = if cfg!(windows) {
                    "set /p line=& ping -n 2 127.0.0.1 >nul & echo printed-while-^away& type nul > printed & set /p done="
                } else {
                    r#"read line; sleep 1; echo "printed-while-""away"; : > printed; read done"#
                };
                let mut spawn_in_state_dir = spawn("back-ch-a", command);
                if let HubToAgent::Spawn { cwd, .. } = &mut spawn_in_state_dir {
                    *cwd = Some(daemon.state_dir.to_string_lossy().into_owned());
                }
                spawned(&mut a, spawn_in_state_dir).await;
                let go: &[u8] = if cfg!(windows) { b"go\r" } else { b"go\n" };
                a.send(&input("back-ch-a", go.to_vec())).await;
                drop(a);
                // A fixed wait lost to a slow shell under load (#570).
                until_created(&daemon.state_dir.join("printed")).await;

                let (mut a2, mut seen_by_a2) = daemon.connect_as(KEY_A).await;
                assert_eq!(state(&seen_by_a2), (vec!["back-ch-a".to_string()], 0));
                a2.send(&HubToAgent::Attach {
                    channel_id: "back-ch-a".to_string(),
                    request_id: None,
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
                // The shell had printed when it made its mark, but the daemon may
                // read that from the terminal only after the snapshot: it then
                // arrives as OUTPUT.
                if !snapshot.contains("printed-while-away") {
                    let deadline = tokio::time::Instant::now() + DEADLINE;
                    while !output_of(&seen_by_a2, "back-ch-a").contains("printed-while-away") {
                        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                        let Some(frame) = a2.frame_within(left).await else {
                            panic!("what the terminal printed while its hub was away is lost");
                        };
                        seen_by_a2.push(frame);
                    }
                }

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
                let (mut ghost, _) = daemon.connect_as(KEY_A).await;
                let (mut b, mut seen_by_b) = daemon.connect_as(KEY_B).await;
                spawned(&mut ghost, interactive("ghost-ch-a")).await;
                seen_by_b.extend(spawned(&mut b, interactive("ghost-ch-b")).await);

                let (mut a2, a2_state) = daemon.connect_as(KEY_A).await;
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
                let (mut a, mut seen_by_a) = daemon.connect_as(KEY_A).await;
                seen_by_a.extend(spawned(&mut a, interactive(HELD)).await);
                let (mut b, _) = daemon.connect_as(KEY_B).await;

                type Request = fn(&str) -> HubToAgent;
                let requests: [(&str, Request); 5] = [
                    ("INPUT", |id| input(id, prints("typed-by-b"))),
                    ("RESIZE", |id| HubToAgent::Resize {
                        channel_id: id.to_string(),
                        cols: 100,
                        rows: 40,
                    }),
                    // Named, as a hub names it: the id echoed tells nothing
                    // apart either (#767).
                    ("ATTACH", |id| HubToAgent::Attach {
                        channel_id: id.to_string(),
                        request_id: Some("attach-request".to_string()),
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
            ///
            /// Its reader holds the exit a while, its workload's status in
            /// hand: a reconnection in that window used to find the id free
            /// and get its SPAWN_OK before the exit (#1089).
            #[tokio::test]
            async fn an_exit_while_its_hub_was_away_reaches_it_before_any_reply() {
                crate::pty::delay_exit_of("flush-restarted", Duration::from_millis(300));
                let daemon = TestDaemon::start("flush").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
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
                // A fixed wait lost to a slow shell under load: the restart
                // then met the old shell still running (#570).
                until_other_hubs_hold_none(&daemon).await;

                let (mut a2, mut seen) = daemon.connect_as(KEY_A).await;
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

            /// A restart of a terminal whose program has just ended, its exit
            /// not sent yet, starts: the replacement took its id, so that exit
            /// is never sent, and none arrives after the replacement's
            /// SPAWN_OK to mark it dead (#1089, #1113).
            #[tokio::test]
            async fn a_restart_while_an_exit_is_held_starts_and_gets_no_late_exit() {
                crate::pty::delay_exit_of("held-restarted", Duration::from_millis(1500));
                let daemon = TestDaemon::start("held-restart").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, spawn("held-restarted", "exit 5")).await;
                // Its PTY closed. Its reader takes its workload back right
                // after, then holds the exit.
                a.read_through(|frame| is_about(frame, "LOG", "held-restarted"))
                    .await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "held-restarted".to_string(),
                })
                .await;
                spawned(&mut a, interactive("held-restarted")).await;
                let later = a.frames_until_quiet(Duration::from_millis(2000)).await;
                assert!(
                    !mentions(&later, "held-restarted").contains(&"CHANNEL_EXIT".to_string()),
                    "an exit after the SPAWN_OK marks the restarted terminal dead"
                );

                daemon.stop().await;
            }

            /// While its exit is not sent, an ended terminal is still there:
            /// its hub, connecting again, is told so and then gets its exit,
            /// and a SPAWN reusing its id is refused (#1089).
            #[tokio::test]
            async fn an_ended_terminal_keeps_its_id_until_its_exit_is_sent() {
                crate::pty::delay_exit_of("held-id", Duration::from_millis(1500));
                let daemon = TestDaemon::start("held-id").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, spawn("held-id", "exit 5")).await;
                a.read_through(|frame| is_about(frame, "LOG", "held-id"))
                    .await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                let (mut a2, listed) = daemon.connect_as(KEY_A).await;
                assert!(
                    listed
                        .iter()
                        .any(|frame| is_about(frame, "AGENT_CHANNEL_STATE", "held-id")
                            && frame["alive"].as_bool() == Some(true)),
                    "the ended terminal is not listed; received {:?}",
                    listed.iter().map(frame_type).collect::<Vec<_>>()
                );
                a2.send(&interactive("held-id")).await;
                let answer = a2
                    .read_through(|frame| {
                        frame["request_id"].as_str() == Some("request-held-id")
                            || is_about(frame, "CHANNEL_EXIT", "held-id")
                    })
                    .await;
                assert_eq!(
                    answer.last().map(frame_type),
                    Some("SPAWN_ERR"),
                    "{:?}",
                    answer.iter().map(frame_type).collect::<Vec<_>>()
                );
                let exit = a2
                    .read_through(|frame| is_about(frame, "CHANNEL_EXIT", "held-id"))
                    .await;
                assert_eq!(exit.last().unwrap()["exit_code"].as_i64(), Some(5));

                daemon.stop().await;
            }

            /// Another hub's ended terminal, its exit not sent yet, still
            /// counts among the terminals other hubs hold (#1089).
            #[tokio::test]
            async fn an_ended_terminal_counts_for_other_hubs_until_its_exit_is_sent() {
                crate::pty::delay_exit_of("held-count", Duration::from_millis(1500));
                let daemon = TestDaemon::start("held-count").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, spawn("held-count", "exit 5")).await;
                a.read_through(|frame| is_about(frame, "LOG", "held-count"))
                    .await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                let (_b, frames) = daemon.connect_as(KEY_B).await;
                assert_eq!(state(&frames).1, 1);

                daemon.stop().await;
            }

            /// A SPAWN reusing the id of a terminal whose exit is on its way
            /// waits for it: the exit comes before its SPAWN_OK (#1089).
            #[tokio::test]
            async fn a_spawn_waits_for_an_exit_on_its_way() {
                crate::pty::delay_route_of("routed-id", Duration::from_millis(800));
                let daemon = TestDaemon::start("routed-id").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, spawn("routed-id", "exit 5")).await;
                a.read_through(|frame| is_about(frame, "LOG", "routed-id"))
                    .await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                let frames = spawned(&mut a, interactive("routed-id")).await;
                assert!(
                    frames
                        .iter()
                        .any(|frame| is_about(frame, "CHANNEL_EXIT", "routed-id")),
                    "the exit must come before the SPAWN_OK; received {:?}",
                    frames.iter().map(frame_type).collect::<Vec<_>>()
                );

                daemon.stop().await;
            }

            /// A live terminal restarted: DESTROY, then SPAWN under its id.
            /// The exit of the shell it destroyed, sent before the SPAWN, comes
            /// before the SPAWN_OK, never after it, where it would mark the new
            /// run dead (#1113).
            #[tokio::test]
            async fn a_live_restart_gets_the_destroyed_shells_exit_before_its_spawn_ok() {
                let daemon = TestDaemon::start("live-restart").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("live-restarted")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;
                crate::pty::hold_routes_of("live-restarted", Duration::from_millis(1500));

                a.send(&HubToAgent::Destroy {
                    channel_id: "live-restarted".to_string(),
                })
                .await;
                // Its shell ends: its reader has seen its PTY close, and sends
                // its exit, before the SPAWN is sent.
                crate::pty::receipt("live-restarted", "exit-enqueued", 1).await;
                let answered = spawned(&mut a, interactive("live-restarted")).await;
                assert!(
                    mentions(&answered, "live-restarted").contains(&"CHANNEL_EXIT".to_string()),
                    "the destroyed shell's exit must come before the SPAWN_OK; received {:?}",
                    answered.iter().map(frame_type).collect::<Vec<_>>()
                );
                let later = a.frames_until_quiet(Duration::from_millis(4000)).await;
                assert!(
                    !mentions(&later, "live-restarted").contains(&"CHANNEL_EXIT".to_string()),
                    "an exit after the SPAWN_OK marks the restarted terminal dead"
                );

                daemon.stop().await;
            }

            /// A live restart whose SPAWN comes before the destroyed shell's
            /// reader sends its exit: that reader sends none, which would come
            /// after the SPAWN_OK and mark the new run dead (#1113).
            #[tokio::test]
            async fn a_live_restart_answered_first_gets_no_exit_of_the_destroyed_shell() {
                crate::pty::delay_torn_down_of("restart-first", Duration::from_millis(1500));
                let daemon = TestDaemon::start("restart-first").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("restart-first")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "restart-first".to_string(),
                })
                .await;
                // Its reader has seen its PTY close, and waits.
                crate::pty::receipt("restart-first", "torn-down", 1).await;
                spawned(&mut a, interactive("restart-first")).await;
                let later = a.frames_until_quiet(Duration::from_millis(3000)).await;
                assert!(
                    !mentions(&later, "restart-first").contains(&"CHANNEL_EXIT".to_string()),
                    "an exit after the SPAWN_OK marks the restarted terminal dead"
                );

                daemon.stop().await;
            }

            /// A live restart while what the destroyed shell's reader read
            /// before its DESTROY is still on its way: none of it comes after
            /// the SPAWN_OK, where the hub would show it in the new terminal,
            /// and the new run is heard from its SPAWN_OK on, not before it
            /// (#1121).
            #[tokio::test]
            async fn a_live_restart_gets_none_of_the_replaced_shells_output_after_its_spawn_ok() {
                crate::pty::delay_torn_down_of("stale-output", Duration::from_millis(3000));
                crate::pty::watch_output_of("stale-output", "OLDMARK1121");
                let daemon = TestDaemon::start("stale-output").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("stale-output")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;
                crate::pty::hold_routes_of("stale-output", Duration::from_millis(1000));

                a.send(&input("stale-output", prints("OLDMARK1121"))).await;
                // Its reader has queued that output; the router holds it.
                crate::pty::receipt("stale-output", "output:OLDMARK1121", 1).await;
                a.send(&HubToAgent::Destroy {
                    channel_id: "stale-output".to_string(),
                })
                .await;
                // The new run starts elsewhere: its first CWD_CHANGE is its own.
                let new_dir = temp_dir("stale-output-new").await;
                let new_dir_name = new_dir.file_name().unwrap().to_string_lossy().into_owned();
                let mut restart = interactive("stale-output");
                if let HubToAgent::Spawn { cwd, .. } = &mut restart {
                    *cwd = Some(new_dir.to_string_lossy().into_owned());
                }
                let answered = spawned(&mut a, restart).await;
                assert!(
                    !answered
                        .iter()
                        .any(|frame| is_about(frame, "CWD_CHANGE", "stale-output")
                            && frame["cwd"]
                                .as_str()
                                .is_some_and(|cwd| cwd.contains(&new_dir_name))),
                    "the new run was heard before its SPAWN_OK: {:?}",
                    answered.iter().map(frame_type).collect::<Vec<_>>()
                );

                let mut later = print(&mut a, "stale-output", "NEWMARK1121").await;
                later.extend(a.frames_until_quiet(Duration::from_millis(1500)).await);
                assert!(
                    !output_of(&later, "stale-output").contains("OLDMARK1121"),
                    "the replaced shell's output came after the SPAWN_OK"
                );
                assert!(
                    !later
                        .iter()
                        .any(|frame| is_about(frame, "LOG", "stale-output")
                            && frame["msg"].as_str() == Some("PTY closed")),
                    "the replaced shell's LOG came after the SPAWN_OK"
                );

                daemon.stop().await;
            }

            /// A live restart whose destroyed shell's reader handles its PTY's
            /// end only after the replacement's SPAWN_OK: it says nothing then,
            /// its exit aside, which the replacement took over (#1121).
            #[tokio::test]
            async fn a_live_restart_gets_nothing_the_replaced_shells_reader_sends_after_the_destroy(
            ) {
                crate::pty::hold_pty_end_of("after-destroy");
                let daemon = TestDaemon::start("after-destroy").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("after-destroy")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "after-destroy".to_string(),
                })
                .await;
                // Its reader is at its PTY's end, held there.
                crate::pty::receipt("after-destroy", "pty-end", 1).await;
                spawned(&mut a, interactive("after-destroy")).await;
                crate::pty::release_pty_end_of("after-destroy");

                let later = a.frames_until_quiet(Duration::from_millis(3000)).await;
                assert!(
                    !later
                        .iter()
                        .any(|frame| is_about(frame, "LOG", "after-destroy")
                            && frame["msg"].as_str() == Some("PTY closed")),
                    "the replaced shell's reader spoke after the SPAWN_OK: {:?}",
                    later.iter().map(frame_type).collect::<Vec<_>>()
                );

                daemon.stop().await;
            }

            /// A SPAWN of a new id while another terminal's frames are held on
            /// their way, that terminal destroyed and its exit still owed: it is
            /// answered at once, not after them (#1121).
            #[tokio::test]
            async fn a_spawn_of_another_id_is_answered_at_once() {
                crate::pty::delay_torn_down_of("busy-other", Duration::from_millis(3000));
                crate::pty::watch_output_of("busy-other", "BUSYMARK1121");
                let daemon = TestDaemon::start("busy-other").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("busy-other")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;
                crate::pty::hold_routes_of("busy-other", Duration::from_millis(2000));

                a.send(&input("busy-other", prints("BUSYMARK1121"))).await;
                crate::pty::receipt("busy-other", "output:BUSYMARK1121", 1).await;
                a.send(&HubToAgent::Destroy {
                    channel_id: "busy-other".to_string(),
                })
                .await;
                crate::pty::receipt("busy-other", "torn-down", 1).await;
                let early = a.frames_until_quiet(Duration::from_millis(100)).await;
                assert!(
                    !output_of(&early, "busy-other").contains("BUSYMARK1121"),
                    "the other terminal's output must still be held"
                );

                let asked = std::time::Instant::now();
                let answered = spawned(&mut a, interactive("fresh-id")).await;
                let waited = asked.elapsed();
                assert!(
                    waited < Duration::from_millis(500),
                    "a SPAWN of another id waited {waited:?}"
                );
                assert!(
                    !output_of(&answered, "busy-other").contains("BUSYMARK1121"),
                    "the other terminal's output was still to be held"
                );

                daemon.stop().await;
            }

            /// A live restart whose new run ends at once, before the destroyed
            /// shell's reader sends its exit: the hub gets the new run's exit,
            /// and that one only (#1113).
            #[tokio::test]
            async fn a_restarted_run_that_ends_at_once_gets_its_own_exit_only() {
                crate::pty::delay_torn_down_of("restart-ends", Duration::from_millis(1500));
                let daemon = TestDaemon::start("restart-ends").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("restart-ends")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "restart-ends".to_string(),
                })
                .await;
                crate::pty::receipt("restart-ends", "torn-down", 1).await;
                spawned(&mut a, spawn("restart-ends", "exit 5")).await;
                let later = a.frames_until_quiet(Duration::from_millis(3000)).await;
                let exits: Vec<Option<i64>> = later
                    .iter()
                    .filter(|frame| is_about(frame, "CHANNEL_EXIT", "restart-ends"))
                    .map(|frame| frame["exit_code"].as_i64())
                    .collect();
                assert_eq!(exits, vec![Some(5)]);

                daemon.stop().await;
            }

            /// A SPAWN under `channel_id` whose shell does not exist: refused
            /// before any PTY is created, as a restart that fails to start is.
            fn unstartable(channel_id: &str) -> HubToAgent {
                let shell = if cfg!(windows) {
                    r"C:\lasterm-test\no-such-shell.exe"
                } else {
                    "/lasterm-test/no-such-shell"
                };
                HubToAgent::Spawn {
                    request_id: format!("refused-{channel_id}"),
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
                    env_mode: "inherit".to_string(),
                    env_unset: None,
                    login_shell: None,
                    report_directory: None,
                }
            }

            /// Send `unstartable(channel_id)`, and read through its SPAWN_ERR.
            async fn refused(hub: &mut Hub, channel_id: &str) -> Vec<rmpv::Value> {
                hub.send(&unstartable(channel_id)).await;
                let request_id = format!("refused-{channel_id}");
                let frames = hub
                    .read_through(|frame| frame["request_id"].as_str() == Some(&request_id))
                    .await;
                assert_eq!(
                    frames.last().map(frame_type),
                    Some("SPAWN_ERR"),
                    "{:?}",
                    frames.iter().map(frame_type).collect::<Vec<_>>()
                );
                frames
            }

            /// A live restart whose SPAWN is refused before it creates a PTY:
            /// the destroyed shell's exit still comes, the end of the terminal
            /// its hub records when the restart fails (#1113).
            #[tokio::test]
            async fn a_restart_that_fails_to_start_still_gets_the_destroyed_shells_exit() {
                crate::pty::delay_torn_down_of("restart-refused", Duration::from_millis(1500));
                let daemon = TestDaemon::start("restart-refused").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("restart-refused")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "restart-refused".to_string(),
                })
                .await;
                // Its reader has seen its PTY close, and waits.
                crate::pty::receipt("restart-refused", "torn-down", 1).await;
                let mut seen = refused(&mut a, "restart-refused").await;
                seen.extend(a.frames_until_quiet(Duration::from_millis(3000)).await);
                let exits = seen
                    .iter()
                    .filter(|frame| is_about(frame, "CHANNEL_EXIT", "restart-refused"))
                    .count();
                assert_eq!(exits, 1, "the destroyed shell's exit must still come");

                daemon.stop().await;
            }

            /// A first restart's SPAWN succeeds while the destroyed shell's
            /// reader is delayed; that replacement is destroyed in turn, and a
            /// second SPAWN of the id is refused before it creates a PTY. The
            /// replacement's exit still comes, the end of the terminal, and
            /// the late first reader sends none (#1113).
            #[tokio::test]
            async fn a_late_reader_does_not_take_the_record_of_the_run_destroyed_after_it() {
                crate::pty::delay_torn_down_of("late-reader", Duration::from_millis(3000));
                let daemon = TestDaemon::start("late-reader").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("late-reader")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "late-reader".to_string(),
                })
                .await;
                // The first reader has seen its PTY close, and waits 3 s from here.
                crate::pty::receipt("late-reader", "torn-down", 1).await;
                let first_closed = std::time::Instant::now();
                spawned(&mut a, interactive("late-reader")).await;
                // The replacement's reader then wakes 1.5 s or more after the
                // first: an exit tells by its time which reader sent it, both
                // runs having ended the same way.
                tokio::time::sleep(Duration::from_millis(1500)).await;
                a.send(&HubToAgent::Destroy {
                    channel_id: "late-reader".to_string(),
                })
                .await;
                // The replacement's reader has seen its PTY close too.
                crate::pty::receipt("late-reader", "torn-down", 2).await;
                let mut first_window = refused(&mut a, "late-reader").await;
                let first_woke = first_closed + Duration::from_millis(3750);
                while let Some(limit) = first_woke.checked_duration_since(std::time::Instant::now())
                {
                    match a.frame_within(limit).await {
                        Some(frame) => first_window.push(frame),
                        None => break,
                    }
                }
                assert!(
                    !mentions(&first_window, "late-reader").contains(&"CHANNEL_EXIT".to_string()),
                    "the late first reader sent an exit"
                );
                let later = a.frames_until_quiet(Duration::from_millis(5000)).await;
                let exits = later
                    .iter()
                    .filter(|frame| is_about(frame, "CHANNEL_EXIT", "late-reader"))
                    .count();
                assert_eq!(exits, 1, "the replacement's exit must come");

                daemon.stop().await;
            }

            /// A terminal whose program ended, its exit not sent yet, is
            /// restarted, and the restart's SPAWN is refused before it creates
            /// a PTY: the program's exit still comes, the end of the terminal,
            /// with its own code and without the screen it drew, as any torn
            /// down workload's (#933, #1113).
            #[tokio::test]
            async fn a_refused_restart_of_an_ended_terminal_still_gets_its_exit() {
                crate::pty::delay_exit_of("ended-refused", Duration::from_millis(1500));
                let daemon = TestDaemon::start("ended-refused").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                let command = if cfg!(windows) {
                    "echo drawn& exit 5"
                } else {
                    "echo drawn; exit 5"
                };
                spawned(&mut a, spawn("ended-refused", command)).await;
                // Its PTY closed. Its reader takes its workload back right
                // after, then holds the exit.
                a.read_through(|frame| is_about(frame, "LOG", "ended-refused"))
                    .await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "ended-refused".to_string(),
                })
                .await;
                let mut seen = refused(&mut a, "ended-refused").await;
                seen.extend(a.frames_until_quiet(Duration::from_millis(3000)).await);
                let exits: Vec<&rmpv::Value> = seen
                    .iter()
                    .filter(|frame| is_about(frame, "CHANNEL_EXIT", "ended-refused"))
                    .collect();
                assert_eq!(exits.len(), 1, "the program's exit must still come");
                assert_eq!(exits[0]["exit_code"].as_i64(), Some(5));
                assert!(
                    exits[0]["screen"].is_nil(),
                    "a destroyed terminal's exit carries no screen: {}",
                    exits[0]
                );

                daemon.stop().await;
            }

            /// A terminal its hub destroyed, its exit on its way: the hub
            /// connecting again is not told it is still there. It let it go
            /// (#1113).
            #[tokio::test]
            async fn a_destroyed_terminals_exit_on_its_way_is_not_listed() {
                crate::pty::delay_route_of("torn-listed", Duration::from_millis(1500));
                let daemon = TestDaemon::start("torn-listed").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("torn-listed")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "torn-listed".to_string(),
                })
                .await;
                // Its reader has seen its PTY close, and sent its exit, which
                // the router holds.
                crate::pty::receipt("torn-listed", "exit-enqueued", 1).await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                let (_a2, listed) = daemon.connect_as(KEY_A).await;
                assert_eq!(state(&listed), (vec![], 0));

                daemon.stop().await;
            }

            /// Another hub's terminal destroyed, its exit on its way, counts
            /// for no other hub: a STOP is not refused for it (#1113).
            #[tokio::test]
            async fn a_destroyed_terminals_exit_on_its_way_counts_for_no_other_hub() {
                crate::pty::delay_route_of("torn-count", Duration::from_millis(1500));
                let daemon = TestDaemon::start("torn-count").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("torn-count")).await;
                a.frames_until_quiet(Duration::from_millis(300)).await;

                a.send(&HubToAgent::Destroy {
                    channel_id: "torn-count".to_string(),
                })
                .await;
                crate::pty::receipt("torn-count", "exit-enqueued", 1).await;
                tokio::time::sleep(Duration::from_millis(300)).await;

                let (_b, frames) = daemon.connect_as(KEY_B).await;
                assert_eq!(state(&frames).1, 0);

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
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                let (mut b, _) = daemon.connect_as(KEY_B).await;
                spawned(&mut b, interactive("stop-ch-b")).await;

                a.send(&stop(false)).await;
                let frames = a.read_until("ERROR").await;
                let refusal = frames.last().unwrap();
                assert_eq!(refusal["code"].as_str(), Some("OTHER_HUBS_HOLD_CHANNELS"));
                assert_eq!(refusal["other_owner_channels"].as_u64(), Some(1));
                let message = refusal["message"].as_str().unwrap_or("");
                assert!(message.starts_with("1 "), "{message:?}");
                // A refusal is not an acceptance (#700).
                let quiet = a.frames_until_quiet(Duration::from_millis(300)).await;
                let types: Vec<&str> = frames.iter().chain(&quiet).map(frame_type).collect();
                assert!(!types.contains(&"STOP_ACCEPTED"), "{types:?}");
                assert!(
                    !daemon.task.is_finished(),
                    "a refused STOP stopped the daemon"
                );
                print(&mut b, "stop-ch-b", "still-here").await;

                a.send(&stop(true)).await;
                // A forced STOP is accepted, said before the connection ends.
                let frames = a.frames_until_closed().await;
                let types: Vec<&str> = frames.iter().map(frame_type).collect();
                assert!(types.contains(&"STOP_ACCEPTED"), "{types:?}");
                let summary = daemon.finished().await.expect("a clean stop");
                assert_eq!(summary.confirmed_shell_exits, 1);
            }

            /// STOP from the hub that holds every terminal stops the daemon,
            /// on the path a signal takes: terminals torn down, connection
            /// closed.
            #[tokio::test]
            async fn stop_ends_a_daemon_whose_terminals_are_all_its_callers() {
                let daemon = TestDaemon::start("stop-own").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("stop-ch-a")).await;

                a.send(&stop(false)).await;
                let frames = a.frames_until_closed().await;
                assert_eq!(errors(&frames), Vec::<String>::new());
                // Said before the end of stream (#700).
                let types: Vec<&str> = frames.iter().map(frame_type).collect();
                assert!(types.contains(&"STOP_ACCEPTED"), "{types:?}");
                let summary = daemon.finished().await.expect("a clean stop");
                assert_eq!(summary.confirmed_shell_exits, 1);
            }

            /// A terminal printing without end, for a hub that stops reading:
            /// its connection's writer is then blocked on the transport.
            fn flood(channel_id: &str) -> HubToAgent {
                spawn(
                    channel_id,
                    if cfg!(windows) {
                        "for /l %i in (0,0,1) do @echo yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
                    } else {
                        "yes yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
                    },
                )
            }

            /// The daemon process's own shutdown path waits for a writer its
            /// hub does not read: `run_daemon_impl` has not returned while
            /// that writer is held, and once the hub reads, STOP_ACCEPTED is
            /// there, whole (#700).
            #[tokio::test]
            async fn the_daemon_does_not_end_while_a_writer_it_owes_is_held() {
                let daemon = TestDaemon::start("held-writer").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, flood("held-flood")).await;
                // Not read from here on: the transport fills, then the writer blocks.
                tokio::time::sleep(Duration::from_secs(2)).await;
                a.send(&stop(true)).await;
                tokio::time::sleep(Duration::from_millis(500)).await;
                assert!(
                    !daemon.task.is_finished(),
                    "the daemon ended with its writer still held"
                );
                let frames = a.frames_until_closed().await;
                let types: Vec<&str> = frames.iter().map(frame_type).collect();
                assert!(types.contains(&"STOP_ACCEPTED"), "no STOP_ACCEPTED");
                daemon.finished().await.expect("a clean stop");
            }

            /// Two hubs: the first reads, so its writer is done at once; the
            /// second does not, so its writer is held until it reads again,
            /// within the bound. `run_daemon_impl` waits for the second, not
            /// only the first, and that hub reads STOP_ACCEPTED whole (#700).
            #[tokio::test]
            async fn the_daemon_waits_for_every_writer_it_owes_not_only_the_first() {
                let daemon = TestDaemon::start("every-writer").await;
                let (mut quick, _) = daemon.connect_as(KEY_A).await;
                let (mut held, _) = daemon.connect_as(KEY_B).await;
                spawned(&mut held, flood("every-writer-flood")).await;
                // Not read from here on: the transport fills, then the writer blocks.
                tokio::time::sleep(Duration::from_secs(2)).await;
                held.send(&stop(true)).await;
                // Read to its end: this writer is done while the other is held.
                quick.frames_until_closed().await;
                tokio::time::sleep(Duration::from_millis(500)).await;
                assert!(
                    !daemon.task.is_finished(),
                    "the daemon ended after the first writer only"
                );
                let frames = held.frames_until_closed().await;
                let types: Vec<&str> = frames.iter().map(frame_type).collect();
                assert!(types.contains(&"STOP_ACCEPTED"), "no STOP_ACCEPTED");
                daemon.finished().await.expect("a clean stop");
            }

            /// Two hubs that never read: the daemon ends once, after one bound
            /// of about two seconds for both, not one each (#700).
            #[tokio::test]
            async fn the_daemon_ends_after_one_bound_for_writers_never_read() {
                let daemon = TestDaemon::start("held-writers").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, flood("held-flood-a")).await;
                let (mut b, _) = daemon.connect_as(KEY_B).await;
                spawned(&mut b, flood("held-flood-b")).await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                a.send(&stop(true)).await;
                let started = std::time::Instant::now();
                let summary = tokio::time::timeout(Duration::from_secs(20), daemon.finished())
                    .await
                    .expect("the daemon ends")
                    .expect("a clean stop");
                let took = started.elapsed();
                assert_eq!(summary.confirmed_shell_exits + summary.unresolved.len(), 2);
                assert!(took >= Duration::from_millis(1900), "{took:?}");
                assert!(
                    took < Duration::from_millis(3900),
                    "a bound per writer: {took:?}"
                );
                drop((a, b));
            }

            /// Another hub connected but holding nothing does not keep the
            /// daemon: only terminals refuse a STOP without force. A hub
            /// replacing an agent older than itself relies on it (#805): the
            /// other hub's connection closes too, and it dials again.
            #[tokio::test]
            async fn stop_without_force_ends_a_daemon_another_hub_merely_connects_to() {
                let daemon = TestDaemon::start("stop-idle-other").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                let (mut b, _) = daemon.connect_as(KEY_B).await;

                a.send(&stop(false)).await;
                let frames = a.frames_until_closed().await;
                assert_eq!(errors(&frames), Vec::<String>::new());
                let seen_by_b = b.frames_until_closed().await;
                assert_eq!(errors(&seen_by_b), Vec::<String>::new());
                let summary = daemon.finished().await.expect("a clean stop");
                assert_eq!(summary.confirmed_shell_exits, 0);
                assert!(summary.unresolved.is_empty());
            }

            /// A connection that opens with a request rather than AUTH, on a
            /// daemon without a token, is refused: told why, closed, and shown
            /// nothing of the channels there. The hub holding them goes on.
            #[tokio::test]
            async fn a_connection_that_does_not_open_with_auth_is_refused() {
                let daemon = TestDaemon::start("no-auth").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("no-auth-held")).await;

                let mut stranger = daemon.open_unauthenticated().await;
                stranger
                    .send(&HubToAgent::Attach {
                        channel_id: "no-auth-held".to_string(),
                        request_id: None,
                    })
                    .await;
                let frames = stranger.frames_until_closed().await;
                let types: Vec<&str> = frames.iter().map(frame_type).collect();
                assert_eq!(types, ["HELLO", "ERROR"], "{frames:?}");
                assert_eq!(errors(&frames), ["AUTH_REQUIRED"]);
                assert_eq!(mentions(&frames, "no-auth-held"), Vec::<String>::new());

                let seen_by_a = print(&mut a, "no-auth-held", "still-held").await;
                assert_eq!(errors(&seen_by_a), Vec::<String>::new());

                daemon.stop().await;
            }

            /// CHANNEL_STATE_END counts the channels every other hub holds.
            #[tokio::test]
            async fn channel_state_end_counts_the_channels_other_hubs_hold() {
                let daemon = TestDaemon::start("count").await;
                let (mut a, _) = daemon.connect_as(KEY_A).await;
                spawned(&mut a, interactive("count-a-1")).await;
                spawned(&mut a, interactive("count-a-2")).await;
                let (mut b, _) = daemon.connect_as(KEY_B).await;
                spawned(&mut b, interactive("count-b-1")).await;

                let (_a2, a_state) = daemon.connect_as(KEY_A).await;
                assert_eq!(
                    state(&a_state),
                    (vec!["count-a-1".to_string(), "count-a-2".to_string()], 1)
                );
                let (_b2, b_state) = daemon.connect_as(KEY_B).await;
                assert_eq!(state(&b_state), (vec!["count-b-1".to_string()], 2));
                let (_c, c_state) = daemon.connect_as("hub-c-key").await;
                assert_eq!(state(&c_state), (Vec::<String>::new(), 3));

                daemon.stop().await;
            }
        }
    }
}

#[cfg(test)]
#[path = "daemon_backpressure_tests.rs"]
mod backpressure_tests;

#[cfg(test)]
#[path = "daemon_input_tests.rs"]
mod input_tests;
