/// End-to-end integration tests for termora-agent.
///
/// Each test spawns the real binary via `CARGO_BIN_EXE_termora-agent`,
/// communicates over stdin/stdout using 4-byte LE length-prefixed MessagePack
/// frames, and verifies correct protocol behavior.
///
/// All reads use `tokio::time::timeout` to prevent test hangs.
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A shell this platform actually has, and the flag that makes it run one
/// command and exit. These tests spawn the real binary, so they cannot share the
/// equivalent helper in `pty.rs`'s unit tests — the crate has no lib target.
/// Hardcoding `/bin/sh` failed every one of these on Windows for as long as they
/// existed, unnoticed because CI never ran the Rust suite there.
fn test_shell() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("cmd.exe", "/C")
    } else {
        ("/bin/sh", "-c")
    }
}

async fn spawn_agent() -> Child {
    let binary = env!("CARGO_BIN_EXE_termora-agent");
    Command::new(binary)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        // stderr must be inherited or actively drained — piping without reading
        // fills the OS pipe buffer and blocks the agent's tracing subscriber,
        // deadlocking the tokio runtime (especially on Windows with ConPTY).
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("failed to spawn termora-agent binary")
}

/// Read one length-prefixed frame from stdout and decode as `rmpv::Value`.
async fn read_frame(stdout: &mut ChildStdout) -> rmpv::Value {
    let mut len_buf = [0u8; 4];
    stdout
        .read_exact(&mut len_buf)
        .await
        .expect("read length header");
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut payload = vec![0u8; len];
    stdout.read_exact(&mut payload).await.expect("read payload");
    rmp_serde::from_slice(&payload).expect("decode msgpack frame")
}

/// Read one frame with a deadline; panics if the timeout fires.
async fn read_frame_timeout(stdout: &mut ChildStdout, secs: u64) -> rmpv::Value {
    tokio::time::timeout(Duration::from_secs(secs), read_frame(stdout))
        .await
        .expect("read_frame timed out")
}

/// Encode `msg` as a length-prefixed MessagePack frame and write it to stdin.
async fn write_frame(stdin: &mut ChildStdin, msg: &rmpv::Value) {
    let payload = rmp_serde::to_vec_named(msg).expect("encode msgpack frame");
    let len = (payload.len() as u32).to_le_bytes();
    stdin.write_all(&len).await.expect("write length header");
    stdin.write_all(&payload).await.expect("write payload");
    stdin.flush().await.expect("flush stdin");
}

/// Build a `rmpv::Value::Map` from `(&str, rmpv::Value)` pairs.
fn msgmap(pairs: Vec<(&str, rmpv::Value)>) -> rmpv::Value {
    rmpv::Value::Map(
        pairs
            .into_iter()
            .map(|(k, v)| (rmpv::Value::String(k.into()), v))
            .collect(),
    )
}

fn sv(s: &str) -> rmpv::Value {
    rmpv::Value::String(s.into())
}

fn iv(n: i64) -> rmpv::Value {
    rmpv::Value::Integer(n.into())
}

#[cfg(unix)]
fn daemon_fixture_dir(label: &str) -> std::path::PathBuf {
    use std::os::unix::fs::DirBuilderExt;

    let dir = std::env::temp_dir().join(format!("termora-agent-{label}-{}", ulid::Ulid::new()));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .expect("create private daemon fixture directory");
    dir
}

