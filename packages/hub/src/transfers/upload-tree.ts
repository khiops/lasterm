import { createHash } from "node:crypto";
import {
	relPathProblem,
	TRANSFER_MAX_FILES,
	TRANSFER_MAX_ITEMS,
	type TransferItemKind,
	type TransferNameProblem,
	type TransferStartItem,
	WINDOWS_MAX_PATH_LENGTH,
	windowsNameProblem,
} from "@lasterm/shared";
import { joinHostPath, type PathStyle } from "../files/host-paths.js";

/** One file or folder of an upload, as the hub holds it: its place in the tree. */
export interface TreeItem {
	/** Its index in TRANSFER_START's `items`. */
	readonly id: number;
	readonly relPath: string;
	/** Its last name. */
	readonly name: string;
	readonly kind: TransferItemKind;
	/** Bytes; 0 for a folder. */
	readonly size: number;
	/** Milliseconds since the epoch, or null. */
	readonly mtime: number | null;
	/** The folder it is in, by id; null at the destination's top. */
	readonly parent: number | null;
	readonly children: number[];
}

export type UploadTree =
	| {
			readonly ok: true;
			/** By id. */
			readonly items: TreeItem[];
			/** Folders before what is in them, shallowest first. */
			readonly order: number[];
			readonly files: number;
			readonly bytes: number;
			/** What says two drops are the same tree: every path, kind, size and time. */
			readonly signature: string;
	  }
	| {
			readonly ok: false;
			readonly code: "INVALID_ITEMS" | "INVALID_NAMES" | "TOO_MANY_FILES";
			readonly message: string;
			readonly names?: TransferNameProblem[];
	  };

/** The most problems one answer lists; the message counts the rest. */
const PROBLEMS_LISTED = 1000;

