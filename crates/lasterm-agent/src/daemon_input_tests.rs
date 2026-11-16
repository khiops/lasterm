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
        // Full once the queue overflows, which the INPUT_DROPPED a test reads
        // later proves. A Linux PTY may still take a chunk or two after that:
        // the level is not exact.
        assert!(
            most >= TEST_BOUND / 2,
            "the queue of a terminal that takes no input held {most} bytes at most"
        );
        let queued = queued_bytes(daemon, &self.channel_id).await;
        assert!(
            queued > 0,
            "the queue of a terminal that takes no input emptied"
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
    let frames = hub
        .read_through(|frame| frame_type(frame) == "HEARTBEAT_ACK")
        .await;
    assert_eq!(
        drops_of(&frames, "doomed"),
        1,
        "its queue was full when it was destroyed"
    );
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

/// Read until `channel_id` has printed `marker`: its reader has processed it,
/// and published its modes before passing the output on (#1012).
#[cfg(unix)]
async fn read_until_printed(hub: &mut TestHub, channel_id: &str, marker: &str) {
    read_until_each_printed(hub, &[(channel_id, marker)]).await;
}

/// Read until each terminal has printed its marker. The output of every one
/// is kept as it comes, whichever prints first: a frame read while waiting for
/// another terminal is not lost.
#[cfg(unix)]
async fn read_until_each_printed(hub: &mut TestHub, waits: &[(&str, &str)]) {
    let mut printed: Vec<Vec<u8>> = vec![Vec::new(); waits.len()];
    let done = |printed: &[Vec<u8>]| {
        waits
            .iter()
            .zip(printed)
            .all(|((_, marker), out)| String::from_utf8_lossy(out).contains(marker))
    };
    tokio::time::timeout(DEADLINE, async {
        while !done(&printed) {
            let frame = hub.next_frame().await;
            for (index, (channel_id, _)) in waits.iter().enumerate() {
                if is_about(&frame, "OUTPUT", channel_id) {
                    printed[index].extend_from_slice(output_data(&frame));
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| {
        let missing: Vec<_> = waits
            .iter()
            .zip(&printed)
            .filter(|((_, marker), out)| !String::from_utf8_lossy(out).contains(marker))
            .map(|((channel_id, marker), _)| format!("{channel_id} ({marker})"))
            .collect();
        panic!("{} did not print within {DEADLINE:?}", missing.join(", "))
    });
}

/// The bytes a raw program wrote to `path` once it holds `len` of them.
#[cfg(unix)]
async fn raw_bytes(path: &Path, len: usize) -> Vec<u8> {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(bytes) = std::fs::read(path) {
                if bytes.len() >= len {
                    return bytes;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "{} did not get {len} bytes within {DEADLINE:?}",
            path.display()
        )
    })
}

/// The agent writes paste markers and cursor keys in the form the program
/// asked for, from what its reader saw, and follows the program changing it
/// (#1012). Unix only: ConPTY keeps a program's `?1h` to itself, and Windows
/// has no raw reader to record what reaches the program.
#[cfg(unix)]
#[tokio::test]
async fn input_reaches_the_program_in_the_form_it_asked_for() {
    let dir = scratch("input-modes");
    let first = dir.join("first");
    let second = dir.join("second");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    hub.spawn(spawn_running(
        "modes",
        &format!(
            "stty raw -echo; printf '\\033[?1h\\033[?2004hREADY'; head -c 16 > {}; printf '\\033[?2004lCLEARED'; head -c 1 > {}",
            first.display(),
            second.display()
        ),
    ))
    .await;
    read_until_printed(&mut hub, "modes", "READY").await;

    // Modes on: application cursor keys, and the markers kept.
    hub.send(&input("modes", b"\x1b[A\x1b[200~x\x1b[201~".to_vec()))
        .await;
    assert_eq!(raw_bytes(&first, 16).await, b"\x1bOA\x1b[200~x\x1b[201~");

    // Bracketed paste cleared by the program: the markers go.
    read_until_printed(&mut hub, "modes", "CLEARED").await;
    hub.send(&input("modes", b"\x1b[200~x\x1b[201~".to_vec()))
        .await;
    assert_eq!(raw_bytes(&second, 1).await, b"x");

    tear_down(&daemon, &dir).await;
}

/// Each terminal's input follows its own program's modes, not another's.
#[cfg(unix)]
#[tokio::test]
async fn each_terminal_adapts_its_input_to_its_own_program() {
    let dir = scratch("input-modes-two");
    let a = dir.join("a");
    let b = dir.join("b");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    hub.spawn(spawn_running(
        "with-decckm",
        &format!(
            "stty raw -echo; printf '\\033[?1hREADY'; head -c 3 > {}",
            a.display()
        ),
    ))
    .await;
    hub.spawn(spawn_running(
        "without",
        &format!(
            "stty raw -echo; printf 'READY'; head -c 3 > {}",
            b.display()
        ),
    ))
    .await;
    read_until_each_printed(&mut hub, &[("with-decckm", "READY"), ("without", "READY")]).await;

    hub.send(&input("with-decckm", b"\x1b[A".to_vec())).await;
    hub.send(&input("without", b"\x1b[A".to_vec())).await;
    assert_eq!(raw_bytes(&a, 3).await, b"\x1bOA");
    assert_eq!(raw_bytes(&b, 3).await, b"\x1b[A");

    tear_down(&daemon, &dir).await;
}

// ─── Pastes (#1014) ─────────────────────────────────────────────────────────
//
// A paste goes to a real terminal running `paste_reader` below, this test
// binary itself started through the PTY, which copies every byte it reads
// to a file: what the program got, markers included, byte for byte.

/// The reader's output file, and what it prints once it reads.
const PASTE_READER_OUT: &str = "LASTERM_TEST_PASTE_READER_OUT";
/// Set: the reader turns bracketed paste on (and application cursor keys)
/// before it reads.
const PASTE_READER_BRACKETED: &str = "LASTERM_TEST_PASTE_READER_BRACKETED";
/// Set to a count: the reader turns bracketed paste off once it has read that
/// many bytes, and prints `OFF`.
const PASTE_READER_OFF_AFTER: &str = "LASTERM_TEST_PASTE_READER_OFF_AFTER";
/// The chunk size and window the hub's panes use (`@lasterm/shared`).
const PASTE_CHUNK: usize = 32 * 1024;
const PASTE_WINDOW: usize = 8;

/// Not a test of its own: the program the paste tests start in a terminal.
/// Run without its variable, as in a plain test run, it does nothing.
#[test]
fn paste_reader() {
    let Some(out) = std::env::var_os(PASTE_READER_OUT) else {
        return;
    };
    use std::io::Write;
    let bracketed = std::env::var_os(PASTE_READER_BRACKETED).is_some();
    let off_after: Option<usize> = std::env::var(PASTE_READER_OFF_AFTER)
        .ok()
        .and_then(|n| n.parse().ok());
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out)
        .expect("open the reader's output");
    raw_input();
    let mut stdout = std::io::stdout();
    if bracketed {
        write!(stdout, "\x1b[?2004h\x1b[?1h").unwrap();
    }
    write!(stdout, "READY\r\n").unwrap();
    stdout.flush().unwrap();
    let mut total = 0usize;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = read_input(&mut buf);
        if n == 0 {
            return;
        }
        file.write_all(&buf[..n]).unwrap();
        file.flush().unwrap();
        let before = total;
        total += n;
        if let Some(limit) = off_after {
            if before < limit && total >= limit {
                write!(stdout, "\x1b[?2004lOFF\r\n").unwrap();
                stdout.flush().unwrap();
            }
        }
    }
}

/// The terminal's input, byte for byte: no echo, no line editing, nothing
/// translated.
#[cfg(unix)]
fn raw_input() {
    // SAFETY: a termios read and written back for this process's stdin.
    unsafe {
        let mut termios: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut termios) == 0 {
            libc::cfmakeraw(&mut termios);
            libc::tcsetattr(0, libc::TCSANOW, &termios);
        }
    }
}

#[cfg(unix)]
fn read_input(buf: &mut [u8]) -> usize {
    use std::io::Read;
    std::io::stdin().read(buf).unwrap_or(0)
}

#[cfg(windows)]
fn raw_input() {
    use windows_sys::Win32::System::Console::{
        GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_INPUT, STD_INPUT_HANDLE,
    };
    // SAFETY: the console mode of this process's own input handle.
    unsafe {
        SetConsoleMode(
            GetStdHandle(STD_INPUT_HANDLE),
            ENABLE_VIRTUAL_TERMINAL_INPUT,
        );
    }
}

#[cfg(windows)]
fn read_input(buf: &mut [u8]) -> usize {
    use windows_sys::Win32::Storage::FileSystem::ReadFile;
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
    let mut n: u32 = 0;
    // SAFETY: a read into `buf`, of at most its length, from our own stdin.
    let ok = unsafe {
        ReadFile(
            GetStdHandle(STD_INPUT_HANDLE),
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut n,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        0
    } else {
        n as usize
    }
}

/// A terminal running `paste_reader`, and the file it copies its input to.
struct PasteTerminal {
    channel_id: String,
    out: PathBuf,
}

impl PasteTerminal {
    async fn start(
        hub: &mut TestHub,
        dir: &Path,
        channel_id: &str,
        bracketed: bool,
        off_after: Option<usize>,
    ) -> Self {
        let out = dir.join(format!("{channel_id}.in"));
        let mut env = std::collections::HashMap::new();
        env.insert(PASTE_READER_OUT.to_string(), out.display().to_string());
        if bracketed {
            env.insert(PASTE_READER_BRACKETED.to_string(), "1".to_string());
        }
        if let Some(n) = off_after {
            env.insert(PASTE_READER_OFF_AFTER.to_string(), n.to_string());
        }
        let exe = std::env::current_exe().expect("this test binary");
        hub.spawn(HubToAgent::Spawn {
            request_id: format!("request-{channel_id}"),
            channel_id: Some(channel_id.to_string()),
            shell: Some(exe.display().to_string()),
            args: Some(vec![
                "--exact".into(),
                "daemon::input_tests::paste_reader".into(),
                "--nocapture".into(),
                "--test-threads=1".into(),
            ]),
            cwd: None,
            env: Some(env),
            cols: 120,
            rows: 30,
            direct_process: None,
            elevated: None,
            elevation_secret: None,
            elevation_method: None,
            custom_command: None,
            env_mode: "inherit".to_string(),
            env_unset: None,
            login_shell: None,
            report_directory: None,
        })
        .await;
        read_output_until(hub, channel_id, "READY").await;
        Self {
            channel_id: channel_id.to_string(),
            out,
        }
    }

    /// What the program has read, once it holds at least `len` bytes, and
    /// after a moment for anything that should not come.
    async fn read(&self, len: usize) -> Vec<u8> {
        let deadline = tokio::time::Instant::now() + DEADLINE;
        loop {
            let got = std::fs::read(&self.out).unwrap_or_default();
            if got.len() >= len {
                tokio::time::sleep(Duration::from_millis(300)).await;
                return std::fs::read(&self.out).unwrap_or_default();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the program read {} of {len} bytes within {DEADLINE:?}",
                got.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// What the program has read once it holds `len` bytes, or what it holds
    /// when `limit` runs out; never fails.
    async fn read_within_or_short(&self, len: usize, limit: Duration) -> Vec<u8> {
        let deadline = tokio::time::Instant::now() + limit;
        while tokio::time::Instant::now() < deadline {
            if std::fs::read(&self.out).unwrap_or_default().len() >= len {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::read(&self.out).unwrap_or_default()
    }
}

/// Read until `channel_id` has printed `text`.
async fn read_output_until(hub: &mut TestHub, channel_id: &str, text: &str) {
    let mut printed = Vec::new();
    while !String::from_utf8_lossy(&printed).contains(text) {
        let frame = tokio::time::timeout(DEADLINE, hub.next_frame())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "{channel_id} did not print {text:?}; it printed {:?}",
                    String::from_utf8_lossy(&printed)
                )
            });
        if is_about(&frame, "OUTPUT", channel_id) {
            printed.extend_from_slice(output_data(&frame));
        }
    }
}

fn paste_chunk(channel_id: &str, paste_id: u32, seq: u32, data: &[u8], last: bool) -> HubToAgent {
    HubToAgent::Paste {
        channel_id: channel_id.to_string(),
        paste_id,
        seq,
        data: data.to_vec(),
        last,
    }
}

/// Send `data` as paste `paste_id` the way a pane does: chunks of
/// `PASTE_CHUNK`, never more than `PASTE_WINDOW` unacknowledged; then wait for
/// the last chunk's PASTE_ACK. Returns the frames read.
async fn paste_paced(
    hub: &mut TestHub,
    channel_id: &str,
    paste_id: u32,
    data: &[u8],
) -> Vec<rmpv::Value> {
    let chunks: Vec<&[u8]> = data.chunks(PASTE_CHUNK).collect();
    let mut frames = Vec::new();
    let mut acked = 0usize;
    let mut sent = 0usize;
    while acked < chunks.len() {
        while sent < chunks.len() && sent - acked < PASTE_WINDOW {
            let last = sent + 1 == chunks.len();
            hub.send(&paste_chunk(
                channel_id,
                paste_id,
                sent as u32,
                chunks[sent],
                last,
            ))
            .await;
            sent += 1;
        }
        let frame = tokio::time::timeout(DEADLINE, hub.next_frame())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "no PASTE_ACK within {DEADLINE:?}: {acked} of {} acknowledged",
                    chunks.len()
                )
            });
        if is_about(&frame, "PASTE_ACK", channel_id) {
            assert_eq!(
                frame["seq"].as_u64(),
                Some(acked as u64),
                "acknowledged in order"
            );
            acked += 1;
        }
        assert!(
            !is_about(&frame, "PASTE_CLOSED", channel_id),
            "the paste was closed: {frame:?}"
        );
        frames.push(frame);
    }
    frames
}

/// 2 MiB: cursor keys in both forms, then a counting pattern, every 8-byte
/// group the offset it starts at.
fn paste_text() -> Vec<u8> {
    let mut data = b"\x1b[A\x1bOA".to_vec();
    while data.len() < 2 * 1024 * 1024 {
        let offset = data.len();
        data.extend_from_slice(format!("{:07}\n", offset % 10_000_000).as_bytes());
    }
    data.truncate(2 * 1024 * 1024);
    data
}

/// PS1: a paste larger than the queue's bound reaches the program whole and
/// unchanged, between one start and one end marker, sent as a pane sends it.
/// Its cursor keys are not rewritten: #1012's `adapt` is not applied to it.
#[tokio::test]
async fn a_paste_larger_than_the_queue_reaches_the_pty_whole() {
    let dir = scratch("paste-whole");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    let terminal = PasteTerminal::start(&mut hub, &dir, "paste-whole", true, None).await;
    let data = paste_text();
    assert!(data.len() > crate::input::INPUT_QUEUE_BYTES);
    paste_paced(&mut hub, &terminal.channel_id, 1, &data).await;
    let expected = [crate::input::PASTE_START, &data, crate::input::PASTE_END].concat();
    let got = terminal.read(expected.len()).await;
    assert!(
        got == expected,
        "{} bytes read, {} expected; first difference at {:?}",
        got.len(),
        expected.len(),
        got.iter().zip(&expected).position(|(a, b)| a != b)
    );
    tear_down(&daemon, &dir).await;
}

/// PS2: the same to a program without bracketed paste: no marker.
#[tokio::test]
async fn a_paste_to_a_program_without_bracketed_paste_has_no_markers() {
    let dir = scratch("paste-plain");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    let terminal = PasteTerminal::start(&mut hub, &dir, "paste-plain", false, None).await;
    let data = paste_text();
    paste_paced(&mut hub, &terminal.channel_id, 1, &data).await;
    let got = terminal.read(data.len()).await;
    assert!(
        got == data,
        "{} bytes read, {} expected",
        got.len(),
        data.len()
    );
    tear_down(&daemon, &dir).await;
}

/// PS3: the program turning bracketed paste off before the last chunk does
/// not change the paste: it still ends with its end marker.
#[tokio::test]
async fn bracketing_is_decided_at_a_pastes_first_chunk() {
    let dir = scratch("paste-decided");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    let terminal =
        PasteTerminal::start(&mut hub, &dir, "paste-decided", true, Some(PASTE_CHUNK)).await;
    let first = vec![b'a'; PASTE_CHUNK];
    hub.send(&paste_chunk(&terminal.channel_id, 1, 0, &first, false))
        .await;
    // The program read the first chunk and turned bracketed paste off.
    read_output_until(&mut hub, &terminal.channel_id, "OFF").await;
    hub.send(&paste_chunk(&terminal.channel_id, 1, 1, b"bb", true))
        .await;
    let expected = [
        crate::input::PASTE_START,
        &first,
        b"bb",
        crate::input::PASTE_END,
    ]
    .concat();
    assert_eq!(terminal.read(expected.len()).await, expected);
    tear_down(&daemon, &dir).await;
}

/// A bracketed paste opened by `hub`, its first chunk taken by the program.
async fn open_paste(hub: &mut TestHub, terminal: &PasteTerminal, paste_id: u32) {
    hub.send(&paste_chunk(
        &terminal.channel_id,
        paste_id,
        0,
        b"first",
        false,
    ))
    .await;
    hub.read_through(|frame| is_about(frame, "PASTE_ACK", &terminal.channel_id))
        .await;
}

/// PS10 connection ends, next connection: a daemon connection ending closes
/// its paste; the hub's next connection cannot carry it on.
#[tokio::test]
async fn a_connection_that_ends_closes_its_paste() {
    let dir = scratch("paste-conn-end");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
    let terminal = PasteTerminal::start(&mut hub, &dir, "paste-conn-end", true, None).await;
    open_paste(&mut hub, &terminal, 1).await;
    drop(hub); // EOF: its handler ends
    let expected = [crate::input::PASTE_START, b"first", crate::input::PASTE_END].concat();
    assert_eq!(terminal.read(expected.len()).await, expected);

    let mut next = TestHub::connect(&daemon, KEY_A, 2).await;
    next.send(&paste_chunk(&terminal.channel_id, 1, 1, b"more", true))
        .await;
    let frames = next
        .read_through(|frame| is_about(frame, "PASTE_CLOSED", &terminal.channel_id))
        .await;
    assert_eq!(frames.last().unwrap()["reason"].as_str(), Some("unknown"));
    assert_eq!(
        terminal.read(expected.len()).await,
        expected,
        "nothing more reached it"
    );
    tear_down(&daemon, &dir).await;
}

/// How soon a key typed after a paste's close reaches the program (#1030).
const TYPED_WITHIN: Duration = Duration::from_secs(5);

/// PS10 displaced, input of the new connection: a connection displaced by a
/// newer one of its hub has its paste closed when it is displaced, even if
/// its own handler never reaches its end; what the new one types follows the
/// end marker, and reaches the program at once.
///
/// #1030 AC7: on Windows 26100 conhost could hold that key until more input
/// came, about once in 30 here; 150 runs miss it with odds near 1 %.
#[tokio::test]
async fn a_displaced_connections_paste_closes_before_the_new_connection_types() {
    for run in 0..150 {
        let name = format!("paste-displaced-{run}");
        let dir = scratch(&name);
        let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
        let mut old = TestHub::connect(&daemon, KEY_A, 1).await;
        let terminal = PasteTerminal::start(&mut old, &dir, &name, true, None).await;
        open_paste(&mut old, &terminal, 1).await;
        // Its handler never runs its end: only the displacement can close it.
        old.abort();
        let mut new = TestHub::connect(&daemon, KEY_A, 2).await;
        new.send(&input(&terminal.channel_id, b"x".to_vec())).await;
        let expected = [
            crate::input::PASTE_START,
            b"first",
            crate::input::PASTE_END,
            b"x",
        ]
        .concat();
        let got = terminal
            .read_within_or_short(expected.len(), TYPED_WITHIN)
            .await;
        // Torn down first: a failed run leaves no terminal behind.
        tear_down(&daemon, &dir).await;
        assert_eq!(got, expected, "run {run}");
    }
}

/// PS10 stale frames and stale INPUT: what a displaced connection still had
/// to dispatch reaches no terminal and leaves the new connection's paste
/// unbroken.
#[tokio::test]
async fn a_displaced_connections_frames_are_dropped() {
    let dir = scratch("paste-stale");
    let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
    let mut hub = TestHub::connect(&daemon, KEY_A, 2).await;
    let terminal = PasteTerminal::start(&mut hub, &dir, "paste-stale", true, None).await;
    open_paste(&mut hub, &terminal, 7).await;

    // A connection of the same hub, displaced, dispatching what it had read.
    let (displace, displaced) = tokio::sync::watch::channel(true);
    let stale = crate::handler::ConnectionRef::daemon(1, displaced);
    let (frame_tx, _frames) = tokio::sync::mpsc::unbounded_channel();
    for msg in [
        paste_chunk(&terminal.channel_id, 7, 1, b"STALE", false),
        paste_chunk(&terminal.channel_id, 3, 0, b"STALE", true),
        input(&terminal.channel_id, b"STALE".to_vec()),
        HubToAgent::PasteCancel {
            channel_id: terminal.channel_id.clone(),
            paste_id: 7,
        },
    ] {
        handle_message(
            msg,
            &OwnerId::from_hub_key(KEY_A),
            &stale,
            Arc::clone(&daemon.pty_manager),
            frame_tx.clone(),
            daemon.channel_events.clone(),
            Arc::clone(&daemon.cmd_senders),
        )
        .await
        .expect("a displaced connection's frame is handled");
    }
    drop(displace);

    hub.send(&paste_chunk(&terminal.channel_id, 7, 1, b"second", true))
        .await;
    hub.read_through(|frame| is_about(frame, "PASTE_ACK", &terminal.channel_id))
        .await;
    let expected = [
        crate::input::PASTE_START,
        b"first",
        b"second",
        crate::input::PASTE_END,
    ]
    .concat();
    assert_eq!(terminal.read(expected.len()).await, expected);
    tear_down(&daemon, &dir).await;
}

/// PS5 through the agent's frames: a PASTE_CANCEL from the connection that
/// owns the paste closes it for the program, end marker included, and answers
/// PASTE_CLOSED `cancelled` with how much of it went; what is typed after
/// follows the end marker, and reaches the program at once.
///
/// #1030 AC7: on Windows 26100 conhost could hold that key until more input
/// came, about once in 10 here; 50 runs miss it with odds near 0.5 %.
#[tokio::test]
async fn a_paste_cancelled_by_its_connection_is_closed_for_the_program() {
    for run in 0..50 {
        let name = format!("paste-cancel-{run}");
        let dir = scratch(&name);
        let daemon = input_daemon(crate::input::INPUT_QUEUE_BYTES);
        let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;
        let terminal = PasteTerminal::start(&mut hub, &dir, &name, true, None).await;
        open_paste(&mut hub, &terminal, 4).await;

        hub.send(&HubToAgent::PasteCancel {
            channel_id: terminal.channel_id.clone(),
            paste_id: 4,
        })
        .await;
        let frames = hub
            .read_through(|frame| is_about(frame, "PASTE_CLOSED", &terminal.channel_id))
            .await;
        let closed = frames.last().unwrap();
        assert_eq!(closed["paste_id"].as_u64(), Some(4));
        assert_eq!(closed["reason"].as_str(), Some("cancelled"));
        assert_eq!(closed["written"].as_u64(), Some(5));
        hub.send(&input(&terminal.channel_id, b"x".to_vec())).await;

        let expected = [
            crate::input::PASTE_START,
            b"first",
            crate::input::PASTE_END,
            b"x",
        ]
        .concat();
        let got = terminal
            .read_within_or_short(expected.len(), TYPED_WITHIN)
            .await;
        // Torn down first: a failed run leaves no terminal behind.
        tear_down(&daemon, &dir).await;
        assert_eq!(got, expected, "run {run}");
    }
}
