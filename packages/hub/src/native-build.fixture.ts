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
 * What this cannot see is a dep-info file that names this checkout for an
 * artifact another one built. Those checkouts also share cargo's record of which
 * crates are fresh, one per crate for all of them, and it goes by modification
 * time. Once another checkout has built newer artifacts, a `cargo build` here
 * (the one `pnpm -F @lasterm/hub test` runs first included) can compile nothing,
 * rewrite the dep-info files to name this checkout's sources, and leave the other
 * checkout's artifacts in place, which then pass. So the rebuild a refusal names
 * cleans the crates first.
 *
 * Only the files cargo lists are compared. A manifest change that alters the
 * build (a dependency, a feature) is not seen.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/**
 * Why `artifact` is not what cargo would build from `checkout` now, or
 * `undefined` when it is. `crate` is the package that builds it; its directory
 * locates the checkout the artifact was built from.
 */
export function nativeBuildProblem(
	artifact: string,
	crate: string,
	checkout: string,
): string | undefined {
	const built = modified(artifact);
	if (built === undefined) return "it is missing";
	const depInfo = join(dirname(artifact), `${parse(artifact).name}.d`);
	let sources: string[];
	try {
		sources = parseDepInfo(readFileSync(depInfo, "utf8"));
	} catch {
		return `there is no ${basename(depInfo)} beside it to say what it was built from`;
	}
	const root = buildRoot(sources, crate);
	if (root === undefined) return `${basename(depInfo)} names no file of crates/${crate}`;
	const where = samePath(root, checkout) ? "" : ` in ${root}`;
	for (const source of sources) {
		const path = relative(root, source);
		if (path.startsWith("..") || isAbsolute(path)) {
			return `it was built from ${source}, outside the checkout at ${root}`;
		}
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

function samePath(a: string, b: string): boolean {
	const [left, right] = [resolve(a), resolve(b)];
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
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