#[cfg(unix)]
async fn wait_for_record(socket: &std::path::Path, prefix: &str) -> std::path::PathBuf {
    let directory = socket.parent().expect("socket has parent directory");
    let socket = socket.to_str().expect("UTF-8 socket path");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        for entry in std::fs::read_dir(directory).expect("read daemon state directory") {
            let path = entry.expect("read daemon state entry").path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".json"))
                && serde_json::from_slice::<serde_json::Value>(
                    &std::fs::read(&path).expect("read identity record"),
                )
                .ok()
                .and_then(|record| record["socket"].as_str().map(str::to_owned))
                .as_deref()
                    == Some(socket)
            {
                return path;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {prefix} record for {socket}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
async fn wait_for_replacement_record(
    socket: &std::path::Path,
    previous_pid: u64,
) -> std::path::PathBuf {
    let record = wait_for_record(socket, "agent.identity-").await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let current_pid = serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(&record).expect("read identity record"),
        )
        .expect("parse identity record")["pid"]
            .as_u64()
            .expect("identity record pid");
        if current_pid != previous_pid {
            return record;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for replacement identity record"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
async fn spawn_daemon(socket: &std::path::Path) -> Child {
    spawn_daemon_from(env!("CARGO_BIN_EXE_termora-agent"), socket).await
}

#[cfg(unix)]
async fn spawn_daemon_from(binary: &str, socket: &std::path::Path) -> Child {
    let state_home = socket.parent().expect("socket has parent directory");
    Command::new(binary)
        .args([
            "--daemon",
            "--socket",
            socket.to_str().expect("UTF-8 socket path"),
        ])
        .env("XDG_STATE_HOME", state_home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .expect("spawn daemon")
}

#[cfg(unix)]
struct DaemonGuard(Child);

#[cfg(unix)]
impl std::ops::Deref for DaemonGuard {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(unix)]
impl std::ops::DerefMut for DaemonGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[cfg(unix)]
impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.0.start_kill();
    }
}

#[cfg(unix)]
async fn invoke_stop(socket: &std::path::Path) -> String {
    let output = invoke_stop_output(socket).await;
    assert!(output.status.success(), "stop process failed: {output:?}");
    String::from_utf8(output.stdout).expect("stop output is UTF-8")
}

#[cfg(unix)]
async fn invoke_stop_output(socket: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_termora-agent"))
        .args([
            "--stop",
            "--socket",
            socket.to_str().expect("UTF-8 socket path"),
        ])
        .output()
        .await
        .expect("run stop mode")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Stop validates the daemon identity before SIGTERM and only reports success
/// once that exact identity has disappeared.
#[cfg(unix)]
#[tokio::test]
async fn stop_mode_stops_a_real_daemon_and_leaves_its_clean_exit_record() {
    let dir = daemon_fixture_dir("stop-clean");
    let socket = dir.join("agent.socket");
    let mut daemon = DaemonGuard(spawn_daemon(&socket).await);
    let live = wait_for_record(&socket, "agent.identity-").await;

    assert_eq!(invoke_stop(&socket).await.trim(), "stopped");
    assert!(daemon.wait().await.expect("wait daemon").success());
    assert!(
        !live.exists(),
        "clean shutdown removes the live identity record"
    );
    let exit = wait_for_record(&socket, "agent.exit-").await;
    let exit_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&exit).expect("exit record"))
            .expect("valid exit record JSON");
    assert_eq!(exit_json["outcome"], "stopped");
    assert_eq!(exit_json["stop_requested"], true);
    assert_eq!(exit_json["forced"], false);

    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
    // Mutation caught: publishing as soon as the signal task is spawned lets
    // this immediate stop take SIGTERM's default disposition instead of the
    // daemon's graceful teardown path.
}

