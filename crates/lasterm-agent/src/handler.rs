use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::batch::{
    batch_loop, BatchedEvent, ChannelEvent, ChannelEventSender, Delivery, EventFrame, OutputEvent,
    ReplyFrame,
};
use crate::cwd::{CwdTracker, ProcessRead};
use crate::environment::{self, EnvMode, Platform};
use crate::expand::expand_vars;
use crate::flow::{Flow, Flows, InTransit, Queued};
use crate::framing::{encode_frame, FrameReader};
use crate::headless::{HeadlessMirror, SnapshotInfo};
use crate::input::Offer;
use crate::owner::OwnerId;
use crate::protocol::{error_codes, AgentToHub, SnapshotData};
use crate::pty::{
    log_teardown_outcome, spawn_teardown_confirmation, DestroyAllSummary, PtyManager,
    TeardownConfirmation, TeardownStart,
};
use crate::report_directory;
use crate::shell;
use async_xpty::PtySize;

/// Commands sent from the main task to a per-channel PTY reader task.
pub(crate) enum ChannelCommand {
    /// Render the screen and answer an ATTACH or a SNAPSHOT_REQ with it.
    Snapshot(SnapshotRequest),
    /// Notify the mirror of a resize.
    Resize(u16, u16),
    /// Read the terminal's directory afresh and send it, changed or not
    /// (CWD_QUERY, #834).
    CwdQuery,
}

/// An ATTACH or a SNAPSHOT_REQ, for the channel's reader to answer (#931).
///
/// The reader renders the screen from what it has read so far and puts the
/// reply into the channel's pipeline, behind that output. So the reply reaches
/// the connection that asked after every OUTPUT its screen holds and before
/// every OUTPUT read after it, and its `last_seq` is the seq of the last read
/// it holds.
pub(crate) struct SnapshotRequest {
    pub(crate) reply: SnapshotReply,
    /// The connection that asked.
    pub(crate) to: FrameSender,
    /// Completed once the reader has taken the request: its reply is in the
    /// pipeline, or could not be encoded and none comes. A reader that is
    /// gone, or lets the request go as its PTY closes, completes nothing
    /// (#777).
    pub(crate) taken: oneshot::Sender<()>,
}

/// Which message answers a [`SnapshotRequest`].
pub(crate) enum SnapshotReply {
    /// ATTACH_OK, echoing the ATTACH's request id (#767).
    Attach { request_id: Option<String> },
    /// SNAPSHOT_RES.
    Snapshot,
}

/// How often a terminal's process is read for its title and its directory.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// A frame on its way to a connection's writer. A terminal's output and
/// events carry their charge against their hub's connection, released once
/// the writer has written them, or when they are dropped (#553). Replies carry
/// none: nothing ever holds them back.
pub(crate) struct Outgoing {
    pub(crate) frame: Vec<u8>,
    _charge: Option<Queued>,
}

impl Outgoing {
    /// A reply, or anything else no terminal printed.
    pub(crate) fn reply(frame: Vec<u8>) -> Self {
        Self {
            frame,
            _charge: None,
        }
    }

    /// A terminal's frame, queued for `connection` and charged to it.
    pub(crate) fn charged(frame: Vec<u8>, charge: Option<InTransit>, connection: u64) -> Self {
        let len = frame.len();
        Self {
            _charge: charge.map(|charge| charge.queue_for(connection, len)),
            frame,
        }
    }

    /// A frame queued with a charge already made for its connection.
    pub(crate) fn queued(frame: Vec<u8>, charge: Queued) -> Self {
        Self {
            frame,
            _charge: Some(charge),
        }
    }

    /// The frame alone; its charge is released.
    pub(crate) fn into_frame(self) -> Vec<u8> {
        self.frame
    }
}

/// Frame sender — encodes messages to bytes, delivers to writer task.
/// Using a channel as the write abstraction allows sharing across stdio and daemon modes.
pub(crate) type FrameSender = mpsc::UnboundedSender<Outgoing>;

/// The one connection of stdio mode, as its hub's flow knows it.
const STDIO_CONNECTION: u64 = 0;

/// Per-channel sender for ChannelCommand.
pub(crate) type SnapshotSenders =
    Arc<Mutex<HashMap<String, mpsc::UnboundedSender<ChannelCommand>>>>;

/// What a reader whose PTY has closed still speaks for.
pub(crate) enum ReaderWorkload {
    /// The workload this reader was started for, taken back for its exit status.
    Own(Box<async_xpty::PtyProcess>),
    /// Nothing is registered under this channel any more: it was destroyed.
    Gone,
    /// A restart put another workload under this channel id. This reader speaks
    /// for a shell that has already ended, and for nothing that is registered.
    Replaced,
}

/// Take back the workload a reader was started for, once its PTY has closed.
///
/// A restart spawns the replacement under the *same* channel id, so an id alone
/// no longer says which workload is which: the pid does. Without that check a
/// dying reader waited on the shell that had just replaced it — and it waited
/// holding the manager lock, which stopped every message the agent had left to
/// answer, including the SPAWN_OK for that very restart (#432).
///
/// Taking the workload out is also what lets the wait happen without the lock:
/// a wait of unknown length has no business holding the one thing every other
/// message needs.
pub(crate) async fn take_own_workload(
    pty_manager: &Arc<Mutex<PtyManager>>,
    channel_id: &str,
    pty_pid: u32,
) -> ReaderWorkload {
    let mut mgr = pty_manager.lock().await;
    match mgr.channels.get(channel_id) {
        None => ReaderWorkload::Gone,
        Some(channel) if channel.process.pid() != pty_pid => ReaderWorkload::Replaced,
        Some(_) => match mgr.remove(channel_id) {
            Some(process) => ReaderWorkload::Own(Box::new(process)),
            None => ReaderWorkload::Gone,
        },
    }
}

/// Run the agent in stdio mode (stdin/stdout MessagePack framing).
/// Run the agent in stdio mode (stdin/stdout MessagePack framing).
pub async fn run_stdio() -> std::io::Result<DestroyAllSummary> {
    // 1. Build a FrameSender — frames go to a channel, writer task drains to stdout
    let stdout_raw = tokio::io::stdout();
    let stdout = Arc::new(Mutex::new(stdout_raw));
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Outgoing>();

    // 2. Spawn stdout writer task. A frame's charge is released once it is
    // written, which is what lets the terminals be read again (#553).
    {
        let stdout_w = Arc::clone(&stdout);
        tokio::spawn(async move {
            while let Some(out) = frame_rx.recv().await {
                let mut w = stdout_w.lock().await;
                let _ = w.write_all(&out.frame).await;
                let _ = w.flush().await;
            }
        });
    }

    // 3. Send HELLO
    send_frame(&frame_tx, &build_hello(false))?;

    // 4. Shared state
    let pty_manager = Arc::new(Mutex::new(PtyManager::new()));

    // 5. Per-channel command senders (for snapshot requests and resize forwarding)
    let cmd_senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));

    // 6. Batch channels: every channel's output and events, in one pipeline.
    // Its one connection owns every channel: stdio has a single hub, which
    // needs no key to be told apart from others. Stdout is that connection,
    // and what waits to be written to it holds the terminals back (#553).
    let owner = OwnerId::stdio();
    let flows = Flows::default();
    flows.of(&owner).attach(STDIO_CONNECTION);
    let (channel_events, channel_events_rx) = ChannelEventSender::new(flows);
    let (batched_tx, mut batched_rx) = mpsc::unbounded_channel::<BatchedEvent>();

    // 7. Spawn batch loop
    tokio::spawn(batch_loop(channel_events_rx, batched_tx));

    // 8. Spawn the writer for what leaves the batch loop, in that order
    {
        let ftx = frame_tx.clone();
        tokio::spawn(async move {
            while let Some(event) = batched_rx.recv().await {
                match event.into_delivery() {
                    Ok(Delivery::Owner(routed)) => {
                        let _ = ftx.send(Outgoing::charged(
                            routed.frame,
                            routed.charge,
                            STDIO_CONNECTION,
                        ));
                    }
                    Ok(Delivery::Asker(reply)) => reply.send(),
                    Err(_) => {}
                }
            }
        });
    }

    // 9. stdin read loop.
    let mut stdin = tokio::io::stdin();
    let mut reader = FrameReader::new();
    let mut buf = vec![0u8; 8192];

    loop {
        let n = stdin.read(&mut buf).await?;
        if n == 0 {
            tracing::info!("stdin EOF, shutting down");
            break;
        }
        let messages = reader.push(&buf[..n])?;
        for msg in messages {
            handle_message(
                msg,
                &owner,
                Arc::clone(&pty_manager),
                frame_tx.clone(),
                channel_events.clone(),
                Arc::clone(&cmd_senders),
            )
            .await?;
        }
    }

    Ok(teardown_stdio_terminals(&pty_manager).await)
}

async fn teardown_stdio_terminals(pty_manager: &Arc<Mutex<PtyManager>>) -> DestroyAllSummary {
    let teardown = pty_manager.lock().await.destroy_all().await;
    if teardown.unresolved.is_empty() {
        tracing::info!(
            confirmed_shell_exits = teardown.confirmed_shell_exits,
            "terminal shutdown complete"
        );
    } else {
        tracing::warn!(
            confirmed_shell_exits = teardown.confirmed_shell_exits,
            unresolved = ?teardown.unresolved,
            "terminal shutdown could not confirm every shell"
        );
    }

    // Shutdown: clean up any leftover ASKPASS temp files
    crate::elevation::cleanup_all();

    teardown
}

pub(crate) fn stdio_exit_status(summary: &DestroyAllSummary) -> i32 {
    crate::daemon::teardown_exit_status(summary)
}

/// Build the HELLO message sent to the hub at connection start.
///
/// A daemon also says `hub-identity`: it requires the AUTH that follows HELLO,
/// with or without a token, takes the hub from its key, keeps each hub's
/// channels to that hub, and understands STOP (#127). Stdio has one hub and
/// nothing to tell apart.
pub(crate) fn build_hello(daemon: bool) -> AgentToHub {
    let mut capabilities: Vec<String> = vec![
        "multiplex".into(),
        "resize".into(),
        "snapshot".into(),
        "launch-profiles".into(),
        // Reads SPAWN's env_mode, env_unset and login_shell, and answers
        // ENV_QUERY (#576).
        "env-modes".into(),
        // Sends CWD_CHANGE and answers CWD_QUERY (#834).
        "cwd".into(),
    ];
    if daemon {
        capabilities.push("hub-identity".into());
    }
    // One detection for both: the default is named as the list names it, which
    // is how the hub finds its profile (#804).
    let available_shells = shell::detect_available_shells();
    let default_shell = shell::default_shell_among(&available_shells);
    AgentToHub::Hello {
        version: 1,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities,
        available_shells: Some(available_shells),
        default_shell: Some(default_shell),
    }
}

