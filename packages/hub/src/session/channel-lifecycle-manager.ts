/**
 * ChannelLifecycleManager — channel spawn, restart, destroy, respawn, and spool operations.
 * All channel state mutations go through StateBroadcaster for proper DB + WS sync.
 */

import type {
	AgentChannelStateMessage,
	AgentSpawnErrMessage,
	AgentSpawnMessage,
	AgentSpawnOkMessage,
	AuthPromptMessage,
	Channel,
	ChannelCreatedMessage,
	ChannelEndReason,
	ChannelStateMessage,
	DestroyMessage,
	ElevationMethod,
	ErrorMessage,
	ProtocolMessage,
	UiAttachOkMessage,
	UiSpawnOkMessage,
} from "@lasterm/shared";
import { DEFAULT_CHANNEL_NAME, generateId, validateCustomCommand } from "@lasterm/shared";
import { type AgentConnection, hasHubIdentity } from "./agent-connection.js";
import { daemonAuthFrame } from "./daemon-auth.js";
import {
	clearContext,
	clearElevationContextsForChannel,
	clearElevationContextsForSession,
	openContext,
	prompt as promptCtx,
	trackElevationContext,
} from "./prompt-context.js";
import {
	captureQuitFence,
	HubQuittingError,
	isQuitFenceCurrent,
	type QuitFence,
} from "./quit-fence.js";
import type {
	ChannelState,
	ElevationPromptOwner,
	SharedSessionContext,
} from "./session-context.js";
import type { WsClient } from "./session-manager.js";
import {
	envNamesIgnoreCase,
	resolveEnvironmentChanges,
	type SpawnEnvironmentFields,
	spawnEnvironmentFields,
	spawnEnvMode,
	wantsLoginShell,
} from "./spawn-environment.js";
import type { StateBroadcaster } from "./state-broadcaster.js";

const SPAWN_TIMEOUT_MS = 10_000;

interface RestartSpawnResult {
	ok: boolean;
	channelId: string | null;
	errCode: string | null;
}

/** Options for _sendSpawnAndWait */
export interface SendSpawnOpts {
	agent: AgentConnection;
	spawnMsg: AgentSpawnMessage;
	clientId: string;
	hostId: string;
	session: { id: string };
	client: WsClient;
	resolvedShell: string | undefined;
	resolvedArgs: string[];
	resolvedCwd: string | undefined;
	resolvedDirectProcess: boolean;
	resolvedLaunchProfileId: string | undefined;
	cols: number;
	rows: number;
	suppressClientError?: boolean;
	resolvedElevated?: boolean;
	resolvedElevationMethod?: string;
	/** The dead channel this spawn brings back, if it is one. */
	reuseChannelId?: string;
}

export class ChannelLifecycleManager {
	/** Optional callback to reconnect an SSH agent when restartChannel finds no connected agent. */
	onReconnectAgent?: (hostId: string) => Promise<boolean>;

	constructor(
		private readonly ctx: SharedSessionContext,
		private readonly broadcaster: StateBroadcaster,
	) {}

	/**
	 * The environment a terminal is started again with.
	 *
	 * A restart is the same terminal asked for a second time, so it gets what a
	 * new one would: the variables its scopes set, under the ones its launch
	 * profile names. Without this a restart spawned with none of them, and a
	 * change of environment could never reach a terminal that already existed —
	 * the only moment it ever can.
	 *
	 * What the spawn request carried is not remembered: it spoke for that one
	 * spawn, not for the terminal.
	 *
	 * It is the whole of what a SPAWN says about the environment (#576): the
	 * scopes' removals, the mode, and whether the shell logs in, decided as for
	 * a new terminal from what the channel was started with.
	 */
	private restartEnv(channelId: string, hostId: string): SpawnEnvironmentFields {
		const profile = this.ctx.configResolver?.resolve(hostId, channelId) ?? null;
		const channel = this.ctx.metaDal.getChannel(channelId);
		const host = this.ctx.metaDal.getHost(hostId);
		const launchProfile = channel?.launchProfileId
			? this.ctx.metaDal.getLaunchProfile(channel.launchProfileId)
			: undefined;
		const environment = resolveEnvironmentChanges(
			[
				...(this.ctx.configResolver?.environmentLayers(hostId, channelId) ?? []),
				launchProfile?.env,
			],
			host !== undefined && envNamesIgnoreCase(host),
		);
		const loginShell =
			host !== undefined &&
			wantsLoginShell(host, channel?.shell, channel?.args, channel?.directProcess);
		return spawnEnvironmentFields(environment, spawnEnvMode(profile?.envMode), loginShell);
	}

	/** The only primitive allowed to emit a SPAWN frame. */
	private sendGuardedSpawn(
		agent: AgentConnection,
		spawnMsg: AgentSpawnMessage,
		quitEpoch = captureQuitFence(this.ctx),
	): QuitFence {
		if (!isQuitFenceCurrent(this.ctx, quitEpoch)) throw new HubQuittingError();
		agent.send(spawnMsg);
		return quitEpoch;
	}

	// ─── Spawn ───────────────────────────────────────────────────────────────

