// Protocol and runtime constants for lasterm

// PROTOCOL_VERSION is checked by AgentConnection.handleData with strict equality
// (hub closes the connection if the Rust agent version does not match).
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
	INVALID_MESSAGE: "INVALID_MESSAGE",
	/** Agent: a newer connection of this same hub took this one's place. */
	DISPLACED: "DISPLACED",
	/** Agent: a STOP without `force`, refused while other hubs hold channels there (#127). */
	OTHER_HUBS_HOLD_CHANNELS: "OTHER_HUBS_HOLD_CHANNELS",
	/** REST stop-keeping: the connected agent did not reach a remote daemon. */
	NO_DAEMON_CONNECTION: "NO_DAEMON_CONNECTION",
	/** REST PUT host: use stop-keeping before revoking a connected daemon policy. */
	DAEMON_CONNECTED: "DAEMON_CONNECTED",
	/** REST: the host has no agent connected to this hub, so there is nobody to ask (#576), including POST /api/hosts/:id/agent/stop-keeping. */
	HOST_NOT_CONNECTED: "HOST_NOT_CONNECTED",
	/**
	 * SPAWN, and the restart route: the host is away. The hub lost it and is
	 * reaching for it again, or lost it while the terminal was starting. Says
	 * nothing about the terminal: started again once the host is back, it may
	 * well run (#605). Also a SPAWN marked `automatic` on a host its user
	 * disconnected, which nothing but that user brings back (#648).
	 */
	HOST_UNREACHABLE: "HOST_UNREACHABLE",
	/** SessionManager refuses host actions while Replace holds its stop marker. */
	HOST_BUSY: "HOST_BUSY",
	/**
	 * REST, reconnect, disconnect and POST /api/hosts/:id/agent/stop-keeping: closing this host's connection would end
	 * terminals. Consent is read by readHostConnectionBody or readStopKeepingBody (#648).
	 */
	TERMINALS_WOULD_END: "TERMINALS_WOULD_END",
	/** REST, connect, reconnect, disconnect and POST /api/hosts/:id/agent/stop-keeping: the host is the local one, which has no connection to act on (#648). */
	NOT_SSH_HOST: "NOT_SSH_HOST",
	/** REST: the host's agent did not answer in time (#576). */
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