/// The ERROR a request about a channel gets when the caller cannot see it: it
/// does not exist, or another hub holds it (#127). Both read the same, byte
/// for byte, so that a hub cannot learn what another one runs.
///
/// `request_id` is the ATTACH's, when this answers one: an INPUT or a RESIZE
/// gets the same code about the same channel, and only the id tells the hub
/// which request this answers (#767).
fn channel_not_found(channel_id: String, request_id: Option<String>) -> AgentToHub {
    AgentToHub::Error {
        code: error_codes::CHANNEL_NOT_FOUND.into(),
        message: format!("channel {} not found", channel_id),
        channel_id: Some(channel_id),
        other_owner_channels: None,
        request_id,
    }
}

/// The ERROR that says a channel's input is being dropped: its terminal has not
/// taken what is queued for it, and its queue is full (#740). Sent once per
/// gap, not once per INPUT dropped.
fn input_dropped(channel_id: String) -> AgentToHub {
    AgentToHub::Error {
        code: error_codes::INPUT_DROPPED.into(),
        message: format!(
            "input to channel {channel_id} dropped: its terminal takes no input and its \
             queue is full; input is dropped until the terminal has taken what is queued"
        ),
        channel_id: Some(channel_id),
        other_owner_channels: None,
        request_id: None,
    }
}

/// Whether `owner` may see this channel: it is registered, and it holds it.
async fn visible_to(
    pty_manager: &Arc<Mutex<PtyManager>>,
    channel_id: &str,
    owner: &OwnerId,
) -> bool {
    pty_manager
        .lock()
        .await
        .owned_by(channel_id, owner)
        .is_some()
}

/// Dispatch a single message from the hub.
///
/// `owner` is the hub the message came from. A channel is visible only to the
/// hub that spawned it: INPUT, RESIZE, DESTROY, ATTACH and SNAPSHOT_REQ about
/// another hub's channel are answered as for one that does not exist. In stdio
/// mode the single connection is the `stdio` owner, and owns everything it
/// spawns.
pub(crate) async fn handle_message(
    msg: crate::protocol::HubToAgent,
    owner: &OwnerId,
    pty_manager: Arc<Mutex<PtyManager>>,
    frame_tx: FrameSender,
    channel_events: ChannelEventSender,
    cmd_senders: SnapshotSenders,
) -> std::io::Result<()> {
    use crate::protocol::HubToAgent;

    let summary = match &msg {
        HubToAgent::Heartbeat { .. } => "HEARTBEAT".to_string(),
        HubToAgent::Spawn {
            shell, cols, rows, ..
        } => format!("SPAWN shell={:?} {}x{}", shell, cols, rows),
        HubToAgent::Input { channel_id, data } => format!(
            "INPUT ch={} {} bytes",
            &channel_id[..8.min(channel_id.len())],
            data.len()
        ),
        HubToAgent::Resize {
            channel_id,
            cols,
            rows,
        } => format!(
            "RESIZE ch={} {}x{}",
            &channel_id[..8.min(channel_id.len())],
            cols,
            rows
        ),
        HubToAgent::Destroy { channel_id } => {
            format!("DESTROY ch={}", &channel_id[..8.min(channel_id.len())])
        }
        HubToAgent::SnapshotReq { channel_id } => {
            format!("SNAPSHOT_REQ ch={}", &channel_id[..8.min(channel_id.len())])
        }
        HubToAgent::Attach { channel_id, .. } => {
            format!("ATTACH ch={}", &channel_id[..8.min(channel_id.len())])
        }
        HubToAgent::CwdQuery { channel_id } => {
            format!("CWD_QUERY ch={}", &channel_id[..8.min(channel_id.len())])
        }
        HubToAgent::Auth { .. } => "AUTH".to_string(),
        HubToAgent::EnvQuery { mode, .. } => format!("ENV_QUERY mode={mode:?}"),
        HubToAgent::Stop { force } => format!("STOP force={force}"),
        HubToAgent::Error { code, .. } => format!("ERROR {}", code),
    };
    tracing::debug!(msg = %summary, owner = owner.short(), "hub message received");

    match msg {
        HubToAgent::Heartbeat { ts } => {
            send_frame(&frame_tx, &AgentToHub::HeartbeatAck { ts })?;
        }

        HubToAgent::Spawn {
            request_id,
            channel_id,
            shell,
            args,
            cwd,
            env,
            cols,
            rows,
            elevated,
            elevation_secret,
            elevation_method,
            custom_command,
            env_mode,
            env_unset,
            login_shell,
            report_directory,
            ..
        } => {
            handle_spawn(
                request_id,
                channel_id,
                shell,
                args.unwrap_or_default(),
                cwd,
                SpawnEnvironment {
                    mode: EnvMode::parse(Some(&env_mode)),
                    unset: env_unset.unwrap_or_default(),
                    env,
                    login_shell: login_shell.unwrap_or(false),
                    report_directory: report_directory.unwrap_or(false),
                },
                cols,
                rows,
                elevated,
                elevation_secret,
                elevation_method,
                custom_command,
                owner.clone(),
                pty_manager,
                frame_tx,
                channel_events,
                cmd_senders,
            )
            .await?;
        }

        HubToAgent::EnvQuery { request_id, mode } => {
            // Agent-wide: every hub may ask, over its own authenticated
            // connection, what it could equally read by typing `env`.
            let env = environment::base(
                environment::inherited_from_process(),
                EnvMode::parse(mode.as_deref()),
                Platform::current(),
            )
            .into_map();
            send_frame(
                &frame_tx,
                &AgentToHub::Env {
                    request_id,
                    env,
                    os: environment::os_name().to_owned(),
                },
            )?;
        }

        HubToAgent::Input { channel_id, data } => {
            // Queued for the channel's own writer, never written here: a
            // terminal that takes no input must not hold up the requests that
            // follow on this connection, other channels' included (#740).
            let offered = {
                let mgr = pty_manager.lock().await;
                mgr.owned_by(&channel_id, owner)
                    .map(|channel| channel.input.offer(data))
            };
            match offered {
                None => send_frame(&frame_tx, &channel_not_found(channel_id, None))?,
                Some(Offer::Overflowed) => {
                    tracing::warn!(
                        channel_id = %channel_id,
                        owner = owner.short(),
                        "terminal takes no input: its input is dropped until it takes what is queued"
                    );
                    send_frame(&frame_tx, &input_dropped(channel_id))?;
                }
                Some(Offer::Dropped) => {
                    tracing::debug!(channel_id = %channel_id, "INPUT dropped: queue still full");
                }
                Some(Offer::Closed) => {
                    tracing::debug!(channel_id = %channel_id, "INPUT dropped: terminal gone");
                }
                Some(Offer::Queued) => {}
            }
        }

        HubToAgent::Resize {
            channel_id,
            cols,
            rows,
        } => {
            // Resize the PTY process
            let size = PtySize { cols, rows };
            let resized = {
                let mgr = pty_manager.lock().await;
                match mgr.owned_by(&channel_id, owner) {
                    Some(channel) => {
                        let _ = channel.process.resize(size).await;
                        true
                    }
                    None => false,
                }
            };
            if resized {
                // Also notify the mirror in the reader task
                let tx_opt = {
                    let senders = cmd_senders.lock().await;
                    senders.get(&channel_id).cloned()
                };
                if let Some(tx) = tx_opt {
                    let _ = tx.send(ChannelCommand::Resize(cols, rows));
                }
            } else {
                send_frame(&frame_tx, &channel_not_found(channel_id, None))?;
            }
        }

        HubToAgent::Destroy { channel_id } => {
            tracing::debug!("DESTROY received for channel {}", channel_id);
            let confirmation = {
                let mut mgr = pty_manager.lock().await;
                match mgr.owned_by(&channel_id, owner).is_some() {
                    true => match mgr.start_teardown(&channel_id) {
                        Ok(TeardownStart::Signalled { pid }) => {
                            let process = mgr
                                .remove(&channel_id)
                                .expect("signalled channel must remain registered until removal");
                            let confirmation =
                                TeardownConfirmation::new(channel_id.clone(), pid, process);
                            tracing::info!(%channel_id, pid, "signalled channel for destruction");
                            Some(confirmation)
                        }
                        Ok(TeardownStart::AlreadyExited(outcome)) => {
                            mgr.remove(&channel_id);
                            log_teardown_outcome(outcome, "DESTROY");
                            None
                        }
                        Err(outcome) => {
                            // Nothing retries a failed teardown today; keep the
                            // only PtyProcess handle registered so a live workload
                            // does not become unreachable.
                            log_teardown_outcome(outcome, "DESTROY");
                            None
                        }
                    },
                    false => None,
                }
            };
            if let Some(confirmation) = confirmation {
                spawn_teardown_confirmation(confirmation, "DESTROY");
            }
            // Idempotent: no error if channel doesn't exist, or is another
            // hub's, which is the same thing to this caller.
        }

        HubToAgent::SnapshotReq { channel_id } => {
            let tx_opt = if visible_to(&pty_manager, &channel_id, owner).await {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
            } else {
                None
            };
            if let Some(tx) = tx_opt {
                match ask_reader(&tx, SnapshotReply::Snapshot, &frame_tx).await {
                    Asked::Taken => {}
                    Asked::Dropped => tracing::warn!(
                        "SNAPSHOT_REQ: reader task dropped the request for channel: {}",
                        channel_id
                    ),
                    Asked::Gone => {
                        tracing::warn!("SNAPSHOT_REQ: reader task gone for channel: {}", channel_id)
                    }
                }
            } else {
                tracing::warn!("SNAPSHOT_REQ for unknown channel: {}", channel_id);
            }
        }

        HubToAgent::Attach {
            channel_id,
            request_id,
        } => {
            // Whatever answers this ATTACH echoes its request id, and nothing
            // else does: the hub tells it apart from an ERROR about the same
            // channel for another reason, an INPUT's (#767).
            let tx_opt = if visible_to(&pty_manager, &channel_id, owner).await {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
            } else {
                None
            };
            if let Some(tx) = tx_opt {
                // The reader serves the snapshot while it reads its PTY, and
                // sends the ATTACH_OK itself, in order with its output (#931).
                // Once its PTY has closed it serves none: the request finds it
                // gone, or reached it as it went and is dropped. Either way the
                // ATTACH is answered here, as for a terminal the agent no longer
                // has, which it is about to be: the hub never waits out its
                // timeout for it (#777).
                let reply = SnapshotReply::Attach {
                    request_id: request_id.clone(),
                };
                let taken = match ask_reader(&tx, reply, &frame_tx).await {
                    Asked::Taken => true,
                    Asked::Dropped => {
                        tracing::warn!(
                            "ATTACH: reader task dropped the request for channel: {}",
                            channel_id
                        );
                        false
                    }
                    Asked::Gone => {
                        tracing::warn!("ATTACH: reader task gone for channel: {}", channel_id);
                        false
                    }
                };
                if !taken {
                    send_frame(
                        &frame_tx,
                        &AgentToHub::Error {
                            code: error_codes::CHANNEL_NOT_FOUND.into(),
                            message: format!("channel {} not found or dead", channel_id),
                            channel_id: Some(channel_id),
                            other_owner_channels: None,
                            request_id,
                        },
                    )?;
                }
            } else {
                tracing::warn!("ATTACH for unknown channel: {}", channel_id);
                send_frame(&frame_tx, &channel_not_found(channel_id, request_id))?;
            }
        }

        HubToAgent::CwdQuery { channel_id } => {
            // Its reader reads the directory afresh and sends it down the
            // channel's own pipeline, as every CWD_CHANGE goes. A terminal the
            // caller cannot see, or whose reader is gone, is not found.
            let tx_opt = if visible_to(&pty_manager, &channel_id, owner).await {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
            } else {
                None
            };
            let asked = tx_opt.is_some_and(|tx| tx.send(ChannelCommand::CwdQuery).is_ok());
            if !asked {
                send_frame(&frame_tx, &channel_not_found(channel_id, None))?;
            }
        }

        HubToAgent::Auth { .. } => {
            // AUTH is consumed by the connection handshake in handle_connection_inner
            // before the message loop starts. If it arrives here the hub sent it
            // out-of-order — ignore it silently (the connection was already accepted).
            tracing::warn!("received AUTH message outside of handshake — ignoring");
        }

        HubToAgent::Stop { .. } => {
            // A daemon answers STOP before it gets here. Stdio has nothing to
            // stop: it ends with its input.
            send_frame(
                &frame_tx,
                &AgentToHub::Error {
                    code: error_codes::INVALID_MESSAGE.into(),
                    message: "STOP applies to an agent daemon; this agent runs on stdio and ends when its input closes".into(),
                    channel_id: None,
                    other_owner_channels: None,
                    request_id: None,
                },
            )?;
        }

        HubToAgent::Error {
            code,
            message,
            channel_id,
        } => {
            if code == error_codes::INVALID_MESSAGE {
                // Unknown message type from FrameReader → send ERROR back to hub
                send_frame(
                    &frame_tx,
                    &AgentToHub::Error {
                        code,
                        message,
                        channel_id,
                        other_owner_channels: None,
                        request_id: None,
                    },
                )?;
            } else {
                tracing::warn!("received ERROR from hub: {} — {}", code, message);
            }
        }
    }

    Ok(())
}

