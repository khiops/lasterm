/**
 * The Transfers part of the files panel (#836), its rows (#837, part of #721): the window's
 * uploads, grouped by host › terminal, each upload one row that expands into its tree, its
 * conflicts asked in its group, and what the pane chips, the toasts and the desktop shell say of
 * them. Decided here without a page; `TransfersPart.vue` and the transfers store read it.
 */
import {
	type ProfileWriteLayers,
	type ProfileWritePlan,
	planProfileWrite,
	TRANSFER_EXPIRY_MS,
	type TransferConflictAction,
	type TransferExisting,
	type TransferFolderConflicts,
	type TransferItemState,
	type TransferNotResumedReason,
	type TransferOutcome,
} from "@lasterm/shared";
import { formatSize } from "./files-panel.js";

// ─── An upload, as the window holds it ───────────────────────────────────────

/** One file or folder of an upload. */
export interface UploadItemView {
	readonly itemId: number;
	/** Its path under the destination, `/`-separated. */
	readonly relPath: string;
	readonly kind: "file" | "dir";
	/** Bytes; 0 for a folder. */
	readonly size: number;
	readonly state: TransferItemState;
	/** Bytes the host acknowledged. */
	readonly acked: number;
	readonly outcome?: TransferOutcome | undefined;
	readonly finalName?: string | undefined;
	readonly reason?: string | undefined;
	readonly code?: string | undefined;
	/** What has its name at the destination, for one in `conflict`. */
	readonly existing?: TransferExisting | null | undefined;
	/** A folder where a file goes, or the reverse: only Keep both or Skip. */
	readonly typeClash?: boolean | undefined;
	/** Its new file's last modification, for the conflict card. */
	readonly mtime?: number | undefined;
}

/** An upload, bound to the host and folder it started for, whatever the panel shows since. */
export interface UploadView {
	readonly id: string;
	readonly hostId: string;
	readonly channelId: string;
	/** The destination, as the hub normalised it. */
	readonly dir: string;
	/** "photos/", "notes.md", or "3 items". */
	readonly label: string;
	readonly items: readonly UploadItemView[];
	/** This window sends its bytes. */
	readonly sender: boolean;
	/** Some of it cannot be read again after a restart: its row says so. */
	readonly notResumable: boolean;
	/** The order uploads started in, in this window. */
	readonly seq: number;
	/** "7 of 120" per folder, as TRANSFER_ACCEPTED said it. */
	readonly folderConflicts: readonly TransferFolderConflicts[];
	/** Bytes a second, over the last few seconds; 0 when nothing moves. */
	readonly rate: number;
	/** Its files by state, as the hub last counted them. */
	readonly totals: UploadCounts;
	/** The upload as a whole, as the hub last said it (#860); running when it did not. */
	readonly state?: "running" | "interrupted" | "done";
	/** Why the last resume did not reach its host. */
	readonly reason?: TransferNotResumedReason | undefined;
	/** The device that started it is this window's: only then can it be resumed here (#837). */
	readonly fromThisDevice?: boolean;
	/** Otherwise, that device's name as the hub lists it. */
	readonly deviceLabel?: string | undefined;
	/** ISO 8601, when it last changed: an interrupted one is discarded 7 days after. */
	readonly updatedAt?: string | null;
	/** Its handles, for a resume after a restart: being read, kept, or none. */
	readonly kept?: "reading" | "kept" | "none";
	/** Where a resume, or a discard, of it is. */
	readonly resume?: ResumeState | null;
	/** What its last resume left out, the files gone or unreadable on this device. */
	readonly leftOut?: LeftOut | null;
}

/** The files a resume left out: gone from this device, or unreadable on it. */
export interface LeftOut {
	readonly gone: number;
	readonly unreadable: number;
}

/** A file a resume found changed since it was sent, and what its user answered. */
export interface ChangedFileView {
	readonly itemId: number;
	readonly relPath: string;
	readonly was: { readonly size: number; readonly lastModified: number };
	readonly now: { readonly size: number; readonly lastModified: number };
	readonly answer: "restart" | "skip" | null;
}

