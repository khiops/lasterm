/**
 * Dropping files to upload them (#837, part of #721): what a drop target decides before anything
 * moves, and what the overlay and the confirmation say. The pane wrapper (PaneLayout.vue), the
 * files panel's list and its folder rows ask `dropDecision`; the overlay and the confirmation
 * card read the words here. `utils/file-drop-guard.ts` stays the backstop everywhere else.
 */
import {
	type TransferDrop,
	type TransferStartItem,
	WINDOWS_MAX_PATH_LENGTH,
	windowsNameProblem,
} from "@lasterm/shared";
import { formatSize } from "./files-panel.js";
import type { WalkCounts, WalkedItem, WalkResult, WalkSkip } from "./upload-walk.js";

// ─── Take or refuse ──────────────────────────────────────────────────────────

/** Where files are dropped: a terminal pane, the panel's list (its folder), or a folder row. */
export type DropTarget = "terminal" | "panel" | "folder";

/** This window's part in the terminal: it writes, nobody does, or another window does. */
export type DropRole = "writer" | "free" | "reader";

export interface DropFacts {
	readonly target: DropTarget;
	/** The drag carries files (`Files` among its types). */
	readonly carriesFiles: boolean;
	/** `[experimental] file_transfer`. */
	readonly enabled: boolean;
	/** The terminal the drop is for; null for a pane still spawning. */
	readonly channelId: string | null;
	readonly role: DropRole;
	/** `transfer_drop`, for a drop on the terminal itself. */
	readonly transferDrop: TransferDrop;
	/** The terminal ended, was killed, or is gone. */
	readonly ended: boolean;
}

/** Why a drop is refused: the cursor says no, and the overlay says why. */
export type DropRefusal = "reader" | "off" | "ended";

export type DropDecision =
	/** Not ours: a pane moved, a link, file transfer off. The guard refuses it if nothing takes it. */
	| { readonly kind: "ignore" }
	/** Taken: `preventDefault` on `dragover` and `drop`, `dropEffect = "copy"`. */
	| { readonly kind: "take" }
	/** Refused here, the cursor saying so (`dropEffect = "none"`), the overlay saying why. */
	| { readonly kind: "refuse"; readonly reason: DropRefusal };

/**
 * Whether a target takes a drag. Only files, only while file transfer is on, only for a
 * terminal: a reader is refused ("Request write" is offered), an ended terminal too, and a drop
 * on the terminal itself when `transfer_drop` is off; the panel's list and folder rows are an
 * explicit gesture, which that setting does not govern.
 */
export function dropDecision(facts: DropFacts): DropDecision {
	if (!facts.carriesFiles || !facts.enabled || facts.channelId === null) return { kind: "ignore" };
	if (facts.ended) return { kind: "refuse", reason: "ended" };
	if (facts.role === "reader") return { kind: "refuse", reason: "reader" };
	if (facts.target === "terminal" && facts.transferDrop === "off") {
		return { kind: "refuse", reason: "off" };
	}
	return { kind: "take" };
}

/** The role from the write lock: this window holds it, nobody does, or another window does. */
export function dropRole(holder: string | null | undefined, clientId: string | null): DropRole {
	if (holder === null || holder === undefined) return "free";
	return clientId !== null && holder === clientId ? "writer" : "reader";
}

/** Whether a drag carries files: `Files` among its types. */
export function carriesFiles(types: readonly string[] | DOMStringList | undefined | null): boolean {
	if (types === undefined || types === null) return false;
	return Array.from(types as ArrayLike<string>).includes("Files");
}

/** What a refused drop's overlay says. */
export function refusalText(reason: DropRefusal, hostLabel: string): string {
	switch (reason) {
		case "reader":
			return "Another window writes in this terminal: request write to upload here";
		case "ended":
			return "This terminal has ended: nothing can be uploaded from it";
		case "off":
			return `Dropping files on a terminal is off for ${hostLabel}: use the files panel`;
	}
}

// ─── The overlay, before any byte moves ──────────────────────────────────────

export interface OverlayFacts {
	/** Items the drag carries, when the browser says (a drag in progress often does not). */
	readonly count: number | null;
	readonly hostLabel: string;
	/** The destination, or null until it is known. */
	readonly dir: string | null;
	/** Where it comes from: the terminal's directory, the folder the panel shows, a folder row. */
	readonly origin: "terminal" | "start" | "panel" | "folder";
}

/**
 * "Drop 3 items to upload to raspberrypi › /home/pi — this terminal's directory": the host first,
 * then the folder, then what that folder is.
 */
export function overlayText(facts: OverlayFacts): string {
	const what =
		facts.count === null || facts.count === 0
			? "Drop"
			: `Drop ${facts.count} ${facts.count === 1 ? "item" : "items"}`;
	const where = facts.dir === null ? facts.hostLabel : `${facts.hostLabel} › ${facts.dir}`;
	const origin =
		facts.origin === "terminal"
			? " — this terminal's directory"
			: facts.origin === "start"
				? " — the folder for unknown directories"
				: facts.origin === "folder"
					? " — this folder"
					: " — the folder shown";
	return `${what} to upload to ${where}${facts.dir === null ? "" : origin}`;
}

// ─── The confirmation's words ────────────────────────────────────────────────

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * What will be sent: "photos/: 120 files (4 hidden), 4 folders (1 empty), 412 MB; 1 link
 * skipped". One root names itself; several are counted ("3 items: …").
 */
