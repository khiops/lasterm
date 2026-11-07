/**
 * Key auth, signed by the SSH agent when it holds the key (#876).
 *
 * A host on key auth names a private key file. When that file needs a
 * passphrase and the running agent holds the same key, the agent signs and no
 * passphrase is asked, as OpenSSH uses the agent's copy of an `IdentityFile`
 * key. The identity the server sees stays the configured one; only the signer
 * changes:
 *
 * - **Only that key is offered** (`ConfiguredKeyAgent`), as `IdentitiesOnly
 *   yes` would: the agent's other keys would change who logs in, and spend the
 *   server's `MaxAuthTries`.
 * - **Its public half is read without the passphrase:** from the public
 *   section an `openssh-key-v1` file keeps in clear, or else from `<key>.pub`.
 *   A legacy PEM key without `.pub` cannot be matched, and keeps its prompt.
 * - **Nothing is written to the agent:** it is asked for its identities and
 *   for signatures, never to add or remove a key.
 * - **`IdentityAgent none`** in the block of the host's `~/.ssh/config` alias
 *   keeps the agent out of it.
 *
 * A key that needs no passphrase is signed from its file, as before: there is
 * nothing to spare the person, and an agent that refused to sign could not be
 * stepped around without overriding its answer.
 *
 * An agent that is gone, no longer holds the key, or does not sign, ends that
 * connection (`agentSignerFailure`): it is closed, the passphrase is asked
 * for, and the host dialled again with the file, as a refused password is
 * (#815). Not within the same connection: a passphrase is asked before
 * anything is dialled (SECURITY.md § 3.3c).
 *
 * Kept apart from `ssh-agent.ts`, which many specs replace whole.
 */

import { readFileSync } from "node:fs";
import ssh2, {
	BaseAgent,
	type ConnectConfig,
	createAgent,
	type IdentityCallback,
	type ParsedKey,
	type SignCallback,
	type SigningRequestOptions,
} from "ssh2";
import { identityAgentIsNone } from "../ssh/ssh-config-parser.js";
import { AskAgainError } from "./ask-again.js";
import { sshAgentAddress, windowsAgentPipeExists } from "./ssh-agent-address.js";

/**
 * How long the agent has to list its keys before a connection. One that does
 * not answer in time is left out, and the passphrase asked for as before.
 */
const AGENT_LIST_TIMEOUT_MS = 3_000;

const OPENSSH_KEY_MAGIC = Buffer.from("openssh-key-v1\0", "latin1");

/** Why the agent did not sign: it could not be reached, no longer held the key, or refused. */
export type AgentSignerFailure = "unreachable" | "lacks_key" | "refused";

/** Which signer a key-auth connection authenticated with, as the security log says it. */
export type KeySigner = "agent" | "file";

/** A key's SSH wire form, or null for what ssh2 does not read as a key. */
function wireForm(data: unknown): Buffer | null {
	const candidate =
		typeof data === "object" && data !== null && !Buffer.isBuffer(data) && "pubKey" in data
			? (data as { pubKey: unknown }).pubKey
			: data;
	if (typeof candidate !== "string" && !Buffer.isBuffer(candidate) && !isParsedKey(candidate)) {
		return null;
	}
	const parsed = ssh2.utils.parseKey(candidate);
	if (parsed instanceof Error) return null;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return key ? key.getPublicSSH() : null;
}

function isParsedKey(value: unknown): value is ParsedKey {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { getPublicSSH?: unknown }).getPublicSSH === "function"
	);
}

/**
 * The public key an `openssh-key-v1` private key file keeps in clear, encrypted
 * or not, or null for any other file.
 */
