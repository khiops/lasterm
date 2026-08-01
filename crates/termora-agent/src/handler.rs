use std::collections::HashMap;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::batch::{batch_loop, BatchedOutput, OutputEvent};
use crate::expand::expand_vars;
use crate::framing::{encode_frame, FrameReader};
use crate::headless::{HeadlessMirror, SnapshotInfo};
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

/// Preserve the pre-existing manager-lock lifetime around `wait()`.
async fn wait_for_reader_exit(
    pty_manager: &Arc<Mutex<PtyManager>>,
    channel_id: &str,
) -> Option<async_xpty::ExitStatus> {
    let mut mgr = pty_manager.lock().await;
    match mgr.channels.get_mut(channel_id) {
        Some(channel) => channel.process.wait().await.ok(),
        None => None,
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
    send_frame(&frame_tx, &build_hello())?;

    // 4. Shared state
    let pty_manager = Arc::new(Mutex::new(PtyManager::new()));

    // 5. Per-channel command senders (for snapshot requests and resize forwarding)
    let cmd_senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));

    // 6. Batch channels
    let (output_tx, output_rx) = mpsc::unbounded_channel::<OutputEvent>();
    let (batched_tx, mut batched_rx) = mpsc::unbounded_channel::<BatchedOutput>();

    // 7. Spawn batch loop
    tokio::spawn(batch_loop(output_rx, batched_tx));

    // 8. Spawn batched output writer
    {
        let ftx = frame_tx.clone();
        tokio::spawn(async move {
            while let Some(b) = batched_rx.recv().await {
                let msg = AgentToHub::Output {
                    channel_id: b.channel_id,
                    seq: b.seq,
                    ts: iso_now(),
                    data: b.data,
                };
                if let Ok(frame) = encode_frame(&msg) {
                    let _ = ftx.send(frame);
                }
            }
        });
    }

    // 9. stdin read loop
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
                Arc::clone(&pty_manager),
                frame_tx.clone(),
                output_tx.clone(),
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
pub(crate) fn build_hello() -> AgentToHub {
    AgentToHub::Hello {
        version: 1,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities: vec![
            "multiplex".into(),
            "resize".into(),
            "snapshot".into(),
            "launch-profiles".into(),
        ],
        available_shells: Some(shell::detect_available_shells()),
        default_shell: Some(shell::get_default_shell()),
    }
}

