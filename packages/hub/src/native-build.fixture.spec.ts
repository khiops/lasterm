import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Nothing here may run the generator or cargo: the target directory these specs
// point the setup at holds placeholders, not programs.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { NATIVE_MANIFESTS, nativeBuildProblem, recordNativeBuild } from "./native-build.fixture.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";
import setupTestTlsMaterial from "./test-tls.setup.js";

const checkout = resolve(import.meta.dirname, "../../..");
const BUILD_SCRIPT = "pnpm build:test-tls-material";
/** Before any checkout's files were written, and after all of them. */
const LONG_AGO = new Date("2001-01-01T00:00:00Z");
const FAR_AHEAD = new Date("2100-01-01T00:00:00Z");

const library = (name: string) =>
	process.platform === "win32"
		? `${name}.dll`
		: process.platform === "darwin"
			? `lib${name}.dylib`
			: `lib${name}.so`;
const executable = process.platform === "win32" ? ".exe" : "";

/** What the hub specs load, with the sources cargo lists for each. */
const ARTIFACTS = [
	{
		name: "hub lock addon",
		file: library("lasterm_hub_lock"),
		sources: [
			"crates/lasterm-hub-lock/build.rs",
			"crates/lasterm-hub-lock/src/lib.rs",
			"crates/lasterm-process-lock/src/lib.rs",
		],
	},
	{
		name: "TLS identity addon",
		file: library("lasterm_tls_identity"),
		sources: [
			"crates/lasterm-protected-fs/src/lib.rs",
			"crates/lasterm-tls-identity/build.rs",
			"crates/lasterm-tls-identity/src/lib.rs",
		],
	},
	{
		name: "TLS test material generator",
		file: `lasterm-tls-test-material${executable}`,
		sources: [
			"crates/lasterm-protected-fs/src/lib.rs",
			"crates/lasterm-tls-identity/build.rs",
			"crates/lasterm-tls-identity/src/bin/lasterm-tls-test-material.rs",
		],
	},
];

const tempDirs: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.mocked(execFileSync).mockReset();
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

function tempDir(name = "lasterm-native-build-"): string {
	const dir = makeTempDir(name);
	tempDirs.push(dir);
	return dir;
}

/** An artifact as cargo leaves it: the file, and a dep-info file beside it. */
function writeArtifact(artifact: string, sources: readonly string[], modified: Date): void {
	mkdirSync(dirname(artifact), { recursive: true });
	writeFileSync(artifact, "placeholder, never run");
	utimesSync(artifact, modified, modified);
	const listed = sources.map((source) => source.replaceAll(" ", "\\ ")).join(" ");
	writeFileSync(depInfoOf(artifact), `${artifact}: ${listed}\n`);
}

function depInfoOf(artifact: string): string {
	return join(dirname(artifact), `${parse(artifact).name}.d`);
}

function writeSource(path: string, contents: string, modified = LONG_AGO): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	utimesSync(path, modified, modified);
}

/** Another checkout holding this one's sources and manifests, except `edited`, which differs. */
function otherCheckout(edited?: string): string {
	const other = tempDir();
	const sources = new Set(ARTIFACTS.flatMap(({ sources }) => sources));
	for (const file of [...sources, ...NATIVE_MANIFESTS]) {
		writeSource(join(other, file), readFileSync(join(checkout, file), "utf8"));
	}
	if (edited !== undefined) writeSource(join(other, edited), "// their edit\n");
	return other;
}