/// A hard kill cannot run the exit-record path, so its live identity remains
/// as evidence that a later stopper must validate rather than trust it.
#[cfg(unix)]
#[tokio::test]
async fn forced_kill_leaves_live_identity_and_no_exit_record() {
    let dir = daemon_fixture_dir("forced-kill");
    let socket = dir.join("agent.socket");
    let mut daemon = DaemonGuard(spawn_daemon(&socket).await);
    let live = wait_for_record(&socket, "agent.identity-").await;
    let killed_pid = serde_json::from_slice::<serde_json::Value>(
        &std::fs::read(&live).expect("read live identity record"),
    )
    .expect("parse live identity record")["pid"]
        .as_u64()
        .expect("live identity pid");

    daemon.kill().await.expect("force kill daemon");
    let _ = daemon.wait().await.expect("wait forced daemon");
    assert!(
        live.exists(),
        "forced kill must leave the live record behind"
    );
    assert!(
        std::fs::read_dir(&dir)
            .expect("read state directory")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("agent.exit-")),
        "forced kill cannot leave a clean exit record"
    );

    // SIGKILL skips all cleanup. The next daemon removes the stale endpoint
    // and starts, replacing the stale record after it has bound.
    let mut replacement = DaemonGuard(spawn_daemon(&socket).await);
    let replacement_live = wait_for_replacement_record(&socket, killed_pid).await;
    assert_eq!(invoke_stop(&socket).await.trim(), "stopped");
    assert!(replacement
        .wait()
        .await
        .expect("wait replacement daemon")
        .success());
    assert!(
        !replacement_live.exists(),
        "the replacement's clean shutdown removes its live record"
    );

    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
}

#[cfg(unix)]
#[tokio::test]
async fn stopping_one_sibling_socket_leaves_the_other_daemon_running() {
    let dir = daemon_fixture_dir("sibling-sockets");
    let first_socket = dir.join("first.socket");
    let second_socket = dir.join("second.socket");
    let mut first = DaemonGuard(spawn_daemon(&first_socket).await);
    let mut second = DaemonGuard(spawn_daemon(&second_socket).await);
    let first_record = wait_for_record(&first_socket, "agent.identity-").await;
    let second_record = wait_for_record(&second_socket, "agent.identity-").await;
    assert_ne!(first_record, second_record, "each socket owns its record");

    assert_eq!(invoke_stop(&first_socket).await.trim(), "stopped");
    assert!(first.wait().await.expect("wait first daemon").success());
    assert!(
        second.try_wait().expect("inspect second daemon").is_none(),
        "stopping the first socket must not stop its sibling"
    );

    assert_eq!(invoke_stop(&second_socket).await.trim(), "stopped");
    assert!(second.wait().await.expect("wait second daemon").success());
    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
    // Mutation caught: restoring a fixed record name makes the second daemon
    // overwrite the first, so stopping first.socket stops second.socket.
}

// A test for "the daemon exits between the pidfd liveness check and the /proc
// read, and stop reports it as gone rather than as an I/O error" lived here and
// was removed. It started the stopper, slept 10 ms and killed the daemon, hoping
// the stopper had already read and validated the record. When it had not, stop
// correctly reported a stale record and the assertion failed — so the test was
// red at random, which is worse for the suite than the coverage was worth.
//
// The window it aimed at is between two syscalls in one function and cannot be
// pinned from another process. Covering it needs a seam inside `identity`, not
// an integration test. Until someone adds one, the ESRCH and ENOENT arms around
// `identity.rs`'s probe are unverified: reverting them to propagate the error
// would make an already-exited daemon look like a failure, and nothing here
// would notice.

#[tokio::test]
async fn contradictory_stop_modes_are_rejected() {
    for mode in [
        "--daemon",
        "--stdio",
        "--buffer-per-channel",
        "--buffer-global",
    ] {
        let mut args = vec![mode, "--stop"];
        if mode.starts_with("--buffer-") {
            args.insert(1, "1");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_termora-agent"))
            .args(args)
            .output()
            .await
            .expect("run contradictory CLI modes");
        assert!(!output.status.success(), "{mode} with --stop must fail");
    }
    // Mutation caught: accepting a daemon-only option with --stop silently
    // ignores the selected daemon configuration.
}

#[cfg(unix)]
#[tokio::test]
async fn planted_record_in_world_writable_directory_does_not_signal_a_process() {
    use std::os::unix::fs::PermissionsExt;

    let dir = daemon_fixture_dir("world-writable-identity");
    let socket = dir.join("agent.socket");
    let mut daemon = DaemonGuard(spawn_daemon(&socket).await);
    let record = wait_for_record(&socket, "agent.identity-").await;
    let planted = std::fs::read(&record).expect("read live daemon record");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777))
        .expect("make fixture directory world writable");
    std::fs::remove_file(&record).expect("remove original record before planting");
    std::fs::write(&record, planted).expect("plant a valid-looking record");

    let output = invoke_stop_output(&socket).await;
    assert!(
        !output.status.success(),
        "untrusted record must not be acted on"
    );
    assert!(
        daemon.try_wait().expect("inspect daemon").is_none(),
        "a planted record in a writable directory must not signal its process"
    );

    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .expect("restore private fixture directory");
    assert_eq!(invoke_stop(&socket).await.trim(), "stopped");
    assert!(daemon.wait().await.expect("wait daemon").success());
    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
    // Mutation caught: removing the reader-side directory check causes --stop
    // to signal the process named by an attacker-planted record.
}

