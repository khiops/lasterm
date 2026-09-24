/**
 * The build `pnpm -F @lasterm/hub test` runs before the hub specs. Cargo is a
 * recorder here: nothing is built or cleaned.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeArtifacts } from "../packages/hub/src/native-build.fixture.js";
import { makeTempDir, removeTempDir } from "../packages/hub/src/temp-dir.fixture.js";
import { buildTestNatives } from "./build-test-tls-material.js";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD = [
	"build",
	"--release",
	"-p",
	"lasterm-hub-lock",
	"-p",
	"lasterm-tls-identity",
	"--features",
	"lasterm-tls-identity/test-tls-material",
];
/**
 * The dependencies first: a clean that fails on a loaded addon has removed them
 * by then, so the next build still recompiles everything.
 */
const CLEAN = [
	"clean",
	"--release",
	"-p",
	"lasterm-protected-fs",
	"-p",
	"lasterm-process-lock",
	"-p",
	"lasterm-tls-identity",
	"-p",
	"lasterm-hub-lock",
];

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

function tempDir(): string {
	const dir = makeTempDir("lasterm-build-test-tls-material-");
	tempDirs.push(dir);
	return dir;
}

/**
 * A `release` folder where cargo last built each artifact in the checkout
 * `builtIn` names for it, with the dep-info file cargo writes beside it.
 */
function release(builtIn: (crate: string) => string): string {
	const folder = join(tempDir(), "release");
	for (const { artifact, crate } of nativeArtifacts(folder)) {
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(artifact, "placeholder, never run");
		const source = join(builtIn(crate), "crates", crate, "src", "lib.rs");
		writeFileSync(
			join(dirname(artifact), `${parse(artifact).name}.d`),
			`${artifact}: ${source.replaceAll(" ", "\\ ")}\n`,
		);
	}
	return folder;
}

/** Runs the build against `folder`, and returns what cargo was asked to do. */
function build(folder: string, status: (args: readonly string[]) => number = () => 0) {
	const calls: string[][] = [];
	const exit = buildTestNatives(ROOT, folder, (args) => {
		calls.push([...args]);
		return status(args);
	});
	return { calls, exit };
}

describe("the hub's pre-test native build", () => {
	it("builds without cleaning when this checkout built last", () => {
		expect(build(release(() => ROOT))).toEqual({ calls: [BUILD], exit: 0 });
	});

	it("builds without cleaning when nothing was built yet", () => {
		expect(build(join(tempDir(), "release"))).toEqual({ calls: [BUILD], exit: 0 });
	});

	// Checkouts sharing a target directory share cargo's record of what is fresh,
	// and it goes by modification time. After another worktree had built, the
	// plain build compiled nothing here and only rewrote the dep-info files to
	// name this checkout, so the setup accepted that worktree's artifacts (#544).
	it("cleans the crates first when a dep-info file names another checkout", () => {
		const other = join(tempDir(), "other checkout");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const folder = release((crate) => (crate === "lasterm-tls-identity" ? other : ROOT));

		expect(build(folder)).toEqual({ calls: [CLEAN, BUILD], exit: 0 });
		expect(log.mock.calls.flat().join("\n")).toContain(other);
	});

	it("stops before the build when the clean fails, and says what may hold the files", () => {
		const other = join(tempDir(), "other");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = build(
			release(() => other),
			(args) => (args[0] === "clean" ? 101 : 0),
		);

		expect(result).toEqual({ calls: [CLEAN], exit: 101 });
		expect(error.mock.calls.flat().join("\n")).toContain(other);
	});

	it.runIf(process.platform === "win32")(
		"takes this checkout written in other letter case for this checkout",
		() => {
			expect(build(release(() => ROOT.toUpperCase()))).toEqual({ calls: [BUILD], exit: 0 });
		},
	);
});
