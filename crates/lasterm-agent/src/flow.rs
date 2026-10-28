//! How much of a hub's terminal output the agent holds, and when it stops
//! reading that hub's terminals (#553).
//!
//! Every byte a reader takes from a PTY is charged to its channel's owner, the
//! hub, until that hub's connection has written it: first as read and not yet
//! routed ([`InTransit`]), then as queued for the connection ([`Queued`]). A
//! charge is released when it is dropped, wherever the bytes end: written,
//! moved to the hub's away queue, or thrown away with a connection that ended.
//!
//! Once a hub's charges reach the high mark, its terminals' readers stop
//! reading, and the programs writing to those terminals block, as on a real
//! terminal nobody reads. They read again once the charges drain to the low
//! mark. Only output is counted, and only readers wait: INPUT, requests and
//! their replies, HEARTBEAT_ACK included, never do.
//!
//! What counts is the hub's *current* connection. A connection that ends or is
//! replaced takes its queue out of the count, even while its writer is still
//! stuck on a socket nobody reads: a hub that connects again is not held back
//! by the connection it left behind (#127).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::Notify;

use crate::owner::OwnerId;

/// A hub's terminals stop being read once the agent holds this much of their
/// output for the hub's connection, and are read again once it drains to
/// `LOW_WATER`.
///
/// The hub reads its agents in flowing mode (`socket.on("data")`), so bytes
/// wait here only when its event loop stalls or its link is slower than the
/// terminals. Beyond the agent, the transport already keeps plenty in flight.
/// Over SSH, ssh2 opens every channel with a 2 MiB window, and sshd reads the
/// agent's socket or stdout only while that window has room: up to 2 MiB sit
/// in sshd and on the link. Add the kernel's buffer: 64 KiB for the daemon's
/// named pipe, a few hundred KiB for a Unix socket. So a queue here adds no
/// throughput: the window keeps the link busy, and a terminal refills this
/// queue far faster than any link drains it. What the queue does add is delay
/// (output, and the reply to an ATTACH, wait behind it) and memory, once per
/// connected hub. 1 MiB, half a window, absorbs the 16 ms batches of many busy
/// terminals and the hub's ordinary pauses (a GC, a spool write) without
/// throttling anything, and costs at most a second of delay on a 1 MB/s link.
pub(crate) const HIGH_WATER: usize = 1024 * 1024;

/// Reading resumes at this mark: the writer still has this much to write while
/// the programs wake and refill the queue, and a paused terminal is not woken
/// for every frame written.
pub(crate) const LOW_WATER: usize = 256 * 1024;

/// The marks a [`Flow`] pauses and resumes at.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Marks {
    pub(crate) high: usize,
    pub(crate) low: usize,
}

impl Marks {
    pub(crate) const DEFAULT: Marks = Marks {
        high: HIGH_WATER,
        low: LOW_WATER,
    };
}

#[derive(Default)]
struct FlowState {
    /// Read from a terminal, not yet handed to a connection or the away queue:
    /// in a reader, the batch loop, or on its way to the router.
    in_transit: usize,
    /// The hub's current connection, whose queue counts.
    connection: Option<u64>,
    /// Queued for that connection and not yet written to it.
    queued: usize,
}

impl FlowState {
    fn pending(&self) -> usize {
        self.in_transit + self.queued
    }
}

/// The output of one hub's terminals that the agent holds.
pub(crate) struct Flow {
    marks: Marks,
    state: Mutex<FlowState>,
    /// Woken when the pending bytes drain to the low mark.
    drained: Notify,
}

impl Flow {
    pub(crate) fn new(marks: Marks) -> Arc<Self> {
        Arc::new(Self {
            marks,
            state: Mutex::new(FlowState::default()),
            drained: Notify::new(),
        })
    }

    /// A charge is released from `Drop`, which must not panic: a poisoned lock
    /// still holds counts worth keeping.
    fn lock(&self) -> MutexGuard<'_, FlowState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Change the counts, and wake the paused readers if this drained them to
    /// the low mark.
    fn update(&self, change: impl FnOnce(&mut FlowState)) {
        let (before, after) = {
            let mut state = self.lock();
            let before = state.pending();
            change(&mut state);
            (before, state.pending())
        };
        if before > self.marks.low && after <= self.marks.low {
            self.drained.notify_waiters();
        }
    }

