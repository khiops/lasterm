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
//! On Windows 26100, conhost can hold back the first input written after an
//! end marker written on its own, until more input comes (#1030); the record
//! below goes out from build 26100 on.
//! The writer then follows the next INPUT, 50 ms later, with a console input
//! record that no program reads as bytes, a Shift key released
//! (`wake_record_for`); written at once, conhost holds it with the INPUT. It
//! writes it only after an INPUT written whole, while no paste is in the
//! queue, and never right after an INPUT that ends with an end marker itself
//! or in the middle of a character.
//! conhost can hold the end marker itself too, when nothing is written after
//! it (#1075): once nothing has been written for 50 ms after an end marker,
//! an INPUT's own included, and no paste is in the queue, the writer writes
//! the record once for that marker. The next INPUT is still followed by its
//! own.
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

/// A console input record in win32-input-mode: the Shift key (virtual key 16,
/// scan code 42) released, no character. conhost takes it as input, which
/// wakes a read it holds back, and gives a program no byte of it: a program
/// reading console records sees a Shift key-up, as from a keyboard (#1030).
const WAKE_RECORD: &[u8] = b"\x1b[16;42;0;0;0;1_";

/// The first Windows build whose conhost holds input back after a lone end
/// marker (Windows 11 24H2, Windows Server 2025).
const WAKE_FROM_BUILD: u32 = 26100;

/// How long after the INPUT, or after a lone end marker, the record goes
/// out. Written at once, it reaches conhost with the INPUT and is held with
/// it; 20 ms and 50 ms after it, it released every run measured on 26100
/// (#1030), and 50 ms after a lone end marker every run (#1075).
const WAKE_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

/// The record the writer of a terminal on Windows build `build` follows an
/// INPUT with after an end marker, if any. An unknown build gets none.
pub(crate) fn wake_record_for(build: Option<u32>) -> Option<&'static [u8]> {
    build
        .filter(|build| *build >= WAKE_FROM_BUILD)
        .map(|_| WAKE_RECORD)
}

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
    /// `start_waking` with no wake record.
    #[cfg(test)]
    pub(crate) fn start<W>(channel_id: &str, pty: W, bound: usize) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::start_waking(channel_id, pty, bound, None)
    }

    /// Start the writer of `channel_id`'s input to `pty`, holding no more
    /// than `bound` bytes for it. `wake` is the record that follows the next
    /// INPUT after an end marker (`wake_record_for`), or none.
    pub(crate) fn start_waking<W>(
        channel_id: &str,
        pty: W,
        bound: usize,
        wake: Option<&'static [u8]>,
    ) -> Self
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
            wake,
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
    wake: Option<&'static [u8]>,
) where
    W: AsyncWrite + Unpin,
{
    let mut due = WakeDue::default();
    loop {
        let entry = match (wake, due.idle) {
            (Some(record), Some(deadline)) => {
                // A deadline already past is served first, so entries that
                // write nothing cannot keep it waiting.
                let entry = if tokio::time::Instant::now() >= deadline {
                    None
                } else {
                    tokio::select! {
                        biased;
                        entry = queue.recv() => Some(entry),
                        () = tokio::time::sleep_until(deadline) => None,
                    }
                };
                match entry {
                    Some(entry) => entry,
                    None => {
                        // Nothing written since the marker: the record
                        // follows it once no paste is in the queue. The next
                        // INPUT still gets its own.
                        if lock(&state).pastes.is_empty() {
                            due.idle = None;
                            if let Err(error) = pty.write_all(record).await {
                                refused(&channel_id, &state, &error);
                                return;
                            }
                        } else {
                            due.idle = Some(tokio::time::Instant::now() + WAKE_DELAY);
                        }
                        continue;
                    }
                }
            }
            _ => queue.recv().await,
        };
        let Some(entry) = entry else { return };
        let written = write_one(&mut pty, &state, entry, wake, &mut due).await;
        if let Err(error) = written {
            refused(&channel_id, &state, &error);
            return;
        }
    }
}

