use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::batch::{
    batch_loop, BatchedEvent, ChannelEvent, ChannelEventSender, EventFrame, OutputEvent,
};
use crate::environment::{self, EnvMode, Platform};
use crate::expand::expand_vars;
use crate::framing::{encode_frame, FrameReader};
use crate::headless::{HeadlessMirror, SnapshotInfo};
use crate::owner::OwnerId;
use crate::protocol::{error_codes, AgentToHub, SnapshotData};
use crate::pty::{
    log_teardown_outcome, spawn_teardown_confirmation, DestroyAllSummary, PtyManager,
    TeardownConfirmation, TeardownStart,
};
use crate::shell;
use async_xpty::PtySize;

/// Commands sent from the main task to a per-channel PTY reader task.
pub(crate) enum ChannelCommand {
    /// Request a snapshot; reply is sent on the oneshot channel.
    Snapshot(oneshot::Sender<SnapshotInfo>),
    /// Notify the mirror of a resize.
    Resize(u16, u16),
}

/// Per-channel sender for ChannelCommand.
/// Frame sender — encodes messages to bytes, delivers to writer task.
/// Using a channel as the write abstraction allows sharing across stdio and daemon modes.
pub(crate) type FrameSender = mpsc::UnboundedSender<Vec<u8>>;

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
    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // 2. Spawn stdout writer task
    {
        let stdout_w = Arc::clone(&stdout);
        tokio::spawn(async move {
            while let Some(frame) = frame_rx.recv().await {
                let mut w = stdout_w.lock().await;
                let _ = w.write_all(&frame).await;
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

    // 6. Batch channels: every channel's output and events, in one pipeline
    let (channel_events, channel_events_rx) = mpsc::unbounded_channel::<ChannelEvent>();
    let (batched_tx, mut batched_rx) = mpsc::unbounded_channel::<BatchedEvent>();

    // 7. Spawn batch loop
    tokio::spawn(batch_loop(channel_events_rx, batched_tx));

    // 8. Spawn the writer for what leaves the batch loop, in that order
    {
        let ftx = frame_tx.clone();
        tokio::spawn(async move {
            while let Some(event) = batched_rx.recv().await {
                if let Ok(frame) = event.into_frame() {
                    let _ = ftx.send(frame);
                }
            }
        });
    }

    // 9. stdin read loop. Its one connection owns every channel: stdio has a
    // single hub, which needs no key to be told apart from others.
    let owner = OwnerId::legacy();
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
/// A daemon also says `hub-identity`: it reads the AUTH that follows HELLO
/// even without a token, keeps each hub's channels to that hub, and
/// understands STOP (#127). Stdio has one hub and nothing to tell apart.
pub(crate) fn build_hello(daemon: bool) -> AgentToHub {
    let mut capabilities: Vec<String> = vec![
        "multiplex".into(),
        "resize".into(),
        "snapshot".into(),
        "launch-profiles".into(),
        // Reads SPAWN's env_mode, env_unset and login_shell, and answers
        // ENV_QUERY (#576).
        "env-modes".into(),
    ];
    if daemon {
        capabilities.push("hub-identity".into());
    }
    AgentToHub::Hello {
        version: 1,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities,
        available_shells: Some(shell::detect_available_shells()),
        default_shell: Some(shell::get_default_shell()),
    }
}

/// The ERROR a request about a channel gets when the caller cannot see it: it
/// does not exist, or another hub holds it (#127). Both read the same, byte
/// for byte, so that a hub cannot learn what another one runs.
fn channel_not_found(channel_id: String) -> AgentToHub {
    AgentToHub::Error {
        code: error_codes::CHANNEL_NOT_FOUND.into(),
        message: format!("channel {} not found", channel_id),
        channel_id: Some(channel_id),
        other_owner_channels: None,
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
/// mode the single connection is `legacy` and owns everything it spawns.
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
        HubToAgent::Attach { channel_id } => {
            format!("ATTACH ch={}", &channel_id[..8.min(channel_id.len())])
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
            ..
        } => {
            handle_spawn(
                request_id,
                channel_id,
                shell,
                args.unwrap_or_default(),
                cwd,
                SpawnEnvironment {
                    mode: EnvMode::parse(env_mode.as_deref()),
                    unset: env_unset.unwrap_or_default(),
                    env,
                    login_shell: login_shell.unwrap_or(false),
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
            // Get writer before dropping lock to avoid holding across await
            let writer_opt = {
                let mgr = pty_manager.lock().await;
                mgr.owned_by(&channel_id, owner)
                    .map(|channel| channel.process.writer())
            };
            if let Some(mut writer) = writer_opt {
                writer.write_all(&data).await?;
            } else {
                send_frame(&frame_tx, &channel_not_found(channel_id))?;
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
                send_frame(&frame_tx, &channel_not_found(channel_id))?;
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
                let (reply_tx, reply_rx) = oneshot::channel::<SnapshotInfo>();
                if tx.send(ChannelCommand::Snapshot(reply_tx)).is_ok() {
                    if let Ok(info) = reply_rx.await {
                        // Get the current seq from the pty_manager
                        let last_seq = {
                            let mgr = pty_manager.lock().await;
                            match mgr.channels.get(&channel_id) {
                                Some(channel) => channel.seq,
                                None => 0,
                            }
                        };
                        let msg = AgentToHub::SnapshotRes {
                            channel_id: channel_id.clone(),
                            snapshot: SnapshotData {
                                serialized: info.serialized,
                                cols: info.cols,
                                rows: info.rows,
                                cursor_x: info.cursor_x,
                                cursor_y: info.cursor_y,
                            },
                            last_seq,
                        };
                        send_frame(&frame_tx, &msg)?;
                    } else {
                        tracing::warn!(
                            "SNAPSHOT_REQ: reader task dropped reply sender for channel: {}",
                            channel_id
                        );
                    }
                } else {
                    tracing::warn!("SNAPSHOT_REQ: reader task gone for channel: {}", channel_id);
                }
            } else {
                tracing::warn!("SNAPSHOT_REQ for unknown channel: {}", channel_id);
            }
        }

        HubToAgent::Attach { channel_id } => {
            let tx_opt = if visible_to(&pty_manager, &channel_id, owner).await {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
            } else {
                None
            };
            if let Some(tx) = tx_opt {
                let (reply_tx, reply_rx) = oneshot::channel::<SnapshotInfo>();
                if tx.send(ChannelCommand::Snapshot(reply_tx)).is_ok() {
                    if let Ok(info) = reply_rx.await {
                        let last_seq = {
                            let mgr = pty_manager.lock().await;
                            match mgr.channels.get(&channel_id) {
                                Some(channel) => channel.seq,
                                None => 0,
                            }
                        };
                        let msg = AgentToHub::AttachOk {
                            channel_id: channel_id.clone(),
                            snapshot: SnapshotData {
                                serialized: info.serialized,
                                cols: info.cols,
                                rows: info.rows,
                                cursor_x: info.cursor_x,
                                cursor_y: info.cursor_y,
                            },
                            last_seq,
                        };
                        send_frame(&frame_tx, &msg)?;
                    } else {
                        tracing::warn!(
                            "ATTACH: reader task dropped reply sender for channel: {}",
                            channel_id
                        );
                    }
                } else {
                    tracing::warn!("ATTACH: reader task gone for channel: {}", channel_id);
                    send_frame(
                        &frame_tx,
                        &AgentToHub::Error {
                            code: error_codes::CHANNEL_NOT_FOUND.into(),
                            message: format!("channel {} not found or dead", channel_id),
                            channel_id: Some(channel_id),
                            other_owner_channels: None,
                        },
                    )?;
                }
            } else {
                tracing::warn!("ATTACH for unknown channel: {}", channel_id);
                send_frame(&frame_tx, &channel_not_found(channel_id))?;
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
    } = spawn_env;
    // Counts and the mode only: names and values can be secrets.
    tracing::info!(
        request_id = %request_id,
        owner = owner.short(),
        shell = ?shell,
        cwd = ?cwd,
        cols = cols,
        rows = rows,
        elevated = ?elevated,
        env_count = env.as_ref().map(|e| e.len()).unwrap_or(0),
        env_unset_count = env_unset.len(),
        env_mode = ?env_mode,
        login_shell,
        "SPAWN received"
    );

    let resolved_shell = shell.unwrap_or_else(shell::get_default_shell);
    let args = shell::login_shell_args(Platform::current(), &resolved_shell, args, login_shell);

    // Expand vars in args, cwd, env values (NOT shell)
    let expanded_args: Vec<String> = args.iter().map(|a| expand_vars(a, env.as_ref())).collect();
    let expanded_cwd: Option<String> = cwd.map(|d| expand_vars(&d, env.as_ref()));
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
                    args = ?effective_args,
                    cwd = ?expanded_cwd,
                    "SPAWN_OK — PTY created"
                );

                spawn_reader_task(
                    owner,
                    ch_id,
                    pty_pid,
                    pty_reader,
                    mirror,
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

        // Spawn a dedicated title-polling task so it never blocks PTY I/O.
        // The task sends the new title whenever it changes; the main loop
        // receives it via the channel arm in select!.
        let (title_tx, mut title_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            // Wait one tick before the first poll so the shell is ready.
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let mut last_title = String::new();
            loop {
                if let Some(title) = crate::process::get_process_title(pty_pid).await {
                    if title != last_title {
                        last_title = title.clone();
                        if title_tx.send(title).is_err() {
                            // Main task dropped — channel is gone, stop polling.
                            break;
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        });

        loop {
            tokio::select! {
                // PTY output
                read_result = pty_reader.read(&mut rbuf) => {
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
                            send_channel_event(&channel_events, &owner, &channel_id, &log_msg);
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
                            let _ = channel_events.send(ChannelEvent::Output(OutputEvent {
                                owner: owner.clone(),
                                channel_id: channel_id.clone(),
                                seq,
                                data,
                            }));

                            // Emit title change if detected
                            if let Some(title) = mirror.take_title_change() {
                                let msg = AgentToHub::TitleChange {
                                    channel_id: channel_id.clone(),
                                    title,
                                    display_title: None,
                                };
                                send_channel_event(&channel_events, &owner, &channel_id, &msg);
                            }

                            // Emit bell if detected
                            if mirror.take_bell() {
                                let msg = AgentToHub::Bell {
                                    channel_id: channel_id.clone(),
                                };
                                send_channel_event(&channel_events, &owner, &channel_id, &msg);
                            }

                            // Emit notification if detected
                            if let Some(message) = mirror.take_notification() {
                                let msg = AgentToHub::Notification {
                                    channel_id: channel_id.clone(),
                                    message,
                                };
                                send_channel_event(&channel_events, &owner, &channel_id, &msg);
                            }
                        }
                    }
                }

                // Command from main task (snapshot request or resize)
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(ChannelCommand::Snapshot(reply_tx)) => {
                            let info = mirror.snapshot();
                            let _ = reply_tx.send(info);
                        }
                        Some(ChannelCommand::Resize(new_cols, new_rows)) => {
                            mirror.resize(new_cols, new_rows);
                        }
                        None => {
                            // Sender dropped — channel being destroyed
                            break;
                        }
                    }
                }

                // Process title update from polling task
                Some(title) = title_rx.recv() => {
                    let msg = AgentToHub::ProcessTitle {
                        channel_id: channel_id.clone(),
                        title,
                        display_title: None,
                    };
                    send_channel_event(&channel_events, &owner, &channel_id, &msg);
                }
            }
        }

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
        send_channel_event(&channel_events, &owner, &channel_id, &msg);
    });
}

/// Send a frame about a channel down the pipeline its output takes, not to the
/// connection that spawned it. It reaches the connection its owner has when it
/// is sent, after the output the channel sent before it (#549, #127).
fn send_channel_event(
    channel_events: &ChannelEventSender,
    owner: &OwnerId,
    channel_id: &str,
    msg: &AgentToHub,
) {
    if let Ok(frame) = encode_frame(msg) {
        let _ = channel_events.send(ChannelEvent::Frame(EventFrame {
            owner: owner.clone(),
            channel_id: channel_id.to_owned(),
            frame,
            ends_channel: matches!(msg, AgentToHub::ChannelExit { .. }),
        }));
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
    let _ = tx.send(frame);
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
                OwnerId::legacy(),
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
        let (channel_events, _channel_events_rx) = mpsc::unbounded_channel();

        handle_message(
            crate::protocol::HubToAgent::Stop { force: true },
            &OwnerId::legacy(),
            manager,
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .expect("STOP is answered");

        let frame = frame_rx.try_recv().expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame[4..]).unwrap();
        assert_eq!(answer["type"], "ERROR");
        assert_eq!(answer["code"], "INVALID_MESSAGE");
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

    #[tokio::test]
    async fn env_query_answers_with_the_base_for_that_mode_and_the_identity() {
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel();
        let (channel_events, _channel_events_rx) = mpsc::unbounded_channel();

        handle_message(
            crate::protocol::HubToAgent::EnvQuery {
                request_id: "env-1".into(),
                mode: Some("minimal".into()),
            },
            &OwnerId::legacy(),
            Arc::new(Mutex::new(PtyManager::new())),
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .expect("ENV_QUERY is answered");

        let frame = frame_rx.try_recv().expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame[4..]).unwrap();
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
        let (channel_events, _channel_events_rx) = mpsc::unbounded_channel();

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
            },
            80,
            24,
            None,
            None,
            None,
            None,
            OwnerId::legacy(),
            Arc::clone(&manager),
            frame_tx,
            channel_events,
            Arc::new(Mutex::new(HashMap::new())),
        )
        .await
        .expect("SPAWN is answered");
        let frame = frame_rx.recv().await.expect("an answer");
        let answer: serde_json::Value = rmp_serde::from_slice(&frame[4..]).unwrap();
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
                OwnerId::legacy(),
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
        let (channel_events, _channel_events_rx) = mpsc::unbounded_channel();
        let senders = Arc::new(Mutex::new(HashMap::new()));

        handle_message(
            crate::protocol::HubToAgent::Destroy {
                channel_id: channel_id.to_owned(),
            },
            &OwnerId::legacy(),
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
        let (channel_events, _channel_events_rx) = mpsc::unbounded_channel();
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
            },
            80,
            24,
            Some(false),
            None,
            None,
            None,
            OwnerId::legacy(),
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
        assert_eq!(frame, expected);

        // Mutation caught: removing the `None` response arm leaves the frame
        // receiver empty after a shutdown sweep wins this registration race.
    }
}
