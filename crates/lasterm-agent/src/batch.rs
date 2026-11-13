use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::flow::{Flow, Flows, InTransit};
use crate::framing::encode_frame;
use crate::handler::{iso_now, FrameSender, Outgoing};
use crate::owner::OwnerId;
use crate::protocol::AgentToHub;

/// Output event from a PTY channel reader task.
pub struct OutputEvent {
    /// The hub the channel belongs to, and the only one this may reach.
    pub owner: OwnerId,
    pub channel_id: String,
    pub seq: u64,
    pub data: Vec<u8>,
    /// What these bytes count against their hub's connection (#553).
    pub charge: InTransit,
}

/// A frame about a channel other than its output (CHANNEL_EXIT, TITLE_CHANGE,
/// PROCESS_TITLE, BELL, NOTIFICATION, LOG), encoded by the reader that saw it.
pub struct EventFrame {
    /// The hub the channel belongs to, and the only one this may reach.
    pub owner: OwnerId,
    pub channel_id: String,
    pub frame: Vec<u8>,
    /// The channel's last frame: its CHANNEL_EXIT. Nothing of it follows.
    pub ends_channel: bool,
    /// What this frame counts against its hub's connection (#553).
    pub charge: InTransit,
}

/// A channel's ATTACH_OK or SNAPSHOT_RES, rendered by its reader (#931).
///
/// It is a reply: it goes to the connection that asked, and is charged to
/// nothing (#553). It travels the channel's pipeline all the same, so that it
/// reaches that connection after the output its screen holds and before the
/// output read after it.
pub struct ReplyFrame {
    pub channel_id: String,
    pub frame: Vec<u8>,
    /// The connection that asked.
    pub to: FrameSender,
}

impl ReplyFrame {
    /// Queue it on the connection that asked. Nothing to do once that one is
    /// gone: nobody waits for it there.
    pub fn send(self) {
        let _ = self.to.send(Outgoing::reply(self.frame));
    }
}

/// What a channel's reader task sends towards the hub.
///
/// Output and events travel the same pipeline, so both reach the connection
/// their hub has when they are sent, not the connection that spawned the
/// channel (#549), and in the order the reader sent them. Each carries its
/// channel's owner, which is fixed at SPAWN: an exit still knows where it goes
/// after its channel is gone from the manager (#127). A snapshot reply takes
/// the same pipeline, to the connection that asked for it (#931).
pub enum ChannelEvent {
    Output(OutputEvent),
    Frame(EventFrame),
    Reply(ReplyFrame),
}

/// Sender half of the pipeline every channel reader writes to, and the flow
/// of each hub its readers charge what they read to (#553).
#[derive(Clone)]
pub struct ChannelEventSender {
    tx: mpsc::UnboundedSender<ChannelEvent>,
    flows: Flows,
}

impl ChannelEventSender {
    pub(crate) fn new(flows: Flows) -> (Self, mpsc::UnboundedReceiver<ChannelEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx, flows }, rx)
    }

    /// The flow `owner`'s terminals charge their output to.
    pub(crate) fn flow(&self, owner: &OwnerId) -> Arc<Flow> {
        self.flows.of(owner)
    }

    /// Hand an event on. Nothing to do once the pipeline is gone: the agent
    /// is ending, and the event's charge goes with it.
    pub fn send(&self, event: ChannelEvent) {
        let _ = self.tx.send(event);
    }
}

/// Batched output ready to be encoded and sent to the hub.
pub struct BatchedOutput {
    pub owner: OwnerId,
    pub channel_id: String,
    /// The seq of the last OutputEvent merged into this batch.
    pub seq: u64,
    pub data: Vec<u8>,
    /// The charges of the OutputEvents merged into this batch.
    pub charge: Option<InTransit>,
}

/// What leaves the batch loop, in the order the hub must receive it.
pub enum BatchedEvent {
    Output(BatchedOutput),
    Frame(EventFrame),
    Reply(ReplyFrame),
}

/// Where a frame that left the batch loop goes.
pub enum Delivery {
    /// To the current connection of the hub that owns its channel.
    Owner(RoutedFrame),
    /// To the connection that asked for it.
    Asker(ReplyFrame),
}

