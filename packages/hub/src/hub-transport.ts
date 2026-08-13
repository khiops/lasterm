import { timingSafeEqual, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface HubTlsRuntime {
	readonly port: number;
	/** Base64 DER SubjectPublicKeyInfo for the TLS identity serving this port. */
	readonly spki?: string;
}

const HUB_TLS_CERTIFICATE_NAME = "hub-tls-cert.pem";

/**
 * Build the TLS options every same-user hub client uses. Certificate-chain
 * validation remains enabled; the recorded DER SPKI is the additional identity
 * predicate, including when an operator-provided certificate bundle is used.
 */
export function hubTlsOptions(runtime: HubTlsRuntime, stateDir: string) {
	if (typeof runtime.spki !== "string" || runtime.spki.length === 0) {
		throw new Error("Hub runtime has no TLS SPKI; refusing to connect");
	}
	const certificate = readFileSync(join(stateDir, HUB_TLS_CERTIFICATE_NAME), "utf8");
	const certificateSpki = new X509Certificate(certificate).publicKey
		.export({ type: "spki", format: "der" })
		.toString("base64");
	if (certificateSpki !== runtime.spki) {
		throw new Error("Hub TLS certificate does not match runtime SPKI; refusing to connect");
	}

	return {
		ca: certificate,
		// Node calls this only after normal certificate validation succeeds. The
		// bundle is not a leaf pin: exact SPKI equality is the identity check.
		checkServerIdentity: (_hostname: string, peerCertificate: { raw: Buffer }) =>
			verifyHubPeerSpki(runtime, peerCertificate.raw),
	};
}

export function verifyHubPeerSpki(
	runtime: HubTlsRuntime,
	peerCertificateDer: Buffer,
): Error | undefined {
	const peerSpki = new X509Certificate(peerCertificateDer).publicKey.export({
		type: "spki",
		format: "der",
	});
	const expectedSpki = Buffer.from(runtime.spki ?? "", "base64");
	if (peerSpki.length !== expectedSpki.length || !timingSafeEqual(peerSpki, expectedSpki)) {
		return new Error("Hub TLS peer SPKI does not match runtime.json; refusing to connect");
	}
	return undefined;
}