#[cfg(unix)]
#[tokio::test]
async fn stop_normalizes_relative_socket_spellings() {
    let dir = daemon_fixture_dir("relative-socket-identity");
    let raw_socket = "agent.socket";
    let absolute_socket = dir.join(raw_socket);
    let mut daemon = DaemonGuard(
        Command::new(env!("CARGO_BIN_EXE_termora-agent"))
            .args(["--daemon", "--socket", raw_socket])
            .current_dir(&dir)
            .env("XDG_STATE_HOME", &dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .expect("spawn daemon with a relative socket spelling"),
    );
    let _record = wait_for_record(&absolute_socket, "agent.identity-").await;

    let output = Command::new(env!("CARGO_BIN_EXE_termora-agent"))
        .args(["--stop", "--socket", "./agent.socket"])
        .current_dir(&dir)
        .output()
        .await
        .expect("stop daemon with an equivalent relative spelling");
    assert!(output.status.success(), "stop process failed: {output:?}");
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "stopped");
    assert!(daemon.wait().await.expect("wait daemon").success());
    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
    // Mutation caught: deriving the record directory from raw input makes
    // `agent.socket` and `./agent.socket` select different state locations.
}

#[cfg(unix)]
#[tokio::test]
async fn executable_mismatch_is_not_reported_as_stopped() {
    let dir = daemon_fixture_dir("executable-mismatch");
    let socket = dir.join("agent.socket");
    let mut daemon = DaemonGuard(spawn_daemon(&socket).await);
    let record = wait_for_record(&socket, "agent.identity-").await;
    let mut json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record).expect("read identity record"))
            .expect("parse identity record");
    json["executable_file_identity"]["inode"] = serde_json::Value::from(u64::MAX);
    std::fs::write(&record, serde_json::to_vec(&json).expect("encode record"))
        .expect("mutate identity record");

    let output = invoke_stop_output(&socket).await;
    assert!(
        !output.status.success(),
        "a mismatch is not a successful stop"
    );
    assert_eq!(
        String::from_utf8(output.stdout)
            .expect("stop output is UTF-8")
            .trim(),
        "record does not match a live process"
    );
    assert!(daemon.try_wait().expect("inspect daemon").is_none());
    daemon.kill().await.expect("clean up daemon");
    let _ = daemon.wait().await.expect("wait daemon");
    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
    // Mutation caught: treating a post-validation mismatch as disappearance
    // reports `stopped` while the daemon continues running.
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn replaced_daemon_binary_remains_stoppable() {
    let dir = daemon_fixture_dir("replaced-binary");
    let socket = dir.join("agent.socket");
    let running_binary = dir.join("termora-agent-running");
    std::fs::copy(env!("CARGO_BIN_EXE_termora-agent"), &running_binary)
        .expect("copy running agent binary");
    let mut daemon = DaemonGuard(
        spawn_daemon_from(running_binary.to_str().expect("UTF-8 binary path"), &socket).await,
    );
    let _record = wait_for_record(&socket, "agent.identity-").await;
    let replacement = dir.join("termora-agent-replacement");
    std::fs::copy(env!("CARGO_BIN_EXE_termora-agent"), &replacement)
        .expect("copy replacement agent binary");
    std::fs::rename(&replacement, &running_binary).expect("replace daemon binary atomically");

    assert_eq!(invoke_stop(&socket).await.trim(), "stopped");
    assert!(daemon.wait().await.expect("wait daemon").success());
    std::fs::remove_dir_all(dir).expect("remove daemon fixture directory");
    // Mutation caught: comparing /proc/<pid>/exe's deleted pathname instead of
    // the opened executable inode refuses an upgraded-but-live daemon.
}