describe("hub test setup", () => {
	/**
	 * A target directory holding the artifacts, dep-info files naming `listed`,
	 * and the pre-test build's record naming `recorded` unless it is null;
	 * `stale` was built before its sources.
	 */
	function useTarget({
		stale,
		listed = checkout,
		recorded = listed,
	}: {
		stale?: string;
		listed?: string;
		recorded?: string | null;
	} = {}): string {
		const target = tempDir();
		for (const { file, sources } of ARTIFACTS) {
			writeArtifact(
				join(target, "release", file),
				sources.map((source) => join(listed, source)),
				file === stale ? LONG_AGO : FAR_AHEAD,
			);
		}
		if (recorded !== null) recordNativeBuild(join(target, "release"), recorded);
		vi.stubEnv("CARGO_TARGET_DIR", target);
		vi.stubEnv("LASTERM_HUB_LOCK_ADDON", undefined);
		vi.stubEnv("LASTERM_TLS_IDENTITY_ADDON", undefined);
		// The setup sets and clears the variable this worker's own run relies on.
		vi.stubEnv("LASTERM_TEST_TLS_DIRECTORY", process.env.LASTERM_TEST_TLS_DIRECTORY);
		return target;
	}

	/** Why the setup refuses to run, having run nothing. */
	function refusal(): string {
		let refused: unknown;
		let teardown: (() => void) | undefined;
		try {
			teardown = setupTestTlsMaterial();
		} catch (error) {
			refused = error;
		} finally {
			teardown?.();
		}
		expect(refused).toBeInstanceOf(Error);
		// Neither the generator nor a build ran.
		expect(execFileSync).not.toHaveBeenCalled();
		return (refused as Error).message;
	}

	it.each(ARTIFACTS)(
		"refuses a stale $name, and says what changed and how to rebuild it",
		({ file, sources }) => {
			const target = useTarget({ stale: file });
			const message = refusal();

			expect(message).toContain("stale native build");
			expect(message).toContain(
				`${join(target, "release", file)}: ${sources[0]} changed after it was built`,
			);
			expect(message).toContain(`Build it with \`${BUILD_SCRIPT}\``);
			// Only the stale artifact is named.
			for (const other of ARTIFACTS.filter((artifact) => artifact.file !== file)) {
				expect(message).not.toContain(join(target, "release", other.file));
			}
		},
	);

	it("refuses another checkout's different build", () => {
		const theirs = otherCheckout("crates/lasterm-protected-fs/src/lib.rs");
		const target = useTarget({ listed: theirs });

		expect(refusal()).toContain(
			`${join(target, "release", library("lasterm_tls_identity"))}: it was built from ${theirs}, whose crates/lasterm-protected-fs/src/lib.rs differs from this checkout's`,
		);
	});

	// Checkouts sharing a target directory share cargo's record of what is fresh,
	// and it goes by modification time. After another worktree had built, a
	// `cargo build` here compiled nothing: it only rewrote the dep-info files to
	// name this checkout's sources and left that worktree's artifacts in place,
	// which this check accepted (#544).
	it("refuses another checkout's build after a cargo build here relabeled it", () => {
		const theirs = otherCheckout("crates/lasterm-protected-fs/src/lib.rs");
		const target = useTarget({ listed: checkout, recorded: theirs });

		expect(refusal()).toContain(
			`${join(target, "release", library("lasterm_tls_identity"))}: it was built from ${theirs}, whose crates/lasterm-protected-fs/src/lib.rs differs from this checkout's`,
		);
	});

	// The dep-info files list no manifest, and the same sources built with
	// another one make other artifacts (seen 2026-09-24: an opt-level override
	// in Cargo.toml, a dependency pinned back in Cargo.lock).
	it.each(NATIVE_MANIFESTS)("refuses a build made with another %s", (manifest) => {
		const theirs = otherCheckout(manifest);
		const target = useTarget({ listed: checkout, recorded: theirs });

		expect(refusal()).toContain(
			`${join(target, "release")}: it was built in ${theirs} with a ${manifest} that differs from this checkout's`,
		);
	});

	it("refuses a build the pre-test build did not record, and names that build", () => {
		const target = useTarget({ recorded: null });
		const message = refusal();

		expect(message).toContain(
			`${join(target, "release")}: no build by \`${BUILD_SCRIPT}\` is recorded there`,
		);
		expect(message).toContain(`Build it with \`${BUILD_SCRIPT}\``);
	});

	it("refuses a build cargo changed after it was recorded", () => {
		const target = useTarget();
		const addon = join(target, "release", library("lasterm_hub_lock"));
		const later = new Date(FAR_AHEAD.getTime() + 1000);
		utimesSync(addon, later, later);

		expect(refusal()).toContain(
			`${library("lasterm_hub_lock")} there changed after \`${BUILD_SCRIPT}\` recorded it`,
		);
	});

	it("accepts another checkout's build of the same sources", () => {
		useTarget({ listed: checkout, recorded: otherCheckout() });
		setupTestTlsMaterial()();

		expect(execFileSync).toHaveBeenCalledTimes(1);
	});

	it("looks under the checkout for a relative CARGO_TARGET_DIR, wherever the run works from", () => {
		const relativeTarget = join("no-such-dir", "lasterm-native-build-spec");
		vi.stubEnv("CARGO_TARGET_DIR", relativeTarget);
		vi.stubEnv("LASTERM_HUB_LOCK_ADDON", undefined);
		vi.stubEnv("LASTERM_TLS_IDENTITY_ADDON", undefined);
		vi.stubEnv("LASTERM_TEST_TLS_DIRECTORY", process.env.LASTERM_TEST_TLS_DIRECTORY);
		const elsewhere = tempDir();
		// Mutation caught (#531): a relative value resolved by path.resolve
		// alone lands under the working directory, not where cargo built.
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(elsewhere);
		let message: string;
		try {
			message = refusal();
		} finally {
			cwd.mockRestore();
		}

		// Nothing is built there, so the setup gives up, naming where it looked
		// and the build to run.
		const generator = `lasterm-tls-test-material${executable}`;
		expect(message).toContain(`missing at ${join(checkout, relativeTarget, "release", generator)}`);
		expect(message).toContain(BUILD_SCRIPT);
		expect(message).not.toContain(elsewhere);
	});

	it("runs the generator, and builds nothing, when the build is current", () => {
		const target = useTarget();
		const teardown = setupTestTlsMaterial();
		try {
			expect(execFileSync).toHaveBeenCalledTimes(1);
			expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe(
				join(target, "release", `lasterm-tls-test-material${executable}`),
			);
		} finally {
			teardown();
		}
	});
});

