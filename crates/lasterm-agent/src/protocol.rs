use serde::{Deserialize, Serialize};

/// All messages sent FROM the agent TO the hub.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToHub {
    #[serde(rename = "HELLO")]
    Hello {
        version: u32,
        agent_version: String,
        capabilities: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        available_shells: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default_shell: Option<String>,
    },
    #[serde(rename = "SPAWN_OK")]
    SpawnOk {
        request_id: String,
        channel_id: String,
    },
    #[serde(rename = "SPAWN_ERR")]
    SpawnErr {
        request_id: String,
        code: String,
        message: String,
    },
    #[serde(rename = "OUTPUT")]
    Output {
        channel_id: String,
        seq: u64,
        ts: String,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    #[serde(rename = "SNAPSHOT_RES")]
    SnapshotRes {
        channel_id: String,
        snapshot: SnapshotData,
        last_seq: u64,
    },
    #[serde(rename = "ATTACH_OK")]
    AttachOk {
        channel_id: String,
        snapshot: SnapshotData,
        last_seq: u64,
    },
    #[serde(rename = "CHANNEL_EXIT")]
    ChannelExit {
        channel_id: String,
        exit_code: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        signal: Option<String>,
    },
    #[serde(rename = "HEARTBEAT_ACK")]
    HeartbeatAck { ts: String },
    #[serde(rename = "TITLE_CHANGE")]
    TitleChange {
        channel_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_title: Option<String>,
    },
    #[serde(rename = "PROCESS_TITLE")]
    ProcessTitle {
        channel_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_title: Option<String>,
    },
    #[serde(rename = "BELL")]
    Bell { channel_id: String },
    #[serde(rename = "NOTIFICATION")]
    Notification { channel_id: String, message: String },
    #[serde(rename = "AGENT_CHANNEL_STATE")]
    AgentChannelState {
        channel_id: String,
        title: String,
        pid: u32,
        alive: bool,
    },
    /// Ends the list of the connection owner's channels.
    #[serde(rename = "CHANNEL_STATE_END")]
    ChannelStateEnd {
        /// How many channels other hubs hold on this agent (#127). The hub may
        /// show it; it must not act on those channels.
        other_owner_channels: u32,
    },
    #[serde(rename = "ERROR")]
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel_id: Option<String>,
        /// With `OTHER_HUBS_HOLD_CHANNELS` only: how many channels other hubs
        /// hold. Absent from every other ERROR, which stays as it was on the wire.
        #[serde(skip_serializing_if = "Option::is_none")]
        other_owner_channels: Option<u32>,
    },
    #[serde(rename = "LOG")]
    Log {
        channel_id: String,
        level: String,
        msg: String,
    },
    /// The answer to ENV_QUERY (`env-modes`, #576): the variables a terminal
    /// would start with in that mode, before the profile changes anything.
    /// The values can be secrets: this frame is never logged, on either side.
    #[serde(rename = "ENV")]
    Env {
        request_id: String,
        env: std::collections::HashMap<String, String>,
        /// The OS the agent runs on, so a reader knows how its names compare.
        os: String,
    },
}

