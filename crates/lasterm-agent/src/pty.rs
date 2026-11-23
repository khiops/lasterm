use std::collections::HashMap;
use std::io;
use std::time::Duration;

use async_xpty::{CommandBuilder, ExitStatus, PtyProcess};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::batch::Voice;
use crate::input::{wake_record_for, InputQueue, INPUT_QUEUE_BYTES};
use crate::input_modes::InputModeCell;
use crate::owner::OwnerId;
use std::sync::Arc;

const CHANNEL_TEARDOWN_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct PtyChannelState {
    pub process: PtyProcess,
    /// The hub whose connection spawned this channel. Set at SPAWN, never
    /// changed: only a getter reads it (#127).
    owner: OwnerId,
    /// What the hub typed and the terminal has not taken yet. Its writer ends
    /// when the channel is removed (#740).
    pub(crate) input: InputQueue,
    /// The modes its reader last saw, which decide how its input is written
    /// (#1012).
    pub(crate) input_modes: Arc<InputModeCell>,
    /// Whether its reader may still speak: silenced by the hub's DESTROY
    /// (#1121).
    pub(crate) voice: Arc<Voice>,
}

impl PtyChannelState {
    pub(crate) fn owner(&self) -> &OwnerId {
        &self.owner
    }
}

/// A channel whose program has ended, from the moment its reader takes its
/// workload back until its CHANNEL_EXIT has been routed to its hub (#1089),
/// or a workload torn down whose exit is on its way (#1113).
///
/// The id stays taken all that time: a SPAWN reusing it is refused, or, once
/// the exit is on its way, waits for it. A SPAWN accepted in between got its
/// SPAWN_OK first, and the hub read the late exit as the end of the terminal
/// that took its place.
pub(crate) struct Ending {
    kind: EndingKind,
    pid: u32,
    /// Set once its exit is sent: it closes when that exit has been routed.
    routed: Option<watch::Receiver<()>>,
}

/// What an [`Ending`] is the end of.
enum EndingKind {
    /// A program that ended by itself, still its hub's: a hub connecting
    /// meanwhile may be told the channel is still there, and gets its exit,
    /// before or after that state, and it counts for the other hubs (#1089).
    Ended(OwnerId),
    /// A workload torn down (DESTROY, `destroy_all`): the hub that destroyed
    /// it no longer holds it, so it is neither listed nor counted. Only a
    /// SPAWN of its id waits for its exit (#1113).
    TornDown,
}

impl Ending {
    /// Whether it still holds its id: its exit is not sent, or not yet routed.
    fn holds(&self) -> bool {
        self.routed
            .as_ref()
            .is_none_or(|routed| routed.has_changed().is_ok())
    }

    /// The hub whose program ended, unless it was torn down.
    fn ended_for(&self) -> Option<&OwnerId> {
        match &self.kind {
            EndingKind::Ended(owner) => Some(owner),
            EndingKind::TornDown => None,
        }
    }
}

/// What became of an [`Ending`] when its reader came to send its exit.
pub(crate) enum EndingSend {
    /// Still its own: the exit goes, and the id is held until `routed` closes.
    Send(watch::Sender<()>),
    /// The hub DESTROYed it before its exit was sent: the exit goes as a torn
    /// down workload's, without a screen, and the id is held until `routed`
    /// closes (#1113).
    TornDown(watch::Sender<()>),
    /// Another workload took its id since: no exit is sent (PROTOCOL.md § 3.2).
    Withdrawn,
}

/// The channels whose reader waits, its workload's exit status in hand,
/// before it sends its exit: the window of #1089, made wide enough to be hit.
/// By id, so that tests running beside each other are not slowed.
#[cfg(test)]
static DELAYED_EXITS: std::sync::Mutex<Vec<(String, Duration)>> = std::sync::Mutex::new(Vec::new());

/// Have the reader of `channel_id` wait `delay` before it sends its exit.
#[cfg(test)]
pub(crate) fn delay_exit_of(channel_id: &str, delay: Duration) {
    DELAYED_EXITS
        .lock()
        .expect("delayed exits")
        .push((channel_id.to_owned(), delay));
}

/// How long the reader of `channel_id` waits before it sends its exit.
#[cfg(test)]
pub(crate) fn exit_delay_of(channel_id: &str) -> Option<Duration> {
    DELAYED_EXITS
        .lock()
        .expect("delayed exits")
        .iter()
        .find(|(id, _)| id == channel_id)
        .map(|(_, delay)| *delay)
}

/// The channels whose exit the output router holds before routing it: the
/// window where a SPAWN waits for an exit on its way (#1089).
#[cfg(test)]
static DELAYED_ROUTES: std::sync::Mutex<Vec<(String, Duration)>> =
    std::sync::Mutex::new(Vec::new());

/// Have the router hold the exit of `channel_id` for `delay` before routing it.
#[cfg(test)]
pub(crate) fn delay_route_of(channel_id: &str, delay: Duration) {
    DELAYED_ROUTES
        .lock()
        .expect("delayed routes")
        .push((channel_id.to_owned(), delay));
}

/// How long the router holds the exit of `channel_id` before routing it.
#[cfg(test)]
pub(crate) fn route_delay_of(channel_id: &str) -> Option<Duration> {
    DELAYED_ROUTES
        .lock()
        .expect("delayed routes")
        .iter()
        .find(|(id, _)| id == channel_id)
        .map(|(_, delay)| *delay)
}

/// The channels every event of which the output router holds before routing
/// it, the exit of a workload the hub destroyed included: the window where
/// that exit, sent before a restart's SPAWN, would reach the hub after its
/// SPAWN_OK (#1113).
#[cfg(test)]
static HELD_ROUTES: std::sync::Mutex<Vec<(String, Duration)>> = std::sync::Mutex::new(Vec::new());

/// Have the router hold every event of `channel_id` for `delay` before routing it.
#[cfg(test)]
pub(crate) fn hold_routes_of(channel_id: &str, delay: Duration) {
    HELD_ROUTES
        .lock()
        .expect("held routes")
        .push((channel_id.to_owned(), delay));
}

/// How long the router holds every event of `channel_id` before routing it.
#[cfg(test)]
pub(crate) fn held_route_of(channel_id: &str) -> Option<Duration> {
    HELD_ROUTES
        .lock()
        .expect("held routes")
        .iter()
        .find(|(id, _)| id == channel_id)
        .map(|(_, delay)| *delay)
}

/// The channels whose reader, finding its workload torn down, waits before
/// it sends its exit: the window where a restart's SPAWN reuses the id first
/// (#1113).
#[cfg(test)]
static DELAYED_TORN_DOWN: std::sync::Mutex<Vec<(String, Duration)>> =
    std::sync::Mutex::new(Vec::new());

