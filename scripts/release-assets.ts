/**
 * release-assets.ts
 *
 * Decides what a release publishes, from the workflow artifacts a build produced.
 *
 * build.yml uploads one artifact per producer and enabled target — agent-,
 * hub-, desktop- and msix-<triple> — each holding a single <name>.tar. This
 * extracts them and resolves the files against .github/build-matrix.json:
 *
 *   - the artifacts present are exactly the expected ones, no more, no less;
 *   - each tar holds regular files at its top level and nothing else;
 *   - agent and hub artifacts hold the one executable their producer writes,
 *     published under the name the hub fetches (agent) or the matrix declares (hub);
 *   - each desktop / MSIX declaration matches exactly one file, and every file
 *     matches a declaration;
 *   - no two deliverables share a public name.
 *
 * It runs on Linux only, in build.yml's dry run and again in release.yml's
 * publish-release, so no Windows shell decides what ships (#272). It imports
 * nothing but Node built-ins and runs under Node's own type stripping: the job
 * that holds the release-write token must not install dependencies.
 *
 * Usage:
 *   node scripts/release-assets.ts --matrix .github/build-matrix.json \
 *     --version 0.10.1 --msix true --downloads <dir> --extract-to <dir> --out <manifest.json>
 */

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface MatrixTarget {
	triple: string;
	os: string;
	enabled?: boolean;
	agent?: boolean;
	hub?: boolean;
	desktop?: boolean;
	artifacts?: {
		bundles?: string[];
		hub?: string[];
		desktop?: string[];
		msix?: string[];
	};
}

export interface Matrix {
	targets: MatrixTarget[];
}

export type Kind = "agent" | "hub" | "desktop" | "msix";

export interface ReleaseAsset {
	kind: Kind;
	triple: string;
	/** Workflow artifact the file came from. */
	artifact: string;
	/** File name inside that artifact's tar. */
	file: string;
	/** Name the file is published under. */
	asset: string;
}

export interface Resolution {
	assets: ReleaseAsset[];
	errors: string[];
}

/**
 * The one triple whose desktop build packages an MSIX. build.yml's packaging
 * and upload steps carry the same predicate; change them together.
 */
export const MSIX_TRIPLE = "x86_64-pc-windows-msvc";

export function checksumsName(version: string): string {
	return `SHA256SUMS-${version}.txt`;
}

/** The executable a producer writes into dist/sea for this target. */
export function executableName(base: string, target: MatrixTarget): string {
	return target.os === "windows" ? `${base}.exe` : base;
}

function extension(target: MatrixTarget): string {
	return target.os === "windows" ? ".exe" : "";
}

/** JSON quoting makes a stray CR, NUL or trailing space visible in a log line. */
function show(value: string): string {
	return JSON.stringify(value);
}

function showList(values: readonly string[]): string {
	return values.length === 0 ? "(none)" : values.map(show).join(", ");
}

/**
 * A matrix declaration as a whole-string RegExp. `*` matches any run of
 * characters and `?` exactly one; everything else is literal. Bracket
 * expressions are refused by `declarationErrors` rather than half-supported.
 */
export function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (const ch of pattern) {
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else source += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "s");
}

function declarationErrors(artifact: string, kind: Kind, declared: readonly string[]): string[] {
	const errors: string[] = [];
	declared.forEach((pattern, i) => {
		if (/[[\]]/.test(pattern)) {
			errors.push(
				`${artifact}: artifacts.${kind}[${i}] ${show(pattern)} uses a bracket expression, which this resolver does not support`,
			);
		}
	});
	return errors;
}

/** Artifact name → the producer and target it must come from. */
export function expectedArtifacts(
	matrix: Matrix,
	msix: boolean,
): Map<string, { kind: Kind; target: MatrixTarget }> {
	const expected = new Map<string, { kind: Kind; target: MatrixTarget }>();
	for (const target of matrix.targets) {
		if (!target.enabled) continue;
		if (target.agent) expected.set(`agent-${target.triple}`, { kind: "agent", target });
		if (target.hub) expected.set(`hub-${target.triple}`, { kind: "hub", target });
		if (target.desktop) expected.set(`desktop-${target.triple}`, { kind: "desktop", target });
		if (target.desktop && msix && target.triple === MSIX_TRIPLE) {
			expected.set(`msix-${target.triple}`, { kind: "msix", target });
		}
	}
	return expected;
}

/**
 * Match candidates against declarations in both directions: every declaration
 * names exactly one candidate, no candidate is named twice, and every
 * candidate is named. Candidates are compared by their public name.
 */
