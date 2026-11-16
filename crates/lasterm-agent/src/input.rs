//! What a hub types into a terminal, on its way to the PTY (#740).
//!
//! Each channel has a queue of its own, which a task of its own writes to the
//! PTY. The connection an INPUT comes in on only queues it: a terminal that
//! takes no input holds up its own input and nothing else, not another
//! channel's INPUT, a RESIZE, a SPAWN or a HEARTBEAT. One writer per channel,
//! taking its queue in order, keeps a channel's bytes in the order they came.
//!
//! A terminal takes no input when its program does not read it and the PTY's
//! own buffer is full; and on Windows while its output is held back (#553),
//! since ConPTY takes no input then.
//!
//! The queue is bounded in bytes. An INPUT that would take it past the bound
//! is dropped whole, and so is every INPUT after it until the terminal has
//! taken everything queued: what reaches the program is whole INPUTs, in
//! order, with one gap. The hub is told once per gap, by an `INPUT_DROPPED`
//! ERROR naming the channel. Pausing the connection's reads instead would hold
//! up every other channel and the hub's heartbeats, which is what this queue
//! is for.
//!
//! A paste (#1014) goes through the same queue, as chunks its hub sends one
//! window at a time. The queue writes its markers itself, decided once at its
//! first chunk, and tells the hub when the terminal took each chunk, which is
//! what lets the next one come. A paste is never dropped in part: a chunk the
//! bound cannot take, one out of order, a cancel, a newer paste or the end of
//! the connection that sent it closes it. Closing skips what is still queued
//! of it and, when its start marker went out, writes its end marker right
//! after the last of it that did, before anything queued later.
//!
//! The queue lives as long as its channel is registered: removing the channel
//! (DESTROY, its exit, the daemon's shutdown) drops it, which ends its writer
//! and frees what it held.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// What one terminal's queue holds at most: input its hub sent that the
/// terminal has not taken yet.
///
/// A hub sends at most 64 KiB in one INPUT (`MAX_INPUT_SIZE` in
/// `@lasterm/shared`), and a terminal whose program reads takes it about as
/// fast as it comes: the queue holds more than a few INPUTs only while a
/// program is slow to read, or does not read at all. 1 MiB is sixteen of the
/// largest INPUTs, four times the window a paste keeps in flight
/// (`PASTE_WINDOW_BYTES` in `@lasterm/shared`), and the same as the output the
/// agent holds for a hub before it stops reading that hub's terminals
/// (`flow::HIGH_WATER`). It costs at most 1 MiB per terminal that takes no
/// input while its hub keeps sending to it.
pub(crate) const INPUT_QUEUE_BYTES: usize = 1024 * 1024;

/// What the writer hands the PTY at a time. On Windows a write is a message to
/// the ConPTY writer thread, which holds up to 64 of them queued and one it is
/// writing: writing 4 KiB at a time keeps what they hold to 260 KiB, whatever
/// the size of the INPUT.
const WRITE_CHUNK: usize = 4096;

/// What opens a bracketed paste, and what closes it.
pub(crate) const PASTE_START: &[u8] = b"\x1b[200~";
pub(crate) const PASTE_END: &[u8] = b"\x1b[201~";

/// Why a paste ended before its last chunk was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloseReason {
    /// Its hub cancelled it: the user did, or its window left or lost the
    /// terminal's write lock.
    Cancelled,
    /// A newer paste opened on the terminal.
    Superseded,
    /// A chunk came that was not the next one.
    OutOfOrder,
    /// A chunk came that the queue's bound could not take.
    Overflow,
    /// The connection that sent it ended or was replaced.
    Connection,
}

impl CloseReason {
    /// Its name in PASTE_CLOSED.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
            Self::OutOfOrder => "out_of_order",
            Self::Overflow => "overflow",
            Self::Connection => "connection",
        }
    }
}

/// What the queue tells a paste's hub.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PasteEvent {
    /// The terminal took chunk `seq`; for a bracketed paste's last chunk, its
    /// end marker too.
    Ack { paste_id: u32, seq: u32 },
    /// The paste ended before its end: `written` of its data bytes went out.
    Closed {
        paste_id: u32,
        reason: CloseReason,
        written: u64,
    },
}

/// Where a paste's events go: its connection, while it is its hub's current
/// one. The caller decides; the queue only calls it.
pub(crate) type PasteReport = Arc<dyn Fn(PasteEvent) + Send + Sync>;

/// What became of a paste chunk offered to a channel's queue.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PasteOffer {
    /// Queued after what came before it.
    Queued,
    /// The chunk closed its paste (out of order, or past the bound); its
    /// PASTE_CLOSED follows once the writer has closed it.
    Closed,
    /// No paste of this connection is open with this id: nothing changed.
    Unknown,
    /// The terminal is gone, and its exit is on its way to the hub.
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PasteKey {
    connection: u64,
    id: u32,
}

