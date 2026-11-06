/**
 * The files panel beside the panes (#836, part of #721): what it decides without a page. Where
 * it shows (docked, floating, a sheet), which terminal it is attached to, a host's paths as its
 * path bar reads them, a listing's rows, the settings in its Options section and where each
 * comes from, and the Transfers part's groups. The panel (components/files/) and App.vue read
 * them here; each is tested beside this file.
 */
import {
	type CwdSource,
	type DroppedOverride,
	type HostOs,
	type LiveCwd,
	type ProfileWriteLayers,
	type ProfileWriteScope,
	planProfileWrite,
	type TerminalProfile,
	type TransferOnConflict,
} from "@lasterm/shared";

/** The panel's element id, which each pane's folder button controls (`aria-controls`). */
export const FILES_PANEL_ID = "files-panel";

// ─── Where the panel shows ───────────────────────────────────────────────────

/**
 * Docked beside the panes, which it narrows; floating over the right of the pane area, below the
 * pane header, taking no room and resizing nothing; or a sheet over the whole terminal area.
 */
export type FilesPanelForm = "docked" | "overlay" | "sheet";

/** Below this window width the panel is a sheet over the terminal area. */
export const SHEET_BELOW_WINDOW_WIDTH = 560;

/** Docked only while the panes keep at least this much room beside it. */
export const DOCKED_PANES_MIN_WIDTH = 480;

export interface PanelFormFacts {
	/** The window's width. */
	readonly windowWidth: number;
	/** The width the panes and a docked panel share: the terminal area below the tab bar. */
	readonly areaWidth: number;
	/** The panel's own width. */
	readonly panelWidth: number;
	/**
	 * Whether this window writes the terminal the panel is attached to, which makes it the one
	 * that decides its size (#831); null when the panel is attached to none.
	 */
	readonly writesAttached: boolean | null;
}

/**
 * How the panel shows. A sheet below 560 px of window. Then, until the writer's panel is shared
 * with the readers (#838), a reader's panel floats, so that opening it never resizes anything: a
 * docked panel narrows every pane of the tab, and the window would resize the terminals it writes
 * there for everyone, by a gesture on a terminal it only reads. Otherwise docked while the panes
 * keep 480 px, floating when they would not.
 */
export function filesPanelForm(facts: PanelFormFacts): FilesPanelForm {
	if (facts.windowWidth < SHEET_BELOW_WINDOW_WIDTH) return "sheet";
	if (facts.writesAttached === false) return "overlay";
	return facts.areaWidth - facts.panelWidth < DOCKED_PANES_MIN_WIDTH ? "overlay" : "docked";
}

// ─── Which terminal it shows ─────────────────────────────────────────────────

/**
 * The terminal the panel is attached to: the pinned one while some tab of the window still shows
 * it, else the one whose pane has the focus, or none (an empty pane, no tab).
 */
export function attachedChannel(
	pinned: string | null,
	focused: string | null,
	isInSomeTab: (channelId: string) => boolean,
): string | null {
	return pinned !== null && isInSomeTab(pinned) ? pinned : focused;
}

// ─── A host's paths, as the hub spells them (PROTOCOL.md, Host Files) ────────

/** POSIX (`/home/pi`) or Windows (`C:\Users\pi`, `\\server\share`, `/` the drives). */
export type PathStyle = "posix" | "windows";