/// Have the reader of `channel_id`, its workload torn down, wait `delay`
/// before it sends its exit.
#[cfg(test)]
pub(crate) fn delay_torn_down_of(channel_id: &str, delay: Duration) {
    DELAYED_TORN_DOWN
        .lock()
        .expect("delayed torn down")
        .push((channel_id.to_owned(), delay));
}

/// How long the reader of `channel_id`, its workload torn down, waits.
#[cfg(test)]
pub(crate) fn torn_down_delay_of(channel_id: &str) -> Option<Duration> {
    DELAYED_TORN_DOWN
        .lock()
        .expect("delayed torn down")
        .iter()
        .find(|(id, _)| id == channel_id)
        .map(|(_, delay)| *delay)
}

/// What test-only receipts readers have left, by channel: the reader states
/// a test waits for before its next step, never sent to the hub (#1121).
#[cfg(test)]
static RECEIPTS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// Record that the reader of `channel_id` reached `what`.
#[cfg(test)]
pub(crate) fn record_receipt(channel_id: &str, what: &str) {
    RECEIPTS
        .lock()
        .expect("receipts")
        .push((channel_id.to_owned(), what.to_owned()));
}

/// Wait until the readers of `channel_id` have reached `what` `times` times
/// in all (a restart's readers share the id): `exit-enqueued`
/// (its CHANNEL_EXIT is in the pipeline), `torn-down` (it found its workload
/// torn down, before any delay it then waits), or `output:<text>` (it
/// enqueued an OUTPUT containing a text given to [`watch_output_of`]).
#[cfg(test)]
pub(crate) async fn receipt(channel_id: &str, what: &str, times: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let found = RECEIPTS
            .lock()
            .expect("receipts")
            .iter()
            .filter(|(id, seen)| id == channel_id && seen == what)
            .count()
            >= times;
        if found {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no receipt {what:?} from the reader of {channel_id}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Texts whose OUTPUT a test waits for, by channel.
#[cfg(test)]
static WATCHED_OUTPUT: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// Have the reader of `channel_id` leave an `output:<text>` receipt once it
/// has enqueued an OUTPUT containing `text`.
#[cfg(test)]
pub(crate) fn watch_output_of(channel_id: &str, text: &str) {
    WATCHED_OUTPUT
        .lock()
        .expect("watched output")
        .push((channel_id.to_owned(), text.to_owned()));
}

/// The watched texts of `channel_id` that `data` contains.
#[cfg(test)]
pub(crate) fn output_watched(channel_id: &str, data: &[u8]) -> Vec<String> {
    let printed = String::from_utf8_lossy(data);
    WATCHED_OUTPUT
        .lock()
        .expect("watched output")
        .iter()
        .filter(|(id, text)| id == channel_id && printed.contains(text.as_str()))
        .map(|(_, text)| text.clone())
        .collect()
}

/// The channels whose reader, at its PTY's end, waits for the test to let it
/// handle that end (#1121).
#[cfg(test)]
static HELD_PTY_ENDS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Have the reader of `channel_id`, at its PTY's end, wait for
/// [`release_pty_end_of`] before it handles that end.
#[cfg(test)]
pub(crate) fn hold_pty_end_of(channel_id: &str) {
    HELD_PTY_ENDS
        .lock()
        .expect("held PTY ends")
        .push(channel_id.to_owned());
}

/// Let the reader of `channel_id` handle its PTY's end.
#[cfg(test)]
pub(crate) fn release_pty_end_of(channel_id: &str) {
    HELD_PTY_ENDS
        .lock()
        .expect("held PTY ends")
        .retain(|id| id != channel_id);
}

/// At its PTY's end, the reader of `channel_id` waits while it is held,
/// having left a `pty-end` receipt.
#[cfg(test)]
pub(crate) async fn pty_end_released(channel_id: &str) {
    record_receipt(channel_id, "pty-end");
    while HELD_PTY_ENDS
        .lock()
        .expect("held PTY ends")
        .iter()
        .any(|id| id == channel_id)
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub struct PtyManager {
    pub(crate) channels: HashMap<String, PtyChannelState>,
    /// Channels whose program ended and whose exit has not reached its hub's
    /// route yet (#1089).
    ending: HashMap<String, Ending>,
    /// Workloads torn down (DESTROY, `destroy_all`) before their reader sent
    /// their exit, the pid of each by its channel id, while no SPAWN has
    /// started a workload under the id since: each one's reader still owes
    /// its exit (#1113). At most one per id: one is added only for the
    /// workload the id holds, and a SPAWN that starts one clears the id's.
    torn_down: HashMap<String, u32>,
    shutting_down: bool,
    teardown_wait_timeout: Duration,
    /// The most input a channel's queue holds (#740).
    input_bound: usize,
    #[cfg(test)]
    fail_next_teardown_signal: bool,
    #[cfg(test)]
    sweep_next_reader_lookup: bool,
}

/// The result of trying to end a terminal workload.
#[derive(Debug)]
pub(crate) enum TeardownOutcome {
    Exited {
        channel_id: String,
        pid: u32,
        status: ExitStatus,
    },
    SignalledButUnconfirmed {
        channel_id: String,
        pid: u32,
        reason: UnconfirmedTeardown,
    },
    SignallingFailed {
        channel_id: String,
        pid: u32,
        error: io::Error,
    },
    AlreadyExited {
        channel_id: String,
        pid: u32,
    },
}

#[derive(Debug)]
pub(crate) enum UnconfirmedTeardown {
    WaitFailed(io::Error),
    TimedOut { timeout: Duration },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum UnresolvedTeardown {
    SignallingFailed,
    WaitFailed,
    TimedOut,
    ConfirmationTaskFailed,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UnresolvedChannel {
    pub channel_id: String,
    pub pid: u32,
    pub reason: UnresolvedTeardown,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DestroyAllSummary {
    /// Number of spawned shells whose exit was confirmed. This does not confirm
    /// that every workload descendant exited: `PtyProcess::wait()` observes the
    /// shell only, while `PtyProcess::kill_tree_scope()` describes the platform
    /// scope that teardown attempts to reach.
    pub confirmed_shell_exits: usize,
    pub unresolved: Vec<UnresolvedChannel>,
}

/// The process has been signalled and now belongs to its confirmation task.
pub(crate) struct TeardownConfirmation {
    channel_id: String,
    pid: u32,
    process: PtyProcess,
    wait_timeout: Duration,
}

pub(crate) enum TeardownStart {
    Signalled { pid: u32 },
    AlreadyExited(TeardownOutcome),
}

struct TeardownWait {
    channel_id: String,
    pid: u32,
    wait: JoinHandle<TeardownOutcome>,
}

impl TeardownOutcome {
    fn unresolved_channel(&self) -> Option<UnresolvedChannel> {
        let (channel_id, pid, reason) = match self {
            Self::SignalledButUnconfirmed {
                channel_id,
                pid,
                reason: UnconfirmedTeardown::WaitFailed(_),
            } => (channel_id, *pid, UnresolvedTeardown::WaitFailed),
            Self::SignalledButUnconfirmed {
                channel_id,
                pid,
                reason: UnconfirmedTeardown::TimedOut { .. },
            } => (channel_id, *pid, UnresolvedTeardown::TimedOut),
            Self::SignallingFailed {
                channel_id, pid, ..
            } => (channel_id, *pid, UnresolvedTeardown::SignallingFailed),
            Self::Exited { .. } | Self::AlreadyExited { .. } => return None,
        };
        Some(UnresolvedChannel {
            channel_id: channel_id.clone(),
            pid,
            reason,
        })
    }
}

impl DestroyAllSummary {
    fn record_outcome(&mut self, outcome: &TeardownOutcome) {
        if let Some(unresolved) = outcome.unresolved_channel() {
            self.unresolved.push(unresolved);
        } else {
            self.confirmed_shell_exits += 1;
        }
    }

    /// Every channel present when teardown started is either confirmed or
    /// unresolved. `record_outcome` is total, so this holds by construction and
    /// a violation would mean the caller miscounted the sweep.
    ///
    /// Debug-only on purpose: this runs while the agent is shutting down, and
    /// the caller consults the summary to decide whether it is safe to replace
    /// files on disk. Panicking here would withhold that answer at the one
    /// moment it is needed.
    fn assert_complete(&self, swept_channels: usize) {
        debug_assert_eq!(
            self.confirmed_shell_exits + self.unresolved.len(),
            swept_channels,
            "every channel present when teardown started must be confirmed or unresolved"
        );
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            channels: HashMap::new(),
            ending: HashMap::new(),
            torn_down: HashMap::new(),
            shutting_down: false,
            teardown_wait_timeout: CHANNEL_TEARDOWN_WAIT_TIMEOUT,
            input_bound: INPUT_QUEUE_BYTES,
            #[cfg(test)]
            fail_next_teardown_signal: false,
            #[cfg(test)]
            sweep_next_reader_lookup: false,
        }
    }

    /// Construct a manager with a custom confirmation bound. Daemon tests use
    /// this to exercise unresolved-workload reporting without waiting for the
    /// production five-second shutdown bound.
    #[cfg(test)]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn with_teardown_wait_timeout(teardown_wait_timeout: Duration) -> Self {
        Self {
            teardown_wait_timeout,
            ..Self::new()
        }
    }

    /// Construct a manager whose channels queue at most `input_bound` bytes of
    /// input each, so that a test fills a queue with little input.
    #[cfg(test)]
    pub(crate) fn with_input_bound(input_bound: usize) -> Self {
        Self {
            input_bound,
            ..Self::new()
        }
    }

    /// Prevent future workload creation before the daemon sweeps existing
    /// channels. This is irreversible for this manager's lifetime.
    pub(crate) fn begin_shutdown(&mut self) {
        self.shutting_down = true;
    }

    /// Where the channel's reader publishes its program's input modes (#1012).
    pub(crate) fn input_modes_for(&self, channel_id: &str) -> Option<Arc<InputModeCell>> {
        self.channels
            .get(channel_id)
            .map(|channel| Arc::clone(&channel.input_modes))
    }

    /// The voice of `channel_id`'s reader, while it is registered.
    pub(crate) fn voice_for(&self, channel_id: &str) -> Option<Arc<Voice>> {
        self.channels
            .get(channel_id)
            .map(|channel| Arc::clone(&channel.voice))
    }

    /// Whether a workload torn down under `channel_id` still owes its exit:
    /// its reader may have frames on their way, and a SPAWN replacing it
    /// answers after them (#1121).
    pub(crate) fn has_torn_down(&self, channel_id: &str) -> bool {
        self.torn_down.contains_key(channel_id)
    }

    /// Take a reader only while its channel remains registered. A daemon sweep
    /// can remove the channel between spawn and reader registration.
    pub(crate) fn reader_for(&mut self, channel_id: &str) -> Option<async_xpty::PtyReader> {
        #[cfg(test)]
        if std::mem::take(&mut self.sweep_next_reader_lookup) {
            self.remove(channel_id);
            return None;
        }
        self.channels
            .get(channel_id)
            .map(|channel| channel.process.reader())
    }

    /// Test seam for the spawn-versus-shutdown handoff: the channel is swept
    /// after `spawn` succeeds but before handler reader registration.
    #[cfg(test)]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn sweep_next_reader_lookup(&mut self) {
        self.sweep_next_reader_lookup = true;
    }

    /// Spawn a new PTY channel for `owner`. Returns (channel_id, pid).
    ///
    /// A channel id is unique across the whole agent, whoever owns it: a
    /// duplicate is refused even when another hub holds the first one.
    ///
    /// `environment` is the whole environment the workload starts with, from a
    /// cleared one (#576); `None` hands it the agent's own.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn spawn(
        &mut self,
        owner: OwnerId,
        channel_id: Option<String>,
        shell: &str,
        args: &[String],
        cwd: Option<&str>,
        environment: Option<&[(String, String)]>,
        cols: u16,
        rows: u16,
    ) -> std::io::Result<(String, u32)> {
        if self.shutting_down {
            return Err(std::io::Error::other(
                "agent is shutting down; refusing to spawn a terminal",
            ));
        }

        if let Some(ref id) = channel_id {
            if self.channels.contains_key(id) || self.is_ending(id) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "channel already exists",
                ));
            }
        }

        let id = channel_id.unwrap_or_else(|| ulid::Ulid::generate().to_string().to_lowercase());

        let mut cmd = CommandBuilder::new(shell);
        for arg in args {
            cmd = cmd.arg(arg);
        }
        if let Some(d) = cwd {
            cmd = cmd.current_dir(d);
        }
        if let Some(environment) = environment {
            cmd = cmd.env_clear();
            for (name, value) in environment {
                cmd = cmd.env(name, value);
            }
        }
        cmd = cmd.size(cols, rows);

        let process = cmd.spawn().await?;
        let pid = process.pid();
        let kill_tree_scope = process.kill_tree_scope();
        tracing::debug!(channel_id = %id, ?kill_tree_scope, "PTY kill-tree scope");
        let input =
            InputQueue::start_waking(&id, process.writer(), self.input_bound, wake_record());
        // A workload torn down under this id was replaced: its reader sends
        // no exit, which the hub would read as this one's end (#1113). Only
        // now that the PTY exists: a SPAWN that fails to start one leaves that
        // exit owed, the end of the terminal when its restart fails.
        self.torn_down.remove(&id);
        self.channels.insert(
            id.clone(),
            PtyChannelState {
                process,
                owner,
                input,
                input_modes: Arc::default(),
                voice: Arc::default(),
            },
        );
        Ok((id, pid))
    }

    /// The channel, if `owner` holds it. Another hub's channel is as absent
    /// as one that does not exist: its existence is never revealed (#127).
    pub(crate) fn owned_by(&self, channel_id: &str, owner: &OwnerId) -> Option<&PtyChannelState> {
        self.channels
            .get(channel_id)
            .filter(|channel| channel.owner() == owner)
    }

    /// How many channels hubs other than `owner` hold, ended ones whose exit
    /// has not reached its route included. A torn-down workload's exit on its
    /// way is not one: its hub let it go (#1113).
    pub(crate) fn held_by_others(&self, owner: &OwnerId) -> u32 {
        let others = self
            .channels
            .values()
            .filter(|channel| channel.owner() != owner)
            .count()
            + self
                .ending
                .values()
                .filter(|ending| {
                    ending.holds() && ending.ended_for().is_some_and(|ended| ended != owner)
                })
                .count();
        u32::try_from(others).unwrap_or(u32::MAX)
    }

    /// `owner`'s channels whose program ended and whose exit has not reached
    /// its route, with their pids: still there for a hub that connects now.
    /// Not a workload it destroyed whose exit is on its way (#1113).
    pub(crate) fn ending_of(&self, owner: &OwnerId) -> Vec<(String, u32)> {
        self.ending
            .iter()
            .filter(|(_, ending)| ending.holds() && ending.ended_for() == Some(owner))
            .map(|(id, ending)| (id.clone(), ending.pid))
            .collect()
    }

    /// Whether `channel_id` is held by a channel whose exit has not reached
    /// its route.
    fn is_ending(&self, channel_id: &str) -> bool {
        self.ending.get(channel_id).is_some_and(Ending::holds)
    }

    /// What a SPAWN reusing `channel_id` waits for first: the routing of the
    /// exit of the channel that held it, once that exit is on its way.
    pub(crate) fn exit_in_transit(&self, channel_id: &str) -> Option<watch::Receiver<()>> {
        self.ending
            .get(channel_id)
            .filter(|ending| ending.holds())
            .and_then(|ending| ending.routed.clone())
    }

    /// Take back the workload of `channel_id`, its program ended, keeping
    /// the id held until its exit has been routed.
    pub(crate) fn take_ended(&mut self, channel_id: &str) -> Option<PtyProcess> {
        let channel = self.channels.remove(channel_id)?;
        let pid = channel.process.pid();
        self.ending.insert(
            channel_id.to_owned(),
            Ending {
                kind: EndingKind::Ended(channel.owner),
                pid,
                routed: None,
            },
        );
        Some(channel.process)
    }

    /// The reader of `pid` is about to send the exit of `channel_id`, whose
    /// program ended. A DESTROY that came first made it a torn-down workload
    /// (`tear_down_ending`): its exit then goes as one's (#1113).
    pub(crate) fn send_ending(&mut self, channel_id: &str, pid: u32) -> EndingSend {
        match self.ending.get_mut(channel_id) {
            Some(ending) if ending.pid == pid && ending.routed.is_none() => {
                let (routed_tx, routed_rx) = watch::channel(());
                ending.routed = Some(routed_rx);
                EndingSend::Send(routed_tx)
            }
            _ => match self.send_torn_down(channel_id, pid) {
                Some(routed_tx) => EndingSend::TornDown(routed_tx),
                None => EndingSend::Withdrawn,
            },
        }
    }

    /// Remove `channel_id` as the hub's DESTROY tears it down: its reader is
    /// silenced first, and sends nothing more but its exit (#1121). Not for
    /// `destroy_all`, whose terminals the hub still records until the stop is
    /// confirmed.
    pub(crate) fn remove_destroyed(&mut self, channel_id: &str) -> Option<PtyProcess> {
        self.channels.get(channel_id)?.voice.silence();
        self.remove_torn_down(channel_id)
    }

    /// Remove `channel_id` as it is torn down (DESTROY, `destroy_all`), its
    /// reader still to send its exit (`send_torn_down`).
    pub(crate) fn remove_torn_down(&mut self, channel_id: &str) -> Option<PtyProcess> {
        let process = self.remove(channel_id)?;
        self.torn_down.insert(channel_id.to_owned(), process.pid());
        Some(process)
    }

    /// The reader of `pid` is about to send the exit of `channel_id`, a
    /// workload torn down before its exit was sent. Its exit holds the id
    /// until routed, as an ended one's does, so a restart's SPAWN reusing it
    /// waits for it and is answered after it (#1113). None once a SPAWN has
    /// started a workload under the id: no exit is sent for a workload whose
    /// id was taken over (PROTOCOL.md § 3.2).
    ///
    /// The record is taken only when it is this reader's: a late reader must
    /// not consume the record of a run destroyed after its own, whose reader
    /// still owes that run's exit.
    pub(crate) fn send_torn_down(
        &mut self,
        channel_id: &str,
        pid: u32,
    ) -> Option<watch::Sender<()>> {
        if self.torn_down.get(channel_id) != Some(&pid) {
            return None;
        }
        self.torn_down.remove(channel_id);
        let (routed_tx, routed_rx) = watch::channel(());
        self.ending.insert(
            channel_id.to_owned(),
            Ending {
                kind: EndingKind::TornDown,
                pid,
                routed: Some(routed_rx),
            },
        );
        Some(routed_tx)
    }

    /// The exit of `pid` under `channel_id` has been routed: its id is free.
    pub(crate) fn release_ending(&mut self, channel_id: &str, pid: u32) {
        if self
            .ending
            .get(channel_id)
            .is_some_and(|ending| ending.pid == pid)
        {
            self.ending.remove(channel_id);
        }
    }

    /// The hub DESTROYs `channel_id`, whose program has ended and whose exit
    /// is not sent yet: the id is free for the SPAWN of a restart (#1089), and
    /// the workload becomes a torn-down one. Its reader then sends its exit as
    /// one's: before the answer of a SPAWN of the id that creates a PTY, and
    /// not at all once such a SPAWN started a workload. When the restart
    /// fails instead, that exit is the terminal's end, and no other comes
    /// (#1113). Returns whether there was one. An exit already on its way is
    /// left to arrive first.
    pub(crate) fn tear_down_ending(&mut self, channel_id: &str, owner: &OwnerId) -> bool {
        let unsent = self
            .ending
            .get(channel_id)
            .is_some_and(|ending| ending.ended_for() == Some(owner) && ending.routed.is_none());
        if !unsent {
            return false;
        }
        if let Some(ending) = self.ending.remove(channel_id) {
            self.torn_down.insert(channel_id.to_owned(), ending.pid);
        }
        true
    }

    #[allow(dead_code)] // Used in tests
    pub fn get_mut(&mut self, channel_id: &str) -> Option<&mut PtyProcess> {
        self.channels
            .get_mut(channel_id)
            .map(|channel| &mut channel.process)
    }

    pub fn remove(&mut self, channel_id: &str) -> Option<PtyProcess> {
        self.channels
            .remove(channel_id)
            .map(|channel| channel.process)
    }

    #[allow(dead_code)] // Used in tests
    pub fn contains(&self, channel_id: &str) -> bool {
        self.channels.contains_key(channel_id)
    }

    #[allow(dead_code)] // Used in tests
    pub fn channel_ids(&self) -> Vec<String> {
        self.channels.keys().cloned().collect()
    }

    #[cfg(test)]
    pub(crate) fn fail_next_teardown_signal(&mut self) {
        self.fail_next_teardown_signal = true;
    }

    /// Signal an active channel while it remains registered.
    pub(crate) fn start_teardown(
        &mut self,
        channel_id: &str,
    ) -> Result<TeardownStart, TeardownOutcome> {
        #[cfg(test)]
        let fail_signal = std::mem::take(&mut self.fail_next_teardown_signal);
        #[cfg(not(test))]
        let fail_signal = false;
        let channel = self
            .channels
            .get(channel_id)
            .expect("start teardown only for a registered channel");
        let pid = channel.process.pid();
        let signal_result = if fail_signal {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "test-only injected kill_tree failure",
            ))
        } else {
            channel.process.kill_tree()
        };

        match signal_result {
            Ok(()) => Ok(TeardownStart::Signalled { pid }),
            // async-xpty reports this exact error when the reader's wait()
            // already observed exit. That target is gone, not still running.
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => Ok(
                TeardownStart::AlreadyExited(TeardownOutcome::AlreadyExited {
                    channel_id: channel_id.to_owned(),
                    pid,
                }),
            ),
            Err(error) => Err(TeardownOutcome::SignallingFailed {
                channel_id: channel_id.to_owned(),
                pid,
                error,
            }),
        }
    }

    /// Destroy all channels (graceful shutdown).
    pub async fn destroy_all(&mut self) -> DestroyAllSummary {
        let channel_ids = self.channel_ids();
        let swept_channels = channel_ids.len();
        let mut teardown_waits = Vec::with_capacity(channel_ids.len());
        let mut summary = DestroyAllSummary::default();
        for channel_id in channel_ids {
            match self.start_teardown(&channel_id) {
                Ok(TeardownStart::Signalled { pid }) => {
                    let process = self
                        .remove_torn_down(&channel_id)
                        .expect("signalled channel must remain registered until removal");
                    let confirmation = TeardownConfirmation {
                        channel_id: channel_id.clone(),
                        pid,
                        process,
                        wait_timeout: self.teardown_wait_timeout,
                    };
                    teardown_waits.push(TeardownWait {
                        channel_id,
                        pid,
                        wait: tokio::spawn(async move { confirmation.confirm().await }),
                    });
                }
                Ok(TeardownStart::AlreadyExited(outcome)) => {
                    self.remove_torn_down(&channel_id);
                    summary.record_outcome(&outcome);
                    log_teardown_outcome(outcome, "shutdown");
                }
                Err(outcome) => {
                    // Nothing retries a failed teardown today; leave the only
                    // PtyProcess handle registered so a live workload does not
                    // become unreachable while shutdown drains other channels.
                    summary.record_outcome(&outcome);
                    log_teardown_outcome(outcome, "shutdown");
                }
            }
        }

        // Every workload was signalled above before this first await. The
        // confirmation tasks therefore overlap, so this remains one wait bound
        // for the entire shutdown rather than one bound per channel.
        for teardown_wait in teardown_waits {
            match teardown_wait.wait.await {
                Ok(outcome) => {
                    summary.record_outcome(&outcome);
                    log_teardown_outcome(outcome, "shutdown");
                }
                Err(error) => {
                    tracing::error!(
                        %error,
                        channel_id = %teardown_wait.channel_id,
                        pid = teardown_wait.pid,
                        "channel teardown confirmation task failed"
                    );
                    summary.unresolved.push(UnresolvedChannel {
                        channel_id: teardown_wait.channel_id,
                        pid: teardown_wait.pid,
                        reason: UnresolvedTeardown::ConfirmationTaskFailed,
                    });
                }
            }
        }
        summary.assert_complete(swept_channels);
        summary
    }
}