	/**
	 * Send a SPAWN message to an agent and wait for SPAWN_OK or SPAWN_ERR.
	 * On SPAWN_OK: creates the channel in DB and memory, notifies all clients, returns channelId.
	 * On SPAWN_ERR: sends ERROR to client (unless suppressClientError=true), returns null errCode.
	 */
	async sendSpawnAndWait(
		opts: SendSpawnOpts,
	): Promise<{ channelId: string | null; errCode: string | null }> {
		const {
			agent,
			spawnMsg,
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
			suppressClientError = false,
			resolvedElevated = false,
			resolvedElevationMethod = undefined,
			reuseChannelId = undefined,
		} = opts;
		this.ctx.hubLogger?.log("debug", "channel-lifecycle: sendSpawnAndWait entry", {
			hostId,
			requestId: spawnMsg.requestId,
			shell: spawnMsg.shell,
			agentConnected: agent.connected,
		});
		let quitEpoch: QuitFence;
		try {
			// The send is the irreversible side effect; fence it immediately before it.
			quitEpoch = this.sendGuardedSpawn(agent, spawnMsg);
		} catch (err) {
			if (err instanceof HubQuittingError) {
				client.send({
					type: "ERROR",
					code: err.code,
					message: err.message,
				} satisfies ErrorMessage);
				return { channelId: null, errCode: err.code };
			}
			throw err;
		}
		this.ctx.hubLogger?.log("debug", "channel-lifecycle: SPAWN sent, awaiting SPAWN_OK", {
			requestId: spawnMsg.requestId,
			timeoutMs: SPAWN_TIMEOUT_MS,
		});

		return new Promise<{ channelId: string | null; errCode: string | null }>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.ctx.pendingRequests.delete(spawnMsg.requestId);
				this.ctx.hubLogger?.log("error", "channel-lifecycle: SPAWN_OK timeout", {
					requestId: spawnMsg.requestId,
					timeoutMs: SPAWN_TIMEOUT_MS,
				});
				reject(new Error("Agent SPAWN timeout"));
			}, SPAWN_TIMEOUT_MS);

			this.ctx.pendingRequests.set(spawnMsg.requestId, (incoming: ProtocolMessage) => {
				if (!isQuitFenceCurrent(this.ctx, quitEpoch)) {
					clearTimeout(timer);
					this.ctx.pendingRequests.delete(spawnMsg.requestId);
					client.send({
						type: "ERROR",
						code: "HUB_QUITTING",
						message: "Hub is quitting; SPAWN response was discarded",
					} satisfies ErrorMessage);
					resolve({ channelId: null, errCode: "HUB_QUITTING" });
					return;
				}
				this.ctx.hubLogger?.log("debug", "channel-lifecycle: pendingRequest handler fired", {
					msgType: incoming.type,
					requestId: spawnMsg.requestId,
				});
				if (incoming.type === "SPAWN_OK") {
					const spawnOk = incoming as AgentSpawnOkMessage;
					clearTimeout(timer);
					this.ctx.pendingRequests.delete(spawnMsg.requestId);
					this.ctx.hubLogger?.log("debug", "channel-lifecycle: SPAWN_OK received", {
						channelId: spawnOk.channelId,
					});

					const { channelId } = spawnOk;

					// A terminal being brought back keeps its row: its tab, its
					// scrollback and everything else keyed by this id. What it needs
					// is the session it now belongs to, which is a new one whenever
					// the hub has been restarted since it died.
					if (reuseChannelId !== undefined && reuseChannelId === channelId) {
						this.ctx.metaDal.reviveChannel(channelId, session.id, cols, rows);
						this.ctx.metaDal.updateChannelConfig(channelId, {
							...(resolvedShell !== undefined ? { shell: resolvedShell } : {}),
							...(resolvedArgs.length > 0 ? { args: resolvedArgs } : {}),
							...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
						});
					} else {
						this.ctx.metaDal.createChannel({
							id: channelId,
							sessionId: session.id,
							status: "born",
							...(resolvedShell !== undefined ? { shell: resolvedShell } : {}),
							...(resolvedArgs.length > 0 && { args: resolvedArgs }),
							...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
							cols,
							rows,
							...(resolvedDirectProcess && { directProcess: resolvedDirectProcess }),
							...(resolvedLaunchProfileId !== undefined && {
								launchProfileId: resolvedLaunchProfileId,
							}),
							...(resolvedElevated && { elevated: true }),
							...(resolvedElevationMethod !== undefined && {
								elevationMethod: resolvedElevationMethod,
							}),
						});
					}

					this.ctx.channels.set(channelId, {
						sessionId: session.id,
						hostId,
						status: "live",
						clients: new Set([clientId]),
						// None when none was resolved: the SPAWN named none either, and
						// a respawn must not name the hub's own SHELL (#583).
						...(resolvedShell !== undefined && { shell: resolvedShell }),
						...(resolvedArgs.length > 0 && { args: resolvedArgs }),
						...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
						cols,
						rows,
						...(resolvedDirectProcess && { directProcess: resolvedDirectProcess }),
						dynamicTitle: null,
						processTitle: null,
						displayTitle: DEFAULT_CHANNEL_NAME,
					});
					this.ctx.metaDal.updateChannelStatus(channelId, "live");
					this.ctx.scheduler.trackChannel(channelId);
					this.ctx.chunker.trackChannel(channelId);
					client.attachedChannels.add(channelId);

					const channelStateMsg: ChannelStateMessage = {
						type: "CHANNEL_STATE",
						channelId,
						sessionId: session.id,
						status: "live",
					};
					this.broadcaster.broadcastToAllClients(channelStateMsg);

					// Broadcast CHANNEL_CREATED to all clients so observers (clients
					// not involved in this spawn) learn about the new channel without
					// having to call fetchChannels.  The spawning client deduplicates
					// via handleChannelCreated's guard (no-op if channelId already
					// present) and via fetchChannels' own channel-list check on resolve.
					const dbChannel = this.ctx.metaDal.getChannel(channelId);
					const now = dbChannel?.createdAt ?? new Date().toISOString();
					// Use the same resolution path as GET /api/channels so observers
					// and late-fetchers see an identical displayTitle (not hardcoded).
					const resolvedDisplayTitle = this.broadcaster.resolveDisplayTitle(channelId);
					const channelCreatedMsg: ChannelCreatedMessage = {
						type: "CHANNEL_CREATED",
						hostId,
						channelId,
						sessionId: session.id,
						...(resolvedShell !== undefined && { shell: resolvedShell }),
						...(resolvedArgs.length > 0 && { args: resolvedArgs }),
						...(resolvedCwd !== undefined && { cwd: resolvedCwd }),
						cols,
						rows,
						status: "live",
						displayTitle: resolvedDisplayTitle,
						createdAt: now,
						updatedAt: now,
					};
					this.broadcaster.broadcastChannelCreated(channelCreatedMsg);

					const response: UiSpawnOkMessage = {
						type: "SPAWN_OK",
						channelId,
						hostId,
						sessionId: session.id,
					};
					client.send(response);
					resolve({ channelId, errCode: null });
				} else if (incoming.type === "SPAWN_ERR") {
					const spawnErr = incoming as AgentSpawnErrMessage;
					clearTimeout(timer);
					this.ctx.pendingRequests.delete(spawnMsg.requestId);
					this.ctx.hubLogger?.log("warn", "channel-lifecycle: SPAWN_ERR received", {
						code: spawnErr.code,
						message: spawnErr.message,
					});

					if (!suppressClientError) {
						const errorMsg: ErrorMessage = {
							type: "ERROR",
							code: spawnErr.code,
							message: spawnErr.message,
						};
						client.send(errorMsg);
					}
					resolve({ channelId: null, errCode: spawnErr.code });
				}
			});
		});
	}

	// ─── Destroy ─────────────────────────────────────────────────────────────

	/**
	 * Destroy a single channel: send DESTROY to the agent, mark dead in DB,
	 * untrack from scheduler/chunker, and remove from in-memory map.
	 * Returns true if the channel was found and destroyed.
	 *
	 * The end is said to be the hub's doing, so that no pane over it brings it
	 * back or closes on it (#580). The agent's CHANNEL_EXIT that follows finds
	 * the channel forgotten and is not reported again.
	 */
	destroyChannel(channelId: string): boolean {
		const ch = this.ctx.channels.get(channelId);
		if (!ch) return false;
		this.clearElevationForChannel(channelId);

		const agent = this.ctx.agents.get(ch.hostId);
		if (agent?.connected) {
			agent.send({ type: "DESTROY", channelId } as DestroyMessage);
		}

		this.broadcaster.updateChannelStatus(channelId, ch.sessionId, "dead", undefined, "destroyed");

		this.ctx.scheduler.untrackChannel(channelId);
		this.ctx.chunker.untrackChannel(channelId);
		this.ctx.channels.delete(channelId);

		return true;
	}

	retireChannel(channelId: string, sessionId: string): void {
		this.clearElevationForChannel(channelId);
		this.broadcaster.updateChannelStatus(channelId, sessionId, "dead");
		this.forgetChannel(channelId);
	}

	/**
	 * Take a terminal out of everything that speaks to a running one: the clients
	 * that hold it, the snapshot timer, the chunker, and the map of what this hub
	 * believes is alive. Saying a channel is dead is not the same as forgetting
	 * it, and one left in that map is read by the rest of the hub as a terminal
	 * still running — its snapshot timer keeps asking an agent that has never
	 * heard of it, and a SPAWN that names it to bring it back is refused.
	 */
	private forgetChannel(channelId: string): void {
		const ch = this.ctx.channels.get(channelId);
		if (ch) {
			for (const clientId of ch.clients) {
				this.ctx.clients.get(clientId)?.attachedChannels.delete(channelId);
			}
		}
		this.ctx.scheduler.untrackChannel(channelId);
		this.ctx.chunker.untrackChannel(channelId);
		this.ctx.channels.delete(channelId);
	}

	// ─── Restart ─────────────────────────────────────────────────────────────

	/**
	 * Restart a channel: destroy the current PTY and respawn with the same config.
	 * Returns true on success.
	 */
	async restartChannel(channelId: string, requestingClientId?: string): Promise<boolean> {
		try {
			captureQuitFence(this.ctx);
		} catch (err) {
			if (err instanceof HubQuittingError) return false;
			throw err;
		}
		const info = this.ctx.metaDal.getChannelWithHost(channelId);
		if (!info) return false;

		const { channel, hostId } = info;
		const ch = this.ctx.channels.get(channelId);

		let agent = this.ctx.agents.get(hostId);
		if (agent?.connected && ch && ch.status !== "dead") {
			agent.send({ type: "DESTROY", channelId } as DestroyMessage);
		}

		let sessionEntry = this.ctx.sessions.get(hostId);

		// If agent not connected, try to reconnect (SSH hosts need a fresh connection)
		if (!agent?.connected && this.onReconnectAgent) {
			const reconnected = await this.onReconnectAgent(hostId);
			if (!reconnected) return false;
			// Refresh references after reconnection
			sessionEntry = this.ctx.sessions.get(hostId);
		}

		if (!sessionEntry || (sessionEntry.status !== "active" && sessionEntry.status !== "detached"))
			return false;
		agent = this.ctx.agents.get(hostId);
		if (!agent?.connected) return false;

		// A terminal with no shell of its own is sent none, as a new one is: its
		// agent starts its user's default shell. It was sent "/bin/sh", which the
		// database made up for it, or else the hub's own SHELL, a shell on the
		// hub's machine (#583).
		const shell = channel.shell;
		const args = channel.args ?? [];
		// A terminal with no directory of its own is sent none, as a new one is:
		// the agent starts it in the home of the user it runs as. The hub's own
		// HOME names a directory on the hub's machine, and a Windows hub has
		// none, which sent every restarted remote terminal to "/" (#581).
		const cwd = channel.cwd;
		const cols = channel.cols;
		const rows = channel.rows;

		// ── Elevated restart ─────────────────────────────────────────────────
		if (channel.elevated && channel.elevationMethod) {
			const method = channel.elevationMethod as ElevationMethod;

			const elevCfg = this._resolveElevationConfig(
				this.ctx.metaDal.getHost(hostId)?.customCommand,
				method,
			);
			if ("validationError" in elevCfg) {
				this.ctx.hubLogger?.log(
					"warn",
					"channel-lifecycle: restartChannel invalid elevation config",
					{ hostId, message: elevCfg.validationError.message },
				);
				return false;
			}
			const { customCommand } = elevCfg;

			const baseElevatedSpawn: AgentSpawnMessage = {
				type: "SPAWN",
				requestId: generateId(),
				channelId,
				...(shell !== undefined && { shell }),
				...(args.length > 0 && { args }),
				...(cwd !== undefined && { cwd }),
				...this.restartEnv(channelId, hostId),
				cols,
				rows,
				elevated: true,
				elevationMethod: method,
				...(customCommand !== undefined && { customCommand }),
			};

			// Find a client to prompt
			let promptClient: WsClient | undefined;
			if (requestingClientId) {
				promptClient = this.ctx.clients.get(requestingClientId);
			}
			if (!promptClient) {
				const attachedClientId =
					ch?.clients && ch.clients.size > 0 ? [...ch.clients][0] : undefined;
				promptClient = attachedClientId ? this.ctx.clients.get(attachedClientId) : undefined;
			}
			if (!promptClient) {
				// No client for prompting — try cache or passwordless only
				// Scan for any valid cache entry for this host (composite key ${hostId}:*)
				let cached: { secret: string; expiresAt: number } | undefined;
				for (const [key, val] of this.ctx.elevationCache) {
					if (key.startsWith(`${hostId}:`) && val.expiresAt > Date.now()) {
						cached = val;
						break;
					}
				}
				if (cached) {
					const spawnWithSecret: AgentSpawnMessage = {
						...baseElevatedSpawn,
						requestId: generateId(),
						elevationSecret: cached.secret,
					};
					return await this.restartSendAndWait(
						agent,
						spawnWithSecret,
						channelId,
						channel,
						hostId,
						sessionEntry,
						ch,
						shell,
						args,
						cwd,
						cols,
						rows,
						channel.directProcess,
					);
				}
				return await this.restartSendAndWait(
					agent,
					baseElevatedSpawn,
					channelId,
					channel,
					hostId,
					sessionEntry,
					ch,
					shell,
					args,
					cwd,
					cols,
					rows,
					channel.directProcess,
				);
			}

			// Cache hit — SEC-004: composite key ${hostId}:${clientId}
			const cacheKey = `${hostId}:${promptClient.id}`;
			const cached = this.ctx.elevationCache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				const spawnWithSecret: AgentSpawnMessage = {
					...baseElevatedSpawn,
					requestId: generateId(),
					elevationSecret: cached.secret,
				};
				return await this.restartSendAndWait(
					agent,
					spawnWithSecret,
					channelId,
					channel,
					hostId,
					sessionEntry,
					ch,
					shell,
					args,
					cwd,
					cols,
					rows,
					channel.directProcess,
				);
			}

			// Cache miss — try passwordless first
			const firstResult = await this.sendRestartSpawn(agent, baseElevatedSpawn);
			if (firstResult.ok && firstResult.channelId !== null) {
				this.applyRestartState(
					firstResult.channelId,
					channelId,
					channel,
					hostId,
					sessionEntry,
					ch,
					shell,
					args,
					cwd,
					cols,
					rows,
					channel.directProcess,
				);
				return true;
			}

			if (firstResult.errCode !== "ELEVATION_PASSWORD_REQUIRED") {
				return false;
			}

			// Prompt user
			const promptFn = this._buildPromptAuth(promptClient, {
				hostId,
				sessionId: sessionEntry.id,
				owner: "channel-restart",
				operationId: channelId,
				channelId,
			});
			const host = this.ctx.metaDal.getHost(hostId);
			const hostname = host?.sshHost ?? host?.label ?? hostId;
			const secret = await promptFn(
				hostId,
				"elevation",
				`Enter password for elevated shell on ${hostname}`,
			);
			if (secret === null) {
				promptClient.send({
					type: "ERROR",
					code: "ELEVATION_CANCELLED",
					message: "Elevation cancelled by user",
				} as ErrorMessage);
				return false;
			}

			this.ctx.elevationCache.set(`${hostId}:${promptClient.id}`, {
				secret,
				expiresAt: Date.now() + 900_000,
			});

			const retrySpawn: AgentSpawnMessage = {
				...baseElevatedSpawn,
				requestId: generateId(),
				elevationSecret: secret,
			};
			return await this.restartSendAndWait(
				agent,
				retrySpawn,
				channelId,
				channel,
				hostId,
				sessionEntry,
				ch,
				shell,
				args,
				cwd,
				cols,
				rows,
				channel.directProcess,
			);
		}

		// ── Non-elevated restart ─────────────────────────────────────────────
		const requestId = generateId();
		const restartSpawn: AgentSpawnMessage = {
			type: "SPAWN",
			requestId,
			channelId,
			...(shell !== undefined && { shell }),
			...(args.length > 0 && { args }),
			...(cwd !== undefined && { cwd }),
			...this.restartEnv(channelId, hostId),
			cols,
			rows,
		};

		const restartResult = await this.sendRestartSpawn(agent, restartSpawn);
		if (!restartResult.ok || restartResult.channelId === null) return false;

		this.applyRestartState(
			restartResult.channelId,
			channelId,
			channel,
			hostId,
			sessionEntry,
			ch,
			shell,
			args,
			cwd,
			cols,
			rows,
			channel.directProcess,
		);
		return true;
	}

	/**
	 * Send SPAWN and wait for SPAWN_OK/ERR, then apply restart state on success.
	 */
	async restartSendAndWait(
		agent: AgentConnection,
		spawnMsg: AgentSpawnMessage,
		channelId: string,
		sourceChannel: Channel,
		hostId: string,
		sessionEntry: { id: string; status: string },
		ch: ChannelState | undefined,
		shell: string | undefined,
		args: string[],
		cwd: string | undefined,
		cols: number,
		rows: number,
		directProcess?: boolean,
	): Promise<boolean> {
		const result = await this.sendRestartSpawn(agent, spawnMsg);
		if (!result.ok || result.channelId === null) return false;
		this.applyRestartState(
			result.channelId,
			channelId,
			sourceChannel,
			hostId,
			sessionEntry,
			ch,
			shell,
			args,
			cwd,
			cols,
			rows,
			directProcess,
		);
		return true;
	}

	private async sendRestartSpawn(
		agent: AgentConnection,
		spawnMsg: AgentSpawnMessage,
	): Promise<RestartSpawnResult> {
		let quitEpoch: QuitFence;
		try {
			quitEpoch = this.sendGuardedSpawn(agent, spawnMsg);
		} catch (err) {
			if (err instanceof HubQuittingError) {
				return { ok: false, channelId: null, errCode: err.code };
			}
			throw err;
		}
		return new Promise<RestartSpawnResult>((resolve) => {
			const timer = setTimeout(() => {
				this.ctx.pendingRequests.delete(spawnMsg.requestId);
				resolve({ ok: false, channelId: null, errCode: null });
			}, SPAWN_TIMEOUT_MS);

			this.ctx.pendingRequests.set(spawnMsg.requestId, (incoming: ProtocolMessage) => {
				if (!isQuitFenceCurrent(this.ctx, quitEpoch)) {
					clearTimeout(timer);
					this.ctx.pendingRequests.delete(spawnMsg.requestId);
					resolve({ ok: false, channelId: null, errCode: "HUB_QUITTING" });
					return;
				}
				clearTimeout(timer);
				this.ctx.pendingRequests.delete(spawnMsg.requestId);
				if (incoming.type === "SPAWN_OK") {
					resolve({
						ok: true,
						channelId: (incoming as AgentSpawnOkMessage).channelId,
						errCode: null,
					});
				} else if (incoming.type === "SPAWN_ERR") {
					resolve({
						ok: false,
						channelId: null,
						errCode: (incoming as AgentSpawnErrMessage).code,
					});
				} else {
					resolve({ ok: false, channelId: null, errCode: null });
				}
			});
		});
	}

	/**
	 * Update in-memory + DB state after a successful restart SPAWN_OK.
	 */
	applyRestartState(
		channelId: string,
		previousChannelId: string,
		sourceChannel: Channel,
		hostId: string,
		sessionEntry: { id: string; status: string },
		ch: ChannelState | undefined,
		shell: string | undefined,
		args: string[],
		cwd: string | undefined,
		cols: number,
		rows: number,
		directProcess?: boolean,
	): void {
		// A SPAWN_OK received after quit must never recreate channel state.
		captureQuitFence(this.ctx);
		const clients = ch?.clients ?? new Set<string>();
		const channelIdChanged = channelId !== previousChannelId;

		if (channelIdChanged) {
			this.retireChannel(previousChannelId, sessionEntry.id);
			for (const clientId of clients) {
				const client = this.ctx.clients.get(clientId);
				client?.attachedChannels.delete(previousChannelId);
				client?.attachedChannels.add(channelId);
			}

			if (this.ctx.metaDal.getChannel(channelId) === undefined) {
				this.ctx.metaDal.createChannel({
					id: channelId,
					sessionId: sessionEntry.id,
					status: "born",
					...(shell !== undefined && { shell }),
					...(args.length > 0 && { args }),
					...(cwd !== undefined && { cwd }),
					cols,
					rows,
					...(sourceChannel.title !== undefined && { title: sourceChannel.title }),
					...(directProcess && { directProcess: true }),
					...(sourceChannel.launchProfileId !== undefined && {
						launchProfileId: sourceChannel.launchProfileId,
					}),
					...(sourceChannel.elevated && { elevated: true }),
					...(sourceChannel.elevationMethod !== undefined && {
						elevationMethod: sourceChannel.elevationMethod,
					}),
				});
			}
		}

		this.ctx.metaDal.updateChannelStatus(channelId, "live");
		this.ctx.channels.set(channelId, {
			sessionId: sessionEntry.id,
			hostId,
			status: "live",
			clients,
			...(shell !== undefined && { shell }),
			...(args.length > 0 && { args }),
			...(cwd !== undefined && { cwd }),
			cols,
			rows,
			...(directProcess && { directProcess: true }),
			dynamicTitle: null,
			processTitle: null,
			displayTitle: DEFAULT_CHANNEL_NAME,
		});
		this.ctx.scheduler.trackChannel(channelId);
		this.ctx.chunker.trackChannel(channelId);

		if (channelIdChanged) {
			const dbChannel = this.ctx.metaDal.getChannel(channelId);
			const now = dbChannel?.createdAt ?? new Date().toISOString();
			this.broadcaster.broadcastChannelCreated({
				type: "CHANNEL_CREATED",
				hostId,
				channelId,
				sessionId: sessionEntry.id,
				...(shell !== undefined && { shell }),
				...(args.length > 0 && { args }),
				...(cwd !== undefined && { cwd }),
				cols,
				rows,
				status: "live",
				displayTitle: this.broadcaster.resolveDisplayTitle(channelId),
				createdAt: now,
				updatedAt: dbChannel?.updatedAt ?? now,
			});
		}

		const channelStateMsg: ChannelStateMessage = {
			type: "CHANNEL_STATE",
			channelId,
			sessionId: sessionEntry.id,
			status: "live",
		};
		this.broadcaster.broadcastToAllClients(channelStateMsg);

		if (sessionEntry.status === "detached") {
			this.broadcaster.updateSessionStatus(hostId, sessionEntry.id, "active");
		}
	}

	// ─── Session close ────────────────────────────────────────────────────────

	/**
	 * End a host's session and every terminal in it.
	 *
	 * `endReason` is for a caller closing it on purpose: its terminals' ends
	 * then say so (#580). Without one, the session is closing under the hub (its
	 * agent went, its connection failed), and those ends are the host's.
	 */
	closeSession(hostId: string, sessionId: string, endReason?: ChannelEndReason): void {
		this.clearElevationForSession(sessionId);

		// Cancel any pending reconnect timer for this host
		const pendingTimer = this.ctx.reconnectTimers.get(hostId);
		if (pendingTimer !== undefined) {
			clearTimeout(pendingTimer);
			this.ctx.reconnectTimers.delete(hostId);
		}
		// Abort any in-flight reconnect start() so it cannot wire/store the agent
		// after the session is already closed (invariant 10).
		const reconnectAc = this.ctx.reconnectAbortControllers.get(hostId);
		if (reconnectAc !== undefined) {
			reconnectAc.abort();
			this.ctx.reconnectAbortControllers.delete(hostId);
		}
		// Every channel of this host goes, whatever state it is in. A channel left
		// in the live map is a terminal the hub believes is running: its snapshot
		// timer keeps asking an agent that no longer knows it, every five seconds
		// for as long as the hub lives, and a spawn that names it to bring it back
		// is refused because "it is still running". One already marked dead is the
		// one most likely to be in both traps, so it is the last thing to skip.
		for (const [channelId, ch] of this.ctx.channels.entries()) {
			if (ch.hostId !== hostId) continue;
			if (ch.status !== "dead") {
				this.broadcaster.updateChannelStatus(channelId, sessionId, "dead", undefined, endReason);
			}
			this.forgetChannel(channelId);
		}
		this.broadcaster.updateSessionStatus(hostId, sessionId, "closed");
		this.ctx.sessions.delete(hostId);
	}

	// ─── Spool helpers ────────────────────────────────────────────────────────

	/**
	 * What an ATTACH_OK may carry after its snapshot.
	 *
	 * The desktop transport caps one hub message at 512 KiB on purpose, so that
	 * a webview which is slow to drain cannot be flooded. A tail built from the
	 * spool ignored that: a channel with a long history produced a 6 MB message,
	 * the socket refused it, and the whole connection went down — taking every
	 * pane's attach with it, each stuck on "Connecting…" for ever.
	 *
	 * The newest chunks are the ones that continue the screen, so those are the
	 * ones kept. Scrollback older than this is lost to the pane; a bounded tail
	 * beats a dead connection.
	 */
	private static readonly MAX_ATTACH_TAIL_BYTES = 128 * 1024;

	/**
	 * The output after a snapshot, or nothing when there is too much of it.
	 *
	 * Cutting a terminal stream is not like cutting a log. Escape sequences set
	 * attributes, move the cursor, enter and leave the alternate screen; a piece
	 * starting anywhere but a boundary leaves the emulator in a state nobody
	 * chose, and it renders something wrong without saying so.
	 *
	 * So when it does not fit, none of it is sent. The snapshot alone is a
	 * coherent screen, older than the truth, and `truncated` is how the pane
	 * gets to say that the rest is missing.
	 */
	static boundTail(chunks: ReadonlyArray<{ dataBlob: Buffer }>): {
		tail: Uint8Array[];
		truncated: boolean;
	} {
		let total = 0;
		for (const chunk of chunks) {
			total += chunk.dataBlob.length;
			if (total > ChannelLifecycleManager.MAX_ATTACH_TAIL_BYTES) {
				return { tail: [], truncated: true };
			}
		}
		return { tail: chunks.map((c) => new Uint8Array(c.dataBlob)), truncated: false };
	}

	buildAttachPayload(channelId: string): {
		snapshot: UiAttachOkMessage["snapshot"];
		tail: Uint8Array[];
		truncated: boolean;
	} {
		let snapshot: UiAttachOkMessage["snapshot"] = null;
		let tail: Uint8Array[] = [];
		let truncated = false;

		const snapshotChunk = this.ctx.spoolDal.getLatestSnapshot(channelId);
		if (snapshotChunk) {
			try {
				snapshot = JSON.parse(
					snapshotChunk.dataBlob.toString("utf8"),
				) as UiAttachOkMessage["snapshot"];
			} catch {
				snapshot = null;
			}
			const tailChunks = this.ctx.spoolDal.getChunksByChannel(channelId, {
				kind: "output",
				afterSeq: snapshotChunk.seq,
			});
			const bounded = ChannelLifecycleManager.boundTail(tailChunks);
			tail = bounded.tail;
			truncated = bounded.truncated;
		}

		return { snapshot, tail, truncated };
	}

	storeSnapshot(channelId: string, snapshot: unknown, agentLastSeq: number): string {
		const snapshotJson = JSON.stringify(snapshot);
		const dataBlob = Buffer.from(snapshotJson);
		this.ctx.chunker.flush(channelId);
		const maxSeq = this.ctx.spoolDal.getMaxSeq(channelId);
		const snapshotSeq = Math.max(maxSeq, agentLastSeq) + 1;
		const chunkId = this.ctx.spoolDal.insertChunk({
			channelId,
			seq: snapshotSeq,
			kind: "snapshot",
			dataBlob,
			uncompressedLen: dataBlob.length,
		});
		this.ctx.chunker.bumpSeq(channelId, snapshotSeq + 1);
		this.ctx.metaDal.updateCacheIndex(channelId, chunkId, snapshotSeq - 1);
		return chunkId;
	}

	// ─── Re-attach channels ───────────────────────────────────────────────────

	reAttachChannels(hostId: string, sessionId: string, agent: AgentConnection): void {
		this.spawnChannelsForHost(
			hostId,
			agent,
			(channelId, ch) => {
				if (ch.clients.size > 0) {
					this.broadcaster.updateChannelStatus(channelId, sessionId, "live");
				}
				this.ctx.scheduler.trackChannel(channelId);
				this.ctx.chunker.trackChannel(channelId);
			},
			(channelId, ch) => {
				this.broadcaster.updateChannelStatus(channelId, ch.sessionId, "dead");
			},
		);
	}

	/**
	 * Send SPAWN messages for every alive channel belonging to a host.
	 * The returned promise resolves once ALL SPAWN_OK/SPAWN_ERR responses (or timeouts) have fired.
	 */
	spawnChannelsForHost(
		hostId: string,
		agent: AgentConnection,
		onSpawnOk: (channelId: string, ch: ChannelState) => void,
		onSpawnErr: (channelId: string, ch: ChannelState) => void,
	): Promise<void> {
		let pending = 0;
		let resolve: (() => void) | undefined;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});

		const settle = (): void => {
			pending--;
			if (pending === 0) resolve?.();
		};

		let quitEpoch: QuitFence;
		try {
			quitEpoch = captureQuitFence(this.ctx);
		} catch (err) {
			if (err instanceof HubQuittingError) return Promise.resolve();
			throw err;
		}

		for (const [channelId, ch] of this.ctx.channels.entries()) {
			if (ch.hostId !== hostId || ch.status === "dead") continue;

			pending++;
			const requestId = generateId();
			if (!isQuitFenceCurrent(this.ctx, quitEpoch)) break;
			this.sendGuardedSpawn(
				agent,
				{
					type: "SPAWN",
					requestId,
					channelId,
					// Neither a shell nor a directory when it has none of its own: the
					// agent's defaults, as for a new terminal and a restart (#581, #583).
					...(ch.shell !== undefined && { shell: ch.shell }),
					...(ch.args !== undefined && ch.args.length > 0 && { args: ch.args }),
					...(ch.cwd !== undefined && { cwd: ch.cwd }),
					...this.restartEnv(channelId, hostId),
					cols: ch.cols,
					rows: ch.rows,
				},
				quitEpoch,
			);

			const timeout = setTimeout(() => {
				this.ctx.pendingRequests.delete(requestId);
				this.ctx.hubLogger?.log("error", "channel-lifecycle: SPAWN timeout", {
					channelId,
					requestId,
					timeoutMs: SPAWN_TIMEOUT_MS,
				});
				onSpawnErr(channelId, ch);
				settle();
			}, SPAWN_TIMEOUT_MS);

			this.ctx.pendingRequests.set(requestId, (incoming: ProtocolMessage) => {
				if (!isQuitFenceCurrent(this.ctx, quitEpoch)) {
					clearTimeout(timeout);
					this.ctx.pendingRequests.delete(requestId);
					settle();
					return;
				}
				clearTimeout(timeout);
				this.ctx.pendingRequests.delete(requestId);
				if (incoming.type === "SPAWN_OK") {
					onSpawnOk(channelId, ch);
				} else {
					onSpawnErr(channelId, ch);
				}
				settle();
			});
		}

		if (pending === 0) resolve?.();

		return promise;
	}

	// ─── Reconcile ────────────────────────────────────────────────────────────

	/**
	 * Take up what a daemon says it is still holding, and say whether the agent
	 * was one.
	 *
	 * Every way of reaching a host over SSH ends here, because each can land on
	 * a daemon holding terminals: the first connection of a run, the one a pane
	 * asks for, and the automatic one after the link drops. The last was missed
	 * — it ran the agent on stdio and started every terminal again, fresh,
	 * under the ids of the ones the daemon was still running (#79).
	 *
	 * An agent this connection started answers with nothing, and asking it
	 * would only wait out the deadline — so it is not asked.
	 */
	async adoptWhatTheDaemonHolds(
		hostId: string,
		agent: AgentConnection & { usedRemoteDaemon?: boolean },
	): Promise<boolean> {
		if (agent.usedRemoteDaemon !== true) return false;
		try {
			// A daemon that serves several hubs waits for this before it says
			// what it holds, since what it says depends on who is asking (#127).
			// It never gets this hub's token: see daemonAuthFrame.
			const auth = daemonAuthFrame(agent, { token: null, hubKey: this.ctx.hubKey });
			if (auth !== null) agent.send(auth);
			this.reconcileChannelState(hostId, await agent.waitForChannelState(), agent);
			// The session was announced active before the daemon had said what
			// other hubs hold there; say it now that it has.
			if (agent.otherOwnerChannels !== undefined && this.ctx.agents.get(hostId) === agent) {
				this.broadcaster.announceSessionState(hostId);
			}
		} catch (stateErr) {
			// Reachable, and it will not say what it holds. Most likely it wants a
			// token: a remote running its own hub has an auth.json of its own, and
			// this hub does not have that token.
			console.error(
				`[lasterm-ssh] the remote daemon did not report its terminals: ${
					stateErr instanceof Error ? stateErr.message : String(stateErr)
				}`,
			);
		}
		return true;
	}

	/**
	 * Judge this host's channels against what the daemon reports holding.
	 *
	 * `agent` is the connection that reported them. When it has `hub-identity`,
	 * everything it listed belongs to this hub (#127), so one this hub does not
	 * know is its own orphan and is destroyed. Without that capability the
	 * list may hold other hubs' channels, and anything unknown is left alone.
	 */
	reconcileChannelState(
		hostId: string,
		states: AgentChannelStateMessage[],
		agent?: AgentConnection,
	): void {
		if (agent !== undefined && hasHubIdentity(agent)) {
			this.destroyOrphans(hostId, states, agent);
		}
		const reportedIds = new Set(states.filter((s) => s.alive).map((s) => s.channelId));

		for (const [channelId, channelState] of this.ctx.channels) {
			if (channelState.hostId !== hostId) continue;

			const session = this.ctx.sessions.get(hostId);
			if (!session) continue;

			if (reportedIds.has(channelId)) {
				// The agent is holding it, so it is alive whichever session it was
				// opened under: a daemon that outlived the hub hands back terminals
				// from a session this run did not start (#79). Adopting it here is
				// what makes the session it now belongs to the one it is in.
				channelState.sessionId = session.id;
				// A pane attached while the host was out of reach was answered
				// from the spool, and says it is not connected. The channel was
				// already live, so nothing changed, and nothing told that pane the
				// terminal could now be reached: it stayed on "Not connected"
				// until pressed again. Its clients are told, as a stdio reconnect
				// already tells them in reAttachChannels (#556).
				if (
					channelState.status === "orphan" ||
					(channelState.status === "live" && channelState.clients.size > 0)
				) {
					this.broadcaster.updateChannelStatus(channelId, session.id, "live");
				}
			} else {
				// And the other way: the agent has no such terminal, so it is gone
				// — again whichever session it came from. Skipping those left a
				// channel nothing would ever judge, showing an empty pane with no
				// overlay, no message, and nothing to do about it.
				// One already dead says nothing new, but it is forgotten all the
				// same: it is the one most likely to have been left behind by an
				// earlier judgement, and so the one still on the snapshot timer.
				if (channelState.status !== "dead") {
					this.broadcaster.updateChannelStatus(channelId, channelState.sessionId, "dead");
				}
				this.clearElevationForChannel(channelId);
				this.forgetChannel(channelId);
			}
		}
	}

	/**
	 * Destroy what a daemon holds for this hub that this hub does not know.
	 *
	 * Only an agent with `hub-identity` reaches here, and it reports only this
	 * hub's channels, so nothing else will ever claim one this hub does not
	 * know: a SPAWN whose answer was lost, a terminal closed while the daemon
	 * was out of reach. Left alone, each keeps a shell running that nothing
	 * can see, until the daemon itself stops.
	 *
	 * Known means tracked here, whatever host it is filed under — two host
	 * entries can reach one daemon — or recorded as not yet dead. A terminal
	 * this hub has declared dead is its to end.
	 */
	private destroyOrphans(
		hostId: string,
		states: AgentChannelStateMessage[],
		agent: AgentConnection,
	): void {
		const orphans = states
			.map((state) => state.channelId)
			.filter((channelId) => {
				if (this.ctx.channels.has(channelId)) return false;
				const recorded = this.ctx.metaDal.getChannel(channelId);
				return recorded === undefined || recorded.status === "dead";
			});
		if (orphans.length === 0) return;
		for (const channelId of orphans) {
			agent.send({ type: "DESTROY", channelId } satisfies DestroyMessage);
		}
		this.ctx.hubLogger?.log("info", "channel-lifecycle: destroyed orphan terminals", {
			hostId,
			count: orphans.length,
		});
		this.ctx.hubLogger?.log("debug", "channel-lifecycle: orphan terminals destroyed", {
			hostId,
			channelIds: orphans,
		});
	}

	// ─── Private elevation helpers ────────────────────────────────────────────

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

	private _buildPromptAuth(
		client: WsClient,
		owner?: ElevationPromptOwner,
	): import("./ssh-agent.js").AuthPromptFn {
		return async (hostId, promptType, message) => {
			// ── Elevation PromptContext path ──────────────────────────────────────
			// Each call opens a dedicated elevation context (kind="elevation") with a
			// fresh ULID as its id, owned by the requesting client.  The context is
			// cleared (via clearContext) on timeout or on the abort/close paths wired
			// by the caller (restartChannel already cleans up via the spawn path).
			// The elevation cache write happens in the caller after the secret is returned.
			// openContext generates its own ULID for "elevation" kind (acqId is only
			// used for "session" kind).  Capture the returned context's id as the
			// canonical contextId for all subsequent prompt() / clearContext() calls.
			const context = openContext(this.ctx, "elevation", hostId, client.id);
			const elevationCtxId = context.id;
			if (owner) {
				trackElevationContext(this.ctx, elevationCtxId, owner);
			}

			// Base payload — promptCtx() merges the real promptId + deliveryEpoch at send time.
			const promptMsgBase: AuthPromptMessage = {
				type: "AUTH_PROMPT",
				hostId,
				promptType,
				message,
				promptId: "", // placeholder; overwritten by prompt()
			};

			// send callback: resolve the owner client at send time and throw on
			// delivery failure so prompt() can clean up the stored prompt.
			const send = (routeClientId: string, msg: Record<string, unknown>) => {
				const target = this.ctx.clients.get(routeClientId);
				if (!target) throw new Error("prompt route client disconnected");
				target.send(msg as unknown as AuthPromptMessage);
			};

			// prompt() arms the timeout, stores the in-flight entry, and returns a
			// Promise resolved by respond() when the response arrives.
			// null is returned on context.state === "CLOSED" (race guard).
			const resultPromise = promptCtx(
				this.ctx,
				elevationCtxId,
				"elevation",
				promptMsgBase,
				send,
				60_000, // original elevation timeout: 60s (matches legacy _buildPromptAuth)
			);

			// If prompt() returned null (context already CLOSED), fail cleanly.
			if (resultPromise === null) {
				clearContext(this.ctx, elevationCtxId);
				return null;
			}

			const result = await resultPromise;

			// Context is self-cleaning after prompt resolves (clearPrompt removes the
			// in-flight entry); clear the context shell itself when the prompt settles.
			clearContext(this.ctx, elevationCtxId);

			return result as string | null;
		};
	}

	private clearElevationForSession(sessionId: string): void {
		clearElevationContextsForSession(this.ctx, sessionId, (routeClientId, msg) => {
			this.ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
		});
	}

	private clearElevationForChannel(channelId: string): void {
		clearElevationContextsForChannel(this.ctx, channelId, (routeClientId, msg) => {
			this.ctx.clients.get(routeClientId)?.send(msg as unknown as ProtocolMessage);
		});
	}
}
