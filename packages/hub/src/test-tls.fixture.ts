import { readFileSync } from "node:fs";
import { join } from "node:path";

type TestTls = { cert: string; key: string };

interface ManifestIdentity {
	readonly certificate: string;
	readonly key: string;
	readonly spki: string;
}

interface TestTlsManifest {
	readonly version: 1;
	readonly artifacts: {
		readonly authority: Omit<ManifestIdentity, "key">;
		readonly pinned: ManifestIdentity;
		readonly other: ManifestIdentity;
		readonly expired: ManifestIdentity;
		readonly server: ManifestIdentity;
	};
}

const TEST_TLS_DIRECTORY_ENV = "LASTERM_TEST_TLS_DIRECTORY";
let material: TestTlsMaterial | undefined;

export interface TestTlsMaterial {
	readonly authority: { certificate: string; spki: string };
	readonly pinned: TestTls & { certificate: string; spki: string };
	readonly other: TestTls & { certificate: string; spki: string };
	readonly expired: TestTls & { certificate: string; spki: string };
	readonly server: TestTls & { certificate: string; spki: string };
}

/** Returns test-only TLS material minted by the Rust test binary for this run. */
export function getTestTlsMaterial(): TestTlsMaterial {
	if (material === undefined) material = loadTestTlsMaterial();
	return material;
}

/** The ordinary hub specs use the dedicated self-signed server identity. */
export function getTestTls(): TestTls {
	const server = getTestTlsMaterial().server;
	return { cert: server.cert, key: server.key };
}

function loadTestTlsMaterial(): TestTlsMaterial {
	const directory = process.env[TEST_TLS_DIRECTORY_ENV];
	if (directory === undefined || directory.length === 0) {
		throw new Error(
			"hub TLS test material is unavailable; run the hub Vitest project so its generator setup executes",
		);
	}
	const manifest = JSON.parse(
		readFileSync(join(directory, "manifest.json"), "utf8"),
	) as TestTlsManifest;
	if (manifest.version !== 1)
		throw new Error("hub TLS test material manifest has an unsupported version");
	return {
		authority: readAuthority(directory, manifest.artifacts.authority),
		pinned: readIdentity(directory, manifest.artifacts.pinned),
		other: readIdentity(directory, manifest.artifacts.other),
		expired: readIdentity(directory, manifest.artifacts.expired),
		server: readIdentity(directory, manifest.artifacts.server),
	};
}

function readAuthority(directory: string, identity: Omit<ManifestIdentity, "key">) {
	return { certificate: readFile(directory, identity.certificate), spki: identity.spki };
}

function readIdentity(directory: string, identity: ManifestIdentity) {
	return {
		cert: readFile(directory, identity.certificate),
		key: readFile(directory, identity.key),
		certificate: readFile(directory, identity.certificate),
		spki: identity.spki,
	};
}

function readFile(directory: string, filename: string): string {
	if (!/^[a-z-]+\.pem$/.test(filename)) {
		throw new Error("hub TLS test material manifest names an invalid artifact");
	}
	return readFileSync(join(directory, filename), "utf8");
}