/** The style of a host's paths: its OS when known, else what a path it gave looks like. */
export function pathStyleOf(os: HostOs | null | undefined, path: string | null): PathStyle {
	if (os === "windows") return "windows";
	if (os === "linux" || os === "darwin") return "posix";
	return path !== null && (/^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\"))
		? "windows"
		: "posix";
}

/** One folder of the path bar: what it shows, and the path it opens. */
export interface Crumb {
	readonly label: string;
	readonly path: string;
}

/** The root of a Windows host, which lists its drives. */
const WINDOWS_ROOT = "/";

/**
 * The path bar's folders, from the root to `path`. On a Windows host the root `/` lists the
 * drives, a share starts at `\\server\share`, and a drive at `C:\`.
 */
export function breadcrumbOf(path: string, style: PathStyle): Crumb[] {
	if (style === "posix") {
		const crumbs: Crumb[] = [{ label: "/", path: "/" }];
		let at = "";
		for (const part of path.split("/").filter((p) => p !== "")) {
			at = `${at}/${part}`;
			crumbs.push({ label: part, path: at });
		}
		return crumbs;
	}
	const crumbs: Crumb[] = [{ label: "Drives", path: WINDOWS_ROOT }];
	if (path === WINDOWS_ROOT) return crumbs;
	if (path.startsWith("\\\\")) {
		const [server = "", share = "", ...rest] = path.slice(2).split("\\");
		let at = `\\\\${server}\\${share}`;
		crumbs.push({ label: at, path: at });
		for (const part of rest.filter((p) => p !== "")) {
			at = `${at}\\${part}`;
			crumbs.push({ label: part, path: at });
		}
		return crumbs;
	}
	const [drive = "", ...rest] = path.split("\\");
	let at = `${drive}\\`;
	crumbs.push({ label: drive, path: at });
	for (const part of rest.filter((p) => p !== "")) {
		at = at.endsWith("\\") ? `${at}${part}` : `${at}\\${part}`;
		crumbs.push({ label: part, path: at });
	}
	return crumbs;
}

/** The folder `path` is in, or null at the top: `/`, or a Windows share. */
export function parentPath(path: string, style: PathStyle): string | null {
	const crumbs = breadcrumbOf(path, style);
	if (crumbs.length < 2) return null;
	// A share has no folder above it that a request can list.
	if (style === "windows" && crumbs.length === 2 && path.startsWith("\\\\")) return null;
	return crumbs[crumbs.length - 2]?.path ?? null;
}

/** `name` in the folder `dir`, as the host spells it. */
export function joinPath(dir: string, name: string, style: PathStyle): string {
	if (style === "posix") return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
	if (dir === WINDOWS_ROOT) return /^[A-Za-z]:$/.test(name) ? `${name}\\` : `/${name}`;
	return dir.endsWith("\\") ? `${dir}${name}` : `${dir}\\${name}`;
}

// ─── A listing's rows ────────────────────────────────────────────────────────

/** An entry of a listing, as the hub answers it (`GET /api/channels/:id/files`). */
export interface FileEntryView {
	readonly name: string;
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly size: number | null;
	readonly mtime: string | null;
	readonly linkTarget?: string;
	readonly linkKind?: "file" | "directory" | "other" | "missing";
}

/** Whether a row opens as a folder: a folder, or a link to one. */
export function isFolderEntry(entry: FileEntryView): boolean {
	return entry.kind === "directory" || (entry.kind === "symlink" && entry.linkKind === "directory");
}

/** A size as the list shows it: "812 B", "4 KB", "2.1 MB"; "" when the host did not say. */
export function formatSize(bytes: number | null): string {
	if (bytes === null) return "";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const shown = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
	return `${shown} ${units[unit]}`;
}

/** When an entry was modified, as the list shows it: the time today, else the day, with the year when not this one. */
export function formatModified(iso: string | null, now: Date): string {
	if (iso === null) return "";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	if (at.toDateString() === now.toDateString()) {
		return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	return at.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
	});
}

/** What a screen reader says of a row: "folder src", "file notes.md, 4 KB, modified Oct 30". */
export function entryLabel(entry: FileEntryView, now: Date): string {
	const what = isFolderEntry(entry)
		? "folder"
		: entry.kind === "symlink"
			? "link"
			: entry.kind === "file"
				? "file"
				: "item";
	const size = isFolderEntry(entry) ? "" : formatSize(entry.size);
	const modified = formatModified(entry.mtime, now);
	return [
		`${what} ${entry.name}`,
		...(size !== "" ? [size] : []),
		...(modified !== "" ? [`modified ${modified}`] : []),
	].join(", ");
}

/**
 * Type-ahead: the first row after `from`, wrapping, whose name starts with `typed`, without regard
 * to case; the row itself only when no other matches. Null when none does.
 */