/// The terminal is gone: the slave side closed, or ConPTY's input with it.
/// Its exit reaches the hub through its reader.
fn refused(channel_id: &str, state: &Mutex<QueueState>, error: &std::io::Error) {
    tracing::debug!(
        channel_id = %channel_id,
        %error,
        "terminal input refused; dropping what is queued for it"
    );
    let mut state = lock(state);
    state.closed = true;
    state.queued = 0;
}

/// Where the writer stands with the wake record.
#[derive(Default)]
struct WakeDue {
    /// An end marker went out, and no INPUT has been followed by the record
    /// since.
    input: bool,
    /// An end marker went out, and nothing has been written after it: when
    /// the record follows it, `WAKE_DELAY` after it unless something is
    /// written first. Entries that write nothing leave it as it is.
    idle: Option<tokio::time::Instant>,
}

impl WakeDue {
    /// An end marker was written, when `marker`.
    fn marked(&mut self, marker: bool) {
        if marker {
            self.input = true;
            self.idle = Some(tokio::time::Instant::now() + WAKE_DELAY);
        }
    }
}

/// Write one entry, the closed pastes' ends before and after it, and the wake
/// record after it when it is the INPUT that follows an end marker.
async fn write_one<W>(
    pty: &mut W,
    state: &Mutex<QueueState>,
    entry: Entry,
    wake: Option<&'static [u8]>,
    due: &mut WakeDue,
) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    due.marked(finish_closed(pty, state).await?);
    // For an INPUT: whether it ends with an end marker, and whether it ends
    // with a whole character.
    let input = match &entry {
        Entry::Input(data) if !data.is_empty() => {
            Some((data.ends_with(PASTE_END), ends_with_whole_char(data)))
        }
        _ => None,
    };
    let was_due = due.input;
    let wrote = write_entry(pty, state, entry).await?;
    if wrote.bytes {
        // An end marker is no longer the last write.
        due.idle = None;
    }
    due.marked(wrote.marker);
    // Decided after this: a paste closed while the INPUT was written is
    // taken, or its end marker written.
    let marker_after = finish_closed(pty, state).await?;
    if let (Some(record), Some((ends_with_marker, whole))) = (wake, input) {
        if was_due && !marker_after && !ends_with_marker && whole && lock(state).pastes.is_empty() {
            // The writer waits itself, holding no lock: what is queued
            // meanwhile is written after the record. Nothing runs between
            // the wait and the write. A queue dropped meanwhile aborts this
            // task, and no record goes out.
            tokio::time::sleep(WAKE_DELAY).await;
            pty.write_all(record).await?;
            due.input = false;
        }
        due.marked(ends_with_marker);
    }
    due.marked(marker_after);
    Ok(())
}

/// Whether `bytes` end with a whole UTF-8 character: an ASCII byte, or a
/// well-formed sequence of 2, 3 or 4 bytes.
fn ends_with_whole_char(bytes: &[u8]) -> bool {
    match bytes.last() {
        None => false,
        Some(last) if last.is_ascii() => true,
        Some(_) => (2..=4)
            .any(|n| bytes.len() >= n && std::str::from_utf8(&bytes[bytes.len() - n..]).is_ok()),
    }
}

/// What `write_entry` wrote.
#[derive(Default)]
struct Wrote {
    /// An end marker, last.
    marker: bool,
    /// Anything else, last.
    bytes: bool,
}