/** Where a resume, or a discard, of an interrupted upload is (#837). */
export type ResumeState =
	/** Its files' read access is asked: the browser may ask its own question. */
	| { readonly phase: "asking" }
	/** Each file is read again, and compared with what was sent. */
	| { readonly phase: "checking" }
	/** Files changed since they were sent: each waits for "send again" or "skip". */
	| {
			readonly phase: "changed";
			readonly files: readonly ChangedFileView[];
			readonly gone: number;
			readonly unreadable: number;
	  }
	/** Asked of the hub, which may ask for the host's passphrase first. */
	| { readonly phase: "resuming"; readonly gone: number; readonly unreadable: number }
	/** The files cannot be read again here: a drop of them finishes the upload. */
	| {
			readonly phase: "redrop";
			readonly why: "denied" | "timeout" | "unsupported" | "unknown";
	  }
	| { readonly phase: "discarding" };

/** Files by state, and bytes, of an upload or of a folder in it. */
export interface UploadCounts {
	readonly files: number;
	readonly bytes: number;
	readonly acked: number;
	readonly states: Readonly<Partial<Record<TransferItemState, number>>>;
}

function count(
	states: Partial<Record<TransferItemState, number>>,
	state: TransferItemState,
): number {
	return states[state] ?? 0;
}

/** Files only, as the hub counts them ("118 of 120 placed, 2 failed"). */
export function countItems(items: readonly UploadItemView[]): UploadCounts {
	const states: Partial<Record<TransferItemState, number>> = {};
	let files = 0;
	let bytes = 0;
	let acked = 0;
	for (const item of items) {
		if (item.kind !== "file") continue;
		files++;
		bytes += item.size;
		acked += item.state === "placed" ? item.size : Math.min(item.acked, item.size);
		states[item.state] = (states[item.state] ?? 0) + 1;
	}
	return { files, bytes, acked, states };
}

/** Whether anything of it is still to move: queued, sending, verifying. */
export function isActive(counts: UploadCounts): boolean {
	return (
		count(counts.states, "queued") +
			count(counts.states, "sending") +
			count(counts.states, "verifying") >
		0
	);
}

/** Whether it waits on the user: a conflict to answer, a failure to retry. */
export function needsAttention(counts: UploadCounts): boolean {
	return count(counts.states, "conflict") + count(counts.states, "failed") > 0;
}

/**
 * Whether nothing is left of it to do: nothing moving, failing, waiting for an answer, or
 * interrupted. Only such an upload is dismissed, or cleared as finished: an interrupted one is
 * resumed or discarded (#837).
 */
export function isOver(upload: Pick<UploadView, "totals" | "state">): boolean {
	return (
		upload.state !== "interrupted" &&
		!isActive(upload.totals) &&
		!needsAttention(upload.totals) &&
		count(upload.totals.states, "interrupted") === 0
	);
}

/** A whole percentage of the bytes the host holds. */
export function percentOf(counts: Pick<UploadCounts, "bytes" | "acked">): number {
	if (counts.bytes <= 0) return 0;
	return Math.floor((100 * Math.min(counts.acked, counts.bytes)) / counts.bytes);
}

/**
 * An upload's state in words: "117 of 120 placed, 1 failed, 1 sending, 1 waiting"; after a
 * cancel, "64 of 120 placed, 56 cancelled".
 */
export function stateText(counts: UploadCounts): string {
	const s = counts.states;
	const parts = [
		`${count(s, "placed").toLocaleString("en-US")} of ${counts.files.toLocaleString("en-US")} placed`,
	];
	const named: [TransferItemState, string][] = [
		["failed", "failed"],
		["conflict", "to decide"],
		["sending", "sending"],
		["verifying", "verifying"],
		["queued", "waiting"],
		["interrupted", "interrupted"],
		["skipped", "skipped"],
		["cancelled", "cancelled"],
	];
	for (const [state, words] of named) {
		const n = count(s, state);
		if (n > 0) parts.push(`${n.toLocaleString("en-US")} ${words}`);
	}
	return parts.join(", ");
}