function opensshPublicSection(keyContent: Buffer): Buffer | null {
	const armored =
		/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
			keyContent.toString("utf8"),
		);
	if (!armored?.[1]) return null;
	const raw = Buffer.from(armored[1].replace(/\s+/g, ""), "base64");
	if (!raw.subarray(0, OPENSSH_KEY_MAGIC.length).equals(OPENSSH_KEY_MAGIC)) return null;
	let offset = OPENSSH_KEY_MAGIC.length;
	const readString = (): Buffer | null => {
		if (offset + 4 > raw.length) return null;
		const length = raw.readUInt32BE(offset);
		offset += 4;
		if (offset + length > raw.length) return null;
		const value = raw.subarray(offset, offset + length);
		offset += length;
		return value;
	};
	// The cipher, the KDF and its options, then the number of keys: ssh-keygen
	// writes one.
	if (readString() === null || readString() === null || readString() === null) return null;
	if (offset + 4 > raw.length || raw.readUInt32BE(offset) !== 1) return null;
	offset += 4;
	const publicKey = readString();
	return publicKey === null ? null : wireForm(publicKey);
}

/**
 * The public half of the key file at `keyPath`, read without its passphrase,
 * in SSH wire form: from the file itself when it is an `openssh-key-v1` key,
 * which keeps it in clear and cannot disagree with itself, or else from
 * `<keyPath>.pub`. Null when neither gives one, as for a legacy PEM key
 * without `.pub`.
 */
export function configuredPublicKey(keyPath: string, keyContent: Buffer): Buffer | null {
	const inFile = opensshPublicSection(keyContent);
	if (inFile !== null) return inFile;
	let pub: Buffer;
	try {
		pub = readFileSync(`${keyPath}.pub`);
	} catch {
		return null;
	}
	return wireForm(pub);
}

/**
 * The SSH agent, seen through the one key a host is configured with: it lists
 * that key alone, when the agent holds it, and signs with nothing else. It has
 * no `getStream`, so nothing forwards the agent through it, and it asks the
 * agent nothing but its identities and signatures.
 */
export class ConfiguredKeyAgent extends BaseAgent<ParsedKey> {
	/**
	 * Why the agent did not sign on the connection it serves now, or null. Each
	 * connection starts by listing the agent's keys, which clears it.
	 */
	failure: AgentSignerFailure | null = null;

	private readonly identity: ParsedKey;

	/** `publicKey` is the configured key's wire form, as `configuredPublicKey` gives it. */
	constructor(
		private readonly agent: BaseAgent,
		private readonly publicKey: Buffer,
	) {
		super();
		const parsed = ssh2.utils.parseKey(publicKey);
		if (parsed instanceof Error) throw parsed;
		this.identity = Array.isArray(parsed) ? parsed[0] : parsed;
	}

	private isConfigured(key: unknown): boolean {
		return wireForm(key)?.equals(this.publicKey) === true;
	}

	getIdentities(cb: IdentityCallback<ParsedKey>): void {
		this.failure = null;
		this.agent.getIdentities((err, keys) => {
			if (err) {
				this.failure = "unreachable";
				cb(err);
				return;
			}
			if (!(keys ?? []).some((entry) => this.isConfigured(entry))) {
				this.failure = "lacks_key";
				cb(null, []);
				return;
			}
			cb(null, [this.identity]);
		});
	}

	sign(pubKey: ParsedKey, data: Buffer, options: SigningRequestOptions, cb?: SignCallback): void;
	sign(pubKey: ParsedKey, data: Buffer, cb: SignCallback): void;
	sign(
		pubKey: ParsedKey,
		data: Buffer,
		optionsOrCb: SigningRequestOptions | SignCallback,
		maybeCb?: SignCallback,
	): void {
		const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
		const options = typeof optionsOrCb === "function" ? {} : optionsOrCb;
		if (!this.isConfigured(pubKey)) {
			this.failure = "refused";
			cb?.(new Error("Only the key this host is configured with is signed with"));
			return;
		}
		this.agent.sign(pubKey, data, options, (err, signature) => {
			if (err || !signature) {
				this.failure = "refused";
				cb?.(err ?? new Error("The SSH agent did not sign"));
				return;
			}
			cb?.(null, signature);
		});
	}
}

/** The agent's keys, as the signer lists them, or why they were not listed in time. */
function listWithin(signer: ConfiguredKeyAgent, timeoutMs: number): Promise<ParsedKey[] | Error> {
	return new Promise((resolve) => {
		const timer = setTimeout(
			() => resolve(new Error(`no answer within ${timeoutMs / 1000} s`)),
			timeoutMs,
		);
		signer.getIdentities((err, keys) => {
			clearTimeout(timer);
			resolve(err ? err : ((keys ?? []) as ParsedKey[]));
		});
	});
}

