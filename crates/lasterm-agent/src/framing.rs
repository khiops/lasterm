use crate::protocol::HubToAgent;

/// Maximum frame size: 10 MB
pub const MAX_FRAME_SIZE: u32 = 10 * 1024 * 1024;

/// Encode a message into a length-prefixed frame.
/// CRITICAL: Uses rmp_serde::to_vec_named() for map serialization.
pub fn encode_frame<T: serde::Serialize>(msg: &T) -> std::io::Result<Vec<u8>> {
    let payload = rmp_serde::to_vec_named(msg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let len = payload.len() as u32;
    if len > MAX_FRAME_SIZE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame too large: {} bytes (max {})", len, MAX_FRAME_SIZE),
        ));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// Incremental frame reader that accumulates bytes across reads.
/// Handles partial frames (header split, payload split).
pub struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Push raw bytes into the reader. Returns decoded messages.
    pub fn push(&mut self, data: &[u8]) -> std::io::Result<Vec<HubToAgent>> {
        self.buf.extend_from_slice(data);
        let mut messages = Vec::new();
        loop {
            if self.buf.len() < 4 {
                break;
            }
            let len =
                u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if len > MAX_FRAME_SIZE as usize {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "frame too large",
                ));
            }
            if self.buf.len() < 4 + len {
                break;
            }
            let payload = &self.buf[4..4 + len];
            match rmp_serde::from_slice::<HubToAgent>(payload) {
                Ok(msg) => messages.push(msg),
                Err(e) => {
                    // Unknown message type → skip frame, don't crash (SC-38).
                    // Caller can send ERROR INVALID_MESSAGE if needed.
                    tracing::warn!("skipping undecodable frame: {}", e);
                    messages.push(HubToAgent::Error {
                        code: "INVALID_MESSAGE".into(),
                        message: format!("undecodable frame: {}", e),
                        channel_id: None,
                    });
                }
            }
            self.buf.drain(..4 + len);
        }
        Ok(messages)
    }
}

impl Default for FrameReader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AgentToHub;

    #[test]
    fn test_encode_frame_structure() {
        let msg = AgentToHub::HeartbeatAck {
            ts: "2026-01-01T00:00:00Z".into(),
        };
        let frame = encode_frame(&msg).unwrap();
        // First 4 bytes = length (LE u32)
        let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
        assert_eq!(len as usize, frame.len() - 4);
        // Decode payload back
        let decoded: serde_json::Value = rmp_serde::from_slice(&frame[4..]).unwrap();
        assert_eq!(decoded["type"], "HEARTBEAT_ACK");
    }

    #[test]
    fn test_encode_uses_named_fields() {
        let msg = AgentToHub::SpawnOk {
            request_id: "req-1".into(),
            channel_id: "ch-1".into(),
        };
        let frame = encode_frame(&msg).unwrap();
        let decoded: serde_json::Value = rmp_serde::from_slice(&frame[4..]).unwrap();
        // Must have named fields, not positional
        assert!(decoded.is_object());
        assert_eq!(decoded["request_id"], "req-1");
        assert_eq!(decoded["channel_id"], "ch-1");
    }

    #[test]
    fn test_frame_reader_complete() {
        let heartbeat = crate::protocol::HubToAgent::Heartbeat { ts: "test".into() };
        let hb_payload = rmp_serde::to_vec_named(&heartbeat).unwrap();
        let mut full = Vec::new();
        full.extend_from_slice(&(hb_payload.len() as u32).to_le_bytes());
        full.extend_from_slice(&hb_payload);
        let mut reader = FrameReader::new();
        let msgs = reader.push(&full).unwrap();
        assert_eq!(msgs.len(), 1);
        matches!(msgs[0], crate::protocol::HubToAgent::Heartbeat { .. });
    }

    #[test]
    fn test_frame_reader_partial() {
        let heartbeat = crate::protocol::HubToAgent::Heartbeat { ts: "test".into() };
        let payload = rmp_serde::to_vec_named(&heartbeat).unwrap();
        let mut full = Vec::new();
        full.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        full.extend_from_slice(&payload);

        let mut reader = FrameReader::new();
        // Push only 2 bytes (partial header)
        let msgs = reader.push(&full[..2]).unwrap();
        assert_eq!(msgs.len(), 0);
        // Push rest
        let msgs = reader.push(&full[2..]).unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn test_frame_reader_rejects_oversized() {
        let mut reader = FrameReader::new();
        let huge_len = (MAX_FRAME_SIZE + 1).to_le_bytes();
        let result = reader.push(&huge_len);
        assert!(result.is_err());
    }

    #[test]
    fn test_output_data_is_binary() {
        let msg = AgentToHub::Output {
            channel_id: "ch-1".into(),
            seq: 1,
            ts: "2026-01-01T00:00:00Z".into(),
            data: vec![0x1b, 0x5b, 0x48], // ESC[H
        };
        let frame = encode_frame(&msg).unwrap();
        let payload = &frame[4..];
        // The msgpack should contain a bin type for data, not an array of ints
        let value: rmpv::Value = rmp_serde::from_slice(payload).unwrap();
        // data field should be Binary, not Array
        if let rmpv::Value::Map(map) = &value {
            let data_entry = map.iter().find(|(k, _)| k.as_str() == Some("data"));
            assert!(data_entry.is_some(), "data field not found");
            let (_, data_val) = data_entry.unwrap();
            assert!(
                data_val.is_bin(),
                "data should be Binary, got {:?}",
                data_val
            );
        } else {
            panic!("expected Map, got {:?}", value);
        }
    }

    #[test]
    fn test_frame_reader_multiple_frames() {
        let hb1 = crate::protocol::HubToAgent::Heartbeat { ts: "t1".into() };
        let hb2 = crate::protocol::HubToAgent::Heartbeat { ts: "t2".into() };

        let mut full = Vec::new();
        for hb in [&hb1, &hb2] {
            let p = rmp_serde::to_vec_named(hb).unwrap();
            full.extend_from_slice(&(p.len() as u32).to_le_bytes());
            full.extend_from_slice(&p);
        }

        let mut reader = FrameReader::new();
        let msgs = reader.push(&full).unwrap();
        assert_eq!(msgs.len(), 2);
    }
}