/** "412 MB of 1.2 GB · 4.1 MB/s" while it moves. */
export function bytesText(counts: UploadCounts, rate: number): string {
	const bytes = `${formatSize(counts.acked)} of ${formatSize(counts.bytes)}`;
	return rate > 0 && isActive(counts) ? `${bytes} · ${formatSize(Math.round(rate))}/s` : bytes;
}

// ─── The tree of an upload ───────────────────────────────────────────────────

export interface TreeNode {
	readonly item: UploadItemView;
	readonly name: string;
	readonly children: readonly TreeNode[];
	/** A folder's files, all the way down. */
	readonly counts: UploadCounts;
}

/** An upload's items as a tree, from its roots; conflicts and failures first at each level. */
export function buildTree(items: readonly UploadItemView[]): TreeNode[] {
	const byPath = new Map<string, { item: UploadItemView; children: string[] }>();
	const roots: string[] = [];
	for (const item of items) byPath.set(item.relPath, { item, children: [] });
	for (const item of items) {
		const slash = item.relPath.lastIndexOf("/");
		const parent = slash === -1 ? null : byPath.get(item.relPath.slice(0, slash));
		if (parent === null || parent === undefined) roots.push(item.relPath);
		else parent.children.push(item.relPath);
	}
	const build = (path: string): TreeNode => {
		const entry = byPath.get(path) as { item: UploadItemView; children: string[] };
		const children = orderNodes(entry.children.map(build));
		const own = entry.item.kind === "file" ? countItems([entry.item]) : null;
		return {
			item: entry.item,
			name: path.slice(path.lastIndexOf("/") + 1),
			children,
			counts: own ?? mergeCounts(children.map((child) => child.counts)),
		};
	};
	return orderNodes(roots.map(build));
}

function mergeCounts(list: readonly UploadCounts[]): UploadCounts {
	const states: Partial<Record<TransferItemState, number>> = {};
	let files = 0;
	let bytes = 0;
	let acked = 0;
	for (const c of list) {
		files += c.files;
		bytes += c.bytes;
		acked += c.acked;
		for (const [state, n] of Object.entries(c.states) as [TransferItemState, number][]) {
			states[state] = (states[state] ?? 0) + n;
		}
	}
	return { files, bytes, acked, states };
}

function attentionRank(node: TreeNode): number {
	if (count(node.counts.states, "conflict") > 0) return 0;
	if (count(node.counts.states, "failed") > 0) return 1;
	return 2;
}

/** Conflicts first, then failures, then the rest, each in its own order. */
function orderNodes(nodes: TreeNode[]): TreeNode[] {
	return nodes
		.map((node, index) => ({ node, index }))
		.sort((a, b) => attentionRank(a.node) - attentionRank(b.node) || a.index - b.index)
		.map(({ node }) => node);
}

/** A folder's line: "60 of 62, 1 failed". */
export function folderText(counts: UploadCounts): string {
	const failed = count(counts.states, "failed");
	const conflicts = count(counts.states, "conflict");
	return [
		`${count(counts.states, "placed").toLocaleString("en-US")} of ${counts.files.toLocaleString("en-US")}`,
		...(failed > 0 ? [`${failed} failed`] : []),
		...(conflicts > 0 ? [`${conflicts} to decide`] : []),
	].join(", ");
}

/** A folder whose every file is placed: one line, collapsed. */
export function isFullyPlaced(counts: UploadCounts): boolean {
	return counts.files > 0 && count(counts.states, "placed") === counts.files;
}

/** How many files under a node a Retry would send again. */
export function retriable(counts: UploadCounts): number {
	return (
		count(counts.states, "failed") +
		count(counts.states, "cancelled") +
		count(counts.states, "interrupted")
	);
}

