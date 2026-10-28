//! A hub that stops reading holds back its own terminals and nothing else, and
//! a hub that is away keeps each of its terminals' newest output (#553).
//!
//! Connections run over in-memory streams whose buffer stands for a socket's:
//! a test hub that stops reading fills it, and the daemon's writer then waits,
//! as it does on a socket nobody drains. The terminals are real.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::*;
use crate::away::{AWAY_BYTES_PER_CHANNEL as AWAY_PER_CHANNEL, AWAY_BYTES_PER_HUB as AWAY_PER_HUB};

// ── What these tests read of the daemon ─────────────────────────────────────

/// Marks far below the daemon's, so that a test needs little output to reach
/// them.
const TEST_MARKS: Marks = Marks {
    high: 64 * 1024,
    low: 16 * 1024,
};

/// A daemon's shared state with the pipeline a real one runs, no listener and
/// no token.
fn backpressure_daemon(marks: Marks) -> DaemonShared {
    DaemonShared::with_pipeline(
        None,
        Arc::new(Mutex::new(PtyManager::new())),
        shutdown_channel().1,
        marks,
    )
}

/// The bytes the daemon holds for `owner`'s connection: read from its
/// terminals and not yet written to it.
fn pending_bytes(daemon: &DaemonShared, owner: &OwnerId) -> usize {
    daemon.channel_events.flow(owner).pending()
}

/// Route a frame of `channel_id` to `owner`, which has no connection.
fn away(routes: &mut HubRoutes, owner: &OwnerId, channel_id: &str, frame: Vec<u8>) {
    routes.route(owner, channel_id, frame, None);
}

/// What `owner`'s next connection is sent first, in order.
fn come_back(routes: &mut HubRoutes, owner: &OwnerId) -> Vec<Vec<u8>> {
    routes
        .queues
        .remove(owner)
        .map(|queue| queue.drain().0)
        .unwrap_or_default()
}

// ── Terminals ───────────────────────────────────────────────────────────────

/// What the daemon may hold beyond the high mark for one hub: each of its
/// terminals reads one more chunk before it sees the mark, and frames carry an
/// envelope.
const SLACK: usize = 16 * 1024;
/// The in-memory stream's own buffer, standing for a socket's.
const STREAM_BUFFER: usize = 16 * 1024;
/// Lines a producer prints, 8 bytes each: 1 MiB, more than twice what fits
/// between a PTY and a hub that reads nothing (the marks, the stream, the PTY's
/// own buffers, and up to 256 KiB in ConPTY's pump on Windows).
const LINES: usize = 128 * 1024;
const DEADLINE: Duration = Duration::from_secs(60);
/// How long a terminal is watched between two looks at its screen, while its
/// hub reads nothing.
const HOLD: Duration = Duration::from_millis(1000);

const KEY_A: &str = "backpressure-hub-a";
const KEY_B: &str = "backpressure-hub-b";

/// A directory of its own for a test's files.
fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lasterm-backpressure-{label}-{}",
        ulid::Ulid::generate().to_string().to_lowercase()
    ));
    std::fs::create_dir_all(&dir).expect("create the test directory");
    dir
}

/// A file of `LINES` numbered lines, 1 to LINES, seven digits each.
fn numbered_file(dir: &Path) -> PathBuf {
    let path = dir.join("numbers.txt");
    let mut text = String::with_capacity(LINES * 8);
    for n in 1..=LINES {
        text.push_str(&format!("{n:07}\n"));
    }
    std::fs::write(&path, text).expect("write the numbered file");
    path
}

/// SPAWN a shell running `command` and ending with it.
fn spawn_running(channel_id: &str, command: &str) -> HubToAgent {
    let (shell, run) = if cfg!(windows) {
        ("cmd.exe", "/C")
    } else {
        ("/bin/sh", "-c")
    };
    spawn_shell(
        channel_id,
        shell,
        Some(vec![run.to_string(), command.to_string()]),
    )
}

/// SPAWN an interactive shell, which waits for what it is typed.
fn spawn_interactive(channel_id: &str) -> HubToAgent {
    let shell = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
    spawn_shell(channel_id, shell, None)
}

