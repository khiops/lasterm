/**
 * SessionManager — coordinator for hub session management.
 *
 * Owns all runtime state (sessions, channels, agents, clients maps) via a
 * SharedSessionContext and delegates work to four focused sub-managers:
 *
 *   StateBroadcaster        — WS state sync, title management, rate-limiting
 *   ChannelLifecycleManager — spawn, restart, destroy, respawn, spool
 *   SshConnectionManager    — auth prompts, host-key verify, reconnect, test-connect
 *   AgentConnectionManager  — agent wiring, daemon attach, warm restart, startup
 *
 * The public API of SessionManager is unchanged — all callers (ws-handler, REST routes)
 * continue to talk to SessionManager exclusively.
 */

import type {
	AgentAttachMessage,
	AgentAttachOkMessage,
	AgentConfig,
	AgentSpawnMessage,
	AgentSyncedMessage,
	ElevationMethod,
	ErrorMessage,
	Host,
	InputMessage,
	ProtocolMessage,
	ResizeMessage,
	StateSyncMessage,
	TestConnectMessage,
	UiAttachOkMessage,
	UiSpawnMessage,
} from "@termora/shared";
import { DEFAULT_AGENT_CONFIG, generateId, validateCustomCommand } from "@termora/shared";
import type { ConfigResolver, GcConfig } from "../config.js";
import type { HubLogger } from "../logging/hub-logger.js";
import type { LoggerRegistry } from "../logging/index.js";
import type { DatabaseManager } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { SpoolDAL } from "../storage/spool.js";
import { AgentConnectionManager } from "./agent-connection-manager.js";
import { DeployError, getBinaryCacheDir } from "./agent-deployer.js";
import { stopLocalAgent } from "./agent-launcher.js";
import { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import { OutputChunker } from "./output-chunker.js";
import {
	clearContext,
	clearElevationContextsForSession,
	openContext,
	clientDisconnect as promptClientDisconnect,
	prompt as promptCtx,
	reconnectContextId,
	trackElevationContext,
} from "./prompt-context.js";
import {
	assertQuitFence,
	captureQuitFence,
	HubQuittingError,
	type QuitFence,
} from "./quit-fence.js";
import * as Acq from "./session-acquisition.js";
import type {
	Lease,
	SessionAcquisition,
	SessionMetaDAL,
	SharedSessionContext,
} from "./session-context.js";
import { SnapshotScheduler } from "./snapshot-scheduler.js";
import { SpoolGarbageCollector } from "./spool-gc.js";
import type { SshAgentDeployOptions } from "./ssh-agent.js";
import { SshAgent } from "./ssh-agent.js";
import { SshConnectionManager } from "./ssh-connection-manager.js";
import { StateBroadcaster } from "./state-broadcaster.js";

export interface WsClient {
	id: string;
	send: (msg: ProtocolMessage) => void;
	attachedChannels: Set<string>;
}

const ATTACH_TIMEOUT_MS = 5_000;
const AGENT_CLOSE_TIMEOUT_MS = 2_000;

function isAgentChannelNotFoundError(err: unknown, channelId: string): err is ErrorMessage {
	if (typeof err !== "object" || err === null) return false;
	const maybeErr = err as Partial<ErrorMessage>;
	if (maybeErr.type !== "ERROR") return false;
	if (maybeErr.channelId !== undefined && maybeErr.channelId !== channelId) return false;
	if (maybeErr.code === "CHANNEL_NOT_FOUND") return true;
	return typeof maybeErr.message === "string" && /channel .*not found/i.test(maybeErr.message);
}

export class SessionManager {
	// ─── Shared runtime state ─────────────────────────────────────────────────
	private readonly ctx: SharedSessionContext;
	/** Full DAL facade stays private; shared and public paths cannot create sessions unfenced. */
	private readonly metaDal: MetaDAL;

	// ─── Sub-managers ─────────────────────────────────────────────────────────
	private readonly broadcaster: StateBroadcaster;
	private readonly lifecycle: ChannelLifecycleManager;
	private readonly sshMgr: SshConnectionManager;
	private readonly agentMgr: AgentConnectionManager;

	// ─── Spool GC (owned by coordinator) ─────────────────────────────────────
	private readonly gc: SpoolGarbageCollector;

	constructor(
		dbManager: DatabaseManager,
		gcConfig?: GcConfig,
		agentConfig?: AgentConfig,
		configResolver?: ConfigResolver,
		hubLogger?: HubLogger,
		loggerRegistry?: LoggerRegistry,
		_logsDir?: string,
	) {
		const metaDal = new MetaDAL(dbManager.meta);
		this.metaDal = metaDal;
		const spoolDal = new SpoolDAL(dbManager.spool);
		const resolvedAgentConfig: AgentConfig = agentConfig ?? { ...DEFAULT_AGENT_CONFIG };

		const scheduler = new SnapshotScheduler((channelId) => {
			const ch = ctx.channels.get(channelId);
			return ch ? ctx.agents.get(ch.hostId) : undefined;
		});
		const chunker = new OutputChunker(spoolDal);

		const agents = new Map<string, import("./agent-connection.js").AgentConnection>();
		const sessions = new Map<string, import("./session-context.js").SessionState>();

		// Build the shared context — all sub-managers share these Maps
		const ctx: SharedSessionContext = {
			quitState: "RUNNING",
			quitEpoch: 0,
			agents,
			sessions,
			commits: {
				adoptAgent(fence, hostId, agent) {
					assertQuitFence(ctx, fence);
					agents.set(hostId, agent);
				},
				persistSession(fence, hostId, state) {
					assertQuitFence(ctx, fence);
					sessions.set(hostId, state);
				},
				createSession(fence, input) {
					assertQuitFence(ctx, fence);
					metaDal.createSession(input);
				},
			},
			channels: new Map(),
			clients: new Map(),
			reconnectTimers: new Map(),
			reconnectAbortControllers: new Map(),
			restartTracking: new Map(),
			pendingRequests: new Map(),
			trustedOnceFingerprints: new Map(),
			trustedAgentSha256: new Map(),
			bellTimestamps: new Map(),
			notificationTimestamps: new Map(),
			elevationCache: new Map(),
			passphraseCache: new Map(),
			agentCapabilities: new Map(),
			titleDebounceTimers: new Map(),
			processTitleDebounceTimers: new Map(),
			// P1/P2/P3 state machine — replaces acquiringSessions + sessionWaiters
			acquisitions: new Map(),
			pendingPrompts: new Map(),
			// PromptContext routing layer — required, initialized here.
			promptContexts: new Map(),
			elevationPromptOwners: new Map(),
			promptIndex: new Map(),
			getWriteLockHolder: null,
			metaDal,
			spoolDal,
			scheduler,
			chunker,
			agentConfig: resolvedAgentConfig,
			configResolver: configResolver ?? null,
			loggerRegistry: loggerRegistry ?? null,
			hubLogger: hubLogger ?? null,
			primaryToken: null,
		};
		this.ctx = ctx;

		this.broadcaster = new StateBroadcaster(ctx);
		this.lifecycle = new ChannelLifecycleManager(ctx, this.broadcaster);
		this.agentMgr = new AgentConnectionManager(ctx, this.broadcaster, this.lifecycle);
		this.sshMgr = new SshConnectionManager(ctx, this.broadcaster, this.lifecycle, this.agentMgr);
		// Break the circular reference: AgentConnectionManager needs SshConnectionManager
		this.agentMgr.sshMgr = this.sshMgr;

		// Wire reconnect callback for restartChannel on SSH hosts
		this.lifecycle.onReconnectAgent = async (hostId: string): Promise<boolean> => {
			const reconnectFence = captureQuitFence(ctx);
			const host = ctx.metaDal.getHost(hostId);
			if (host?.type !== "ssh") return false;

			// Snapshot the session entry BEFORE any await so we can currency-check it
			// after start() returns (mirrors the invariant-10 guard in scheduleReconnect).
			const sessionBefore = ctx.sessions.get(hostId);
			if (!sessionBefore) return false;
			const sessionId = sessionBefore.id;

			// Need a WS client to construct prompt/deploy callbacks. The reconnect
			// PromptContext routes by live ctx.clients at prompt time, not this captured client.
			const firstClientId = [...ctx.clients.keys()].sort()[0];
			const firstClient = firstClientId ? ctx.clients.get(firstClientId) : undefined;
			if (!firstClient) return false;
			const reconnectCtxId = reconnectContextId(sessionId);
			const sendPromptCancel = (routeClientId: string, msg: Record<string, unknown>) => {
				ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
			};

			// Mirror scheduleReconnect's abort model: create an AbortController and
			// register it so closeSession() (which aborts reconnectAbortControllers) can
			// cancel an in-flight passphrase/TOFU prompt or SSH handshake, preventing a
			// stale prompt from caching a secret for an already-closed session.
			// Identity-guarded on settle so a concurrent newer attempt is not clobbered.
			//
			// Abort-before-overwrite: if scheduleReconnect already registered a controller
			// for this host, abort it before overwriting — so its pending auth prompt is
			// cleared at handoff time rather than left orphaned in PromptContext state.
			const existingAcOnReconnect = ctx.reconnectAbortControllers.get(hostId);
			if (existingAcOnReconnect) existingAcOnReconnect.abort();
			const ac = new AbortController();
			ctx.reconnectAbortControllers.set(hostId, ac);

			try {
				const promptAuth = this.sshMgr.buildPromptAuth(firstClient, ac.signal, reconnectCtxId);
				const deployOpts = this._buildDeployOpts(hostId, host, firstClient, reconnectCtxId);
				const sshAgent = new SshAgent(host, promptAuth, deployOpts, ctx.agentConfig);

				const storedFp = ctx.metaDal.getHostFingerprint(hostId);
				const sshHostname = host.sshHost?.includes("@")
					? (host.sshHost.split("@")[1] ?? host.sshHost)
					: (host.sshHost ?? host.label);
				const sshPort = host.sshPort ?? 22;
				const hostKey = `${sshHostname}:${sshPort}`;
				const sessionTrustedFp = ctx.trustedOnceFingerprints.get(hostKey);

				await sshAgent.start(storedFp, sessionTrustedFp, ac.signal);

				// Post-await currency re-check (mirrors scheduleReconnect invariant 10):
				// closeSession() may have deleted the session entry while start() was
				// awaiting the SSH handshake. If the session is gone or was replaced
				// (different id), close the fresh agent and bail — do NOT wire/store/revive.
				if (
					ac.signal.aborted ||
					ctx.reconnectAbortControllers.get(hostId) !== ac ||
					ctx.sessions.get(hostId)?.id !== sessionId
				) {
					sshAgent.close();
					return false;
				}

				// Clear the controller — attempt settled successfully.
				ctx.reconnectAbortControllers.delete(hostId);

				this.broadcaster.updateSessionStatus(hostId, sessionId, "active");
				this.agentMgr.wireAgentEvents(hostId, sessionId, sshAgent);
				ctx.commits.adoptAgent(reconnectFence, hostId, sshAgent);
				return true;
			} catch {
				// Clear the controller on failure (identity-guarded so a newer concurrent
				// attempt is not clobbered).
				if (ctx.reconnectAbortControllers.get(hostId) === ac) {
					ctx.reconnectAbortControllers.delete(hostId);
				}
				return false;
			} finally {
				clearContext(ctx, reconnectCtxId, sendPromptCancel);
			}
		};

		this.gc = new SpoolGarbageCollector(spoolDal, metaDal, gcConfig);
		this.gc.start();
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	setGetWriteLockHolder(fn: (channelId: string) => string | null): void {
		this.ctx.getWriteLockHolder = fn;
	}

	async ensureLocalHost(): Promise<string> {
		return this.agentMgr.ensureLocalHost();
	}

	async startup(): Promise<void> {
		return this.agentMgr.startup();
	}

	/**
	 * Atomically latch this hub against revival, then abort work which was already
	 * acquiring a session or reconnecting. The latch is deliberately owned by the
	 * hub/session supervisor, never by the agent it is about to stop.
	 */
	beginQuit(): void {
		if (this.ctx.quitState === "QUITTING") return;
		this.ctx.quitState = "QUITTING";
		this.ctx.quitEpoch++;
		Acq.shutdownAll(this.ctx);
		for (const timer of this.ctx.reconnectTimers.values()) clearTimeout(timer);
		this.ctx.reconnectTimers.clear();
		for (const controller of this.ctx.reconnectAbortControllers.values()) controller.abort();
		this.ctx.reconnectAbortControllers.clear();
	}

	async stopLocalAgent(): Promise<import("./agent-launcher.js").AgentStopResult> {
		return stopLocalAgent(this.ctx.agentConfig.socketPath);
	}

	isQuitting(): boolean {
		return this.ctx.quitState === "QUITTING";
	}

	async shutdown(): Promise<void> {
		// Abort all in-flight acquisitions before awaiting agent close so no
		// connect/start continuation can outlive a slow agent teardown.
		Acq.shutdownAll(this.ctx);
		for (const timer of this.ctx.reconnectTimers.values()) clearTimeout(timer);
		this.ctx.reconnectTimers.clear();
		for (const ac of this.ctx.reconnectAbortControllers.values()) ac.abort();
		this.ctx.reconnectAbortControllers.clear();
		for (const timer of this.ctx.titleDebounceTimers.values()) clearTimeout(timer);
		this.ctx.titleDebounceTimers.clear();
		for (const timer of this.ctx.processTitleDebounceTimers.values()) clearTimeout(timer);
		this.ctx.processTitleDebounceTimers.clear();
		for (const contextId of [...this.ctx.promptContexts.keys()]) {
			clearContext(this.ctx, contextId);
		}
		// Defensive sweep for any malformed pending prompt that is missing its context.
		for (const [, p] of this.ctx.pendingPrompts) {
			if (p.timer !== null) clearTimeout(p.timer);
			p.resolve(null);
		}
		this.ctx.pendingPrompts.clear();
		this.ctx.elevationCache.clear();
		this.ctx.agentCapabilities.clear();
		this.ctx.scheduler.shutdown();
		this.ctx.chunker.shutdown();
		this.gc.stop();
		const agentCloseResults = await Promise.allSettled(
			[...this.ctx.agents.values()].map((agent) => closeAgentWithTimeout(agent)),
		);
		for (const result of agentCloseResults) {
			if (result.status === "rejected") {
				this.ctx.hubLogger?.log("warn", "agent close failed during shutdown", {
					err: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
		}
		this.ctx.agents.clear();
		this.ctx.clients.clear();
		this.ctx.channels.clear();
		this.ctx.sessions.clear();
	}

	// ─── DAL accessors ────────────────────────────────────────────────────────

	setPrimaryToken(token: string): void {
		this.ctx.primaryToken = token;
	}

	getMetaDal(): SessionMetaDAL {
		return this.metaDal;
	}

	getSpoolDal(): SpoolDAL {
		return this.ctx.spoolDal;
	}

	// ─── Client registry ──────────────────────────────────────────────────────

	addClient(client: WsClient): void {
		this.broadcaster.addClient(client);
	}

	removeClient(clientId: string): void {
		promptClientDisconnect(this.ctx, clientId, (newClientId, msg) => {
			const newClient = this.ctx.clients.get(newClientId);
			newClient?.send(msg as unknown as ProtocolMessage);
		});

		// broadcaster.removeClient runs LAST — after all retargeting — so that
		// ctx.clients still contains the departing client while PromptContext ops
		// send PROMPT_CANCEL and retarget prompts.
		this.broadcaster.removeClient(clientId);
	}

	getOthersCount(callerClientId?: string): number {
		let others = 0;
		for (const [clientId, client] of [...this.ctx.clients.entries()]) {
			if (!client || typeof client.send !== "function") {
				this.ctx.clients.delete(clientId);
				continue;
			}
			if (clientId !== callerClientId) others++;
		}
		return others;
	}

	getClientsForChannel(channelId: string): WsClient[] {
		return this.broadcaster.getClientsForChannel(channelId);
	}

	// ─── State broadcast ──────────────────────────────────────────────────────

	getStateSnapshot(): StateSyncMessage {
		return this.broadcaster.getStateSnapshot();
	}

	broadcastToAllClients(msg: ProtocolMessage): void {
		this.broadcaster.broadcastToAllClients(msg);
	}

	notifyChannelRenamed(channelId: string): void {
		this.broadcaster.notifyChannelRenamed(channelId);
	}

	broadcastDisplayTitles(): void {
		this.broadcaster.broadcastDisplayTitles();
	}

	resolveDisplayTitle(channelId: string): string {
		return this.broadcaster.resolveDisplayTitle(channelId);
	}

	// ─── Channel operations ───────────────────────────────────────────────────

	destroyChannel(channelId: string): boolean {
		return this.lifecycle.destroyChannel(channelId);
	}

	async restartChannel(channelId: string, requestingClientId?: string): Promise<boolean> {
		if (this.isQuitting()) return false;
		return this.lifecycle.restartChannel(channelId, requestingClientId);
	}

	async closeSession(sessionId: string): Promise<void> {
		let hostId: string | undefined;
		for (const [hId, state] of this.ctx.sessions.entries()) {
			if (state.id === sessionId) {
				hostId = hId;
				break;
			}
		}

		if (!hostId) {
			this.ctx.metaDal.updateSessionStatus(sessionId, "closed");
			return;
		}

		const agent = this.ctx.agents.get(hostId);
		if (agent) {
			agent.close();
			this.ctx.agents.delete(hostId);
		}

		// P1: Abort in-flight acquisition synchronously via state-machine primitive.
		// close() sets CLOSING before abort — joins are refused from that moment.
		// Does NOT consume leases; waiters' outer finally still calls release() harmlessly.
		// Returns the closed acq so we can clear its prompts by ownerAcqId (invariant 5).
		const closedAcq = Acq.close(this.ctx, hostId);

		const clearSend = (routeClientId: string, msg: Record<string, unknown>) => {
			this.ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
		};

		// Acquisition-owned prompts are cleared by the acquisition id. Reconnect
		// prompts are owned by the live session id and cleared separately.
		if (closedAcq) {
			clearContext(this.ctx, closedAcq.id, clearSend);
		}
		clearContext(this.ctx, reconnectContextId(sessionId), clearSend);
		clearElevationContextsForSession(this.ctx, sessionId, clearSend);

		this.lifecycle.closeSession(hostId, sessionId);
	}

	// ─── WS message handlers ──────────────────────────────────────────────────

	/** Build SshAgentDeployOptions for a given host + WS client. */
	private _buildDeployOpts(
		hostId: string,
		host: Host,
		client: WsClient,
		ownerAcqId?: string,
	): SshAgentDeployOptions {
		const sshHostname = host.sshHost?.includes("@")
			? (host.sshHost.split("@")[1] ?? host.sshHost)
			: (host.sshHost ?? host.label);
		const binaryCache = getBinaryCacheDir();
		const pinnedSha256 = this.ctx.metaDal.getHostAgentSha256(hostId);
		const sessionTrustedAgentSha = this.ctx.trustedAgentSha256.get(hostId);
		return {
			binaryCache,
			hostname: sshHostname,
			...(pinnedSha256 != null ? { pinnedSha256 } : {}),
			...(sessionTrustedAgentSha != null ? { sessionTrustedSha256: sessionTrustedAgentSha } : {}),
			onOsDetected: (hid, os, arch) => {
				this.ctx.metaDal.updateHostOsArch(hid, os, arch);
			},
			promptBinaryVerify: this.sshMgr.buildBinaryVerifyPrompt(client, ownerAcqId),
			onAgentPinned: (hid, sha256) => {
				this.ctx.metaDal.updateHostAgentSha256(hid, sha256);
			},
			onAgentTrustOnce: (hid, sha256) => {
				this.ctx.trustedAgentSha256.set(hid, sha256);
			},
			onAgentUpdated: (hid) => {
				this.ctx.hubLogger?.log(
					"info",
					"session-manager: remote agent re-uploaded after SHA256 mismatch",
					{ hostId: hid, hostname: sshHostname },
				);
				this.broadcaster.broadcastToAllClients({
					type: "AGENT_SYNCED",
					hostId: hid,
					hostname: sshHostname,
					message: `Agent on ${sshHostname} updated to the current version`,
				} satisfies AgentSyncedMessage);
			},
		};
	}

	private failConnectingAcq(
		acq: SessionAcquisition,
		err: unknown,
		lease?: Lease | null,
		hasChannels: () => boolean = () => false,
	): void {
		const error = err instanceof Error ? err : new Error(String(err));
		Acq.fail(this.ctx, acq, error);
		const clearSend = (routeClientId: string, msg: Record<string, unknown>) => {
			this.ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
		};
		clearContext(this.ctx, acq.id, clearSend);
		if (lease !== null && lease !== undefined && !lease.released) {
			Acq.release(this.ctx, lease, hasChannels);
		}
	}

	async handleSpawn(clientId: string, msg: UiSpawnMessage): Promise<string | null> {
		this.ctx.hubLogger?.log("debug", "handleSpawn: start", { clientId, hostId: msg.hostId });
		const client = this.ctx.clients.get(clientId);
		if (!client) {
			this.ctx.hubLogger?.log("debug", "handleSpawn: client not found", { clientId });
			return null;
		}
		let spawnFence: QuitFence;
		try {
			spawnFence = captureQuitFence(this.ctx);
		} catch (err) {
			if (!(err instanceof HubQuittingError)) throw err;
			client.send({
				type: "ERROR",
				code: "HUB_QUITTING",
				message: "Hub is quitting; local work cannot be started or restarted",
			} satisfies ErrorMessage);
			return null;
		}

		const hostId = await this.agentMgr.resolveHostId(msg.hostId);
		this.ctx.hubLogger?.log("debug", "handleSpawn: resolvedHostId", { hostId });
		const host = this.ctx.metaDal.getHost(hostId);
		if (!host) {
			this.ctx.hubLogger?.log("warn", "handleSpawn: host not found", { hostId });
			const errorMsg: ErrorMessage = {
				type: "ERROR",
				code: "HOST_NOT_FOUND",
				message: `Host ${hostId} not found`,
			};
			client.send(errorMsg);
			return null;
		}

		this.ctx.hubLogger?.log("debug", "handleSpawn: host found", {
			hostId,
			type: host.type,
			label: host.label,
		});

		let agent = this.ctx.agents.get(hostId);
		this.ctx.hubLogger?.log("debug", "handleSpawn: existing agent", {
			connected: agent?.connected ?? false,
		});

		// ── Acquire or join the session-acquisition state machine ─────────────────
		// For SSH hosts with no live agent: coalesce via the acquisition map.
		// P1: the slot is claimed SYNCHRONOUSLY (no await between the map check and
		//     the map.set) so two concurrent SPAWNs cannot both see empty and each
		//     create their own "starting" session.
		// biome-ignore lint/style/noNonNullAssertion: assigned before use on all non-null-returning paths
		let session: import("./session-context.js").SessionState = undefined!;
		// lease is held until the outer finally runs — invariant 2.
		let lease: Lease | null = null;
		// acq reference kept for identity re-validation after awaits — invariant 7.
		let acq: SessionAcquisition | null = null;

		// ── Single outer try/finally — release the lease on EVERY exit path ─────────
		// Invariant 2: the try wraps the entire acquisition + spawn body so all early
		// returns (follower error, leader error, session-currency checks, guard fails)
		// pass through the finally.  release() is idempotent (invariant 6), so
		// pre-commit failure paths can release early and the outer finally will no-op.
		// Invariant 3: release checks leases.size===0 && no channels → reap if needed.
		try {
			// B1: outer try wraps all paths that hold a lease (B1 fix — every early return hits this finally)
			if (!agent?.connected && host.type === "ssh") {
				// ── SSH: no live agent — use acquisition state machine ────────────────
				const existing = this.ctx.acquisitions.get(hostId);

				if (existing !== undefined) {
					// ── Follower: join the in-flight acquisition ───────────────────────
					// P1: join() is synchronous; returns null if CLOSING/FAILED (invariant 9).
					const joined = Acq.join(existing, clientId);
					if (joined !== null) {
						// Follower successfully joined — hold the lease.
						lease = joined;
						acq = existing;
						this.ctx.hubLogger?.log("debug", "handleSpawn: follower joining in-flight acquire", {
							hostId,
							acqId: acq.id,
						});
						try {
							session = await acq.connectPromise;
						} catch (err) {
							// Leader reported failure — relay to this client too.
							client.send({
								type: "ERROR",
								code: "SSH_CONNECT_FAILED",
								message: err instanceof Error ? err.message : "SSH connection failed",
							} satisfies ErrorMessage);
							return null;
						}
						// Re-validate: session must still be current after the await (invariant 7).
						const curAfterFollow = this.ctx.sessions.get(hostId);
						if (!curAfterFollow || curAfterFollow.id !== session.id) {
							client.send({
								type: "ERROR",
								code: "SSH_CONNECT_FAILED",
								message: "SSH session was closed during connect",
							} satisfies ErrorMessage);
							return null;
						}
						agent = this.ctx.agents.get(hostId);
						if (!agent?.connected) {
							client.send({
								type: "ERROR",
								code: "SSH_CONNECT_FAILED",
								message: "SSH connection failed",
							} satisfies ErrorMessage);
							return null;
						}
						// Fall through to the spawn section with lease held.
					}
				}

				// Leader branch: either no existing acq, or follower join was refused (terminal acq).
				if (lease === null) {
					// P1: acquire() sets ctx.acquisitions[hostId] = acq SYNCHRONOUSLY, before any
					// await — this is the critical section that prevents double-session creation.
					const acquired = Acq.acquire(this.ctx, hostId, clientId);
					acq = acquired.acq;
					lease = acquired.lease;

					this.ctx.hubLogger?.log("debug", "handleSpawn: leader acquiring SSH session", {
						hostId,
						acqId: acq.id,
					});

					const connectingAcq = acq; // capture for identity checks below
					const releaseConnectingLease = () =>
						[...this.ctx.channels.values()].some(
							(ch) => session != null && ch.sessionId === session.id,
						);
					try {
						// getOrCreateSession is async; the session object is created here.
						const sessionState = await this.agentMgr.getOrCreateSession(hostId, true, spawnFence);
						// B4 fix: _connectSshAgent returns the wired agent WITHOUT setting
						// ctx.agents — we set it here, atomically with commit(), so no
						// concurrent SPAWN can observe "agent live + acq live" simultaneously.
						let connectedAgent: import("./agent-connection.js").AgentConnection;
						try {
							connectedAgent = await this._connectSshAgent(
								hostId,
								host,
								client,
								sessionState.id,
								connectingAcq.controller.signal,
								connectingAcq.id, // B3: ownerAcqId for prompt identity tracking
							);
						} catch (err) {
							// On connect failure: remove the session if it was freshly started.
							if (sessionState.status === "starting") {
								this.broadcaster.updateSessionStatus(hostId, sessionState.id, "closed");
								this.ctx.sessions.delete(hostId);
							}
							this.failConnectingAcq(
								connectingAcq,
								err instanceof Error ? err : new Error("SSH connection failed"),
								lease,
								releaseConnectingLease,
							);
							return null;
						}

						// Connect succeeded — commit: P1 synchronous guarded step (invariant 7).
						// Guard: map identity + state + signal + session currency.
						// B4 fix: ctx.agents.set is done HERE, inside the guard, atomically with
						// commit() — no microtask gap between "agent visible" and "acq deleted".
						if (
							this.ctx.acquisitions.get(hostId) === connectingAcq &&
							connectingAcq.state === "CONNECTING" &&
							!connectingAcq.controller.signal.aborted &&
							this.ctx.sessions.get(hostId)?.id === sessionState.id
						) {
							// P2: set agent + commit atomically — agent becomes visible only when
							// the acq is simultaneously deleted (no dual-authority window).
							this.ctx.commits.adoptAgent(spawnFence, hostId, connectedAgent);
							Acq.commit(this.ctx, connectingAcq, sessionState);
							clearContext(this.ctx, connectingAcq.id);
							agent = connectedAgent;
							session = sessionState;
						} else {
							// Guard failed — session aborted/replaced during connect (invariant 7).
							// connectedAgent was wired but the acq is stale — close it.
							connectedAgent.close();
							const curSession = this.ctx.sessions.get(hostId);
							if (curSession?.id === sessionState.id) {
								this.ctx.sessions.delete(hostId);
							}
							this.failConnectingAcq(
								connectingAcq,
								new Error("SSH connect aborted"),
								lease,
								releaseConnectingLease,
							);
							client.send({
								type: "ERROR",
								code: "SSH_CONNECT_FAILED",
								message: "SSH session was closed during connect",
							} satisfies ErrorMessage);
							return null;
						}
					} catch (err) {
						this.failConnectingAcq(connectingAcq, err, lease, releaseConnectingLease);
						return null;
					}

					// Re-validate after leader's own await (invariant 7 belt-and-suspenders).
					const curAfterLead = this.ctx.sessions.get(hostId);
					if (!curAfterLead || curAfterLead.id !== session.id) {
						client.send({
							type: "ERROR",
							code: "SSH_CONNECT_FAILED",
							message: "SSH session was closed during connect",
						} satisfies ErrorMessage);
						return null;
					}
					if (!agent?.connected) {
						client.send({
							type: "ERROR",
							code: "SSH_CONNECT_FAILED",
							message: "SSH connection failed",
						} satisfies ErrorMessage);
						return null;
					}
				}
			} else {
				// ── Non-SSH or SSH with live agent — fast path ────────────────────────
				try {
					session = await this.agentMgr.getOrCreateSession(hostId, host.type === "ssh", spawnFence);
				} catch (err) {
					if (err instanceof HubQuittingError) {
						client.send({
							type: "ERROR",
							code: err.code,
							message: err.message,
						} satisfies ErrorMessage);
						return null;
					}
					throw err;
				}
			}

			// ── Post-acquisition spawn body ───────────────────────────────────────────
			{
				// ── Client-disconnect guard ───────────────────────────────────────────────
				if (!this.ctx.clients.has(clientId)) {
					const sessionHasChannels = [...this.ctx.channels.values()].some(
						(ch) => ch.sessionId === session.id,
					);
					if (lease !== null && !lease.released) {
						// SSH path: attempt reap via the lease. If the acq was already committed
						// (P2 — deleted from map), release() returns false; Fix A guarantees it
						// STILL removes this lease from acq.leases so the size is accurate.
						const reaped = Acq.release(this.ctx, lease, () => sessionHasChannels);
						lease = null; // outer finally will no-op
						if (reaped) {
							// Reap fired (abort signal set) — the abort listener in _connectSshAgent
							// will close the agent when it observes the signal. No extra close needed.
							return null;
						}
						// release() returned false: acq was committed (P2, not in map). Fix A:
						// release() already removed this lease from acq.leases, so acq.leases.size
						// now reflects only the remaining in-flight followers.  If size > 0, at
						// least one follower is still holding its lease — do not close the session.
						if (acq !== null && acq.leases.size > 0) {
							// Followers in-flight — do NOT close the session under them.
							return null;
						}
					}
					// Sole-requester close: acq was committed (agent wired) but the requesting
					// client is gone and no channels/followers exist — close the agent + session.
					if (!sessionHasChannels && this.ctx.sessions.get(hostId)?.id === session.id) {
						const agentToClose = this.ctx.agents.get(hostId);
						if (agentToClose) {
							agentToClose.close();
							this.ctx.agents.delete(hostId);
						}
						this.broadcaster.updateSessionStatus(hostId, session.id, "closed");
						this.ctx.sessions.delete(hostId);
					}
					return null;
				}

				this.ctx.hubLogger?.log("debug", "handleSpawn: session", {
					sessionId: session.id,
					status: session.status,
				});

				if (!agent?.connected) {
					if (host.type !== "ssh") {
						this.ctx.hubLogger?.log(
							"debug",
							"handleSpawn: local host — connecting to daemon agent",
							{
								hostId,
							},
						);
						try {
							agent = await this.agentMgr.connectDaemonAgent(hostId, session.id);
						} catch (err) {
							if (err instanceof HubQuittingError) {
								client.send({
									type: "ERROR",
									code: err.code,
									message: err.message,
								} satisfies ErrorMessage);
								return null;
							}
							throw err;
						}
						this.ctx.hubLogger?.log("debug", "handleSpawn: daemon agent connected", { hostId });
					}
				}

				// biome-ignore lint/style/noNonNullAssertion: invariant — all failure paths returned null above
				const readyAgent = agent!;

				this.ctx.hubLogger?.log("debug", "handleSpawn: agent ready, building SPAWN message", {
					hostId,
				});
				const requestId = generateId();
				const cols = msg.cols ?? 80;
				const rows = msg.rows ?? 24;

				// ── Launch profile resolution ─────────────────────────────────────────
				let resolvedShell = msg.shell ?? undefined;
				let resolvedArgs = msg.args ?? [];
				let resolvedCwd = msg.cwd ?? undefined;
				let resolvedEnv: Record<string, string> = msg.env ?? {};
				let resolvedDirectProcess = msg.directProcess ?? false;
				let resolvedElevated = msg.elevated ?? false;
				let resolvedLaunchProfileId: string | undefined;

				if (msg.launchProfileId) {
					const profile = this.ctx.metaDal.getLaunchProfile(msg.launchProfileId);
					if (profile) {
						resolvedShell = msg.shell ?? profile.shell;
						resolvedArgs = msg.args ?? profile.args ?? [];
						resolvedCwd = msg.cwd ?? profile.cwd ?? resolvedCwd;
						resolvedEnv = { ...(profile.env ?? {}), ...(msg.env ?? {}) };
						resolvedDirectProcess = msg.directProcess ?? profile.mode === "process";
						resolvedElevated = msg.elevated ?? profile.elevated;
						resolvedLaunchProfileId = profile.id;
					}
				}

				// ── First-profile fallback ────────────────────────────────────────────
				if (resolvedShell === undefined) {
					const firstProfile =
						host.type === "ssh"
							? this.ctx.metaDal.listHostProfiles(hostId, host.os ?? "linux")[0]
							: this.ctx.metaDal.listLaunchProfiles(1)[0];
					if (firstProfile !== undefined) {
						resolvedShell = firstProfile.shell;
						if (resolvedArgs.length === 0 && firstProfile.args) {
							resolvedArgs = firstProfile.args;
						}
						if (Object.keys(resolvedEnv).length === 0 && firstProfile.env) {
							resolvedEnv = { ...firstProfile.env };
						}
					}
				}

				// ── Elevation checks ──────────────────────────────────────────────────
				if (resolvedElevated) {
					if (host.type === "ssh") {
						this.ctx.hubLogger?.log(
							"warn",
							"ERR-04: elevation not supported over SSH, spawning without elevation",
							{ hostId },
						);
						resolvedElevated = false;
					}
				}

				if (resolvedElevated) {
					const caps = this.ctx.agentCapabilities.get(hostId) ?? [];
					if (!caps.includes("launch-profiles")) {
						this.ctx.hubLogger?.log(
							"warn",
							"ERR-05: agent does not advertise launch-profiles capability, spawning without elevation",
							{ hostId },
						);
						resolvedElevated = false;
					}
				}

				const terminalProfile = this.ctx.configResolver
					? this.ctx.configResolver.resolve(hostId)
					: null;
				const resolvedEnvMode = terminalProfile?.envMode ?? "inherit";

				const baseSpawnMsg: AgentSpawnMessage = {
					type: "SPAWN",
					requestId,
					...(resolvedShell !== undefined ? { shell: resolvedShell } : {}),
					...(resolvedArgs.length > 0 && { args: resolvedArgs }),
					...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
					env: resolvedEnv,
					cols,
					rows,
					...(resolvedDirectProcess && { directProcess: true }),
					envMode: resolvedEnvMode,
				};

				// ── Elevated spawn ────────────────────────────────────────────────────
				if (resolvedElevated) {
					const rawMethod = this.ctx.configResolver
						? this.ctx.configResolver.resolveElevationMethod(host.elevationMethod)
						: process.platform === "win32"
							? "gsudo"
							: "sudo";
					const elevCfg = this._resolveElevationConfig(host.customCommand, rawMethod);
					if ("validationError" in elevCfg) {
						client.send(elevCfg.validationError);
						return null;
					}
					const { method, customCommand } = elevCfg;

					const agentSpawn: AgentSpawnMessage = {
						...baseSpawnMsg,
						elevated: true,
						elevationMethod: method,
						...(customCommand !== undefined && { customCommand }),
					};

					const cacheKey = `${hostId}:${clientId}`;
					const cached = this.ctx.elevationCache.get(cacheKey);
					if (cached && cached.expiresAt > Date.now()) {
						agentSpawn.elevationSecret = cached.secret;
						return (
							await this.lifecycle.sendSpawnAndWait({
								agent: readyAgent,
								spawnMsg: agentSpawn,
								clientId,
								hostId,
								session,
								client,
								resolvedShell,
								resolvedArgs,
								resolvedCwd,
								resolvedDirectProcess,
								resolvedLaunchProfileId,
								cols,
								rows,
								suppressClientError: false,
								resolvedElevated: true,
								resolvedElevationMethod: method,
							})
						).channelId;
					}

					const firstResult = await this.lifecycle.sendSpawnAndWait({
						agent: readyAgent,
						spawnMsg: agentSpawn,
						clientId,
						hostId,
						session,
						client,
						resolvedShell,
						resolvedArgs,
						resolvedCwd,
						resolvedDirectProcess,
						resolvedLaunchProfileId,
						cols,
						rows,
						suppressClientError: true,
						resolvedElevated: true,
						resolvedElevationMethod: method,
					});

					if (
						firstResult.channelId !== null ||
						firstResult.errCode !== "ELEVATION_PASSWORD_REQUIRED"
					) {
						return firstResult.channelId;
					}

					// ── Task 3: Elevation retry — "elevation" PromptContext (guard E) ────────
					// Open a dedicated elevation context owned by the spawn operation.
					// Route = the requesting client. Always cleared on every terminal path.
					const elevCtx = openContext(this.ctx, "elevation", hostId, clientId);
					const elevCtxId = elevCtx.id;
					trackElevationContext(this.ctx, elevCtxId, {
						hostId,
						sessionId: session.id,
						owner: "spawn",
						operationId: requestId,
					});
					const elevSend = (routeClientId: string, msg: Record<string, unknown>) => {
						const target = this.ctx.clients.get(routeClientId);
						if (!target) throw new Error("prompt route client disconnected");
						target.send(msg as unknown as import("@termora/shared").AuthPromptMessage);
					};
					const hostname = host.sshHost ?? host.label ?? hostId;
					const elevPayload: import("@termora/shared").AuthPromptMessage = {
						type: "AUTH_PROMPT",
						hostId,
						promptType: "elevation",
						message: `Enter password for elevated shell on ${hostname}`,
						promptId: "",
					};
					const elevPromise = promptCtx(
						this.ctx,
						elevCtxId,
						"elevation",
						elevPayload,
						elevSend,
						60_000,
					);
					let secret: string | null;
					if (elevPromise === null) {
						secret = null;
					} else {
						secret = (await elevPromise) as string | null;
					}
					// Guard E: always clear the elevation context.
					clearContext(this.ctx, elevCtxId, elevSend);
					if (secret === null) {
						client.send({
							type: "ERROR",
							code: "ELEVATION_CANCELLED",
							message: "Elevation cancelled by user",
						});
						return null;
					}

					this.ctx.elevationCache.set(cacheKey, {
						secret,
						expiresAt: Date.now() + 300_000,
					});

					const retrySpawn: AgentSpawnMessage = {
						...agentSpawn,
						requestId: generateId(),
						elevationSecret: secret,
					};
					return (
						await this.lifecycle.sendSpawnAndWait({
							agent: readyAgent,
							spawnMsg: retrySpawn,
							clientId,
							hostId,
							session,
							client,
							resolvedShell,
							resolvedArgs,
							resolvedCwd,
							resolvedDirectProcess,
							resolvedLaunchProfileId,
							cols,
							rows,
							suppressClientError: false,
							resolvedElevated: true,
							resolvedElevationMethod: method,
						})
					).channelId;
				}

				// ── Non-elevated spawn ─────────────────────────────────────────────────
				this.ctx.hubLogger?.log("debug", "handleSpawn: sending non-elevated SPAWN", {
					requestId: baseSpawnMsg.requestId,
					shell: baseSpawnMsg.shell,
				});
				const spawnResult = await this.lifecycle.sendSpawnAndWait({
					agent: readyAgent,
					spawnMsg: baseSpawnMsg,
					clientId,
					hostId,
					session,
					client,
					resolvedShell,
					resolvedArgs,
					resolvedCwd,
					resolvedDirectProcess,
					resolvedLaunchProfileId,
					cols,
					rows,
				});
				this.ctx.hubLogger?.log("debug", "handleSpawn: sendSpawnAndWait returned", {
					channelId: spawnResult.channelId,
					errCode: spawnResult.errCode,
				});
				return spawnResult.channelId;
			} // end inner bare block
		} finally {
			// ── Single outer finally — release lease exactly once ─────────────────
			// Invariant 2: covers ALL exit paths (success, failure, early return, throw).
			// release() is idempotent (invariant 6).
			// Invariant 3: triggers reap if leases.size===0 && no channels.
			if (lease !== null && !lease.released) {
				// `session` is unassigned on follower failure paths (e.g. acq.connectPromise
				// rejected before a session resolved). Guard the deref so the finally never
				// throws on `session.id` — that would mask the original error and skip release.
				Acq.release(this.ctx, lease, () =>
					[...this.ctx.channels.values()].some(
						(ch) => session != null && ch.sessionId === session.id,
					),
				);
			}
		}
	}

	async handleAttach(clientId: string, channelId: string): Promise<boolean> {
		const client = this.ctx.clients.get(clientId);
		if (!client) return false;
		if (this.isQuitting()) {
			client.send({
				type: "ERROR",
				code: "HUB_QUITTING",
				message: "Hub is quitting; channels cannot be revived",
			} satisfies ErrorMessage);
			return false;
		}

		const channel = this.ctx.channels.get(channelId);
		if (!channel) {
			const dbChannel = this.ctx.metaDal.getChannel(channelId);
			if (dbChannel?.status === "dead") {
				const respawned = await this.lifecycle.respawnDeadChannel(channelId, client, clientId);
				if (respawned) return true;
			}
			const code = dbChannel?.status === "dead" ? "CHANNEL_DEAD" : "CHANNEL_NOT_FOUND";
			const errorMsg: ErrorMessage = {
				type: "ERROR",
				code,
				message: `Channel ${channelId} ${code === "CHANNEL_DEAD" ? "is dead" : "not found"}`,
			};
			client.send(errorMsg);
			return false;
		}

		const wasOrphan = channel.status === "orphan";
		channel.clients.add(clientId);
		client.attachedChannels.add(channelId);

		if (wasOrphan) {
			this.broadcaster.updateChannelStatus(channelId, channel.sessionId, "live");
		}

		const agent = this.ctx.agents.get(channel.hostId);

		const dbChannelForTitle = this.ctx.metaDal.getChannel(channelId);
		const dynamicTitle = dbChannelForTitle?.dynamicTitle;
		const processTitle = dbChannelForTitle?.processTitle;

		if (dynamicTitle !== undefined && channel.dynamicTitle === null) {
			channel.dynamicTitle = dynamicTitle;
		}
		if (processTitle !== undefined && channel.processTitle === null) {
			channel.processTitle = processTitle;
		}

		const displayTitle = this.broadcaster.resolveDisplayTitle(channelId);

		if (!agent?.connected) {
			const { snapshot, tail } = this.lifecycle.buildAttachPayload(channelId);
			const attachOk: UiAttachOkMessage = {
				type: "ATTACH_OK",
				channelId,
				snapshot,
				tail,
				writeLockHolder: this.ctx.getWriteLockHolder?.(channelId) ?? null,
				cached: true,
				...(dynamicTitle !== undefined && { dynamicTitle }),
				...(processTitle !== undefined && { processTitle }),
				displayTitle,
			};
			client.send(attachOk);
			return true;
		}

		const agentAttach: AgentAttachMessage = { type: "ATTACH", channelId };
		agent.send(agentAttach);

		const pendingKey = `attach:${channelId}`;
		try {
			const agentResponse = await new Promise<AgentAttachOkMessage>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.ctx.pendingRequests.delete(pendingKey);
					reject(new Error("Agent ATTACH timeout"));
				}, ATTACH_TIMEOUT_MS);

				this.ctx.pendingRequests.set(pendingKey, (incoming: ProtocolMessage) => {
					if (incoming.type === "ATTACH_OK") {
						const attachOkMsg = incoming as AgentAttachOkMessage;
						clearTimeout(timer);
						this.ctx.pendingRequests.delete(pendingKey);
						resolve(attachOkMsg);
					} else if (incoming.type === "ERROR") {
						clearTimeout(timer);
						this.ctx.pendingRequests.delete(pendingKey);
						reject(incoming);
					}
				});
			});

			this.lifecycle.storeSnapshot(channelId, agentResponse.snapshot, agentResponse.lastSeq);

			const tailChunks = this.ctx.spoolDal.getChunksByChannel(channelId, {
				kind: "output",
				afterSeq: agentResponse.lastSeq,
			});
			const tail = tailChunks.map((c) => new Uint8Array(c.dataBlob));

			const attachOk: UiAttachOkMessage = {
				type: "ATTACH_OK",
				channelId,
				snapshot: agentResponse.snapshot,
				tail,
				writeLockHolder: this.ctx.getWriteLockHolder?.(channelId) ?? null,
				cached: false,
				...(dynamicTitle !== undefined && { dynamicTitle }),
				...(processTitle !== undefined && { processTitle }),
				displayTitle,
			};
			client.send(attachOk);
		} catch (err) {
			if (isAgentChannelNotFoundError(err, channelId)) {
				this.lifecycle.retireChannel(channelId, channel.sessionId);
				channel.clients.delete(clientId);
				client.attachedChannels.delete(channelId);
				client.send({
					type: "ERROR",
					code: "CHANNEL_DEAD",
					message: `Channel ${channelId} is no longer live on the agent`,
					channelId,
				} satisfies ErrorMessage);
				return false;
			}

			const { snapshot, tail } = this.lifecycle.buildAttachPayload(channelId);
			const attachOk: UiAttachOkMessage = {
				type: "ATTACH_OK",
				channelId,
				snapshot,
				tail,
				writeLockHolder: this.ctx.getWriteLockHolder?.(channelId) ?? null,
				cached: true,
				...(dynamicTitle !== undefined && { dynamicTitle }),
				...(processTitle !== undefined && { processTitle }),
				displayTitle,
			};
			client.send(attachOk);
		}
		return true;
	}

	handleDetach(clientId: string, channelId: string): void {
		this.broadcaster.detachClient(clientId, channelId);
	}

	handleInput(_clientId: string, channelId: string, data: Uint8Array): void {
		const channel = this.ctx.channels.get(channelId);
		if (!channel) return;
		const agent = this.ctx.agents.get(channel.hostId);
		if (!agent) return;
		const inputMsg: InputMessage = { type: "INPUT", channelId, data };
		agent.send(inputMsg);
	}

	handleResize(_clientId: string, channelId: string, cols: number, rows: number): void {
		const channel = this.ctx.channels.get(channelId);
		if (!channel) return;
		const agent = this.ctx.agents.get(channel.hostId);
		if (!agent) return;
		const resizeMsg: ResizeMessage = { type: "RESIZE", channelId, cols, rows };
		agent.send(resizeMsg);
		channel.cols = cols;
		channel.rows = rows;
		this.ctx.metaDal.updateChannelDimensions(channelId, cols, rows);
	}

	handleAuthPromptResponse(
		clientId: string,
		hostId: string,
		secret: string | null,
		rememberSession?: boolean,
		promptId?: string,
		deliveryEpoch?: number,
	): void {
		this.sshMgr.handleAuthPromptResponse(
			clientId,
			hostId,
			secret,
			rememberSession,
			promptId,
			deliveryEpoch,
		);
	}

	handleHostVerifyResponse(
		promptId: string,
		action: "trust_permanent" | "trust_once" | "reject",
		clientId: string,
	): void {
		this.sshMgr.handleHostVerifyResponse(promptId, action, clientId);
	}

	handleAgentVerifyResponse(
		promptId: string,
		action: "trust_permanent" | "trust_once" | "reject",
		clientId: string,
	): void {
		this.sshMgr.handleAgentVerifyResponse(promptId, action, clientId);
	}

	async handleTestConnect(clientId: string, msg: TestConnectMessage): Promise<void> {
		return this.sshMgr.handleTestConnect(clientId, msg);
	}

	// ─── Test-surface accessors (delegating to ctx / sub-managers) ───────────
	// Tests access internal state via type-casts like:
	//   (sm as unknown as { agents: Map<…> }).agents
	// These getters make those casts resolve correctly without changing behaviour.

	get agents(): SharedSessionContext["agents"] {
		return this.ctx.agents;
	}

	get sessions(): SharedSessionContext["sessions"] {
		return this.ctx.sessions;
	}

	get channels(): SharedSessionContext["channels"] {
		return this.ctx.channels;
	}

	get restartTracking(): SharedSessionContext["restartTracking"] {
		return this.ctx.restartTracking;
	}

	get pendingRequests(): SharedSessionContext["pendingRequests"] {
		return this.ctx.pendingRequests;
	}

	get agentCapabilities(): SharedSessionContext["agentCapabilities"] {
		return this.ctx.agentCapabilities;
	}

	get elevationCache(): SharedSessionContext["elevationCache"] {
		return this.ctx.elevationCache;
	}

	/** Proxy used by tests that call sm._resolveDisplayTitle(channelId) */
	_resolveDisplayTitle(channelId: string): string {
		return this.broadcaster.resolveDisplayTitle(channelId);
	}

	/** Proxy used by tests that call sm._spawnChannelsForHost(...) */
	_spawnChannelsForHost(
		hostId: string,
		agent: unknown,
		onOk: (id: string, ch: unknown) => void,
		onErr: (id: string, ch: unknown) => void,
	): Promise<void> {
		return this.lifecycle.spawnChannelsForHost(
			hostId,
			agent as Parameters<typeof this.lifecycle.spawnChannelsForHost>[1],
			onOk as Parameters<typeof this.lifecycle.spawnChannelsForHost>[2],
			onErr as Parameters<typeof this.lifecycle.spawnChannelsForHost>[3],
		);
	}

	/** Proxy used by tests that call sm._warmRestartLocal(hostId, sessionId) */
	_warmRestartLocal(hostId: string, sessionId: string): Promise<void> {
		return this.agentMgr.warmRestartLocal(hostId, sessionId);
	}

	get acquisitions(): SharedSessionContext["acquisitions"] {
		return this.ctx.acquisitions;
	}

	get pendingPrompts(): SharedSessionContext["pendingPrompts"] {
		return this.ctx.pendingPrompts;
	}

	// ─── Internal: SSH connect (used by handleSpawn coalescing) ──────────────

	/**
	 * Perform the full SSH connect sequence for a host: create SshAgent, call
	 * sshAgent.start(), handle TOFU / mismatch retries.  On success the agent
	 * is wired into ctx.agents.  On failure an ERROR is sent to `client` and
	 * the promise rejects so the caller can clean up.
	 *
	 * This method is extracted from handleSpawn so that concurrent SPAWNs for
	 * the same host can share a single in-flight promise via ctx.connectingAgents.
	 *
	 * @param signal - AbortSignal from the coalescing AbortController. When
	 *   aborted (via closeSession/shutdown), the SSH connect is cancelled and
	 *   the promise rejects — preventing revival of an explicitly closed session.
	 */
	private async _connectSshAgent(
		hostId: string,
		host: import("@termora/shared").Host,
		client: WsClient,
		sessionId: string,
		signal?: AbortSignal,
		ownerAcqId?: string,
	): Promise<import("./agent-connection.js").AgentConnection> {
		const promptAuth = this.sshMgr.buildPromptAuth(client, signal, ownerAcqId);

		const storedFingerprint = this.ctx.metaDal.getHostFingerprint(hostId);
		const sshHostname = host.sshHost?.includes("@")
			? (host.sshHost.split("@")[1] ?? host.sshHost)
			: (host.sshHost ?? host.label);
		const sshPort = host.sshPort ?? 22;
		const hostKey = `${sshHostname}:${sshPort}`;
		const sessionTrustedFp = this.ctx.trustedOnceFingerprints.get(hostKey);

		const deployOpts = this._buildDeployOpts(hostId, host, client, ownerAcqId);

		console.error(`[termora-ssh] creating SshAgent for host ${host.id}`);
		const sshAgent = new SshAgent(host, promptAuth, deployOpts, this.ctx.agentConfig);

		console.error(`[termora-ssh] starting SSH connection to ${host.sshHost ?? host.label}`);
		try {
			console.error("[termora-ssh] deploying agent...");
			await sshAgent.start(storedFingerprint, sessionTrustedFp, signal);
			console.error("[termora-ssh] agent deployed, exec starting");
			console.error("[termora-ssh] SSH connection established");
		} catch (err) {
			console.error(`[termora-ssh] SSH error: ${err instanceof Error ? err.message : String(err)}`);
			// Handle deploy errors (user rejection, binary not available)
			if (err instanceof DeployError) {
				client.send({
					type: "ERROR",
					code: err.code,
					message: err.message,
					hostId,
				} satisfies ErrorMessage);
				throw err;
			}

			// If the connect was aborted (session closed/shutdown), propagate without
			// sending an error to the client — the session is intentionally gone.
			if (signal?.aborted) {
				throw err instanceof Error ? err : new Error("SSH connect aborted");
			}

			const kv = sshAgent.lastKeyVerification;
			if (kv.tofu || kv.mismatch) {
				const action = await this.sshMgr.promptHostKeyVerify(
					client,
					hostId,
					host.sshHost ?? host.label,
					kv.mismatch ? (storedFingerprint ?? "") : "",
					kv.capturedFingerprint,
					kv.tofu,
					ownerAcqId,
				);
				if (action === "reject") {
					client.send({
						type: "ERROR",
						code: "SSH_HOST_KEY_REJECTED",
						message: "SSH host key rejected by user",
					} satisfies ErrorMessage);
					throw new Error("SSH host key rejected by user");
				}
				const retryFp = kv.capturedFingerprint;
				// Abort guard: if the session was closed (aborted) or replaced while
				// the user was responding to the verify prompt, discard the trust decision.
				// Without this guard, a response arriving after closeSession() would
				// persist a fingerprint for a session that is no longer current.
				if (signal?.aborted || this.ctx.sessions.get(hostId)?.id !== sessionId) {
					throw Object.assign(new Error("SSH connect aborted"), { name: "AbortError" });
				}
				if (action === "trust_permanent") {
					this.ctx.metaDal.updateHostFingerprint(hostId, retryFp);
				} else {
					this.ctx.trustedOnceFingerprints.set(hostKey, retryFp);
				}
				const retryAgent = new SshAgent(host, promptAuth, deployOpts, this.ctx.agentConfig);
				console.error(`[termora-ssh] creating SshAgent for host ${host.id} (retry)`);
				console.error(
					`[termora-ssh] starting SSH connection to ${host.sshHost ?? host.label} (retry)`,
				);
				try {
					console.error("[termora-ssh] deploying agent...");
					await retryAgent.start(
						action === "trust_permanent" ? retryFp : null,
						action === "trust_once" ? retryFp : undefined,
						signal,
					);
					console.error("[termora-ssh] agent deployed, exec starting");
					console.error("[termora-ssh] SSH connection established");
				} catch (retryErr) {
					console.error(
						`[termora-ssh] SSH error: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					);
					// Aborted during retry — don't send an error to the client.
					if (signal?.aborted) {
						throw retryErr instanceof Error ? retryErr : new Error("SSH connect aborted");
					}
					if (retryErr instanceof DeployError) {
						client.send({
							type: "ERROR",
							code: retryErr.code,
							message: retryErr.message,
							hostId,
						} satisfies ErrorMessage);
					} else {
						client.send({
							type: "ERROR",
							code: "SSH_CONNECT_FAILED",
							message: retryErr instanceof Error ? retryErr.message : "SSH connection failed",
						} satisfies ErrorMessage);
					}
					throw retryErr instanceof Error ? retryErr : new Error("SSH connection failed");
				}
				// Session-currency guard: verify the session is still the one we started.
				// An abort racing the final wiring could revive a closed session without this.
				if (signal?.aborted || this.ctx.sessions.get(hostId)?.id !== sessionId) {
					retryAgent.close();
					throw Object.assign(new Error("SSH connect aborted"), { name: "AbortError" });
				}
				this.broadcaster.updateSessionStatus(hostId, sessionId, "active");
				this.agentMgr.wireAgentEvents(hostId, sessionId, retryAgent);
				// B4: do NOT set ctx.agents here — caller sets it atomically with commit().
				return retryAgent;
			}
			client.send({
				type: "ERROR",
				code: "SSH_CONNECT_FAILED",
				message: err instanceof Error ? err.message : "SSH connection failed",
			} satisfies ErrorMessage);
			throw err instanceof Error ? err : new Error("SSH connection failed");
		}

		// Session-currency guard: verify the session is still the one we started.
		// An abort racing the final wiring (between start() returning and this line)
		// cannot revive a closed session because we check here before wiring.
		if (signal?.aborted || this.ctx.sessions.get(hostId)?.id !== sessionId) {
			sshAgent.close();
			throw Object.assign(new Error("SSH connect aborted"), { name: "AbortError" });
		}

		// First connection succeeded without TOFU/mismatch prompt
		this.broadcaster.updateSessionStatus(hostId, sessionId, "active");
		this.agentMgr.wireAgentEvents(hostId, sessionId, sshAgent);
		// B4: do NOT set ctx.agents here — caller sets it atomically with commit().
		return sshAgent;
	}

	// ─── Internal: elevation config ───────────────────────────────────────────

	private _resolveElevationConfig(
		hostCustomCommand: string | null | undefined,
		method: ElevationMethod,
	):
		| { method: ElevationMethod; customCommand: string | undefined }
		| { validationError: ErrorMessage } {
		const customCommand =
			method === "custom" && this.ctx.configResolver
				? this.ctx.configResolver.resolveCustomCommand(hostCustomCommand)
				: undefined;

		if (customCommand !== undefined) {
			try {
				validateCustomCommand(customCommand);
			} catch (err) {
				const e = err as { code: string; message: string };
				return {
					validationError: {
						type: "ERROR",
						code: "INVALID_CUSTOM_COMMAND",
						message: e.message,
					},
				};
			}
		}

		return { method, customCommand };
	}
}

async function closeAgentWithTimeout(agent: import("./agent-connection.js").AgentConnection) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			agent.close(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, AGENT_CLOSE_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
