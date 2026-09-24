/**
 * The build `pnpm -F @lasterm/hub test` runs before the hub specs, the one they
 * accept. Cargo is a stand-in here: nothing is built or cleaned.
 */
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NATIVE_MANIFESTS,
	nativeArtifacts,
	recordedNativeBuild,
	recordNativeBuild,
} from "../packages/hub/src/native-build.fixture.js";
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
const PROTECTED_FS = "crates/lasterm-protected-fs/src/lib.rs";
/** Before any checkout's files were written. */
const LONG_AGO = new Date("2001-01-01T00:00:00Z");

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
 * A `release` folder holding the artifacts, as built now, with dep-info files
 * naming `listed`, and the record naming `recorded` unless it is null.
 */
function release({
	listed = ROOT,
	recorded = listed,
}: {
	listed?: string;
	recorded?: string | null;
} = {}): string {
	const folder = join(tempDir(), "release");
	for (const { artifact, crate } of nativeArtifacts(folder)) {
		mkdirSync(dirname(artifact), { recursive: true });
		writeFileSync(artifact, "placeholder, never run");
		const sources = [PROTECTED_FS, `crates/${crate}/src/lib.rs`].map((source) =>
			join(listed, source).replaceAll(" ", "\\ "),
		);
		writeFileSync(
			join(dirname(artifact), `${parse(artifact).name}.d`),
			`${artifact}: ${sources.join(" ")}\n`,
		);
	}
	if (recorded !== null) recordNativeBuild(folder, recorded);
	return folder;
}

/**
 * Another checkout holding this one's sources and manifests, except `edited`,
 * which differs.
 */
function otherCheckout(edited?: string): string {
	const other = join(tempDir(), "other checkout");
	const sources = ["lasterm-protected-fs", "lasterm-hub-lock", "lasterm-tls-identity"].map(
		(crate) => `crates/${crate}/src/lib.rs`,
	);
	for (const file of [...sources, ...NATIVE_MANIFESTS]) {
		const path = join(other, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, file === edited ? "# their edit\n" : readFileSync(join(ROOT, file)));
		utimesSync(path, LONG_AGO, LONG_AGO);
	}
	return other;
}

/** As a build that compiles something leaves the folder: an artifact written anew. */
function compile(folder: string): void {
	writeFileSync(nativeArtifacts(folder)[0]!.artifact, "compiled again");
}

/**
 * Cargo, as far as these specs need it: a clean removes the artifacts, and a
 * build writes those that are missing.
 */
function cargoIn(folder: string): (args: readonly string[]) => number {
	return (args) => {
		for (const { artifact } of nativeArtifacts(folder)) {
			if (args[0] === "clean") rmSync(artifact, { force: true });
			if (args[0] === "build") {
				try {
					writeFileSync(artifact, "built", { flag: "wx" });
				} catch {}
			}
		}
		return 0;
	};
}

/**
 * Runs the build against `folder`, and returns what cargo was asked to do. `run`
 * stands for cargo: it gets the arguments, and returns the exit status.
 */
function build(folder: string, run = cargoIn(folder), extra?: string[]) {
	const calls: string[][] = [];
	const exit = buildTestNatives(
		ROOT,
		folder,
		(args) => {
			calls.push([...args]);
			return run(args);
		},
		extra,
	);
	return { calls, exit };
}

function recordedCheckout(folder: string): string | undefined {
	const recorded = recordedNativeBuild(folder, ROOT);
	return "checkout" in recorded ? recorded.checkout : undefined;
}