/** How many files under a node a Cancel would stop. */
export function cancellable(counts: UploadCounts): number {
	return (
		count(counts.states, "queued") +
		count(counts.states, "sending") +
		count(counts.states, "verifying") +
		count(counts.states, "conflict") +
		count(counts.states, "interrupted")
	);
}

/** A file's state in words: "waiting", "sending 40 %", "placed as a (1).txt", "failed: no space". */
export function itemText(item: UploadItemView): string {
	switch (item.state) {
		case "queued":
			return "waiting";
		case "sending":
			return item.size > 0
				? `sending ${percentOf({ bytes: item.size, acked: item.acked })} %`
				: "sending";
		case "verifying":
			return "verifying";
		case "placed":
			if (item.outcome === "replaced") return "replaced";
			if (item.outcome === "kept_both" && item.finalName !== undefined)
				return `placed as ${item.finalName}`;
			if (item.outcome === "merged") return "merged into the folder there";
			return "placed";
		case "failed":
			return item.reason !== undefined ? `failed: ${item.reason}` : "failed";
		case "skipped":
			return item.reason !== undefined ? `skipped: ${item.reason}` : "skipped";
		case "conflict":
			return item.typeClash === true
				? "to decide: a folder and a file"
				: "to decide: already there";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return item.reason !== undefined ? `interrupted: ${item.reason}` : "interrupted";
	}
}

// ─── The groups ──────────────────────────────────────────────────────────────

export interface TerminalGroup {
	readonly channelId: string;
	readonly uploads: readonly UploadView[];
}

export interface HostGroup {
	readonly hostId: string;
	readonly terminals: readonly TerminalGroup[];
	/** It holds the focused terminal's uploads. */
	readonly focused: boolean;
}

function uploadRank(upload: UploadView): number {
	const counts = upload.totals;
	if (count(counts.states, "conflict") > 0) return 0;
	if (count(counts.states, "failed") > 0) return 1;
	return 2;
}

/**
 * The window's uploads, one group per host and one sub-group per terminal inside it; the group
 * of the focused terminal first, that terminal first in it. Within a terminal, conflicts and
 * failures first, then in the order they started. Focus moves reorder; they remove nothing.
 */
export function groupUploads(
	uploads: readonly UploadView[],
	focusedChannelId: string | null,
): HostGroup[] {
	const ordered = [...uploads].sort((a, b) => a.seq - b.seq);
	const hosts = new Map<string, Map<string, UploadView[]>>();
	for (const upload of ordered) {
		const terminals = hosts.get(upload.hostId) ?? new Map<string, UploadView[]>();
		hosts.set(upload.hostId, terminals);
		const list = terminals.get(upload.channelId) ?? [];
		terminals.set(upload.channelId, list);
		list.push(upload);
	}
	const groups: HostGroup[] = [...hosts].map(([hostId, terminals]) => {
		const list = [...terminals].map(([channelId, list]) => ({
			channelId,
			uploads: list
				.map((upload, index) => ({ upload, index }))
				.sort((a, b) => uploadRank(a.upload) - uploadRank(b.upload) || a.index - b.index)
				.map(({ upload }) => upload),
		}));
		const focused = list.findIndex((t) => t.channelId === focusedChannelId);
		if (focused > 0) list.unshift(...list.splice(focused, 1));
		return { hostId, terminals: list, focused: focused !== -1 };
	});
	const first = groups.findIndex((group) => group.focused);
	if (first > 0) groups.unshift(...groups.splice(first, 1));
	return groups;
}

/**
 * The order to show while the pointer or the keyboard is in the list: what was shown keeps its
 * place, and only what is new comes after it, so that rows never move under them. Null shows
 * `next` as it is.
 */
export function stableOrder(next: readonly string[], shown: readonly string[] | null): string[] {
	if (shown === null) return [...next];
	const present = new Set(next);
	const kept = shown.filter((key) => present.has(key));
	const known = new Set(kept);
	return [...kept, ...next.filter((key) => !known.has(key))];
}

