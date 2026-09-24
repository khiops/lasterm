use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::framing::encode_frame;
use crate::handler::iso_now;
use crate::protocol::AgentToHub;

/// Output event from a PTY channel reader task.
pub struct OutputEvent {
    pub channel_id: String,
    pub seq: u64,
    pub data: Vec<u8>,
}

/// A frame about a channel other than its output (CHANNEL_EXIT, TITLE_CHANGE,
/// PROCESS_TITLE, BELL, NOTIFICATION, LOG), encoded by the reader that saw it.
pub struct EventFrame {
    pub channel_id: String,
    pub frame: Vec<u8>,
}

/// What a channel's reader task sends towards the hub.
///
/// Output and events travel the same pipeline, so both reach whichever hub is
/// connected when they are sent, not the connection that spawned the channel
/// (#549), and in the order the reader sent them.
pub enum ChannelEvent {
    Output(OutputEvent),
    Frame(EventFrame),
}

/// Sender half of the pipeline every channel reader writes to.
pub type ChannelEventSender = mpsc::UnboundedSender<ChannelEvent>;

/// Batched output ready to be encoded and sent to the hub.
pub struct BatchedOutput {
    pub channel_id: String,
    /// The seq of the last OutputEvent merged into this batch.
    pub seq: u64,
    pub data: Vec<u8>,
}

/// What leaves the batch loop, in the order the hub must receive it.
pub enum BatchedEvent {
    Output(BatchedOutput),
    Frame(EventFrame),
}

impl BatchedEvent {
    /// The frame to write to the hub. OUTPUT is stamped with the time it
    /// leaves; an event was encoded by the reader that saw it.
    pub fn into_frame(self) -> std::io::Result<Vec<u8>> {
        match self {
            BatchedEvent::Output(b) => encode_frame(&AgentToHub::Output {
                channel_id: b.channel_id,
                seq: b.seq,
                ts: iso_now(),
                data: b.data,
            }),
            BatchedEvent::Frame(event) => Ok(event.frame),
        }
    }
}

const BATCH_INTERVAL_MS: u64 = 16;
const BATCH_MAX_BYTES: usize = 4096;

struct ChannelBuffer {
    data: Vec<u8>,
    last_seq: u64,
}

impl ChannelBuffer {
    /// What this channel has buffered, as one batch, if anything.
    fn take(&mut self, channel_id: &str) -> Option<BatchedOutput> {
        if self.data.is_empty() {
            return None;
        }
        Some(BatchedOutput {
            channel_id: channel_id.to_owned(),
            seq: self.last_seq,
            data: std::mem::take(&mut self.data),
        })
    }
}

/// Global output batch loop.
///
/// Receives `ChannelEvent`s from PTY reader tasks. Output accumulates per
/// channel and is flushed every 16 ms or when a channel buffer exceeds 4 KB.
/// An event about a channel first flushes that channel's buffered output, then
/// goes out: a channel's output never arrives after its CHANNEL_EXIT.
pub async fn batch_loop(
    mut rx: mpsc::UnboundedReceiver<ChannelEvent>,
    tx: mpsc::UnboundedSender<BatchedEvent>,
) {
    let mut buffers: HashMap<String, ChannelBuffer> = HashMap::new();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(BATCH_INTERVAL_MS));

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(ChannelEvent::Output(e)) => {
                        let buf = buffers.entry(e.channel_id.clone()).or_insert(ChannelBuffer {
                            data: Vec::new(),
                            last_seq: 0,
                        });
                        buf.data.extend_from_slice(&e.data);
                        buf.last_seq = e.seq;
                        if buf.data.len() >= BATCH_MAX_BYTES {
                            if let Some(batch) = buf.take(&e.channel_id) {
                                let _ = tx.send(BatchedEvent::Output(batch));
                            }
                        }
                    }
                    Some(ChannelEvent::Frame(event)) => {
                        let held = buffers
                            .get_mut(&event.channel_id)
                            .and_then(|buf| buf.take(&event.channel_id));
                        if let Some(batch) = held {
                            let _ = tx.send(BatchedEvent::Output(batch));
                        }
                        let _ = tx.send(BatchedEvent::Frame(event));
                    }
                    None => break,
                }
            }
            _ = interval.tick() => {
                for (id, buf) in buffers.iter_mut() {
                    if let Some(batch) = buf.take(id) {
                        let _ = tx.send(BatchedEvent::Output(batch));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn output(channel_id: &str, seq: u64, data: &[u8]) -> ChannelEvent {
        ChannelEvent::Output(OutputEvent {
            channel_id: channel_id.into(),
            seq,
            data: data.to_vec(),
        })
    }

    fn event(channel_id: &str, frame: &[u8]) -> ChannelEvent {
        ChannelEvent::Frame(EventFrame {
            channel_id: channel_id.into(),
            frame: frame.to_vec(),
        })
    }

    fn expect_output(item: Option<BatchedEvent>) -> BatchedOutput {
        match item {
            Some(BatchedEvent::Output(batch)) => batch,
            Some(BatchedEvent::Frame(event)) => {
                panic!("expected OUTPUT, got an event for {}", event.channel_id)
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
}