/// What a SPAWN says about the environment its terminal starts with (#576).
pub(crate) struct SpawnEnvironment {
    /// What the environment starts from.
    pub mode: EnvMode,
    /// Variables removed from that start: what a profile set to `null`.
    pub unset: Vec<String>,
    /// Variables set after the removals: the scopes', the launch profile's
    /// and the request's, merged by the hub.
    pub env: Option<HashMap<String, String>>,
    /// Whether the hub asks for a login shell.
    pub login_shell: bool,
    /// Whether the launch profile has a PowerShell report its directory (#839).
    pub report_directory: bool,
}

/// The whole environment a terminal starts with: the base for the mode, the
/// removals, the request's values, then elevation's.
fn spawn_environment<I>(
    inherited: I,
    platform: Platform,
    mode: EnvMode,
    unset: &[String],
    env: Option<&HashMap<String, String>>,
    elevation_env: &HashMap<String, String>,
) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut environment = environment::base(inherited, mode, platform);
    environment.apply_unset(unset);
    if let Some(env) = env {
        environment.apply(env);
    }
    environment.apply(elevation_env);
    environment.into_pairs()
}

/// The directory a terminal starts in: the one the SPAWN names, its `${VAR}`s
/// expanded, or else `default` — the home of the user the agent runs as
/// ([`shell::agent_default_cwd`]). The hub names none for a terminal that has
/// none of its own, a restart included (#581).
fn spawn_cwd(
    requested: Option<String>,
    env: Option<&HashMap<String, String>>,
    default: impl FnOnce() -> Option<String>,
) -> Option<String> {
    match requested {
        Some(dir) => Some(expand_vars(&dir, env)),
        None => default(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_spawn(
    request_id: String,
    channel_id: Option<String>,
    shell: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    spawn_env: SpawnEnvironment,
    cols: u16,
    rows: u16,
    elevated: Option<bool>,
    elevation_secret: Option<String>,
    elevation_method: Option<String>,
    custom_command: Option<String>,
    owner: OwnerId,
    pty_manager: Arc<Mutex<PtyManager>>,
    frame_tx: FrameSender,
    channel_events: ChannelEventSender,
    cmd_senders: SnapshotSenders,
) -> std::io::Result<()> {
    let SpawnEnvironment {
        mode: env_mode,
        unset: env_unset,
        env,
        login_shell,
        report_directory,
    } = spawn_env;
    // Counts, presence and the mode only: environment names and values,
    // arguments and the working directory can be secrets.
    tracing::info!(
        request_id = %request_id,
        owner = owner.short(),
        shell = ?shell,
        cwd_given = cwd.is_some(),
        cols = cols,
        rows = rows,
        elevated = ?elevated,
        env_count = env.as_ref().map(|e| e.len()).unwrap_or(0),
        env_unset_count = env_unset.len(),
        env_mode = ?env_mode,
        login_shell,
        report_directory,
        "SPAWN received"
    );

    let resolved_shell = shell.unwrap_or_else(shell::get_default_shell);
    let args = shell::login_shell_args(Platform::current(), &resolved_shell, args, login_shell);

    // Expand vars in args, cwd, env values (NOT shell)
    let expanded_args: Vec<String> = args.iter().map(|a| expand_vars(a, env.as_ref())).collect();
    // Judged on the arguments as the shell gets them, and added after their
    // expansion: the script is data, not something to expand.
    let expanded_args = report_directory::report_directory_args(
        Platform::current(),
        &resolved_shell,
        expanded_args,
        report_directory,
    );
    let expanded_cwd = spawn_cwd(cwd, env.as_ref(), shell::agent_default_cwd);
    let expanded_env: Option<std::collections::HashMap<String, String>> = env.map(|e| {
        e.into_iter()
            .map(|(k, v)| (k, expand_vars(&v, None)))
            .collect()
    });

    // Determine effective program + args (may be wrapped by elevation)
    let (effective_program, effective_args, extra_env, cleanup_path) = if elevated.unwrap_or(false)
    {
        use crate::elevation::{
            register_cleanup, schedule_cleanup, wrap_elevated, ElevationMethod,
        };
        use zeroize::Zeroizing;

        // Determine elevation method
        let method = match elevation_method.as_deref() {
            Some("custom") => match custom_command {
                Some(ref cmd) => ElevationMethod::Custom(cmd.clone()),
                None => {
                    send_frame(
                        &frame_tx,
                        &AgentToHub::SpawnErr {
                            request_id,
                            code: "ELEVATION_CUSTOM_CMD_MISSING".into(),
                            message: "custom elevation method requires custom_command field".into(),
                        },
                    )?;
                    return Ok(());
                }
            },
            Some(s) => ElevationMethod::from_str_method(s)
                .unwrap_or_else(ElevationMethod::platform_default),
            None => ElevationMethod::platform_default(),
        };

        // Immediately wrap secret in Zeroizing — clears on drop
        let secret: Option<Zeroizing<String>> = elevation_secret.map(Zeroizing::new);

        match wrap_elevated(&method, &resolved_shell, &expanded_args, secret).await {
            Ok(elevated_cmd) => {
                let cleanup = elevated_cmd.cleanup_path.clone();
                if let Some(ref path) = cleanup {
                    register_cleanup(path);
                    let path_for_cleanup = path.clone();
                    schedule_cleanup(path_for_cleanup, 1000);
                }
                (
                    elevated_cmd.program,
                    elevated_cmd.args,
                    elevated_cmd.env,
                    cleanup,
                )
            }
            Err(e) if e.to_string() == error_codes::ELEVATION_PASSWORD_REQUIRED => {
                send_frame(
                    &frame_tx,
                    &AgentToHub::SpawnErr {
                        request_id,
                        code: error_codes::ELEVATION_PASSWORD_REQUIRED.into(),
                        message: e.to_string(),
                    },
                )?;
                return Ok(());
            }
            Err(e) => {
                send_frame(
                    &frame_tx,
                    &AgentToHub::SpawnErr {
                        request_id,
                        code: "ELEVATION_FAILED".into(),
                        message: e.to_string(),
                    },
                )?;
                return Ok(());
            }
        }
    } else {
        (
            resolved_shell,
            expanded_args,
            std::collections::HashMap::new(),
            None,
        )
    };

    // The whole environment, elevation's variables last: the PTY starts from
    // this and nothing else.
    let environment = spawn_environment(
        environment::inherited_from_process(),
        Platform::current(),
        env_mode,
        &env_unset,
        expanded_env.as_ref(),
        &extra_env,
    );

    // Suppress unused warning — cleanup_path lifetime is managed by schedule_cleanup
    let _ = cleanup_path;

    let spawn_result = {
        let mut mgr = pty_manager.lock().await;
        mgr.spawn(
            owner.clone(),
            channel_id,
            &effective_program,
            &effective_args,
            expanded_cwd.as_deref(),
            Some(&environment),
            cols,
            rows,
        )
        .await
    };

    match spawn_result {
        Ok((ch_id, pty_pid)) => {
            // Get a reader for the new channel before releasing the broader context
            let pty_reader_opt = {
                let mut mgr = pty_manager.lock().await;
                mgr.reader_for(&ch_id)
            };

            if let Some(pty_reader) = pty_reader_opt {
                // Create a headless mirror for this channel (not Send — lives in the reader task)
                let mirror = HeadlessMirror::new(cols, rows, 1000);
                // Its directory, starting where the agent started it (#834).
                let cwd = CwdTracker::new(&effective_program, expanded_cwd.clone());

                // Create per-channel command channel for snapshot/resize
                let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<ChannelCommand>();
                {
                    let mut senders = cmd_senders.lock().await;
                    senders.insert(ch_id.clone(), cmd_tx.clone());
                }

                // Send SPAWN_OK *before* starting the reader task.
                //
                // The reader task is a separate tokio::spawn that immediately
                // reads the PTY.  On a multi-core scheduler, work-stealing can
                // run the reader task before this function resumes, and a shell
                // that exits at once has LOG("PTY closed") and CHANNEL_EXIT to
                // send. PROTOCOL.md requires SPAWN_OK to be the first agent→hub
                // frame for any spawn, so enqueue it now: the reader's frames
                // reach this connection only through the batch loop, after it.
                //
                // We clone ch_id so that both the SpawnOk frame and the reader
                // task receive their own owned copy; the original ch_id is moved
                // into the reader task call below.
                send_frame(
                    &frame_tx,
                    &AgentToHub::SpawnOk {
                        request_id,
                        channel_id: ch_id.clone(),
                    },
                )?;
                tracing::info!(
                    channel_id = %ch_id,
                    pid = pty_pid,
                    program = %effective_program,
                    arg_count = effective_args.len(),
                    "SPAWN_OK — PTY created"
                );

                spawn_reader_task(
                    owner,
                    ch_id,
                    pty_pid,
                    pty_reader,
                    mirror,
                    cwd,
                    cmd_rx,
                    cmd_tx,
                    channel_events,
                    Arc::clone(&pty_manager),
                    Arc::clone(&cmd_senders),
                );
            } else {
                let error = std::io::Error::other(
                    "terminal channel was gone before its reader could be registered",
                );
                tracing::warn!(channel_id = %ch_id, "SPAWN_ERR — channel was gone before reader registration");
                send_frame(
                    &frame_tx,
                    &AgentToHub::SpawnErr {
                        request_id,
                        code: map_spawn_error(&error).into(),
                        message: error.to_string(),
                    },
                )?;
            }
        }

        Err(e) => {
            tracing::error!(
                program = %effective_program,
                error = %e,
                "SPAWN_ERR — PTY creation failed"
            );
            let code = map_spawn_error(&e);
            // Send SpawnErr first so the hub can act on it immediately
            send_frame(
                &frame_tx,
                &AgentToHub::SpawnErr {
                    request_id,
                    code: code.into(),
                    message: e.to_string(),
                },
            )?;
            // Then emit a LOG diagnostic (best-effort, non-blocking)
            let _ = send_frame(
                &frame_tx,
                &AgentToHub::Log {
                    channel_id: String::new(),
                    level: "error".to_string(),
                    msg: format!("spawn failed: {}", e),
                },
            );
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_reader_task(
    owner: OwnerId,
    channel_id: String,
    pty_pid: u32,
    mut pty_reader: async_xpty::PtyReader,
    mirror: HeadlessMirror,
    cwd: CwdTracker,
    mut cmd_rx: mpsc::UnboundedReceiver<ChannelCommand>,
    own_cmd_tx: mpsc::UnboundedSender<ChannelCommand>,
    channel_events: ChannelEventSender,
    pty_manager: Arc<Mutex<PtyManager>>,
    cmd_senders: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<ChannelCommand>>>>,
) {
    tokio::spawn(async move {
        let mut rbuf = vec![0u8; 4096];
        let mut seq: u64 = 0;
        let mut mirror = mirror;
        let mut cwd = cwd;
        // What this terminal's output counts against: its hub's connection.
        // While that is full, the PTY is not read, and the program writing to
        // it blocks once the PTY's own buffer is full, as on a terminal nobody
        // reads (#553). Snapshots, resizes and titles are still served: only
        // the read waits.
        let flow = channel_events.flow(&owner);
        let mut held_back = flow.full();

        // A dedicated task reads the terminal's process, so that it never
        // blocks PTY I/O: its title and its directory, every two seconds, and
        // at once for a CWD_QUERY. The main loop receives each read via the
        // channel arm in select!.
        let (poll_tx, mut poll_rx) = mpsc::unbounded_channel::<Poll>();
        let wake = Arc::new(tokio::sync::Notify::new());
        tokio::spawn(poll_process(pty_pid, poll_tx, Arc::clone(&wake)));

        // The directory it starts in, before anything is read (#834).
        send_cwd(&mut cwd, false, &channel_events, &flow, &owner, &channel_id);

        loop {
            tokio::select! {
                // PTY output, unless its hub's connection is full
                read_result = pty_reader.read(&mut rbuf), if !held_back => {
                    match read_result {
                        Ok(0) | Err(_) => {
                            let reason = match &read_result {
                                Ok(0) => "EOF (0 bytes)".to_string(),
                                Err(e) => format!("Error: {}", e),
                                _ => "unexpected".to_string(),
                            };
                            tracing::debug!(channel_id = %channel_id, reason = %reason, "PTY reader EOF");
                            // Emit a LOG diagnostic before breaking
                            let log_msg = AgentToHub::Log {
                                channel_id: channel_id.clone(),
                                level: "debug".to_string(),
                                msg: "PTY closed".to_string(),
                            };
                            send_channel_event(
                                &channel_events, &flow, &owner, &channel_id, &log_msg,
                            );
                            break;
                        }
                        Ok(n) => {
                            seq += 1;
                            // Strip DSR queries (\x1b[6n) from output before
                            // forwarding to the hub.  With PSEUDOCONSOLE_INHERIT_CURSOR,
                            // ConPTY sends DSR but does not need a response.  If xterm.js
                            // sees the DSR, it responds with \x1b[row;colR which travels
                            // back as INPUT → ConPTY stdin → child console input buffer,
                            // killing the shell with garbage keyboard events.
                            let raw = &rbuf[..n];
                            let data = strip_dsr(raw);

                            // Skip empty chunks (e.g. all-DSR data after stripping)
                            if data.is_empty() {
                                continue;
                            }

                            // Feed output to the headless mirror BEFORE sending to batch
                            mirror.process(&data);

                            // Send to batch loop for OUTPUT frames
                            channel_events.send(ChannelEvent::Output(OutputEvent {
                                owner: owner.clone(),
                                channel_id: channel_id.clone(),
                                seq,
                                charge: flow.read(data.len()),
                                data,
                            }));

                            // Emit title change if detected
                            if let Some(title) = mirror.take_title_change() {
                                let msg = AgentToHub::TitleChange {
                                    channel_id: channel_id.clone(),
                                    title,
                                    display_title: None,
                                };
                                send_channel_event(
                                    &channel_events, &flow, &owner, &channel_id, &msg,
                                );
                            }

                            // Emit bell if detected
                            if mirror.take_bell() {
                                let msg = AgentToHub::Bell {
                                    channel_id: channel_id.clone(),
                                };
                                send_channel_event(
                                    &channel_events, &flow, &owner, &channel_id, &msg,
                                );
                            }

                            // Emit notification if detected
                            if let Some(message) = mirror.take_notification() {
                                let msg = AgentToHub::Notification {
                                    channel_id: channel_id.clone(),
                                    message,
                                };
                                send_channel_event(
                                    &channel_events, &flow, &owner, &channel_id, &msg,
                                );
                            }

                            // The shell said where it is: sent at once (#834).
                            if let Some(report) = mirror.take_shell_cwd() {
                                cwd.shell_reported(report);
                                send_cwd(
                                    &mut cwd, false, &channel_events, &flow, &owner, &channel_id,
                                );
                            }

                            if flow.full() {
                                held_back = true;
                                tracing::debug!(
                                    channel_id = %channel_id,
                                    pending = flow.pending(),
                                    "output held back until the hub's connection drains"
                                );
                            }
                        }
                    }
                }

                // The hub's connection drained: read again
                _ = flow.drained(), if held_back => {
                    held_back = false;
                }

                // Command from main task (snapshot request or resize)
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(ChannelCommand::Snapshot(request)) => {
                            answer_snapshot(request, &mirror, seq, &channel_events, &channel_id);
                        }
                        Some(ChannelCommand::Resize(new_cols, new_rows)) => {
                            mirror.resize(new_cols, new_rows);
                        }
                        Some(ChannelCommand::CwdQuery) => {
                            // Answered by the read this starts, not by one
                            // already under way.
                            wake.notify_one();
                        }
                        None => {
                            // Sender dropped — channel being destroyed
                            break;
                        }
                    }
                }

                // What the polling task read of the terminal's process
                Some(poll) = poll_rx.recv() => {
                    if let Some(title) = poll.title {
                        let msg = AgentToHub::ProcessTitle {
                            channel_id: channel_id.clone(),
                            title,
                            display_title: None,
                        };
                        send_channel_event(&channel_events, &flow, &owner, &channel_id, &msg);
                    }
                    cwd.process_read(poll.process);
                    send_cwd(&mut cwd, poll.answering, &channel_events, &flow, &owner, &channel_id);
                }
            }
        }

        // It serves no snapshot or resize any more. Its queue goes now, not
        // once the wait on its workload below is over, however long that is:
        // a snapshot request that reached it as its PTY closed is dropped at
        // once, and its ATTACH answered (#777).
        drop(cmd_rx);

        // PTY EOF: clean up cmd sender entry — but only this reader's own. A
        // restart registers the replacement under the same channel id, and
        // removing that one would leave the new terminal deaf to resizes and
        // snapshots.
        {
            let mut senders = cmd_senders.lock().await;
            if senders
                .get(&channel_id)
                .is_some_and(|tx| tx.same_channel(&own_cmd_tx))
            {
                senders.remove(&channel_id);
            }
        }

        let exit_status = match take_own_workload(&pty_manager, &channel_id, pty_pid).await {
            ReaderWorkload::Own(mut process) => process.wait().await.ok(),
            ReaderWorkload::Gone => None,
            // The hub asked for this workload to end and already knows it did:
            // an exit reported now would be read against the terminal that took
            // its place.
            ReaderWorkload::Replaced => return,
        };

        let (exit_code, signal) = match exit_status {
            Some(s) => (s.code().unwrap_or(-1), s.signal().map(|n| format!("{}", n))),
            None => (-1, None),
        };

        tracing::info!(
            channel_id = %channel_id,
            exit_code = exit_code,
            signal = ?signal,
            "PTY process exited"
        );

        let msg = AgentToHub::ChannelExit {
            channel_id: channel_id.clone(),
            exit_code,
            signal,
        };
        send_channel_event(&channel_events, &flow, &owner, &channel_id, &msg);
    });
}

/// One read of a terminal's process by its polling task.
struct Poll {
    /// Its title, when it changed since the last read.
    title: Option<String>,
    /// Its directory, and whether its shell is at its prompt.
    process: ProcessRead,
    /// Read for a CWD_QUERY: what it gives is sent, changed or not.
    answering: bool,
}

/// Read the process `pid` every [`POLL_INTERVAL`], and at once when `wake` is
/// notified, until the reader task that receives the reads is gone.
async fn poll_process(pid: u32, tx: mpsc::UnboundedSender<Poll>, wake: Arc<tokio::sync::Notify>) {
    let mut last_title = String::new();
    loop {
        // The first read waits one tick too, so that the shell is ready,
        // unless a query asks first.
        let answering = tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => false,
            _ = wake.notified() => true,
        };
        let title = match crate::process::get_process_title(pid).await {
            Some(title) if title != last_title => {
                last_title = title.clone();
                Some(title)
            }
            _ => None,
        };
        let process = crate::cwd::read_process(pid).await;
        if tx
            .send(Poll {
                title,
                process,
                answering,
            })
            .is_err()
        {
            // The reader is gone, and its terminal with it.
            break;
        }
    }
}

/// Send the terminal's directory when it changed, or when `answering` a
/// CWD_QUERY. Logged at DEBUG, without the directory: it is user content.
fn send_cwd(
    tracker: &mut CwdTracker,
    answering: bool,
    channel_events: &ChannelEventSender,
    flow: &Arc<Flow>,
    owner: &OwnerId,
    channel_id: &str,
) {
    let Some(state) = tracker.change_to_send(answering) else {
        return;
    };
    tracing::debug!(
        channel_id = %channel_id,
        source = ?state.source,
        known = state.cwd.is_some(),
        at_prompt = ?state.at_prompt,
        answering,
        "CWD_CHANGE"
    );
    let msg = state.into_message(channel_id.to_owned());
    send_channel_event(channel_events, flow, owner, channel_id, &msg);
}

/// Send a frame about a channel down the pipeline its output takes, not to the
/// connection that spawned it. It reaches the connection its owner has when it
/// is sent, after the output the channel sent before it (#549, #127). It is
/// charged to the owner's flow as output is, and never waits for it (#553).
fn send_channel_event(
    channel_events: &ChannelEventSender,
    flow: &Arc<Flow>,
    owner: &OwnerId,
    channel_id: &str,
    msg: &AgentToHub,
) {
    if let Ok(frame) = encode_frame(msg) {
        channel_events.send(ChannelEvent::Frame(EventFrame {
            owner: owner.clone(),
            channel_id: channel_id.to_owned(),
            charge: flow.read(frame.len()),
            frame,
            ends_channel: matches!(msg, AgentToHub::ChannelExit { .. }),
        }));
    }
}

/// What became of a [`SnapshotRequest`] handed to a channel's reader.
enum Asked {
    /// Its reply is in the channel's pipeline.
    Taken,
    /// The reader let it go, as its PTY closed.
    Dropped,
    /// The reader was gone already.
    Gone,
}

/// Ask a channel's reader for a snapshot reply to `to`, and wait until it has
/// put the reply in its pipeline or let the request go.
async fn ask_reader(
    reader: &mpsc::UnboundedSender<ChannelCommand>,
    reply: SnapshotReply,
    to: &FrameSender,
) -> Asked {
    let (taken, taken_rx) = oneshot::channel();
    let request = SnapshotRequest {
        reply,
        to: to.clone(),
        taken,
    };
    if reader.send(ChannelCommand::Snapshot(request)).is_err() {
        return Asked::Gone;
    }
    match taken_rx.await {
        Ok(()) => Asked::Taken,
        Err(_) => Asked::Dropped,
    }
}

/// Answer `request` with the screen as the reads `1..=last_seq` left it, put
/// in the channel's pipeline behind the output of those reads (#931).
fn answer_snapshot(
    request: SnapshotRequest,
    mirror: &HeadlessMirror,
    last_seq: u64,
    channel_events: &ChannelEventSender,
    channel_id: &str,
) {
    let info: SnapshotInfo = mirror.snapshot();
    let snapshot = SnapshotData {
        serialized: info.serialized,
        cols: info.cols,
        rows: info.rows,
        cursor_x: info.cursor_x,
        cursor_y: info.cursor_y,
    };
    let msg = match request.reply {
        SnapshotReply::Attach { request_id } => AgentToHub::AttachOk {
            channel_id: channel_id.to_owned(),
            request_id,
            snapshot,
            last_seq,
        },
        SnapshotReply::Snapshot => AgentToHub::SnapshotRes {
            channel_id: channel_id.to_owned(),
            snapshot,
            last_seq,
        },
    };
    match encode_frame(&msg) {
        Ok(frame) => {
            channel_events.send(ChannelEvent::Reply(ReplyFrame {
                channel_id: channel_id.to_owned(),
                frame,
                to: request.to,
            }));
            let _ = request.taken.send(());
        }
        // A screen too large for one frame (`MAX_FRAME_SIZE`): no reply
        // comes, and the hub answers its pane from the spool once it stops
        // waiting, as for a reply lost. The request was taken all the same:
        // the terminal runs on, and is not answered as one the agent no
        // longer has.
        Err(e) => {
            tracing::warn!(channel_id = %channel_id, error = %e, "snapshot reply not encoded");
            let _ = request.taken.send(());
        }
    }
}

/// Map an io::Error from spawn to a protocol error code.
fn map_spawn_error(e: &std::io::Error) -> &'static str {
    match e.kind() {
        std::io::ErrorKind::NotFound => error_codes::SHELL_NOT_FOUND,
        std::io::ErrorKind::PermissionDenied => error_codes::PERMISSION_DENIED,
        std::io::ErrorKind::AlreadyExists => error_codes::CHANNEL_EXISTS,
        _ => error_codes::PTY_SPAWN_FAILED,
    }
}

/// Encode and write a frame to the shared stdout.
/// Encode a message and send it via the frame channel.
/// Synchronous — no await needed. Errors are ignored if receiver is gone.
/// Strip DSR query sequences (`\x1b[6n`) from ConPTY output.
///
/// ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR` sends DSR but doesn't need
/// a response.  If we forward DSR to xterm.js, it responds with
/// `\x1b[row;colR` which the hub sends back as INPUT.  ConPTY passes this
/// to the child's console input buffer as keyboard events, killing the shell.
fn strip_dsr(data: &[u8]) -> Vec<u8> {
    const DSR: &[u8] = b"\x1b[6n";
    if !data.windows(DSR.len()).any(|w| w == DSR) {
        return data.to_vec(); // fast path: no DSR
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if i + DSR.len() <= data.len() && &data[i..i + DSR.len()] == DSR {
            i += DSR.len(); // skip the DSR sequence
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

pub(crate) fn send_frame(tx: &FrameSender, msg: &AgentToHub) -> std::io::Result<()> {
    let frame = encode_frame(msg)?;
    // SendError means receiver dropped — treat as EOF, not a hard error
    let _ = tx.send(Outgoing::reply(frame));
    Ok(())
}

/// Returns current time as ISO 8601 with millisecond precision (UTC).
/// Returns current time as ISO 8601 with millisecond precision (UTC).
pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let millis = d.subsec_millis();
    let hours = (secs % 86400) / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    let (year, month, day) = days_to_ymd(secs / 86400);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hours, minutes, seconds, millis
    )
}

/// Convert days since Unix epoch (1970-01-01) to (year, month, day).
/// Algorithm: http://howardhinnant.github.io/date_algorithms.html
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod restart_identity_tests {
    use super::*;

    /// A shell that exists on both platforms and, on a PTY with nobody typing,
    /// blocks rather than exiting.
    fn test_shell() -> &'static str {
        if cfg!(windows) {
            "cmd.exe"
        } else {
            "/bin/sh"
        }
    }

    async fn spawn_under(manager: &Arc<Mutex<PtyManager>>, channel_id: &str) -> u32 {
        manager
            .lock()
            .await
            .spawn(
                OwnerId::stdio(),
                Some(channel_id.to_owned()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .expect("spawn terminal workload")
            .1
    }

    async fn end(manager: &Arc<Mutex<PtyManager>>, channel_id: &str) {
        if let Some(process) = manager.lock().await.remove(channel_id) {
            let _ = process.kill_tree();
        }
    }

    /// A restart reuses the channel id, so the reader of the shell that was
    /// replaced must not take the replacement for its own: it used to wait on
    /// it, holding the manager lock, and the agent answered nothing again (#432).
    #[tokio::test]
    async fn a_reader_does_not_claim_the_workload_that_replaced_it() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let channel_id = "restarted-channel";
        let replaced_pid = spawn_under(&manager, channel_id).await;
        end(&manager, channel_id).await;
        let live_pid = spawn_under(&manager, channel_id).await;
        assert_ne!(replaced_pid, live_pid, "the restart spawned another shell");

        let workload = take_own_workload(&manager, channel_id, replaced_pid).await;

        assert!(matches!(workload, ReaderWorkload::Replaced));
        assert!(
            manager.lock().await.contains(channel_id),
            "the terminal that took the id over stays registered"
        );
        end(&manager, channel_id).await;
    }

    #[tokio::test]
    async fn a_reader_takes_back_its_own_workload() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let channel_id = "own-channel";
        let pid = spawn_under(&manager, channel_id).await;

        let workload = take_own_workload(&manager, channel_id, pid).await;

        match workload {
            ReaderWorkload::Own(process) => {
                assert_eq!(process.pid(), pid);
                let _ = process.kill_tree();
            }
            _ => panic!("the reader must get its own workload back"),
        }
        assert!(
            !manager.lock().await.contains(channel_id),
            "a workload waited on outside the lock is no longer registered"
        );
    }

    #[tokio::test]
    async fn a_reader_of_a_destroyed_channel_has_nothing_to_wait_on() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));

        let workload = take_own_workload(&manager, "never-registered", 1).await;

        assert!(matches!(workload, ReaderWorkload::Gone));
    }
}

