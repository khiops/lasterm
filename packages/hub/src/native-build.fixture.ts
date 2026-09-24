/**
 * Test-only: whether a native artifact the hub specs load is what cargo would
 * build from this checkout now (#129).
 *
 * The specs load the Rust addons from the cargo target directory, and nothing in
 * the TypeScript loop rebuilds them. After a crate edit they would test the
 * previous build, and fail, when they fail at all, as if the code under test were
 * wrong.
 *
 * Beside every artifact it places in the target directory, cargo writes a
 * dep-info file, `<name>.d`, naming each local source file the artifact was built
 * from. The artifact is current when none of those files changed after it was
 * written, which is the comparison cargo makes to decide a rebuild. They must
 * also match this checkout's files: checkouts that share one target directory
 * overwrite each other's artifacts, and the last build may have come from
 * another one.
 *
 * Which one cargo does not say. Those checkouts share its record of which crates
 * are fresh, one per crate for all of them, and it goes by modification time:
 * once another checkout has built newer artifacts, a `cargo build` here compiles
 * nothing, rewrites the dep-info files to name this checkout's sources, and
 * leaves the other checkout's artifacts in place (#544). So only one build is
 * trusted, `pnpm build:test-tls-material` (`buildTestNatives` in
 * scripts/build-test-tls-material.ts). It cleans the crates unless the last
 * build is known to match this checkout, then records which checkout built, and
 * the modification time of every file cargo keeps for these crates. A build that
 * compiles anything changes one of those files; one that compiles nothing leaves
 * them all, so the record still names the checkout the artifacts came from.
 * Anything the record does not cover is refused.
 *
 * The dep-info files list no manifest, so the record also keeps a digest of each
 * file in `NATIVE_MANIFESTS` as the build found it. The same `.rs` files built
 * with another `Cargo.toml` or `Cargo.lock` make other artifacts, and were
 * accepted before (seen 2026-09-24: an opt-level override, a dependency pinned
 * back in the lock).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** The one build whose artifacts the hub specs accept. */
export const NATIVE_BUILD_SCRIPT = "pnpm build:test-tls-material";
/**
 * Every workspace crate the artifacts are built from: the two packages and
 * their path dependencies. Cargo rebuilds only a crate it finds stale, so one
 * left out of a clean can keep another checkout's build.
 *
 * The dependencies come first, and cargo cleans in this order. On Windows a
 * clean fails on an addon a running process has loaded, and stops there after
 * removing the dep-info files; with the dependencies already gone, whatever
 * builds next still recompiles all four (seen 2026-09-24). The other order left
 * another checkout's dependencies for the next build to link.
 */
export const NATIVE_CRATES = [
	"lasterm-protected-fs",
	"lasterm-process-lock",
	"lasterm-tls-identity",
	"lasterm-hub-lock",
];
/** Cargo's arguments to build the artifacts. */
export const NATIVE_BUILD_ARGS = [
	"build",
	"--release",
	"-p",
	"lasterm-hub-lock",
	"-p",
	"lasterm-tls-identity",
	"--features",
	"lasterm-tls-identity/test-tls-material",
];
/** Cargo's arguments to remove them and everything they are built from. */
export const NATIVE_CLEAN_ARGS = [
	"clean",
	"--release",
	...NATIVE_CRATES.flatMap((crate) => ["-p", crate]),
];
/**
 * What else decides the artifacts, beyond the sources the dep-info files list:
 * the manifests, the lock file, and the compiler. A checkout's differ from the
 * ones the recorded build used, or they changed since, and it is refused.
 */
export const NATIVE_MANIFESTS = [
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain.toml",
	...NATIVE_CRATES.map((crate) => `crates/${crate}/Cargo.toml`),
];
/** The record `recordNativeBuild` keeps in the `release` folder. */
const RECORD = "lasterm-test-natives.json";
/** The file `fileClock` writes to read the time. */
const CLOCK = "lasterm-test-natives.clock";

/** A native artifact the hub specs load or run, and the package that builds it. */
export interface NativeArtifact {
	artifact: string;
	crate: string;
	/** The variable that names an addon to load instead of this one, if any. */
	override?: string;
}

/** The artifacts the hub specs take from the target directory's `release` folder. */
export function nativeArtifacts(release: string): NativeArtifact[] {
	const library = (name: string) =>
		platform() === "win32"
			? `${name}.dll`
			: platform() === "darwin"
				? `lib${name}.dylib`
				: `lib${name}.so`;
	const executable = platform() === "win32" ? ".exe" : "";
	return [
		{
			artifact: join(release, library("lasterm_hub_lock")),
			crate: "lasterm-hub-lock",
			override: "LASTERM_HUB_LOCK_ADDON",
		},
		{
			artifact: join(release, library("lasterm_tls_identity")),
			crate: "lasterm-tls-identity",
			override: "LASTERM_TLS_IDENTITY_ADDON",
		},
		{
			artifact: join(release, `lasterm-tls-test-material${executable}`),
			crate: "lasterm-tls-identity",
		},
	];
}