describe("nativeBuildProblem", () => {
	const CRATE = "lasterm-hub-lock";
	const SOURCES = ["crates/lasterm-hub-lock/src/lib.rs", "crates/lasterm-process-lock/src/lib.rs"];

	/** A checkout holding SOURCES, written long ago. */
	function makeCheckout(root = tempDir()): string {
		for (const source of SOURCES) writeSource(join(root, source), `// ${source}\n`);
		return root;
	}

	function buildFrom(built: string, modified = new Date("2002-01-01T00:00:00Z")): string {
		const artifact = join(tempDir(), "release", library("lasterm_hub_lock"));
		writeArtifact(
			artifact,
			SOURCES.map((source) => join(built, source)),
			modified,
		);
		return artifact;
	}

	it("accepts an artifact built after its sources last changed", () => {
		const ours = makeCheckout();
		expect(nativeBuildProblem(buildFrom(ours), CRATE, ours)).toBeUndefined();
	});

	it("names a source that changed after the build", () => {
		const ours = makeCheckout();
		const artifact = buildFrom(ours);
		writeSource(join(ours, SOURCES[1]!), "// edited\n", new Date("2003-01-01T00:00:00Z"));
		expect(nativeBuildProblem(artifact, CRATE, ours)).toBe(
			"crates/lasterm-process-lock/src/lib.rs changed after it was built",
		);
	});

	it("names a source the build used that no longer exists", () => {
		const ours = makeCheckout();
		const artifact = buildFrom(ours);
		rmSync(join(ours, SOURCES[0]!));
		expect(nativeBuildProblem(artifact, CRATE, ours)).toBe(
			"crates/lasterm-hub-lock/src/lib.rs, which it was built from, no longer exists",
		);
	});

	// Checkouts that share a target directory overwrite each other's artifacts.
	it("accepts an artifact another checkout built from the same sources", () => {
		const ours = makeCheckout();
		const theirs = makeCheckout();
		expect(nativeBuildProblem(buildFrom(theirs), CRATE, ours)).toBeUndefined();
	});

	it("names the other checkout when its sources differ from this one's", () => {
		const ours = makeCheckout();
		const theirs = makeCheckout();
		writeSource(join(theirs, SOURCES[0]!), "// their edit\n");
		expect(nativeBuildProblem(buildFrom(theirs), CRATE, ours)).toBe(
			`it was built from ${theirs}, whose crates/lasterm-hub-lock/src/lib.rs differs from this checkout's`,
		);
	});

	it("compares the checkout it is told the artifact came from, not the one its dep-info names", () => {
		const ours = makeCheckout();
		const theirs = makeCheckout();
		writeSource(join(theirs, SOURCES[0]!), "// their edit\n");
		expect(nativeBuildProblem(buildFrom(ours), CRATE, ours, theirs)).toBe(
			`it was built from ${theirs}, whose crates/lasterm-hub-lock/src/lib.rs differs from this checkout's`,
		);
	});

	it("reads a checkout path with a space in it", () => {
		const ours = makeCheckout(join(tempDir(), "check out"));
		expect(nativeBuildProblem(buildFrom(ours), CRATE, ours)).toBeUndefined();
	});

	it("refuses an artifact without cargo's record of what it was built from", () => {
		const ours = makeCheckout();
		const artifact = buildFrom(ours);
		rmSync(depInfoOf(artifact));
		expect(nativeBuildProblem(artifact, CRATE, ours)).toBe(
			`there is no ${parse(artifact).name}.d beside it to say what it was built from`,
		);
	});

	it("refuses a missing artifact", () => {
		const ours = makeCheckout();
		expect(nativeBuildProblem(join(tempDir(), "absent.dll"), CRATE, ours)).toBe("it is missing");
	});
});