impl BatchedEvent {
    /// The frame to write to the hub, with its channel and its charge, or the
    /// reply for the connection that asked. OUTPUT is stamped with the time it
    /// leaves; an event or a reply was encoded by the reader that made it.
    pub fn into_delivery(self) -> std::io::Result<Delivery> {
        match self {
            BatchedEvent::Reply(reply) => Ok(Delivery::Asker(reply)),
            BatchedEvent::Output(b) => Ok(Delivery::Owner(RoutedFrame {
                frame: encode_frame(&AgentToHub::Output {
                    channel_id: b.channel_id.clone(),
                    seq: b.seq,
                    ts: iso_now(),
                    data: b.data,
                })?,
                owner: b.owner,
                channel_id: b.channel_id,
                charge: b.charge,
            })),
            BatchedEvent::Frame(event) => Ok(Delivery::Owner(RoutedFrame {
                owner: event.owner,
                channel_id: event.channel_id,
                frame: event.frame,
                charge: Some(event.charge),
            })),
        }
    }
}

/// A frame on its way to the hub that owns its channel.
pub struct RoutedFrame {
    pub owner: OwnerId,
    pub channel_id: String,
    pub frame: Vec<u8>,
    /// What it counts against that hub's connection until it is written.
    pub charge: Option<InTransit>,
}

const BATCH_INTERVAL_MS: u64 = 16;
const BATCH_MAX_BYTES: usize = 4096;

struct ChannelBuffer {
    owner: OwnerId,
    data: Vec<u8>,
    last_seq: u64,
    charge: Option<InTransit>,
}

impl ChannelBuffer {
    /// What this channel has buffered, as one batch, if anything.
    fn take(&mut self, channel_id: &str) -> Option<BatchedOutput> {
        if self.data.is_empty() {
            return None;
        }
        Some(BatchedOutput {
            owner: self.owner.clone(),
            channel_id: channel_id.to_owned(),
            seq: self.last_seq,
            data: std::mem::take(&mut self.data),
            charge: self.charge.take(),
        })
    }
}

/// The output each channel has buffered, and the rules for letting it go.
#[derive(Default)]
struct Batcher {
    buffers: HashMap<String, ChannelBuffer>,
}

impl Batcher {
    fn accept(&mut self, event: ChannelEvent, tx: &mpsc::UnboundedSender<BatchedEvent>) {
        match event {
            ChannelEvent::Output(e) => {
                let buf =
                    self.buffers
                        .entry(e.channel_id.clone())
                        .or_insert_with(|| ChannelBuffer {
                            owner: e.owner.clone(),
                            data: Vec::new(),
                            last_seq: 0,
                            charge: None,
                        });
                // A restart reuses its channel's id. Whatever the previous
                // workload left goes out under its own owner first.
                if buf.owner != e.owner {
                    if let Some(batch) = buf.take(&e.channel_id) {
                        let _ = tx.send(BatchedEvent::Output(batch));
                    }
                    buf.owner = e.owner.clone();
                }
                buf.data.extend_from_slice(&e.data);
                buf.last_seq = e.seq;
                match &mut buf.charge {
                    Some(charge) => charge.absorb(e.charge),
                    None => buf.charge = Some(e.charge),
                }
                if buf.data.len() >= BATCH_MAX_BYTES {
                    if let Some(batch) = buf.take(&e.channel_id) {
                        let _ = tx.send(BatchedEvent::Output(batch));
                    }
                }
            }
            ChannelEvent::Frame(event) => {
                self.release(&event.channel_id, tx);
                // Its exit is a channel's last word: keeping an empty buffer
                // for it would grow the map by one per terminal ever run.
                if event.ends_channel {
                    self.buffers.remove(&event.channel_id);
                }
                let _ = tx.send(BatchedEvent::Frame(event));
            }
            // The output its screen holds goes first; what the reader reads
            // after it is buffered behind it (#931).
            ChannelEvent::Reply(reply) => {
                self.release(&reply.channel_id, tx);
                let _ = tx.send(BatchedEvent::Reply(reply));
            }
        }
    }

    /// Send what `channel_id` has buffered, now.
    fn release(&mut self, channel_id: &str, tx: &mpsc::UnboundedSender<BatchedEvent>) {
        let held = self
            .buffers
            .get_mut(channel_id)
            .and_then(|buf| buf.take(channel_id));
        if let Some(batch) = held {
            let _ = tx.send(BatchedEvent::Output(batch));
        }
    }