/** Put `items` in the order of `keys`, by `keyOf`; those not named keep their order at the end. */
export function inOrder<T>(
	items: readonly T[],
	keys: readonly string[],
	keyOf: (item: T) => string,
): T[] {
	const rank = new Map(keys.map((key, index) => [key, index]));
	return items
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				(rank.get(keyOf(a.item)) ?? keys.length + a.index) -
				(rank.get(keyOf(b.item)) ?? keys.length + b.index),
		)
		.map(({ item }) => item);
}

/**
 * Whether a group shows expanded: as the user set it by hand, else when it holds the focused
 * terminal. A group expanded by hand stays so; one the focus expanded collapses when it moves on.
 */
export function isExpanded(
	group: Pick<HostGroup, "hostId" | "focused">,
	byHand: ReadonlyMap<string, boolean>,
): boolean {
	return byHand.get(group.hostId) ?? group.focused;
}

/**
 * The hand settings to keep when the focus moves on: a group expanded by hand stays expanded;
 * one collapsed by hand is the focus's to expand again next time.
 */
export function afterFocusMove(byHand: ReadonlyMap<string, boolean>): Map<string, boolean> {
	return new Map([...byHand].filter(([, expanded]) => expanded));
}

/** The filter: every upload of the window (the default), or the focused terminal's only. */
export type TransfersFilter = "all" | "terminal";

export function filterGroups(
	groups: readonly HostGroup[],
	filter: TransfersFilter,
	focusedChannelId: string | null,
): HostGroup[] {
	if (filter === "all") return [...groups];
	return groups
		.map((group) => ({
			...group,
			terminals: group.terminals.filter((terminal) => terminal.channelId === focusedChannelId),
		}))
		.filter((group) => group.terminals.length > 0);
}

/**
 * A collapsed group's summary, in words: "AD · 1 failed", "raspberrypi · 2 running, 64 %",
 * "local · 3 done"; `warn` when it holds a failure or a conflict to decide.
 */
export function groupSummary(
	hostLabel: string,
	uploads: readonly UploadView[],
): { text: string; warn: boolean } {
	let running = 0;
	let failed = 0;
	let deciding = 0;
	let done = 0;
	let bytes = 0;
	let acked = 0;
	for (const upload of uploads) {
		const counts = upload.totals;
		if (count(counts.states, "conflict") > 0) deciding++;
		if (count(counts.states, "failed") > 0) failed++;
		if (isActive(counts)) {
			running++;
			bytes += counts.bytes;
			acked += counts.acked;
		} else if (!needsAttention(counts)) {
			done++;
		}
	}
	const parts = [
		...(failed > 0 ? [`${failed} failed`] : []),
		...(deciding > 0 ? [`${deciding} to decide`] : []),
		...(running > 0 ? [`${running} running, ${percentOf({ bytes, acked })} %`] : []),
		...(done > 0 ? [`${done} done`] : []),
	];
	return {
		text: [hostLabel, ...(parts.length > 0 ? [parts.join(", ")] : [])].join(" · "),
		warn: failed + deciding > 0,
	};
}

