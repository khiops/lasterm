import type { HostOs } from "@lasterm/shared";

/**
 * The paths a client may name on a host it browses (#832), and the one form
 * each takes: what the file service hands every backend, and answers with.
 *
 * A path is absolute and taken literally: nothing in it is expanded, whatever
 * the backend, so a name may hold `$`, `%`, quotes or backticks. It has no `.`
 * or `..` segment, so the folder it names is the one it spells, whatever links
 * lie on the way.
 */

/** How a host spells its paths. */
export type PathStyle = "posix" | "windows";

export function pathStyleOf(os: HostOs): PathStyle {
	return os === "windows" ? "windows" : "posix";
}

/**
 * The root of a Windows host, which holds its drives: what lists them, and what
 * a drive's root (`C:\`) is in. `/` + a drive's name (`C:`) is `/C:`, which
 * normalises to that drive's root, so a client joins names onto it as onto any
 * other folder.
 */
export const WINDOWS_ROOT = "/";

export type NormalisedPath =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly reason: string };

function refused(reason: string): NormalisedPath {
	return { ok: false, reason };
}

/** `%NAME%`, which cmd.exe would expand and nothing here does (#711). */
const WINDOWS_VARIABLE = /%[A-Za-z_][A-Za-z0-9_().-]*%/;

/** What no Windows file name holds: these, the control characters, and `:` past the drive's. */
const WINDOWS_FORBIDDEN = /["<>|?*\p{Cc}]/u;

/** `path` in its one form for a host of `style`, or why it is refused. */
export function normaliseHostPath(path: string, style: PathStyle): NormalisedPath {
	if (path === "") return refused("the path is empty");
	if (path.includes("\0")) return refused("the path holds a NUL character");
	return style === "windows" ? normaliseWindowsPath(path) : normalisePosixPath(path);
}

function withoutDotSegments(segments: readonly string[]): NormalisedPath | null {
	return segments.some((segment) => segment === "." || segment === "..")
		? refused("the path has a . or .. segment: name the folder itself")
		: null;
}

function normalisePosixPath(path: string): NormalisedPath {
	if (!path.startsWith("/")) {
		if (path.startsWith("~")) {
			return refused(
				"a path starting with ~ is not expanded: give the home folder's absolute path",
			);
		}
		if (path.startsWith("$")) {
			return refused("environment variables are not expanded: give the absolute path");
		}
		return refused("the path is not absolute");
	}
	const segments = path.split("/").filter((segment) => segment !== "");
	const dots = withoutDotSegments(segments);
	if (dots) return dots;
	return { ok: true, path: `/${segments.join("/")}` };
}

function normaliseWindowsPath(input: string): NormalisedPath {
	if (WINDOWS_VARIABLE.test(input)) {
		return refused(
			"the path names an environment variable (%NAME%), which is not expanded: give the folder it stands for",
		);
	}
	let path = input.replace(/\//g, "\\");
	if (/^\\+$/.test(path)) return { ok: true, path: WINDOWS_ROOT };
	// `/C:/x`, as a Windows SFTP server spells `C:\x`.
	if (/^\\[A-Za-z]:(?:\\|$)/.test(path)) path = path.slice(1);

	let root: string;
	let rest: string;
	const drive = /^([A-Za-z]):(.*)$/s.exec(path);
	if (drive) {
		const [, letter = "", after = ""] = drive;
		if (after !== "" && !after.startsWith("\\")) {
			return refused("a drive-relative path (C:name) names no folder: give C:\\name");
		}
		root = `${letter.toUpperCase()}:\\`;
		rest = after;
	} else if (path.startsWith("\\\\")) {
		const [server = "", share = "", ...tail] = path.slice(2).split("\\");
		if (server === "?" || server === ".") {
			return refused("device paths (\\\\?\\, \\\\.\\) are not browsed");
		}
		if (server === "" || share === "") {
			return refused("a UNC path names a server and a share: \\\\server\\share");
		}
		root = `\\\\${server}\\${share}`;
		rest = tail.join("\\");
	} else if (path.startsWith("\\")) {
		return refused("the path names no drive: give C:\\… or \\\\server\\share\\…");
	} else {
		return refused("the path is not absolute: give C:\\… or \\\\server\\share\\…");
	}

	const segments = rest.split("\\").filter((segment) => segment !== "");
	const dots = withoutDotSegments([...root.slice(2).split("\\"), ...segments]);
	if (dots) return dots;
	const named = [...(root.startsWith("\\\\") ? root.slice(2).split("\\") : []), ...segments];
	if (named.some((segment) => WINDOWS_FORBIDDEN.test(segment) || segment.includes(":"))) {
		return refused(
			'the path holds a character no Windows name may: " < > | ? * : or a control character',
		);
	}
	if (segments.length === 0) return { ok: true, path: root };
	return { ok: true, path: `${root}${root.endsWith("\\") ? "" : "\\"}${segments.join("\\")}` };
}

/** The path of `name` in the folder `dir`, both as `normaliseHostPath` gives them. */
export function joinHostPath(dir: string, name: string, style: PathStyle): string {
	if (style === "posix") return dir === "/" ? `/${name}` : `${dir}/${name}`;
	if (dir === WINDOWS_ROOT) return `${name.replace(/[:\\]+$/, "").toUpperCase()}:\\`;
	return `${dir}${dir.endsWith("\\") ? "" : "\\"}${name}`;
}

/** The last name in `path`: a drive's root is its drive (`C:`), and a root is itself. */
export function baseNameOf(path: string, style: PathStyle): string {
	if (style === "posix") return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
	if (path === WINDOWS_ROOT) return WINDOWS_ROOT;
	if (/^[A-Z]:\\$/.test(path)) return path.slice(0, 2);
	return path.slice(path.lastIndexOf("\\") + 1);
}

/** The folder `path` is in, or null for a root (POSIX `/`, a drive's or a share's root, or the drives). */
export function parentOf(path: string, style: PathStyle): string | null {
	if (style === "posix") {
		if (path === "/") return null;
		const cut = path.lastIndexOf("/");
		return cut === 0 ? "/" : path.slice(0, cut);
	}
	if (path === WINDOWS_ROOT) return null;
	if (/^[A-Z]:\\$/.test(path)) return WINDOWS_ROOT;
	if (/^\\\\[^\\]+\\[^\\]+$/.test(path)) return null;
	const cut = path.lastIndexOf("\\");
	const parent = path.slice(0, cut);
	return /^[A-Z]:$/.test(parent) ? `${parent}\\` : parent;
}
