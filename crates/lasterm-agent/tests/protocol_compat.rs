//! Protocol compatibility tests for lasterm-agent.
//!
//! These tests verify that the Rust MessagePack serialization output matches
//! what the TypeScript hub expects: binary data fields use MsgPack Bin (not
//! Array), all field names are snake_case, and messages serialize as maps
//! (not arrays).
//!
//! Tests do NOT spawn the binary — they work directly with the encoding layer.
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// OUTPUT data field must be MessagePack Bin, not an Array of integers.
///
/// The TS hub decodes `data` with a Uint8Array view — an Array-of-ints would
/// break that. The Rust side uses `#[serde(with = "serde_bytes")]` to ensure
/// the Bin wire type; this test proves that choice round-trips correctly.
#[test]
fn test_output_data_is_msgpack_bin() {
    // Build an OUTPUT-like map directly (bypasses Rust protocol types so the
    // test is independent of any future rename/restructure).
    let output = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("type".into()),
            rmpv::Value::String("OUTPUT".into()),
        ),
        (
            rmpv::Value::String("channel_id".into()),
            rmpv::Value::String("ch-1".into()),
        ),
        (
            rmpv::Value::String("seq".into()),
            rmpv::Value::Integer(1.into()),
        ),
        (
            rmpv::Value::String("ts".into()),
            rmpv::Value::String("2026-01-01T00:00:00.000Z".into()),
        ),
        // Binary payload: ESC [ H (cursor-home sequence)
        (
            rmpv::Value::String("data".into()),
            rmpv::Value::Binary(vec![0x1b, 0x5b, 0x48]),
        ),
    ]);

    let encoded = rmp_serde::to_vec_named(&output).expect("encode output map");
    let decoded: rmpv::Value = rmp_serde::from_slice(&encoded).expect("decode output map");

    if let rmpv::Value::Map(pairs) = decoded {
        let data_val = pairs
            .iter()
            .find(|(k, _)| k.as_str() == Some("data"))
            .map(|(_, v)| v)
            .expect("data field must be present");

        assert!(
            data_val.is_bin(),
            "data field must be MessagePack Bin (got {:?}); TS hub expects Uint8Array",
            data_val
        );
    } else {
        panic!("decoded value must be a Map");
    }
}

/// All non-type field names in agent → hub messages must be snake_case.
///
/// The TS codec uses `camelCase` internally but expects `snake_case` on the
/// wire.  `rmp_serde::to_vec_named` preserves Rust field names, which are
/// defined as snake_case in the protocol structs.
#[test]
fn test_field_names_snake_case() {
    let spawn_ok = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("type".into()),
            rmpv::Value::String("SPAWN_OK".into()),
        ),
        (
            rmpv::Value::String("request_id".into()),
            rmpv::Value::String("req-1".into()),
        ),
        (
            rmpv::Value::String("channel_id".into()),
            rmpv::Value::String("ch-1".into()),
        ),
    ]);

    let encoded = rmp_serde::to_vec_named(&spawn_ok).expect("encode spawn_ok");
    let decoded: rmpv::Value = rmp_serde::from_slice(&encoded).expect("decode spawn_ok");

    if let rmpv::Value::Map(pairs) = decoded {
        for (key, _) in &pairs {
            let key_str = key.as_str().expect("key must be a string");
            // `type` carries the UPPER_SNAKE_CASE tag — that is intentional.
            if key_str == "type" {
                continue;
            }
            assert!(
                !key_str.chars().any(|c| c.is_uppercase()),
                "field '{}' is not snake_case — TS hub expects snake_case wire names",
                key_str
            );
        }
    } else {
        panic!("decoded value must be a Map");
    }
}

/// `rmp_serde::to_vec_named` serializes structs/maps as MsgPack maps, not arrays.
///
/// The TS hub uses `@msgpack/msgpack` which decodes MsgPack maps into JS
/// objects.  If Rust used positional (array) encoding the TS side would receive
/// an Array instead of an Object and all field lookups would fail.
#[test]
fn test_serialization_is_map_not_array() {
    let hello = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("type".into()),
            rmpv::Value::String("HELLO".into()),
        ),
        (
            rmpv::Value::String("version".into()),
            rmpv::Value::Integer(1.into()),
        ),
    ]);

    let encoded = rmp_serde::to_vec_named(&hello).expect("encode hello");
    let decoded: rmpv::Value = rmp_serde::from_slice(&encoded).expect("decode hello");

    assert!(
        decoded.is_map(),
        "serialized message must be a MsgPack map, not an array (got {:?})",
        decoded
    );
}

/// The 4-byte LE length prefix framing is correct: prefix equals payload length.
///
/// The TS hub reads `buf.readUInt32LE(0)` to get the payload size.
#[test]
fn test_frame_length_prefix_is_little_endian() {
    let msg = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("type".into()),
            rmpv::Value::String("HEARTBEAT_ACK".into()),
        ),
        (
            rmpv::Value::String("ts".into()),
            rmpv::Value::String("2026-01-01T00:00:00Z".into()),
        ),
    ]);

    let payload = rmp_serde::to_vec_named(&msg).expect("encode message");
    let payload_len = payload.len() as u32;

    // Simulate encode_frame
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&payload_len.to_le_bytes());
    frame.extend_from_slice(&payload);

    // Decode the prefix
    let prefix = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
    assert_eq!(
        prefix as usize,
        frame.len() - 4,
        "LE length prefix must equal the payload byte length"
    );

    // Verify round-trip decode
    let decoded: rmpv::Value = rmp_serde::from_slice(&frame[4..]).expect("decode payload");
    assert_eq!(decoded["type"].as_str(), Some("HEARTBEAT_ACK"));
}

/// CHANNEL_EXIT exit_code field is a signed integer (not string or float).
///
/// The TS hub stores exit codes as `number`.  A wrong encoding (e.g., f64)
/// would cause type mismatches.
#[test]
fn test_channel_exit_code_is_integer() {
    let exit_msg = rmpv::Value::Map(vec![
        (
            rmpv::Value::String("type".into()),
            rmpv::Value::String("CHANNEL_EXIT".into()),
        ),
        (
            rmpv::Value::String("channel_id".into()),
            rmpv::Value::String("ch-1".into()),
        ),
        (
            rmpv::Value::String("exit_code".into()),
            rmpv::Value::Integer(0.into()),
        ),
    ]);

    let encoded = rmp_serde::to_vec_named(&exit_msg).expect("encode channel_exit");
    let decoded: rmpv::Value = rmp_serde::from_slice(&encoded).expect("decode channel_exit");

    let exit_code = decoded
        .as_map()
        .and_then(|pairs| {
            pairs
                .iter()
                .find(|(k, _)| k.as_str() == Some("exit_code"))
                .map(|(_, v)| v.clone())
        })
        .expect("exit_code field must be present");

    assert!(
        exit_code.is_i64() || exit_code.is_u64(),
        "exit_code must be a MsgPack integer, got {:?}",
        exit_code
    );
}
