/**
 * release-assets.ts
 *
 * Decides what a release publishes, from the workflow artifacts a build produced.
 *
 * build.yml uploads one artifact per producer and enabled target, each holding
 * a single <name>.tar. Its callers download only the agent-, hub- and
 * desktop-<triple> ones; the msix-<triple> artifact is a Store-submission input
 * and is refused here if it arrives. This extracts the downloaded artifacts and
 * resolves the files against .github/build-matrix.json:
 *
 *   - the artifacts present are exactly the expected ones, no more, no less;
 *   - each tar holds regular files at its top level and nothing else;
 *   - an agent artifact holds the one executable its producer writes, published
 *     under the name the hub fetches;
 *   - a hub artifact holds the executable and the native addons it loads from
 *     its own directory (#889), and nothing else. They are published together,
 *     as one zip this script writes, under the name the matrix declares;
 *   - each desktop declaration matches exactly one file, and every file
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
 *     --version 0.10.1 --downloads <dir> --extract-to <dir> --out <manifest.json>
 */

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * The native addons the hub executable loads from its own directory, which it
 * refuses to start without (#889): its artifact carries them beside it.
 */
export const HUB_ADDONS: readonly string[] = ["lasterm_hub_lock.node", "lasterm_tls_identity.node"];

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
	};
}

export interface Matrix {
	targets: MatrixTarget[];
}

export type Kind = "agent" | "hub" | "desktop";

export interface ReleaseAsset {
	kind: Kind;
	triple: string;
	/** Workflow artifact the file came from. */
	artifact: string;
	/** File name inside that artifact's tar; for a zip, the archive written beside them. */
	file: string;
	/** Name the file is published under. */
	asset: string;
	/** For a zip: the artifact's files it holds, in this order, at its top level. */
	members?: string[];
}

interface Candidate {
	file: string;
	asset: string;
	members?: string[];
}

export interface Resolution {
	assets: ReleaseAsset[];
	errors: string[];
}

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
): Map<string, { kind: Kind; target: MatrixTarget }> {
	const expected = new Map<string, { kind: Kind; target: MatrixTarget }>();
	for (const target of matrix.targets) {
		if (!target.enabled) continue;
		if (target.agent) expected.set(`agent-${target.triple}`, { kind: "agent", target });
		if (target.hub) expected.set(`hub-${target.triple}`, { kind: "hub", target });
		if (target.desktop && target.artifacts?.bundles && target.artifacts.desktop) {
			expected.set(`desktop-${target.triple}`, { kind: "desktop", target });
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
	candidates: readonly Candidate[],
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
			...(match.members === undefined ? {} : { members: match.members }),
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
 * The hub's files, executable first: exactly the executable and its addons.
 * Without an addon the executable does not start, and anything else would be
 * published unexamined.
 */
function resolveHubFiles(
	artifact: string,
	target: MatrixTarget,
	files: readonly string[],
	out: Resolution,
): string[] | undefined {
	const expected = [executableName("lasterm-hub", target), ...HUB_ADDONS];
	const found = [...files].sort();
	if (found.length !== expected.length || [...expected].sort().some((f, i) => f !== found[i])) {
		out.errors.push(
			`${artifact}: expected exactly ${showList(expected)}, found ${showList(files)}`,
		);
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
	contents: ReadonlyMap<string, readonly string[]>,
): Resolution {
	const out: Resolution = { assets: [], errors: [] };
	const expected = expectedArtifacts(matrix);

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
			const members = resolveHubFiles(name, target, files, out);
			if (members !== undefined) {
				const zip = `lasterm-hub-${target.triple}.zip`;
				const candidates = [{ file: zip, asset: zip, members }];
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

export interface ZipEntry {
	readonly name: string;
	readonly data: Buffer;
	/** Unix permission bits, which unzip restores and Windows ignores. */
	readonly mode: number;
}

/** 1980-01-01 00:00, the earliest time a zip records, as an MS-DOS date. */
const ZIP_EPOCH_DATE = (0 << 9) | (1 << 5) | 1;
const ZIP_LIMIT = 0xffffffff;

/**
 * A zip archive of `entries`, deflated, in the given order, every time at the
 * format's epoch: the same files give the same bytes. Built from Node's zlib
 * alone, for the job that may not install anything. No ZIP64: an entry or an
 * archive of 4 GiB or more is refused, which no executable here approaches.
 */
export function zipArchive(entries: readonly ZipEntry[]): Buffer {
	if (entries.length > 0xffff) throw new Error("a zip holds at most 65535 entries without ZIP64");
	const parts: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const compressed = deflateRawSync(entry.data, { level: 9 });
		const crc = crc32(entry.data);
		if (entry.data.length >= ZIP_LIMIT || compressed.length >= ZIP_LIMIT || offset >= ZIP_LIMIT) {
			throw new Error(`${entry.name} is too large for a zip without ZIP64`);
		}
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed: 2.0, for deflate
		local.writeUInt16LE(0x0800, 6); // the name is UTF-8
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(ZIP_EPOCH_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is read
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(ZIP_EPOCH_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		// Extra field, comment, disk and internal attributes: none.
		central.writeUInt32LE(((0o100000 | (entry.mode & 0o777)) << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		parts.push(local, name, compressed);
		directory.push(central, name);
		offset += local.length + name.length + compressed.length;
	}
	const centralDirectory = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, centralDirectory, end]);
}

/**
 * Write each zip the resolution names, beside the artifact files it holds: the
 * executable 0755, an addon 0644.
 */
export function writeZipAssets(assets: readonly ReleaseAsset[], extractDir: string): void {
	for (const asset of assets) {
		if (asset.members === undefined) continue;
		const dir = join(extractDir, asset.artifact);
		const entries = asset.members.map((name) => ({
			name,
			data: readFileSync(join(dir, name)),
			mode: name.endsWith(".node") ? 0o644 : 0o755,
		}));
		writeFileSync(join(dir, asset.file), zipArchive(entries));
	}
}

function argument(argv: readonly string[], flag: string): string {
	const i = argv.indexOf(flag);
	const value = i >= 0 ? argv[i + 1] : undefined;
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`missing ${flag}`);
	}
	return value;
}

function rejectUnknownOptions(argv: readonly string[]): void {
	const known = new Set(["--matrix", "--version", "--downloads", "--extract-to", "--out"]);
	for (const value of argv) {
		if (value.startsWith("--") && !known.has(value)) {
			throw new Error(`unknown option ${value}`);
		}
	}
}

function main(argv: readonly string[]): number {
	rejectUnknownOptions(argv);
	const matrix = JSON.parse(readFileSync(argument(argv, "--matrix"), "utf8")) as Matrix;
	const version = argument(argv, "--version");
	const extractDir = argument(argv, "--extract-to");
	const extracted = extractArtifacts(argument(argv, "--downloads"), extractDir);
	const resolution = resolveReleaseAssets(matrix, version, extracted.contents);
	const errors = [...extracted.errors, ...resolution.errors];
	if (errors.length > 0) {
		for (const error of errors) console.error(`::error::${error}`);
		return 1;
	}
	writeZipAssets(resolution.assets, extractDir);
	const manifest = resolution.assets.map((a) => ({
		...a,
		path: join(extractDir, a.artifact, a.file),
	}));
	writeFileSync(argument(argv, "--out"), `${JSON.stringify(manifest, null, 2)}\n`);
	for (const a of manifest) {
		const from = a.members === undefined ? a.file : `{${a.members.join(",")}}`;
		console.log(`${a.asset}\t<- ${a.artifact}/${from}`);
	}
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
