/**
 * Where lasterm keeps its state, configuration and cache: the one resolver the
 * hub and the tools around it call (#297).
 *
 * The rule is the one the desktop already applies (#241), so every component
 * agrees on the same directory or refuses:
 *
 * - Windows: `LOCALAPPDATA` (state, cache) or `APPDATA` (configuration) must be
 *   an absolute path. Absent, empty or relative, the lookup fails and names the
 *   variable. Nothing is invented: a directory made up here would not be the
 *   one another component made up, and a hub and agent reading different
 *   configuration directories is how agent authentication gets switched off
 *   (#165).
 * - Elsewhere: `XDG_STATE_HOME`, `XDG_CONFIG_HOME` or `XDG_CACHE_HOME` when it is
 *   an absolute path. A relative or empty one is ignored, as the XDG Base
 *   Directory specification requires, and the home-directory default is used,
 *   which must itself be absolute.
 */
import { homedir } from "node:os";
import path from "node:path";

export type PlatformDirKind = "state" | "config" | "cache";

/** What the lookup reads; tests substitute it to cover both platforms. */
export interface PlatformDirContext {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly homedir: () => string;
}

/** Thrown when the environment does not say where a directory is. */
export class PlatformDirError extends Error {
	readonly code = "PLATFORM_DIR_UNRESOLVED";

	constructor(message: string) {
		super(message);
		this.name = "PlatformDirError";
	}
}

const WINDOWS_VARIABLE: Record<PlatformDirKind, string> = {
	state: "LOCALAPPDATA",
	config: "APPDATA",
	cache: "LOCALAPPDATA",
};

const XDG_VARIABLE: Record<PlatformDirKind, string> = {
	state: "XDG_STATE_HOME",
	config: "XDG_CONFIG_HOME",
	cache: "XDG_CACHE_HOME",
};

const HOME_DEFAULT: Record<PlatformDirKind, readonly string[]> = {
	state: [".local", "state"],
	config: [".config"],
	cache: [".cache"],
};

function currentContext(): PlatformDirContext {
	return { platform: process.platform, env: process.env, homedir };
}

function pathFor(context: PlatformDirContext): path.PlatformPath {
	return context.platform === "win32" ? path.win32 : path.posix;
}

/**
 * The platform directory that holds `kind` for every application: the value of
 * the variable, or its home-directory default. The product name is not added.
 */
export function platformBaseDir(
	kind: PlatformDirKind,
	context: PlatformDirContext = currentContext(),
): string {
	const paths = pathFor(context);
	if (context.platform === "win32") {
		const name = WINDOWS_VARIABLE[kind];
		const value = context.env[name];
		if (!value) {
			throw new PlatformDirError(
				`${name} is absent or empty, so the lasterm ${kind} directory cannot be located`,
			);
		}
		if (!paths.isAbsolute(value)) {
			throw new PlatformDirError(
				`${name} is not an absolute path (${value}), so the lasterm ${kind} directory cannot be located`,
			);
		}
		return value;
	}

	const name = XDG_VARIABLE[kind];
	const value = context.env[name];
	if (value && paths.isAbsolute(value)) return value;
	const home = context.homedir();
	if (!home || !paths.isAbsolute(home)) {
		throw new PlatformDirError(
			`the lasterm ${kind} directory cannot be located: ${name} is not an absolute path and neither is the home directory (${home || "none"})`,
		);
	}
	return paths.join(home, ...HOME_DEFAULT[kind]);
}

/**
 * lasterm's own directory for `kind`. On Windows the cache sits inside the
 * state tree (`%LOCALAPPDATA%\lasterm\cache`), where it has always been.
 */
export function lastermDir(
	kind: PlatformDirKind,
	context: PlatformDirContext = currentContext(),
): string {
	const paths = pathFor(context);
	const base = platformBaseDir(kind, context);
	return context.platform === "win32" && kind === "cache"
		? paths.join(base, "lasterm", "cache")
		: paths.join(base, "lasterm");
}