export function typeAheadIndex(
	names: readonly string[],
	from: number,
	typed: string,
): number | null {
	if (typed === "" || names.length === 0) return null;
	const wanted = typed.toLowerCase();
	// Typing the same letter again moves on; a longer prefix may stay on the row.
	const start = typed.length > 1 ? from : from + 1;
	for (let i = 0; i < names.length; i++) {
		const index = (((start + i) % names.length) + names.length) % names.length;
		if (names[index]?.toLowerCase().startsWith(wanted)) return index;
	}
	return null;
}

// ─── The status line ─────────────────────────────────────────────────────────

/** A terminal's working directory as it is now, as the hub last relayed it (#834). */
export type { CwdSource, LiveCwd };

/** The facts the status line is made of. */
export interface StatusFacts {
	/** The panel follows the terminal's directory. */
	readonly following: boolean;
	/** What the hub last said of it; undefined when nothing ever did. */
	readonly live: LiveCwd | undefined;
	/** The folder listed now, once a listing came back. */
	readonly shown: string | null;
	/** For a listing asked without a path: which folder the hub opened at. */
	readonly start: "fallback" | "home" | undefined;
	/** Why the fallback folder was not used, as the hub said it. */
	readonly fallbackProblem: string | undefined;
	readonly hostLabel: string;
	/** The terminal's shell, or its foreground program, for what can be said of it. */
	readonly shell: string | undefined;
	/** The host's SSH server offers no SFTP: its files go over SSH commands. */
	readonly sftpUnavailable: boolean;
}

export interface StatusLine {
	readonly id: string;
	readonly text: string;
	/** A path the line names, shown as code; with `goThere`, the button that resumes following. */
	readonly path?: string;
	readonly goThere?: true;
	readonly tone: "info" | "warn";
}

const POWERSHELL = /(^|[\\/])(pwsh|powershell)(\.exe)?$/i;

/**
 * What the panel says under its path bar: where the terminal is when the panel does not show it
 * ("Terminal is in … · Go there"), why it cannot follow it and where it opened instead, a program
 * holding the terminal, a nested session on another host, and a host without SFTP.
 */
export function statusLines(facts: StatusFacts): StatusLine[] {
	const lines: StatusLine[] = [];
	const live = facts.live;
	const cwd = live?.cwd ?? null;
	if (cwd !== null) {
		if (!facts.following || (facts.shown !== null && facts.shown !== cwd)) {
			lines.push({
				id: "elsewhere",
				text: "Terminal is in",
				path: cwd,
				goThere: true,
				tone: "info",
			});
		} else {
			lines.push({ id: "following", text: "Following the terminal", tone: "info" });
		}
		if (
			live?.atPrompt === false &&
			live.foreground !== undefined &&
			/^ssh$/i.test(live.foreground)
		) {
			lines.push({
				id: "foreground",
				text: "ssh is running in this terminal: showing the shell's directory",
				tone: "warn",
			});
		}
	} else if (live?.otherHost !== undefined) {
		lines.push({
			id: "other-host",
			text: `This terminal shows ${live.otherHost}; these are the files of ${facts.hostLabel}`,
			tone: "warn",
		});
	} else if (facts.following) {
		if (live === undefined) {
			lines.push({
				id: "unknown",
				text: `Update the agent on ${facts.hostLabel} to follow this terminal's directory`,
				tone: "info",
			});
		} else if (facts.shell !== undefined && POWERSHELL.test(facts.shell.trim())) {
			lines.push({
				id: "powershell",
				text: "PowerShell does not tell other programs its directory",
				tone: "info",
			});
		} else {
			lines.push({ id: "cannot", text: "Can't follow this shell's directory", tone: "info" });
		}
	}
	if (facts.start !== undefined && cwd === null) {
		lines.push({
			id: "start",
			text:
				facts.start === "fallback"
					? "Showing the folder set for unknown directories"
					: "Showing the home folder",
			tone: "info",
		});
	}
	if (facts.fallbackProblem !== undefined) {
		lines.push({ id: "fallback", text: facts.fallbackProblem, tone: "warn" });
	}
	if (facts.sftpUnavailable) {
		lines.push({ id: "sftp", text: "Over SSH commands: this server offers no SFTP", tone: "info" });
	}
	return lines;
}