impl TeardownConfirmation {
    pub(crate) fn new(channel_id: String, pid: u32, process: PtyProcess) -> Self {
        Self {
            channel_id,
            pid,
            process,
            wait_timeout: CHANNEL_TEARDOWN_WAIT_TIMEOUT,
        }
    }

    async fn confirm(mut self) -> TeardownOutcome {
        // On Windows a timed-out `wait()` retains a blocking-pool worker; one
        // detached task per channel is intentional. See khiops/async-xpty#5.
        match tokio::time::timeout(self.wait_timeout, self.process.wait()).await {
            Ok(Ok(status)) => TeardownOutcome::Exited {
                channel_id: self.channel_id,
                pid: self.pid,
                status,
            },
            Ok(Err(error)) => TeardownOutcome::SignalledButUnconfirmed {
                channel_id: self.channel_id,
                pid: self.pid,
                reason: UnconfirmedTeardown::WaitFailed(error),
            },
            Err(_) => TeardownOutcome::SignalledButUnconfirmed {
                channel_id: self.channel_id,
                pid: self.pid,
                reason: UnconfirmedTeardown::TimedOut {
                    timeout: self.wait_timeout,
                },
            },
        }
    }
}

/// Confirm a signalled workload in one task and let that task log its result.
pub(crate) fn spawn_teardown_confirmation(
    confirmation: TeardownConfirmation,
    site: &'static str,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let outcome = confirmation.confirm().await;
        log_teardown_outcome(outcome, site);
    })
}

