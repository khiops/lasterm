import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { TlsConfig } from "@lasterm/shared";
import { installedAddonPath, loadInstalledAddon } from "@lasterm/shared/dist/installed-addon.js";
import { detectSea } from "@lasterm/shared/dist/sea-addon-loader.js";
import { cargoTargetDir } from "./cargo-target-dir.js";

/** The addon's name beside the single executable (#889). */
export const TLS_IDENTITY_ADDON = "lasterm_tls_identity.node";

interface GeneratedTlsIdentity {
	readonly certificatePem?: string;
	readonly certificate_pem?: string;
	readonly spki: Buffer;
	readonly keyPath?: string;
	readonly key_path?: string;
}

interface TlsIdentityAddon {
	generateTlsIdentity?(identityDirectory: string): GeneratedTlsIdentity;
	generate_tls_identity?(identityDirectory: string): GeneratedTlsIdentity;
}

export interface HubTlsIdentity {
	readonly tls: { cert: string; key: string };
	readonly certificate: string;
	/** Base64 DER SubjectPublicKeyInfo, persisted with the endpoint it identifies. */
	readonly spki: string;
}

/** Resolve an operator pair or generate the local identity. */
export function resolveHubTlsIdentity(stateDir: string, configured: TlsConfig): HubTlsIdentity {
	if (configured.certificatePath !== undefined) {
		const certificate = readFileSync(configured.certificatePath, "utf8");
		const key = readFileSync(configured.keyPath, "utf8");
		return { tls: { cert: certificate, key }, certificate, spki: certificateSpki(certificate) };
	}

	const generated = generateTlsIdentity(loadTlsIdentityAddon(), stateDir);
	const certificate = generated.certificatePem ?? generated.certificate_pem;
	if (certificate === undefined) throw new Error("TLS identity addon returned no certificate");
	const keyPath = generated.keyPath ?? generated.key_path;
	if (keyPath === undefined) throw new Error("TLS identity addon returned no private-key path");
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

function loadTlsIdentityAddon(): TlsIdentityAddon {
	if (detectSea()) {
		// The single executable loads the addon installed beside it, once its
		// descriptor shows the bytes the executable's manifest records.
		const exports = loadInstalledAddon(TLS_IDENTITY_ADDON);
		return asTlsIdentityAddon(exports, installedAddonPath(TLS_IDENTITY_ADDON));
	}
	const override = process.env.LASTERM_TLS_IDENTITY_ADDON;
	const addonPath = override && override.length > 0 ? override : localAddonPath();
	return dlopenAddon(addonPath);
}

function localAddonPath(): string {
	const extension = platform() === "win32" ? ".dll" : platform() === "darwin" ? ".dylib" : ".so";
	const filename =
		platform() === "win32" ? "lasterm_tls_identity.dll" : `liblasterm_tls_identity${extension}`;
	return join(cargoTargetDir(), "release", filename);
}

function dlopenAddon(addonPath: string): TlsIdentityAddon {
	const mod = { exports: {} as Record<string, unknown> };
	process.dlopen(mod, addonPath);
	return asTlsIdentityAddon(mod.exports, addonPath);
}

function asTlsIdentityAddon(exports: Record<string, unknown>, source: string): TlsIdentityAddon {
	const addon = exports as Partial<TlsIdentityAddon>;
	if (
		typeof addon.generateTlsIdentity !== "function" &&
		typeof addon.generate_tls_identity !== "function"
	) {
		throw new Error(`TLS identity addon at ${source} does not export generate_tls_identity`);
	}
	return addon as TlsIdentityAddon;
}

/** napi-rs camel-cases the Rust export for JavaScript while retaining its Rust name. */
function generateTlsIdentity(
	addon: TlsIdentityAddon,
	identityDirectory: string,
): GeneratedTlsIdentity {
	const generate = addon.generateTlsIdentity ?? addon.generate_tls_identity;
	if (generate === undefined) throw new Error("TLS identity addon has no generator");
	return generate(identityDirectory);
}