// ─── Options: the file transfer settings of the attached host ────────────────

/** The terminal-profile keys Options shows, each written for a host or everywhere. */
export const SCOPED_OPTION_KEYS = [
	"transferOnConflict",
	"transferConfirmDrop",
	"transferFollowCwd",
	"transferVerify",
] as const;
export type ScopedOptionKey = (typeof SCOPED_OPTION_KEYS)[number];

/** What a scoped option's value comes from, nearest first, as the cascade resolves it. */
export type OptionSource = "terminal" | "host" | "everywhere";

/** The layers of a terminal's profile, as `GET /api/config/cascade` gives them. */
export interface OptionLayers {
	readonly global?: Partial<TerminalProfile> | undefined;
	readonly host?: Partial<TerminalProfile> | undefined;
	readonly channel?: Partial<TerminalProfile> | undefined;
}

function holds(layer: Partial<TerminalProfile> | undefined, key: string): boolean {
	const value = layer?.[key];
	return value !== undefined && value !== null;
}

/** Where `key`'s value comes from for the terminal: its own profile, its host's, or everywhere. */
export function optionSource(layers: OptionLayers, key: ScopedOptionKey): OptionSource {
	if (holds(layers.channel, key)) return "terminal";
	if (holds(layers.host, key)) return "host";
	return "everywhere";
}

/** A source in words: "this terminal", the host's name, or "everywhere". */
export function sourceLabel(source: OptionSource, hostLabel: string): string {
	return source === "terminal" ? "this terminal" : source === "host" ? hostLabel : "everywhere";
}

/** "When a file already exists", each answer as Options and Settings name it. */
export const CONFLICT_LABELS: Readonly<Record<TransferOnConflict, string>> = {
	ask: "Ask",
	replace: "Replace",
	keep_both: "Keep both",
	skip: "Skip",
};

/** The same answer as the collapsed Options line says it. */
const CONFLICT_SUMMARY: Readonly<Record<TransferOnConflict, string>> = {
	ask: "Ask if a file exists",
	replace: "Replace existing files",
	keep_both: "Keep both",
	skip: "Skip existing files",
};

/** The effective values the collapsed line names. */
export interface OptionsSummaryFacts {
	readonly onConflict: TransferOnConflict;
	readonly followCwd: boolean;
	readonly verify: boolean;
	/** Verify only applies to a host reached over SSH commands, which offers no SFTP. */
	readonly verifyApplies: boolean;
}

/**
 * Options collapsed: one line naming the effective values in words, "Options · Ask if a file
 * exists · Following · Verify", the last only on a host without SFTP.
 */
export function optionsSummary(facts: OptionsSummaryFacts): string {
	return [
		"Options",
		CONFLICT_SUMMARY[facts.onConflict],
		facts.followCwd ? "Following" : "Not following",
		...(facts.verifyApplies && facts.verify ? ["Verify"] : []),
	].join(" · ");
}

/** A value of an option, in words: On, Off, or the answer's name. */
export function optionValueText(value: unknown): string {
	if (value === true) return "On";
	if (value === false) return "Off";
	if (typeof value === "string" && value in CONFLICT_LABELS) {
		return CONFLICT_LABELS[value as TransferOnConflict];
	}
	return String(value);
}

/** The question a change asks before anything is written: one choice per scope. */
export interface ScopeChoice {
	readonly scope: ProfileWriteScope;
	/** What the button says: the host's name, or "Everywhere". */
	readonly label: string;
	/** What else the write drops, said before it is made; null when it drops nothing. */
	readonly drops: string | null;
}

function dropsText(
	label: string,
	dropped: readonly DroppedOverride[],
	hostLabel: string,
): string | null {
	if (dropped.length === 0) return null;
	const parts = dropped.map((drop) =>
		drop.scope === "host"
			? `${hostLabel}'s own value (${optionValueText(drop.value)})`
			: `this terminal's own value (${optionValueText(drop.value)})`,
	);
	return `${label} also drops ${parts.join(" and ")}.`;
}