#[cfg(test)]
mod stdio_tests {
    use super::*;

    /// Stdio has nothing to stop but itself, and that is its input's to
    /// decide: STOP is answered with an error, and nothing ends.
    #[tokio::test]
    async fn stdio_answers_stop_with_an_error() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());

        handle_message(
            crate::protocol::HubToAgent::Stop { force: true },
            &OwnerId::stdio(),
            manager,
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .expect("STOP is answered");

        let frame = frame_rx.try_recv().expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame.frame[4..]).unwrap();
        assert_eq!(answer["type"], "ERROR");
        assert_eq!(answer["code"], "INVALID_MESSAGE");
    }

    /// The frames `msg` is answered with, decoded.
    async fn answers(
        msg: crate::protocol::HubToAgent,
        manager: &Arc<Mutex<PtyManager>>,
        senders: &SnapshotSenders,
    ) -> Vec<serde_json::Value> {
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());
        handle_message(
            msg,
            &OwnerId::stdio(),
            Arc::clone(manager),
            frame_tx,
            channel_events,
            Arc::clone(senders),
        )
        .await
        .expect("the message is handled");
        let mut frames = Vec::new();
        while let Ok(frame) = frame_rx.try_recv() {
            frames.push(rmp_serde::from_slice(&frame.frame[4..]).unwrap());
        }
        frames
    }

    /// INPUT and ATTACH to a terminal the agent does not have get the same
    /// code about the same channel. Only the ATTACH's carries its request id,
    /// which is how the hub tells the two apart (#767).
    #[tokio::test]
    async fn only_the_answer_to_an_attach_carries_its_request_id() {
        use crate::protocol::HubToAgent;
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));

        let attach = answers(
            HubToAgent::Attach {
                channel_id: "gone".into(),
                request_id: Some("attach-1".into()),
            },
            &manager,
            &senders,
        )
        .await;
        let input = answers(
            HubToAgent::Input {
                channel_id: "gone".into(),
                data: b"x".to_vec(),
            },
            &manager,
            &senders,
        )
        .await;
        let unnamed = answers(
            HubToAgent::Attach {
                channel_id: "gone".into(),
                request_id: None,
            },
            &manager,
            &senders,
        )
        .await;

        for frames in [&attach, &input, &unnamed] {
            assert_eq!(frames.len(), 1, "{frames:?}");
            assert_eq!(frames[0]["type"], "ERROR");
            assert_eq!(frames[0]["code"], "CHANNEL_NOT_FOUND");
            assert_eq!(frames[0]["channel_id"], "gone");
        }
        assert_eq!(attach[0]["request_id"], "attach-1");
        assert!(input[0].get("request_id").is_none(), "{input:?}");
        // A hub that names no ATTACH gets the ERROR it always did.
        assert_eq!(unnamed, input);
    }

    /// Start a terminal under `channel_id`, as a SPAWN does.
    async fn start_terminal(
        channel_id: &str,
        manager: &Arc<Mutex<PtyManager>>,
        senders: &SnapshotSenders,
    ) {
        start_terminal_in(channel_id, None, manager, senders).await;
    }

    /// Start a terminal under `channel_id` in `cwd`, as a SPAWN does. What it
    /// sends about itself arrives on the receiver returned.
    async fn start_terminal_in(
        channel_id: &str,
        cwd: Option<String>,
        manager: &Arc<Mutex<PtyManager>>,
        senders: &SnapshotSenders,
    ) -> mpsc::UnboundedReceiver<ChannelEvent> {
        let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
        start_shell_in(channel_id, shell, Vec::new(), cwd, false, manager, senders).await
    }

    /// Start `shell` with `args` under `channel_id` in `cwd`, its launch
    /// profile reporting its directory or not, as a SPAWN does. What it sends
    /// about itself arrives on the receiver returned.
    async fn start_shell_in(
        channel_id: &str,
        shell: &str,
        args: Vec<String>,
        cwd: Option<String>,
        report_directory: bool,
        manager: &Arc<Mutex<PtyManager>>,
        senders: &SnapshotSenders,
    ) -> mpsc::UnboundedReceiver<ChannelEvent> {
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, channel_events_rx) = ChannelEventSender::new(Flows::default());
        handle_spawn(
            "spawn-1".into(),
            Some(channel_id.into()),
            Some(shell.into()),
            args,
            cwd,
            SpawnEnvironment {
                mode: EnvMode::Inherit,
                unset: Vec::new(),
                env: None,
                login_shell: false,
                report_directory,
            },
            80,
            24,
            None,
            None,
            None,
            None,
            OwnerId::stdio(),
            Arc::clone(manager),
            frame_tx,
            channel_events,
            Arc::clone(senders),
        )
        .await
        .expect("SPAWN is answered");
        let spawned: serde_json::Value =
            rmp_serde::from_slice(&frame_rx.recv().await.expect("an answer").frame[4..]).unwrap();
        assert_eq!(spawned["type"], "SPAWN_OK", "{spawned}");
        channel_events_rx
    }

    /// The next CWD_CHANGE `matching` among what a terminal sends, within
    /// `within`; None when none comes.
    async fn next_cwd_change(
        events: &mut mpsc::UnboundedReceiver<ChannelEvent>,
        within: std::time::Duration,
        matching: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        tokio::time::timeout(within, async {
            while let Some(event) = events.recv().await {
                if let ChannelEvent::Frame(event) = event {
                    let frame: serde_json::Value =
                        rmp_serde::from_slice(&event.frame[4..]).unwrap();
                    if frame["type"] == "CWD_CHANGE" && matching(&frame) {
                        return Some(frame);
                    }
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    }

    /// Whether a CWD_CHANGE names `dir`: the same directory, however each
    /// side spells it (a short name, a symbolic link, the case of a letter).
    fn names_dir(frame: &serde_json::Value, dir: &std::path::Path) -> bool {
        let Some(cwd) = frame["cwd"].as_str() else {
            return false;
        };
        match (std::fs::canonicalize(cwd), std::fs::canonicalize(dir)) {
            (Ok(a), Ok(b)) => a == b,
            _ => cwd.eq_ignore_ascii_case(dir.to_str().unwrap()),
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lasterm-handler-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A terminal says where it starts, answers a CWD_QUERY at once with a
    /// fresh read, and follows `cd` within a poll (#834).
    #[tokio::test]
    async fn a_terminal_reports_its_directory_and_answers_a_query_at_once() {
        use crate::protocol::HubToAgent;
        use std::time::Duration;
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));
        let start = temp_dir("query");
        let mut events = start_terminal_in(
            "cwd-ch",
            Some(start.to_str().unwrap().to_owned()),
            &manager,
            &senders,
        )
        .await;

        let first = next_cwd_change(&mut events, Duration::from_secs(5), |_| true)
            .await
            .expect("the directory it starts in");
        assert_eq!(first["source"], "start", "{first}");
        assert_eq!(first["cwd"], start.to_str().unwrap(), "{first}");

        // Well before the first poll's two seconds.
        let asked = answers(
            HubToAgent::CwdQuery {
                channel_id: "cwd-ch".into(),
            },
            &manager,
            &senders,
        )
        .await;
        assert_eq!(
            asked,
            Vec::<serde_json::Value>::new(),
            "answered in the pipeline"
        );
        let fresh = next_cwd_change(&mut events, Duration::from_millis(1500), |_| true)
            .await
            .expect("a CWD_QUERY is answered at once");
        assert_eq!(fresh["source"], "process", "{fresh}");
        assert!(names_dir(&fresh, &start), "{fresh}");

        let (line, target): (&[u8], &str) = if cfg!(windows) {
            (b"cd /d C:\\Windows\r", "C:\\Windows")
        } else {
            (b"cd /tmp\n", "/tmp")
        };
        answers(
            HubToAgent::Input {
                channel_id: "cwd-ch".into(),
                data: line.to_vec(),
            },
            &manager,
            &senders,
        )
        .await;
        let target = std::path::Path::new(target);
        let moved = next_cwd_change(&mut events, Duration::from_secs(5), |frame| {
            names_dir(frame, target)
        })
        .await
        .expect("cd is followed within a poll");
        assert_eq!(moved["source"], "process", "{moved}");

        if let Some(process) = manager.lock().await.remove("cwd-ch") {
            let _ = process.kill_tree();
        }
        let _ = std::fs::remove_dir_all(&start);
    }

    /// A shell's own report is sent at once, and wins over its process.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_shell_report_is_sent_at_once() {
        use crate::protocol::HubToAgent;
        use std::time::Duration;
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));
        let mut events = start_terminal_in("osc-ch", None, &manager, &senders).await;
        next_cwd_change(&mut events, Duration::from_secs(5), |_| true)
            .await
            .expect("the directory it starts in");

        answers(
            HubToAgent::Input {
                channel_id: "osc-ch".into(),
                data: b"printf '\\033]9;9;/reported/dir\\007'\n".to_vec(),
            },
            &manager,
            &senders,
        )
        .await;
        let reported = next_cwd_change(&mut events, Duration::from_millis(1500), |frame| {
            frame["source"] == "shell"
        })
        .await
        .expect("reported at once, before any poll");
        assert_eq!(reported["cwd"], "/reported/dir");

        let removed = manager.lock().await.remove("osc-ch");
        if let Some(process) = removed {
            let _ = process.kill_tree();
        }
    }

    /// A PowerShell whose launch profile reports its directory says where it
    /// is at its first prompt, and follows `Set-Location`, which its process
    /// directory never does: the prompt's OSC 7 comes through ConPTY (#839).
    /// Windows PowerShell 5.1 always, PowerShell 7 where this machine has it.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_powershell_reporting_its_directory_is_followed_through_set_location() {
        use crate::protocol::HubToAgent;
        use std::time::Duration;
        let powershells: Vec<String> = shell::detect_available_shells()
            .into_iter()
            .filter(|shell| {
                let name = shell.rsplit('\\').next().unwrap_or(shell);
                name.eq_ignore_ascii_case("powershell.exe") || name.eq_ignore_ascii_case("pwsh.exe")
            })
            .collect();
        assert!(
            powershells
                .iter()
                .any(|shell| shell.to_ascii_lowercase().ends_with("powershell.exe")),
            "Windows PowerShell is part of Windows: {powershells:?}"
        );
        let windows = std::path::Path::new("C:\\Windows");

        for (i, powershell) in powershells.iter().enumerate() {
            let manager = Arc::new(Mutex::new(PtyManager::new()));
            let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));
            let start = temp_dir(&format!("report-{i}"));
            let channel = format!("ps-ch-{i}");
            let mut events = start_shell_in(
                &channel,
                powershell,
                vec!["-NoLogo".into(), "-NoProfile".into()],
                Some(start.to_str().unwrap().to_owned()),
                true,
                &manager,
                &senders,
            )
            .await;

            let first = next_cwd_change(&mut events, Duration::from_secs(30), |frame| {
                frame["source"] == "shell"
            })
            .await
            .unwrap_or_else(|| panic!("{powershell} reports where it starts"));
            assert!(names_dir(&first, &start), "{powershell}: {first}");

            answers(
                HubToAgent::Input {
                    channel_id: channel.clone(),
                    data: b"Set-Location C:\\Windows\r".to_vec(),
                },
                &manager,
                &senders,
            )
            .await;
            let moved = next_cwd_change(&mut events, Duration::from_secs(15), |frame| {
                names_dir(frame, windows)
            })
            .await
            .unwrap_or_else(|| panic!("{powershell} reports Set-Location"));
            assert_eq!(moved["source"], "shell", "{powershell}: {moved}");
            assert!(moved["other_host"].is_null(), "{powershell}: {moved}");

            if let Some(process) = manager.lock().await.remove(&channel) {
                let _ = process.kill_tree();
            }
            let _ = std::fs::remove_dir_all(&start);
        }
    }

    #[tokio::test]
    async fn a_cwd_query_for_a_terminal_it_does_not_have_is_not_found() {
        use crate::protocol::HubToAgent;
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));
        let frames = answers(
            HubToAgent::CwdQuery {
                channel_id: "gone".into(),
            },
            &manager,
            &senders,
        )
        .await;
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["type"], "ERROR");
        assert_eq!(frames[0]["code"], "CHANNEL_NOT_FOUND");
        assert_eq!(frames[0]["channel_id"], "gone");
    }

    /// The ATTACH_OK of a live terminal echoes the request id too. Its reader
    /// sends it down the channel's pipeline, behind the output it holds
    /// (#931): nothing goes to the connection around it.
    #[tokio::test]
    async fn attach_ok_echoes_the_attach_request_id() {
        use crate::protocol::HubToAgent;
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));
        let mut events = start_terminal_in("attached", None, &manager, &senders).await;

        let direct = answers(
            HubToAgent::Attach {
                channel_id: "attached".into(),
                request_id: Some("attach-2".into()),
            },
            &manager,
            &senders,
        )
        .await;
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match events.recv().await {
                    Some(ChannelEvent::Reply(reply)) => break reply,
                    Some(_) => continue,
                    None => panic!("the terminal's pipeline closed without a reply"),
                }
            }
        })
        .await
        .expect("the reader replies");
        if let Some(process) = manager.lock().await.remove("attached") {
            let _ = process.kill_tree();
        }

        assert!(direct.is_empty(), "{direct:?}");
        assert_eq!(reply.channel_id, "attached");
        let attached: serde_json::Value = rmp_serde::from_slice(&reply.frame[4..]).unwrap();
        assert_eq!(attached["type"], "ATTACH_OK");
        assert_eq!(attached["channel_id"], "attached");
        assert_eq!(attached["request_id"], "attach-2");
    }

    /// A terminal whose reader lets go of the snapshot an ATTACH asks for, as
    /// one does when its PTY closes with the request in its queue, or whose
    /// reader is gone already. The ATTACH is answered all the same, at once,
    /// with the ERROR that carries its request id: the hub does not wait out
    /// its five seconds for it (#777).
    #[tokio::test]
    async fn an_attach_is_answered_when_no_snapshot_comes() {
        use crate::protocol::HubToAgent;
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));
        start_terminal("closing", &manager, &senders).await;

        // A reader that takes the request and drops it, and one already gone.
        let (dropping, mut queue) = mpsc::unbounded_channel::<ChannelCommand>();
        tokio::spawn(async move {
            while let Some(command) = queue.recv().await {
                drop(command);
            }
        });
        let (gone, _) = mpsc::unbounded_channel::<ChannelCommand>();

        let mut answered = Vec::new();
        for (reader, request_id) in [(dropping, "attach-3"), (gone, "attach-4")] {
            senders.lock().await.insert("closing".into(), reader);
            let frames = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                answers(
                    HubToAgent::Attach {
                        channel_id: "closing".into(),
                        request_id: Some(request_id.into()),
                    },
                    &manager,
                    &senders,
                ),
            )
            .await
            .expect("the ATTACH is handled at once");
            answered.push((frames, request_id));
        }
        if let Some(process) = manager.lock().await.remove("closing") {
            let _ = process.kill_tree();
        }

        for (frames, request_id) in &answered {
            assert_eq!(frames.len(), 1, "{request_id}: {frames:?}");
            assert_eq!(frames[0]["type"], "ERROR");
            assert_eq!(frames[0]["code"], "CHANNEL_NOT_FOUND");
            assert_eq!(frames[0]["channel_id"], "closing");
            assert_eq!(frames[0]["request_id"], *request_id);
        }
    }

    /// A screen too large for one frame is not answered as a terminal the
    /// agent no longer has: its hub would retire a terminal that runs on.
    /// The reader takes the request and no reply comes, so the hub answers
    /// its pane from the spool once it stops waiting (#931).
    #[tokio::test]
    async fn a_snapshot_too_large_to_send_is_not_answered_as_a_terminal_gone() {
        // Cells alternating two truecolor pairs and every attribute on and
        // off: each is drawn with its own escape sequences, about 47 bytes,
        // and 500 x 500 of them are past what one frame may carry.
        let mut mirror = HeadlessMirror::new(500, 500, 0);
        let mut screen = Vec::new();
        for row in 1..=500 {
            screen.extend_from_slice(format!("\x1b[{row};1H").as_bytes());
            for col in 0..500 {
                let cell: &[u8] = if col % 2 == 0 {
                    b"\x1b[1;2;3;4;5;7;8;9;38;2;255;254;253;48;2;252;251;250mx"
                } else {
                    b"\x1b[0;38;2;100;101;102;48;2;103;104;105my"
                };
                screen.extend_from_slice(cell);
            }
        }
        mirror.process(&screen);
        assert!(
            mirror.snapshot().serialized.len() > crate::framing::MAX_FRAME_SIZE as usize,
            "the screen must be too large for one frame"
        );
        let (channel_events, mut events) = ChannelEventSender::new(Flows::default());
        let (to, mut replies) = mpsc::unbounded_channel();
        let (taken, taken_rx) = oneshot::channel();

        answer_snapshot(
            SnapshotRequest {
                reply: SnapshotReply::Attach {
                    request_id: Some("too-large".into()),
                },
                to,
                taken,
            },
            &mirror,
            1,
            &channel_events,
            "too-large",
        );

        assert!(taken_rx.await.is_ok(), "the reader takes the request");
        assert!(
            events.try_recv().is_err(),
            "no reply goes down the pipeline"
        );
        assert!(replies.try_recv().is_err(), "nor to the connection");
    }

    /// Only a daemon says it tells hubs apart.
    #[test]
    fn only_a_daemon_says_hub_identity() {
        let capabilities = |daemon| match build_hello(daemon) {
            AgentToHub::Hello { capabilities, .. } => capabilities,
            _ => unreachable!("build_hello builds HELLO"),
        };
        assert!(capabilities(true).contains(&"hub-identity".to_string()));
        assert!(!capabilities(false).contains(&"hub-identity".to_string()));
    }

    /// Both kinds of agent build the environment themselves and answer
    /// ENV_QUERY, and say so: the hub asks nothing of an agent that does not.
    #[test]
    fn every_agent_says_env_modes() {
        for daemon in [true, false] {
            match build_hello(daemon) {
                AgentToHub::Hello { capabilities, .. } => {
                    assert!(capabilities.contains(&"env-modes".to_string()), "{daemon}");
                }
                _ => unreachable!("build_hello builds HELLO"),
            }
        }
    }

    /// Both kinds of agent send CWD_CHANGE and answer CWD_QUERY (#834).
    #[test]
    fn every_agent_says_cwd() {
        for daemon in [true, false] {
            match build_hello(daemon) {
                AgentToHub::Hello { capabilities, .. } => {
                    assert!(capabilities.contains(&"cwd".to_string()), "{daemon}");
                }
                _ => unreachable!("build_hello builds HELLO"),
            }
        }
    }

    #[tokio::test]
    async fn env_query_answers_with_the_base_for_that_mode_and_the_identity() {
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());

        handle_message(
            crate::protocol::HubToAgent::EnvQuery {
                request_id: "env-1".into(),
                mode: Some("minimal".into()),
            },
            &OwnerId::stdio(),
            Arc::new(Mutex::new(PtyManager::new())),
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .expect("ENV_QUERY is answered");

        let frame = frame_rx.try_recv().expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame.frame[4..]).unwrap();
        assert_eq!(answer["type"], "ENV");
        assert_eq!(answer["request_id"], "env-1");
        assert_eq!(answer["os"], environment::os_name());
        let env = answer["env"].as_object().expect("a map of variables");
        assert_eq!(env["TERM_PROGRAM"], "lasterm");
        assert_eq!(env["COLORTERM"], "truecolor");
        // Minimal: everything there is on its list, or is the identity.
        let identity: Vec<&str> = environment::identity(Platform::current())
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        for name in env.keys() {
            assert!(
                identity.contains(&name.as_str())
                    || environment::kept_by_minimal(Platform::current(), name),
                "{name} is not a minimal variable"
            );
        }
    }

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        vars(pairs).into_iter().collect()
    }

    fn value<'a>(environment: &'a [(String, String)], name: &str) -> Option<&'a str> {
        environment
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    /// Base, identity, removals, the request's values, elevation's: each step
    /// speaks after the one before it.
    #[test]
    fn a_spawn_environment_is_built_in_order() {
        let environment = spawn_environment(
            vars(&[
                ("HOME", "/home/pi"),
                ("EDITOR", "vi"),
                ("NO_COLOR", "1"),
                ("TERM", "dumb"),
                ("SSH_AUTH_SOCK", "/tmp/a"),
            ]),
            Platform::Unix,
            EnvMode::Inherit,
            &["SSH_AUTH_SOCK".into(), "COLORTERM".into()],
            Some(&map(&[("EDITOR", "hx"), ("ASKPASS", "request")])),
            &map(&[("ASKPASS", "elevation")]),
        );

        assert_eq!(value(&environment, "HOME"), Some("/home/pi"));
        assert_eq!(value(&environment, "NO_COLOR"), None);
        assert_eq!(value(&environment, "TERM"), Some("xterm-256color"));
        assert_eq!(value(&environment, "SSH_AUTH_SOCK"), None);
        assert_eq!(value(&environment, "COLORTERM"), None);
        assert_eq!(value(&environment, "EDITOR"), Some("hx"));
        assert_eq!(value(&environment, "ASKPASS"), Some("elevation"));
    }

    #[test]
    fn a_spawn_naming_a_directory_starts_there() {
        let env = map(&[("PROJECT", "/srv/app")]);
        assert_eq!(
            spawn_cwd(Some("${PROJECT}/web".into()), Some(&env), || panic!(
                "the default is not asked for"
            )),
            Some("/srv/app/web".to_string())
        );
    }

    // What the hub sends for a terminal with no directory of its own (#581).
    #[test]
    fn a_spawn_naming_none_starts_in_the_default() {
        assert_eq!(
            spawn_cwd(None, None, || Some("/home/pi".into())),
            Some("/home/pi".to_string())
        );
        assert_eq!(spawn_cwd(None, None, || None), None);
    }

    #[test]
    fn a_minimal_spawn_keeps_what_the_request_adds() {
        let environment = spawn_environment(
            vars(&[("HOME", "/home/pi"), ("EDITOR", "vi")]),
            Platform::Unix,
            EnvMode::Minimal,
            &[],
            Some(&map(&[("PAGER", "less")])),
            &HashMap::new(),
        );

        assert_eq!(value(&environment, "HOME"), Some("/home/pi"));
        assert_eq!(value(&environment, "EDITOR"), None);
        assert_eq!(value(&environment, "PAGER"), Some("less"));
    }

    #[test]
    fn a_windows_spawn_merges_names_without_case() {
        let environment = spawn_environment(
            vars(&[("Path", r"C:\Windows"), ("TEMP", r"C:\Temp")]),
            Platform::Windows,
            EnvMode::Inherit,
            &["temp".into()],
            Some(&map(&[("PATH", r"C:\Tools;C:\Windows")])),
            &HashMap::new(),
        );

        assert_eq!(value(&environment, "Path"), Some(r"C:\Tools;C:\Windows"));
        assert_eq!(
            value(&environment, "PATH"),
            None,
            "one variable, as named first"
        );
        assert_eq!(value(&environment, "TEMP"), None);
    }

    /// A command that writes what the shell sees of two variables to `out`.
    fn print_two_variables(out: &std::path::Path) -> (String, Vec<String>) {
        let out = out.to_string_lossy().into_owned();
        if cfg!(windows) {
            (
                "cmd.exe".into(),
                vec![
                    "/C".into(),
                    "echo".into(),
                    "%LASTERM_ENV_E2E%/%USERPROFILE%".into(),
                    ">".into(),
                    out,
                ],
            )
        } else {
            (
                "/bin/sh".into(),
                vec![
                    "-c".into(),
                    format!("printf '%s/%s' \"$LASTERM_ENV_E2E\" \"${{HOME-unset}}\" > '{out}'"),
                ],
            )
        }
    }

    #[derive(Clone)]
    struct LogCapture(Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogCapture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
        type Writer = Self;

        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[tokio::test]
    async fn spawn_logs_neither_arguments_nor_working_directory() {
        let arg_marker = format!("lasterm-secret-{}", ulid::Ulid::generate());
        let cwd_marker = format!("lasterm-cwd-secret-{}", ulid::Ulid::generate());
        let dir = std::env::temp_dir().join(&cwd_marker);
        std::fs::create_dir_all(&dir).unwrap();
        let (shell, args) = if cfg!(windows) {
            (
                "cmd.exe",
                vec!["/C".into(), "rem".into(), arg_marker.clone()],
            )
        } else {
            ("/bin/sh", vec!["-c".into(), format!(": {arg_marker}")])
        };
        let capture = LogCapture(Arc::new(std::sync::Mutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(capture.clone())
            .finish();
        // Keep two dispatches alive: tracing's single-dispatch optimization
        // otherwise caches "never" when a parallel test first hits a callsite
        // without a thread-local subscriber.
        let _parallel_dispatch = tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_writer(std::io::sink)
                .finish(),
        );
        let dispatch = tracing::Dispatch::new(subscriber);
        let _subscriber = tracing::dispatcher::set_default(&dispatch);
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());

        let result = handle_spawn(
            "log-privacy".into(),
            Some("log-privacy".into()),
            Some(shell.into()),
            args,
            Some(dir.to_string_lossy().into_owned()),
            SpawnEnvironment {
                mode: EnvMode::Inherit,
                unset: vec![],
                env: None,
                login_shell: false,
                report_directory: false,
            },
            80,
            24,
            None,
            None,
            None,
            None,
            OwnerId::stdio(),
            Arc::clone(&manager),
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await;
        if let Some(mut process) = manager.lock().await.remove("log-privacy") {
            let _ = process.kill_tree();
            tokio::time::timeout(std::time::Duration::from_secs(10), process.wait())
                .await
                .expect("shell exit timed out")
                .expect("wait for shell exit");
        }
        std::fs::remove_dir_all(&dir).unwrap();
        result.expect("SPAWN is answered");
        let frame = frame_rx.recv().await.expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame.frame[4..]).unwrap();
        assert_eq!(answer["type"], "SPAWN_OK", "{answer}");

        let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        assert!(
            logs.contains("SPAWN_OK — PTY created"),
            "spawn event captured"
        );
        assert!(logs.contains("arg_count"), "argument count captured");
        assert!(!logs.contains(&arg_marker), "arguments must not be logged");
        assert!(
            !logs.contains(&cwd_marker),
            "working directory must not be logged"
        );
    }

    /// A terminal's directory is user content (#834): CWD_CHANGE is logged at
    /// DEBUG, by its source and whether it is known, and never with the
    /// directory, whether the agent started it there, read it, or the shell
    /// reported it.
    #[tokio::test]
    async fn a_terminals_directory_is_never_logged() {
        use crate::protocol::HubToAgent;
        use std::time::Duration;
        let marker = format!("lasterm-live-cwd-secret-{}", ulid::Ulid::generate());
        let dir = std::env::temp_dir().join(&marker);
        std::fs::create_dir_all(&dir).unwrap();
        let capture = LogCapture(Arc::new(std::sync::Mutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(capture.clone())
            .finish();
        // As above: two dispatches, so no callsite caches "never".
        let _parallel_dispatch = tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_writer(std::io::sink)
                .finish(),
        );
        let dispatch = tracing::Dispatch::new(subscriber);
        let _subscriber = tracing::dispatcher::set_default(&dispatch);
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));

        let mut events = start_terminal_in(
            "cwd-log",
            Some(dir.to_string_lossy().into_owned()),
            &manager,
            &senders,
        )
        .await;
        next_cwd_change(&mut events, Duration::from_secs(5), |frame| {
            frame["source"] == "start"
        })
        .await
        .expect("the start directory");
        answers(
            HubToAgent::CwdQuery {
                channel_id: "cwd-log".into(),
            },
            &manager,
            &senders,
        )
        .await;
        next_cwd_change(&mut events, Duration::from_secs(5), |frame| {
            names_dir(frame, &dir)
        })
        .await
        .expect("the directory, read");
        // And as a shell reports it, where printing an OSC is plain.
        if cfg!(unix) {
            answers(
                HubToAgent::Input {
                    channel_id: "cwd-log".into(),
                    data: format!("printf '\\033]7;file:///{marker}/x\\007'\n").into_bytes(),
                },
                &manager,
                &senders,
            )
            .await;
            next_cwd_change(&mut events, Duration::from_secs(5), |frame| {
                frame["source"] == "shell"
            })
            .await
            .expect("the directory, reported");
        }
        if let Some(process) = manager.lock().await.remove("cwd-log") {
            let _ = process.kill_tree();
        }
        let _ = std::fs::remove_dir_all(&dir);

        let logs = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        assert!(logs.contains("CWD_CHANGE"), "CWD_CHANGE is logged: {logs}");
        assert!(!logs.contains(&marker), "a directory must not be logged");
    }

    /// The whole chain, from SPAWN to the shell: what the request removes is
    /// not there, even though the agent has it. It would be, were the PTY
    /// spawned from the agent's environment rather than a cleared one.
    #[tokio::test]
    async fn a_spawned_shell_sees_the_built_environment_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("lasterm-env-e2e-{}", ulid::Ulid::generate()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("seen.txt");
        let (shell, args) = print_two_variables(&out);
        let removed = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        assert!(
            std::env::var_os(removed).is_some(),
            "the agent has {removed}, so only a cleared spawn can lack it"
        );
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());

        handle_spawn(
            "env-e2e".into(),
            Some("env-e2e".into()),
            Some(shell),
            args,
            None,
            SpawnEnvironment {
                mode: EnvMode::Inherit,
                unset: vec![removed.into()],
                env: Some(map(&[("LASTERM_ENV_E2E", "given")])),
                login_shell: false,
                report_directory: false,
            },
            80,
            24,
            None,
            None,
            None,
            None,
            OwnerId::stdio(),
            Arc::clone(&manager),
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .expect("SPAWN is answered");
        let frame = frame_rx.recv().await.expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame.frame[4..]).unwrap();
        assert_eq!(answer["type"], "SPAWN_OK", "{answer}");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let seen = loop {
            if let Ok(text) = std::fs::read_to_string(&out) {
                if !text.trim().is_empty() {
                    break text;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the shell wrote nothing"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        if let Some(process) = manager.lock().await.remove("env-e2e") {
            let _ = process.kill_tree();
        }
        let _ = std::fs::remove_dir_all(&dir);

        let expected = if cfg!(windows) {
            "given/%USERPROFILE%"
        } else {
            "given/unset"
        };
        assert_eq!(seen.trim(), expected);
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use crate::pty::PtyChannelState;

    async fn spawn_channel(manager: &Arc<Mutex<PtyManager>>, channel_id: &str) -> u32 {
        manager
            .lock()
            .await
            .spawn(
                OwnerId::stdio(),
                Some(channel_id.to_owned()),
                "/bin/sh",
                &["-c".to_owned(), "sleep 30".to_owned()],
                None,
                None,
                80,
                24,
            )
            .await
            .expect("spawn test channel")
            .1
    }

    #[tokio::test]
    async fn failed_destroy_keeps_active_channel_registered() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let channel_id = "destroy-retry";
        spawn_channel(&manager, channel_id).await;
        manager.lock().await.fail_next_teardown_signal();
        let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());
        let senders = Arc::new(Mutex::new(HashMap::new()));

        handle_message(
            crate::protocol::HubToAgent::Destroy {
                channel_id: channel_id.to_owned(),
            },
            &OwnerId::stdio(),
            Arc::clone(&manager),
            frame_tx.clone(),
            channel_events.clone(),
            Arc::clone(&senders),
        )
        .await
        .expect("first DESTROY");

        assert!(matches!(
            manager.lock().await.channels.get(channel_id),
            Some(PtyChannelState { .. })
        ));

        let channel = manager
            .lock()
            .await
            .remove(channel_id)
            .expect("failed teardown must leave its handle registered");
        let _ = channel.kill_tree();
    }

    #[tokio::test]
    async fn stdio_teardown_with_an_unresolved_workload_has_a_failing_status() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        let channel_id = "stdio-unresolved";
        spawn_channel(&manager, channel_id).await;
        manager.lock().await.fail_next_teardown_signal();

        let summary = teardown_stdio_terminals(&manager).await;

        assert_eq!(summary.unresolved.len(), 1);
        assert_eq!(stdio_exit_status(&summary), 1);

        let channel = manager
            .lock()
            .await
            .remove(channel_id)
            .expect("failed stdio teardown must keep its handle registered");
        let _ = channel.kill_tree();
    }

    #[tokio::test]
    async fn spawn_swept_during_reader_registration_sends_spawn_error() {
        let manager = Arc::new(Mutex::new(PtyManager::new()));
        manager.lock().await.sweep_next_reader_lookup();
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = ChannelEventSender::new(Flows::default());
        let senders = Arc::new(Mutex::new(HashMap::new()));

        handle_spawn(
            "swept-spawn-request".into(),
            Some("swept-spawn-channel".into()),
            Some("/bin/true".into()),
            Vec::new(),
            None,
            SpawnEnvironment {
                mode: EnvMode::Inherit,
                unset: Vec::new(),
                env: None,
                login_shell: false,
                report_directory: false,
            },
            80,
            24,
            Some(false),
            None,
            None,
            None,
            OwnerId::stdio(),
            manager,
            frame_tx,
            channel_events,
            senders,
        )
        .await
        .expect("swept spawn must resolve its protocol request");

        let frame = frame_rx
            .recv()
            .await
            .expect("swept spawn must send a response frame");
        let expected = encode_frame(&AgentToHub::SpawnErr {
            request_id: "swept-spawn-request".into(),
            code: error_codes::PTY_SPAWN_FAILED.into(),
            message: "terminal channel was gone before its reader could be registered".into(),
        })
        .expect("expected spawn error frame must encode");
        assert_eq!(frame.frame, expected);

        // Mutation caught: removing the `None` response arm leaves the frame
        // receiver empty after a shutdown sweep wins this registration race.
    }
}