/** Records that `checkout`, with its manifests, built what `release` now holds of these crates. */
export function recordNativeBuild(release: string, checkout: string): void {
	const record = {
		checkout: resolve(checkout),
		manifests: manifestDigests(checkout),
		files: buildState(release),
	};
	mkdirSync(release, { recursive: true });
	writeFileSync(join(release, RECORD), `${JSON.stringify(record, null, "\t")}\n`);
}

/**
 * The time a file written in `release` now is stamped with, to compare with
 * the files cargo writes there. `Date.now()` will not do: read just after a
 * write, it was up to 1.5 ms behind that file's stamp (measured 2026-09-24).
 */
export function fileClock(release: string): bigint {
	mkdirSync(release, { recursive: true });
	const probe = join(release, CLOCK);
	writeFileSync(probe, "");
	return statSync(probe, { bigint: true }).mtimeNs;
}

/**
 * A file cargo keeps for these crates in `release` that was written before
 * `after`, or after `before`, when there is one. A build that follows a clean
 * writes every one of them itself: a file older than it came from another build
 * that ran in between. None may be newer than the end of the build either.
 */
export function writtenOutside(
	release: string,
	after: bigint | undefined,
	before: bigint,
): string | undefined {
	for (const [file, time] of Object.entries(buildState(release))) {
		const written = BigInt(time);
		if ((after !== undefined && written < after) || written > before) return file;
	}
	return undefined;
}

/** Drops the record, before something changes what it covers. */
export function forgetNativeBuild(release: string): void {
	rmSync(join(release, RECORD), { force: true });
}

/**
 * The checkout the record in `release` names, or why there is no record that
 * holds for `checkout`: none was kept, cargo has since changed a file it covers,
 * or `checkout`'s manifests are not the ones the build used.
 */
export function recordedNativeBuild(
	release: string,
	checkout: string,
): { checkout: string } | { problem: string } {
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(join(release, RECORD), "utf8"));
	} catch {
		return { problem: `no build by \`${NATIVE_BUILD_SCRIPT}\` is recorded there` };
	}
	if (!isRecord(record)) return { problem: `${RECORD} there is not a record it wrote` };
	const now = buildState(release);
	for (const file of new Set([...Object.keys(record.files), ...Object.keys(now)])) {
		if (record.files[file] !== now[file]) {
			return { problem: `${file} there changed after \`${NATIVE_BUILD_SCRIPT}\` recorded it` };
		}
	}
	const ours = manifestDigests(checkout);
	for (const manifest of NATIVE_MANIFESTS) {
		if (record.manifests[manifest] !== ours[manifest]) {
			return {
				problem: `it was built in ${record.checkout} with a ${manifest} that differs from this checkout's`,
			};
		}
	}
	return { checkout: record.checkout };
}

/**
 * Why the artifacts in `release` are not what cargo would build from `checkout`
 * now, one line each; none when they are. Only a build the record covers
 * counts, and the checkout it names is the one they were built from.
 */
export function nativeBuildProblems(
	release: string,
	checkout: string,
	artifacts: readonly NativeArtifact[] = nativeArtifacts(release),
): string[] {
	const recorded = recordedNativeBuild(release, checkout);
	if ("problem" in recorded) return [`${release}: ${recorded.problem}`];
	return artifacts.flatMap(({ artifact, crate }) => {
		const problem = nativeBuildProblem(artifact, crate, checkout, recorded.checkout);
		return problem === undefined ? [] : [`${artifact}: ${problem}`];
	});
}

/**
 * Why `artifact` is not what cargo would build from `checkout` now, or
 * `undefined` when it is. `crate` is the package that builds it. `builtIn` is
 * the checkout it was built from; by default, the one its dep-info file names.
 */