/**
 * The agent, as the signer of the key file at `keyPath` (`displayPath` as the
 * host names it), when it is reachable and holds that key: asked before
 * anything is dialled, so that whether the passphrase is needed is known
 * before the connection. Null otherwise: no public key without the passphrase,
 * no agent, `IdentityAgent none` for `sshConfigHost`, or an agent that does
 * not hold the key or does not answer.
 */
export async function agentSignerFor(
	keyPath: string,
	displayPath: string,
	keyContent: Buffer,
	sshConfigHost: string | null | undefined,
): Promise<ConfiguredKeyAgent | null> {
	const publicKey = configuredPublicKey(keyPath, keyContent);
	if (publicKey === null) return null;
	const address = sshAgentAddress({
		env: process.env,
		platform: process.platform,
		pipeExists: windowsAgentPipeExists,
	});
	if (address === null) return null;
	if (sshConfigHost && identityAgentIsNone(sshConfigHost)) {
		console.error(
			`[lasterm-ssh] IdentityAgent none for ${sshConfigHost} in ~/.ssh/config: the SSH agent is not asked`,
		);
		return null;
	}
	const signer = new ConfiguredKeyAgent(createAgent(address), publicKey);
	const listed = await listWithin(signer, AGENT_LIST_TIMEOUT_MS);
	if (listed instanceof Error) {
		console.error(`[lasterm-ssh] could not ask the SSH agent for its keys: ${listed.message}`);
		return null;
	}
	if (listed.length === 0) {
		console.error(`[lasterm-ssh] the SSH agent does not hold ${displayPath}`);
		return null;
	}
	console.error(`[lasterm-ssh] the SSH agent holds ${displayPath}: it signs, nothing is asked`);
	return signer;
}

/** What decrypts each signer's key file instead, once the agent did not sign. */
const fileFallbacks = new WeakMap<ConfiguredKeyAgent, () => Promise<void>>();

/**
 * Authenticate `config` with `signer`. `decryptFile` asks for the key file's
 * passphrase and puts the file into `config` in the agent's place: it is what
 * `agentSignerFailure` hands back when the agent does not sign.
 */
export function signWithAgent(
	config: ConnectConfig,
	signer: ConfiguredKeyAgent,
	decryptFile: () => Promise<void>,
): void {
	config.agent = signer;
	fileFallbacks.set(signer, decryptFile);
}

/** The agent did not sign with the configured key: its file is decrypted, and the host dialled again. */
export class AgentSignerFailedError extends AskAgainError {
	constructor(
		readonly failure: AgentSignerFailure,
		askAgain: () => Promise<void>,
	) {
		super(
			failure === "unreachable"
				? "The SSH agent could not be reached"
				: failure === "lacks_key"
					? "The SSH agent no longer holds the key"
					: "The SSH agent did not sign with the key",
			askAgain,
		);
		this.name = "AgentSignerFailedError";
	}
}

/**
 * Why the connection `config` authenticated ended for want of the agent's
 * signature, as an error whose `askAgain` decrypts the key file, or null when
 * that is not why: no agent signer, or one that did sign.
 *
 * `config` may be a copy of the one `signWithAgent` was given: the file goes
 * into that one all the same.
 */
export function agentSignerFailure(config: { agent?: unknown }): AgentSignerFailedError | null {
	const signer = config.agent;
	if (!(signer instanceof ConfiguredKeyAgent) || signer.failure === null) return null;
	const decryptFile = fileFallbacks.get(signer);
	if (decryptFile === undefined) return null;
	const failure = signer.failure;
	return new AgentSignerFailedError(failure, async () => {
		console.error(`[lasterm-ssh] the SSH agent did not sign (${failure}): decrypting the key file`);
		await decryptFile();
	});
}

/**
 * The signer of the key-auth connection `config` authenticated, or null for
 * another method.
 */
export function keySignerOf(config: { agent?: unknown; privateKey?: unknown }): KeySigner | null {
	if (config.agent instanceof ConfiguredKeyAgent) return "agent";
	return config.privateKey !== undefined ? "file" : null;
}