fn spawn_shell(channel_id: &str, shell: &str, args: Option<Vec<String>>) -> HubToAgent {
    HubToAgent::Spawn {
        request_id: format!("request-{channel_id}"),
        channel_id: Some(channel_id.to_string()),
        shell: Some(shell.to_string()),
        args,
        cwd: None,
        env: None,
        cols: 80,
        rows: 24,
        direct_process: None,
        elevated: None,
        elevation_secret: None,
        elevation_method: None,
        custom_command: None,
        env_mode: None,
        env_unset: None,
        login_shell: None,
    }
}

/// Print the numbered file, then write `done`: `done` exists once the program
/// has written everything to its terminal.
fn print_then_mark(numbers: &Path, done: &Path) -> String {
    if cfg!(windows) {
        format!("type {} & echo done> {}", numbers.display(), done.display())
    } else {
        format!(
            "cat '{}'; echo done > '{}'",
            numbers.display(),
            done.display()
        )
    }
}

/// SPAWN a shell that prints the numbered file in the background, then
/// `done`, while the shell itself waits for a line and writes it to `typed`.
fn print_meanwhile_read_a_line(
    channel_id: &str,
    numbers: &Path,
    done: &Path,
    typed: &Path,
) -> HubToAgent {
    if cfg!(windows) {
        // `^&` and `^>` reach the inner cmd.exe as they are. `!line!` is read
        // when it runs, not when the line is parsed, as `%line%` would be.
        let command = format!(
            "start /b cmd /c type {} ^& echo done^> {} & set /p line= & echo !line!> {}",
            numbers.display(),
            done.display(),
            typed.display()
        );
        let args = vec!["/V:ON".to_string(), "/C".to_string(), command];
        spawn_shell(channel_id, "cmd.exe", Some(args))
    } else {
        let command = format!(
            "(cat '{}'; echo done > '{}') & read line; echo \"$line\" > '{}'; wait",
            numbers.display(),
            done.display(),
            typed.display()
        );
        spawn_running(channel_id, &command)
    }
}

/// SPAWN a shell that waits for a line and writes it to `typed`.
fn read_a_line(channel_id: &str, typed: &Path) -> HubToAgent {
    if cfg!(windows) {
        let command = format!("set /p line= & echo !line!> {}", typed.display());
        let args = vec!["/V:ON".to_string(), "/C".to_string(), command];
        spawn_shell(channel_id, "cmd.exe", Some(args))
    } else {
        spawn_running(
            channel_id,
            &format!("read line; echo \"$line\" > '{}'", typed.display()),
        )
    }
}

/// A line that makes a shell print `text`, which the line itself does not
/// contain: the terminal echoes what is typed.
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

/// What a terminal shows of these bytes: its escape sequences left out.
fn visible(bytes: &[u8]) -> Vec<u8> {
    let mut shown = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            shown.push(bytes[i]);
            i += 1;
            continue;
        }
        match bytes.get(i + 1) {
            // CSI: parameters, then one final byte.
            Some(b'[') => {
                i += 2;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                i += 1;
            }
            // OSC: up to BEL or ST.
            Some(b']') => {
                i += 2;
                while i < bytes.len() && bytes[i] != 0x07 && bytes[i] != 0x1b {
                    i += 1;
                }
                i += if bytes.get(i) == Some(&0x1b) { 2 } else { 1 };
            }
            _ => i += 2,
        }
    }
    shown
}

/// The numbers a terminal printed of the numbered file, in the order shown.
fn numbers_shown(output: &[u8]) -> Vec<usize> {
    let shown = visible(output);
    shown
        .split(|b| !b.is_ascii_digit())
        .filter(|run| run.len() == 7)
        .map(|run| {
            std::str::from_utf8(run)
                .expect("digits are UTF-8")
                .parse()
                .expect("seven digits are a number")
        })
        .collect()
}

/// The hub's end of an in-memory connection to the daemon.
struct TestHub {
    stream: DuplexStream,
    received: Vec<u8>,
    _handler: tokio::task::JoinHandle<()>,
}