/// Write `entry`.
async fn write_entry<W>(
    pty: &mut W,
    state: &Mutex<QueueState>,
    entry: Entry,
) -> std::io::Result<Wrote>
where
    W: AsyncWrite + Unpin,
{
    let mut wrote = Wrote::default();
    match entry {
        Entry::Input(data) => {
            for chunk in data.chunks(WRITE_CHUNK) {
                pty.write_all(chunk).await?;
                wrote.bytes = true;
                let mut state = lock(state);
                state.queued = state.queued.saturating_sub(chunk.len());
            }
        }
        Entry::Start(key) => {
            if lock(state).is_open(key) {
                pty.write_all(PASTE_START).await?;
                wrote.bytes = true;
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
                        return Ok(wrote);
                    }
                }
                pty.write_all(chunk).await?;
                wrote.bytes = true;
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
                wrote = Wrote {
                    marker: true,
                    bytes: false,
                };
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
    Ok(wrote)
}

/// Finish every closed paste: its end marker, when its start marker went
/// out, then its PASTE_CLOSED. Run before and after each entry, so the marker
/// follows the last byte of the paste written and precedes the next entry.
/// True when it wrote an end marker.
async fn finish_closed<W>(pty: &mut W, state: &Mutex<QueueState>) -> std::io::Result<bool>
where
    W: AsyncWrite + Unpin,
{
    let mut marker = false;
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
            return Ok(marker);
        };
        if start_written {
            pty.write_all(PASTE_END).await?;
            marker = true;
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
        /// When it last took a write.
        taken_at: Arc<Mutex<Option<std::time::Instant>>>,
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
                *self.taken_at.lock().unwrap() = Some(std::time::Instant::now());
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
        let queue = waking(&pty);
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
        // #1030 AC4: no end marker went out, so no wake record.
        queue.offer(b"x".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&chunk(b'p', 8192), b"x"]));
    }

    /// PS5 before the start marker: nothing of the paste, no marker.
    #[tokio::test]
    async fn a_paste_cancelled_before_its_start_writes_nothing() {
        let pty = Gate::default();
        let queue = waking(&pty);
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
        // #1030 AC4: no end marker went out, so no wake record.
        queue.offer(b"x".to_vec());
        assert_eq!(settled(&pty).await, b"lsx");
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

    // ─── The wake record after an end marker (#1030) ───────────────────────

    /// Stands for the wake record: any bytes no input here holds.
    const REC: &[u8] = b"{wake}";

    fn waking(pty: &Gate) -> InputQueue {
        InputQueue::start_waking("gate", pty.clone(), 1 << 20, Some(REC))
    }

    /// What the PTY holds once the writer has nothing left to write.
    async fn settled(pty: &Gate) -> Vec<u8> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        pty.taken()
    }

    /// Bracketed paste `id` opened with `first` then cancelled, on an open
    /// PTY: its end marker written.
    async fn close_a_paste(queue: &InputQueue, id: u32) -> Events {
        let (report, events) = recorder();
        queue.offer_paste(CONN, id, 0, b"first".to_vec(), false, || true, report);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, id));
        event_count(&events, 2).await;
        events
    }

    fn closed() -> Vec<u8> {
        cat(&[PASTE_START, b"first", PASTE_END])
    }

    /// AC1, AC1b, AC5: after a cancelled paste, the next INPUT is followed by
    /// the record, in a write of its own, counted nowhere.
    #[tokio::test]
    async fn the_input_after_an_end_marker_is_followed_by_the_wake_record() {
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 4, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 4));
        pty.release(1);
        event_count(&events, 2).await;
        assert_eq!(
            events.lock().unwrap()[1],
            PasteEvent::Closed {
                paste_id: 4,
                reason: CloseReason::Cancelled,
                written: 5
            }
        );
        assert_eq!(pty.taken(), closed(), "nothing right after the marker");

        queue.offer(b"x".to_vec());
        pty.release(1);
        pty.holds(closed().len() + 1).await;
        let x_taken = pty.taken_at.lock().unwrap().expect("x was taken");
        pty.blocked().await;
        let waited = x_taken.elapsed();
        assert!(
            waited >= Duration::from_millis(50) && waited < Duration::from_secs(1),
            "the record's write was attempted {waited:?} after x was taken"
        );
        assert_eq!(pty.taken(), cat(&[&closed(), b"x"]), "x on its own write");
        assert_eq!(queue.queued(), 0, "the record is not counted");
        pty.release(1);
        pty.holds(closed().len() + 1 + REC.len()).await;
        pty.open_all();
        assert_eq!(settled(&pty).await, cat(&[&closed(), b"x", REC]));
    }

    /// AC2: a paste ended by its last chunk too.
    #[tokio::test]
    async fn the_wake_record_follows_the_input_after_a_normal_end_too() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"abc".to_vec(), true, || true, report);
        event_count(&events, 1).await;
        queue.offer(b"x".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[PASTE_START, b"abc", PASTE_END, b"x", REC])
        );
    }

    /// AC2b: an INPUT whose last write is an end marker alone sets the flag.
    #[tokio::test]
    async fn the_wake_record_follows_the_input_after_an_input_ending_with_the_marker() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        let pasted = cat(&[PASTE_START, &chunk(b'a', 4090), PASTE_END]);
        queue.offer(pasted.clone());
        queue.offer(b"x".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&pasted, b"x", REC]));
    }

    /// AC2c: never right after an INPUT that ends with the marker itself.
    #[tokio::test]
    async fn the_wake_record_is_not_after_an_input_ending_with_the_marker() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        let pasted = cat(&[PASTE_START, b"b", PASTE_END]);
        queue.offer(pasted.clone());
        queue.offer(b"x".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&closed(), &pasted, b"x", REC]));
    }

    /// AC2d: the marker judged on the INPUT's bytes, not its last write.
    #[tokio::test]
    async fn the_wake_record_sees_a_marker_across_a_chunk_boundary() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        let pasted = cat(&[PASTE_START, &chunk(b'a', 4085), PASTE_END]);
        assert_eq!(pasted.len(), WRITE_CHUNK + 1);
        queue.offer(pasted.clone());
        queue.offer(b"x".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&pasted, b"x", REC]));
    }

    /// AC2e: a marker inside an INPUT, not at its end, neither sets the flag
    /// nor withholds the record.
    #[tokio::test]
    async fn the_wake_record_ignores_a_marker_inside_an_input() {
        let inside = cat(&[PASTE_START, b"b", PASTE_END, b"x"]);
        let pty = Gate::opened();
        let queue = waking(&pty);
        queue.offer(inside.clone());
        queue.offer(b"y".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&inside, b"y"]), "flag clear");

        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        queue.offer(inside.clone());
        queue.offer(b"y".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), &inside, REC, b"y"]),
            "flag set"
        );
    }

    /// AC3: once per end marker, and again after the next one.
    #[tokio::test]
    async fn the_wake_record_follows_the_input_only_once() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        queue.offer(b"x".to_vec());
        queue.offer(b"y".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&closed(), b"x", REC, b"y"]));
        close_a_paste(&queue, 2).await;
        queue.offer(b"z".to_vec());
        queue.offer(b"w".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", REC, b"y", &closed(), b"z", REC, b"w"])
        );
    }

    /// AC4: no end marker, no record.
    #[tokio::test]
    async fn the_wake_record_is_never_without_an_end_marker() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        queue.offer(b"x".to_vec());
        queue.offer(b"y".to_vec());
        assert_eq!(settled(&pty).await, b"xy");
    }

    /// AC4b: after the whole INPUT, not its first write.
    #[tokio::test]
    async fn the_wake_record_follows_the_whole_input() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        queue.offer(chunk(b'b', 5000));
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), &chunk(b'b', 5000), REC])
        );
    }

    /// AC4c: never while a paste is in the queue, whenever it came.
    #[tokio::test]
    async fn the_wake_record_is_never_inside_a_paste() {
        // A paste open when the INPUT comes; the record waits for its end.
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        let (report, events) = recorder();
        queue.offer_paste(
            CONN,
            2,
            0,
            b"q".to_vec(),
            false,
            || true,
            Arc::clone(&report),
        );
        event_count(&events, 1).await;
        queue.offer(b"x".to_vec());
        queue.offer_paste(CONN, 2, 1, b"r".to_vec(), true, || true, report);
        event_count(&events, 2).await;
        queue.offer(b"y".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[
                &closed(),
                PASTE_START,
                b"q",
                b"x",
                b"r",
                PASTE_END,
                b"y",
                REC
            ]),
            "open"
        );

        // Queued behind the INPUT, while the writer waits on the marker.
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 1));
        pty.blocked().await;
        queue.offer(b"x".to_vec());
        let (report, _events) = recorder();
        queue.offer_paste(CONN, 2, 0, b"q".to_vec(), false, || true, report);
        pty.open_all();
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", PASTE_START, b"q"]),
            "queued behind"
        );

        // Registered while the INPUT is written.
        let (pty, queue) = blocked_on_x().await;
        let (report, _events) = recorder();
        queue.offer_paste(CONN, 2, 0, b"q".to_vec(), false, || true, report);
        pty.open_all();
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", PASTE_START, b"q"]),
            "registered during the write"
        );

        // Registered and cancelled before its start while the INPUT is
        // written: taken without a marker, the record goes out.
        let (pty, queue) = blocked_on_x().await;
        let (report, _events) = recorder();
        queue.offer_paste(CONN, 2, 0, b"q".to_vec(), false, || true, report);
        assert!(queue.cancel_paste(CONN, 2));
        pty.open_all();
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", REC]),
            "registered and cancelled during the write"
        );

        // A started paste cancelled while the INPUT is written: its end
        // marker follows the INPUT, and the record waits for the next one.
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 1));
        pty.release(1);
        event_count(&events, 2).await;
        let (report, events) = recorder();
        queue.offer_paste(CONN, 2, 0, b"q".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        queue.offer(b"x".to_vec());
        pty.blocked().await;
        assert!(queue.cancel_paste(CONN, 2));
        pty.open_all();
        event_count(&events, 2).await;
        queue.offer(b"y".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), PASTE_START, b"q", b"x", PASTE_END, b"y", REC]),
            "started paste cancelled during the write"
        );
    }

    /// A closed paste's marker written, then INPUT `x` pending on the PTY.
    async fn blocked_on_x() -> (Gate, InputQueue) {
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 1));
        pty.release(1);
        event_count(&events, 2).await;
        queue.offer(b"x".to_vec());
        pty.blocked().await;
        (pty, queue)
    }

    /// AC1e: what comes during the 50 ms wait does not change the decision,
    /// and a queue dropped meanwhile writes no record.
    #[tokio::test]
    async fn the_wake_record_survives_events_during_the_wait() {
        // A paste offered during the wait: queued behind the record.
        let (pty, queue) = x_taken_record_waiting().await;
        let (report, _events) = recorder();
        queue.offer_paste(CONN, 2, 0, b"q".to_vec(), false, || true, report);
        pty.open_all();
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", REC, PASTE_START, b"q"]),
            "paste offered during the wait"
        );

        // A paste offered then cancelled during the wait: nothing of it.
        let (pty, queue) = x_taken_record_waiting().await;
        let (report, _events) = recorder();
        queue.offer_paste(CONN, 2, 0, b"q".to_vec(), false, || true, report);
        assert!(queue.cancel_paste(CONN, 2));
        pty.open_all();
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", REC]),
            "paste offered and cancelled during the wait"
        );

        // The queue dropped during the wait: no record.
        let (pty, queue) = x_taken_record_waiting().await;
        pty.open_all();
        drop(queue);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(pty.taken(), cat(&[&closed(), b"x"]), "queue dropped");
    }

    /// A closed paste's marker written, then INPUT `x` taken, the writer in
    /// the record's wait (well before its 50 ms are over).
    async fn x_taken_record_waiting() -> (Gate, InputQueue) {
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 1));
        pty.release(1);
        event_count(&events, 2).await;
        queue.offer(b"x".to_vec());
        pty.release(1);
        pty.holds(closed().len() + 1).await;
        let x_taken = pty.taken_at.lock().unwrap().expect("x was taken");
        assert!(
            x_taken.elapsed() < Duration::from_millis(25),
            "still in the wait"
        );
        (pty, queue)
    }

    /// AC4d: never after a cut character.
    #[tokio::test]
    async fn the_wake_record_is_never_after_a_cut_character() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        queue.offer(vec![b'x', 0xC3]);
        queue.offer(vec![0xA9]);
        queue.offer(b"y".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), &[b'x', 0xC3], &[0xA9], b"y", REC])
        );
    }

    /// AC4e: after a whole character of 2, 3 or 4 bytes; not after a cut one.
    #[tokio::test]
    async fn the_wake_record_follows_a_whole_character() {
        for whole in [
            &[0xC3, 0xA9][..],
            &[0xE2, 0x82, 0xAC],
            &[0xF0, 0x9F, 0x98, 0x80],
        ] {
            let pty = Gate::opened();
            let queue = waking(&pty);
            close_a_paste(&queue, 1).await;
            queue.offer(whole.to_vec());
            assert_eq!(
                settled(&pty).await,
                cat(&[&closed(), whole, REC]),
                "{whole:02x?}"
            );
        }
        for cut in [&[0xE2, 0x82][..], &[0xF0, 0x9F, 0x98]] {
            let pty = Gate::opened();
            let queue = waking(&pty);
            close_a_paste(&queue, 1).await;
            queue.offer(cut.to_vec());
            queue.offer(b"y".to_vec());
            assert_eq!(
                settled(&pty).await,
                cat(&[&closed(), cut, b"y", REC]),
                "{cut:02x?}"
            );
        }
    }

    /// AC1c: entries the writer skips leave the flag as it is.
    #[tokio::test]
    async fn the_wake_record_is_kept_across_skipped_entries() {
        // A cancel that skips the rest of the paste's data and its end.
        let (pty, queue, events) = paste_cut_after_one_write(true).await;
        assert!(queue.cancel_paste(CONN, 5));
        pty.open_all();
        event_count(&events, 1).await;
        queue.offer(b"x".to_vec());
        assert_eq!(
            settled(&pty).await,
            cat(&[PASTE_START, &chunk(b'p', 8192), PASTE_END, b"x", REC]),
            "skipped data and end"
        );

        // A paste cancelled before its start, queued after a marker.
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 1));
        pty.blocked().await; // on the end marker
        let (report, _events) = recorder();
        queue.offer_paste(CONN, 3, 0, b"q".to_vec(), false, || true, report);
        assert!(queue.cancel_paste(CONN, 3));
        queue.offer(b"x".to_vec());
        pty.open_all();
        assert_eq!(
            settled(&pty).await,
            cat(&[&closed(), b"x", REC]),
            "skipped start"
        );
    }

    // ─── The wake record after a lone end marker (#1075) ───────────────────

    /// A cancelled paste's end marker with nothing after it is followed by
    /// the record once the queue has stayed empty for 50 ms, in a write of
    /// its own.
    #[tokio::test]
    async fn a_lone_end_marker_is_followed_by_the_wake_record() {
        let pty = Gate::default();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 4, 0, b"first".to_vec(), false, || true, report);
        pty.release(2);
        event_count(&events, 1).await;
        assert!(queue.cancel_paste(CONN, 4));
        pty.release(1);
        pty.holds(closed().len()).await;
        let marker_taken = pty.taken_at.lock().unwrap().expect("the marker was taken");
        pty.blocked().await;
        let waited = marker_taken.elapsed();
        assert!(
            waited >= Duration::from_millis(50) && waited < Duration::from_secs(1),
            "the record's write was attempted {waited:?} after the marker was taken"
        );
        assert_eq!(pty.taken(), closed(), "the marker on its own write");
        pty.open_all();
        assert_eq!(settled(&pty).await, cat(&[&closed(), REC]));
        assert_eq!(queue.queued(), 0, "the record is not counted");
    }

    /// A paste ended by its last chunk too: its end marker is a write of its
    /// own.
    #[tokio::test]
    async fn a_lone_end_marker_after_a_normal_end_is_followed_by_the_wake_record() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        let (report, events) = recorder();
        queue.offer_paste(CONN, 1, 0, b"abc".to_vec(), true, || true, report);
        event_count(&events, 1).await;
        assert_eq!(
            settled(&pty).await,
            cat(&[PASTE_START, b"abc", PASTE_END, REC])
        );
    }

    /// Once per marker: an idle queue gets no second record, and the next
    /// INPUT is still followed by its own.
    #[tokio::test]
    async fn a_lone_end_marker_gets_the_record_once_and_the_next_input_its_own() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(pty.taken(), cat(&[&closed(), REC]), "once");
        queue.offer(b"x".to_vec());
        queue.offer(b"y".to_vec());
        assert_eq!(settled(&pty).await, cat(&[&closed(), REC, b"x", REC, b"y"]));
    }

    /// An INPUT ending with an end marker, with nothing after it, gets the
    /// record too.
    #[tokio::test]
    async fn an_input_ending_with_the_marker_is_followed_by_the_record_when_idle() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        let pasted = cat(&[PASTE_START, b"b", PASTE_END]);
        queue.offer(pasted.clone());
        assert_eq!(settled(&pty).await, cat(&[&pasted, REC]));
    }

    /// Not while a paste is in the queue: an end marker followed by a paste
    /// that has written nothing yet.
    #[tokio::test]
    async fn a_lone_end_marker_gets_no_record_while_a_paste_is_in_the_queue() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        let (report, events) = recorder();
        queue.offer_paste(CONN, 2, 0, Vec::new(), false, || false, Arc::clone(&report));
        event_count(&events, 1).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(pty.taken(), closed(), "nothing inside the paste");
        queue.offer_paste(CONN, 2, 1, b"z".to_vec(), true, || false, report);
        event_count(&events, 2).await;
        assert_eq!(settled(&pty).await, cat(&[&closed(), b"z"]));

        // The paste then closed without writing anything: the record follows
        // the marker after all.
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        let (report, events) = recorder();
        queue.offer_paste(CONN, 2, 0, Vec::new(), false, || false, report);
        event_count(&events, 1).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(pty.taken(), closed(), "nothing inside the paste");
        assert!(queue.cancel_paste(CONN, 2));
        event_count(&events, 2).await;
        assert_eq!(settled(&pty).await, cat(&[&closed(), REC]), "after it");
    }

    /// A PTY that takes `writes` writes, then refuses every write after.
    #[derive(Clone)]
    struct Breaks {
        writes: Arc<AtomicUsize>,
        taken: Arc<Mutex<Vec<u8>>>,
    }

    impl AsyncWrite for Breaks {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self
                .writes
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_err()
            {
                return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
            }
            self.taken.lock().unwrap().extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A terminal gone when the record after a lone end marker is written
    /// closes the queue, as any refused write does.
    #[tokio::test]
    async fn a_refused_record_after_a_lone_end_marker_closes_the_queue() {
        // The start marker, "first" and the end marker; the record refused.
        let pty = Breaks {
            writes: Arc::new(AtomicUsize::new(3)),
            taken: Arc::default(),
        };
        let queue = InputQueue::start_waking("breaks", pty.clone(), 1 << 20, Some(REC));
        close_a_paste(&queue, 1).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(*pty.taken.lock().unwrap(), closed());
        assert_eq!(queue.offer(b"x".to_vec()), Offer::Closed);
        assert_eq!(queue.queued(), 0);
    }

    /// Entries that write nothing, such as empty INPUTs, do not put the
    /// record off: it follows 50 ms after the marker.
    #[tokio::test]
    async fn entries_that_write_nothing_do_not_put_off_the_record() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        for _ in 0..10 {
            queue.offer(Vec::new());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(pty.taken(), cat(&[&closed(), REC]));
    }

    /// A deadline already past is served before entries queued meanwhile,
    /// even when they are ready at once.
    #[tokio::test(start_paused = true)]
    async fn a_past_deadline_is_served_before_entries_ready_at_once() {
        let pty = Gate::opened();
        let queue = waking(&pty);
        close_a_paste(&queue, 1).await;
        for _ in 0..10 {
            queue.offer(Vec::new());
        }
        queue.offer(b"x".to_vec());
        tokio::time::advance(Duration::from_millis(100)).await;
        assert_eq!(settled(&pty).await, cat(&[&closed(), REC, b"x", REC]));
    }

    /// Nothing without a record to write.
    #[tokio::test]
    async fn a_lone_end_marker_gets_nothing_without_a_record() {
        let pty = Gate::opened();
        let queue = InputQueue::start("gate", pty.clone(), 1 << 20);
        close_a_paste(&queue, 1).await;
        assert_eq!(settled(&pty).await, closed());
    }

    /// AC6: the record, exactly, from build 26100 on; none before or unknown.
    #[test]
    fn the_wake_record_is_for_build_26100_and_later() {
        let record: &[u8] = b"\x1b[16;42;0;0;0;1_";
        assert_eq!(wake_record_for(Some(26100)), Some(record));
        assert_eq!(wake_record_for(Some(26300)), Some(record));
        assert_eq!(wake_record_for(Some(22631)), None);
        assert_eq!(wake_record_for(Some(19045)), None);
        assert_eq!(wake_record_for(None), None);
    }
}