/// A paste the queue has opened and not yet finished.
struct Paste {
    key: PasteKey,
    /// Decided at its first chunk, from the program's mode then.
    bracketed: bool,
    /// The chunk it takes next.
    next_seq: u32,
    /// Its last chunk, once received.
    last_seq: Option<u32>,
    /// Why it was closed; `None` while it is open.
    closed: Option<CloseReason>,
    /// Its start marker has been written.
    start_written: bool,
    /// Its data bytes written so far.
    written: u64,
    report: PasteReport,
}

/// What the writer takes, in order.
enum Entry {
    Input(Vec<u8>),
    Start(PasteKey),
    Data {
        key: PasteKey,
        seq: u32,
        bytes: Vec<u8>,
    },
    End(PasteKey),
    /// Nothing to write: a closed paste is to be finished now.
    Wake,
}

#[derive(Default)]
struct QueueState {
    /// Bytes queued and not yet taken by the terminal: INPUTs and paste data,
    /// never the markers.
    queued: usize,
    /// An INPUT was dropped, and the terminal has not yet taken everything
    /// queued before it: what comes meanwhile is dropped too. Paste chunks
    /// are judged by the bound alone.
    dropping: bool,
    /// The writer has ended: the terminal took a write as an error, which
    /// means it is gone.
    closed: bool,
    /// Pastes opened and not yet finished: at most one open, and those closed
    /// whose end the writer has not written yet.
    pastes: Vec<Paste>,
}

impl QueueState {
    fn paste(&self, key: PasteKey) -> Option<&Paste> {
        self.pastes.iter().find(|paste| paste.key == key)
    }

    fn paste_mut(&mut self, key: PasteKey) -> Option<&mut Paste> {
        self.pastes.iter_mut().find(|paste| paste.key == key)
    }

    fn is_open(&self, key: PasteKey) -> bool {
        self.paste(key).is_some_and(|paste| paste.closed.is_none())
    }

    fn take(&mut self, key: PasteKey) -> Option<Paste> {
        let index = self.pastes.iter().position(|paste| paste.key == key)?;
        Some(self.pastes.remove(index))
    }
}

/// What became of an INPUT offered to a channel's queue.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Offer {
    /// Queued, to be written to the terminal after what came before it.
    Queued,
    /// Dropped, and the first INPUT dropped since the terminal last took
    /// everything queued: the hub is to be told.
    Overflowed,
    /// Dropped, as everything is until the terminal has taken what is
    /// queued. The hub has been told already.
    Dropped,
    /// Dropped: the terminal is gone, and its exit is on its way to the hub.
    Closed,
}

/// One channel's input queue and the writer that takes it to the PTY.
pub(crate) struct InputQueue {
    tx: mpsc::UnboundedSender<Entry>,
    state: Arc<Mutex<QueueState>>,
    bound: usize,
    writer: AbortHandle,
}

fn lock(state: &Mutex<QueueState>) -> MutexGuard<'_, QueueState> {
    // A poisoned lock still holds counts worth keeping, and `Drop` must not
    // panic.
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