export function nativeBuildProblem(
	artifact: string,
	crate: string,
	checkout: string,
	builtIn?: string,
): string | undefined {
	const built = modified(artifact);
	if (built === undefined) return "it is missing";
	const depInfo = depInfoOf(artifact);
	let sources: string[];
	try {
		sources = parseDepInfo(readFileSync(depInfo, "utf8"));
	} catch {
		return `there is no ${basename(depInfo)} beside it to say what it was built from`;
	}
	const named = buildRoot(sources, crate);
	if (named === undefined) return `${basename(depInfo)} names no file of crates/${crate}`;
	const root = builtIn ?? named;
	const where = samePath(root, checkout) ? "" : ` in ${root}`;
	for (const listed of sources) {
		const path = relative(named, listed);
		if (path.startsWith("..") || isAbsolute(path)) {
			return `it was built from ${listed}, outside the checkout at ${named}`;
		}
		const source = join(root, path);
		const shown = path.split(sep).join("/");
		const changed = modified(source);
		if (changed === undefined) return `${shown}${where}, which it was built from, no longer exists`;
		if (changed > built) return `${shown}${where} changed after it was built`;
		// Always compared, even when the paths look like this checkout's: a
		// path compared as text can name the same directory two ways.
		const ours = readOrUndefined(join(checkout, path));
		if (ours === undefined) return `it was built from ${root}, and this checkout has no ${shown}`;
		if (!ours.equals(readFileSync(source))) {
			return `it was built from ${root}, whose ${shown} differs from this checkout's`;
		}
	}
	return undefined;
}

/**
 * The files a dep-info file lists. Cargo writes one line, `target: dep dep …`,
 * with each space inside a path escaped as `\ `. A Windows path's drive colon is
 * not followed by a space, so the first `: ` ends the target.
 */
export function parseDepInfo(text: string): string[] {
	const line = text.split(/\r?\n/, 1)[0] ?? "";
	const colon = line.indexOf(": ");
	if (colon < 0) return [];
	return line
		.slice(colon + 2)
		.split(/(?<!\\) /)
		.filter((entry) => entry.length > 0)
		.map((entry) => resolve(entry.replaceAll("\\ ", " ")));
}

/** Whether `a` and `b` name one directory, as this platform compares paths. */
export function samePath(a: string, b: string): boolean {
	const [left, right] = [resolve(a), resolve(b)];
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The modification time of each file cargo keeps for these crates in
 * `release`: the artifacts, and the fingerprint of every unit that builds them
 * or what they link. The dep-info files are left out, since a build that
 * compiles nothing still rewrites them.
 */
function buildState(release: string): Record<string, string> {
	const state: Record<string, string> = {};
	const note = (path: string) => {
		const time = modified(path);
		if (time !== undefined) state[relative(release, path).split(sep).join("/")] = String(time);
	};
	for (const { artifact } of nativeArtifacts(release)) note(artifact);
	const fingerprints = join(release, ".fingerprint");
	const unit = new RegExp(`^(${NATIVE_CRATES.join("|")})-[0-9a-f]{16}$`);
	for (const dir of listOrEmpty(fingerprints).filter((name) => unit.test(name))) {
		for (const file of listOrEmpty(join(fingerprints, dir))) note(join(fingerprints, dir, file));
	}
	return state;
}

/** The SHA-256 of each of `checkout`'s `NATIVE_MANIFESTS`, null for one it lacks. */
function manifestDigests(checkout: string): Record<string, string | null> {
	const digests: Record<string, string | null> = {};
	for (const manifest of NATIVE_MANIFESTS) {
		const contents = readOrUndefined(join(checkout, manifest));
		digests[manifest] =
			contents === undefined ? null : createHash("sha256").update(contents).digest("hex");
	}
	return digests;
}

function isRecord(value: unknown): value is {
	checkout: string;
	manifests: Record<string, string | null>;
	files: Record<string, string>;
} {
	if (typeof value !== "object" || value === null) return false;
	const { checkout, manifests, files } = value as Record<string, unknown>;
	return (
		typeof checkout === "string" &&
		typeof manifests === "object" &&
		manifests !== null &&
		Object.values(manifests).every((digest) => digest === null || typeof digest === "string") &&
		typeof files === "object" &&
		files !== null &&
		Object.values(files).every((time) => typeof time === "string")
	);
}

/** The dep-info file cargo writes beside `artifact`. */
function depInfoOf(artifact: string): string {
	return join(dirname(artifact), `${parse(artifact).name}.d`);
}

/** The checkout directory that holds `crates/<crate>` in the listed sources. */
function buildRoot(sources: readonly string[], crate: string): string | undefined {
	const marker = `/crates/${crate}/`;
	for (const source of sources) {
		// One character for one, so the index is the same in the original.
		const at = source.replaceAll("\\", "/").lastIndexOf(marker);
		if (at >= 0) return source.slice(0, at);
	}
	return undefined;
}

function listOrEmpty(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function modified(path: string): bigint | undefined {
	try {
		return statSync(path, { bigint: true }).mtimeNs;
	} catch {
		return undefined;
	}
}

function readOrUndefined(path: string): Buffer | undefined {
	try {
		return readFileSync(path);
	} catch {
		return undefined;
	}
}