    fn flush_all(&mut self, tx: &mpsc::UnboundedSender<BatchedEvent>) {
        for (id, buf) in self.buffers.iter_mut() {
            if let Some(batch) = buf.take(id) {
                let _ = tx.send(BatchedEvent::Output(batch));
            }
        }
    }
}

/// Global output batch loop.
///
/// Receives `ChannelEvent`s from PTY reader tasks. Output accumulates per
/// channel and is flushed every 16 ms or when a channel buffer exceeds 4 KB.
/// An event or a snapshot reply about a channel first flushes that channel's
/// buffered output, then goes out: a channel's output never arrives after its
/// CHANNEL_EXIT, nor after a snapshot that already shows it.
pub async fn batch_loop(
    mut rx: mpsc::UnboundedReceiver<ChannelEvent>,
    tx: mpsc::UnboundedSender<BatchedEvent>,
) {
    let mut batcher = Batcher::default();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(BATCH_INTERVAL_MS));

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(event) => batcher.accept(event, &tx),
                    None => break,
                }
            }
            _ = interval.tick() => batcher.flush_all(&tx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// A charge on a flow nothing waits on.
    fn charge(bytes: usize) -> InTransit {
        Flow::new(crate::flow::Marks::DEFAULT).read(bytes)
    }

    fn output(channel_id: &str, seq: u64, data: &[u8]) -> ChannelEvent {
        ChannelEvent::Output(OutputEvent {
            owner: OwnerId::stdio(),
            channel_id: channel_id.into(),
            seq,
            data: data.to_vec(),
            charge: charge(data.len()),
        })
    }

    fn event(channel_id: &str, frame: &[u8]) -> ChannelEvent {
        ChannelEvent::Frame(EventFrame {
            owner: OwnerId::stdio(),
            channel_id: channel_id.into(),
            frame: frame.to_vec(),
            ends_channel: false,
            charge: charge(frame.len()),
        })
    }

    fn exit(channel_id: &str) -> ChannelEvent {
        ChannelEvent::Frame(EventFrame {
            owner: OwnerId::stdio(),
            channel_id: channel_id.into(),
            frame: b"exit".to_vec(),
            ends_channel: true,
            charge: charge(4),
        })
    }

    fn expect_output(item: Option<BatchedEvent>) -> BatchedOutput {
        match item {
            Some(BatchedEvent::Output(batch)) => batch,
            Some(BatchedEvent::Frame(event)) => {
                panic!("expected OUTPUT, got an event for {}", event.channel_id)
            }
            Some(BatchedEvent::Reply(reply)) => {
                panic!("expected OUTPUT, got a reply for {}", reply.channel_id)
            }
            None => panic!("expected OUTPUT, got nothing"),
        }
    }

    fn expect_event(item: Option<BatchedEvent>) -> EventFrame {
        match item {
            Some(BatchedEvent::Frame(event)) => event,
            Some(BatchedEvent::Output(batch)) => {
                panic!("expected an event, got OUTPUT for {}", batch.channel_id)
            }
            Some(BatchedEvent::Reply(reply)) => {
                panic!("expected an event, got a reply for {}", reply.channel_id)
            }
            None => panic!("expected an event, got nothing"),
        }
    }

    #[tokio::test]
    async fn test_batch_flushes_on_timer() {
        let (out_tx, out_rx) = mpsc::unbounded_channel::<ChannelEvent>();
        let (batch_tx, mut batch_rx) = mpsc::unbounded_channel::<BatchedEvent>();

        tokio::spawn(batch_loop(out_rx, batch_tx));

        out_tx.send(output("ch1", 1, b"hello")).unwrap();

        // Wait longer than the 16 ms timer
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;

        let batched = expect_output(batch_rx.try_recv().ok());
        assert_eq!(batched.channel_id, "ch1");
        assert_eq!(batched.data, b"hello");
        assert_eq!(batched.seq, 1);
    }

    #[tokio::test]
    async fn test_batch_flushes_on_threshold() {
        let (out_tx, out_rx) = mpsc::unbounded_channel::<ChannelEvent>();
        let (batch_tx, mut batch_rx) = mpsc::unbounded_channel::<BatchedEvent>();

        tokio::spawn(batch_loop(out_rx, batch_tx));

        // Send exactly BATCH_MAX_BYTES (4096 bytes) to trigger immediate flush
        out_tx.send(output("ch2", 5, &[0xAB; 4096])).unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let batched = expect_output(batch_rx.try_recv().ok());
        assert_eq!(batched.channel_id, "ch2");
        assert_eq!(batched.data.len(), 4096);
        assert_eq!(batched.seq, 5);
    }

    /// An event about a channel goes out after the output that channel sent
    /// before it, without waiting for the timer. CHANNEL_EXIT used to bypass
    /// the batch and could reach the hub before the shell's last output (#549).
    #[tokio::test(start_paused = true)]
    async fn an_event_goes_out_after_the_output_its_channel_sent_before_it() {
        let (out_tx, out_rx) = mpsc::unbounded_channel::<ChannelEvent>();
        let (batch_tx, mut batch_rx) = mpsc::unbounded_channel::<BatchedEvent>();
        tokio::spawn(batch_loop(out_rx, batch_tx));
        // The timer's first tick is immediate. Let the loop take it, then keep
        // the paused clock short of the next one: only the event can flush.
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;

        out_tx.send(output("ch1", 1, b"last ")).unwrap();
        out_tx.send(output("ch1", 2, b"words")).unwrap();
        out_tx.send(event("ch1", b"exit")).unwrap();
        // Nothing buffered for it any more: this one goes out alone.
        out_tx.send(event("ch1", b"after")).unwrap();

        let batched = expect_output(batch_rx.recv().await);
        assert_eq!(batched.channel_id, "ch1");
        assert_eq!(batched.data, b"last words");
        assert_eq!(batched.seq, 2);
        let exit = expect_event(batch_rx.recv().await);
        assert_eq!(
            (exit.channel_id.as_str(), exit.frame.as_slice()),
            ("ch1", &b"exit"[..])
        );
        let after = expect_event(batch_rx.recv().await);
        assert_eq!(after.frame, b"after");
    }

    /// A channel that ended keeps no buffer: the loop used to hold an empty
    /// one for every terminal it had ever carried, for the daemon's lifetime.
    /// What the channel had buffered still goes out, before its exit.
    #[test]
    fn a_channel_that_ended_leaves_no_buffer_behind() {
        let (tx, mut rx) = mpsc::unbounded_channel::<BatchedEvent>();
        let mut batcher = Batcher::default();
        batcher.accept(output("ended", 1, b"bye"), &tx);
        batcher.accept(output("running", 1, b"hi"), &tx);

        batcher.accept(exit("ended"), &tx);

        assert_eq!(expect_output(rx.try_recv().ok()).data, b"bye");
        assert!(expect_event(rx.try_recv().ok()).ends_channel);
        assert!(
            !batcher.buffers.contains_key("ended"),
            "the ended channel's buffer must go with it"
        );
        assert!(
            batcher.buffers.contains_key("running"),
            "another channel's buffer stays"
        );
    }

    /// Each batch goes to the hub its channel belongs to, even when a restart
    /// hands the channel id to a workload of another hub before the previous
    /// one's output left.
    #[test]
    fn a_batch_never_mixes_the_output_of_two_owners() {
        let (tx, mut rx) = mpsc::unbounded_channel::<BatchedEvent>();
        let mut batcher = Batcher::default();
        let first = OwnerId::from_hub_key("first-hub");
        let second = OwnerId::from_hub_key("second-hub");
        let send = |owner: &OwnerId, data: &[u8]| {
            ChannelEvent::Output(OutputEvent {
                owner: owner.clone(),
                channel_id: "reused".into(),
                seq: 1,
                data: data.to_vec(),
                charge: charge(data.len()),
            })
        };

        batcher.accept(send(&first, b"of the first"), &tx);
        batcher.accept(send(&second, b"of the second"), &tx);
        batcher.flush_all(&tx);

        let one = expect_output(rx.try_recv().ok());
        assert!(one.owner == first && one.data == b"of the first");
        let two = expect_output(rx.try_recv().ok());
        assert!(two.owner == second && two.data == b"of the second");
    }
}
