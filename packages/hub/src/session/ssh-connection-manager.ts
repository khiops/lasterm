/**
 * SshConnectionManager — SSH-specific connection logic:
 *   - auth prompt request/response
 *   - host key mismatch verification
 *   - reconnect with exponential backoff
 *   - test connectivity
 */

import type {
	AgentBinaryVerifyMessage,
	AuthPromptMessage,
	HostArch,
	HostOs,
	HostVerifyMessage,
	TestConnectMessage,
} from "@termora/shared";
import { Client as SshClient } from "ssh2";
import type { AgentConnectionManager } from "./agent-connection-manager.js";
import { type BinaryVerifyPromptFn, getBinaryCacheDir } from "./agent-deployer.js";
import type { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import {
	clearContext,
	isReconnectContextId,
	openContext,
	pickReconnectRouteCandidate,
	pickRouteCandidate,
	prompt as promptCtx,
	reconnectSessionId,
	respond as respondCtx,
} from "./prompt-context.js";
import { captureQuitFence } from "./quit-fence.js";
import type { PromptContext, SharedSessionContext } from "./session-context.js";
import type { WsClient } from "./session-manager.js";
import {
	type AuthPromptFn,
	buildSshConnectConfig,
	SshAgent,
	type SshAgentDeployOptions,
} from "./ssh-agent.js";
import type { StateBroadcaster } from "./state-broadcaster.js";

/** Reconnect backoff steps in ms (capped at 30s, total budget 5 min) */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const RECONNECT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
const HOST_KEY_MISMATCH_TIMEOUT_MS = 30_000; // original 30 s timeout for host-key + agent-binary verify
const AUTH_PROMPT_TIMEOUT_MS = 120_000; // 2 min — unanswered prompt must not wedge the host
type PendingPromptEntry =
	SharedSessionContext["pendingPrompts"] extends Map<string, infer P> ? P : never;

export class SshConnectionManager {
	constructor(
		private readonly ctx: SharedSessionContext,
		private readonly broadcaster: StateBroadcaster,
		private readonly lifecycle: ChannelLifecycleManager,
		private readonly agentMgr: AgentConnectionManager,
	) {}

	private _authPromptWireType(
		promptEntry: PendingPromptEntry | undefined,
	): "password" | "passphrase" | "elevation" | undefined {
		const promptType = (promptEntry?.resendPayload as { promptType?: unknown } | undefined)
			?.promptType;
		if (promptType === "password" || promptType === "passphrase" || promptType === "elevation") {
			return promptType;
		}
		return undefined;
	}

	private _isCacheableSessionPassphrase(promptEntry: PendingPromptEntry | undefined): boolean {
		if (promptEntry?.type !== "passphrase") return false;
		const contextId = promptEntry.contextId;
		const context = contextId ? this.ctx.promptContexts.get(contextId) : undefined;
		return context?.kind === "session" && this._authPromptWireType(promptEntry) === "passphrase";
	}

	private _cacheAcceptedPassphrase(
		promptEntry: PendingPromptEntry | undefined,
		fallbackHostId: string,
		secret: string | null,
		rememberSession: boolean | undefined,
	): void {
		if (secret === null || !this._isCacheableSessionPassphrase(promptEntry)) return;
		const ttl = rememberSession === true ? 15 * 60 * 1000 : 60 * 1000;
		this.ctx.passphraseCache.set(promptEntry?.hostId ?? fallbackHostId, {
			secret,
			expiresAt: Date.now() + ttl,
		});
	}

	private _resolveLegacyAuthPromptId(clientId: string, hostId: string): string | null {
		const matches: string[] = [];
		for (const [, context] of this.ctx.promptContexts) {
			if (context.state !== "OPEN") continue;
			if (context.hostId !== hostId) continue;
			if (context.routeClientId !== clientId) continue;

			for (const promptId of context.prompts) {
				const promptEntry = this.ctx.pendingPrompts.get(promptId);
				if (promptEntry?.hostId !== hostId) continue;
				if (promptEntry.type !== "passphrase" && promptEntry.type !== "elevation") continue;
				matches.push(promptId);
			}
		}

		if (matches.length === 1) return matches[0] ?? null;

		this.ctx.hubLogger?.log("warn", "ssh-connection: AUTH_PROMPT_RESPONSE ignored", {
			hostId,
			clientId,
			reason: matches.length === 0 ? "no_matching_prompt" : "ambiguous_prompt",
			matchCount: matches.length,
		});
		return null;
	}

	private _getOrOpenSessionPromptContext(
		contextId: string | undefined,
		hostId: string,
		client: WsClient,
	): PromptContext | null {
		if (contextId === undefined) {
			if (!this.ctx.clients.has(client.id)) return null;
			return openContext(this.ctx, "session", hostId, client.id);
		}

		const existing = this.ctx.promptContexts.get(contextId);
		if (existing && existing.state === "OPEN") {
			if (this.ctx.clients.has(existing.routeClientId)) return existing;
			const candidate = pickRouteCandidate(this.ctx, contextId, existing.routeClientId);
			if (!candidate) {
				clearContext(this.ctx, contextId);
				return null;
			}
			existing.routeClientId = candidate;
			return existing;
		}

		if (isReconnectContextId(contextId)) {
			const sessionId = reconnectSessionId(contextId);
			if (!sessionId) return null;
			const candidate = pickReconnectRouteCandidate(this.ctx, hostId, sessionId);
			if (!candidate) return null;
			return openContext(this.ctx, "session", hostId, candidate, contextId);
		}

		if (!this.ctx.clients.has(client.id)) return null;
		return openContext(this.ctx, "session", hostId, client.id, contextId);
	}

	// ─── Auth prompt ─────────────────────────────────────────────────────────

	buildPromptAuth(client: WsClient, signal?: AbortSignal, acqId?: string): AuthPromptFn {
		return async (hostId, promptType, message) => {
			// Cache hit: return cached passphrase without prompting the UI
			if (promptType === "passphrase") {
				const cached = this.ctx.passphraseCache.get(hostId);
				console.error(
					`[termora-ssh] passphrase cache lookup for ${hostId}: ${cached ? "hit" : "miss"}`,
				);
				if (cached) {
					if (cached.expiresAt > Date.now()) {
						console.error(
							`[termora-ssh] returning cached passphrase (length ${cached.secret.length})`,
						);
						return cached.secret;
					}
					// Expired — evict and fall through to prompt
					this.ctx.passphraseCache.delete(hostId);
				}
			}
			// If the connect was already aborted before we even arm a prompt, bail immediately.
			if (signal?.aborted) return null;

			const context = this._getOrOpenSessionPromptContext(acqId, hostId, client);
			if (!context) return null;
			const clearOnSettle = acqId === undefined;

			// Base payload — prompt() will merge the real promptId + deliveryEpoch at send time.
			const promptMsgBase: AuthPromptMessage = {
				type: "AUTH_PROMPT",
				hostId,
				promptType,
				message,
				promptId: "", // placeholder; prompt() overwrites with the real promptId
			};

			// send callback: resolve the client from ctx at send time so retargeted
			// sends (after a clientDisconnect retarget) reach the new route owner.
			const send = (routeClientId: string, msg: Record<string, unknown>) => {
				const target = this.ctx.clients.get(routeClientId);
				if (!target) throw new Error("prompt route client disconnected");
				target.send(msg as unknown as AuthPromptMessage);
			};

			const abortListener = () => clearContext(this.ctx, context.id, send);
			signal?.addEventListener("abort", abortListener, { once: true });
			try {
				const result = await promptCtx(
					this.ctx,
					context.id,
					"passphrase",
					promptMsgBase,
					send,
					AUTH_PROMPT_TIMEOUT_MS,
				);
				return result as string | null;
			} finally {
				signal?.removeEventListener("abort", abortListener);
				if (clearOnSettle) {
					clearContext(this.ctx, context.id, send);
				}
			}
		};
	}

	handleAuthPromptResponse(
		clientId: string,
		hostId: string,
		secret: string | null,
		rememberSession?: boolean,
		promptId?: string,
		deliveryEpoch?: number,
	): void {
		// ── promptId path (new web clients that echo promptId) ───────────────────
		// respond() enforces SEC-003 (clientId === routeClientId) and optionally
		// epoch. On accept we cache only real session passphrase prompts.
		if (promptId !== undefined) {
			// Read the pending prompt before respond() clears it; cache eligibility
			// depends on the prompt's owning context kind and wire promptType.
			const pp = this.ctx.pendingPrompts.get(promptId);
			const accepted = respondCtx(this.ctx, promptId, clientId, deliveryEpoch, secret);
			if (accepted) this._cacheAcceptedPassphrase(pp, hostId, secret, rememberSession);
			return;
		}

		// ── Back-compat path (old clients without promptId) ──────────────────────
		// Resolve only an exact single in-flight passphrase/elevation prompt for this
		// host that is addressable by this route client.
		const resolvedPromptId = this._resolveLegacyAuthPromptId(clientId, hostId);

		if (resolvedPromptId !== null) {
			// Route via PromptContext ops (SEC-003 enforced inside respond()).
			const pp = this.ctx.pendingPrompts.get(resolvedPromptId);
			const accepted = respondCtx(this.ctx, resolvedPromptId, clientId, undefined, secret);
			if (accepted) this._cacheAcceptedPassphrase(pp, hostId, secret, rememberSession);
			return;
		}

		return;
	}

	// ─── Host key mismatch ────────────────────────────────────────────────────

	/**
	 * Send HOST_VERIFY to the client and wait (30 s timeout) for HOST_VERIFY_RESPONSE.
	 * Returns the action chosen by the user.
	 * @param firstConnect - true for TOFU (first connection), false for mismatch.
	 */
	async promptHostKeyVerify(
		client: WsClient,
		hostId: string,
		hostname: string,
		oldFingerprint: string,
		newFingerprint: string,
		firstConnect = false,
		ownerAcqId?: string,
	): Promise<"trust_permanent" | "trust_once" | "reject"> {
		const context = this._getOrOpenSessionPromptContext(ownerAcqId, hostId, client);
		if (!context) return "reject";
		const clearOnSettle = ownerAcqId === undefined;

		// Base payload — promptId will be overridden by prompt() with the real ULID.
		const verifyMsgBase: Omit<HostVerifyMessage, "promptId"> & { promptId: string } = {
			type: "HOST_VERIFY",
			hostId,
			fingerprint: newFingerprint,
			algorithm: "SHA256",
			...(oldFingerprint ? { oldFingerprint } : {}),
			promptId: "", // placeholder; prompt() overwrites with the real promptId
			...(firstConnect ? { firstConnect: true } : {}),
		};

		// send callback: prompt() merges promptId + deliveryEpoch onto the payload,
		// then passes the routeClientId. Resolve the client from ctx at send time so
		// retargeted sends (after a clientDisconnect retarget) reach the new owner.
		const send = (routeClientId: string, msg: Record<string, unknown>) => {
			const target = this.ctx.clients.get(routeClientId);
			if (!target) throw new Error("prompt route client disconnected");
			target.send(msg as unknown as HostVerifyMessage);
		};

		const result = await promptCtx(
			this.ctx,
			context.id,
			"host_verify",
			verifyMsgBase,
			send,
			HOST_KEY_MISMATCH_TIMEOUT_MS,
		);
		if (clearOnSettle) {
			clearContext(this.ctx, context.id, send);
		}

		// promptCtx resolves null on timeout (clearContext / send failure).
		if (result === null) {
			this.ctx.hubLogger?.log("warn", "ssh-connection: HOST_VERIFY timeout, rejecting", {
				hostId,
				hostname,
			});
			return "reject";
		}
		return result as "trust_permanent" | "trust_once" | "reject";
	}

	/**
	 * Resolve a pending host-key-mismatch prompt.
	 * Called by WsHandler when HOST_VERIFY_RESPONSE arrives from the UI.
	 */
	handleHostVerifyResponse(
		promptId: string,
		action: "trust_permanent" | "trust_once" | "reject",
		clientId: string,
	): void {
		// Delegate to the PromptContext ops. respond() enforces:
		//   - SEC-003: clientId must match context.routeClientId (current route owner)
		//   - Guard B: ignored if context is CLOSED
		//   - Guard D (epoch): skipped here — HOST_VERIFY_RESPONSE carries no deliveryEpoch
		//     yet (back-compat path; epoch enforcement added when web echoes it).
		// Returns false silently when rejected (wrong client, unknown promptId, etc.).
		respondCtx(this.ctx, promptId, clientId, undefined, action);
	}

	// ─── Agent binary verify ──────────────────────────────────────────────────

	buildBinaryVerifyPrompt(client: WsClient, ownerAcqId?: string): BinaryVerifyPromptFn {
		return async (
			hostId: string,
			hostname: string,
			remotePath: string,
			remoteSha256: string,
			os: HostOs,
			arch: HostArch,
			mismatch: boolean,
			pinnedSha256?: string,
		): Promise<"trust_permanent" | "trust_once" | "reject"> => {
			const context = this._getOrOpenSessionPromptContext(ownerAcqId, hostId, client);
			if (!context) return "reject";
			const clearOnSettle = ownerAcqId === undefined;

			// Base payload — prompt() merges the real promptId + deliveryEpoch at send time.
			const verifyMsgBase: Omit<AgentBinaryVerifyMessage, "promptId"> & { promptId: string } = {
				type: "AGENT_BINARY_VERIFY",
				promptId: "", // placeholder; prompt() overwrites with the real promptId
				hostId,
				hostname,
				remotePath,
				remoteSha256,
				os,
				arch,
				mismatch,
				...(pinnedSha256 ? { pinnedSha256 } : {}),
			};

			// send callback: resolve the client from ctx at send time so retargeted sends
			// (after a clientDisconnect retarget) reach the new route owner.
			const send = (routeClientId: string, msg: Record<string, unknown>) => {
				const target = this.ctx.clients.get(routeClientId);
				if (!target) throw new Error("prompt route client disconnected");
				target.send(msg as unknown as AgentBinaryVerifyMessage);
			};

			const result = await promptCtx(
				this.ctx,
				context.id,
				"agent_verify",
				verifyMsgBase,
				send,
				HOST_KEY_MISMATCH_TIMEOUT_MS,
			);
			if (clearOnSettle) {
				clearContext(this.ctx, context.id, send);
			}

			// promptCtx resolves null on timeout (clearContext / send failure).
			if (result === null) {
				this.ctx.hubLogger?.log("warn", "ssh-connection: AGENT_BINARY_VERIFY timeout, rejecting", {
					hostname,
				});
				return "reject";
			}
			return result as "trust_permanent" | "trust_once" | "reject";
		};
	}

	handleAgentVerifyResponse(
		promptId: string,
		action: "trust_permanent" | "trust_once" | "reject",
		clientId: string,
	): void {
		// Delegate to the PromptContext ops. respond() enforces:
		//   - SEC-003: clientId must match context.routeClientId (current route owner)
		//   - Guard B: ignored if context is CLOSED
		//   - Guard D (epoch): skipped here — AGENT_BINARY_VERIFY_RESPONSE carries no
		//     deliveryEpoch yet (back-compat path; epoch enforcement added when web echoes it).
		// Returns false silently when rejected (wrong client, unknown promptId, etc.).
		respondCtx(this.ctx, promptId, clientId, undefined, action);
	}

	/**
	 * Build a cache-only AuthPromptFn for use during non-interactive reconnects.
	 * Returns the cached passphrase if present and unexpired.
	 * On cache miss, throws with a distinct internal reason so callers surface a
	 * meaningful diagnostic rather than the generic "Authentication cancelled"
	 * message — the error still propagates fail-closed (backoff retry / closeSession).
	 * No secret material is included in the error message.
	 */
	buildCacheOnlyPromptAuth(hostId: string): AuthPromptFn {
		return async (_hid, promptType, _message) => {
			if (promptType !== "passphrase") return null;
			const cached = this.ctx.passphraseCache.get(hostId);
			if (cached && cached.expiresAt > Date.now()) {
				return cached.secret;
			}
			// Evict the expired entry so it doesn't linger in memory past TTL.
			// Mirror the interactive buildPromptAuth path which also deletes on expiry.
			if (cached) {
				this.ctx.passphraseCache.delete(hostId);
			}
			throw new Error("no cached passphrase for non-interactive reconnect");
		};
	}

	// ─── Reconnect ────────────────────────────────────────────────────────────

	scheduleReconnect(
		hostId: string,
		sessionId: string,
		attemptIndex: number,
		startTime: number,
	): void {
		// This can be called directly from an agent "close" listener. A quit refusal
		// is normal control flow there, not an exception escaping the listener.
		if (this.ctx.quitState === "QUITTING") return;
		const reconnectFence = captureQuitFence(this.ctx);
		const elapsed = Date.now() - startTime;
		if (elapsed >= RECONNECT_TIMEOUT_MS) {
			this.lifecycle.closeSession(hostId, sessionId);
			return;
		}

		const delayMs =
			RECONNECT_BACKOFF_MS[Math.min(attemptIndex, RECONNECT_BACKOFF_MS.length - 1)] ?? 30_000;

		const timer = setTimeout(async () => {
			this.ctx.reconnectTimers.delete(hostId);

			// Currency check before any async work: bail if session was closed
			// or superseded by a newer session while the timer was pending.
			const session = this.ctx.sessions.get(hostId);
			if (!session || session.status === "closed" || session.id !== sessionId) return;

			const host = this.ctx.metaDal.getHost(hostId);
			if (!host) {
				// Only close if this is still the session we were reconnecting.
				if (this.ctx.sessions.get(hostId)?.id === sessionId) {
					this.lifecycle.closeSession(hostId, sessionId);
				}
				return;
			}

			// Create an AbortController for this in-flight attempt and register it so
			// closeSession() can abort a start() that is still awaiting the SSH handshake.
			// Invariant 10: the controller is identity-checked so a stale abort cannot
			// clobber a newer reconnect attempt that replaced this one.
			//
			// Abort-before-overwrite: if a prior reconnect attempt registered a controller
			// for this host but never cleared it (e.g. overwritten by a second reconnect
			// path racing in), abort it now so its pending auth prompt is cleared at
			// handoff time — preventing an orphaned PromptContext entry.
			const existingAc = this.ctx.reconnectAbortControllers.get(hostId);
			if (existingAc) existingAc.abort();
			const ac = new AbortController();
			this.ctx.reconnectAbortControllers.set(hostId, ac);

			try {
				const binaryCache = getBinaryCacheDir();
				const pinnedSha256 = this.ctx.metaDal.getHostAgentSha256(hostId);
				const sessionTrustedAgentSha = this.ctx.trustedAgentSha256.get(hostId);
				const sshHostname = host.sshHost?.includes("@")
					? (host.sshHost.split("@")[1] ?? host.sshHost)
					: (host.sshHost ?? host.label);

				const deployOpts: SshAgentDeployOptions = {
					binaryCache,
					hostname: sshHostname,
					...(pinnedSha256 != null ? { pinnedSha256 } : {}),
					...(sessionTrustedAgentSha != null
						? { sessionTrustedSha256: sessionTrustedAgentSha }
						: {}),
					onOsDetected: (hid, os, arch) => {
						this.ctx.metaDal.updateHostOsArch(hid, os, arch);
					},
					// No promptBinaryVerify — reconnect is non-interactive.
					// If binary is untrusted, deploy will throw AGENT_BINARY_UNTRUSTED
					// and reconnect will retry or give up (existing retry logic).
					onAgentPinned: (hid, sha256) => {
						this.ctx.metaDal.updateHostAgentSha256(hid, sha256);
					},
					onAgentTrustOnce: (hid, sha256) => {
						this.ctx.trustedAgentSha256.set(hid, sha256);
					},
				};

				const sshAgent = new SshAgent(
					host,
					this.buildCacheOnlyPromptAuth(hostId),
					deployOpts,
					this.ctx.agentConfig,
				);
				const storedFp = this.ctx.metaDal.getHostFingerprint(hostId);
				const hostKey = `${sshHostname}:${host.sshPort ?? 22}`;
				const sessionFp = this.ctx.trustedOnceFingerprints.get(hostKey);

				// Thread the abort signal into start() so closeSession() can cancel mid-handshake.
				await sshAgent.start(storedFp, sessionFp, ac.signal);

				// Post-await currency/abort re-check (invariant 10).
				// closeSession() may have fired while start() was awaiting the SSH handshake.
				// Do NOT wire/store/reAttach if the session is no longer current or was aborted.
				if (
					ac.signal.aborted ||
					this.ctx.reconnectAbortControllers.get(hostId) !== ac ||
					this.ctx.sessions.get(hostId)?.id !== sessionId
				) {
					sshAgent.close();
					return;
				}

				// Clear the controller — attempt settled successfully.
				this.ctx.reconnectAbortControllers.delete(hostId);

				this.broadcaster.updateSessionStatus(hostId, sessionId, "active");
				this.agentMgr.wireAgentEvents(hostId, sessionId, sshAgent);
				this.ctx.commits.adoptAgent(reconnectFence, hostId, sshAgent);

				this.lifecycle.reAttachChannels(hostId, sessionId, sshAgent);
			} catch {
				// Clear the controller on failure (aborted or real error).
				if (this.ctx.reconnectAbortControllers.get(hostId) === ac) {
					this.ctx.reconnectAbortControllers.delete(hostId);
				}

				// If the attempt was aborted by closeSession(), do nothing — session is already closed.
				if (ac.signal.aborted) return;

				const nextElapsed = Date.now() - startTime;
				if (nextElapsed >= RECONNECT_TIMEOUT_MS) {
					// Only close if this is still the session we were reconnecting.
					if (this.ctx.sessions.get(hostId)?.id === sessionId) {
						this.lifecycle.closeSession(hostId, sessionId);
					}
				} else {
					this.scheduleReconnect(hostId, sessionId, attemptIndex + 1, startTime);
				}
			}
		}, delayMs);
		this.ctx.reconnectTimers.set(hostId, timer);
	}

	// ─── Test connect ─────────────────────────────────────────────────────────

	async handleTestConnect(clientId: string, msg: TestConnectMessage): Promise<void> {
		const client = this.ctx.clients.get(clientId);
		if (!client) return;

		// ── Task 2: Test-connect isolation (invariant 1) ──────────────────────────
		// Open a dedicated "test" PromptContext scoped to this client and this request.
		// A concurrent TEST_CONNECT from another client cannot touch this context.
		// The context is always cleared (via clearContext) on success, failure, or timeout.
		const testCtx = openContext(this.ctx, "test", msg.hostId, clientId);
		const testCtxId = testCtx.id;

		const deliverySend = (routeClientId: string, m: Record<string, unknown>) => {
			const target = this.ctx.clients.get(routeClientId);
			if (!target) throw new Error("prompt route client disconnected");
			target.send(m as unknown as AuthPromptMessage);
		};
		const clearSend = (routeClientId: string, m: Record<string, unknown>) => {
			this.ctx.clients.get(routeClientId)?.send(m as unknown as AuthPromptMessage);
		};

		// Build a promptAuth that uses the "test" PromptContext instead of the legacy path.
		const promptAuth: AuthPromptFn = async (hostId, promptType, message) => {
			const promptMsgBase: AuthPromptMessage = {
				type: "AUTH_PROMPT",
				hostId,
				promptType,
				message,
				promptId: "",
			};

			const result = await promptCtx(
				this.ctx,
				testCtxId,
				"passphrase",
				promptMsgBase,
				deliverySend,
				AUTH_PROMPT_TIMEOUT_MS,
			);
			return result as string | null;
		};

		try {
			const result = await this._testSshConnectivity(msg, promptAuth);
			if (result.ok) {
				client.send({ type: "TEST_CONNECT_OK", hostId: msg.hostId });
			} else {
				client.send({
					type: "TEST_CONNECT_FAIL",
					hostId: msg.hostId,
					message: result.message ?? "Connection failed",
				});
			}
		} catch (err) {
			client.send({
				type: "TEST_CONNECT_FAIL",
				hostId: msg.hostId,
				message: err instanceof Error ? err.message : "Connection test failed",
			});
		} finally {
			// Guard E: clear the test context on every terminal path.
			clearContext(this.ctx, testCtxId, clearSend);
		}
	}

	private async _testSshConnectivity(
		msg: TestConnectMessage,
		promptAuth: AuthPromptFn,
	): Promise<{ ok: boolean; message?: string }> {
		const sshClient = new SshClient();
		const SSH_TEST_TIMEOUT_MS = 10_000;

		const username = msg.sshUser ?? process.env.USER ?? "root";

		let connectConfig: Parameters<InstanceType<typeof SshClient>["connect"]>[0];
		try {
			connectConfig = await buildSshConnectConfig(
				{ method: msg.sshAuth ?? "key", keyPath: msg.sshKeyPath },
				msg.hostname,
				msg.port,
				username,
				promptAuth,
				msg.hostId,
			);
		} catch (err) {
			return {
				ok: false,
				message: err instanceof Error ? err.message : "Authentication error",
			};
		}
		connectConfig.readyTimeout = SSH_TEST_TIMEOUT_MS;

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				sshClient.destroy();
				resolve({ ok: false, message: "Connection timed out" });
			}, SSH_TEST_TIMEOUT_MS);

			sshClient.on("ready", () => {
				clearTimeout(timer);
				sshClient.end();
				resolve({ ok: true });
			});

			sshClient.on("error", (err: Error) => {
				clearTimeout(timer);
				const errMsg = err.message ?? "Unknown error";
				const lower = errMsg.toLowerCase();
				if (
					errMsg.includes("ECONNREFUSED") ||
					errMsg.includes("ETIMEDOUT") ||
					errMsg.includes("EHOSTUNREACH") ||
					errMsg.includes("ENOTFOUND")
				) {
					resolve({ ok: false, message: errMsg });
				} else if (
					lower.includes("authentication") ||
					lower.includes("permission denied") ||
					lower.includes("publickey") ||
					lower.includes("keyboard-interactive") ||
					lower.includes("all configured authentication methods failed")
				) {
					sshClient.end();
					resolve({ ok: false, message: "Authentication failed" });
				} else {
					sshClient.end();
					resolve({ ok: false, message: errMsg });
				}
			});

			try {
				sshClient.connect(connectConfig);
			} catch (err) {
				clearTimeout(timer);
				resolve({
					ok: false,
					message: err instanceof Error ? err.message : "Connection failed",
				});
			}
		});
	}
}