impl TestHub {
    /// Connect as the hub `key` names, and read up to CHANNEL_STATE_END.
    async fn connect(daemon: &DaemonShared, key: &str, connection_id: u64) -> Self {
        let (client, server) = tokio::io::duplex(STREAM_BUFFER);
        let handler = tokio::spawn(handle_connection_inner(
            server,
            daemon.clone(),
            connection_id,
        ));
        let mut hub = Self {
            stream: client,
            received: Vec::new(),
            _handler: handler,
        };
        // This daemon has no token: a hub sends an empty one (#127).
        hub.send(&HubToAgent::Auth {
            token: String::new(),
            hub_key: Some(key.to_string()),
        })
        .await;
        hub.read_through(|frame| frame_type(frame) == "CHANNEL_STATE_END")
            .await;
        hub
    }

    async fn send(&mut self, msg: &HubToAgent) {
        let frame = encode_frame(msg).expect("encode a hub frame");
        tokio::time::timeout(DEADLINE, self.stream.write_all(&frame))
            .await
            .expect("the daemon reads what its hub sends, however full its output is")
            .expect("write to the daemon");
    }

    /// The next frame. Cancelling it loses nothing: a partial frame stays in
    /// `received`.
    async fn next_frame(&mut self) -> rmpv::Value {
        loop {
            if self.received.len() >= 4 {
                let len = u32::from_le_bytes(self.received[..4].try_into().unwrap()) as usize;
                if self.received.len() >= 4 + len {
                    let frame = rmp_serde::from_slice(&self.received[4..4 + len])
                        .expect("decode a daemon frame");
                    self.received.drain(..4 + len);
                    return frame;
                }
            }
            let mut buf = vec![0u8; 64 * 1024];
            let n = self
                .stream
                .read(&mut buf)
                .await
                .expect("read from the daemon");
            assert!(n > 0, "the daemon closed this connection");
            self.received.extend_from_slice(&buf[..n]);
        }
    }

    /// Read up to the first frame `last` accepts, and return every frame read,
    /// that one included.
    async fn read_through(&mut self, last: impl Fn(&rmpv::Value) -> bool) -> Vec<rmpv::Value> {
        let mut frames = Vec::new();
        loop {
            let frame = tokio::time::timeout(DEADLINE, self.next_frame())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "the frame awaited did not come within {DEADLINE:?}; received {:?}",
                        frames.iter().map(frame_type).collect::<Vec<_>>()
                    )
                });
            let done = last(&frame);
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }

    /// SPAWN, and read up to its SPAWN_OK.
    async fn spawn(&mut self, spawn: HubToAgent) {
        let HubToAgent::Spawn {
            channel_id: Some(channel_id),
            ..
        } = &spawn
        else {
            panic!("a SPAWN with a channel id");
        };
        let channel_id = channel_id.clone();
        self.send(&spawn).await;
        self.read_through(|frame| is_about(frame, "SPAWN_OK", &channel_id))
            .await;
    }

    /// Have an interactive shell print `text`, and read until it has.
    async fn print(&mut self, channel_id: &str, text: &str) {
        self.send(&input(channel_id, prints(text))).await;
        let mut printed = Vec::new();
        while !String::from_utf8_lossy(&visible(&printed)).contains(text) {
            let frame = tokio::time::timeout(DEADLINE, self.next_frame())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "{channel_id} did not print {text:?} within {DEADLINE:?}; it printed {:?}",
                        String::from_utf8_lossy(&printed)
                    )
                });
            if is_about(&frame, "OUTPUT", channel_id) {
                printed.extend_from_slice(output_data(&frame));
            }
        }
    }

    /// Read everything up to `channel_id`'s exit, and return what it printed.
    async fn output_until_exit(&mut self, channel_id: &str) -> Vec<u8> {
        let frames = self
            .read_through(|frame| is_about(frame, "CHANNEL_EXIT", channel_id))
            .await;
        let seqs: Vec<u64> = frames
            .iter()
            .filter(|frame| is_about(frame, "OUTPUT", channel_id))
            .filter_map(|frame| frame["seq"].as_u64())
            .collect();
        assert!(
            seqs.windows(2).all(|pair| pair[0] < pair[1]),
            "OUTPUT seqs must only grow"
        );
        frames
            .iter()
            .filter(|frame| is_about(frame, "OUTPUT", channel_id))
            .flat_map(|frame| output_data(frame).iter().copied())
            .collect()
    }
}

