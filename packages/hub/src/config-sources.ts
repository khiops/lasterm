/**
 * Where `config.toml` is read from, per build channel (#1084).
 *
 * - Release: one file, `<config dir>/config.toml`, as it has always been.
 * - Dev: the file the Store build reads (S), read only, with the dev build's
 *   own `<config dir>/config.toml` (the overlay, O) applied on top. Every dev
 *   run so exercises the release's configuration, and every dev write goes to
 *   O, never to S.
 *
 * S is, on Windows, the Store package's private copy when it exists (MSIX
 * redirects a packaged app's new AppData files there), else the real
 * `%APPDATA%\lasterm\config.toml`; elsewhere the release channel's
 * `<XDG_CONFIG_HOME|~/.config>/lasterm/config.toml`.
 *
 * The merge works at the unit the Settings writers write, one key of a
 * section: top-level tables and `[appearance.<key>]` sub-tables merge key by
 * key; every other value present in O (a scalar, an array, or a table such as
 * `terminal.env`) replaces S's whole. `[agent] socket_path` is dropped from S,
 * since it would name the Store's agent pipe.
 *
 * A source that cannot be read or parsed contributes nothing, with one WARN
 * per process per source.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { type BuildChannel, buildChannel } from "@lasterm/shared";
import {
	lastermDir,
	type PlatformDirContext,
	platformBaseDir,
} from "@lasterm/shared/dist/platform-dirs.js";
import { checkConfigDirectoryPermissions } from "./auth.js";

/**
 * The Store package family name: `MSIX_IDENTITY_NAME` (`O2CSI.Lasterm`) and the
 * hash Windows derives from `MSIX_PUBLISHER`
 * (`CN=3DB35F84-A90B-410A-8375-06E93C7AB6C4`), measured from the installed
 * package on 2026-11-21. A changed Store identity makes S fall back to the
 * real AppData file.
 */
export const STORE_PACKAGE_FAMILY_NAME = "O2CSI.Lasterm_sx7tynvv0nmw4";

/** The configuration file inside a configuration directory. */
export function configFilePath(configDir: string): string {
	return path.join(configDir, "config.toml");
}

/** The context the dev resolution reads; tests substitute it. */
export interface ConfigSourceContext extends PlatformDirContext {
	readonly channel: BuildChannel;
}

function currentContext(): ConfigSourceContext {
	return { platform: process.platform, env: process.env, homedir, channel: buildChannel() };
}

/** The candidates for S, in the order they are tried. */
export function sharedConfigCandidates(context: PlatformDirContext): string[] {
	const paths = context.platform === "win32" ? path.win32 : path.posix;
	const release = { ...context, channel: "release" as const };
	if (context.platform !== "win32") {
		return [paths.join(lastermDir("config", release), "config.toml")];
	}
	const candidates: string[] = [];
	try {
		candidates.push(
			paths.join(
				platformBaseDir("state", context),
				"Packages",
				STORE_PACKAGE_FAMILY_NAME,
				"LocalCache",
				"Roaming",
				"lasterm",
				"config.toml",
			),
		);
	} catch {
		// No LOCALAPPDATA: no package folder to look in.
	}
	try {
		candidates.push(paths.join(lastermDir("config", release), "config.toml"));
	} catch {
		// No APPDATA: no real file either.
	}
	return candidates;
}

type WarnedSource = "shared" | "overlay" | "socket_path";
const warned = new Set<WarnedSource>();

function warnOnce(source: WarnedSource, message: string): void {
	if (warned.has(source)) return;
	warned.add(source);
	process.stderr.write(`[config] WARN ${message}\n`);
}

/** Test-only: forget which sources were warned about. */
export function resetConfigWarnings(): void {
	warned.clear();
}

function isAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** S as the dev channel reads it: its table, or `{}` when it contributes nothing. */
function readShared(context: ConfigSourceContext): TOML.JsonMap {
	for (const candidate of sharedConfigCandidates(context)) {
		try {
			statSync(candidate);
		} catch (error) {
			if (isAbsent(error)) continue;
			warnOnce(
				"shared",
				`the shared config ${candidate} cannot be read, ignored: ${describe(error)}`,
			);
			return {};
		}
		// It exists: it is S, whether or not it can be used.
		try {
			checkConfigDirectoryPermissions(path.dirname(candidate));
			const parsed = TOML.parse(readFileSync(candidate, "utf8"));
			return withoutSharedSocketPath(parsed);
		} catch (error) {
			warnOnce("shared", `the shared config ${candidate} is not used: ${describe(error)}`);
			return {};
		}
	}
	return {};
}

/** S without `[agent] socket_path`, which would name the Store's agent. */
function withoutSharedSocketPath(parsed: TOML.JsonMap): TOML.JsonMap {
	const agent = parsed.agent;
	if (!isTable(agent) || !("socket_path" in agent)) return parsed;
	warnOnce(
		"socket_path",
		"[agent] socket_path from the shared config is ignored by a development build; set it in the dev config to use one",
	);
	const { socket_path: _dropped, ...rest } = agent;
	return { ...parsed, agent: rest as TOML.JsonMap };
}

/** What reading O gave. */
export type OverlayRead = { ok: true; value: TOML.JsonMap } | { ok: false; error: string };

/** Read O: absent is empty; unreadable or unparsable is an error. */
export function readOverlay(overlayPath: string): OverlayRead {
	let content: string;
	try {
		content = readFileSync(overlayPath, "utf8");
	} catch (error) {
		if (isAbsent(error)) return { ok: true, value: {} };
		return { ok: false, error: `the dev config ${overlayPath} cannot be read: ${describe(error)}` };
	}
	try {
		return { ok: true, value: TOML.parse(content) };
	} catch (error) {
		return { ok: false, error: `the dev config ${overlayPath} does not parse: ${describe(error)}` };
	}
}

function isTable(value: unknown): value is TOML.JsonMap {
	return (
		value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
	);
}

function mergeTables(
	base: TOML.JsonMap,
	over: TOML.JsonMap,
	deeper: (key: string) => boolean,
): TOML.JsonMap {
	const result: TOML.JsonMap = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const current = result[key];
		result[key] =
			deeper(key) && isTable(value) && isTable(current)
				? mergeTables(current, value, () => false)
				: value;
	}
	return result;
}

/** S merged with O at the writers' unit (see the module comment). */
export function mergeSharedAndOverlay(shared: TOML.JsonMap, overlay: TOML.JsonMap): TOML.JsonMap {
	const result: TOML.JsonMap = { ...shared };
	for (const [section, value] of Object.entries(overlay)) {
		const current = result[section];
		if (isTable(value) && isTable(current)) {
			result[section] = mergeTables(current, value, () => section === "appearance");
		} else {
			result[section] = value;
		}
	}
	return result;
}

/**
 * The configuration the loaders read. Release: `undefined` when the file is
 * absent, else its parsed table — a parse error is thrown, for each loader to
 * handle as it always has. Dev: the merge of S and O, never thrown.
 */
export function readConfigTable(
	configDir: string,
	context: ConfigSourceContext = currentContext(),
): TOML.JsonMap | undefined {
	const own = configFilePath(configDir);
	if (context.channel === "release") {
		if (!existsSync(own)) return undefined;
		return TOML.parse(readFileSync(own, "utf8"));
	}
	const overlay = readOverlay(own);
	if (!overlay.ok) warnOnce("overlay", `${overlay.error}; it is ignored`);
	return mergeSharedAndOverlay(readShared(context), overlay.ok ? overlay.value : {});
}

/** Whether this process reads S under O. */
export function readsSharedConfig(context: ConfigSourceContext = currentContext()): boolean {
	return context.channel === "dev";
}
