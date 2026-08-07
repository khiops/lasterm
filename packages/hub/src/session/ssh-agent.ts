import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentConfig, HelloMessage, Host, HostArch, HostOs } from "@lasterm/shared";
import { DEFAULT_AGENT_CONFIG, encodeFrame, type ProtocolMessage } from "@lasterm/shared";
import ssh2, { Client, type ClientChannel, type SyncHostVerifier } from "ssh2";
import { AgentConnection } from "./agent-connection.js";
import {
	type BinaryVerifyPromptFn,
	DeployError,
	type DeployOptions,
	type DeployResult,
	deployAgentIfNeeded,
} from "./agent-deployer.js";
import { SendQueue } from "./send-queue.js";

const HELLO_TIMEOUT_MS = 5_000;
type AgentLoggingConfig = Pick<AgentConfig, "logLevel" | "logFormat">;

/**
 * Result of SSH host key verification, populated by the hostVerifier closure
 * before the Promise resolves/rejects so callers can act on it.
 */
export interface HostKeyVerification {
	/** SHA256:<base64> fingerprint seen during this connect attempt. */
	capturedFingerprint: string;
	/** True when the server presented a key that differs from the stored fingerprint. */
	mismatch: boolean;
	/** True when this is the very first connection (TOFU) — no stored fingerprint yet. */
	tofu: boolean;
}

/** Callback to prompt the user for a secret (password or key passphrase). */
export type AuthPromptFn = (
	hostId: string,
	promptType: "password" | "passphrase" | "elevation",
	message: string,
) => Promise<string | null>;

/**
 * Parse the username and hostname from an sshHost string.
 * Accepts "user@hostname" or just "hostname".
 */
function parseSshHost(sshHost: string): { username: string; hostname: string } {
	const atIdx = sshHost.indexOf("@");
	if (atIdx !== -1) {
		return {
			username: sshHost.slice(0, atIdx),
			hostname: sshHost.slice(atIdx + 1),
		};
	}
	return {
		username: process.env.USER ?? process.env.USERNAME ?? "root",
		hostname: sshHost,
	};
}