/**
 * The scopes a change of `key` offers, this host and everywhere, each saying what nearer
 * override it would drop (`planProfileWrite`, #835), so that the question says it first.
 */
export function scopeChoices(
	key: ScopedOptionKey,
	value: unknown,
	target: { hostId: string | null; channelId: string | null },
	layers: ProfileWriteLayers,
	hostLabel: string,
): ScopeChoice[] {
	const choices: ScopeChoice[] = [];
	for (const [scope, label] of [
		["host", hostLabel],
		["global", "Everywhere"],
	] as const) {
		const plan = planProfileWrite(key, value, scope, target, layers);
		if (plan === null) continue;
		choices.push({ scope, label, drops: dropsText(label, plan.dropped, hostLabel) });
	}
	return choices;
}

// ─── Transfers: the window's uploads, grouped (#837 brings the rows) ──────────

/** What an upload is doing, as its row will say (#837). */
export type TransferState = "queued" | "running" | "conflict" | "failed" | "done" | "cancelled";

/** An upload, as the Transfers part groups it: bound to the host and terminal it started from. */
export interface TransferEntry {
	readonly id: string;
	readonly hostId: string;
	readonly channelId: string;
	readonly state: TransferState;
}

export interface TransferTerminalGroup {
	readonly channelId: string;
	readonly transfers: readonly TransferEntry[];
}

export interface TransferHostGroup {
	readonly hostId: string;
	readonly terminals: readonly TransferTerminalGroup[];
	/** It holds the focused terminal's uploads: first, and expanded. */
	readonly focused: boolean;
}

/**
 * The window's uploads, one group per host and inside it one per terminal, each in the order of
 * its first upload; the group of the focused terminal's host first, that terminal first in it.
 * A focus change reorders and removes nothing.
 */
export function groupTransfers(
	entries: readonly TransferEntry[],
	focusedChannelId: string | null,
): TransferHostGroup[] {
	const hosts = new Map<string, Map<string, TransferEntry[]>>();
	for (const entry of entries) {
		const terminals = hosts.get(entry.hostId) ?? new Map<string, TransferEntry[]>();
		hosts.set(entry.hostId, terminals);
		const list = terminals.get(entry.channelId) ?? [];
		terminals.set(entry.channelId, list);
		list.push(entry);
	}
	const groups: TransferHostGroup[] = [...hosts].map(([hostId, terminals]) => {
		const list = [...terminals].map(([channelId, transfers]) => ({ channelId, transfers }));
		const focused = list.findIndex((t) => t.channelId === focusedChannelId);
		if (focused > 0) list.unshift(...list.splice(focused, 1));
		return { hostId, terminals: list, focused: focused !== -1 };
	});
	const first = groups.findIndex((group) => group.focused);
	if (first > 0) groups.unshift(...groups.splice(first, 1));
	return groups;
}

/** What the Transfers header counts: "2 running, 1 failed", or "none". */
export function transfersCount(entries: readonly TransferEntry[]): { text: string; warn: boolean } {
	const running = entries.filter((e) => e.state === "running" || e.state === "queued").length;
	const failed = entries.filter((e) => e.state === "failed").length;
	const conflicts = entries.filter((e) => e.state === "conflict").length;
	const parts = [
		...(running > 0 ? [`${running} running`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
		...(conflicts > 0 ? [`${conflicts} to decide`] : []),
	];
	return { text: parts.length > 0 ? parts.join(", ") : "none", warn: failed + conflicts > 0 };
}

// ─── The split between Files and Transfers ───────────────────────────────────

/** The share of the panel Transfers takes: at most 70 %. */
export const TRANSFERS_SHARE_MAX = 0.7;
export const TRANSFERS_SHARE_MIN = 0.15;
export const TRANSFERS_SHARE_DEFAULT = 0.3;

/** A share Transfers may take; anything else is the default. */
export function clampTransfersShare(share: number): number {
	if (!Number.isFinite(share)) return TRANSFERS_SHARE_DEFAULT;
	return Math.min(TRANSFERS_SHARE_MAX, Math.max(TRANSFERS_SHARE_MIN, share));
}
