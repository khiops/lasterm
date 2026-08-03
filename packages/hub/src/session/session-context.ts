/**
 * SharedSessionContext — mutable runtime state shared across all sub-managers.
 * Each sub-manager receives a reference to this context in its constructor
 * so they can read/write the same Maps without circular constructor deps.
 */

import type { AgentConfig, ChannelStatus, SessionStatus } from "@termora/shared";
import type { ConfigResolver } from "../config.js";
import type { MetaDAL } from "../storage/meta.js";
import type { SpoolDAL } from "../storage/spool.js";
import type { AgentConnection } from "./agent-connection.js";
import type { OutputChunker } from "./output-chunker.js";
import type { QuitFence } from "./quit-fence.js";
import type { WsClient } from "./session-manager.js";
import type { SnapshotScheduler } from "./snapshot-scheduler.js";

/**
 * Maps remain readable and teardown can remove dead state, but revival writes
 * are private to commits. ReadonlyMap also makes forEach expose a readonly map.
 */
export type CommitProtectedMap<K, V> = ReadonlyMap<K, V> & Pick<Map<K, V>, "delete" | "clear">;
/** The session DAL is narrowed too; otherwise it re-exposes createSession. */
export type SessionMetaDAL = Omit<MetaDAL, "createSession" | "sessions"> & {
	readonly sessions: Omit<MetaDAL["sessions"], "createSession">;
};

export interface RevivalCommits {
	adoptAgent(fence: QuitFence, hostId: string, agent: AgentConnection): void;
	persistSession(fence: QuitFence, hostId: string, state: SessionState): void;
	createSession(
		fence: QuitFence,
		input: { id: string; hostId: string; status: SessionStatus },
	): void;
}

// ─── Session-acquisition state machine types ──────────────────────────────────

/**
 * A Lease represents a single spawn-intent's claim on a SessionAcquisition.
 * release(lease) is idempotent (per-lease `released` flag).
 *
 * _acq is an internal back-reference to the owning SessionAcquisition so that
 * release() can ALWAYS remove the lease from acq.leases even after commit()
 * deletes the acq from ctx.acquisitions (P2). This keeps the refcount accurate
 * in both the pre-commit and post-commit regimes (Fix A).
 */
export interface Lease {
	readonly id: string;
	/** hostId this lease is for — for diagnostics */
	readonly hostId: string;
	/** acqId this lease belongs to */
	readonly acqId: string;
	/** clientId of the WsClient that issued this spawn-intent.
	 * Used by the prompt re-target logic: when the prompt owner disconnects,
	 * the disconnect handler searches other live leases for a connected candidate. */
	readonly clientId: string;
	/** Set to true by release(); prevents double-release */
	released: boolean;
	/** Internal back-reference to the owning acq — set by acquire()/join(), never reassigned */
	readonly _acq: SessionAcquisition;
}

/**
 * SessionAcquisition — the single authority for a host while connecting.
 *
 * State machine:
 *   CONNECTING  → commit() → session active, acq deleted (P2)
 *   CONNECTING  → fail()   → FAILED, acq deleted
 *   CONNECTING  → close()  → CLOSING, acq deleted, controller aborted
 *   CLOSING     → (terminal, joins refused)
 *   FAILED      → (terminal, joins refused)
 *   RECONNECTING (reserved for invariant 10 follow-up — same structure)
 *
 * P1: All state mutations are synchronous (check-and-mutate in one block, no
 *     await between reading state and writing it).
 * P2: acq exists ONLY while CONNECTING/RECONNECTING. Deleted on commit().
 * P3: leases.size is the refcount. reap when size===0 and no channels.
 */
export interface SessionAcquisition {
	readonly id: string;
	readonly hostId: string;
	state: "CONNECTING" | "RECONNECTING" | "CLOSING" | "FAILED";
	readonly controller: AbortController;
	/** Shared promise all waiters await. Resolved by commit(), rejected by fail()/close(). */
	readonly connectPromise: Promise<SessionState>;
	/** Internal resolver/rejecter for connectPromise — called exactly once. */
	_resolve: (s: SessionState) => void;
	_reject: (e: Error) => void;
	/** Live spawn-intents; refCount = leases.size */
	readonly leases: Set<Lease>;
}