function resolveDeclared(
	artifact: string,
	kind: Kind,
	target: MatrixTarget,
	candidates: readonly { file: string; asset: string }[],
	declared: readonly string[],
	version: string,
	out: Resolution,
): void {
	const bracketErrors = declarationErrors(artifact, kind, declared);
	if (bracketErrors.length > 0) {
		out.errors.push(...bracketErrors);
		return;
	}
	if (declared.length === 0) {
		out.errors.push(`${artifact}: target ${target.triple} declares no artifacts.${kind}`);
		return;
	}
	const expanded = declared.map((pattern) => pattern.replaceAll("{version}", version));
	const regexps = expanded.map(globToRegExp);
	const claimedBy = new Map<string, string>();
	const names = candidates.map((c) => c.asset);
	expanded.forEach((pattern, i) => {
		const re = globToRegExp(pattern);
		const matches = candidates.filter((c) => re.test(c.asset));
		const [match, another] = matches;
		if (match === undefined) {
			out.errors.push(
				`${artifact}: artifacts.${kind}[${i}] ${show(pattern)} matched no file; candidates: ${showList(names)}`,
			);
			return;
		}
		if (another !== undefined) {
			out.errors.push(
				`${artifact}: artifacts.${kind}[${i}] ${show(pattern)} matched more than one file: ${showList(matches.map((m) => m.asset))}`,
			);
			return;
		}
		const previous = claimedBy.get(match.asset);
		if (previous !== undefined) {
			out.errors.push(
				`${artifact}: artifacts.${kind} ${show(previous)} and ${show(pattern)} both matched ${show(match.asset)}`,
			);
			return;
		}
		claimedBy.set(match.asset, pattern);
		out.assets.push({
			kind,
			triple: target.triple,
			artifact,
			file: match.file,
			asset: match.asset,
		});
	});
	for (const candidate of candidates) {
		if (!regexps.some((re) => re.test(candidate.asset))) {
			out.errors.push(
				`${artifact}: ${show(candidate.file)} matches no artifacts.${kind} declaration; declared: ${showList(expanded)}`,
			);
		}
	}
}

function resolveExecutable(
	artifact: string,
	base: string,
	target: MatrixTarget,
	files: readonly string[],
	out: Resolution,
): string | undefined {
	const expected = executableName(base, target);
	if (files.length !== 1 || files[0] !== expected) {
		out.errors.push(`${artifact}: expected exactly ${show(expected)}, found ${showList(files)}`);
		return undefined;
	}
	return expected;
}

/**
 * Resolve extracted artifacts into release assets.
 *
 * @param contents artifact name → regular file names at the top of its tar
 */
export function resolveReleaseAssets(
	matrix: Matrix,
	version: string,
	msix: boolean,
	contents: ReadonlyMap<string, readonly string[]>,
): Resolution {
	const out: Resolution = { assets: [], errors: [] };
	const expected = expectedArtifacts(matrix, msix);

	for (const name of contents.keys()) {
		if (!expected.has(name)) {
			out.errors.push(`unexpected artifact ${show(name)}: no enabled target produces it`);
		}
	}
	for (const [name, { kind, target }] of expected) {
		const files = contents.get(name);
		if (files === undefined) {
			out.errors.push(`missing artifact ${show(name)} for the ${kind} of ${target.triple}`);
			continue;
		}
		if (kind === "agent") {
			const file = resolveExecutable(name, "lasterm-agent", target, files, out);
			if (file !== undefined) {
				out.assets.push({
					kind,
					triple: target.triple,
					artifact: name,
					file,
					asset: `lasterm-agent-${target.triple}-${version}${extension(target)}`,
				});
			}
		} else if (kind === "hub") {
			const file = resolveExecutable(name, "lasterm-hub", target, files, out);
			if (file !== undefined) {
				const candidates = [{ file, asset: `lasterm-hub-${target.triple}${extension(target)}` }];
				resolveDeclared(name, kind, target, candidates, target.artifacts?.hub ?? [], version, out);
			}
		} else {
			const candidates = files.map((file) => ({ file, asset: file }));
			const declared = target.artifacts?.[kind] ?? [];
			resolveDeclared(name, kind, target, candidates, declared, version, out);
		}
	}

	const byAsset = new Map<string, ReleaseAsset>();
	for (const asset of out.assets) {
		const other = byAsset.get(asset.asset);
		if (other !== undefined) {
			out.errors.push(
				`${show(asset.asset)} is produced by both ${other.artifact} and ${asset.artifact}`,
			);
		}
		byAsset.set(asset.asset, asset);
		if (asset.asset === checksumsName(version)) {
			out.errors.push(
				`${asset.artifact}: ${show(asset.asset)} collides with the checksum manifest`,
			);
		}
	}
	return out;
}

