/**
 * AgentConnectionManager — agent wiring, startup, daemon attach, warm restart.
 * Handles the low-level lifecycle of AgentConnection instances:
 *   - _wireAgentEvents: event dispatch from agent → session/channel handlers
 *   - daemon connect/reconnect
 *   - warm restart for local agents
 *   - session/host bootstrap (ensureLocalHost, startup, _getOrCreateSession)
 */

import type {
	AgentBellMessage,
	AgentLogMessage,
	AgentNotificationMessage,
	AgentProcessTitleMessage,
	AgentSnapshotResMessage,
	AgentTitleChangeMessage,
	ChannelExitMessage,
	ErrorMessage,
	HelloMessage,
	LogConfig,
	OutputMessage,
	ProtocolMessage,
	SessionStatus,
} from "@lasterm/shared";
import { DEFAULT_CHANNEL_NAME, ErrorCode, generateId, getSocketPath } from "@lasterm/shared";
import { HUB_VERSION } from "../build-version.js";
import { type AgentConnection, hasHubIdentity } from "./agent-connection.js";
import { connectOrLaunch } from "./agent-launcher.js";
import type { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import { daemonAuthFrame } from "./daemon-auth.js";
import { LastermAgent } from "./lasterm-agent.js";
import { assertQuitFence, captureQuitFence } from "./quit-fence.js";
import { hostKeepsDaemon } from "./remote-daemon.js";
import type { SessionState, SharedSessionContext } from "./session-context.js";
import { seedShellProfiles } from "./shell-profile-seed.js";
import { SshAgent } from "./ssh-agent.js";
import type { SshConnectionManager } from "./ssh-connection-manager.js";
import type { StateBroadcaster } from "./state-broadcaster.js";

export class AgentVersionMismatchError extends Error {
	readonly code = "AGENT_VERSION_MISMATCH" as const;

	constructor(agentVersion: string, hubVersion: string) {
		super(
			`Agent version mismatch after deploy: agent=${agentVersion} hub=${hubVersion}. Re-fetch or install the matching Lasterm agent binary, then reconnect.`,
		);
		this.name = "AgentVersionMismatchError";
	}
}

export class AgentConnectionManager {
	/** Lazy ref to SshConnectionManager — set after construction to break circular dep */
	sshMgr!: SshConnectionManager;

	private readonly daemonAttachPromises = new Map<string, Promise<LastermAgent>>();

	constructor(
		private readonly ctx: SharedSessionContext,
		private readonly broadcaster: StateBroadcaster,
		private readonly lifecycle: ChannelLifecycleManager,
	) {}

	// ─── Host / session helpers ───────────────────────────────────────────────

	async ensureLocalHost(): Promise<string> {
		const existing = this.ctx.metaDal.getHostByLabel("local");
		if (existing) return existing.id;
		const host = this.ctx.metaDal.createHost({ type: "local", label: "local" });
		return host.id;
	}

	async resolveHostId(requestedId?: string): Promise<string> {
		if (!requestedId || requestedId === "local") {
			return this.ensureLocalHost();
		}
		return requestedId;
	}

	async getOrCreateSession(
		hostId: string,
		isSsh: boolean,
		fence = captureQuitFence(this.ctx),
	): Promise<SessionState> {
		const existing = this.ctx.sessions.get(hostId);
		if (
			existing &&
			(existing.status === "active" ||
				existing.status === "disconnected" ||
				(!isSsh && existing.status === "starting"))
		) {
			return existing;
		}

		const sessionId = generateId();
		const initialStatus: SessionStatus = "starting";
		const state: SessionState = { id: sessionId, hostId, status: initialStatus };
		// These two commits independently revalidate the same opaque capability.
		// A quit between them leaves neither a context session nor a database row.
		this.ctx.commits.createSession(fence, { id: sessionId, hostId, status: initialStatus });
		this.ctx.commits.persistSession(fence, hostId, state);
		return state;
	}

	private warnAgentVersionMismatch(helloMsg: HelloMessage): void {
		if (helloMsg.agentVersion !== HUB_VERSION) {
			console.warn(
				`[lasterm] Agent version mismatch: agent=${helloMsg.agentVersion} hub=${HUB_VERSION}`,
			);
		}
	}

	private abortAgentVersionMismatch(
		hostId: string,
		sessionId: string,
		agent: AgentConnection,
		helloMsg: HelloMessage,
	): AgentVersionMismatchError | null {
		if (helloMsg.agentVersion === HUB_VERSION) return null;

		const error = new AgentVersionMismatchError(helloMsg.agentVersion, HUB_VERSION);
		this.ctx.hubLogger?.log("warn", "agent-connection-manager: deployed agent version mismatch", {
			hostId,
			sessionId,
			code: error.code,
			agentVersion: helloMsg.agentVersion,
			hubVersion: HUB_VERSION,
		});
		this.broadcaster.broadcastToAllClients({
			type: "ERROR",
			code: error.code,
			message: error.message,
			hostId,
		} satisfies ErrorMessage);
		if (this.ctx.agents.get(hostId) === agent) {
			this.ctx.agents.delete(hostId);
			this.ctx.agentCapabilities.delete(hostId);
		}
		agent.close();
		this.lifecycle.closeSession(hostId, sessionId);
		return error;
	}

	private handleHello(
		hostId: string,
		sessionId: string,
		agent: AgentConnection,
		helloMsg: HelloMessage,
		deployedThisSession: boolean,
		remoteMatchesHubVersionCache: boolean,
		reachedRunningDaemon: boolean,
	): AgentVersionMismatchError | null {
		this.ctx.hubLogger?.log("debug", "agent-connection-manager: HELLO received", {
			hostId,
			agentVersion: helloMsg.agentVersion,
			capabilities: helloMsg.capabilities,
			availableShells: helloMsg.availableShells,
		});
		// After a deploy, a version that disagrees means the binary is not the
		// one this hub meant to put there: stop. Not when the agent answering is
		// a daemon that was already running: it was started from the binary that
		// was there before, and it is the outdated agent the host reports and
		// offers to replace (#456, #555).
		if ((deployedThisSession || remoteMatchesHubVersionCache) && !reachedRunningDaemon) {
			const mismatch = this.abortAgentVersionMismatch(hostId, sessionId, agent, helloMsg);
			if (mismatch) return mismatch;
		} else {
			this.warnAgentVersionMismatch(helloMsg);
		}
		if (helloMsg.availableShells !== undefined) {
			this.ctx.metaDal.updateHostDiscoveredShells(
				hostId,
				helloMsg.availableShells,
				helloMsg.defaultShell,
			);
			// Auto-seed launch profiles for the agent's shells
			if (helloMsg.availableShells.length > 0) {
				const host = this.ctx.metaDal.getHost(hostId);
				seedShellProfiles(
					hostId,
					helloMsg.availableShells,
					helloMsg.defaultShell,
					host?.os ?? null,
					this.ctx.metaDal,
				).catch((err: unknown) => {
					console.error("[lasterm-ssh] seedShellProfiles failed:", err);
				});
			}
		}
		if (Array.isArray(helloMsg.capabilities)) {
			this.ctx.agentCapabilities.set(hostId, helloMsg.capabilities);
		}
		return null;
	}

	// ─── Startup ──────────────────────────────────────────────────────────────

	/**
	 * Whether this host's terminals may have outlived the hub.
	 *
	 * Only where a daemon was left running: that is the switch, and Windows
	 * remotes never qualify — their daemon listens on a named pipe, which no
	 * SSH channel carries, so they were on stdio and died with the connection.
	 */
	private remoteDaemonKeepsChannels(hostId: string): boolean {
		return hostKeepsDaemon(
			this.ctx.metaDal.getHost(hostId),
			this.ctx.configResolver?.sshConfig?.remoteDaemon === true,
		);
	}

	/**
	 * On hub start, restore sessions that were alive before the previous shutdown.
	 */
	async startup(): Promise<void> {
		const alive = this.ctx.metaDal.listAliveChannelsWithHost();
		if (alive.length === 0) return;

		const byHost = new Map<string, typeof alive>();
		for (const ch of alive) {
			const group = byHost.get(ch.hostId) ?? [];
			group.push(ch);
			byHost.set(ch.hostId, group);
		}

		for (const [hostId, channels] of byHost) {
			const first = channels[0];
			if (!first) continue;
			const hostType = first.hostType;
			const sessions = this.ctx.metaDal.listSessions(hostId);
			const session = sessions.find((s) => s.status !== "closed");
			if (!session) {
				for (const ch of channels) {
					this.ctx.metaDal.updateChannelStatus(ch.id, "dead");
				}
				continue;
			}

			this.ctx.metaDal.markHostSessionDisconnected(hostId);
			const fence = captureQuitFence(this.ctx);
			this.ctx.commits.persistSession(fence, hostId, {
				id: session.id,
				hostId,
				status: "disconnected",
			});

			this.ctx.metaDal.markHostChannelsOrphan(hostId);
			for (const ch of channels) {
				this.ctx.channels.set(ch.id, {
					sessionId: session.id,
					hostId,
					status: "orphan",
					clients: new Set(),
					...(ch.shell !== null && { shell: ch.shell }),
					...(ch.args.length > 0 && { args: ch.args }),
					cols: ch.cols,
					rows: ch.rows,
					...(ch.cwd !== null && { cwd: ch.cwd }),
					...(ch.directProcess && { directProcess: true }),
					// The process outlived the hub: its titles are the last ones the
					// database kept, until the agent reports new ones. Starting from
					// null named every restored terminal "Terminal".
					dynamicTitle: ch.dynamicTitle,
					processTitle: ch.processTitle,
					displayTitle: DEFAULT_CHANNEL_NAME,
				});
				this.broadcaster.resolveDisplayTitle(ch.id);
				// A terminal that outlived the hub still needs its screen kept: the
				// scheduler is what asks the agent for one every few seconds, and
				// the chunker is what bounds what the spool keeps. Registering the
				// channel without them left a restored terminal never snapshotted
				// again, its attach tail growing from the last snapshot before the
				// restart — 6 MB for a full-screen program, which is more than the
				// transport accepts (#457).
				this.ctx.scheduler.trackChannel(ch.id);
				this.ctx.chunker.trackChannel(ch.id);
			}

			if (hostType === "local") {
				try {
					await this.connectDaemonAgent(hostId, session.id);
				} catch {
					await this.warmRestartLocal(hostId, session.id);
				}
			} else if (this.remoteDaemonKeepsChannels(hostId)) {
				// A remote daemon outlives the SSH connection, so these terminals
				// may still be running. They stay orphan — already the state set
				// above — and the hub does not go and connect: reaching this host
				// can need a password, and at startup there is nobody to ask.
				// Selecting the host is what reconnects, and what adopts them.
				this.ctx.hubLogger?.log(
					"info",
					"agent-connection-manager: leaving remote channels orphan",
					{
						hostId,
						count: channels.length,
					},
				);
			} else {
				// SSH hosts on stdio: the agent was a child of the connection, and
				// the connection is gone. The PTYs went with it — this is not the
				// hub ending them, it is the hub finding them ended (#79).
				for (const ch of channels) {
					const chState = this.ctx.channels.get(ch.id);
					if (chState) chState.status = "dead";
					this.ctx.metaDal.updateChannelStatus(ch.id, "dead");
				}
			}
		}
	}

	// ─── Event wiring ─────────────────────────────────────────────────────────

	wireAgentEvents(hostId: string, sessionId: string, agent: AgentConnection): void {
		if (agent instanceof SshAgent) this.recordSshConnection(hostId, agent);
		const deployedThisSession = agent.deployedThisSession;
		const remoteMatchesHubVersionCache = agent.remoteMatchesHubVersionCache;
		const reachedRunningDaemon = agent.reachedRunningDaemon;
		agent.on("message", (msg: ProtocolMessage) => {
			// Dispatch pending request responses
			const rid = (msg as { requestId?: string }).requestId;
			if (rid) {
				const handler = this.ctx.pendingRequests.get(rid);
				if (handler) {
					handler(msg);
					return;
				}
			}

			// A newer connection has taken this one's place. Nothing this
			// connection sends will be read from here on, so it is dropped rather
			// than left writing into a socket that answers nothing (#127).
			if (msg.type === "ERROR" && (msg as { code?: string }).code === ErrorCode.DISPLACED) {
				this.dropDisplacedConnection(hostId, sessionId, agent, msg as ErrorMessage);
				return;
			}

			// Dispatch pending attach responses (ATTACH_OK uses channelId, not requestId)
			if (msg.type === "ATTACH_OK" || msg.type === "ERROR") {
				const cid = (msg as { channelId?: string }).channelId;
				if (cid) {
					const handler = this.ctx.pendingRequests.get(`attach:${cid}`);
					if (handler) {
						handler(msg);
						return;
					}
				}
			}

			if (msg.type === "HELLO") {
				const helloMsg = msg as HelloMessage;
				this.handleHello(
					hostId,
					sessionId,
					agent,
					helloMsg,
					deployedThisSession,
					remoteMatchesHubVersionCache,
					reachedRunningDaemon,
				);
			} else if (msg.type === "OUTPUT") {
				const outputMsg = msg as OutputMessage;
				this.broadcaster.broadcastToChannel(outputMsg.channelId, outputMsg);
				this.ctx.scheduler.onOutput(outputMsg.channelId);
				this.ctx.chunker.onOutput(outputMsg.channelId, outputMsg.data);
			} else if (msg.type === "SNAPSHOT_RES") {
				const res = msg as AgentSnapshotResMessage;
				this.ctx.scheduler.onSnapshotResponse(res.channelId);
				this.lifecycle.storeSnapshot(res.channelId, res.snapshot, res.lastSeq);
			} else if (msg.type === "CHANNEL_EXIT") {
				const exitMsg = msg as ChannelExitMessage;
				const channel = this.ctx.channels.get(exitMsg.channelId);
				if (channel) {
					this.broadcaster.updateChannelStatus(
						exitMsg.channelId,
						channel.sessionId,
						"dead",
						exitMsg.exitCode,
					);
				}
				this.ctx.scheduler.untrackChannel(exitMsg.channelId);
				this.ctx.chunker.untrackChannel(exitMsg.channelId);
				this.broadcaster.clearTitleDebounce(exitMsg.channelId);
				this.broadcaster.clearProcessTitleDebounce(exitMsg.channelId);
				// Close and remove the channel logger on exit
				const exitLogger = this.ctx.loggerRegistry?.get(exitMsg.channelId);
				if (exitLogger) {
					exitLogger.log("hub", "info", "channel exit", { exitCode: exitMsg.exitCode ?? null });
					exitLogger.close();
					this.ctx.loggerRegistry?.delete(exitMsg.channelId);
				}
			} else if (msg.type === "TITLE_CHANGE") {
				this.broadcaster.handleTitleChange(msg as AgentTitleChangeMessage);
			} else if (msg.type === "PROCESS_TITLE") {
				this.broadcaster.handleProcessTitle(msg as AgentProcessTitleMessage);
			} else if (msg.type === "BELL") {
				const bellMsg = msg as AgentBellMessage;
				if (this.broadcaster.rateLimitCheck(this.ctx.bellTimestamps, bellMsg.channelId, 10)) {
					this.broadcaster.broadcastToChannel(bellMsg.channelId, bellMsg);
				}
			} else if (msg.type === "NOTIFICATION") {
				const notifMsg = msg as AgentNotificationMessage;
				if (
					this.broadcaster.rateLimitCheck(this.ctx.notificationTimestamps, notifMsg.channelId, 5)
				) {
					this.broadcaster.broadcastToChannel(notifMsg.channelId, notifMsg);
				}
			} else if ((msg as { type: string }).type === "LOG") {
				const logMsg = msg as unknown as AgentLogMessage;
				// Validate level before casting
				const validLevels = ["trace", "debug", "info", "warn", "error"];
				const level = (
					validLevels.includes(logMsg.level) ? logMsg.level : "info"
				) as LogConfig["level"];
				const channelLogger = this.ctx.loggerRegistry?.get(logMsg.channelId);
				if (channelLogger) {
					channelLogger.log("agent", level, logMsg.msg);
				} else {
					this.ctx.hubLogger?.log(level, logMsg.msg, { channelId: logMsg.channelId, src: "agent" });
				}
			}
		});

		// The HELLO may have fired before we registered the "message" handler
		if (agent.helloMessage) {
			const helloMsg = agent.helloMessage;
			this.ctx.hubLogger?.log("debug", "agent-connection-manager: replaying cached HELLO", {
				hostId,
				agentVersion: helloMsg.agentVersion,
			});
			const mismatch = this.handleHello(
				hostId,
				sessionId,
				agent,
				helloMsg,
				deployedThisSession,
				remoteMatchesHubVersionCache,
				reachedRunningDaemon,
			);
			if (mismatch) throw mismatch;
		}

		agent.on("error", (err: Error) => {
			this.ctx.hubLogger?.log("warn", "agent-connection-manager: agent error", {
				hostId,
				message: err.message,
			});
			if (this.ctx.agents.get(hostId) === agent) {
				agent.close();
			}
		});

		agent.on("close", () => {
			this.ctx.hubLogger?.log("info", "agent-connection-manager: agent closed", { hostId });
			const session = this.ctx.sessions.get(hostId);
			const host = this.ctx.metaDal.getHost(hostId);
			// Fix C (invariant 10): identity-guard ALL side effects — not just agents.delete.
			// A stale close from a REPLACED agent must not trigger disconnect/reconnect for
			// the new agent's session.  Compute once, apply to every branch below.
			const isCurrentAgent = this.ctx.agents.get(hostId) === agent;
			if (isCurrentAgent) {
				this.ctx.agents.delete(hostId);
				// agentCapabilities is keyed to the same agent generation — clear it too.
				this.ctx.agentCapabilities.delete(hostId);
			}

			// Guard: stale close events from replaced agents produce no further side effects.
			if (!isCurrentAgent) return;

			if (!session) return;

			if (agent instanceof LastermAgent) {
				this.broadcaster.updateSessionStatus(hostId, session.id, "disconnected");
				this.reconnectDaemon(hostId, session.id).catch(() => {
					this.lifecycle.closeSession(hostId, session.id);
				});
				return;
			}

			if (host?.type === "ssh") {
				this.broadcaster.updateSessionStatus(hostId, session.id, "disconnected");
				this.sshMgr.scheduleReconnect(hostId, session.id, 0, Date.now());
			} else {
				this.warmRestartLocal(hostId, session.id).catch(() => {
					this.lifecycle.closeSession(hostId, session.id);
				});
			}
		});
	}

	/**
	 * Let go of a connection the daemon says a newer one has replaced.
	 *
	 * Either way this connection is finished: it is dropped, and no longer the
	 * way to reach this host if it still was. What differs is what the message
	 * means, and so how loudly it is said (#127).
	 *
	 * An agent with `hub-identity` serves several hubs, and replaces only a
	 * connection of the same hub: this hub opened a newer one itself, which is
	 * the one to use from now on. That is housekeeping, not news.
	 *
	 * An agent without it serves one hub at a time and has taken up with
	 * someone else, possibly another hub: the terminals this connection drove
	 * now answer elsewhere, and that is said where a person can find it.
	 */
	private dropDisplacedConnection(
		hostId: string,
		sessionId: string,
		agent: AgentConnection,
		msg: ErrorMessage,
	): void {
		if (hasHubIdentity(agent)) {
			this.ctx.hubLogger?.log(
				"debug",
				"agent-connection-manager: replaced by a newer connection of this hub",
				{ hostId, sessionId },
			);
		} else {
			this.ctx.hubLogger?.log("warn", "agent-connection-manager: displaced by another hub", {
				hostId,
				sessionId,
				message: msg.message,
			});
			console.error(
				`[lasterm] another connection has taken over the agent on ${hostId}: ${
					msg.message ?? "no detail"
				}`,
			);
		}
		if (this.ctx.agents.get(hostId) === agent) {
			this.ctx.agents.delete(hostId);
			this.ctx.agentCapabilities.delete(hostId);
		}
		agent.close();
	}

	/**
	 * Record the SSH connection a host session takes up, and its end. Every
	 * connect and every reconnect passes through wireAgentEvents once it has
	 * authenticated, which is what makes this the one place to say so. The end
	 * is listened for here, before anything below can close the agent, so a
	 * connection refused on its version still has both halves in the log.
	 */
	private recordSshConnection(hostId: string, agent: SshAgent): void {
		const host = this.ctx.metaDal.getHost(hostId);
		this.ctx.security.sshConnected({
			hostId,
			hostLabel: host?.label ?? "",
			authMethod: host?.sshAuth ?? "key",
		});
		agent.once("close", () => {
			this.ctx.security.sshDisconnected({
				hostId,
				reason: agent.closedByHub ? "closed_by_hub" : "connection_lost",
			});
		});
	}

	// ─── Daemon agent ─────────────────────────────────────────────────────────

	private async attachDaemon(hostId: string, sessionId: string): Promise<LastermAgent> {
		captureQuitFence(this.ctx);
		const existing = this.ctx.agents.get(hostId);
		if (existing?.connected) {
			this.ctx.hubLogger?.log("debug", "agent-connection-manager: reusing live daemon agent", {
				hostId,
				sessionId,
			});
			return existing as LastermAgent;
		}
		if (existing !== undefined) {
			this.ctx.hubLogger?.log("debug", "agent-connection-manager: evicting stale daemon agent", {
				hostId,
				sessionId,
			});
			this.ctx.agents.delete(hostId);
			this.ctx.agentCapabilities.delete(hostId);
			existing.close();
		}

		const inFlight = this.daemonAttachPromises.get(hostId);
		if (inFlight !== undefined) {
			this.ctx.hubLogger?.log("debug", "agent-connection-manager: joining daemon attach", {
				hostId,
				sessionId,
			});
			return inFlight;
		}

		const attachPromise = this.attachDaemonFresh(hostId, sessionId);
		this.daemonAttachPromises.set(hostId, attachPromise);
		void attachPromise
			.finally(() => {
				if (this.daemonAttachPromises.get(hostId) === attachPromise) {
					this.daemonAttachPromises.delete(hostId);
				}
			})
			.catch(() => {});
		return attachPromise;
	}

	private async attachDaemonFresh(hostId: string, sessionId: string): Promise<LastermAgent> {
		const quitEpoch = captureQuitFence(this.ctx);
		const socketPath = getSocketPath(this.ctx.agentConfig.socketPath);
		this.ctx.hubLogger?.log("debug", "agent-connection-manager: attachDaemon", {
			hostId,
			sessionId,
			socketPath,
		});
		let agent: LastermAgent | null = null;
		try {
			agent = await connectOrLaunch(
				socketPath,
				this.ctx.agentConfig,
				undefined,
				this.ctx.hubLogger ?? undefined,
				() => assertQuitFence(this.ctx, quitEpoch),
			);
			// A connect which completed after quit began is not adopted.
			assertQuitFence(this.ctx, quitEpoch);
			this.ctx.hubLogger?.log("debug", "agent-connection-manager: connectOrLaunch succeeded", {
				hostId,
				connected: agent.connected,
				hasPrimaryToken: this.ctx.primaryToken !== null,
			});

			this.wireAgentEvents(hostId, sessionId, agent);

			// Send AUTH to daemon agent (required before CHANNEL_STATE handshake).
			// The LastermAgent channel-state collector is installed in the constructor,
			// so the CHANNEL_STATE listener is already armed before AUTH can trigger it.
			// It carries the hub key, which is what makes this hub's channels its
			// own on a daemon that serves several (#127).
			const auth = daemonAuthFrame(agent, {
				token: this.ctx.primaryToken || null,
				hubKey: this.ctx.hubKey,
			});
			if (auth !== null) agent.send(auth);

			this.ctx.hubLogger?.log("debug", "agent-connection-manager: waiting for channel state", {
				hostId,
			});
			const states = await agent.waitForChannelState();
			assertQuitFence(this.ctx, quitEpoch);
			this.ctx.hubLogger?.log("debug", "agent-connection-manager: got channel states", {
				hostId,
				count: states.length,
			});
			this.lifecycle.reconcileChannelState(hostId, states, agent);

			assertQuitFence(this.ctx, quitEpoch);
			this.ctx.commits.adoptAgent(quitEpoch, hostId, agent);
			this.broadcaster.updateSessionStatus(hostId, sessionId, "active");
			this.ctx.hubLogger?.log("info", "agent-connection-manager: agent active", { hostId });

			return agent;
		} catch (err) {
			if (agent !== null) {
				if (this.ctx.agents.get(hostId) === agent) {
					this.ctx.agents.delete(hostId);
					this.ctx.agentCapabilities.delete(hostId);
				}
				agent.close();
			}
			this.ctx.hubLogger?.log("warn", "agent-connection-manager: daemon attach failed", {
				hostId,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}

	async connectDaemonAgent(hostId: string, sessionId: string): Promise<LastermAgent> {
		this.ctx.hubLogger?.log("debug", "agent-connection-manager: connectDaemonAgent", {
			hostId,
			sessionId,
		});
		return this.attachDaemon(hostId, sessionId);
	}

	async reconnectDaemon(hostId: string, sessionId: string): Promise<void> {
		captureQuitFence(this.ctx);
		await this.attachDaemon(hostId, sessionId);
	}

	// ─── Warm restart (local) ─────────────────────────────────────────────────

	async warmRestartLocal(hostId: string, sessionId: string): Promise<void> {
		captureQuitFence(this.ctx);
		// Crash-loop protection: max 3 restarts in 60s
		const now = Date.now();
		const tracking = this.ctx.restartTracking.get(hostId) ?? { count: 0, windowStart: now };
		if (now - tracking.windowStart > 60_000) {
			tracking.count = 0;
			tracking.windowStart = now;
		}
		tracking.count++;
		this.ctx.restartTracking.set(hostId, tracking);

		if (tracking.count > 3) {
			this.lifecycle.closeSession(hostId, sessionId);
			return;
		}

		let agent: LastermAgent;
		try {
			agent = await this.attachDaemon(hostId, sessionId);
		} catch {
			this.lifecycle.closeSession(hostId, sessionId);
			return;
		}

		await this.lifecycle.spawnChannelsForHost(
			hostId,
			agent,
			(channelId) => {
				this.ctx.scheduler.trackChannel(channelId);
				this.ctx.chunker.trackChannel(channelId);
			},
			(channelId, ch) => {
				this.broadcaster.updateChannelStatus(channelId, ch.sessionId, "dead");
			},
		);
	}
}
