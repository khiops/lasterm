// Protocol and runtime constants for lasterm

// PROTOCOL_VERSION is checked by AgentConnection.handleData with strict equality
// (hub closes the connection if the Rust agent version does not match).
// The AUTH_PROMPT/AUTH_PROMPT_RESPONSE promptId + deliveryEpoch fields and
// PROMPT_CANCEL are additive optional additions — not a breaking wire change.
// Do NOT bump until promptId becomes required (would reject un-updated Rust agents).
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_SIZE = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_PORT = 4100;
export const PORT_RANGE_START = 4100;
export const PORT_RANGE_END = 4199;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MISS_LIMIT = 3;
export const PING_INTERVAL_MS = 30_000;
export const PING_MISS_LIMIT = 2;
export const OUTPUT_BATCH_MS = 16;
export const OUTPUT_BATCH_BYTES = 4096;
export const SNAPSHOT_IDLE_MS = 3000;
export const SNAPSHOT_FORCED_MS = 5000;
export const MAX_CHANNELS_PER_AGENT = 50;
export const SSH_RECONNECT_INITIAL_MS = 1000;
export const SSH_RECONNECT_MAX_MS = 30_000;
export const SSH_RECONNECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
export const SESSION_DETACH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
export const CHUNK_MAX_BYTES = 256 * 1024; // 256 KB
export const CHUNK_FLUSH_MS = 1000;
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_EXPIRY_MS = 60_000;
export const MAX_ENV_ENTRIES = 100;
export const DEFAULT_CHANNEL_NAME = "Terminal";

/**
 * Resolve the display name for a channel using strict title source mode.
 *
 * Priority:
 *   1. Custom title (F2 rename) — always honored
 *   2. Source-specific title (dynamic/process/static) — only the configured source
 *   3. DEFAULT_CHANNEL_NAME
 *
 * Pure function — no Vue/Pinia deps. Usable in stores, composables, and components.
 */
export function resolveChannelDisplayName(
	channel:
		| { title?: string | null; dynamicTitle?: string | null; processTitle?: string | null }
		| null
		| undefined,
	titleSource: "dynamic" | "static" | "process" = "dynamic",
	staticTitle = "",
): string {
	if (channel?.title) return channel.title;
	switch (titleSource) {
		case "dynamic":
			if (channel?.dynamicTitle) return channel.dynamicTitle;
			break;
		case "process":
			if (channel?.processTitle) return channel.processTitle;
			break;
		case "static":
			if (staticTitle) return staticTitle;
			break;
	}
	// Fallback chain: dynamicTitle → processTitle → default
	if (channel?.dynamicTitle) return channel.dynamicTitle;
	if (channel?.processTitle) return channel.processTitle;
	return DEFAULT_CHANNEL_NAME;
}

export const ErrorCode = {
	AUTH_REQUIRED: "AUTH_REQUIRED",
	AUTH_INVALID: "AUTH_INVALID",
	CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
	NOT_ATTACHED: "NOT_ATTACHED",
	WRITE_LOCK_HELD: "WRITE_LOCK_HELD",
	HOST_NOT_FOUND: "HOST_NOT_FOUND",
	SSH_FAILED: "SSH_FAILED",
	AGENT_ERROR: "AGENT_ERROR",
	FRAME_TOO_LARGE: "FRAME_TOO_LARGE",
	PROTOCOL_ERROR: "PROTOCOL_ERROR",
	SHELL_NOT_FOUND: "SHELL_NOT_FOUND",
	PERMISSION_DENIED: "PERMISSION_DENIED",
	PTY_SPAWN_FAILED: "PTY_SPAWN_FAILED",
	CHANNEL_LIMIT: "CHANNEL_LIMIT",
	INVALID_MESSAGE: "INVALID_MESSAGE",
	VERSION_MISMATCH: "VERSION_MISMATCH",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