impl InputQueue {
    /// Start the writer of `channel_id`'s input to `pty`, holding no more
    /// than `bound` bytes for it.
    pub(crate) fn start<W>(channel_id: &str, pty: W, bound: usize) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx, rx) = mpsc::unbounded_channel();
        let state = Arc::new(Mutex::new(QueueState::default()));
        let writer = tokio::spawn(write_input(
            channel_id.to_owned(),
            pty,
            rx,
            Arc::clone(&state),
        ))
        .abort_handle();
        Self {
            tx,
            state,
            bound,
            writer,
        }
    }

    /// Hand `entry` to the writer; false once it has ended.
    fn push(&self, state: &mut QueueState, entry: Entry) -> bool {
        if self.tx.send(entry).is_err() {
            state.closed = true;
            return false;
        }
        true
    }

    /// Queue an INPUT whole, or drop it whole. Never waits.
    pub(crate) fn offer(&self, data: Vec<u8>) -> Offer {
        let mut state = lock(&self.state);
        if state.closed {
            return Offer::Closed;
        }
        if state.dropping {
            if state.queued > 0 {
                return Offer::Dropped;
            }
            state.dropping = false;
        }
        let len = data.len();
        if state.queued + len > self.bound {
            state.dropping = true;
            return Offer::Overflowed;
        }
        // Counted before it is sent, under the lock: the writer cannot take
        // it before it counts.
        state.queued += len;
        if !self.push(&mut state, Entry::Input(data)) {
            state.queued -= len;
            return Offer::Closed;
        }
        Offer::Queued
    }

    /// Queue chunk `seq` of paste `paste_id` from `connection`, or close the
    /// paste it breaks. Never waits.
    ///
    /// Chunk 0 opens the paste, closing any other still open (`superseded`):
    /// `bracketed` is asked then, once, and decides both markers. A later
    /// chunk is taken only as the next one of the open paste of the same
    /// connection and id; one that is not closes that paste (`out_of_order`),
    /// and one for a paste of no open paste of this connection changes
    /// nothing. A chunk the bound cannot take closes its paste (`overflow`).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn offer_paste(
        &self,
        connection: u64,
        paste_id: u32,
        seq: u32,
        data: Vec<u8>,
        last: bool,
        bracketed: impl FnOnce() -> bool,
        report: PasteReport,
    ) -> PasteOffer {
        let mut state = lock(&self.state);
        if state.closed {
            return PasteOffer::Gone;
        }
        let key = PasteKey {
            connection,
            id: paste_id,
        };
        let len = data.len();
        if seq == 0 {
            // Only this connection's: a paste is changed by its own connection
            // alone (a displaced one's were closed when it was displaced).
            for paste in state.pastes.iter_mut() {
                if paste.closed.is_none() && paste.key.connection == connection {
                    paste.closed = Some(CloseReason::Superseded);
                }
            }
            let bracketed = bracketed();
            let mut paste = Paste {
                key,
                bracketed,
                next_seq: 1,
                last_seq: last.then_some(0),
                closed: None,
                start_written: false,
                written: 0,
                report,
            };
            if state.queued + len > self.bound {
                paste.closed = Some(CloseReason::Overflow);
                state.pastes.push(paste);
                return if self.push(&mut state, Entry::Wake) {
                    PasteOffer::Closed
                } else {
                    PasteOffer::Gone
                };
            }
            state.pastes.push(paste);
            return self.queue_chunk(&mut state, key, 0, data, last, bracketed);
        }
        let Some(open) = state
            .pastes
            .iter()
            .position(|paste| paste.closed.is_none() && paste.key.connection == connection)
        else {
            // A chunk still in flight for a paste closed and not yet finished:
            // its PASTE_CLOSED, with its reason and count, is the answer.
            if state.paste(key).is_some() {
                return PasteOffer::Closed;
            }
            return PasteOffer::Unknown;
        };
        let paste = &mut state.pastes[open];
        if paste.key.id != paste_id || paste.last_seq.is_some() || seq != paste.next_seq {
            paste.closed = Some(CloseReason::OutOfOrder);
            return self.wake(&mut state);
        }
        if state.queued + len > self.bound {
            state.pastes[open].closed = Some(CloseReason::Overflow);
            return self.wake(&mut state);
        }
        let paste = &mut state.pastes[open];
        paste.next_seq = seq.wrapping_add(1);
        if last {
            paste.last_seq = Some(seq);
        }
        let bracketed = paste.bracketed;
        self.queue_chunk(&mut state, key, seq, data, last, bracketed)
    }

    fn queue_chunk(
        &self,
        state: &mut QueueState,
        key: PasteKey,
        seq: u32,
        bytes: Vec<u8>,
        last: bool,
        bracketed: bool,
    ) -> PasteOffer {
        let len = bytes.len();
        state.queued += len;
        let mut sent = true;
        if seq == 0 && bracketed {
            sent &= self.push(state, Entry::Start(key));
        }
        sent &= self.push(state, Entry::Data { key, seq, bytes });
        if last && bracketed {
            sent &= self.push(state, Entry::End(key));
        }
        if !sent {
            state.queued = state.queued.saturating_sub(len);
            return PasteOffer::Gone;
        }
        PasteOffer::Queued
    }

    fn wake(&self, state: &mut QueueState) -> PasteOffer {
        if self.push(state, Entry::Wake) {
            PasteOffer::Closed
        } else {
            PasteOffer::Gone
        }
    }

    /// Close paste `paste_id` of `connection` if it is still open
    /// (`cancelled`); true if it was.
    pub(crate) fn cancel_paste(&self, connection: u64, paste_id: u32) -> bool {
        let mut state = lock(&self.state);
        let key = PasteKey {
            connection,
            id: paste_id,
        };
        let Some(paste) = state.paste_mut(key).filter(|paste| paste.closed.is_none()) else {
            return false;
        };
        paste.closed = Some(CloseReason::Cancelled);
        self.push(&mut state, Entry::Wake);
        true
    }

    /// Close every paste `connection` still has open: it ended, or a newer
    /// connection of its hub replaced it.
    pub(crate) fn close_connection(&self, connection: u64) {
        let mut state = lock(&self.state);
        let mut closed = false;
        for paste in state.pastes.iter_mut() {
            if paste.key.connection == connection && paste.closed.is_none() {
                paste.closed = Some(CloseReason::Connection);
                closed = true;
            }
        }
        if closed {
            self.push(&mut state, Entry::Wake);
        }
    }

    /// Bytes queued and not yet taken by the terminal.
    #[cfg(test)]
    pub(crate) fn queued(&self) -> usize {
        lock(&self.state).queued
    }

    /// Alive while this queue or its writer is: a test watches it end.
    #[cfg(test)]
    pub(crate) fn liveness(&self) -> std::sync::Weak<impl Sized> {
        Arc::downgrade(&self.state)
    }
}