export function walkSummary(
	rootNames: readonly { name: string; kind: "file" | "directory" }[],
	counts: Readonly<WalkCounts>,
	skipped: readonly WalkSkip[],
): string {
	const head =
		rootNames.length === 1 && rootNames[0] !== undefined
			? `${rootNames[0].name}${rootNames[0].kind === "directory" ? "/" : ""}`
			: plural(rootNames.length, "item");
	const files = `${plural(counts.files, "file")}${counts.hidden > 0 ? ` (${counts.hidden} hidden)` : ""}`;
	const folders =
		counts.folders > 0
			? `, ${plural(counts.folders, "folder")}${counts.emptyFolders > 0 ? ` (${counts.emptyFolders} empty)` : ""}`
			: "";
	const links = skipped.filter((skip) => skip.reason === "link").length;
	const deep = skipped.filter((skip) => skip.reason === "too-deep").length;
	const unreadable = skipped.filter((skip) => skip.reason === "unreadable").length;
	const left = [
		...(links > 0 ? [`${plural(links, "link")} skipped`] : []),
		...(deep > 0 ? [`${plural(deep, "folder")} too deep skipped`] : []),
		...(unreadable > 0 ? [`${unreadable.toLocaleString("en-US")} unreadable skipped`] : []),
	];
	return `${head}: ${files}${folders}, ${formatSize(counts.bytes)}${left.length > 0 ? `; ${left.join(", ")}` : ""}`;
}

/** "Counting… 12,300 files, 4.1 GB" while the walk goes. */
export function countingText(counts: Readonly<WalkCounts>): string {
	return `Counting… ${plural(counts.files, "file")}, ${formatSize(counts.bytes)}`;
}

/** Why a large drop is warned about, or refused. */
export function limitText(
	limits: { refuse: boolean; warn: boolean },
	counts: WalkCounts,
): string | null {
	if (limits.refuse) {
		return "An upload holds at most 100,000 files: send an archive of this folder instead.";
	}
	if (limits.warn) {
		return `This is a large upload (${plural(counts.files, "file")}, ${formatSize(counts.bytes)}): an archive may be faster.`;
	}
	return null;
}

// ─── Names a Windows host cannot hold ────────────────────────────────────────

export interface NameProblem {
	readonly relPath: string;
	readonly reason: string;
}

/**
 * Every path of the tree a Windows host would refuse, before any byte moves, as the hub checks
 * it (PROTOCOL.md § 4.19): a name it cannot hold, two names that differ only by case, a full
 * path over 259 characters at the destination. A folder refused takes everything in it along.
 */
export function windowsNameProblems(dir: string, items: readonly WalkedItem[]): NameProblem[] {
	const problems: NameProblem[] = [];
	const seen = new Map<string, string>();
	const base = dir.endsWith("\\") ? dir : `${dir}\\`;
	for (const item of items) {
		const segments = item.relPath.split("/");
		const name = segments.at(-1) ?? "";
		const reason = windowsNameProblem(name);
		if (reason !== null) {
			problems.push({ relPath: item.relPath, reason });
			continue;
		}
		const lower = item.relPath.toLowerCase();
		const other = seen.get(lower);
		if (other !== undefined && other !== item.relPath) {
			problems.push({
				relPath: item.relPath,
				reason: `differs from ${other} only by case, which Windows takes as the same name`,
			});
			continue;
		}
		seen.set(lower, item.relPath);
		const full = `${base}${item.relPath.replaceAll("/", "\\")}`;
		if (full.length > WINDOWS_MAX_PATH_LENGTH) {
			problems.push({
				relPath: item.relPath,
				reason: `the full path would be ${full.length} characters, over Windows' ${WINDOWS_MAX_PATH_LENGTH}`,
			});
		}
	}
	return problems;
}

/** The tree without the paths given, nor anything under them: "Skip those". */
export function withoutPaths(items: readonly WalkedItem[], paths: readonly string[]): WalkedItem[] {
	const gone = new Set(paths);
	return items.filter((item) => {
		if (gone.has(item.relPath)) return false;
		const segments = item.relPath.split("/");
		for (let i = 1; i < segments.length; i++) {
			if (gone.has(segments.slice(0, i).join("/"))) return false;
		}
		return true;
	});
}

/** The items as TRANSFER_START names them, in the walk's order (folders before what they hold). */
export function startItems(items: readonly WalkedItem[]): TransferStartItem[] {
	return items.map((item) =>
		item.kind === "dir"
			? { relPath: item.relPath, kind: "dir" }
			: {
					relPath: item.relPath,
					kind: "file",
					size: item.size ?? 0,
					...(item.mtime !== undefined ? { mtime: item.mtime } : {}),
				},
	);
}

/** A whole walk's counts again, once names were skipped. */
export function countItems(items: readonly WalkedItem[]): WalkCounts {
	const counts: WalkCounts = { files: 0, folders: 0, emptyFolders: 0, hidden: 0, bytes: 0 };
	const parents = new Set<string>();
	for (const item of items) {
		const slash = item.relPath.lastIndexOf("/");
		if (slash !== -1) parents.add(item.relPath.slice(0, slash));
	}
	for (const item of items) {
		const name = item.relPath.slice(item.relPath.lastIndexOf("/") + 1);
		if (name.startsWith(".")) counts.hidden++;
		if (item.kind === "file") {
			counts.files++;
			counts.bytes += item.size ?? 0;
		} else {
			counts.folders++;
			if (!parents.has(item.relPath)) counts.emptyFolders++;
		}
	}
	return counts;
}

export type { WalkResult };
