//! A terminal that takes no input holds up its own input and nothing else
//! (#740): not another channel, not a heartbeat, not the connection.
//!
//! A terminal takes no input once its program stops reading it and the PTY's
//! buffer is full. On Windows that is not enough: ConPTY keeps taking what a
//! program does not read (it took 16 MiB without a pause, measured). What it
//! does not take is input while its output is held back (#553). So a terminal
//! that takes no input is, on Unix, a program that does not read, and on
//! Windows, a terminal whose hub reads nothing while it prints.
//!
//! The terminals are real; the connections run over in-memory streams, as in
//! `daemon_backpressure_tests.rs`, whose helpers these tests share.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::backpressure_tests::{
    frame_type, held_back, input, is_about, numbered_file, output_data,
    print_meanwhile_read_a_line, read_a_line, read_until_written, scratch, spawn_interactive,
    spawn_running, tear_down, typed_line, visible, wait_for_file, TestHub, DEADLINE, KEY_A,
    TEST_MARKS,
};
use super::*;

/// The input bound of the daemons these tests run, far below the agent's.
const TEST_BOUND: usize = 64 * 1024;
/// Bytes in each INPUT the tests send in bulk.
const FRAME_BYTES: usize = 4096;
/// INPUTs sent to a terminal that takes none: 800 KiB, more than the bound
/// and everything between the queue and the program put together (a Unix PTY
/// holds some 68 KiB; on Windows, ConPTY's writer thread holds 64 writes of
/// 4 KiB, and its pipe a few more).
const FLOOD: usize = 200;
/// How long the daemon may take to read what its hub sends. It reads as it
/// comes; before #740 it stopped for good behind a terminal that took nothing.
const SEND_WITHIN: Duration = Duration::from_secs(15);

/// A daemon holding no more than `bound` bytes of a terminal's input.
fn input_daemon(bound: usize) -> DaemonShared {
    DaemonShared::with_pipeline(
        None,
        Arc::new(Mutex::new(PtyManager::with_input_bound(bound))),
        shutdown_channel().1,
        TEST_MARKS,
    )
}

/// The input queued for `channel_id`, not yet taken by its terminal.
async fn queued_bytes(daemon: &DaemonShared, channel_id: &str) -> usize {
    daemon
        .pty_manager
        .lock()
        .await
        .channels
        .get(channel_id)
        .map_or(0, |channel| channel.input.queued())
}

fn heartbeat(ts: &str) -> HubToAgent {
    HubToAgent::Heartbeat { ts: ts.to_string() }
}

/// INPUT number `k`, of `FRAME_BYTES`, made of whole lines that leave
/// `in-KKKKKK-LL-ni` in `out` once a program takes them: on Unix 64 lines of
/// 64 bytes that `cat > out` copies, on Windows one line `cmd` runs.
fn numbered_input(k: usize, out: &Path) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_BYTES);
    if cfg!(windows) {
        frame.extend_from_slice(
            format!("echo in-{k:06}-00-ni>>{} & rem ", out.display()).as_bytes(),
        );
        frame.resize(FRAME_BYTES - 1, b'x');
        frame.push(b'\r');
    } else {
        for line in 0..FRAME_BYTES / 64 {
            let start = frame.len();
            frame.extend_from_slice(format!("in-{k:06}-{line:02}-ni ").as_bytes());
            frame.resize(start + 63, b'x');
            frame.push(b'\n');
        }
    }
    frame
}

/// The lines of `numbered_input` each INPUT carries.
fn lines_per_input() -> usize {
    if cfg!(windows) {
        1
    } else {
        FRAME_BYTES / 64
    }
}

/// Every `in-KKKKKK-LL-ni` in `text`, in order, as (input, line).
fn numbered_lines(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while let Some(at) = text[i..].find("in-") {
        let start = i + at;
        let token = &bytes[start..bytes.len().min(start + 15)];
        if token.len() == 15
            && token[3..9].iter().all(u8::is_ascii_digit)
            && token[9] == b'-'
            && token[10..12].iter().all(u8::is_ascii_digit)
            && &token[12..15] == b"-ni"
        {
            let k = text[start + 3..start + 9].parse().expect("six digits");
            let line = text[start + 10..start + 12].parse().expect("two digits");
            found.push((k, line));
            i = start + 15;
        } else {
            i = start + 3;
        }
    }
    found
}

/// Every line of the INPUTs `inputs`, in order.
fn lines_of(inputs: impl IntoIterator<Item = usize>) -> Vec<(usize, usize)> {
    inputs
        .into_iter()
        .flat_map(|k| (0..lines_per_input()).map(move |line| (k, line)))
        .collect()
}