/// SC-09: Agent sends HELLO as the very first frame on stdout.
#[tokio::test]
async fn test_hello_on_startup() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();

    let hello = read_frame_timeout(&mut stdout, 5).await;

    assert_eq!(
        hello["type"].as_str(),
        Some("HELLO"),
        "first frame must be HELLO"
    );
    assert_eq!(hello["version"].as_u64(), Some(1), "version must be 1");
    assert!(
        hello["capabilities"].is_array(),
        "capabilities must be an array"
    );

    agent.kill().await.ok();
}

/// SC-10: HELLO contains shell detection fields (available_shells, default_shell).
#[tokio::test]
async fn test_hello_contains_shells() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();

    let hello = read_frame_timeout(&mut stdout, 5).await;

    let shells = hello["available_shells"]
        .as_array()
        .expect("available_shells must be present in HELLO");
    assert!(!shells.is_empty(), "at least one shell must be detected");

    let default = hello["default_shell"]
        .as_str()
        .expect("default_shell must be present in HELLO");
    assert!(!default.is_empty(), "default_shell must be non-empty");

    agent.kill().await.ok();
}

/// SC-27: HEARTBEAT → HEARTBEAT_ACK; ts field is echoed back verbatim.
#[tokio::test]
async fn test_heartbeat_ack() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    // Consume HELLO before sending commands.
    let _hello = read_frame_timeout(&mut stdout, 5).await;

    let ts = "2026-03-21T00:00:00Z";
    let hb = msgmap(vec![("type", sv("HEARTBEAT")), ("ts", sv(ts))]);
    write_frame(&mut stdin, &hb).await;

    let ack = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(ack["type"].as_str(), Some("HEARTBEAT_ACK"));
    assert_eq!(
        ack["ts"].as_str(),
        Some(ts),
        "ts must be echoed back verbatim"
    );

    agent.kill().await.ok();
}

/// SC-11: SPAWN with a valid shell → SPAWN_OK containing a non-empty channel_id.
#[tokio::test]
async fn test_spawn_ok() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    let _hello = read_frame_timeout(&mut stdout, 5).await;

    let spawn_msg = msgmap(vec![
        ("type", sv("SPAWN")),
        ("request_id", sv("req-1")),
        ("shell", sv(test_shell().0)),
        ("cols", iv(80)),
        ("rows", iv(24)),
    ]);
    write_frame(&mut stdin, &spawn_msg).await;

    let resp = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(resp["type"].as_str(), Some("SPAWN_OK"));
    assert_eq!(resp["request_id"].as_str(), Some("req-1"));

    let ch_id = resp["channel_id"]
        .as_str()
        .expect("channel_id must be present in SPAWN_OK");
    assert!(!ch_id.is_empty(), "channel_id must be non-empty");

    agent.kill().await.ok();
}

/// SC-13: SPAWN with a nonexistent shell path → SPAWN_ERR with code SHELL_NOT_FOUND.
#[tokio::test]
async fn test_spawn_nonexistent_shell() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    let _hello = read_frame_timeout(&mut stdout, 5).await;

    let spawn_msg = msgmap(vec![
        ("type", sv("SPAWN")),
        ("request_id", sv("req-2")),
        ("shell", sv("/nonexistent/shell")),
        ("cols", iv(80)),
        ("rows", iv(24)),
    ]);
    write_frame(&mut stdin, &spawn_msg).await;

    let resp = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(resp["type"].as_str(), Some("SPAWN_ERR"));
    assert_eq!(resp["request_id"].as_str(), Some("req-2"));
    assert_eq!(resp["code"].as_str(), Some("SHELL_NOT_FOUND"));

    agent.kill().await.ok();
}

