import { createPublicKey, timingSafeEqual, X509Certificate } from "node:crypto";
import { Agent, type RequestOptions } from "node:https";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";

export interface HubTlsRuntime {
	readonly port: number;
	/** Base64 DER SubjectPublicKeyInfo for the TLS identity serving this port. */
	readonly spki?: string;
}

/** Node's Agent callback always receives a Duplex, including an error path. */
type ConnectionCallback = (error: Error | null, socket: Duplex) => void;

/** A peer completed TLS but proved a key other than the runtime pin. */
export const HUB_TLS_PIN_MISMATCH_CODE = "ERR_HUB_TLS_PIN_MISMATCH";

/** Lets callers distinguish an identity refusal from an unavailable transport. */
export class HubTlsPinMismatchError extends Error {
	readonly code = HUB_TLS_PIN_MISMATCH_CODE;

	constructor() {
		super("Hub TLS peer SPKI does not match runtime.json; refusing to connect");
		this.name = "HubTlsPinMismatchError";
	}
}

/** The runtime record does not say which hub to accept, so nothing was dialled. */
export const HUB_RUNTIME_UNUSABLE_CODE = "ERR_HUB_RUNTIME_UNUSABLE";

/**
 * A refusal made before connecting: the record is what is wrong, not the peer,
 * and no amount of waiting for the hub changes it.
 */
export class HubRuntimeUnusableError extends Error {
	readonly code = HUB_RUNTIME_UNUSABLE_CODE;

	constructor(message: string) {
		super(message);
		this.name = "HubRuntimeUnusableError";
	}
}

/** A TCP peer accepted the connection but did not finish TLS in time. */
export const HUB_TLS_HANDSHAKE_TIMEOUT_CODE = "ERR_HUB_TLS_HANDSHAKE_TIMEOUT";

/**
 * Maximum time from starting a TLS connection until its peer has proved the
 * recorded key. Three seconds leaves substantial headroom for a local hub under
 * load, while ensuring a TCP peer that never completes TLS cannot strand a
 * caller indefinitely.
 */
export const HUB_TLS_HANDSHAKE_TIMEOUT_MS = 3_000;

/**
 * Create the only TLS agent used for same-user hub requests. It withholds its
 * socket from HTTP until the completed, non-resumed TLS handshake has proved
 * possession of the runtime record's exact leaf SPKI.
 *
 * It keeps no socket alive, so Node asks the hub to close each connection
 * unless the request says `Connection: keep-alive`. A request should say it:
 * the agent then closes the connection once the answer is in, instead of the
 * hub right after writing it, which can cost the answer its end (`requestHub`).
 */
export function createHubTlsAgent(
	runtime: HubTlsRuntime,
	handshakeTimeoutMs = HUB_TLS_HANDSHAKE_TIMEOUT_MS,
): Agent {
	const expectedSpki = expectedHubSpki(runtime);
	const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
	agent.createConnection = makeHubTlsConnector(expectedSpki, handshakeTimeoutMs);
	return agent;
}

/**
 * Build an asynchronous Agent connector. It intentionally returns undefined:
 * Node receives the socket only through its callback after pin verification.
 */
export function createHubTlsConnector(
	runtime: HubTlsRuntime,
	handshakeTimeoutMs = HUB_TLS_HANDSHAKE_TIMEOUT_MS,
) {
	return makeHubTlsConnector(expectedHubSpki(runtime), handshakeTimeoutMs);
}

function makeHubTlsConnector(expectedSpki: Buffer, handshakeTimeoutMs: number) {
	if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1) {
		throw new Error("Hub TLS handshake timeout must be a positive integer");
	}
	return (options: RequestOptions, callback?: ConnectionCallback): undefined => {
		if (callback === undefined) {
			throw new Error("Hub TLS connector requires an Agent callback");
		}

		let completed = false;
		let handshakeTimer: NodeJS.Timeout | undefined;
		const complete = (error: Error | null, socket: tls.TLSSocket) => {
			if (completed) return;
			completed = true;
			if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
			if (error !== null) {
				socket.destroy();
				callback(error, socket);
				return;
			}
			callback(null, socket);
		};

		const { host, path, port: configuredPort, ...connectionOptions } = options;
		const port = typeof configuredPort === "string" ? Number(configuredPort) : configuredPort;
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
			const socket = new tls.TLSSocket(new Socket());
			socket.destroy();
			callback(new Error("Hub TLS endpoint could not be reached: no usable TCP port"), socket);
			return undefined;
		}
		const tlsOptions: tls.ConnectionOptions = {
			...connectionOptions,
			...(typeof path === "string" ? { path } : {}),
			...(typeof host === "string" ? { host } : {}),
			port,
			// Certificate authorization and name matching are deliberately not part
			// of this transport's identity predicate. TLS still verifies the
			// server's handshake signature before secureConnect.
			rejectUnauthorized: false,
			checkServerIdentity: () => undefined,
			// A resumed session has no CertificateVerify or leaf certificate to pin.
			// The agent also disables its session cache, making resumption impossible.
			session: undefined,
		};
		const socket = tls.connect(tlsOptions);
		handshakeTimer = setTimeout(() => {
			complete(
				Object.assign(
					new Error(
						`Hub TLS endpoint could not be reached: TLS handshake timed out after ${handshakeTimeoutMs}ms`,
					),
					{ code: HUB_TLS_HANDSHAKE_TIMEOUT_CODE },
				),
				socket,
			);
		}, handshakeTimeoutMs);
		socket.once("error", (error) => {
			complete(withHubTransportContext(error), socket);
		});
		socket.once("secureConnect", () => {
			const peerCertificate = socket.getPeerCertificate(true);
			const pinError = verifyHubPeerSpki(expectedSpki, peerCertificate.raw);
			if (pinError !== undefined) {
				complete(pinError, socket);
				return;
			}
			complete(null, socket);
		});
		return undefined;
	};
}

/** Preserve conventional Node socket error codes alongside hub-specific context. */
function withHubTransportContext(error: Error): Error {
	const contextualError = new Error(`Hub TLS endpoint could not be reached: ${error.message}`, {
		cause: error,
	});
	if ("code" in error && typeof error.code === "string") {
		Object.assign(contextualError, { code: error.code });
	}
	return contextualError;
}

export function verifyHubPeerSpki(
	expectedSpki: Buffer,
	peerCertificateDer: Buffer | undefined,
): Error | undefined {
	try {
		if (peerCertificateDer === undefined || peerCertificateDer.length === 0) {
			return new HubTlsPinMismatchError();
		}
		const peerSpki = new X509Certificate(peerCertificateDer).publicKey.export({
			type: "spki",
			format: "der",
		});
		if (peerSpki.length !== expectedSpki.length || !timingSafeEqual(peerSpki, expectedSpki)) {
			return new HubTlsPinMismatchError();
		}
		return undefined;
	} catch {
		return new HubTlsPinMismatchError();
	}
}

function expectedHubSpki(runtime: HubTlsRuntime): Buffer {
	if (typeof runtime.spki !== "string" || runtime.spki.length === 0) {
		throw new HubRuntimeUnusableError("Hub runtime has no usable TLS SPKI; refusing to connect");
	}
	try {
		const expectedSpki = Buffer.from(runtime.spki, "base64");
		if (expectedSpki.length === 0 || expectedSpki.toString("base64") !== runtime.spki) {
			throw new Error("non-canonical SPKI");
		}
		createPublicKey({ key: expectedSpki, format: "der", type: "spki" });
		return expectedSpki;
	} catch {
		throw new HubRuntimeUnusableError("Hub runtime has no usable TLS SPKI; refusing to connect");
	}
}