impl Drop for InputQueue {
    /// The channel is gone: its writer ends, even in the middle of a write
    /// the terminal is not taking, and what it held is freed with it.
    fn drop(&mut self) {
        self.writer.abort();
    }
}

/// Write `channel_id`'s queue to its PTY, in order, until the queue is gone or
/// the PTY refuses a write.
async fn write_input<W>(
    channel_id: String,
    mut pty: W,
    mut queue: mpsc::UnboundedReceiver<Entry>,
    state: Arc<Mutex<QueueState>>,
) where
    W: AsyncWrite + Unpin,
{
    while let Some(entry) = queue.recv().await {
        let written = async {
            finish_closed(&mut pty, &state).await?;
            write_entry(&mut pty, &state, entry).await?;
            finish_closed(&mut pty, &state).await
        }
        .await;
        if let Err(error) = written {
            // The terminal is gone: the slave side closed, or ConPTY's input
            // with it. Its exit reaches the hub through its reader.
            tracing::debug!(
                channel_id = %channel_id,
                %error,
                "terminal input refused; dropping what is queued for it"
            );
            let mut state = lock(&state);
            state.closed = true;
            state.queued = 0;
            return;
        }
    }
}

async fn write_entry<W>(pty: &mut W, state: &Mutex<QueueState>, entry: Entry) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    match entry {
        Entry::Input(data) => {
            for chunk in data.chunks(WRITE_CHUNK) {
                pty.write_all(chunk).await?;
                let mut state = lock(state);
                state.queued = state.queued.saturating_sub(chunk.len());
            }
        }
        Entry::Start(key) => {
            if lock(state).is_open(key) {
                pty.write_all(PASTE_START).await?;
                if let Some(paste) = lock(state).paste_mut(key) {
                    paste.start_written = true;
                }
            }
        }
        Entry::Data { key, seq, bytes } => {
            let mut done = 0;
            for chunk in bytes.chunks(WRITE_CHUNK) {
                {
                    let mut state = lock(state);
                    if !state.is_open(key) {
                        // Closed: none of the rest goes out. A write already
                        // started was finished above.
                        state.queued = state.queued.saturating_sub(bytes.len() - done);
                        return Ok(());
                    }
                }
                pty.write_all(chunk).await?;
                done += chunk.len();
                let mut state = lock(state);
                state.queued = state.queued.saturating_sub(chunk.len());
                if let Some(paste) = state.paste_mut(key) {
                    paste.written += chunk.len() as u64;
                }
            }
            let answer = {
                let mut state = lock(state);
                match state.paste(key) {
                    Some(paste) if paste.closed.is_none() => {
                        if paste.last_seq == Some(seq) && paste.bracketed {
                            // Acknowledged with its end marker.
                            None
                        } else if paste.last_seq == Some(seq) {
                            state.take(key).map(|paste| paste.report)
                        } else {
                            Some(Arc::clone(&paste.report))
                        }
                    }
                    _ => None,
                }
            };
            if let Some(report) = answer {
                report(PasteEvent::Ack {
                    paste_id: key.id,
                    seq,
                });
            }
        }
        Entry::End(key) => {
            if lock(state).is_open(key) {
                pty.write_all(PASTE_END).await?;
                let finished = lock(state).take(key);
                if let Some(paste) = finished {
                    let event = match paste.closed {
                        None => PasteEvent::Ack {
                            paste_id: key.id,
                            seq: paste.last_seq.unwrap_or(0),
                        },
                        Some(reason) => PasteEvent::Closed {
                            paste_id: key.id,
                            reason,
                            written: paste.written,
                        },
                    };
                    (paste.report)(event);
                }
            }
        }
        Entry::Wake => {}
    }
    Ok(())
}