describe("the hub's pre-test native build", () => {
	it("builds without cleaning when this checkout's build is recorded", () => {
		expect(build(release())).toEqual({ calls: [BUILD], exit: 0 });
	});

	it("builds without cleaning another checkout's recorded build of the same sources, and leaves its record", () => {
		const other = otherCheckout();
		const folder = release({ recorded: other });

		expect(build(folder)).toEqual({ calls: [BUILD], exit: 0 });
		expect(recordedCheckout(folder)).toBe(resolve(other));
	});

	it("cleans first when no build is recorded, then records this checkout", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const folder = release({ recorded: null });

		expect(build(folder)).toEqual({ calls: [CLEAN, BUILD], exit: 0 });
		expect(recordedCheckout(folder)).toBe(ROOT);
	});

	it("cleans first when another checkout with different sources built, and says so", () => {
		const other = otherCheckout(PROTECTED_FS);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(build(release({ listed: other }))).toEqual({ calls: [CLEAN, BUILD], exit: 0 });
		expect(log.mock.calls.flat().join("\n")).toContain(`it was built from ${other}`);
	});

	// Checkouts sharing a target directory share cargo's record of what is fresh,
	// and it goes by modification time. After another worktree had built, a
	// plain build here compiled nothing and only rewrote the dep-info files to
	// name this checkout, so the setup accepted that worktree's artifacts (#544).
	it("cleans first when the record names another checkout, whatever the dep-info files say", () => {
		const other = otherCheckout(PROTECTED_FS);
		vi.spyOn(console, "log").mockImplementation(() => {});

		const folder = release({ listed: ROOT, recorded: other });
		expect(build(folder)).toEqual({ calls: [CLEAN, BUILD], exit: 0 });
	});

	// The same sources built with another lock file make other artifacts (seen
	// 2026-09-24 with a dependency pinned back).
	it("cleans first when the recorded build used another Cargo.lock, and says so", () => {
		const other = otherCheckout("Cargo.lock");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(build(release({ recorded: other }))).toEqual({ calls: [CLEAN, BUILD], exit: 0 });
		expect(log.mock.calls.flat().join("\n")).toContain(
			`it was built in ${other} with a Cargo.lock that differs from this checkout's`,
		);
	});

	it("cleans first when cargo changed the build after it was recorded", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const folder = release();
		compile(folder);

		expect(build(folder)).toEqual({ calls: [CLEAN, BUILD], exit: 0 });
	});

	it("stops before the build when the clean fails, and leaves no record", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const folder = release({ recorded: null });

		const result = build(folder, (args) => (args[0] === "clean" ? 101 : 0));

		expect(result).toEqual({ calls: [CLEAN], exit: 101 });
		expect(error.mock.calls.flat().join("\n")).toContain("cargo clean failed");
		expect(recordedCheckout(folder)).toBeUndefined();
	});

	// What it compiled came from here, and what it did not was already this
	// checkout's: the next run can finish the build without cleaning.
	it("records this checkout once its build changed anything, even a build that failed", () => {
		const folder = release();
		const result = build(folder, (args) => {
			if (args[0] === "build") compile(folder);
			return 101;
		});

		expect(result).toEqual({ calls: [BUILD], exit: 101 });
		expect(recordedCheckout(folder)).toBe(ROOT);
	});

	// Seen 2026-09-24: another worktree's plain cargo build, waiting on cargo's
	// lock during the clean, took it before this build did and compiled all four
	// crates; this build then had nothing to do, and recorded that worktree's
	// artifacts as this checkout's.
	it("records nothing when another build slipped in between the clean and the build", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const folder = release({ recorded: null });
		const cargo = cargoIn(folder);
		const seconds = new Date(Date.now() - 3000);

		const result = build(folder, (args) => {
			const status = cargo(args);
			if (args[0] === "clean") {
				cargo(["build"]);
				for (const { artifact } of nativeArtifacts(folder)) utimesSync(artifact, seconds, seconds);
			}
			return status;
		});

		expect(result).toEqual({ calls: [CLEAN, BUILD], exit: 1 });
		expect(error.mock.calls.flat().join("\n")).toContain("Another build wrote");
		expect(recordedCheckout(folder)).toBeUndefined();
	});

	it("records nothing when another build wrote after this one's cargo finished", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const folder = release();
		const later = new Date(Date.now() + 60_000);

		const result = build(folder, () => {
			const { artifact } = nativeArtifacts(folder)[0]!;
			utimesSync(artifact, later, later);
			return 0;
		});

		expect(result).toEqual({ calls: [BUILD], exit: 1 });
		expect(error.mock.calls.flat().join("\n")).toContain("Another build wrote");
		expect(recordedCheckout(folder)).toBeUndefined();
	});

	it("passes its arguments on to cargo build", () => {
		const folder = release();
		expect(build(folder, undefined, ["--locked"]).calls).toEqual([[...BUILD, "--locked"]]);
	});

	it.runIf(process.platform === "win32")(
		"takes this checkout written in other letter case for this checkout",
		() => {
			expect(build(release({ recorded: ROOT.toUpperCase() }))).toEqual({
				calls: [BUILD],
				exit: 0,
			});
		},
	);
});