fn frame_type(frame: &rmpv::Value) -> &str {
    frame["type"].as_str().unwrap_or("")
}

fn is_about(frame: &rmpv::Value, kind: &str, channel_id: &str) -> bool {
    frame_type(frame) == kind && frame["channel_id"].as_str() == Some(channel_id)
}

fn output_data(frame: &rmpv::Value) -> &[u8] {
    match &frame["data"] {
        rmpv::Value::Binary(data) => data,
        _ => &[],
    }
}

/// The last number the daemon's screen model of `channel_id` shows: how far
/// the daemon has read that terminal. The reader answers this whether or not
/// it is reading its terminal. A terminal whose reader is gone has ended,
/// having printed everything.
async fn last_number_on_screen(daemon: &DaemonShared, channel_id: &str) -> usize {
    let Some(reader) = daemon.cmd_senders.lock().await.get(channel_id).cloned() else {
        return LINES;
    };
    let (reply, screen) = oneshot::channel();
    reader
        .send(crate::handler::ChannelCommand::Snapshot(reply))
        .unwrap_or_else(|_| panic!("the reader of {channel_id} is gone"));
    let screen = tokio::time::timeout(DEADLINE, screen)
        .await
        .expect("the reader answers while its output is held back")
        .expect("the reader replies");
    numbers_shown(screen.serialized.as_bytes())
        .into_iter()
        .max()
        .unwrap_or(0)
}

