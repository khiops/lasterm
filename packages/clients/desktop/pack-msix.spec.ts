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
const MARKER_CHECK = fileURLToPath(new URL("msix/assert-release-binary.ps1", import.meta.url));
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
/**
 * The headers of a PE file for `machine` (0x8664 is x64), all the staging's check
 * reads: "MZ", the offset of "PE\0\0" at 0x3C, then the machine field.
 */
function peHeader(machine: number): Buffer {
	const bytes = Buffer.alloc(0x46);
	bytes.write("MZ", 0, "latin1");
	bytes.writeInt32LE(0x40, 0x3c);
	bytes.write("PE\0\0", 0x40, "latin1");
	bytes.writeUInt16LE(machine, 0x44);
	return bytes;
}

function fixture(
	resources: Record<string, Buffer>,
	targets: Record<string, string>,
	binaries: { desktop?: string; hub?: string } = {},
	explorer: { command?: Buffer | null; besideDesktop?: Buffer } = {},
): string {
	// The long form of the path, which the script's messages carry.
	const root = realpathSync.native(makeTempDir("lasterm-pack-msix-"));
	tempDirs.push(root);
	const file = (path: string, bytes: string | Buffer) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), bytes);
	};
	file("msix/pack-msix.ps1", readFileSync(SCRIPT));
	file("msix/assert-release-binary.ps1", readFileSync(MARKER_CHECK));
	file("msix/Package.appxmanifest", "<Package />");
	file("src-tauri/Cargo.toml", '[package]\nname = "fixture-desktop"\n');
	file(
		"src-tauri/target/x86_64-pc-windows-msvc/release/fixture-desktop.exe",
		binaries.desktop ?? "desktop",
	);
	file("src-tauri/lasterm-hub-x86_64-pc-windows-msvc.exe", binaries.hub ?? "hub");
	file("src-tauri/lasterm-agent-x86_64-pc-windows-msvc.exe", "agent");
	// File Explorer's command (#1236): a valid x64 header unless the test says otherwise.
	const command = explorer.command === undefined ? peHeader(0x8664) : explorer.command;
	if (command !== null) file("src-tauri/lasterm_explorer_command.dll", command);
	if (explorer.besideDesktop !== undefined) {
		file(
			"src-tauri/target/x86_64-pc-windows-msvc/release/lasterm_explorer_command.dll",
			explorer.besideDesktop,
		);
	}
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
function stage(root: string, flags = ""): { status: number | null; output: string } {
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
			`try { & '${script}' -SkipBuild -StageOnly ${flags}; 'staged' } catch { 'refused: ' + $_.Exception.Message; exit 1 }`,
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
			expect(readFileSync(join(staged, "lasterm_explorer_command.dll"))).toEqual(peHeader(0x8664));
		},
		TIMEOUT_MS,
	);

	it(
		"stages File Explorer's command from src-tauri even when a file of its name sits beside the desktop",
		() => {
			const command = Buffer.concat([peHeader(0x8664), Buffer.from("the command")]);
			const root = fixture({}, {}, {}, { command, besideDesktop: Buffer.from("another dll") });

			const run = stage(root);

			expect(run.status, run.output).toBe(0);
			expect(
				readFileSync(join(root, "msix", "out", "stage", "lasterm_explorer_command.dll")),
			).toEqual(command);
		},
		TIMEOUT_MS,
	);

	for (const [what, command, message] of [
		["missing", null, "Required file not found:"],
		["empty", Buffer.alloc(0), "is empty. Build it with scripts\\build-explorer-command.ps1"],
		["not x64", peHeader(0xaa64), "expected x64/AMD64 0x8664"],
	] as const) {
		it(
			`refuses File Explorer's command when it is ${what}`,
			() => {
				const root = fixture({}, {}, {}, { command });

				const run = stage(root);

				expect(run.output).toContain(message);
				expect(run.status).toBe(1);
			},
			TIMEOUT_MS,
		);
	}

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

// The release guard (#1084): with -Release, the desktop and the hub must both
// carry the release channel's marker and not the dev one's.
describe.skipIf(process.platform !== "win32")("pack-msix.ps1 -Release", () => {
	const RELEASE = "bytes lasterm-build-channel:release bytes";
	const DEV = "bytes lasterm-build-channel:dev bytes";
	const BOTH = "lasterm-build-channel:release lasterm-build-channel:dev";
	const ADDONS = {
		resources: {
			"hub_lock.node": Buffer.from("the hub lock addon"),
			"tls_identity.node": Buffer.from("the TLS identity addon"),
		},
		targets: {
			"hub_lock.node": "lasterm_hub_lock.node",
			"tls_identity.node": "lasterm_tls_identity.node",
		},
	};

	function run(desktop: string, hub: string, flags: string) {
		const root = fixture(ADDONS.resources, ADDONS.targets, { desktop, hub });
		return { root, ...stage(root, flags) };
	}

	// Mutations: the guard checks only the hub (a, c, c3), only the desktop
	// (b, c2, c4), refuses only on a dev marker (c, c2), accepts on the release
	// marker alone (c3, c4).
	it.each([
		["a dev desktop with a release hub", DEV, RELEASE, "desktop"],
		["a release desktop with a dev hub", RELEASE, DEV, "hub"],
		["a desktop with no marker", "desktop", RELEASE, "desktop"],
		["a hub with no marker", RELEASE, "hub", "hub"],
		["a desktop carrying both markers", BOTH, RELEASE, "desktop"],
		["a hub carrying both markers", RELEASE, BOTH, "hub"],
	])(
		"refuses %s",
		(_case, desktop, hub, refused) => {
			const { root, status, output } = run(desktop, hub, "-Release");
			const file =
				refused === "desktop"
					? join(
							root,
							"src-tauri",
							"target",
							"x86_64-pc-windows-msvc",
							"release",
							"fixture-desktop.exe",
						)
					: join(root, "src-tauri", "lasterm-hub-x86_64-pc-windows-msvc.exe");
			expect(output).toContain(`refused: ${file} is not a release-channel build`);
			expect(status).toBe(1);
		},
		TIMEOUT_MS,
	);

	it(
		"stages a release desktop and a release hub",
		() => {
			const { status, output } = run(RELEASE, RELEASE, "-Release");
			expect(output).toMatch(/^staged$/m);
			expect(status, output).toBe(0);
		},
		TIMEOUT_MS,
	);

	// Mutation: the guard active without -Release.
	it(
		"stages development binaries without -Release",
		() => {
			const { status, output } = run(DEV, DEV, "");
			expect(output).toMatch(/^staged$/m);
			expect(status, output).toBe(0);
		},
		TIMEOUT_MS,
	);
});