/// SC-38: Unknown message type → agent sends ERROR INVALID_MESSAGE and continues.
///
/// The FrameReader catches deserialization errors and wraps them as
/// HubToAgent::Error { code: "INVALID_MESSAGE" }, which the handler echoes
/// back to the hub as AgentToHub::Error. The agent does NOT crash.
#[tokio::test]
async fn test_unknown_message_type_sends_error() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    let _hello = read_frame_timeout(&mut stdout, 5).await;

    // Send an unknown message type
    let unknown = msgmap(vec![
        ("type", sv("UNKNOWN_TYPE_XYZ")),
        ("payload", sv("ignored")),
    ]);
    write_frame(&mut stdin, &unknown).await;

    // Agent should respond with ERROR INVALID_MESSAGE
    let response = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(response["type"].as_str(), Some("ERROR"));
    assert_eq!(response["code"].as_str(), Some("INVALID_MESSAGE"));

    // Agent is still alive — send heartbeat to confirm
    let hb = msgmap(vec![("type", sv("HEARTBEAT")), ("ts", sv("alive-check"))]);
    write_frame(&mut stdin, &hb).await;
    let ack = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(ack["type"].as_str(), Some("HEARTBEAT_ACK"));

    agent.kill().await.ok();
}

/// Full lifecycle: SPAWN → read OUTPUT containing expected text → CHANNEL_EXIT.
#[tokio::test]
async fn test_full_lifecycle() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    let _hello = read_frame_timeout(&mut stdout, 5).await;

    // Spawn a short-lived command that prints a known string then exits.
    let spawn_msg = msgmap(vec![
        ("type", sv("SPAWN")),
        ("request_id", sv("req-lc")),
        ("shell", sv(test_shell().0)),
        (
            "args",
            // Both shells exit on their own after a `-c` / `/C` command, so the
            // explicit `&& exit 0` this used to carry was doing nothing.
            rmpv::Value::Array(vec![sv(test_shell().1), sv("echo lifecycle_test")]),
        ),
        ("cols", iv(80)),
        ("rows", iv(24)),
    ]);
    write_frame(&mut stdin, &spawn_msg).await;

    // SPAWN_OK must be the very first frame after the SPAWN request — no skip loop needed.
    let spawn_ok = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(spawn_ok["type"].as_str(), Some("SPAWN_OK"));
    let ch_id = spawn_ok["channel_id"].as_str().unwrap().to_string();

    // Drain frames until OUTPUT with "lifecycle_test" and CHANNEL_EXIT are seen.
    // IMPORTANT: OUTPUT goes through the 16ms batch loop; CHANNEL_EXIT goes
    // directly via frame_tx. They race — so we must NOT stop reading the moment
    // we see CHANNEL_EXIT. Instead we keep reading for a short grace period after
    // exit so any buffered OUTPUT frames can arrive.
    let mut saw_output = false;
    let mut saw_exit = false;
    // After CHANNEL_EXIT, allow up to 500 ms for any buffered OUTPUT to arrive.
    let mut exit_grace_deadline: Option<tokio::time::Instant> = None;

    loop {
        // Use a short per-frame timeout; tighten it after we've seen exit.
        let per_frame_ms = if exit_grace_deadline.is_some() {
            500
        } else {
            2000
        };
        let frame = match tokio::time::timeout(
            Duration::from_millis(per_frame_ms),
            read_frame(&mut stdout),
        )
        .await
        {
            Ok(f) => f,
            Err(_) => break, // silence — stop draining
        };

        match frame["type"].as_str() {
            Some("OUTPUT") => {
                if let rmpv::Value::Binary(data) = &frame["data"] {
                    if String::from_utf8_lossy(data).contains("lifecycle_test") {
                        saw_output = true;
                    }
                }
            }
            Some("CHANNEL_EXIT") => {
                assert_eq!(
                    frame["channel_id"].as_str(),
                    Some(ch_id.as_str()),
                    "CHANNEL_EXIT channel_id must match the spawned channel"
                );
                saw_exit = true;
                // Keep reading briefly in case buffered OUTPUT hasn't arrived yet.
                exit_grace_deadline =
                    Some(tokio::time::Instant::now() + Duration::from_millis(500));
            }
            _ => {} // TITLE_CHANGE, PROCESS_TITLE, BELL — benign, ignore
        }

        // Stop once we have both, or once the grace period after exit expires.
        if saw_output && saw_exit {
            break;
        }
        if let Some(deadline) = exit_grace_deadline {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
        }
    }

    assert!(
        saw_output,
        "expected OUTPUT frame containing 'lifecycle_test'"
    );
    assert!(saw_exit, "expected CHANNEL_EXIT frame");

    agent.kill().await.ok();
}