/// Read what comes for a moment, keeping it.
async fn read_a_moment(hub: &mut TestHub, frames: &mut Vec<rmpv::Value>) {
    if let Ok(frame) = tokio::time::timeout(Duration::from_millis(20), hub.next_frame()).await {
        frames.push(frame);
    }
}

/// Read, keeping what comes, until `path` holds `last`.
async fn read_until_line(
    hub: &mut TestHub,
    frames: &mut Vec<rmpv::Value>,
    path: &Path,
    last: (usize, usize),
) {
    let deadline = tokio::time::Instant::now() + DEADLINE;
    loop {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        if numbered_lines(&text).last() == Some(&last) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{} did not end with {last:?} within {DEADLINE:?}; it holds {} lines",
            path.display(),
            numbered_lines(&text).len()
        );
        read_a_moment(hub, frames).await;
    }
}

/// The INPUT_DROPPED errors about `channel_id` among `frames`.
fn drops_of(frames: &[rmpv::Value], channel_id: &str) -> usize {
    frames
        .iter()
        .filter(|frame| is_about(frame, "ERROR", channel_id))
        .filter(|frame| frame["code"].as_str() == Some(error_codes::INPUT_DROPPED))
        .count()
}

/// A terminal that takes no input until released.
struct Stuck {
    channel_id: String,
    /// Unix: the program reads nothing until this file exists.
    go: PathBuf,
    /// Windows: written once the terminal has printed everything.
    done: PathBuf,
}

impl Stuck {
    /// Spawn `channel_id` and return once it takes no input. Released, it
    /// copies its input to `copy_to` (Unix), or runs it (Windows: the lines
    /// of `numbered_input` append to the same file); without `copy_to`, it
    /// never reads (Unix).
    async fn start(
        hub: &mut TestHub,
        daemon: &DaemonShared,
        dir: &Path,
        channel_id: &str,
        copy_to: Option<&Path>,
    ) -> Self {
        let stuck = Self {
            channel_id: channel_id.to_string(),
            go: dir.join(format!("{channel_id}-go")),
            done: dir.join(format!("{channel_id}-done")),
        };
        if cfg!(windows) {
            // An interactive cmd made to print far more than its hub, which
            // reads nothing, lets through: its output is held back, and
            // ConPTY takes no input meanwhile.
            let numbers = numbered_file(dir);
            hub.spawn(spawn_interactive(channel_id)).await;
            let command = format!(
                "type {} & echo done> {}\r",
                numbers.display(),
                stuck.done.display()
            );
            hub.send(&input(channel_id, command.into_bytes())).await;
            held_back(
                daemon,
                &OwnerId::from_hub_key(KEY_A),
                channel_id,
                &stuck.done,
            )
            .await;
        } else {
            let command = match copy_to {
                Some(out) => format!(
                    "while [ ! -e '{}' ]; do sleep 0.05; done; exec cat > '{}'",
                    stuck.go.display(),
                    out.display()
                ),
                None => "exec sleep 600".to_string(),
            };
            hub.spawn(spawn_running(channel_id, &command)).await;
        }
        stuck
    }

    /// Have the terminal take input again, keeping what is read meanwhile.
    async fn release(&self, hub: &mut TestHub, frames: &mut Vec<rmpv::Value>) {
        if cfg!(windows) {
            // Its output drains once its hub reads.
            let deadline = tokio::time::Instant::now() + DEADLINE;
            while !self.done.exists() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "{} printed nothing more once its hub read",
                    self.channel_id
                );
                read_a_moment(hub, frames).await;
            }
        } else {
            std::fs::write(&self.go, b"go").expect("release the terminal");
        }
    }

    /// Send `FLOOD` numbered INPUTs, from 0. Each must be read within
    /// `SEND_WITHIN`, and the queue never holds more than its bound.
    async fn flood(&self, hub: &mut TestHub, daemon: &DaemonShared, out: &Path) {
        let mut most = 0;
        for k in 0..FLOOD {
            hub.send_within(
                &input(&self.channel_id, numbered_input(k, out)),
                SEND_WITHIN,
            )
            .await;
            most = most.max(queued_bytes(daemon, &self.channel_id).await);
        }
        assert!(
            most <= TEST_BOUND,
            "{most} bytes queued, over the bound of {TEST_BOUND}"
        );
        let queued = queued_bytes(daemon, &self.channel_id).await;
        assert!(
            queued > TEST_BOUND - FRAME_BYTES,
            "a terminal that takes no input left its queue at {queued} bytes, short of full"
        );
    }
}