/// Watch `owner`'s connection read nothing while its terminal `channel_id`
/// has far more to print than fits anywhere in between. The daemon must stop
/// reading that terminal, so that its screen stops moving short of the end and
/// the program stays blocked, `done` never written; and it must hold no more
/// than the high mark for that connection, give or take a read per terminal.
async fn held_back(daemon: &DaemonShared, owner: &OwnerId, channel_id: &str, done: &Path) {
    let mut most = 0;
    let watch = |most: &mut usize| {
        *most = (*most).max(pending_bytes(daemon, owner));
    };
    // The terminals stop at the high mark. The writer may still move up to
    // the stream's buffer onto the stream afterwards, so what the daemon is
    // seen to hold can settle that much lower. The buffer is smaller than the
    // gap between the marks: filling it cannot resume them.
    const { assert!(STREAM_BUFFER < TEST_MARKS.high - TEST_MARKS.low) };
    let stopped_at = TEST_MARKS.high - STREAM_BUFFER;
    // Until what the daemon holds has reached that and stopped moving: a
    // terminal that prints, however slowly, keeps it moving. On Linux the
    // whole climb takes less than a look, on Windows ConPTY takes its time.
    const STEADY: Duration = Duration::from_millis(500);
    let settle = tokio::time::Instant::now() + DEADLINE;
    let mut last = usize::MAX;
    let mut steady_since = tokio::time::Instant::now();
    while !done.exists() && tokio::time::Instant::now() < settle {
        let now = pending_bytes(daemon, owner);
        most = most.max(now);
        if now != last {
            last = now;
            steady_since = tokio::time::Instant::now();
        } else if now >= stopped_at && steady_since.elapsed() >= STEADY {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let before = last_number_on_screen(daemon, channel_id).await;
    let until = tokio::time::Instant::now() + HOLD;
    while tokio::time::Instant::now() < until {
        watch(&mut most);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let after = last_number_on_screen(daemon, channel_id).await;

    assert!(
        !done.exists() && after < LINES,
        "the program wrote everything to its terminal while its hub read nothing \
         (the screen shows line {after} of {LINES}): the daemon kept reading that terminal"
    );
    assert_eq!(
        before, after,
        "the daemon kept reading a terminal whose hub reads nothing: its screen moved \
         from line {before} to line {after}"
    );
    assert!(
        most <= TEST_MARKS.high + SLACK,
        "the daemon held {most} bytes for a hub that reads nothing"
    );
    assert!(
        most >= stopped_at,
        "the daemon held at most {most} bytes, short of the high mark: the terminal never filled it"
    );
}

/// Every number of the file, once each, in order.
fn assert_complete_and_in_order(output: &[u8]) {
    let shown = numbers_shown(output);
    let expected: Vec<usize> = (1..=LINES).collect();
    if shown != expected {
        let first_wrong = shown
            .iter()
            .zip(&expected)
            .position(|(got, want)| got != want)
            .unwrap_or(shown.len().min(expected.len()));
        panic!(
            "{} numbers arrived of {LINES}; the first out of place is at {first_wrong}: {:?}",
            shown.len(),
            shown.get(first_wrong.saturating_sub(2)..(first_wrong + 3).min(shown.len()))
        );
    }
}

async fn wait_for_file(path: &Path) -> String {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if !text.trim().is_empty() {
                    return text;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} was not written within {DEADLINE:?}", path.display()))
}

async fn tear_down(daemon: &DaemonShared, dir: &Path) {
    daemon.pty_manager.lock().await.destroy_all().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// A hub that reads nothing stops its terminal: the program blocks, as on a
/// real terminal nobody reads, and the daemon holds no more than the high mark
/// for it. It used to read on, into memory, for as long as the program
/// printed. Once the hub reads again, the terminal resumes, and everything it
/// printed arrives, once, in order.
#[tokio::test]
async fn a_hub_that_stops_reading_stops_its_terminal_until_it_reads_again() {
    let dir = scratch("stall");
    let numbers = numbered_file(&dir);
    let done = dir.join("done");
    let daemon = backpressure_daemon(TEST_MARKS);
    let owner = OwnerId::from_hub_key(KEY_A);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;

    hub.spawn(spawn_running("stalled", &print_then_mark(&numbers, &done)))
        .await;
    held_back(&daemon, &owner, "stalled", &done).await;

    let output = hub.output_until_exit("stalled").await;
    assert_complete_and_in_order(&output);
    wait_for_file(&done).await;
    // The writer lets go of a frame's charge just after writing it.
    tokio::time::timeout(DEADLINE, async {
        while pending_bytes(&daemon, &owner) != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("everything read is written, and the daemon holds nothing more");

    tear_down(&daemon, &dir).await;
}

/// A hub that reads nothing holds back its own terminals only: another hub's
/// terminal on the same daemon prints and is read as usual (#127).
#[tokio::test]
async fn a_hub_that_stops_reading_holds_back_no_other_hub() {
    let dir = scratch("other-hub");
    let numbers = numbered_file(&dir);
    let done = dir.join("done");
    let daemon = backpressure_daemon(TEST_MARKS);
    let owner_a = OwnerId::from_hub_key(KEY_A);
    let mut a = TestHub::connect(&daemon, KEY_A, 1).await;
    let mut b = TestHub::connect(&daemon, KEY_B, 2).await;

    b.spawn(spawn_interactive("flowing")).await;
    a.spawn(spawn_running("stalled", &print_then_mark(&numbers, &done)))
        .await;
    held_back(&daemon, &owner_a, "stalled", &done).await;

    for round in 0..5 {
        b.print("flowing", &format!("still-flowing-{round}")).await;
    }
    assert!(
        !done.exists(),
        "the stalled hub's terminal stays blocked meanwhile"
    );

    tear_down(&daemon, &dir).await;
}

/// A line typed and Enter.
fn typed_line(text: &str) -> Vec<u8> {
    let enter = if cfg!(windows) { "\r" } else { "\n" };
    format!("{text}{enter}").into_bytes()
}

/// Read whatever comes until `path` is written, and return what it holds.
async fn read_until_written(hub: &mut TestHub, path: &Path) -> String {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if !text.trim().is_empty() {
                    return text;
                }
            }
            let _ = tokio::time::timeout(Duration::from_millis(20), hub.next_frame()).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} was not written within {DEADLINE:?}", path.display()))
}

/// What a hub types reaches its terminals while their output is held back:
/// backpressure stops reading a terminal, never writing to it, and the
/// connection's requests are not held up behind its output.
///
/// On Unix the held-back terminal's shell reads the line at once. ConPTY takes
/// no input while its own output is blocked: the agent writes the line all the
/// same, and the shell reads it as soon as the hub reads again.
#[tokio::test]
async fn input_reaches_a_terminal_whose_output_is_held_back() {
    let dir = scratch("input");
    let numbers = numbered_file(&dir);
    let done = dir.join("done");
    let typed = dir.join("typed");
    let typed_idle = dir.join("typed-idle");
    let daemon = backpressure_daemon(TEST_MARKS);
    let owner = OwnerId::from_hub_key(KEY_A);
    let mut hub = TestHub::connect(&daemon, KEY_A, 1).await;

    hub.spawn(read_a_line("idle", &typed_idle)).await;
    hub.spawn(print_meanwhile_read_a_line(
        "stalled", &numbers, &done, &typed,
    ))
    .await;
    held_back(&daemon, &owner, "stalled", &done).await;

    hub.send(&input("stalled", typed_line("typed-while-held")))
        .await;
    hub.send(&input("idle", typed_line("typed-to-idle"))).await;
    let got = wait_for_file(&typed_idle).await;
    assert!(
        got.contains("typed-to-idle"),
        "the idle shell, held back with the other, read {got:?}"
    );

    let got = if cfg!(windows) {
        read_until_written(&mut hub, &typed).await
    } else {
        let got = wait_for_file(&typed).await;
        assert!(
            !done.exists(),
            "its output is still held back, and its program still blocked"
        );
        got
    };
    assert!(
        got.contains("typed-while-held"),
        "the held-back shell read {got:?}"
    );

    tear_down(&daemon, &dir).await;
}

/// A hub whose connection stalls and that connects again is not held back by
/// what its previous connection never wrote: that one no longer counts.
#[tokio::test]
async fn a_hub_that_connects_again_is_not_held_back_by_its_stalled_connection() {
    let dir = scratch("reconnect");
    let numbers = numbered_file(&dir);
    let done = dir.join("done");
    let daemon = backpressure_daemon(TEST_MARKS);
    let owner = OwnerId::from_hub_key(KEY_A);
    let mut stalled = TestHub::connect(&daemon, KEY_A, 1).await;

    stalled
        .spawn(spawn_running("printing", &print_then_mark(&numbers, &done)))
        .await;
    held_back(&daemon, &owner, "printing", &done).await;

    // The stalled connection stays open, its writer stuck on it.
    let mut again = TestHub::connect(&daemon, KEY_A, 2).await;
    let output = again.output_until_exit("printing").await;
    assert_eq!(
        numbers_shown(&output).last(),
        Some(&LINES),
        "the terminal printed to its end for the connection that reads"
    );
    wait_for_file(&done).await;
    drop(stalled);

    tear_down(&daemon, &dir).await;
}

// ── While a hub is away ─────────────────────────────────────────────────────

/// A frame of `len` bytes saying which channel sent it, and its rank there.
fn tagged(channel_id: &str, rank: usize, len: usize) -> Vec<u8> {
    let mut frame = format!("{channel_id}:{rank}:").into_bytes();
    frame.resize(len, b'.');
    frame
}

/// The (channel, rank) of every frame, in the order given.
fn tags(frames: &[Vec<u8>]) -> Vec<(String, usize)> {
    frames
        .iter()
        .map(|frame| {
            let text = String::from_utf8_lossy(frame);
            let mut parts = text.split(':');
            let channel = parts.next().unwrap_or("").to_string();
            let rank = parts.next().and_then(|r| r.parse().ok()).unwrap_or(0);
            (channel, rank)
        })
        .collect()
}

fn ranks_of(tags: &[(String, usize)], channel_id: &str) -> Vec<usize> {
    tags.iter()
        .filter(|(channel, _)| channel == channel_id)
        .map(|(_, rank)| *rank)
        .collect()
}

const FRAME: usize = 4096;

/// One busy terminal does not push out another's output while their hub is
/// away. The queue used to hold 1000 frames for all of a hub's terminals, and
/// a terminal that printed fast emptied it of every other one's.
#[test]
fn a_busy_terminal_does_not_push_out_another_terminals_output_while_its_hub_is_away() {
    let mut routes = HubRoutes::default();
    let owner = OwnerId::from_hub_key(KEY_A);
    for rank in 0..10 {
        away(&mut routes, &owner, "quiet", tagged("quiet", rank, 64));
    }
    let busy_frames = 2 * AWAY_PER_CHANNEL / FRAME + 1000;
    for rank in 0..busy_frames {
        away(&mut routes, &owner, "busy", tagged("busy", rank, FRAME));
    }

    let tags = tags(&come_back(&mut routes, &owner));
    assert_eq!(
        ranks_of(&tags, "quiet"),
        (0..10).collect::<Vec<_>>(),
        "the quiet terminal's output is all kept"
    );
}

/// While its hub is away, a terminal keeps its newest output, up to its own
/// bound, in order; its last frame (its exit, when it ended) is always kept.
#[test]
fn a_terminal_keeps_its_newest_output_within_its_bound_while_its_hub_is_away() {
    let mut routes = HubRoutes::default();
    let owner = OwnerId::from_hub_key(KEY_A);
    let busy_frames = 2 * AWAY_PER_CHANNEL / FRAME + 1000;
    for rank in 0..busy_frames {
        away(&mut routes, &owner, "busy", tagged("busy", rank, FRAME));
    }
    away(&mut routes, &owner, "busy", tagged("busy", busy_frames, 40));

    let frames = come_back(&mut routes, &owner);
    let kept: usize = frames.iter().map(Vec::len).sum();
    assert!(
        kept <= AWAY_PER_CHANNEL,
        "kept {kept} bytes of one terminal, over its bound of {AWAY_PER_CHANNEL}"
    );
    assert!(
        kept > AWAY_PER_CHANNEL - 2 * FRAME,
        "kept only {kept} bytes of a bound of {AWAY_PER_CHANNEL}"
    );
    let ranks = ranks_of(&tags(&frames), "busy");
    let first = busy_frames + 1 - ranks.len();
    assert_eq!(
        ranks,
        (first..=busy_frames).collect::<Vec<_>>(),
        "the newest frames are kept, in order, the last one included"
    );
}

/// All of a hub's terminals together keep no more than the hub's bound; what
/// goes is the oldest output of whichever holds the most, so each keeps its
/// newest. What is kept goes out in the order it was sent.
#[test]
fn a_hubs_terminals_together_keep_no_more_than_its_bound_while_it_is_away() {
    let mut routes = HubRoutes::default();
    let owner = OwnerId::from_hub_key(KEY_A);
    let channels: Vec<String> = (0..24).map(|n| format!("ch{n:02}")).collect();
    let per_channel = AWAY_PER_CHANNEL / FRAME;
    // Interleaved: each terminal prints a frame in turn.
    for rank in 0..per_channel {
        for channel in &channels {
            away(&mut routes, &owner, channel, tagged(channel, rank, FRAME));
        }
    }

    let frames = come_back(&mut routes, &owner);
    let kept: usize = frames.iter().map(Vec::len).sum();
    assert!(
        kept <= AWAY_PER_HUB,
        "kept {kept} bytes for one hub, over its bound of {AWAY_PER_HUB}"
    );
    let tags = tags(&frames);
    for channel in &channels {
        let ranks = ranks_of(&tags, channel);
        assert_eq!(
            ranks.last(),
            Some(&(per_channel - 1)),
            "{channel} keeps its newest frame"
        );
        assert!(
            ranks.len() * FRAME >= AWAY_PER_HUB / channels.len() - FRAME,
            "{channel} keeps its share: {} frames",
            ranks.len()
        );
    }
    let order: Vec<(usize, usize)> = tags
        .iter()
        .map(|(channel, rank)| {
            let index = channels.iter().position(|c| c == channel).unwrap();
            (*rank, index)
        })
        .collect();
    assert!(
        order.windows(2).all(|pair| pair[0] < pair[1]),
        "what is kept goes out in the order it was sent"
    );
}