/// Dispatch a single message from the hub.
/// Dispatch a single message from the hub.
pub(crate) async fn handle_message(
    msg: crate::protocol::HubToAgent,
    pty_manager: Arc<Mutex<PtyManager>>,
    frame_tx: FrameSender,
    output_tx: mpsc::UnboundedSender<OutputEvent>,
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
        HubToAgent::Error { code, .. } => format!("ERROR {}", code),
    };
    tracing::debug!(msg = %summary, "hub message received");

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
            ..
        } => {
            handle_spawn(
                request_id,
                channel_id,
                shell,
                args.unwrap_or_default(),
                cwd,
                env,
                cols,
                rows,
                elevated,
                elevation_secret,
                elevation_method,
                custom_command,
                pty_manager,
                frame_tx,
                output_tx,
                cmd_senders,
            )
            .await?;
        }

        HubToAgent::Input { channel_id, data } => {
            // Get writer before dropping lock to avoid holding across await
            let writer_opt = {
                let mgr = pty_manager.lock().await;
                mgr.channels
                    .get(&channel_id)
                    .map(|channel| channel.process.writer())
            };
            if let Some(mut writer) = writer_opt {
                writer.write_all(&data).await?;
            } else {
                send_frame(
                    &frame_tx,
                    &AgentToHub::Error {
                        code: error_codes::CHANNEL_NOT_FOUND.into(),
                        message: format!("channel {} not found", channel_id),
                        channel_id: Some(channel_id),
                    },
                )?;
            }
        }

        HubToAgent::Resize {
            channel_id,
            cols,
            rows,
        } => {
            // Resize the PTY process
            let size = PtySize { cols, rows };
            {
                let mgr = pty_manager.lock().await;
                match mgr.channels.get(&channel_id) {
                    Some(channel) => {
                        let _ = channel.process.resize(size).await;
                    }
                    None => {
                        send_frame(
                            &frame_tx,
                            &AgentToHub::Error {
                                code: error_codes::CHANNEL_NOT_FOUND.into(),
                                message: format!("channel {} not found", channel_id),
                                channel_id: Some(channel_id.clone()),
                            },
                        )?;
                    }
                }
            }
            // Also notify the mirror in the reader task
            let tx_opt = {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
            };
            if let Some(tx) = tx_opt {
                let _ = tx.send(ChannelCommand::Resize(cols, rows));
            }
        }

        HubToAgent::Destroy { channel_id } => {
            tracing::debug!("DESTROY received for channel {}", channel_id);
            let confirmation = {
                let mut mgr = pty_manager.lock().await;
                match mgr.channels.contains_key(&channel_id) {
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
            // Idempotent: no error if channel doesn't exist
        }

        HubToAgent::SnapshotReq { channel_id } => {
            let tx_opt = {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
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
            let tx_opt = {
                let senders = cmd_senders.lock().await;
                senders.get(&channel_id).cloned()
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
                        },
                    )?;
                }
            } else {
                tracing::warn!("ATTACH for unknown channel: {}", channel_id);
                send_frame(
                    &frame_tx,
                    &AgentToHub::Error {
                        code: error_codes::CHANNEL_NOT_FOUND.into(),
                        message: format!("channel {} not found", channel_id),
                        channel_id: Some(channel_id),
                    },
                )?;
            }
        }

        HubToAgent::Auth { .. } => {
            // AUTH is consumed by the connection handshake in handle_connection_inner
            // before the message loop starts. If it arrives here the hub sent it
            // out-of-order — ignore it silently (the connection was already accepted).
            tracing::warn!("received AUTH message outside of handshake — ignoring");
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
                    },
                )?;
            } else {
                tracing::warn!("received ERROR from hub: {} — {}", code, message);
            }
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_spawn(
    request_id: String,
    channel_id: Option<String>,
    shell: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    cols: u16,
    rows: u16,
    elevated: Option<bool>,
    elevation_secret: Option<String>,
    elevation_method: Option<String>,
    custom_command: Option<String>,
    pty_manager: Arc<Mutex<PtyManager>>,
    frame_tx: FrameSender,
    output_tx: mpsc::UnboundedSender<OutputEvent>,
    cmd_senders: SnapshotSenders,
) -> std::io::Result<()> {
    tracing::info!(
        request_id = %request_id,
        shell = ?shell,
        cwd = ?cwd,
        cols = cols,
        rows = rows,
        elevated = ?elevated,
        env_count = env.as_ref().map(|e| e.len()).unwrap_or(0),
        "SPAWN received"
    );

    let resolved_shell = shell.unwrap_or_else(shell::get_default_shell);

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

    // Merge extra_env (elevation env) into expanded_env
    let merged_env: Option<std::collections::HashMap<String, String>> = if extra_env.is_empty() {
        expanded_env
    } else {
        let mut merged = expanded_env.unwrap_or_default();
        merged.extend(extra_env);
        Some(merged)
    };

    // Suppress unused warning — cleanup_path lifetime is managed by schedule_cleanup
    let _ = cleanup_path;

    let spawn_result = {
        let mut mgr = pty_manager.lock().await;
        mgr.spawn(
            channel_id,
            &effective_program,
            &effective_args,
            expanded_cwd.as_deref(),
            merged_env.as_ref(),
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
                    senders.insert(ch_id.clone(), cmd_tx);
                }

                // Send SPAWN_OK *before* starting the reader task.
                //
                // The reader task is a separate tokio::spawn that immediately
                // reads the PTY.  On a multi-core scheduler, work-stealing can
                // run the reader task before this function resumes, causing it
                // to enqueue LOG("PTY closed") and CHANNEL_EXIT into the shared
                // FIFO frame channel *before* SPAWN_OK is enqueued here.
                // PROTOCOL.md requires SPAWN_OK to be the first agent→hub frame
                // for any spawn, so enqueue it now, while we still hold the
                // logical ordering advantage, then start the reader.
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
                    ch_id,
                    pty_pid,
                    pty_reader,
                    mirror,
                    cmd_rx,
                    output_tx,
                    frame_tx.clone(),
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
    channel_id: String,
    pty_pid: u32,
    mut pty_reader: async_xpty::PtyReader,
    mirror: HeadlessMirror,
    mut cmd_rx: mpsc::UnboundedReceiver<ChannelCommand>,
    output_tx: mpsc::UnboundedSender<OutputEvent>,
    frame_tx: FrameSender,
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
                            if let Ok(frame) = encode_frame(&log_msg) {
                                let _ = frame_tx.send(frame);
                            }
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
                            let _ = output_tx.send(OutputEvent {
                                channel_id: channel_id.clone(),
                                seq,
                                data,
                            });

                            // Emit title change if detected
                            if let Some(title) = mirror.take_title_change() {
                                let msg = AgentToHub::TitleChange {
                                    channel_id: channel_id.clone(),
                                    title,
                                    display_title: None,
                                };
                                if let Ok(frame) = encode_frame(&msg) {
                                    let _ = frame_tx.send(frame);
                                }
                            }

                            // Emit bell if detected
                            if mirror.take_bell() {
                                let msg = AgentToHub::Bell {
                                    channel_id: channel_id.clone(),
                                };
                                if let Ok(frame) = encode_frame(&msg) {
                                    let _ = frame_tx.send(frame);
                                }
                            }

                            // Emit notification if detected
                            if let Some(message) = mirror.take_notification() {
                                let msg = AgentToHub::Notification {
                                    channel_id: channel_id.clone(),
                                    message,
                                };
                                if let Ok(frame) = encode_frame(&msg) {
                                    let _ = frame_tx.send(frame);
                                }
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
                    if let Ok(frame) = encode_frame(&msg) {
                        let _ = frame_tx.send(frame);
                    }
                }
            }
        }

        // PTY EOF: clean up cmd sender entry
        {
            let mut senders = cmd_senders.lock().await;
            senders.remove(&channel_id);
        }

        let exit_status = wait_for_reader_exit(&pty_manager, &channel_id).await;
        let mut mgr = pty_manager.lock().await;
        mgr.remove(&channel_id);

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
            channel_id,
            exit_code,
            signal,
        };
        if let Ok(frame) = encode_frame(&msg) {
            let _ = frame_tx.send(frame);
        }
    });
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
#[cfg(target_os = "linux")]
mod tests {
    use super::*;
    use crate::pty::PtyChannelState;

    async fn spawn_channel(manager: &Arc<Mutex<PtyManager>>, channel_id: &str) -> u32 {
        manager
            .lock()
            .await
            .spawn(
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
        let (output_tx, _output_rx) = mpsc::unbounded_channel();
        let senders = Arc::new(Mutex::new(HashMap::new()));

        handle_message(
            crate::protocol::HubToAgent::Destroy {
                channel_id: channel_id.to_owned(),
            },
            Arc::clone(&manager),
            frame_tx.clone(),
            output_tx.clone(),
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
        let (output_tx, _output_rx) = mpsc::unbounded_channel();
        let senders = Arc::new(Mutex::new(HashMap::new()));

        handle_spawn(
            "swept-spawn-request".into(),
            Some("swept-spawn-channel".into()),
            Some("/bin/true".into()),
            Vec::new(),
            None,
            None,
            80,
            24,
            Some(false),
            None,
            None,
            None,
            manager,
            frame_tx,
            output_tx,
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