/// A program that never reads holds up neither another terminal nor a
/// heartbeat on the same connection. The connection used to stop reading for
/// good behind the first INPUT its terminal did not take.
///
/// On Windows ConPTY takes all of it: this checks nothing is in the way, and
/// `input_to_a_held_back_terminal_does_not_block_its_connection` is the case
/// that stalls there.
#[tokio::test]
async fn a_program_that_never_reads_holds_up_no_other_terminal_and_no_heartbeat() {
    let dir = scratch("deaf");
    let daemon = input_daemon(TEST_BOUND);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    hub.spawn(spawn_interactive("other")).await;
    let deaf = if cfg!(windows) {
        "ping -n 600 127.0.0.1 >nul"
    } else {
        "exec sleep 600"
    };
    hub.spawn(spawn_running("deaf", deaf)).await;

    let out = dir.join("unused");
    for k in 0..256 {
        hub.send_within(&input("deaf", numbered_input(k, &out)), SEND_WITHIN)
            .await;
    }
    hub.send_within(&heartbeat("after-the-flood"), SEND_WITHIN)
        .await;
    let frames = hub
        .read_through(|frame| frame_type(frame) == "HEARTBEAT_ACK")
        .await;
    assert_eq!(
        frames.last().unwrap()["ts"].as_str(),
        Some("after-the-flood")
    );
    hub.print("other", "other-still-answers").await;

    tear_down(&daemon, &dir).await;
}

/// Past its bound, a terminal's input is dropped whole, the hub told once,
/// and taken again once the terminal has taken everything queued. What the
/// program reads is whole INPUTs, in order, with one gap.
#[tokio::test]
async fn input_past_the_bound_is_dropped_whole_and_the_hub_told_once() {
    let dir = scratch("bound");
    let out = dir.join("out");
    let daemon = input_daemon(TEST_BOUND);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    let stuck = Stuck::start(&mut hub, &daemon, &dir, "stuck", Some(&out)).await;

    stuck.flood(&mut hub, &daemon, &out).await;

    let mut frames = Vec::new();
    stuck.release(&mut hub, &mut frames).await;
    let deadline = tokio::time::Instant::now() + DEADLINE;
    while queued_bytes(&daemon, "stuck").await > 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the released terminal did not take its queue"
        );
        read_a_moment(&mut hub, &mut frames).await;
    }
    let after = FLOOD..FLOOD + 4;
    for k in after.clone() {
        hub.send(&input("stuck", numbered_input(k, &out))).await;
    }
    let last = *lines_of(after.clone()).last().unwrap();
    read_until_line(&mut hub, &mut frames, &out, last).await;

    assert_eq!(
        drops_of(&frames, "stuck"),
        1,
        "one INPUT_DROPPED for the gap, naming the terminal"
    );
    let got = numbered_lines(&std::fs::read_to_string(&out).unwrap());
    let taken = got.iter().take_while(|(k, _)| *k < FLOOD).count();
    let first_dropped = taken / lines_per_input();
    assert!(
        first_dropped > 0 && taken % lines_per_input() == 0,
        "the terminal took {taken} lines before the gap: not whole INPUTs"
    );
    assert_eq!(
        got,
        lines_of((0..first_dropped).chain(after)),
        "INPUTs 0 to {first_dropped}, then those sent once it took input again, whole and in order"
    );

    tear_down(&daemon, &dir).await;
}

/// A terminal's input reaches it in the order sent, however long it waited
/// in the queue.
#[tokio::test]
async fn a_terminals_input_reaches_it_in_order() {
    let dir = scratch("order");
    let out = dir.join("out");
    // The agent's own bound: nothing is dropped.
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    // Unix: reads nothing until released, so the queue holds what the PTY
    // does not. Windows: ConPTY takes everything at once anyway.
    let reader = if cfg!(windows) {
        hub.spawn(spawn_interactive("ordered")).await;
        None
    } else {
        Some(Stuck::start(&mut hub, &daemon, &dir, "ordered", Some(&out)).await)
    };

    let inputs = 0..64;
    for k in inputs.clone() {
        hub.send(&input("ordered", numbered_input(k, &out))).await;
    }
    let mut frames = Vec::new();
    if let Some(reader) = &reader {
        assert!(
            queued_bytes(&daemon, "ordered").await > 0,
            "the queue holds what the terminal has not taken"
        );
        reader.release(&mut hub, &mut frames).await;
    }
    let expected = lines_of(inputs);
    read_until_line(&mut hub, &mut frames, &out, *expected.last().unwrap()).await;

    assert_eq!(
        numbered_lines(&std::fs::read_to_string(&out).unwrap()),
        expected
    );
    assert_eq!(drops_of(&frames, "ordered"), 0);

    tear_down(&daemon, &dir).await;
}