pub(crate) fn log_teardown_outcome(outcome: TeardownOutcome, site: &'static str) {
    match outcome {
        TeardownOutcome::Exited {
            channel_id,
            pid,
            status,
        } => {
            tracing::info!(%site, %channel_id, pid, ?status, "terminal workload exited after tree teardown")
        }
        TeardownOutcome::SignalledButUnconfirmed {
            channel_id,
            pid,
            reason: UnconfirmedTeardown::WaitFailed(error),
        } => {
            tracing::warn!(%site, %channel_id, pid, %error, "terminal workload was signalled but its exit was not confirmed")
        }
        TeardownOutcome::SignalledButUnconfirmed {
            channel_id,
            pid,
            reason: UnconfirmedTeardown::TimedOut { timeout },
        } => {
            tracing::warn!(%site, %channel_id, pid, ?timeout, "terminal workload was signalled but its exit was not confirmed before the timeout")
        }
        TeardownOutcome::SignallingFailed {
            channel_id,
            pid,
            error,
        } => {
            tracing::warn!(%site, %channel_id, pid, %error, "failed to signal terminal workload; it may still be running")
        }
        TeardownOutcome::AlreadyExited { channel_id, pid } => {
            tracing::info!(%site, %channel_id, pid, "terminal workload had already exited before tree teardown")
        }
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The record a terminal's input writer follows an INPUT with after an end
/// marker on this machine (#1030): Windows' build, read once.
fn wake_record() -> Option<&'static [u8]> {
    static RECORD: std::sync::OnceLock<Option<&'static [u8]>> = std::sync::OnceLock::new();
    *RECORD.get_or_init(|| wake_record_for(windows_build()))
}

/// This Windows' build number; none elsewhere, or when it cannot be read.
#[cfg(windows)]
fn windows_build() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // SAFETY: a zeroed OSVERSIONINFOW with its size set, filled by ntdll.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a valid, writable OSVERSIONINFOW.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status == 0).then_some(info.dwBuildNumber)
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell that exists on this platform and, attached to a PTY with nobody
    /// typing, blocks on input rather than exiting. Tests that hardcoded
    /// `/bin/sh` failed everywhere on Windows for as long as they existed,
    /// unnoticed because CI never ran the Rust suite there.
    fn test_shell() -> &'static str {
        if cfg!(windows) {
            "cmd.exe"
        } else {
            "/bin/sh"
        }
    }

    #[tokio::test]
    async fn test_spawn_channel() {
        let mut mgr = PtyManager::new();
        let (id, pid) = mgr
            .spawn(
                OwnerId::stdio(),
                None,
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .unwrap();
        assert!(!id.is_empty());
        assert!(pid > 0);
        assert!(mgr.contains(&id));
        // Cleanup
        if let Some(ch) = mgr.remove(&id) {
            let _ = ch.kill();
        }
    }

    #[tokio::test]
    async fn test_duplicate_channel_id_rejected() {
        let mut mgr = PtyManager::new();
        let fixed_id = "test-channel-01".to_string();
        let (id, _) = mgr
            .spawn(
                OwnerId::stdio(),
                Some(fixed_id.clone()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .unwrap();
        assert_eq!(id, fixed_id);

        let err = mgr
            .spawn(
                OwnerId::stdio(),
                Some(fixed_id.clone()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);

        // Cleanup
        if let Some(ch) = mgr.remove(&fixed_id) {
            let _ = ch.kill();
        }
    }

    #[tokio::test]
    async fn spawn_is_refused_after_shutdown_begins() {
        let mut manager = PtyManager::new();
        manager.begin_shutdown();

        let error = manager
            .spawn(
                OwnerId::stdio(),
                Some("post-shutdown-spawn".to_owned()),
                test_shell(),
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .expect_err("a manager being swept must refuse a later spawn");

        assert!(error.to_string().contains("agent is shutting down"));
        assert!(manager.channels.is_empty());

        // Mutation caught: removing the shutting_down guard permits a detached
        // daemon handler to create a workload after the shutdown sweep began.
    }

    #[tokio::test]
    async fn test_destroy_all() {
        let mut mgr = PtyManager::new();
        mgr.spawn(
            OwnerId::stdio(),
            None,
            test_shell(),
            &[],
            None,
            None,
            80,
            24,
        )
        .await
        .unwrap();
        mgr.spawn(
            OwnerId::stdio(),
            None,
            test_shell(),
            &[],
            None,
            None,
            80,
            24,
        )
        .await
        .unwrap();
        assert_eq!(mgr.channel_ids().len(), 2);
        let summary = mgr.destroy_all().await;
        assert_eq!(summary.confirmed_shell_exits, 2);
        assert!(summary.unresolved.is_empty());
        assert_eq!(mgr.channel_ids().len(), 0);
    }

    #[tokio::test]
    async fn destroy_all_reports_a_signalling_failure_as_unresolved() {
        let mut manager = PtyManager::new();
        let channel_id = "signal-failure-shutdown".to_string();
        let (spawned_channel_id, pid) = manager
            .spawn(
                OwnerId::stdio(),
                Some(channel_id.clone()),
                test_shell(),
                // No args: an idle shell on a PTY blocks reading input, which is
                // all this needs, and the sleep had no portable equivalent.
                &[],
                None,
                None,
                80,
                24,
            )
            .await
            .expect("spawn terminal workload");
        manager.fail_next_teardown_signal();

        let summary = manager.destroy_all().await;

        assert_eq!(summary.confirmed_shell_exits, 0);
        assert_eq!(
            summary.unresolved,
            vec![UnresolvedChannel {
                channel_id: spawned_channel_id.clone(),
                pid,
                reason: UnresolvedTeardown::SignallingFailed,
            }]
        );
        assert_eq!(
            summary.confirmed_shell_exits + summary.unresolved.len(),
            1,
            "every channel present when teardown started must be represented"
        );
        assert!(manager.contains(&spawned_channel_id));

        if let Some(process) = manager.remove(&spawned_channel_id) {
            let _ = process.kill_tree();
        }
    }

    /// A terminal does not start with SIGPIPE ignored, nor any other signal
    /// (#597). The Rust runtime ignores SIGPIPE in the agent, and every command
    /// a terminal ran used to inherit that: `yes | head -1` printed a write
    /// error instead of `yes` dying quietly.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_terminal_starts_with_no_signal_ignored() {
        // The agent's own state. The Rust runtime already set it; setting it
        // again keeps the test independent of that and changes nothing here.
        // SAFETY: SIG_IGN installs no handler.
        let previous = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
        assert_ne!(previous, libc::SIG_ERR, "could not ignore SIGPIPE");

        let (output, status) = run_in_terminal("grep SigIgn /proc/self/status").await;

        assert!(status.success(), "grep failed: {status}, output {output:?}");
        let ignored = output
            .lines()
            .find_map(|line| line.trim().strip_prefix("SigIgn:"))
            .map(str::trim)
            .unwrap_or_else(|| panic!("no SigIgn line in {output:?}"));
        let ignored = u64::from_str_radix(ignored, 16).expect("SigIgn is a hexadecimal mask");
        let sigpipe = 1_u64 << (libc::SIGPIPE - 1);
        assert_eq!(
            ignored & sigpipe,
            0,
            "the terminal starts with SIGPIPE ignored (SigIgn {ignored:016x})"
        );
        assert_eq!(
            ignored, 0,
            "the terminal starts with signals ignored (SigIgn {ignored:016x})"
        );
    }

    /// A terminal's input is UTF-8 for the line discipline (#601). Without
    /// `IUTF8`, Backspace over `é` or `€` in canonical mode (`read`, a password
    /// prompt) erased one byte and left broken UTF-8 in the line.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_terminal_starts_with_iutf8() {
        let (output, status) = run_in_terminal("stty -a").await;

        assert!(status.success(), "stty failed: {status}, output {output:?}");
        let flags: Vec<&str> = output.split_whitespace().collect();
        assert!(
            !flags.contains(&"-iutf8"),
            "the terminal starts without IUTF8: {output:?}"
        );
        assert!(flags.contains(&"iutf8"), "no iutf8 in stty -a: {output:?}");
    }

    /// Run `command` with `/bin/sh -c` in a terminal the manager spawns, to its
    /// end: everything it printed, then how it ended.
    #[cfg(target_os = "linux")]
    async fn run_in_terminal(command: &str) -> (String, ExitStatus) {
        use tokio::io::AsyncReadExt;

        let mut manager = PtyManager::new();
        let args = vec!["-c".to_string(), command.to_string()];
        let (channel_id, _) = manager
            .spawn(OwnerId::stdio(), None, "/bin/sh", &args, None, None, 80, 24)
            .await
            .expect("spawn terminal");
        let mut reader = manager.reader_for(&channel_id).expect("terminal reader");
        let mut process = manager.remove(&channel_id).expect("terminal process");

        let mut output = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), reader.read_to_end(&mut output))
            .await
            .expect("terminal output timed out")
            .expect("read terminal output");
        let status = tokio::time::timeout(Duration::from_secs(10), process.wait())
            .await
            .expect("terminal exit timed out")
            .expect("wait for terminal exit");
        (String::from_utf8_lossy(&output).into_owned(), status)
    }

    #[cfg(target_os = "linux")]
    mod linux_teardown_tests {
        use std::fs;
        use std::io;
        use std::path::{Path, PathBuf};
        use std::sync::Arc;
        use std::time::{Duration, Instant};

        use tokio::sync::{mpsc, Mutex};

        use super::*;
        use crate::batch::ChannelEventSender;
        use crate::handler::{handle_message, SnapshotSenders};
        use crate::protocol::HubToAgent;

        const FIXTURE_DEADLINE: Duration = Duration::from_secs(10);
        const TRACED_EXIT_RELEASE_DELAY: Duration = Duration::from_millis(250);

        /// Ensures a fixture does not survive if a test fails before teardown.
        struct WorkloadCleanup {
            shell_pid: i32,
            child_pid: i32,
            pid_file: PathBuf,
            armed: bool,
        }

        impl WorkloadCleanup {
            fn disarm(mut self) {
                let _ = fs::remove_file(&self.pid_file);
                self.armed = false;
            }
        }

        impl Drop for WorkloadCleanup {
            fn drop(&mut self) {
                if !self.armed {
                    return;
                }
                // SAFETY: the shell PID comes from the PTY we just spawned. The
                // negative PID addresses that shell's process group, which the
                // fixture below verifies contains the reported child.
                // These raw PIDs can theoretically be reused after the fixture
                // exits and before an unwind; the fixture is short-lived, so
                // this deliberately accepted cleanup-only risk stays bounded.
                unsafe {
                    libc::kill(-self.shell_pid, libc::SIGKILL);
                    libc::kill(self.child_pid, libc::SIGKILL);
                }
                let _ = fs::remove_file(&self.pid_file);
            }
        }

        fn quote_for_sh(path: &Path) -> String {
            format!(
                "'{}'",
                path.display().to_string().replace('\'', "'\\\"'\\\"'")
            )
        }

        fn pid_file() -> PathBuf {
            std::env::temp_dir().join(format!(
                "lasterm-agent-tree-teardown-{}-{}.pid",
                std::process::id(),
                ulid::Ulid::generate()
            ))
        }

        fn pid_is_alive(pid: i32) -> io::Result<bool> {
            // SAFETY: signal 0 checks liveness without delivering a signal.
            let rc = unsafe { libc::kill(pid, 0) };
            if rc == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ESRCH) => Ok(false),
                Some(libc::EPERM) => Ok(true),
                _ => Err(error),
            }
        }

        fn enable_subreaper() -> io::Result<()> {
            // Reap an orphaned background child ourselves in containers whose
            // PID 1 does not promptly reap zombies, keeping kill(pid, 0) honest.
            // SAFETY: PR_SET_CHILD_SUBREAPER affects only this test process and
            // its descendants; the remaining varargs are zero as required. It
            // is process-global and intentionally not restored, so sibling-test
            // orphaned grandchildren can also be adopted and left unreaped.
            let rc = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
            if rc == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        fn reap_if_adopted(pid: i32) -> io::Result<()> {
            let mut status = 0;
            // SAFETY: pid is a fixture child; WNOHANG prevents blocking.
            let rc = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if rc == -1 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ECHILD) {
                    return Err(error);
                }
            }
            Ok(())
        }

        fn hold_at_exit(pid: i32) -> io::Result<()> {
            // PTRACE_O_TRACEEXIT leaves the tracee stopped after SIGKILL until
            // the test releases it. This makes the fixture's death observably
            // slow without changing the production teardown timeout.
            // SAFETY: pid belongs to a PTY child spawned by this test; the
            // option value is passed as the ptrace data word.
            let rc = unsafe {
                libc::ptrace(
                    libc::PTRACE_SEIZE,
                    pid,
                    std::ptr::null_mut::<libc::c_void>(),
                    libc::PTRACE_O_TRACEEXIT as *mut libc::c_void,
                )
            };
            if rc == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        fn release_exit(pid: i32) -> io::Result<()> {
            // SAFETY: a successfully seized fixture is stopped at its traced
            // exit event before this function is called.
            let rc = unsafe {
                libc::ptrace(
                    libc::PTRACE_CONT,
                    pid,
                    std::ptr::null_mut::<libc::c_void>(),
                    std::ptr::null_mut::<libc::c_void>(),
                )
            };
            if rc == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        struct TracedProcessesCleanup {
            pids: Vec<i32>,
        }

        impl Drop for TracedProcessesCleanup {
            fn drop(&mut self) {
                for &pid in &self.pids {
                    // Best effort only: an assertion may fire before a traced
                    // process has reached its exit stop. Resume any stopped
                    // tracee after SIGKILL so this test cannot strand it.
                    // SAFETY: each PID was just spawned and seized by this test.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                        libc::ptrace(
                            libc::PTRACE_CONT,
                            pid,
                            std::ptr::null_mut::<libc::c_void>(),
                            std::ptr::null_mut::<libc::c_void>(),
                        );
                    }
                }
            }
        }

        async fn wait_for_child_pid(path: &Path) -> i32 {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                if let Ok(contents) = fs::read_to_string(path) {
                    if let Ok(pid) = contents.trim().parse() {
                        return pid;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "fixture did not write child PID to {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn wait_until_gone(pid: i32) {
            let deadline = Instant::now() + FIXTURE_DEADLINE;
            loop {
                reap_if_adopted(pid).expect("reap adopted fixture child");
                if !pid_is_alive(pid).expect("check fixture child liveness") {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "background child PID {pid} survived terminal teardown"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        async fn spawn_background_workload(
            manager: &mut PtyManager,
            channel_id: String,
        ) -> (String, WorkloadCleanup) {
            let child_pid_file = pid_file();
            let args = vec![
                "-c".to_string(),
                format!(
                    "set +m; /bin/sh -c 'trap \"\" HUP; exec sleep 30' & child=$!; printf '%s\\n' \"$child\" > {}; wait",
                    quote_for_sh(&child_pid_file)
                ),
            ];
            let (channel_id, shell_pid) = manager
                .spawn(
                    OwnerId::stdio(),
                    Some(channel_id),
                    "/bin/sh",
                    &args,
                    None,
                    None,
                    80,
                    24,
                )
                .await
                .expect("spawn background workload");
            let child_pid = wait_for_child_pid(&child_pid_file).await;
            assert!(pid_is_alive(child_pid).expect("check fixture child liveness"));
            // SAFETY: child_pid was written by the live fixture and getpgid only
            // observes its process group.
            assert_eq!(unsafe { libc::getpgid(child_pid) }, shell_pid as i32);
            (
                channel_id,
                WorkloadCleanup {
                    shell_pid: shell_pid as i32,
                    child_pid,
                    pid_file: child_pid_file,
                    armed: true,
                },
            )
        }

        #[tokio::test]
        async fn destroy_all_kills_a_background_child_in_the_shell_process_group() {
            // Regression: replacing kill_tree() with kill() kills only the
            // shell, leaving this background child alive and making this fail.
            enable_subreaper().expect("enable child subreaper");
            let mut manager = PtyManager::new();
            let (_channel_id, cleanup) =
                spawn_background_workload(&mut manager, "destroy-all-tree".to_string()).await;

            manager.destroy_all().await;
            wait_until_gone(cleanup.child_pid).await;
            cleanup.disarm();
        }

        #[tokio::test]
        async fn destroy_message_kills_a_background_child_in_the_shell_process_group() {
            enable_subreaper().expect("enable child subreaper");
            let manager = Arc::new(Mutex::new(PtyManager::new()));
            let (channel_id, cleanup) = {
                let mut guard = manager.lock().await;
                spawn_background_workload(&mut guard, "destroy-message-tree".to_string()).await
            };
            let (frame_tx, _frame_rx) = mpsc::unbounded_channel();
            let (channel_events, _channel_events_rx) =
                ChannelEventSender::new(crate::flow::Flows::default());
            let cmd_senders: SnapshotSenders = Arc::new(Mutex::new(HashMap::new()));

            // There is deliberately no reader task here, so this test cannot
            // cover a reused channel ID interacting with a reader; #114 owns
            // that pre-existing ID-only cleanup problem.

            handle_message(
                HubToAgent::Destroy {
                    channel_id: channel_id.clone(),
                },
                &OwnerId::stdio(),
                &crate::handler::ConnectionRef::stdio(),
                Arc::clone(&manager),
                frame_tx,
                channel_events,
                cmd_senders,
            )
            .await
            .expect("handle DESTROY message");

            assert!(!manager.lock().await.contains(&channel_id));
            wait_until_gone(cleanup.child_pid).await;
            cleanup.disarm();
        }

        #[tokio::test]
        async fn destroy_all_reports_a_workload_unconfirmed_at_the_wait_bound() {
            let mut manager = PtyManager::new();
            let (channel_id, pid) = manager
                .spawn(
                    OwnerId::stdio(),
                    Some("unconfirmed-shutdown".to_string()),
                    "/bin/sh",
                    &["-c".to_string(), "sleep 30".to_string()],
                    None,
                    None,
                    80,
                    24,
                )
                .await
                .expect("spawn terminal workload");
            hold_at_exit(pid as i32).expect("trace terminal workload exit");
            let traced_cleanup = TracedProcessesCleanup {
                pids: vec![pid as i32],
            };

            let summary = manager.destroy_all().await;

            assert_eq!(summary.confirmed_shell_exits, 0);
            assert_eq!(
                summary.unresolved,
                vec![UnresolvedChannel {
                    channel_id,
                    pid,
                    reason: UnresolvedTeardown::TimedOut,
                }]
            );

            release_exit(pid as i32).expect("release terminal workload exit");
            drop(traced_cleanup);
        }

        #[tokio::test]
        async fn destroy_all_tears_down_several_channels_with_one_wait_bound() {
            let manager = Arc::new(Mutex::new(PtyManager::new()));
            let mut traced_pids = Vec::new();
            for number in 0..6 {
                let mut guard = manager.lock().await;
                let (_channel_id, pid) = guard
                    .spawn(
                        OwnerId::stdio(),
                        Some(format!("many-teardown-{number}")),
                        "/bin/sh",
                        &["-c".to_string(), "sleep 30".to_string()],
                        None,
                        None,
                        80,
                        24,
                    )
                    .await
                    .expect("spawn terminal workload");
                hold_at_exit(pid as i32).expect("trace terminal workload exit");
                traced_pids.push(pid as i32);
            }
            let traced_cleanup = TracedProcessesCleanup { pids: traced_pids };

            let started = Instant::now();
            let teardown_manager = Arc::clone(&manager);
            let teardown = tokio::spawn(async move {
                teardown_manager.lock().await.destroy_all().await;
            });

            tokio::time::sleep(TRACED_EXIT_RELEASE_DELAY).await;
            for &pid in &traced_cleanup.pids {
                release_exit(pid).expect("all workloads must be signalled before waiting");
            }
            teardown.await.expect("destroy all task");
            assert!(
                started.elapsed() < TRACED_EXIT_RELEASE_DELAY + Duration::from_secs(1),
                "all channels must wait concurrently after being signalled"
            );
            assert!(manager.lock().await.channel_ids().is_empty());

            // Mutation caught: changing destroy_all() to a sequential
            // signal-and-wait loop leaves five tracees running here, so their
            // release_exit() calls fail instead of reaching this assertion.
        }
    }
}
