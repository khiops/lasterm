use std::collections::HashMap;
use tokio::sync::mpsc;

/// Output event from a PTY channel reader task.
pub struct OutputEvent {
    pub channel_id: String,
    pub seq: u64,
    pub data: Vec<u8>,
}

/// Batched output ready to be encoded and sent to the hub.
pub struct BatchedOutput {
    pub channel_id: String,
    /// The seq of the last OutputEvent merged into this batch.
    pub seq: u64,
    pub data: Vec<u8>,
}

const BATCH_INTERVAL_MS: u64 = 16;
const BATCH_MAX_BYTES: usize = 4096;

struct ChannelBuffer {
    data: Vec<u8>,
    last_seq: u64,
}

/// Global output batch loop.
///
/// Receives `OutputEvent`s from PTY reader tasks, accumulates per channel,
/// and flushes every 16 ms or when a channel buffer exceeds 4 KB.
pub async fn batch_loop(
    mut rx: mpsc::UnboundedReceiver<OutputEvent>,
    tx: mpsc::UnboundedSender<BatchedOutput>,
) {
    let mut buffers: HashMap<String, ChannelBuffer> = HashMap::new();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(BATCH_INTERVAL_MS));

    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(e) => {
                        let buf = buffers.entry(e.channel_id.clone()).or_insert(ChannelBuffer {
                            data: Vec::new(),
                            last_seq: 0,
                        });
                        buf.data.extend_from_slice(&e.data);
                        buf.last_seq = e.seq;
                        if buf.data.len() >= BATCH_MAX_BYTES {
                            let data = std::mem::take(&mut buf.data);
                            let seq = buf.last_seq;
                            let _ = tx.send(BatchedOutput {
                                channel_id: e.channel_id,
                                seq,
                                data,
                            });
                        }
                    }
                    None => break,
                }
            }
            _ = interval.tick() => {
                let ids: Vec<String> = buffers
                    .iter()
                    .filter(|(_, v)| !v.data.is_empty())
                    .map(|(k, _)| k.clone())
                    .collect();
                for id in ids {
                    if let Some(buf) = buffers.get_mut(&id) {
                        if !buf.data.is_empty() {
                            let data = std::mem::take(&mut buf.data);
                            let seq = buf.last_seq;
                            let _ = tx.send(BatchedOutput {
                                channel_id: id,
                                seq,
                                data,
                            });
                        }
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

    #[tokio::test]
    async fn test_batch_flushes_on_timer() {
        let (out_tx, out_rx) = mpsc::unbounded_channel::<OutputEvent>();
        let (batch_tx, mut batch_rx) = mpsc::unbounded_channel::<BatchedOutput>();

        tokio::spawn(batch_loop(out_rx, batch_tx));

        out_tx
            .send(OutputEvent {
                channel_id: "ch1".into(),
                seq: 1,
                data: b"hello".to_vec(),
            })
            .unwrap();

        // Wait longer than the 16 ms timer
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;

        let batched = batch_rx.try_recv().expect("should have flushed on timer");
        assert_eq!(batched.channel_id, "ch1");
        assert_eq!(batched.data, b"hello");
        assert_eq!(batched.seq, 1);
    }

    #[tokio::test]
    async fn test_batch_flushes_on_threshold() {
        let (out_tx, out_rx) = mpsc::unbounded_channel::<OutputEvent>();
        let (batch_tx, mut batch_rx) = mpsc::unbounded_channel::<BatchedOutput>();

        tokio::spawn(batch_loop(out_rx, batch_tx));

        // Send exactly BATCH_MAX_BYTES (4096 bytes) to trigger immediate flush
        let big_data = vec![0xABu8; 4096];
        out_tx
            .send(OutputEvent {
                channel_id: "ch2".into(),
                seq: 5,
                data: big_data,
            })
            .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let batched = batch_rx
            .try_recv()
            .expect("should have flushed on threshold");
        assert_eq!(batched.channel_id, "ch2");
        assert_eq!(batched.data.len(), 4096);
        assert_eq!(batched.seq, 5);
    }
}