/// All messages sent FROM the hub TO the agent.
///
/// SPAWN is by far the largest variant. A message is decoded, dispatched and
/// dropped one at a time, never stored in bulk, so boxing it would buy nothing.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HubToAgent {
    /// AUTH handshake: the first message after HELLO. When the agent has a
    /// token configured in auth.json, a missing or mismatched one closes the
    /// connection. `hub_key` names the hub, and so the owner of every channel
    /// the connection spawns (#127); without one the connection is `legacy`.
    #[serde(rename = "AUTH")]
    Auth {
        token: String,
        #[serde(default)]
        hub_key: Option<String>,
    },
    #[serde(rename = "SPAWN")]
    Spawn {
        request_id: String,
        #[serde(default)]
        channel_id: Option<String>,
        #[serde(default)]
        shell: Option<String>,
        #[serde(default)]
        args: Option<Vec<String>>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Option<std::collections::HashMap<String, String>>,
        cols: u16,
        rows: u16,
        #[serde(default)]
        direct_process: Option<bool>,
        #[serde(default)]
        elevated: Option<bool>,
        /// SECURITY NOTE: This arrives as plain String from serde deserialization.
        /// The handler MUST immediately wrap it in `Zeroizing<String>` and clear
        /// the original. A custom Deserialize impl for Zeroizing<String> would
        /// require a serde wrapper — deferred as non-critical since the window
        /// between deserialization and wrapping is a single function call.
        #[serde(default)]
        elevation_secret: Option<String>,
        #[serde(default)]
        elevation_method: Option<String>,
        #[serde(default)]
        custom_command: Option<String>,
        /// `inherit` (the default) or `minimal`: what the environment starts
        /// from (#576). Hubs from before it do not send it.
        #[serde(default)]
        env_mode: Option<String>,
        /// Variables to remove from that start, before `env` is applied: what
        /// a profile set to `null`.
        #[serde(default)]
        env_unset: Option<Vec<String>>,
        /// Start the shell as a login shell. A Unix agent adds `-l` for a shell
        /// known to take it, when `args` is empty; Windows ignores it.
        #[serde(default)]
        login_shell: Option<bool>,
    },
    /// Ask for the variables a terminal would start with in `mode`
    /// (`env-modes`, #576). Answered with ENV.
    #[serde(rename = "ENV_QUERY")]
    EnvQuery {
        request_id: String,
        #[serde(default)]
        mode: Option<String>,
    },
    #[serde(rename = "INPUT")]
    Input {
        channel_id: String,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    #[serde(rename = "RESIZE")]
    Resize {
        channel_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "SNAPSHOT_REQ")]
    SnapshotReq { channel_id: String },
    #[serde(rename = "ATTACH")]
    Attach { channel_id: String },
    #[serde(rename = "DESTROY")]
    Destroy { channel_id: String },
    #[serde(rename = "HEARTBEAT")]
    Heartbeat { ts: String },
    /// Ask a daemon to stop (#127). Without `force`, it refuses while other
    /// hubs hold channels on it; otherwise it takes the path SIGTERM takes.
    #[serde(rename = "STOP")]
    Stop {
        #[serde(default)]
        force: bool,
    },
    #[serde(rename = "ERROR")]
    Error {
        code: String,
        message: String,
        #[serde(default)]
        channel_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SnapshotData {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
}

/// Standard error codes
pub mod error_codes {
    pub const SHELL_NOT_FOUND: &str = "SHELL_NOT_FOUND";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const PTY_SPAWN_FAILED: &str = "PTY_SPAWN_FAILED";
    pub const ELEVATION_PASSWORD_REQUIRED: &str = "ELEVATION_PASSWORD_REQUIRED";
    pub const INVALID_MESSAGE: &str = "INVALID_MESSAGE";
    pub const CHANNEL_NOT_FOUND: &str = "CHANNEL_NOT_FOUND";
    pub const CHANNEL_EXISTS: &str = "CHANNEL_EXISTS";
    /// A newer connection of the same hub has replaced this one, which is
    /// ending.
    ///
    /// The daemon serves several hubs at once, one connection each, and a
    /// hub's newest connection replaces its previous one: a connection left
    /// half-open must not lock that hub out. Saying so is what lets the
    /// connection being replaced tell "I am no longer the one driving these
    /// terminals" from "these terminals stopped answering" (#127).
    pub const DISPLACED: &str = "DISPLACED";
    /// A STOP without `force` was refused: other hubs hold channels on this
    /// agent, and stopping it would end them (#127).
    pub const OTHER_HUBS_HOLD_CHANNELS: &str = "OTHER_HUBS_HOLD_CHANNELS";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that AgentToHub::Log serializes with snake_case field names
    /// and the "LOG" rename in MessagePack named format.
    #[test]
    fn log_variant_serializes_snake_case() {
        let msg = AgentToHub::Log {
            channel_id: "ch_01".to_string(),
            level: "debug".to_string(),
            msg: "PTY closed".to_string(),
        };

        let bytes = rmp_serde::to_vec_named(&msg).expect("serialization must succeed");
        // rmp_serde encodes externally-tagged enums as a flat map:
        // { "type": "VARIANT_NAME", ...fields }
        let decoded: serde_json::Value =
            rmp_serde::from_slice(&bytes).expect("must decode via serde_json::Value");

        assert!(decoded.is_object(), "top-level must be a map/object");
        assert_eq!(decoded["type"], "LOG", "serde rename must produce LOG");
        assert_eq!(decoded["channel_id"], "ch_01", "channel_id snake_case");
        assert_eq!(decoded["level"], "debug", "level field present");
        assert_eq!(decoded["msg"], "PTY closed", "msg field present");

        // Confirm no camelCase leakage
        assert!(
            decoded.get("channelId").is_none(),
            "must not have camelCase channelId"
        );
    }

    /// Verify that all AgentToHub variants that are used by send_frame
    /// round-trip through msgpack without error.
    #[test]
    fn log_variant_error_level_serializes() {
        let msg = AgentToHub::Log {
            channel_id: "ch_02".to_string(),
            level: "error".to_string(),
            msg: "spawn failed: no such file".to_string(),
        };
        let bytes = rmp_serde::to_vec_named(&msg).expect("serialization must succeed");

        // rmp_serde encodes as a flat map: { "type": "LOG", ...fields }
        let decoded: serde_json::Value =
            rmp_serde::from_slice(&bytes).expect("must decode via serde_json::Value");

        assert_eq!(decoded["type"], "LOG");
        assert_eq!(decoded["channel_id"], "ch_02");
        assert_eq!(decoded["level"], "error");
        assert_eq!(decoded["msg"], "spawn failed: no such file");
    }

    fn hub_frame(value: serde_json::Value) -> HubToAgent {
        let bytes = rmp_serde::to_vec_named(&value).expect("encode a hub frame");
        rmp_serde::from_slice(&bytes).expect("decode a hub frame")
    }

    /// Today's hubs send AUTH without a key: it still decodes, as no key.
    #[test]
    fn auth_reads_a_hub_key_and_does_without_one() {
        match hub_frame(serde_json::json!({ "type": "AUTH", "token": "t" })) {
            HubToAgent::Auth { token, hub_key } => {
                assert_eq!(token, "t");
                assert_eq!(hub_key, None);
            }
            other => panic!("expected AUTH, got {other:?}"),
        }
        match hub_frame(serde_json::json!({ "type": "AUTH", "token": "", "hub_key": "k" })) {
            HubToAgent::Auth { token, hub_key } => {
                assert_eq!(token, "");
                assert_eq!(hub_key.as_deref(), Some("k"));
            }
            other => panic!("expected AUTH, got {other:?}"),
        }
    }

    #[test]
    fn stop_reads_its_force_flag() {
        assert!(matches!(
            hub_frame(serde_json::json!({ "type": "STOP", "force": true })),
            HubToAgent::Stop { force: true }
        ));
        assert!(matches!(
            hub_frame(serde_json::json!({ "type": "STOP", "force": false })),
            HubToAgent::Stop { force: false }
        ));
    }

    /// The count is a field the hub reads first, on the refusal only. Every
    /// other ERROR is the bytes it was before the field existed.
    #[test]
    fn only_the_stop_refusal_carries_a_count_of_other_hubs_channels() {
        let ordinary = rmp_serde::to_vec_named(&AgentToHub::Error {
            code: error_codes::CHANNEL_NOT_FOUND.into(),
            message: "channel ch-1 not found".into(),
            channel_id: Some("ch-1".into()),
            other_owner_channels: None,
        })
        .unwrap();
        // The map an ERROR was before this field, key for key, in order.
        let field = |key: &str, value: &str| {
            (
                rmpv::Value::String(key.into()),
                rmpv::Value::String(value.into()),
            )
        };
        let before = rmp_serde::to_vec_named(&rmpv::Value::Map(vec![
            field("type", "ERROR"),
            field("code", "CHANNEL_NOT_FOUND"),
            field("message", "channel ch-1 not found"),
            field("channel_id", "ch-1"),
        ]))
        .unwrap();
        assert_eq!(
            ordinary, before,
            "an ordinary ERROR must not change on the wire"
        );

        let refusal = rmp_serde::to_vec_named(&AgentToHub::Error {
            code: error_codes::OTHER_HUBS_HOLD_CHANNELS.into(),
            message: "2 terminals on this agent belong to other hubs".into(),
            channel_id: None,
            other_owner_channels: Some(2),
        })
        .unwrap();
        let decoded: serde_json::Value = rmp_serde::from_slice(&refusal).unwrap();
        assert_eq!(decoded["code"], "OTHER_HUBS_HOLD_CHANNELS");
        assert_eq!(decoded["other_owner_channels"], 2);
        assert!(decoded.get("channel_id").is_none());
    }

    #[test]
    fn spawn_reads_the_environment_fields_and_does_without_them() {
        match hub_frame(serde_json::json!({
            "type": "SPAWN", "request_id": "r", "cols": 80, "rows": 24,
            "env_mode": "minimal", "env_unset": ["NO_COLOR", "PAGER"], "login_shell": true,
        })) {
            HubToAgent::Spawn {
                env_mode,
                env_unset,
                login_shell,
                ..
            } => {
                assert_eq!(env_mode.as_deref(), Some("minimal"));
                assert_eq!(env_unset, Some(vec!["NO_COLOR".into(), "PAGER".into()]));
                assert_eq!(login_shell, Some(true));
            }
            other => panic!("expected SPAWN, got {other:?}"),
        }
        // A hub from before #576 sends none of them.
        match hub_frame(
            serde_json::json!({ "type": "SPAWN", "request_id": "r", "cols": 80, "rows": 24 }),
        ) {
            HubToAgent::Spawn {
                env_mode,
                env_unset,
                login_shell,
                ..
            } => {
                assert_eq!(env_mode, None);
                assert_eq!(env_unset, None);
                assert_eq!(login_shell, None);
            }
            other => panic!("expected SPAWN, got {other:?}"),
        }
    }

    #[test]
    fn env_query_and_env_speak_snake_case_and_keep_names_as_they_are() {
        match hub_frame(
            serde_json::json!({ "type": "ENV_QUERY", "request_id": "q1", "mode": "inherit" }),
        ) {
            HubToAgent::EnvQuery { request_id, mode } => {
                assert_eq!(request_id, "q1");
                assert_eq!(mode.as_deref(), Some("inherit"));
            }
            other => panic!("expected ENV_QUERY, got {other:?}"),
        }

        let bytes = rmp_serde::to_vec_named(&AgentToHub::Env {
            request_id: "q1".into(),
            env: [("LC_ALL".to_string(), "C".to_string())].into(),
            os: "linux".into(),
        })
        .unwrap();
        let decoded: serde_json::Value = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded["type"], "ENV");
        assert_eq!(decoded["request_id"], "q1");
        assert_eq!(decoded["env"]["LC_ALL"], "C");
        assert_eq!(decoded["os"], "linux");
    }

    #[test]
    fn channel_state_end_counts_other_hubs_channels() {
        let bytes = rmp_serde::to_vec_named(&AgentToHub::ChannelStateEnd {
            other_owner_channels: 3,
        })
        .unwrap();
        let decoded: serde_json::Value = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded["type"], "CHANNEL_STATE_END");
        assert_eq!(decoded["other_owner_channels"], 3);
    }
}
