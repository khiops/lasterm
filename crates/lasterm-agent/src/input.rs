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
/// largest INPUTs, room for a paste a busy program reads a moment later, and
/// the same as the output the agent holds for a hub before it stops reading
/// that hub's terminals (`flow::HIGH_WATER`). It costs at most 1 MiB per
/// terminal that takes no input while its hub keeps sending to it.
pub(crate) const INPUT_QUEUE_BYTES: usize = 1024 * 1024;

/// What the writer hands the PTY at a time. On Windows a write is a message to
/// the ConPTY writer thread, which holds up to 64 of them: writing 4 KiB at a
/// time keeps what they hold to 256 KiB, whatever the size of the INPUT.
const WRITE_CHUNK: usize = 4096;

#[derive(Default)]
struct QueueState {
    /// Bytes queued and not yet taken by the terminal.
    queued: usize,
    /// An INPUT was dropped, and the terminal has not yet taken everything
    /// queued before it: what comes meanwhile is dropped too.
    dropping: bool,
    /// The writer has ended: the terminal took a write as an error, which
    /// means it is gone.
    closed: bool,
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
    tx: mpsc::UnboundedSender<Vec<u8>>,
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
        if self.tx.send(data).is_err() {
            state.queued -= len;
            state.closed = true;
            return Offer::Closed;
        }
        Offer::Queued
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
    mut queue: mpsc::UnboundedReceiver<Vec<u8>>,
    state: Arc<Mutex<QueueState>>,
) where
    W: AsyncWrite + Unpin,
{
    while let Some(data) = queue.recv().await {
        for chunk in data.chunks(WRITE_CHUNK) {
            if let Err(error) = pty.write_all(chunk).await {
                // The terminal is gone: the slave side closed, or ConPTY's
                // input with it. Its exit reaches the hub through its reader.
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
            let mut state = lock(&state);
            state.queued = state.queued.saturating_sub(chunk.len());
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
}