    /// Bytes read from this hub's terminals and not yet written to its
    /// current connection.
    pub(crate) fn pending(&self) -> usize {
        self.lock().pending()
    }

    /// Whether this hub's terminals must stop being read.
    pub(crate) fn full(&self) -> bool {
        self.pending() >= self.marks.high
    }

    /// Wait until the pending bytes have drained to the low mark.
    pub(crate) async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            // Registered before the check, so a drain in between still wakes it.
            notified.as_mut().enable();
            if self.pending() <= self.marks.low {
                return;
            }
            notified.await;
        }
    }

    /// Charge `bytes` just read from one of this hub's terminals.
    pub(crate) fn read(self: &Arc<Self>, bytes: usize) -> InTransit {
        self.update(|state| state.in_transit += bytes);
        InTransit {
            flow: Arc::clone(self),
            bytes,
        }
    }

    /// Charge a frame queued for `connection` that no reader charged: what the
    /// hub's terminals said while it was away, sent on to its new connection.
    pub(crate) fn queue(self: &Arc<Self>, connection: u64, bytes: usize) -> Queued {
        let mut counted = false;
        self.update(|state| {
            if state.connection == Some(connection) {
                state.queued += bytes;
                counted = true;
            }
        });
        Queued {
            flow: Arc::clone(self),
            connection,
            bytes,
            counted,
        }
    }

    /// `connection` is now the hub's: its queue is what counts, starting
    /// empty. What a previous connection still holds no longer does.
    pub(crate) fn attach(&self, connection: u64) {
        self.update(|state| {
            state.connection = Some(connection);
            state.queued = 0;
        });
    }

    /// `connection` ended or was replaced: what it still holds no longer
    /// counts. Another connection, attached since, is left alone.
    pub(crate) fn detach(&self, connection: u64) {
        self.update(|state| {
            if state.connection == Some(connection) {
                state.connection = None;
                state.queued = 0;
            }
        });
    }
}

/// Output read from a hub's terminal and not yet routed. Released on drop.
pub(crate) struct InTransit {
    flow: Arc<Flow>,
    bytes: usize,
}

impl InTransit {
    /// Take on another charge of the same hub, as the batch loop merges a
    /// channel's reads into one frame.
    pub(crate) fn absorb(&mut self, mut other: InTransit) {
        // One channel, one owner, one flow: the batch loop flushes a channel
        // before another hub's workload takes its id. Should two flows ever
        // meet, the other charge is released now rather than misattributed,
        // which would hold its hub back for good.
        if Arc::ptr_eq(&self.flow, &other.flow) {
            self.bytes += std::mem::take(&mut other.bytes);
        }
    }

    /// Hand these bytes to `connection`'s queue, as a frame of `frame_len`
    /// bytes, in one step: the count never dips in between, which would wake
    /// paused readers for nothing.
    pub(crate) fn queue_for(mut self, connection: u64, frame_len: usize) -> Queued {
        let bytes = std::mem::take(&mut self.bytes);
        let mut counted = false;
        self.flow.update(|state| {
            state.in_transit = state.in_transit.saturating_sub(bytes);
            if state.connection == Some(connection) {
                state.queued += frame_len;
                counted = true;
            }
        });
        Queued {
            flow: Arc::clone(&self.flow),
            connection,
            bytes: frame_len,
            counted,
        }
    }
}

impl Drop for InTransit {
    fn drop(&mut self) {
        let bytes = self.bytes;
        if bytes > 0 {
            self.flow
                .update(|state| state.in_transit = state.in_transit.saturating_sub(bytes));
        }
    }
}

/// Output queued for one connection of a hub and not yet written to it.
/// Released on drop: once written, or thrown away.
pub(crate) struct Queued {
    flow: Arc<Flow>,
    connection: u64,
    bytes: usize,
    /// Whether this connection was the hub's when the charge was made.
    counted: bool,
}

impl Drop for Queued {
    fn drop(&mut self) {
        if !self.counted {
            return;
        }
        let (connection, bytes) = (self.connection, self.bytes);
        self.flow.update(|state| {
            // A connection detached since counts for nothing any more.
            if state.connection == Some(connection) {
                state.queued = state.queued.saturating_sub(bytes);
            }
        });
    }
}

