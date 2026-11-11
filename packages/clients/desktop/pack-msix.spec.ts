/**
 * The MSIX staging of msix/pack-msix.ps1: what Tauri installs beside the
 * executable, its bundle.resources, lands at the package root (#889, #936).
 *
 * The script finds its inputs from its own directory, so a copy of it runs in
 * a fixture tree with -SkipBuild -StageOnly: nothing is built or packed. It
 * runs in PowerShell 7, as the release does, out of reach of any Windows SDK:
 * PATH names an empty directory and ProgramFiles(x86) is unset, the two places
 * the script looks for one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../../hub/src/temp-dir.fixture.js";

const SCRIPT = fileURLToPath(new URL("msix/pack-msix.ps1", import.meta.url));
/** A guard against a hang, not a measure: PowerShell takes a second or two to start. */
const TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

/**
 * A desktop package tree holding the script, what its staging copies, and
 * `resources` (a file in src-tauri → its bytes) as tauri.conf.json's
 * bundle.resources mapping each to `targets`' entry.
 */
function fixture(resources: Record<string, Buffer>, targets: Record<string, string>): string {
	// The long form of the path, which the script's messages carry.
	const root = realpathSync.native(makeTempDir("lasterm-pack-msix-"));
	tempDirs.push(root);
	const file = (path: string, bytes: string | Buffer) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), bytes);
	};
	file("msix/pack-msix.ps1", readFileSync(SCRIPT));
	file("msix/Package.appxmanifest", "<Package />");
	file("src-tauri/Cargo.toml", '[package]\nname = "fixture-desktop"\n');
	file("src-tauri/target/x86_64-pc-windows-msvc/release/fixture-desktop.exe", "desktop");
	file("src-tauri/lasterm-hub-x86_64-pc-windows-msvc.exe", "hub");
	file("src-tauri/lasterm-agent-x86_64-pc-windows-msvc.exe", "agent");
	for (const [source, bytes] of Object.entries(resources)) file(`src-tauri/${source}`, bytes);
	file(
		"src-tauri/tauri.conf.json",
		JSON.stringify({ version: "1.2.3", bundle: { resources: targets } }),
	);
	return root;
}

/** PowerShell 7's absolute path, found on this PATH, so that the script can run with another. */
function pwsh(): string {
	const where = spawnSync("where.exe", ["pwsh"], { encoding: "utf8" });
	const path = where.stdout?.split(/\r?\n/)[0];
	if (where.status !== 0 || !path) {
		throw new Error(`pwsh (PowerShell 7) runs pack-msix.ps1, as the release does: ${where.stderr}`);
	}
	return path;
}

/** Runs the fixture's script to its staging: `staged`, or the message it stopped with. */
function stage(root: string): { status: number | null; output: string } {
	const script = join(root, "msix", "pack-msix.ps1").replace(/'/g, "''");
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!["path", "programfiles(x86)"].includes(name.toLowerCase())) env[name] = value;
	}
	env.PATH = join(root, "no-tools");
	mkdirSync(env.PATH);
	const run = spawnSync(
		pwsh(),
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`try { & '${script}' -SkipBuild -StageOnly; 'staged' } catch { 'refused: ' + $_.Exception.Message; exit 1 }`,
		],
		{ encoding: "utf8", env, timeout: TIMEOUT_MS },
	);
	if (run.error) throw run.error;
	return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe.skipIf(process.platform !== "win32")("pack-msix.ps1 -StageOnly", () => {
	it(
		"stages the executables, the manifest and each of bundle.resources at its target, with their bytes",
		() => {
			const hubLock = Buffer.from("the hub lock addon");
			const tlsIdentity = Buffer.from("the TLS identity addon");
			const root = fixture(
				{ "hub_lock.node": hubLock, "tls_identity.node": tlsIdentity },
				{
					"hub_lock.node": "lasterm_hub_lock.node",
					"tls_identity.node": "lasterm_tls_identity.node",
				},
			);

			const run = stage(root);

			expect(run.output).toMatch(/^staged$/m);
			expect(run.status, run.output).toBe(0);
			const staged = join(root, "msix", "out", "stage");
			expect(readFileSync(join(staged, "fixture-desktop.exe"), "utf8")).toBe("desktop");
			expect(readFileSync(join(staged, "lasterm-hub.exe"), "utf8")).toBe("hub");
			expect(readFileSync(join(staged, "lasterm-agent.exe"), "utf8")).toBe("agent");
			expect(readFileSync(join(staged, "AppxManifest.xml"), "utf8")).toBe("<Package />");
			expect(readFileSync(join(staged, "lasterm_hub_lock.node"))).toEqual(hubLock);
			expect(readFileSync(join(staged, "lasterm_tls_identity.node"))).toEqual(tlsIdentity);
		},
		TIMEOUT_MS,
	);

	it(
		"refuses an empty resource, the placeholder a lint build leaves",
		() => {
			const root = fixture(
				{
					"hub_lock.node": Buffer.from("the hub lock addon"),
					"tls_identity.node": Buffer.alloc(0),
				},
				{
					"hub_lock.node": "lasterm_hub_lock.node",
					"tls_identity.node": "lasterm_tls_identity.node",
				},
			);

			const run = stage(root);

			expect(run.output).toContain(
				`refused: ${join(root, "src-tauri", "tls_identity.node")} is empty, a placeholder rather than the hub's addon. Place the files the hub was built with (dist\\sea) in src-tauri, as scripts\\build-desktop.ps1 does.`,
			);
			expect(run.status).toBe(1);
		},
		TIMEOUT_MS,
	);
});