function quotePosixShellArg(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteWindowsCmdArg(value: string): string {
	return `"${value.replace(/"/g, '^"')}"`;
}

function quoteRemoteShellArg(value: string, os: HostOs | null): string {
	if (os === "windows") return quoteWindowsCmdArg(value);
	return quotePosixShellArg(value);
}

function buildAgentCommand(
	agentPath: string,
	os: HostOs | null,
	loggingConfig: AgentLoggingConfig,
	includeLoggingArgs: boolean,
): string {
	const args = [quoteRemoteShellArg(agentPath, os), "--stdio"];
	if (includeLoggingArgs) {
		args.push(
			"--log-level",
			quoteRemoteShellArg(loggingConfig.logLevel, os),
			"--format",
			quoteRemoteShellArg(loggingConfig.logFormat, os),
		);
	}
	return args.join(" ");
}

function buildAgentCommandForDeployResult(
	result: DeployResult,
	loggingConfig: AgentLoggingConfig,
): string {
	return buildAgentCommand(result.remotePath, result.os, loggingConfig, result.deployed);
}

/**
 * SshAgent connects to a remote host over SSH, launches `lasterm-agent --stdio`
 * on the remote side, and communicates via length-prefixed MessagePack frames
 * over the SSH channel's stdin/stdout.
 *
 * Usage:
 *   const agent = new SshAgent(host);
 *   await agent.start();           // resolves after HELLO handshake
 *   agent.send({ type: "SPAWN", ... });
 *   agent.on("message", (msg) => { ... });
 *   agent.close();
 */

/**
 * Build the ssh2 ConnectConfig for a given auth method.
 * Throws on missing config or user-cancelled prompts.
 * Call sites that need non-throwing behavior (e.g. test-connect) should catch
 * and convert to their own error representation.
 */
export async function buildSshConnectConfig(
	auth: { method: string; keyPath?: string | undefined },
	hostname: string,
	port: number,
	user: string,
	promptAuth?: AuthPromptFn | undefined,
	hostId?: string | undefined,
): Promise<Parameters<InstanceType<typeof Client>["connect"]>[0]> {
	const connectConfig: Parameters<InstanceType<typeof Client>["connect"]>[0] = {
		host: hostname,
		port,
		username: user,
	};

	if (auth.method === "password") {
		if (!promptAuth || !hostId) {
			throw new Error("password auth not yet supported without promptAuth callback");
		}
		const secret = await promptAuth(hostId, "password", `Enter password for ${user}@${hostname}`);
		if (secret === null) {
			throw new Error("Authentication cancelled by user");
		}
		connectConfig.password = secret;
	} else if (auth.method === "agent") {
		const authSock = process.env.SSH_AUTH_SOCK;
		if (!authSock) {
			throw new Error("SSH_AUTH_SOCK is not set; cannot use agent auth");
		}
		connectConfig.agent = authSock;
	} else {
		// "key" auth — read the private key file
		if (!auth.keyPath) {
			throw new Error("Key path is required for key auth");
		}
		const resolvedPath = auth.keyPath.startsWith("~")
			? auth.keyPath.replace("~", homedir())
			: auth.keyPath;
		const keyContent = readFileSync(resolvedPath);
		// Detect encrypted keys: use ssh2 parseKey which handles both
		// legacy PEM ("ENCRYPTED" header) and modern OpenSSH format
		const parsed = ssh2.utils.parseKey(keyContent);
		if (parsed instanceof Error) {
			console.error(`[lasterm-ssh] key needs passphrase (parseKey error: ${parsed.message})`);
			if (!promptAuth || !hostId) {
				throw new Error("Key is passphrase-protected but no prompt callback available");
			}
			const secret = await promptAuth(hostId, "passphrase", `Enter passphrase for ${auth.keyPath}`);
			console.error(
				`[lasterm-ssh] passphrase obtained: ${secret ? `yes (length ${secret.length})` : "null (cancelled)"}`,
			);
			if (secret === null) {
				throw new Error("Authentication cancelled by user");
			}
			// Pass raw key + passphrase — ssh2 connect() decrypts internally.
			// Verify first that the passphrase works, to give a clear error.
			const verify = ssh2.utils.parseKey(keyContent, secret);
			if (verify instanceof Error) {
				console.error(`[lasterm-ssh] key decryption failed: ${verify.message}`);
				throw new Error(`Failed to decrypt SSH key: ${verify.message}`);
			}
			const verifiedKey = Array.isArray(verify) ? verify[0] : verify;
			console.error(`[lasterm-ssh] key verified (type: ${verifiedKey.type})`);
			connectConfig.privateKey = keyContent;
			connectConfig.passphrase = secret;
			console.error(
				`[lasterm-ssh] connectConfig has privateKey (${keyContent.length}B) + passphrase (${secret.length}ch)`,
			);
		} else {
			connectConfig.privateKey = keyContent;
		}
	}

	return connectConfig;
}

/**
 * Options for auto-deploying the agent binary to a remote host.
 * When provided, SshAgent will attempt to upload the binary via SFTP
 * if lasterm-agent is not found on the remote host after SSH connect.
 */
export interface SshAgentDeployOptions {
	/** Path to the local binary cache directory. */
	binaryCache: string;
	/** Hostname for display in prompts. */
	hostname?: string;
	/** Pinned SHA256 from host record (null = no pin). */
	pinnedSha256?: string | null;
	/** Session-trusted SHA256 (trust_once from earlier connect). */
	sessionTrustedSha256?: string | null;
	/** Called when OS/arch is detected on the remote host. */
	onOsDetected?: (hostId: string, os: HostOs, arch: HostArch) => void;
	/** Called to prompt user for binary trust decision. */
	promptBinaryVerify?: BinaryVerifyPromptFn;
	/** Called when user chose trust_permanent — persist SHA256 to DB. */
	onAgentPinned?: (hostId: string, sha256: string) => void;
	/** Called when user chose trust_once — store in session map. */
	onAgentTrustOnce?: (hostId: string, sha256: string) => void;
	/** Called when remote agent was re-uploaded (SHA256 mismatch with local cache). */
	onAgentUpdated?: (hostId: string) => void;
}

/**
 * Map SshAgentDeployOptions + resolved hostname to the DeployOptions shape
 * expected by deployAgentIfNeeded.
 */
function toDeployOptions(
	opts: SshAgentDeployOptions,
	host: Host,
	resolvedHostname: string,
): DeployOptions {
	return {
		binaryCache: opts.binaryCache,
		hostname: opts.hostname ?? resolvedHostname,
		hostId: host.id,
		...(opts.pinnedSha256 != null ? { pinnedSha256: opts.pinnedSha256 } : {}),
		...(opts.sessionTrustedSha256 != null
			? { sessionTrustedSha256: opts.sessionTrustedSha256 }
			: {}),
		...(opts.promptBinaryVerify !== undefined
			? { promptBinaryVerify: opts.promptBinaryVerify }
			: {}),
		...(opts.onAgentPinned !== undefined ? { onAgentPinned: opts.onAgentPinned } : {}),
		...(opts.onAgentTrustOnce !== undefined ? { onAgentTrustOnce: opts.onAgentTrustOnce } : {}),
		...(opts.onAgentUpdated !== undefined ? { onAgentUpdated: opts.onAgentUpdated } : {}),
	};
}

export class SshAgent extends AgentConnection {
	private client: Client | null = null;
	private channel: ClientChannel | null = null;
	private channelOpen = false;
	private readonly sendQueue = new SendQueue("ssh-agent");
	/**
	 * Populated by the hostVerifier closure during a connect attempt.
	 * Accessible after start() resolves or rejects so callers can inspect mismatch state.
	 */
	lastKeyVerification: HostKeyVerification = {
		capturedFingerprint: "",
		mismatch: false,
		tofu: false,
	};

	constructor(
		private readonly host: Host,
		private readonly promptAuth?: AuthPromptFn,
		private readonly deployOptions?: SshAgentDeployOptions,
		private readonly loggingConfig: AgentLoggingConfig = DEFAULT_AGENT_CONFIG,
	) {
		super();
	}

	/**
	 * Connect to the remote host over SSH, exec `lasterm-agent --stdio`,
	 * and wait for the HELLO handshake.
	 * Rejects if HELLO is not received within 5 seconds.
	 *
	 * @param storedFingerprint - The trusted fingerprint from the DB (null = first connect / TOFU).
	 *   When provided and the server key doesn't match, the connection is rejected and
	 *   the returned HostKeyVerification will have `mismatch: true`.
	 * @param sessionTrustedFingerprint - Fingerprint trusted for this session only (trust_once).
	 * @param signal - Optional AbortSignal. When aborted, the SSH connect is cancelled:
	 *   the underlying ssh2 Client is destroyed and the returned promise rejects with
	 *   an AbortError. Any pending auth prompt for this host is also cleared.
	 */
	async start(
		storedFingerprint?: string | null,
		sessionTrustedFingerprint?: string | null,
		signal?: AbortSignal,
	): Promise<{ hello: HelloMessage; keyVerification: HostKeyVerification }> {
		this.deployedThisSession = false;
		this.remoteMatchesHubVersionCache = false;
		if (!this.host.sshHost) {
			throw new Error("Host has no sshHost configured");
		}

		// Bail early if already aborted before any async work.
		if (signal?.aborted) {
			throw Object.assign(new Error("SSH connect aborted"), { name: "AbortError" });
		}

		const parsed = parseSshHost(this.host.sshHost);
		// Prefer explicit ssh_user from host config over parsed user@host
		const username = this.host.sshUser || parsed.username;
		const hostname = parsed.hostname;
		const port = this.host.sshPort ?? 22;
		const authMethod = this.host.sshAuth ?? "key";
		console.error(`[lasterm-ssh] resolved: ${username}@${hostname}:${port} auth=${authMethod}`);

		const client = new Client();
		this.client = client;

		// If aborted while building the connect config (which may prompt for auth),
		// destroy the client and reject before proceeding.
		const connectConfig = await buildSshConnectConfig(
			{ method: authMethod, keyPath: this.host.sshKeyPath ?? undefined },
			hostname,
			port,
			username,
			this.promptAuth ?? undefined,
			this.host.id,
		);

		if (signal?.aborted) {
			this.cleanup();
			throw Object.assign(new Error("SSH connect aborted"), { name: "AbortError" });
		}

		// TOFU host key verification.
		// The verifier populates this object synchronously before the connect attempt resolves.
		// Also synced to this.lastKeyVerification so callers can inspect it after rejection.
		const keyVerification: HostKeyVerification = {
			capturedFingerprint: "",
			mismatch: false,
			tofu: false,
		};
		this.lastKeyVerification = keyVerification;

		connectConfig.hostVerifier = ((key: Buffer) => {
			const hash = createHash("sha256").update(key).digest("base64");
			const fingerprint = `SHA256:${hash}`;
			keyVerification.capturedFingerprint = fingerprint;

			if (sessionTrustedFingerprint && sessionTrustedFingerprint === fingerprint) {
				// Session-trusted (trust_once): accepted for this hub session, skip TOFU prompt.
				return true;
			}
			if (!storedFingerprint) {
				// TOFU: first connect — signal caller to prompt user for trust decision.
				keyVerification.tofu = true;
				return false;
			}
			if (storedFingerprint === fingerprint) {
				// Known host, fingerprint matches — accept.
				return true;
			}
			// Fingerprint changed — reject so the caller can prompt the user.
			keyVerification.mismatch = true;
			return false;
		}) as SyncHostVerifier;

		console.error(`[lasterm-ssh] connecting...`);
		return new Promise<{ hello: HelloMessage; keyVerification: HostKeyVerification }>(
			(resolve, reject) => {
				let resolved = false;
				const rejectOnce = (err: Error): void => {
					if (resolved) return;
					resolved = true;
					reject(err);
				};

				const resolveOnce = (msg: HelloMessage): void => {
					if (resolved) return;
					resolved = true;
					resolve({ hello: msg, keyVerification });
				};

				// Abort handler: destroy the ssh2 client immediately and reject.
				// Registered with { once: true } so it fires at most once even if abort
				// is already set (addEventListener fires synchronously in that case).
				if (signal) {
					const onAbort = (): void => {
						// client.destroy() terminates the TCP socket immediately without
						// waiting for the SSH close handshake — correct for cancellation.
						try {
							client.destroy();
						} catch {
							// ignore errors during forced teardown
						}
						this.client = null;
						this.channelOpen = false;
						rejectOnce(Object.assign(new Error("SSH connect aborted"), { name: "AbortError" }));
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}

				// Use `on` (not `once`) so subsequent ssh2 error events (e.g.
				// KEY_EXCHANGE_FAILED / { code: 3 } emitted after hostVerifier rejection)
				// are also handled and don't become unhandled EventEmitter throws.
				// rejectOnce is idempotent — only the first call wins.
				client.on("error", (err) => {
					// ssh2 may emit a plain object (e.g. { code: 3 }) rather than an Error
					// instance when hostVerifier returns false. Normalise to a proper Error
					// so callers (and vitest .rejects.toThrow()) always receive an Error.
					if (keyVerification.tofu) {
						// TOFU rejection — caller will prompt user for first-connect trust decision.
						rejectOnce(new Error("SSH_TOFU"));
						return;
					}
					if (keyVerification.mismatch) {
						rejectOnce(
							new Error(
								`Host key mismatch: expected ${storedFingerprint}, got ${keyVerification.capturedFingerprint}`,
							),
						);
						return;
					}
					rejectOnce(err instanceof Error ? err : new Error(String(err)));
				});

				client.on("close", () => {
					this.client = null;
					this.channelOpen = false;
					this.emit("close", undefined);
				});

				client.on("ready", () => {
					console.error("[lasterm-ssh] SSH ready");
					// SEC-014: zero credentials immediately after successful auth
					if (connectConfig.password) connectConfig.password = "";
					if (connectConfig.passphrase) connectConfig.passphrase = "";
					// If aborted between TCP connect and the 'ready' event, tear down and bail.
					if (signal?.aborted) {
						this.cleanup();
						rejectOnce(Object.assign(new Error("SSH connect aborted"), { name: "AbortError" }));
						return;
					}
					// Attach stream handler — called after deploy (or immediately if no deploy needed).
					const runAgent = (agentPath: string): void => {
						// Start HELLO timeout NOW — deploy phase is complete, agent is being exec'd.
						// Timeout is intentionally NOT started earlier so that TOFU binary
						// verification prompts (up to 30s) don't race against this 5s timer.
						const helloTimeout = setTimeout(() => {
							this.cleanup();
							rejectOnce(new Error("Agent HELLO timeout"));
						}, HELLO_TIMEOUT_MS);

						// ssh2 Client — sends command over encrypted SSH channel to remote host
						client.exec(agentPath, (err, stream) => {
							if (err) {
								clearTimeout(helloTimeout);
								rejectOnce(err);
								return;
							}

							this.channel = stream;
							this.channelOpen = true;

							stream.on("data", (data: Buffer) => {
								this.handleData(data);
							});

							stream.on("close", () => {
								clearTimeout(helloTimeout);
								this.sendQueue.clear();
								this.channel = null;
								this.channelOpen = false;
								client.end();
								// If the channel closed before the agent HELLO arrived, the remote
								// command exited (e.g. binary missing / immediate failure). Reject so
								// start() fails fast instead of hanging. rejectOnce is settled-once, so
								// this is a no-op once HELLO has already resolved the normal path.
								rejectOnce(new Error("Agent channel closed before HELLO"));
							});

							stream.on("error", (streamErr: Error) => {
								this.emit("error", streamErr);
							});

							this.sendQueue.attach(stream);

							// Wait for HELLO — emitted by AgentConnection.handleData once HELLO decoded
							this.once("ready", (msg: HelloMessage) => {
								console.error("[lasterm-ssh] agent HELLO received");
								clearTimeout(helloTimeout);
								resolveOnce(msg);
							});
						});
					};

					if (this.deployOptions) {
						// Auto-deploy is best-effort: if it fails, we still try to run the agent
						// (the user may have installed it manually in a non-standard path).
						// DeployError (user-initiated rejection) propagates; infrastructure failures fall back.
						console.error("[lasterm-ssh] deploy phase starting");
						deployAgentIfNeeded(
							client,
							this.host,
							toDeployOptions(this.deployOptions, this.host, hostname),
						)
							.then((result) => {
								this.deployedThisSession = result.deployed;
								this.remoteMatchesHubVersionCache = result.remoteMatchesHubVersionCache;
								// Notify caller if new OS/arch info was detected (either via deploy or detection)
								if (result.os && result.arch) {
									this.deployOptions?.onOsDetected?.(this.host.id, result.os, result.arch);
								}
								// Check abort after the deploy await — deploy can take tens of seconds.
								if (signal?.aborted) {
									this.cleanup();
									rejectOnce(
										Object.assign(new Error("SSH connect aborted"), { name: "AbortError" }),
									);
									return;
								}
								console.error(
									`[lasterm-ssh] deploy result: remotePath=${result.remotePath} os=${result.os ?? "unknown"} arch=${result.arch ?? "unknown"}`,
								);
								console.error("[lasterm-ssh] exec lasterm-agent...");
								runAgent(buildAgentCommandForDeployResult(result, this.loggingConfig));
							})
							.catch((deployErr: unknown) => {
								// User-initiated rejections must propagate — no fallback.
								if (deployErr instanceof DeployError) {
									console.error(
										`[lasterm-ssh] deploy result: rejected by user (${deployErr.code})`,
									);
									this.cleanup();
									rejectOnce(deployErr);
									return;
								}
								// SECURITY: do NOT fall back to running a possibly-unverified binary after a
								// deploy/replacement failure. The deployer may have detected a mismatched or
								// unverifiable remote agent (the binary the replacement was meant to overwrite);
								// exec'ing whatever `lasterm-agent` is on PATH would bypass the integrity/update
								// policy on first-use and unpinned hosts. Reject with a clear error. (A best-effort
								// fallback for manually-installed agents was considered but rejected — running an
								// unverified binary is the larger risk. See #43.)
								const deployErrMsg =
									deployErr instanceof Error ? deployErr.message : String(deployErr);
								console.error(`[lasterm-ssh] deploy result: failed — ${deployErrMsg}`);
								console.warn(
									`[ssh-agent] auto-deploy failed for host ${this.host.id}: ${deployErrMsg}`,
								);
								this.cleanup();
								rejectOnce(new Error(`Agent deployment failed: ${deployErrMsg}`));
							});
					} else {
						console.error("[lasterm-ssh] exec lasterm-agent...");
						runAgent(buildAgentCommand("lasterm-agent", this.host.os, this.loggingConfig, false));
					}
				});

				client.connect(connectConfig);
			},
		);
	}

	/** Send a protocol message to the remote agent via the SSH channel stdin (with backpressure). */
	send(msg: ProtocolMessage): void {
		if (!this.channel || !this.channelOpen) {
			throw new Error("SSH agent not connected");
		}
		this.sendQueue.send(Buffer.from(encodeFrame(msg)));
	}

	/** Close the SSH channel and the underlying SSH connection. */
	async close(): Promise<void> {
		this.cleanup();
	}

	get connected(): boolean {
		return this.client !== null && this.channelOpen;
	}

	private cleanup(): void {
		this.sendQueue.clear();
		if (this.channel) {
			try {
				this.channel.close();
			} catch {
				// ignore errors during cleanup
			}
			this.channel = null;
			this.channelOpen = false;
		}
		if (this.client) {
			try {
				this.client.end();
			} catch {
				// ignore errors during cleanup
			}
			this.client = null;
		}
	}
}
