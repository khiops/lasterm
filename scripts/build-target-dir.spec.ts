/**
 * The target directory the build scripts hand cargo (#531).
 *
 * Each script runs with `cargo` and `pnpm` replaced by stubs: the cargo stub
 * records its arguments and fails, so nothing is built and the script stops
 * there. As a second guard, RUSTUP_TOOLCHAIN names no toolchain, so a real
 * cargo reached by mistake refuses to start rather than build into the
 * directory under test.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../packages/hub/src/temp-dir.fixture.js";

const ROOT = resolve(import.meta.dirname, "..");
const onWindows = process.platform === "win32";
/** Exit status of the cargo stub, so a run that stopped there is recognisable. */
const STUB_CARGO_STATUS = 42;

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

function tempDir(): string {
	const dir = makeTempDir("lasterm-build-target-dir-");
	tempDirs.push(dir);
	return dir;
}

/** Stubs for cargo and pnpm, as the shell that runs the scripts finds commands. */
function writeStubs(dir: string): void {
	if (onWindows) {
		writeFileSync(
			join(dir, "cargo.ps1"),
			`Set-Content -LiteralPath $env:LASTERM_TEST_CARGO_ARGS -Value $args\nexit ${STUB_CARGO_STATUS}\n`,
		);
		writeFileSync(join(dir, "pnpm.ps1"), "exit 0\n");
	} else {
		writeFileSync(
			join(dir, "cargo"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > "$LASTERM_TEST_CARGO_ARGS"\nexit ${STUB_CARGO_STATUS}\n`,
			{ mode: 0o755 },
		);
		writeFileSync(join(dir, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	}
}

/**
 * This environment without the variables under test, and with the stubs first
 * on PATH. Windows names are matched without regard to case, as Windows does.
 */
function scriptEnv(stubs: string, set: Record<string, string>): NodeJS.ProcessEnv {
	const drop = new Set(["cargo_target_dir", "lasterm_cargo_target_dir", "lasterm_target_triple"]);
	const env: NodeJS.ProcessEnv = {};
	let path = "";
	for (const [name, value] of Object.entries(process.env)) {
		if (name.toLowerCase() === "path") path = value ?? "";
		else if (!drop.has(name.toLowerCase())) env[name] = value;
	}
	return {
		...env,
		PATH: `${stubs}${delimiter}${path}`,
		RUSTUP_TOOLCHAIN: "lasterm-spec-no-such-toolchain",
		...set,
	};
}

/** Run `script` from the repository with `set` in its environment; the `--target-dir` it gave cargo. */
function targetDirOf(script: string, set: Record<string, string>): string {
	const work = tempDir();
	const stubs = join(work, "stubs");
	mkdirSync(stubs);
	writeStubs(stubs);
	const argsFile = join(work, "cargo-args.txt");
	const env = scriptEnv(stubs, {
		LASTERM_TEST_CARGO_ARGS: argsFile,
		LASTERM_DIST_DIR: join(work, "dist"),
		LASTERM_BUILD_HASH: "0badc0de",
		LASTERM_SKIP_WEB: "true",
		...set,
	});
	const run = onWindows
		? spawnSync(
				"pwsh",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					join(ROOT, "scripts", `${script}.ps1`),
				],
				{ env, encoding: "utf8" },
			)
		: spawnSync("bash", [join(ROOT, "scripts", `${script}.sh`)], { env, encoding: "utf8" });
	const output = `${run.stdout}\n${run.stderr}`;
	expect(existsSync(argsFile), `${script} never reached the cargo stub:\n${output}`).toBe(true);
	if (!onWindows) expect(run.status, output).toBe(STUB_CARGO_STATUS);
	const args = readFileSync(argsFile, "utf8").split(/\r?\n/);
	const flag = args.indexOf("--target-dir");
	expect(flag, `no --target-dir in: ${args.join(" ")}`).toBeGreaterThanOrEqual(0);
	return args[flag + 1] ?? "";
}

describe.each(["build-agent", "build-hub"])("%s", (script) => {
	const shared = resolve(tmpShared());

	it("builds into the repository's target when neither variable is set", () => {
		expect(resolve(ROOT, targetDirOf(script, {}))).toBe(join(ROOT, "target"));
	});

	it("builds into CARGO_TARGET_DIR when LASTERM_CARGO_TARGET_DIR is unset", () => {
		// Mutation caught: a worktree that shares one target through
		// CARGO_TARGET_DIR got a new target directory of its own.
		expect(targetDirOf(script, { CARGO_TARGET_DIR: shared })).toBe(shared);
	});

	it("builds into LASTERM_CARGO_TARGET_DIR over CARGO_TARGET_DIR", () => {
		const own = join(shared, "own");
		expect(targetDirOf(script, { CARGO_TARGET_DIR: shared, LASTERM_CARGO_TARGET_DIR: own })).toBe(
			own,
		);
	});

	it("takes empty variables as unset", () => {
		expect(
			resolve(ROOT, targetDirOf(script, { CARGO_TARGET_DIR: "", LASTERM_CARGO_TARGET_DIR: "" })),
		).toBe(join(ROOT, "target"));
	});
});

/** A directory name for the tests to hand the scripts; nothing is ever created in it. */
function tmpShared(): string {
	return join(ROOT, "..", "lasterm-build-target-dir-spec-shared-target");
}

// desktop-ui.ps1 -Build moves CARGO_TARGET_DIR for the Tauri build alone. It is
// run from a copy in a scratch repository whose build-desktop.ps1 is a stub that
// records what it was given and fails, so the script stops at its build step:
// nothing is built, and nothing after it (the app) is reached.
describe.runIf(onWindows)("desktop-ui.ps1 -Build", () => {
	it("keeps the agent and the hub in their own target directory, and puts both variables back", () => {
		// Its long form: PowerShell expands a short (8.3) temp path in $PSScriptRoot.
		const fakeRoot = realpathSync.native(tempDir());
		mkdirSync(join(fakeRoot, "scripts", "dev"), { recursive: true });
		copyFileSync(
			join(ROOT, "scripts", "dev", "desktop-ui.ps1"),
			join(fakeRoot, "scripts", "dev", "desktop-ui.ps1"),
		);
		const seen = join(fakeRoot, "seen.txt");
		writeFileSync(
			join(fakeRoot, "scripts", "build-desktop.ps1"),
			[
				"param([switch]$NoBundle)",
				`Set-Content -LiteralPath '${seen}' -Value @("$env:CARGO_TARGET_DIR", "$env:LASTERM_CARGO_TARGET_DIR")`,
				"exit 7",
			].join("\n"),
		);
		const shared = resolve(tmpShared());
		const script = join(fakeRoot, "scripts", "dev", "desktop-ui.ps1");
		const run = spawnSync(
			"pwsh",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`try { & '${script}' -Build } catch { 'stopped: ' + $_ }; 'after=' + $env:CARGO_TARGET_DIR + '|' + $env:LASTERM_CARGO_TARGET_DIR`,
			],
			{ env: scriptEnv(tempDir(), { CARGO_TARGET_DIR: shared }), encoding: "utf8" },
		);

		expect(run.stdout, run.stderr).toContain("stopped: build-desktop.ps1 failed");
		const [tauri, agentAndHub] = readFileSync(seen, "utf8").split(/\r?\n/);
		expect(tauri).toBe(join(fakeRoot, "target", "desktop-ui", "build"));
		// Mutation caught: unpinned, the agent and the hub followed the Tauri
		// build's CARGO_TARGET_DIR into target\desktop-ui\build.
		expect(agentAndHub).toBe(shared);
		// Mutation caught: removing CARGO_TARGET_DIR afterwards lost the value
		// the session had before.
		expect(run.stdout.trim().split(/\r?\n/).at(-1)).toBe(`after=${shared}|`);
	});
});