/// DESTROY ends a terminal's input writer, stuck on a terminal that takes
/// nothing, and frees its queue; the connection carries on.
#[tokio::test]
async fn destroy_ends_the_input_writer_and_frees_its_queue() {
    let dir = scratch("destroy");
    let out = dir.join("unused");
    let daemon = input_daemon(TEST_BOUND);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    let stuck = Stuck::start(&mut hub, &daemon, &dir, "doomed", None).await;
    stuck.flood(&mut hub, &daemon, &out).await;
    let queue = daemon
        .pty_manager
        .lock()
        .await
        .channels
        .get("doomed")
        .map(|channel| channel.input.liveness())
        .expect("the terminal is registered");

    hub.send_within(
        &HubToAgent::Destroy {
            channel_id: "doomed".into(),
        },
        SEND_WITHIN,
    )
    .await;
    tokio::time::timeout(DEADLINE, async {
        while queue.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the writer ends and the queue is freed once its terminal is destroyed");

    hub.send_within(&heartbeat("after-destroy"), SEND_WITHIN)
        .await;
    hub.read_through(|frame| frame_type(frame) == "HEARTBEAT_ACK")
        .await;
    assert!(!daemon.pty_manager.lock().await.contains("doomed"));

    tear_down(&daemon, &dir).await;
}

/// The Windows case (#553): ConPTY takes no input while its output is held
/// back. Typing more into such a terminal than ConPTY holds used to stop its
/// connection: another terminal's input and the heartbeat waited until its
/// hub read again, which a hub waiting for its heartbeat might never do.
///
/// On Unix the held-back shell reads one line and no more, so the rest of the
/// input stalls it the same way.
#[tokio::test]
async fn input_to_a_held_back_terminal_does_not_block_its_connection() {
    let dir = scratch("held-input");
    let numbers = numbered_file(&dir);
    let done = dir.join("done");
    let typed = dir.join("typed");
    let typed_idle = dir.join("typed-idle");
    let out = dir.join("unused");
    let daemon = input_daemon(TEST_BOUND);
    let owner = OwnerId::from_hub_key(KEY_A);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;

    hub.spawn(read_a_line("idle", &typed_idle)).await;
    hub.spawn(print_meanwhile_read_a_line(
        "stalled", &numbers, &done, &typed,
    ))
    .await;
    held_back(&daemon, &owner, "stalled", &done).await;

    hub.send_within(
        &input("stalled", typed_line("typed-while-held")),
        SEND_WITHIN,
    )
    .await;
    for k in 0..FLOOD {
        hub.send_within(&input("stalled", numbered_input(k, &out)), SEND_WITHIN)
            .await;
    }
    hub.send_within(&heartbeat("while-held"), SEND_WITHIN).await;
    hub.send_within(&input("idle", typed_line("typed-to-idle")), SEND_WITHIN)
        .await;
    let got = wait_for_file(&typed_idle).await;
    assert!(
        got.contains("typed-to-idle"),
        "the other terminal read {got:?}"
    );

    // Once the hub reads, the reply it was owed is there, then the other
    // terminal's output, and the held-back terminal gets what it was typed
    // before its queue filled.
    let mut frames = hub
        .read_through(|frame| frame_type(frame) == "HEARTBEAT_ACK")
        .await;
    assert_eq!(
        drops_of(&frames, "stalled"),
        1,
        "its input was dropped past the bound, once"
    );
    let echoed = |frames: &[rmpv::Value]| {
        let echo: Vec<u8> = frames
            .iter()
            .filter(|frame| is_about(frame, "OUTPUT", "idle"))
            .flat_map(|frame| output_data(frame).iter().copied())
            .collect();
        String::from_utf8_lossy(&visible(&echo)).contains("typed-to-idle")
    };
    let deadline = tokio::time::Instant::now() + DEADLINE;
    while !echoed(&frames) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the other terminal's output did not reach its hub"
        );
        read_a_moment(&mut hub, &mut frames).await;
    }
    assert_eq!(drops_of(&frames, "idle"), 0);
    let got = read_until_written(&mut hub, &typed).await;
    assert!(
        got.contains("typed-while-held"),
        "the held-back shell read {got:?}"
    );

    tear_down(&daemon, &dir).await;
}