/**
 * Unified pending prompt entry — covers host-key verify, agent-verify, and passphrase
 * prompts. Keyed by promptId (globally unique). ownerAcqId ties each prompt to the
 * acquisition that issued it, enabling safe cleanup by owner identity.
 */
export interface PendingPrompt {
	readonly ownerAcqId: string;
	readonly hostId: string;
	readonly timer: ReturnType<typeof setTimeout> | null;
	readonly resolve: (result: unknown) => void;
	/** clientId of the WsClient currently owning this prompt (re-targetable on disconnect). */
	clientId: string;
	// PromptContext-owned prompt routing metadata.
	/** Globally unique prompt id (ULID). Carried on wire, echoed in response. */
	promptId?: string;
	/** PromptContext id that owns this prompt. */
	contextId?: string;
	/** Discriminator for the prompt type. */
	type?: "passphrase" | "host_verify" | "agent_verify" | "elevation";
	/** Monotonic counter incremented on every (re)send / retarget. */
	deliveryEpoch?: number;
	/** Payload needed to re-send this prompt to a new route (retarget). */
	resendPayload?: unknown;
}

// PromptContext types.

/**
 * PromptContext — stable owner of a prompt sequence for one connect/test/elevation flow.
 *
 * Owner identity:
 *   - "session" kind: id === acqId of the SessionAcquisition that started it.
 *   - "test" / "elevation" kinds: id is a fresh ULID.
 *
 * routeClientId is the single live client that receives prompts NOW. It is mutable
 * via retarget() — all in-flight and future prompts of this context route to the
 * current routeClientId.
 *
 * state transitions:
 *   OPEN → clearContext() → CLOSED (terminal, all pending resolved null, all maps cleaned)
 */
export interface PromptContext {
	readonly id: string;
	readonly kind: "session" | "test" | "elevation";
	readonly hostId: string;
	/** The live client that receives this context's prompts. Mutable via retarget(). */
	routeClientId: string;
	/** Terminal flag — set synchronously in clearContext() before any async work. */
	state: "OPEN" | "CLOSED";
	/** Set of promptIds belonging to this context (in-flight). */
	prompts: Set<string>;
}

export interface ElevationPromptOwner {
	readonly hostId: string;
	readonly sessionId: string;
	readonly owner: "spawn" | "channel-restart";
	readonly operationId: string;
	readonly channelId?: string;
}

export interface ChannelState {
	sessionId: string;
	hostId: string;
	status: ChannelStatus;
	/** clientId set — empty when orphan */
	clients: Set<string>;
	shell: string;
	args?: string[];
	cwd?: string;
	cols: number;
	rows: number;
	directProcess?: boolean;
	dynamicTitle: string | null;
	processTitle: string | null;
	displayTitle: string;
}

export interface SessionState {
	id: string;
	hostId: string;
	status: SessionStatus;
}