/// SC-28: Closing stdin (EOF) causes the agent to exit with code 0 (graceful shutdown).
#[tokio::test]
async fn test_stdin_eof_graceful_shutdown() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let stdin = agent.stdin.take().unwrap();

    let _hello = read_frame_timeout(&mut stdout, 5).await;

    // Close stdin — triggers the `n == 0` branch in run_stdio.
    drop(stdin);

    let status = tokio::time::timeout(Duration::from_secs(5), agent.wait())
        .await
        .expect("agent did not exit within 5 s after stdin EOF")
        .expect("wait() failed");

    assert!(status.success(), "agent must exit with code 0 on stdin EOF");
}

/// Multiple sequential heartbeats are all acknowledged in order with matching ts.
#[tokio::test]
async fn test_multiple_heartbeats_in_order() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    let _hello = read_frame_timeout(&mut stdout, 5).await;

    for i in 0u32..3 {
        let ts = format!("2026-03-21T00:00:0{i}Z");
        let hb = msgmap(vec![("type", sv("HEARTBEAT")), ("ts", sv(&ts))]);
        write_frame(&mut stdin, &hb).await;

        let ack = read_frame_timeout(&mut stdout, 5).await;
        assert_eq!(
            ack["type"].as_str(),
            Some("HEARTBEAT_ACK"),
            "heartbeat {i} must be acked"
        );
        assert_eq!(
            ack["ts"].as_str(),
            Some(ts.as_str()),
            "ts must match for heartbeat {i}"
        );
    }

    agent.kill().await.ok();
}

// ---------------------------------------------------------------------------
// Windows ConPTY — verify no stdout leak
// ---------------------------------------------------------------------------