/// The flow of every hub, shared by the readers that charge it and the routes
/// that attach its connections. A hub keeps its flow for the agent's lifetime:
/// one small entry per hub key ever seen.
#[derive(Clone)]
pub(crate) struct Flows {
    marks: Marks,
    by_owner: Arc<Mutex<HashMap<OwnerId, Arc<Flow>>>>,
}

impl Flows {
    pub(crate) fn new(marks: Marks) -> Self {
        Self {
            marks,
            by_owner: Arc::default(),
        }
    }

    /// `owner`'s flow.
    pub(crate) fn of(&self, owner: &OwnerId) -> Arc<Flow> {
        let mut flows = self.by_owner.lock().unwrap_or_else(PoisonError::into_inner);
        Arc::clone(
            flows
                .entry(owner.clone())
                .or_insert_with(|| Flow::new(self.marks)),
        )
    }
}

impl Default for Flows {
    fn default() -> Self {
        Self::new(Marks::DEFAULT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const MARKS: Marks = Marks { high: 100, low: 40 };

    /// Not resumed until the bytes drain to the low mark: a reader paused at
    /// the high mark is not woken for every frame written.
    #[tokio::test]
    async fn a_paused_reader_waits_for_the_low_mark() {
        let flow = Flow::new(MARKS);
        flow.attach(1);
        let queued: Vec<Queued> = (0..10).map(|_| flow.read(10).queue_for(1, 10)).collect();
        assert!(flow.full());

        let waiter = tokio::spawn({
            let flow = Arc::clone(&flow);
            async move { flow.drained().await }
        });
        let mut queued = queued.into_iter();
        for _ in 0..5 {
            drop(queued.next());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiter.is_finished(),
            "resumed at 50 bytes, above the low mark"
        );
        drop(queued.next());
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("resumed at the low mark")
            .expect("the waiter does not panic");
        assert_eq!(flow.pending(), 40);
    }

    /// What a replaced connection still holds stops counting: the hub's new
    /// connection starts empty, and the old queue's later writes change
    /// nothing.
    #[tokio::test]
    async fn a_replaced_connection_holds_nothing_back() {
        let flow = Flow::new(MARKS);
        flow.attach(1);
        let stuck: Vec<Queued> = (0..12).map(|_| flow.read(10).queue_for(1, 10)).collect();
        assert!(flow.full());

        flow.attach(2);
        assert_eq!(flow.pending(), 0);
        tokio::time::timeout(Duration::from_secs(5), flow.drained())
            .await
            .expect("nothing holds the hub back");
        let fresh = flow.read(30).queue_for(2, 30);
        drop(stuck);
        assert_eq!(
            flow.pending(),
            30,
            "the old connection's writes count for nothing"
        );
        drop(fresh);
        assert_eq!(flow.pending(), 0);
    }

    /// Bytes routed while the hub has no connection, to its away queue,
    /// count for nothing once released; nor does a detach of a connection
    /// that is no longer the hub's undo the current one.
    #[test]
    fn only_the_current_connection_counts() {
        let flow = Flow::new(MARKS);
        drop(flow.read(70));
        assert_eq!(flow.pending(), 0);

        flow.attach(1);
        flow.attach(2);
        let queued = flow.read(20).queue_for(2, 25);
        flow.detach(1);
        assert_eq!(
            flow.pending(),
            25,
            "detaching a replaced connection changes nothing"
        );
        flow.detach(2);
        assert_eq!(flow.pending(), 0);
        drop(queued);
        assert_eq!(flow.pending(), 0);
    }

    /// Merged charges are released together; charges of another hub are not
    /// taken on.
    #[test]
    fn a_batch_carries_the_charges_it_merged() {
        let flow = Flow::new(MARKS);
        let other = Flow::new(MARKS);
        let mut batch = flow.read(10);
        batch.absorb(flow.read(15));
        batch.absorb(other.read(7));
        assert_eq!(flow.pending(), 25);
        assert_eq!(
            other.pending(),
            0,
            "another hub's charge is released, not kept"
        );
        drop(batch);
        assert_eq!(flow.pending(), 0);
    }
}