export interface SharedSessionContext {
	/** Hub-owned latch. Once QUITTING, revival work can never be committed again. */
	quitState: "RUNNING" | "QUITTING";
	/** Incremented synchronously with quitState so async revival work can fence itself. */
	quitEpoch: number;
	/** hostId → AgentConnection */
	agents: CommitProtectedMap<string, AgentConnection>;
	/** hostId → SessionState */
	sessions: CommitProtectedMap<string, SessionState>;
	/** The only route by which a local revival becomes externally visible. */
	commits: RevivalCommits;
	/** channelId → ChannelState */
	channels: Map<string, ChannelState>;
	/** clientId → WsClient */
	clients: Map<string, WsClient>;
	/** hostId → pending reconnect timer */
	reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
	/**
	 * hostId → AbortController for the in-flight reconnect attempt.
	 * Stored so closeSession() can abort a start() that is awaiting SSH handshake.
	 * The controller is created when the reconnect timer fires and cleared when the
	 * attempt settles (success or failure) or is aborted.
	 */
	reconnectAbortControllers: Map<string, AbortController>;
	/** Crash-loop tracking for local agent restarts: hostId → { count, windowStart } */
	restartTracking: Map<string, { count: number; windowStart: number }>;
	/** requestId → callback for pending agent responses */
	pendingRequests: Map<string, (msg: import("@termora/shared").ProtocolMessage) => void>;
	/** '${hostname}:${port}' → fingerprint trusted for this session only (trust_once, not persisted) */
	trustedOnceFingerprints: Map<string, string>;
	/** Per-host SHA256 of agent binary trusted for this session only (trust_once). */
	trustedAgentSha256: Map<string, string>;
	/** channelId → timestamps of recent BELL messages (sliding window for rate limiting) */
	bellTimestamps: Map<string, number[]>;
	/** channelId → timestamps of recent NOTIFICATION messages (sliding window for rate limiting) */
	notificationTimestamps: Map<string, number[]>;
	/** hostId → cached elevation secret + expiry (TTL 15 min) */
	elevationCache: Map<string, { secret: string; expiresAt: number }>;
	/** Per-host cached passphrase (opt-in "remember for session"). Cleared on hub restart. */
	passphraseCache: Map<string, { secret: string; expiresAt: number }>;
	/** hostId → capabilities string[] reported in the agent HELLO message */
	agentCapabilities: Map<string, string[]>;
	/** channelId → pending title debounce timer for DB writes */
	titleDebounceTimers: Map<string, ReturnType<typeof setTimeout>>;
	/** channelId → pending process title debounce timer for DB writes */
	processTitleDebounceTimers: Map<string, ReturnType<typeof setTimeout>>;
	/** Optional callback to resolve the current write-lock holder for a channel */
	getWriteLockHolder: ((channelId: string) => string | null) | null;
	/** DALs */
	metaDal: SessionMetaDAL;
	spoolDal: SpoolDAL;
	/** Scheduler, chunker */
	scheduler: SnapshotScheduler;
	chunker: OutputChunker;
	/** Config */
	agentConfig: AgentConfig;
	configResolver: ConfigResolver | null;
	/** Per-channel logger registry */
	loggerRegistry: import("../logging/index.js").LoggerRegistry | null;
	/** Structured logger for hub operations (injected by SessionManager constructor) */
	hubLogger: import("../logging/hub-logger.js").HubLogger | null;
	/** Primary auth token for daemon agent authentication */
	primaryToken: string | null;
	/**
	 * Session-acquisition state machine (P1/P2/P3 redesign — invariants 1–9).
	 * Replaces the old acquiringSessions + sessionWaiters pair.
	 *
	 * hostId → SessionAcquisition (exists only while CONNECTING or RECONNECTING).
	 * Identity rule: every removal/abort is guarded
	 *   `if (ctx.acquisitions.get(hostId) === acq) …`
	 * Leases replace the old sessionWaiters counter; refCount = acq.leases.size.
	 */
	acquisitions: Map<string, SessionAcquisition>;
	/**
	 * Unified pending-prompt registry: promptId → PendingPrompt.
	 * Covers host-key verify, agent-verify, and passphrase prompts.
	 * Each entry carries ownerAcqId for cleanup by owner identity (invariant 5).
	 */
	pendingPrompts: Map<string, PendingPrompt>;
	// ── PromptContext routing layer ───────────────────────────────────────────
	/**
	 * contextId → PromptContext.
	 * The new routing model: each connect/test/elevation flow owns one context.
	 *
	 * Required — initialized in SessionManager constructor.
	 */
	promptContexts: Map<string, PromptContext>;
	/**
	 * elevation PromptContext id → owning session/channel operation.
	 * Used by closeSession()/destroyChannel() to cancel pending elevation prompts
	 * without clearing independent test-connect contexts for the same host.
	 */
	elevationPromptOwners?: Map<string, ElevationPromptOwner>;
	/**
	 * promptId → contextId reverse index for O(1) response routing.
	 * Populated by prompt(), cleared by respond() / clearContext().
	 *
	 * Required — initialized in SessionManager constructor.
	 */
	promptIndex: Map<string, string>;
}