/// Verify that ConPTY child output doesn't leak onto the agent's stdout.
///
/// The bug: when the hub spawns the agent in --stdio mode and the agent spawns
/// cmd.exe via ConPTY, the cmd.exe banner ("Microsoft Windows...") was leaking
/// onto the agent's stdout pipe, corrupting the MessagePack protocol stream.
/// The hub would see `Incoming frame too large: 1919117645` (ASCII "Micr").
///
/// The fix: `protect_stdio_handles()` clears HANDLE_FLAG_INHERIT on the agent's
/// stdout/stderr before any ConPTY creation, preventing conhost.exe from
/// inheriting the protocol pipe.
#[cfg(windows)]
#[tokio::test]
async fn test_conpty_no_stdout_leak() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    // HELLO should always be valid.
    let hello = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(hello["type"].as_str(), Some("HELLO"));

    // Spawn cmd.exe — triggers ConPTY creation internally.
    let spawn_msg = msgmap(vec![
        ("type", sv("SPAWN")),
        ("request_id", sv("req-conpty")),
        ("shell", sv("cmd.exe")),
        ("cols", iv(80)),
        ("rows", iv(24)),
    ]);
    write_frame(&mut stdin, &spawn_msg).await;

    // ── PRIMARY ASSERTION ──────────────────────────────────────────────────
    // The next frame MUST be SPAWN_OK — not raw ASCII "Microsoft Windows..."
    // If the ConPTY stdout leak is present, read_frame_timeout panics because
    // the first 4 bytes of "Micr" decode as length 1919117645 (> MAX_FRAME_SIZE).
    let resp = read_frame_timeout(&mut stdout, 10).await;
    assert_eq!(
        resp["type"].as_str(),
        Some("SPAWN_OK"),
        "Expected SPAWN_OK but got {:?} — ConPTY output may have leaked onto stdout",
        resp
    );
    assert!(
        resp["channel_id"].as_str().is_some_and(|s| !s.is_empty()),
        "SPAWN_OK must contain a non-empty channel_id"
    );

    // ── SECONDARY: verify all subsequent frames are valid protocol ──────
    // Read a few frames to confirm no delayed corruption.
    for i in 0..5 {
        match tokio::time::timeout(Duration::from_secs(2), read_frame(&mut stdout)).await {
            Ok(frame) => {
                let ft = frame["type"].as_str().unwrap_or("(none)");
                assert!(
                    matches!(
                        ft,
                        "OUTPUT"
                            | "TITLE_CHANGE"
                            | "PROCESS_TITLE"
                            | "BELL"
                            | "NOTIFICATION"
                            | "CHANNEL_EXIT"
                    ),
                    "Frame {} has unexpected type {:?} — possible protocol corruption",
                    i,
                    ft
                );
                if ft == "CHANNEL_EXIT" {
                    break;
                }
            }
            Err(_) => break, // timeout — OK, no more frames
        }
    }

    agent.kill().await.ok();
}

/// Regression: SPAWN_OK must be the very first frame after a SPAWN request,
/// even when the shell exits immediately (e.g. `exit 0`).
///
/// Before the fix, tokio work-stealing could run the PTY reader task before
/// `handle_spawn` enqueued SPAWN_OK, causing CHANNEL_EXIT to arrive first —
/// a protocol inversion (PROTOCOL.md §SPAWN_OK is the "channel exists" ack).
///
/// Post-fix this is deterministic: SPAWN_OK is enqueued *before*
/// `spawn_reader_task` is called, so no reader frame can precede it in the
/// single FIFO mpsc channel regardless of scheduler ordering.
#[tokio::test]
async fn test_spawn_ok_precedes_channel_exit() {
    let mut agent = spawn_agent().await;
    let mut stdout = agent.stdout.take().unwrap();
    let mut stdin = agent.stdin.take().unwrap();

    // Consume the mandatory HELLO frame.
    let hello = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(hello["type"].as_str(), Some("HELLO"));

    // Spawn a shell that exits immediately — maximises scheduler pressure on
    // the race window between SPAWN_OK and the reader task's CHANNEL_EXIT.
    let spawn_msg = msgmap(vec![
        ("type", sv("SPAWN")),
        ("request_id", sv("req-ordering")),
        ("shell", sv(test_shell().0)),
        (
            "args",
            rmpv::Value::Array(vec![sv(test_shell().1), sv("exit 0")]),
        ),
        ("cols", iv(80)),
        ("rows", iv(24)),
    ]);
    write_frame(&mut stdin, &spawn_msg).await;

    // PRIMARY ASSERTION: the very first frame after SPAWN must be SPAWN_OK.
    // No skip loop — any other frame type here is a protocol violation.
    let first = read_frame_timeout(&mut stdout, 5).await;
    assert_eq!(
        first["type"].as_str(),
        Some("SPAWN_OK"),
        "SPAWN_OK must be the first agent->hub frame after SPAWN; got {:?}",
        first
    );
    assert!(
        first["channel_id"].as_str().is_some_and(|s| !s.is_empty()),
        "SPAWN_OK must carry a non-empty channel_id"
    );
    assert_eq!(
        first["request_id"].as_str(),
        Some("req-ordering"),
        "SPAWN_OK request_id must echo the SPAWN request_id"
    );

    agent.kill().await.ok();
}
