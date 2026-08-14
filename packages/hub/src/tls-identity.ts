import { X509Certificate } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TlsConfig } from "@lasterm/shared";
import {
	detectSea,
	extractAddonToDir,
	getAddonCacheDir,
} from "@lasterm/shared/dist/sea-addon-loader.js";

const GENERATED_KEY_NAME = "hub-tls-key.pem";
export const GENERATED_CERTIFICATE_CACHE_NAME = "hub-tls-generated-cert.pem";
export const HUB_TLS_CERTIFICATE_NAME = "hub-tls-cert.pem";
const SEA_ASSET_NAME = "lasterm_tls_identity.node";

interface GeneratedTlsIdentity {
	readonly certificatePem?: string;
	readonly certificate_pem?: string;
	readonly spki: Buffer;
}

interface TlsIdentityAddon {
	generateTlsIdentity?(
		keyPath: string,
		certificatePath: string,
		legacyCertificatePath?: string,
	): GeneratedTlsIdentity;
	generate_tls_identity?(
		keyPath: string,
		certificatePath: string,
		legacyCertificatePath?: string,
	): GeneratedTlsIdentity;
}

export interface HubTlsIdentity {
	readonly tls: { cert: string; key: string };
	readonly certificate: string;
	/** Base64 DER SubjectPublicKeyInfo, persisted with the endpoint it identifies. */
	readonly spki: string;
}

export function getHubCertificatePath(stateDir: string): string {
	return join(stateDir, HUB_TLS_CERTIFICATE_NAME);
}

export function getGeneratedCertificateCachePath(stateDir: string): string {
	return join(stateDir, GENERATED_CERTIFICATE_CACHE_NAME);
}

/**
 * Resolve an operator pair or generate the local identity. In both cases, the
 * effective public certificate is placed beside runtime.json for same-user CLI
 * callers to use as their per-request trust anchor.
 */
export function resolveHubTlsIdentity(stateDir: string, configured: TlsConfig): HubTlsIdentity {
	if (configured.certificatePath !== undefined) {
		const certificate = readFileSync(configured.certificatePath, "utf8");
		const key = readFileSync(configured.keyPath, "utf8");
		persistCertificate(stateDir, certificate);
		return { tls: { cert: certificate, key }, certificate, spki: certificateSpki(certificate) };
	}

	const keyPath = join(stateDir, GENERATED_KEY_NAME);
	const generated = generateTlsIdentity(
		loadTlsIdentityAddon(),
		keyPath,
		getGeneratedCertificateCachePath(stateDir),
		getHubCertificatePath(stateDir),
	);
	const certificate = generated.certificatePem ?? generated.certificate_pem;
	if (certificate === undefined) throw new Error("TLS identity addon returned no certificate");
	persistCertificate(stateDir, certificate);
	return {
		tls: { cert: certificate, key: readFileSync(keyPath, "utf8") },
		certificate,
		spki: generated.spki.toString("base64"),
	};
}

export function certificateSpki(certificate: string): string {
	return new X509Certificate(certificate).publicKey
		.export({ type: "spki", format: "der" })
		.toString("base64");
}

function persistCertificate(stateDir: string, certificate: string): void {
	const certificatePath = getHubCertificatePath(stateDir);
	writeFileSync(certificatePath, certificate, { encoding: "utf8", mode: 0o600 });
	chmodSync(certificatePath, 0o600);
}

function loadTlsIdentityAddon(): TlsIdentityAddon {
	if (detectSea()) return loadSeaAddon();
	const override = process.env.LASTERM_TLS_IDENTITY_ADDON;
	const addonPath = override && override.length > 0 ? override : localAddonPath();
	return dlopenAddon(addonPath);
}

function loadSeaAddon(): TlsIdentityAddon {
	const req = createRequire(import.meta.url);
	const sea = req("node:sea") as {
		getRawAsset: (name: string) => ArrayBuffer;
		getAsset?: (name: string, encoding: BufferEncoding) => string;
	};
	let version = "0.0.0";
	try {
		version = sea.getAsset?.("VERSION", "utf8").trim() || version;
	} catch {
		// The version only determines the extraction cache path.
	}
	const addonPath = extractAddonToDir(
		SEA_ASSET_NAME,
		getAddonCacheDir(version),
		Buffer.from(sea.getRawAsset(SEA_ASSET_NAME)),
	);
	return dlopenAddon(addonPath);
}

function localAddonPath(): string {
	const extension = platform() === "win32" ? ".dll" : platform() === "darwin" ? ".dylib" : ".so";
	const filename =
		platform() === "win32" ? "lasterm_tls_identity.dll" : `liblasterm_tls_identity${extension}`;
	const sourceDir = dirname(fileURLToPath(import.meta.url));
	const targetDir = process.env.CARGO_TARGET_DIR ?? resolve(sourceDir, "../../../target");
	return resolve(targetDir, "release", filename);
}

function dlopenAddon(addonPath: string): TlsIdentityAddon {
	const mod = { exports: {} as Record<string, unknown> };
	process.dlopen(mod, addonPath);
	const addon = mod.exports as Partial<TlsIdentityAddon>;
	if (
		typeof addon.generateTlsIdentity !== "function" &&
		typeof addon.generate_tls_identity !== "function"
	) {
		throw new Error(`TLS identity addon at ${addonPath} does not export generate_tls_identity`);
	}
	return addon as TlsIdentityAddon;
}

/** napi-rs camel-cases the Rust export for JavaScript while retaining its Rust name. */
function generateTlsIdentity(
	addon: TlsIdentityAddon,
	keyPath: string,
	certificatePath: string,
	legacyCertificatePath: string,
): GeneratedTlsIdentity {
	const generate = addon.generateTlsIdentity ?? addon.generate_tls_identity;
	if (generate === undefined) throw new Error("TLS identity addon has no generator");
	return generate(keyPath, certificatePath, legacyCertificatePath);
}
