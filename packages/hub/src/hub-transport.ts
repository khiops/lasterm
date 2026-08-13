import { createPublicKey, timingSafeEqual, X509Certificate } from "node:crypto";
import { Agent, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";

export interface HubTlsRuntime {
	readonly port: number;
	/** Base64 DER SubjectPublicKeyInfo for the TLS identity serving this port. */
	readonly spki?: string;
}

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
		const complete = (error: Error | null, socket?: tls.TLSSocket) => {
			if (completed) return;
			completed = true;
			if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
			if (error !== null) {
				if (socket !== undefined) socket.destroy();
				callback(error, socket as Duplex);
				return;
			}
			callback(null, socket as Duplex);
		};

		const { host, port: configuredPort, ...connectionOptions } = options;
		const port = typeof configuredPort === "string" ? Number(configuredPort) : configuredPort;
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
			callback(
				new Error("Hub TLS endpoint could not be reached: no usable TCP port"),
				undefined as unknown as Duplex,
			);
			return undefined;
		}
		const socket = tls.connect({
			...(connectionOptions as tls.ConnectionOptions),
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
		});
		handshakeTimer = setTimeout(() => {
			complete(
				new Error(
					`Hub TLS endpoint could not be reached: TLS handshake timed out after ${handshakeTimeoutMs}ms`,
				),
				socket,
			);
		}, handshakeTimeoutMs);
		socket.once("error", (error) => {
			complete(
				new Error(`Hub TLS endpoint could not be reached: ${error.message}`, { cause: error }),
				socket,
			);
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
		throw new Error("Hub runtime has no usable TLS SPKI; refusing to connect");
	}
	try {
		const expectedSpki = Buffer.from(runtime.spki, "base64");
		if (expectedSpki.length === 0 || expectedSpki.toString("base64") !== runtime.spki) {
			throw new Error("non-canonical SPKI");
		}
		createPublicKey({ key: expectedSpki, format: "der", type: "spki" });
		return expectedSpki;
	} catch {
		throw new Error("Hub runtime has no usable TLS SPKI; refusing to connect");
	}
}