/** What the Transfers header counts: "2 running, 1 failed, 1 interrupted", or "none". */
export function transfersCount(uploads: readonly UploadView[]): { text: string; warn: boolean } {
	let running = 0;
	let failed = 0;
	let deciding = 0;
	let interrupted = 0;
	for (const upload of uploads) {
		const counts = upload.totals;
		if (upload.state === "interrupted") {
			interrupted++;
			continue;
		}
		if (isActive(counts)) running++;
		if (count(counts.states, "failed") > 0) failed++;
		if (count(counts.states, "conflict") > 0) deciding++;
	}
	const parts = [
		...(running > 0 ? [`${running} running`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
		...(deciding > 0 ? [`${deciding} to decide`] : []),
		...(interrupted > 0 ? [`${interrupted} interrupted`] : []),
	];
	return { text: parts.length > 0 ? parts.join(", ") : "none", warn: failed + deciding > 0 };
}

/**
 * A pane's chip: that pane's terminal's uploads only, "↑ 2 · 64 %" while they move,
 * "⚠ 1 failed" or "⚠ 1 to decide" when one waits on the user; null when there is none to show.
 */
export function chipFor(
	uploads: readonly UploadView[],
	channelId: string,
): { text: string; warn: boolean; label: string } | null {
	let running = 0;
	let failed = 0;
	let deciding = 0;
	let bytes = 0;
	let acked = 0;
	for (const upload of uploads) {
		if (upload.channelId !== channelId) continue;
		const counts = upload.totals;
		if (count(counts.states, "failed") > 0) failed++;
		if (count(counts.states, "conflict") > 0) deciding++;
		if (isActive(counts)) {
			running++;
			bytes += counts.bytes;
			acked += counts.acked;
		}
	}
	if (failed > 0) {
		return {
			text: `⚠ ${failed} failed`,
			warn: true,
			label: `${failed} ${failed === 1 ? "upload" : "uploads"} failed`,
		};
	}
	if (deciding > 0) {
		return {
			text: `⚠ ${deciding} to decide`,
			warn: true,
			label: `${deciding} ${deciding === 1 ? "upload waits" : "uploads wait"} for an answer`,
		};
	}
	if (running > 0) {
		const percent = percentOf({ bytes, acked });
		return {
			text: `↑ ${running} · ${percent} %`,
			warn: false,
			label: `${running} ${running === 1 ? "upload" : "uploads"} running, ${percent} %`,
		};
	}
	return null;
}

// ─── What the desktop shell is told ──────────────────────────────────────────

/**
 * This window's uploads, as the desktop shell takes them (`set_uploads_in_progress`, #863): what
 * its quit question counts, what a quit when finished waits for, and what its tray says ("2
 * uploads · 64 % · 1 failed"). Only the uploads this window sends.
 */
export interface UploadsReport {
	/** Uploads not ended: files queued, sending or verifying, or waiting for an answer. */
	readonly inProgress: number;
	/** Of those, the ones stopped on a conflict question, nothing else of them moving. */
	readonly waiting: number;
	/** Uploads that ended with a failed file, still listed. */
	readonly failed: number;
	/** How far the bytes of those in progress are, 0–100 floored; null with none in progress. */
	readonly percent: number | null;
}

export function uploadsReportOf(uploads: readonly UploadView[]): UploadsReport {
	let inProgress = 0;
	let waiting = 0;
	let failed = 0;
	let bytes = 0;
	let acked = 0;
	for (const upload of uploads) {
		if (!upload.sender) continue;
		const counts = upload.totals;
		const moving = isActive(counts);
		const asking = count(counts.states, "conflict") > 0;
		if (moving || asking) {
			inProgress++;
			if (!moving) waiting++;
			bytes += counts.bytes;
			acked += counts.acked;
		} else if (count(counts.states, "failed") > 0) {
			failed++;
		}
	}
	return {
		inProgress,
		waiting,
		failed,
		percent: inProgress === 0 ? null : percentOf({ bytes, acked }),
	};
}

/** The line Transfers shows while the desktop waits for these uploads to end before it quits. */
export function quitPendingText(pending: "quit" | "restart" | null): string | null {
	if (pending === null) return null;
	return `Lasterm will ${pending} when these uploads end`;
}

// ─── Interrupted uploads (#837) ──────────────────────────────────────────────

/** Why the last resume did not reach the upload's host: "Not resumed: AD needs its passphrase". */
export function notResumedText(reason: TransferNotResumedReason, hostLabel: string): string {
	switch (reason) {
		case "needs_passphrase":
			return `Not resumed: ${hostLabel} needs its passphrase`;
		case "needs_password":
			return `Not resumed: ${hostLabel} needs its password`;
		case "host_key_not_accepted":
			return `Not resumed: ${hostLabel}'s host key was not accepted`;
		case "host_unreachable":
			return `Not resumed: ${hostLabel} could not be reached`;
	}
}

/** A day as the panel says it: "12 Nov". */
export function dayText(date: Date): string {
	return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Until when interrupted uploads are kept: the first of them to go, 7 days after it last changed
 * (`TRANSFER_EXPIRY_MS`); null when none says when.
 */
export function keptUntil(updatedAts: readonly (string | null | undefined)[]): Date | null {
	let first: number | null = null;
	for (const at of updatedAts) {
		const ms = at === null || at === undefined ? Number.NaN : Date.parse(at);
		if (!Number.isNaN(ms) && (first === null || ms < first)) first = ms;
	}
	return first === null ? null : new Date(first + TRANSFER_EXPIRY_MS);
}

/** The block folded by Not now, in one line: "4 interrupted uploads · kept until 12 Nov". */
export function foldedText(count: number, until: Date | null): string {
	const what = `${count.toLocaleString("en-US")} interrupted ${count === 1 ? "upload" : "uploads"}`;
	return until === null ? what : `${what} · kept until ${dayText(until)}`;
}

/** What was placed of an upload: "118 of 120 placed". */
export function placedText(counts: UploadCounts): string {
	return `${count(counts.states, "placed").toLocaleString("en-US")} of ${counts.files.toLocaleString("en-US")} placed`;
}

/**
 * The device another device's upload can be resumed from, by the name the hub's credentials give
 * it: the desktop app holds the hub's own one ("Primary"), a pairing names its address.
 */
export function deviceText(label: string | undefined): string {
	if (label === undefined || label.trim() === "") return "another device";
	if (label === "Primary") return "the desktop app";
	const paired = /^Paired from (.+)$/.exec(label);
	return paired !== null ? `the device paired from ${paired[1]}` : label;
}

/** A resume under way, in words; null when it says nothing of its own. */
export function resumeText(resume: ResumeState | null | undefined): string | null {
	switch (resume?.phase) {
		case "asking":
			return "Asking for access to its files…";
		case "checking":
			return "Checking its files…";
		case "resuming":
			return "Resuming…";
		case "discarding":
			return "Discarding…";
		case "redrop":
			return "Drop the files again to finish";
		default:
			return null;
	}
}

/** What a resume left out, said on its row: "1 file no longer there, left out". */
export function leftOutText(gone: number, unreadable: number): string | null {
	const parts = [
		...(gone > 0
			? [`${gone.toLocaleString("en-US")} ${gone === 1 ? "file" : "files"} no longer there`]
			: []),
		...(unreadable > 0
			? [
					`${unreadable.toLocaleString("en-US")} ${unreadable === 1 ? "file" : "files"} could not be read`,
				]
			: []),
	];
	return parts.length === 0 ? null : `${parts.join(", ")}: left out`;
}

/** A changed file's line: "notes.md · 4 KB, 3 Nov → 6 KB, 5 Nov". */
export function changedText(file: ChangedFileView): string {
	const side = (it: { size: number; lastModified: number }) =>
		`${formatSize(it.size)}, ${dayText(new Date(it.lastModified))}`;
	return `${file.relPath} · ${side(file.was)} → ${side(file.now)}`;
}

// ─── Conflicts ───────────────────────────────────────────────────────────────

/** The last name of a path, either style. */
function baseName(path: string): string {
	const parts = path.split(/[\\/]/).filter((part) => part !== "");
	return parts.at(-1) ?? path;
}

/** A folder of an upload that exists at the destination, and how many of its files conflict. */
export interface FolderConflict {
	readonly item: UploadItemView;
	readonly conflicting: number;
	readonly total: number;
	/** The files under it waiting for an answer now. */
	readonly waiting: readonly UploadItemView[];
}

/**
 * The folders of an upload that exist where it goes, with files waiting under them: the top ones
 * only, each said once ("7 of 120").
 */
export function folderConflicts(upload: UploadView): FolderConflict[] {
	const byId = new Map(upload.items.map((item) => [item.itemId, item]));
	const out: FolderConflict[] = [];
	const shown: string[] = [];
	const sorted = [...upload.folderConflicts]
		.map((fc) => ({ fc, item: byId.get(fc.itemId) }))
		.filter((x): x is { fc: TransferFolderConflicts; item: UploadItemView } => x.item !== undefined)
		.sort((a, b) => a.item.relPath.split("/").length - b.item.relPath.split("/").length);
	for (const { fc, item } of sorted) {
		if (shown.some((top) => item.relPath.startsWith(`${top}/`))) continue;
		const waiting = upload.items.filter(
			(other) =>
				other.kind === "file" &&
				other.state === "conflict" &&
				other.relPath.startsWith(`${item.relPath}/`),
		);
		if (waiting.length === 0) continue;
		shown.push(item.relPath);
		out.push({ item, conflicting: fc.conflicting, total: fc.total, waiting });
	}
	return out;
}

/**
 * A folder conflict's summary: "photos/ already exists in assets: 7 of 120 files would conflict.
 * The 113 others merge in." A folder is never replaced as a whole.
 */
export function folderConflictText(conflict: FolderConflict, dir: string): string {
	const others = Math.max(0, conflict.total - conflict.conflicting);
	const name = baseName(conflict.item.relPath);
	const lead = `${name}/ already exists in ${baseName(dir)}: ${conflict.conflicting.toLocaleString("en-US")} of ${conflict.total.toLocaleString("en-US")} ${conflict.total === 1 ? "file" : "files"} would conflict.`;
	return others > 0 ? `${lead} The ${others.toLocaleString("en-US")} others merge in.` : lead;
}

/** The files of an upload waiting for an answer that no folder conflict covers. */
export function fileConflicts(upload: UploadView): UploadItemView[] {
	const folders = folderConflicts(upload).map((fc) => fc.item.relPath);
	return upload.items.filter(
		(item) =>
			item.state === "conflict" && !folders.some((top) => item.relPath.startsWith(`${top}/`)),
	);
}

/** "Existing: 4 KB, 3 Nov · New: 6 KB, today" for one file. */
export function conflictDetail(item: UploadItemView, now: Date): string {
	const existing = item.existing;
	const when = (ms: number | null): string => {
		if (ms === null || Number.isNaN(ms)) return "";
		const at = new Date(ms);
		return at.toDateString() === now.toDateString()
			? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
			: at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	};
	const there =
		existing === null || existing === undefined
			? "something is there"
			: existing.kind === "directory"
				? "a folder is there"
				: [
						formatSize(existing.size),
						when(existing.mtime === null ? null : Date.parse(existing.mtime)),
					]
						.filter((part) => part !== "")
						.join(", ");
	const incoming = [formatSize(item.size), when(item.mtime ?? null)]
		.filter((part) => part !== "")
		.join(", ");
	return `Existing: ${there} · New: ${incoming}`;
}

/** Where "Always do this" saves the answer: not at all (this time only), the host, or everywhere. */
export type ConflictScope = "once" | "host" | "global";

/**
 * "Always do this" as a write: `transfer_on_conflict` for the upload's host, which the panel may
 * no longer show, or everywhere, through `planProfileWrite` (#835) so that it holds over the
 * upload's terminal. Null for this time only.
 */
export function conflictScopePlan(
	action: TransferConflictAction,
	scope: ConflictScope,
	upload: Pick<UploadView, "hostId" | "channelId">,
	layers: ProfileWriteLayers = {},
): ProfileWritePlan | null {
	if (scope === "once") return null;
	return planProfileWrite(
		"transferOnConflict",
		action,
		scope,
		{ hostId: upload.hostId, channelId: upload.channelId },
		layers,
	);
}

/** The answers a conflict takes: a type clash takes no Replace. */
export function conflictActions(items: readonly UploadItemView[]): TransferConflictAction[] {
	return items.some((item) => item.typeClash === true) &&
		items.every((item) => item.typeClash === true)
		? ["keep_both", "skip"]
		: ["skip", "keep_both", "replace"];
}