/** A whole number at least 0 that a number holds exactly: a size, a time in milliseconds. */
export function isWholeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Check a whole tree before any byte moves (#833), and build it: every item a
 * relative path of names a host can take, a file with its size, every folder
 * an item is in an item too, no name twice. For a Windows host, every name in
 * every path is checked as Windows takes names (reserved device names with
 * any extension, a trailing dot or space, `<>:"/\|?*` and control
 * characters), two names that differ only by case are one, and the full path
 * at the destination must fit in MAX_PATH. Every problem is listed, so that
 * the client can leave those out or cancel; nothing is half sent because of a
 * name found later.
 */
export function buildUploadTree(raw: unknown, style: PathStyle, dir: string): UploadTree {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, code: "INVALID_ITEMS", message: "items must be a non-empty list" };
	}
	if (raw.length > TRANSFER_MAX_ITEMS) {
		return {
			ok: false,
			code: "TOO_MANY_FILES",
			message: `An upload holds at most ${TRANSFER_MAX_ITEMS} files and folders: send an archive instead`,
		};
	}
	const structural: TransferNameProblem[] = [];
	const naming: TransferNameProblem[] = [];
	const parsed: { relPath: string; kind: TransferItemKind; size: number; mtime: number | null }[] =
		[];
	let files = 0;
	let bytes = 0;
	raw.forEach((entry: unknown, index) => {
		const item = (entry ?? {}) as Partial<TransferStartItem>;
		const relPath = typeof item.relPath === "string" ? item.relPath : "";
		const problem =
			typeof item.relPath !== "string"
				? "rel_path must be text"
				: item.kind !== "file" && item.kind !== "dir"
					? 'kind must be "file" or "dir"'
					: item.kind === "file" && !isWholeNumber(item.size)
						? "a file's size must be a whole number of bytes"
						: item.mtime !== undefined && !isWholeNumber(item.mtime)
							? "mtime must be milliseconds since the epoch"
							: relPathProblem(relPath);
		if (problem !== null) structural.push({ relPath: relPath || `#${index}`, reason: problem });
		const kind = item.kind === "dir" ? "dir" : "file";
		const size = kind === "file" && isWholeNumber(item.size) ? item.size : 0;
		if (kind === "file") {
			files++;
			bytes += size;
		}
		parsed.push({
			relPath,
			kind,
			size,
			mtime: isWholeNumber(item.mtime) ? item.mtime : null,
		});
	});
	if (files > TRANSFER_MAX_FILES) {
		return {
			ok: false,
			code: "TOO_MANY_FILES",
			message: `An upload holds at most ${TRANSFER_MAX_FILES} files: send an archive instead`,
		};
	}

	// Each path once, and on Windows each path once whatever its case.
	const key = (relPath: string) => (style === "windows" ? relPath.toUpperCase() : relPath);
	const byKey = new Map<string, number>();
	parsed.forEach((item, index) => {
		const seen = byKey.get(key(item.relPath));
		if (seen === undefined) {
			byKey.set(key(item.relPath), index);
			return;
		}
		const same = parsed[seen]?.relPath === item.relPath;
		(same ? structural : naming).push({
			relPath: item.relPath,
			reason: same
				? "the path is in the upload twice"
				: "another item has this name but for its case, which a Windows host does not tell apart",
		});
	});

	// One reason per path: a path refused already is not refused again for its folder.
	const refused = new Set(structural.map((problem) => problem.relPath));
	const items: TreeItem[] = parsed.map((item, id) => {
		const cut = item.relPath.lastIndexOf("/");
		const parentPath = cut === -1 ? null : item.relPath.slice(0, cut);
		const parentIndex = parentPath === null ? undefined : byKey.get(key(parentPath));
		if (parentPath !== null && !refused.has(item.relPath)) {
			if (parentIndex === undefined) {
				structural.push({
					relPath: item.relPath,
					reason: "the folder it is in is not in the upload",
				});
			} else if (parsed[parentIndex]?.kind !== "dir") {
				structural.push({ relPath: item.relPath, reason: "what it is in is a file" });
			}
		}
		return {
			id,
			relPath: item.relPath,
			name: item.relPath.slice(cut + 1),
			kind: item.kind,
			size: item.size,
			mtime: item.mtime,
			parent: parentIndex ?? null,
			children: [],
		};
	});

	if (style === "windows") {
		for (const item of items) {
			const problem = item.relPath
				.split("/")
				.map(windowsNameProblem)
				.find((reason) => reason !== null);
			if (problem) {
				naming.push({ relPath: item.relPath, reason: problem });
				continue;
			}
			const full = joinHostPath(dir, item.relPath.replace(/\//g, "\\"), "windows");
			if (full.length > WINDOWS_MAX_PATH_LENGTH) {
				naming.push({
					relPath: item.relPath,
					reason: `its path on the host would be ${full.length} characters, over the ${WINDOWS_MAX_PATH_LENGTH} Windows allows`,
				});
			}
		}
	}

	const problems = structural.length > 0 ? structural : naming;
	if (problems.length > 0) {
		const listed = problems.slice(0, PROBLEMS_LISTED);
		const more = problems.length - listed.length;
		const code = structural.length > 0 ? "INVALID_ITEMS" : "INVALID_NAMES";
		return {
			ok: false,
			code,
			message:
				code === "INVALID_NAMES"
					? `${problems.length} name${problems.length === 1 ? "" : "s"} cannot be created on this host${more > 0 ? ` (the first ${listed.length} are listed)` : ""}: leave them out, or cancel`
					: `${problems.length} item${problems.length === 1 ? "" : "s"} cannot be sent as given${more > 0 ? ` (the first ${listed.length} are listed)` : ""}`,
			names: listed,
		};
	}

	for (const item of items) {
		if (item.parent !== null) items[item.parent]?.children.push(item.id);
	}
	const depth = (item: TreeItem) => item.relPath.split("/").length;
	const order = [...items]
		.sort((a, b) => depth(a) - depth(b) || a.id - b.id)
		.map((item) => item.id);
	const signature = createHash("sha256")
		.update(
			JSON.stringify(
				[...parsed].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)),
			),
		)
		.digest("hex");
	return { ok: true, items, order, files, bytes, signature };
}