/** A tar member path that lands at the top of the extraction directory. */
function isFlatMember(member: string): boolean {
	const name = member.startsWith("./") ? member.slice(2) : member;
	return name === "" || (!name.includes("/") && name !== "." && name !== "..");
}

/**
 * Extract each downloaded artifact's single tar into its own directory and
 * return the regular files found there. Everything that is not exactly one
 * flat tar of regular files is an error, reported per artifact.
 *
 * tar gets relative, forward-slash paths only, run from the artifact's own
 * directory. Publication runs on Linux, but the specs also run on Windows,
 * where the tar on PATH is Git's GNU tar: it reads a leading `C:` in an archive
 * name as a remote host, and a `-C` directory handed over from Node loses its
 * backslashes to escapes (`\a` of `\agent-…` arrives as a BEL).
 */
export function extractArtifacts(
	downloadsDir: string,
	extractDir: string,
): { contents: Map<string, string[]>; errors: string[] } {
	const contents = new Map<string, string[]>();
	const errors: string[] = [];
	for (const entry of readdirSync(downloadsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			errors.push(`downloads: ${show(entry.name)} is not an artifact directory`);
			continue;
		}
		const name = entry.name;
		const dir = join(downloadsDir, name);
		const tarName = `${name}.tar`;
		const held = readdirSync(dir);
		if (held.length !== 1 || held[0] !== tarName) {
			errors.push(`${name}: expected exactly ${show(tarName)}, found ${showList(held)}`);
			continue;
		}
		const listing = spawnSync("tar", ["-tf", tarName], { cwd: dir, encoding: "utf8" });
		if (listing.status !== 0) {
			errors.push(`${name}: tar -tf failed: ${listing.stderr || listing.error?.message}`);
			continue;
		}
		const members = listing.stdout.split("\n").filter((m) => m !== "");
		const nested = members.filter((m) => !isFlatMember(m));
		if (nested.length > 0) {
			errors.push(`${name}: tar holds entries outside its top level: ${showList(nested)}`);
			continue;
		}
		const target = resolve(extractDir, name);
		mkdirSync(target, { recursive: true });
		const into = relative(resolve(dir), target).split(sep).join("/");
		const extraction = spawnSync("tar", ["-xf", tarName, "-C", into], {
			cwd: dir,
			encoding: "utf8",
		});
		if (extraction.status !== 0) {
			errors.push(`${name}: tar -xf failed: ${extraction.stderr || extraction.error?.message}`);
			continue;
		}
		const files: string[] = [];
		for (const file of readdirSync(target)) {
			if (lstatSync(join(target, file)).isFile()) files.push(file);
			else errors.push(`${name}: ${show(file)} is not a regular file`);
		}
		contents.set(name, files.sort());
	}
	return { contents, errors };
}

function argument(argv: readonly string[], flag: string): string {
	const i = argv.indexOf(flag);
	const value = i >= 0 ? argv[i + 1] : undefined;
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`missing ${flag}`);
	}
	return value;
}

function main(argv: readonly string[]): number {
	const matrix = JSON.parse(readFileSync(argument(argv, "--matrix"), "utf8")) as Matrix;
	const version = argument(argv, "--version");
	const msixFlag = argument(argv, "--msix");
	if (msixFlag !== "true" && msixFlag !== "false") {
		throw new Error(`--msix must be true or false, got ${show(msixFlag)}`);
	}
	const extractDir = argument(argv, "--extract-to");
	const extracted = extractArtifacts(argument(argv, "--downloads"), extractDir);
	const resolution = resolveReleaseAssets(matrix, version, msixFlag === "true", extracted.contents);
	const errors = [...extracted.errors, ...resolution.errors];
	if (errors.length > 0) {
		for (const error of errors) console.error(`::error::${error}`);
		return 1;
	}
	const manifest = resolution.assets.map((a) => ({
		...a,
		path: join(extractDir, a.artifact, a.file),
	}));
	writeFileSync(argument(argv, "--out"), `${JSON.stringify(manifest, null, 2)}\n`);
	for (const a of manifest) console.log(`${a.asset}\t<- ${a.artifact}/${a.file}`);
	return 0;
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err: unknown) {
		console.error(`::error::release-assets: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