/// Finish every closed paste: its end marker, when its start marker went
/// out, then its PASTE_CLOSED. Run before and after each entry, so the marker
/// follows the last byte of the paste written and precedes the next entry.
async fn finish_closed<W>(pty: &mut W, state: &Mutex<QueueState>) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    loop {
        let next = {
            let state = lock(state);
            state
                .pastes
                .iter()
                .find(|paste| paste.closed.is_some())
                .map(|paste| (paste.key, paste.start_written))
        };
        let Some((key, start_written)) = next else {
            return Ok(());
        };
        if start_written {
            pty.write_all(PASTE_END).await?;
        }
        let finished = lock(state).take(key);
        if let Some(paste) = finished {
            (paste.report)(PasteEvent::Closed {
                paste_id: key.id,
                reason: paste.closed.unwrap_or(CloseReason::Cancelled),
                written: paste.written,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    /// A PTY that takes nothing until `open` is set, then everything, and
    /// keeps what it took.
    #[derive(Clone, Default)]
    struct Valve {
        open: Arc<std::sync::atomic::AtomicBool>,
        taken: Arc<Mutex<Vec<u8>>>,
    }

    impl AsyncWrite for Valve {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.open.load(std::sync::atomic::Ordering::SeqCst) {
                self.taken.lock().unwrap().extend_from_slice(buf);
                Poll::Ready(Ok(buf.len()))
            } else {
                // Polled again soon: a test waits a few milliseconds at most.
                let waker = cx.waker().clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    waker.wake();
                });
                Poll::Pending
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    async fn drained(queue: &InputQueue) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while queue.queued() > 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the queue drains once the terminal takes input");
    }

    /// Dropped whole past the bound, said once per gap, and taken again once
    /// the terminal has taken everything queued before the gap.
    #[tokio::test]
    async fn a_full_queue_drops_whole_inputs_until_the_terminal_takes_it() {
        let pty = Valve::default();
        let queue = InputQueue::start("valve", pty.clone(), 10);

        assert_eq!(queue.offer(b"aaaa".to_vec()), Offer::Queued);
        assert_eq!(queue.offer(b"bbbb".to_vec()), Offer::Queued);
        assert_eq!(queue.offer(b"ccc".to_vec()), Offer::Overflowed);
        assert_eq!(
            queue.offer(b"d".to_vec()),
            Offer::Dropped,
            "fits, but follows a drop"
        );
        assert_eq!(queue.queued(), 8);

        pty.open.store(true, std::sync::atomic::Ordering::SeqCst);
        drained(&queue).await;
        assert_eq!(queue.offer(b"eeeeeeeeee".to_vec()), Offer::Queued);
        drained(&queue).await;
        assert_eq!(
            queue.offer(b"fffffffffff".to_vec()),
            Offer::Overflowed,
            "over the bound alone"
        );
        assert_eq!(*pty.taken.lock().unwrap(), b"aaaabbbbeeeeeeeeee");
    }

    /// Dropping the queue ends its writer, even one stuck on a terminal that
    /// takes nothing, and frees what it held.
    #[tokio::test]
    async fn dropping_the_queue_ends_its_writer() {
        let queue = InputQueue::start("valve", Valve::default(), 1024);
        assert_eq!(queue.offer(vec![b'x'; 100]), Offer::Queued);
        let liveness = queue.liveness();
        drop(queue);
        tokio::time::timeout(Duration::from_secs(5), async {
            while liveness.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the writer ends with its queue");
    }

    // ─── Pastes (#1014) ─────────────────────────────────────────────────────

    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// A PTY that takes one write per permit, or every write once open, and
    /// keeps what it took. A write it does not take stays pending, as on a
    /// terminal whose program does not read: started, not taken.
    #[derive(Clone, Default)]
    struct Gate {
        permits: Arc<AtomicUsize>,
        open: Arc<AtomicBool>,
        pending: Arc<AtomicUsize>,
        taken: Arc<Mutex<Vec<u8>>>,
    }

    impl Gate {
        fn opened() -> Self {
            let gate = Self::default();
            gate.open.store(true, Ordering::SeqCst);
            gate
        }

        fn release(&self, writes: usize) {
            self.permits.fetch_add(writes, Ordering::SeqCst);
        }

        fn open_all(&self) {
            self.open.store(true, Ordering::SeqCst);
        }

        fn taken(&self) -> Vec<u8> {
            self.taken.lock().unwrap().clone()
        }

        /// Wait until the PTY holds `len` bytes, then until the writer is
        /// pending on its next write, if any is coming.
        async fn holds(&self, len: usize) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.taken.lock().unwrap().len() < len {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("the PTY takes what it was let take");
        }

        /// Wait until a write is pending on the PTY.
        async fn blocked(&self) {
            let before = self.pending.load(Ordering::SeqCst);
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.pending.load(Ordering::SeqCst) == before {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("the writer waits on the PTY");
        }
    }

    impl AsyncWrite for Gate {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            let permitted = self.open.load(Ordering::SeqCst)
                || self
                    .permits
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok();
            if permitted {
                self.taken.lock().unwrap().extend_from_slice(buf);
                return Poll::Ready(Ok(buf.len()));
            }
            self.pending.fetch_add(1, Ordering::SeqCst);
            let waker = cx.waker().clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2)).await;
                waker.wake();
            });
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    type Events = Arc<Mutex<Vec<PasteEvent>>>;

    fn recorder() -> (PasteReport, Events) {
        let events: Events = Arc::default();
        let sink = Arc::clone(&events);
        let report: PasteReport = Arc::new(move |event| sink.lock().unwrap().push(event));
        (report, events)
    }

    async fn event_count(events: &Events, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while events.lock().unwrap().len() < count {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{count} events expected, got {:?}", events.lock().unwrap()));
    }

    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    const CONN: u64 = 7;

    fn chunk(byte: u8, len: usize) -> Vec<u8> {
        vec![byte; len]
    }

    /// PS4 held: a chunk is acknowledged once the PTY took it, not when queued.
    #[tokio::test]
    async fn a_chunk_is_acknowledged_once_the_pty_takes_it() {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        let offered = queue.offer_paste(CONN, 1, 0, chunk(b'a', 10), false, || false, report);
        assert_eq!(offered, PasteOffer::Queued);
        pty.blocked().await;
        assert!(events.lock().unwrap().is_empty(), "queued is not taken");
        pty.open_all();
        event_count(&events, 1).await;
        assert_eq!(
            *events.lock().unwrap(),
            vec![PasteEvent::Ack {
                paste_id: 1,
                seq: 0
            }]
        );
    }

    /// PS4 last chunk: a bracketed paste's last chunk is acknowledged with its
    /// end marker, not before.
    #[tokio::test]
    async fn the_last_chunk_is_acknowledged_with_the_end_marker() {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, chunk(b'a', 10), true, || true, report);
        pty.release(2); // the start marker and the data, not the end marker
        pty.holds(PASTE_START.len() + 10).await;
        pty.blocked().await;
        assert!(
            events.lock().unwrap().is_empty(),
            "no ack before the marker"
        );
        pty.release(1);
        event_count(&events, 1).await;
        assert_eq!(
            pty.taken(),
            cat(&[PASTE_START, &chunk(b'a', 10), PASTE_END])
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec![PasteEvent::Ack {
                paste_id: 1,
                seq: 0
            }]
        );
    }

    /// PS1 and PS2 at the queue: whole, in order, with or without markers.
    #[tokio::test]
    async fn a_paste_reaches_the_pty_whole_with_its_markers_only_when_bracketed() {
        for bracketed in [true, false] {
            let pty = Gate::opened();
            let queue = InputQueue::start("gate", pty.clone(), 64 * 1024);
            let (report, events) = recorder();
            let mut expected = Vec::new();
            for seq in 0..16u32 {
                let data = chunk(b'a' + seq as u8, 8192);
                expected.extend_from_slice(&data);
                // One chunk in flight at a time: each waits for the previous ack.
                let offered = queue.offer_paste(
                    CONN,
                    3,
                    seq,
                    data,
                    seq == 15,
                    || bracketed,
                    Arc::clone(&report),
                );
                assert_eq!(offered, PasteOffer::Queued, "chunk {seq}");
                event_count(&events, seq as usize + 1).await;
            }
            let want = if bracketed {
                cat(&[PASTE_START, &expected, PASTE_END])
            } else {
                expected
            };
            assert_eq!(pty.taken(), want, "bracketed={bracketed}");
        }
    }

    /// PS3: the decision is taken at the first chunk.
    #[tokio::test]
    async fn bracketing_is_decided_at_the_first_chunk() {
        let pty = Gate::opened();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(
            CONN,
            1,
            0,
            chunk(b'a', 4),
            false,
            || true,
            Arc::clone(&report),
        );
        // The program turned bracketed paste off meanwhile: not asked again.
        queue.offer_paste(CONN, 1, 1, chunk(b'b', 4), true, || false, report);
        event_count(&events, 2).await;
        assert_eq!(
            pty.taken(),
            cat(&[PASTE_START, b"aaaa", b"bbbb", PASTE_END])
        );
    }

    /// Three chunks of 16 KiB queued behind a PTY that took the start marker
    /// and 4 KiB, its next 4 KiB write pending: 8 KiB of the first chunk go
    /// out, not the whole chunk.
    async fn paste_cut_after_one_write(bracketed: bool) -> (Gate, InputQueue, Events) {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        for seq in 0..3 {
            queue.offer_paste(
                CONN,
                5,
                seq,
                chunk(b'p', 16384),
                seq == 2,
                || bracketed,
                Arc::clone(&report),
            );
        }
        let start = if bracketed { PASTE_START.len() } else { 0 };
        pty.release(usize::from(bracketed) + 1);
        pty.holds(start + 4096).await;
        pty.blocked().await;
        (pty, queue, events)
    }

    /// PS5 bracketed: the write started finishes, nothing more of the paste
    /// goes out, then its end marker.
    #[tokio::test]
    async fn a_cancel_finishes_the_write_started_and_closes_the_paste() {
        let (pty, queue, events) = paste_cut_after_one_write(true).await;
        assert!(queue.cancel_paste(CONN, 5));
        pty.open_all();
        event_count(&events, 1).await;
        assert_eq!(
            pty.taken(),
            cat(&[PASTE_START, &chunk(b'p', 8192), PASTE_END])
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec![PasteEvent::Closed {
                paste_id: 5,
                reason: CloseReason::Cancelled,
                written: 8192
            }]
        );
        assert_eq!(queue.queued(), 0, "what was skipped is no longer counted");
    }

    /// PS5 not bracketed: the same writes, no marker.
    #[tokio::test]
    async fn a_cancel_without_bracketing_writes_no_marker() {
        let (pty, queue, events) = paste_cut_after_one_write(false).await;
        assert!(queue.cancel_paste(CONN, 5));
        pty.open_all();
        event_count(&events, 1).await;
        assert_eq!(pty.taken(), chunk(b'p', 8192));
        assert_eq!(
            *events.lock().unwrap(),
            vec![PasteEvent::Closed {
                paste_id: 5,
                reason: CloseReason::Cancelled,
                written: 8192
            }]
        );
    }

    /// PS5 before the start marker: nothing of the paste, no marker.
    #[tokio::test]
    async fn a_paste_cancelled_before_its_start_writes_nothing() {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        assert_eq!(queue.offer(b"ls".to_vec()), Offer::Queued);
        queue.offer_paste(CONN, 9, 0, chunk(b'p', 100), false, || true, report);
        pty.blocked().await; // still on the INPUT
        assert!(queue.cancel_paste(CONN, 9));
        pty.open_all();
        event_count(&events, 1).await;
        assert_eq!(pty.taken(), b"ls");
        assert_eq!(
            *events.lock().unwrap(),
            vec![PasteEvent::Closed {
                paste_id: 9,
                reason: CloseReason::Cancelled,
                written: 0
            }]
        );
    }

    /// PS5 after the last chunk: a paste whose last chunk was received stays
    /// cancellable until its end is written.
    #[tokio::test]
    async fn a_paste_stays_cancellable_after_its_last_chunk() {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 2, 0, chunk(b'p', 16384), true, || true, report);
        pty.release(2);
        pty.holds(PASTE_START.len() + 4096).await;
        pty.blocked().await;
        assert!(queue.cancel_paste(CONN, 2));
        pty.open_all();
        event_count(&events, 1).await;
        assert_eq!(
            pty.taken(),
            cat(&[PASTE_START, &chunk(b'p', 8192), PASTE_END])
        );
        assert!(matches!(
            events.lock().unwrap()[0],
            PasteEvent::Closed {
                reason: CloseReason::Cancelled,
                ..
            }
        ));
    }

    /// PS6: what follows a paste, or its close, is written after its end
    /// marker, even what was queued before the cancel.
    #[tokio::test]
    async fn input_after_a_paste_follows_its_end_marker() {
        // After the paste.
        let pty = Gate::opened();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"abc".to_vec(), true, || true, report);
        queue.offer(b"x".to_vec());
        event_count(&events, 1).await;
        pty.holds(PASTE_START.len() + 3 + PASTE_END.len() + 1).await;
        assert_eq!(pty.taken(), cat(&[PASTE_START, b"abc", PASTE_END, b"x"]));

        // After a cancel.
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, chunk(b'p', 16384), false, || true, report);
        pty.release(2);
        pty.holds(PASTE_START.len() + 4096).await;
        pty.blocked().await;
        queue.cancel_paste(CONN, 1);
        queue.offer(b"x".to_vec());
        pty.open_all();
        event_count(&events, 1).await;
        pty.holds(PASTE_START.len() + 8192 + PASTE_END.len() + 1)
            .await;
        assert_eq!(
            pty.taken(),
            cat(&[PASTE_START, &chunk(b'p', 8192), PASTE_END, b"x"])
        );

        // Queued before the cancel, behind the last chunk.
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, chunk(b'p', 16384), true, || true, report);
        queue.offer(b"x".to_vec());
        pty.release(2);
        pty.holds(PASTE_START.len() + 4096).await;
        pty.blocked().await;
        queue.cancel_paste(CONN, 1);
        pty.open_all();
        event_count(&events, 1).await;
        pty.holds(PASTE_START.len() + 8192 + PASTE_END.len() + 1)
            .await;
        assert_eq!(
            pty.taken(),
            cat(&[PASTE_START, &chunk(b'p', 8192), PASTE_END, b"x"])
        );
    }

    /// PS7 past the bound: the chunk the bound cannot take closes the paste;
    /// no later chunk goes out.
    #[tokio::test]
    async fn a_chunk_past_the_bound_closes_its_paste() {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 16 * 1024);
        let (report, events) = recorder();
        queue.offer_paste(
            CONN,
            4,
            0,
            chunk(b'a', 8192),
            false,
            || true,
            Arc::clone(&report),
        );
        pty.release(1);
        pty.holds(PASTE_START.len()).await;
        pty.blocked().await;
        let second = queue.offer_paste(
            CONN,
            4,
            1,
            chunk(b'b', 8192),
            false,
            || true,
            Arc::clone(&report),
        );
        assert_eq!(second, PasteOffer::Queued);
        let third = queue.offer_paste(
            CONN,
            4,
            2,
            chunk(b'c', 8192),
            false,
            || true,
            Arc::clone(&report),
        );
        assert_eq!(third, PasteOffer::Closed);
        let fourth = queue.offer_paste(CONN, 4, 3, chunk(b'd', 8192), true, || true, report);
        assert_eq!(
            fourth,
            PasteOffer::Closed,
            "closed and not yet finished: its own PASTE_CLOSED is the answer, not `unknown`"
        );
        pty.open_all();
        event_count(&events, 1).await;
        let taken = pty.taken();
        assert!(taken.starts_with(PASTE_START) && taken.ends_with(PASTE_END));
        let data = &taken[PASTE_START.len()..taken.len() - PASTE_END.len()];
        assert!(data.len() <= 16 * 1024 && data.iter().all(|&b| b == b'a' || b == b'b'));
        assert!(!data.contains(&b'c') && !data.contains(&b'd'));
        assert!(matches!(
            events.lock().unwrap().last(),
            Some(PasteEvent::Closed {
                reason: CloseReason::Overflow,
                ..
            })
        ));
    }

    /// PS7 during INPUT's gap: a chunk within the bound is taken.
    #[tokio::test]
    async fn a_chunk_is_judged_by_the_bound_alone() {
        let pty = Gate::default();
        let queue = InputQueue::start("gate", pty.clone(), 100);
        let (report, events) = recorder();
        queue.offer_paste(
            CONN,
            1,
            0,
            chunk(b'a', 10),
            false,
            || false,
            Arc::clone(&report),
        );
        assert_eq!(queue.offer(vec![b'x'; 95]), Offer::Overflowed);
        assert_eq!(
            queue.offer(b"y".to_vec()),
            Offer::Dropped,
            "INPUT's gap is on"
        );
        let chunk_offer = queue.offer_paste(CONN, 1, 1, chunk(b'b', 10), true, || false, report);
        assert_eq!(chunk_offer, PasteOffer::Queued);
        pty.open_all();
        event_count(&events, 2).await;
        assert_eq!(pty.taken(), cat(&[&chunk(b'a', 10), &chunk(b'b', 10)]));
    }

    /// PS8: a chunk out of order closes its paste; one for no open paste
    /// changes nothing.
    #[tokio::test]
    async fn a_chunk_out_of_order_closes_its_paste() {
        let pty = Gate::opened();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(
            CONN,
            1,
            0,
            b"a".to_vec(),
            false,
            || true,
            Arc::clone(&report),
        );
        event_count(&events, 1).await;
        let skipped = queue.offer_paste(
            CONN,
            1,
            2,
            b"c".to_vec(),
            true,
            || true,
            Arc::clone(&report),
        );
        assert_eq!(skipped, PasteOffer::Closed);
        event_count(&events, 2).await;
        assert_eq!(pty.taken(), cat(&[PASTE_START, b"a", PASTE_END]));
        assert!(matches!(
            events.lock().unwrap()[1],
            PasteEvent::Closed {
                reason: CloseReason::OutOfOrder,
                written: 1,
                ..
            }
        ));
        let unknown = queue.offer_paste(CONN, 1, 3, b"d".to_vec(), true, || true, report);
        assert_eq!(unknown, PasteOffer::Unknown);
        assert_eq!(pty.taken(), cat(&[PASTE_START, b"a", PASTE_END]));
    }

    /// PS9: a newer paste closes the open one before it opens.
    #[tokio::test]
    async fn a_newer_paste_closes_the_open_one_first() {
        let pty = Gate::opened();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(
            CONN,
            1,
            0,
            b"first".to_vec(),
            false,
            || true,
            Arc::clone(&report),
        );
        event_count(&events, 1).await;
        queue.offer_paste(CONN, 2, 0, b"second".to_vec(), true, || true, report);
        event_count(&events, 3).await;
        assert_eq!(
            pty.taken(),
            cat(&[
                PASTE_START,
                b"first",
                PASTE_END,
                PASTE_START,
                b"second",
                PASTE_END
            ])
        );
        assert!(events.lock().unwrap().contains(&PasteEvent::Closed {
            paste_id: 1,
            reason: CloseReason::Superseded,
            written: 5
        }));
    }

    /// A chunk never closes another connection's paste, and the end of a
    /// connection closes its pastes.
    #[tokio::test]
    async fn a_connection_touches_only_its_own_paste() {
        let pty = Gate::opened();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        let (report, events) = recorder();
        queue.offer_paste(1, 1, 0, b"a".to_vec(), false, || true, Arc::clone(&report));
        event_count(&events, 1).await;
        let stray = queue.offer_paste(2, 1, 1, b"z".to_vec(), false, || true, Arc::clone(&report));
        assert_eq!(stray, PasteOffer::Unknown);
        assert!(!queue.cancel_paste(2, 1), "not its paste");
        queue.close_connection(1);
        event_count(&events, 2).await;
        assert_eq!(pty.taken(), cat(&[PASTE_START, b"a", PASTE_END]));
        assert!(matches!(
            events.lock().unwrap()[1],
            PasteEvent::Closed {
                reason: CloseReason::Connection,
                ..
            }
        ));
    }
}
