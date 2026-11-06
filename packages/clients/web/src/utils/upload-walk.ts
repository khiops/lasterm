/**
 * What was dropped or picked for an upload (#837, part of #721), read into the tree
 * TRANSFER_START names (PROTOCOL.md § 4.19), with a way back to each file for after a restart
 * where the browser gives one.
 *
 * - **In the drop event**, each item is asked for its File System Access handle
 *   (`getAsFileSystemHandle()`) and for its entry (`webkitGetAsEntry()`), both before the event
 *   returns: the items are unreadable after it. The handle's promise is awaited **with a bound**:
 *   Chromium may hold it pending while it shows its dialog for a sensitive folder (one under
 *   `%LOCALAPPDATA%` stayed pending for over 15 s in WebView2, for good in a test bench). Past
 *   the bound, the item goes on with its entry, which nothing keeps for after a restart.
 * - **The walk** goes through a folder's handle (`values()`) or its entry
 *   (`createReader().readEntries()` until it gives no more). Hidden files are included and
 *   counted; a folder that is the same as one above it (a link the walk can recognise) is
 *   skipped, listed as a link; a folder deeper than 32 levels is skipped too, so that a drop that
 *   presents a link as its target cannot walk for ever. The walk counts as it goes, and stops at
 *   the most files an upload may hold.
 *
 * The browser types are taken structurally, so that a spec gives plain objects.
 */
import { TRANSFER_MAX_FILES, TRANSFER_MAX_ITEMS } from "@lasterm/shared";

// ─── The browser's objects, as the walk uses them ────────────────────────────

/** A file's File System Access handle. */
export interface FileHandleLike {
	readonly kind: "file";
	readonly name: string;
	getFile(): Promise<File>;
	isSameEntry?(other: HandleLike): Promise<boolean>;
}

/** A folder's File System Access handle. */
export interface DirectoryHandleLike {
	readonly kind: "directory";
	readonly name: string;
	values(): AsyncIterable<HandleLike>;
	isSameEntry?(other: HandleLike): Promise<boolean>;
}

export type HandleLike = FileHandleLike | DirectoryHandleLike;

/** A dropped item's entry (`webkitGetAsEntry()`), the way every browser reads a dropped folder. */
export interface EntryLike {
	readonly name: string;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	file?(success: (file: File) => void, failure?: (error: unknown) => void): void;
	createReader?(): {
		readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void;
	};
}

/** A dropped item, as `DataTransferItem` gives it. */
export interface DropItemLike {
	readonly kind: string;
	getAsFile(): File | null;
	webkitGetAsEntry?(): EntryLike | null;
	getAsFileSystemHandle?(): Promise<HandleLike | null>;
}

// ─── What was dropped or picked ──────────────────────────────────────────────

/** Why a root cannot be read again after a restart. */
export type NotResumable =
	/** The browser has no File System Access API (Firefox, Safari, an `<input type=file>`). */
	| "unsupported"
	/** Its handle stayed pending past the bound: the drop went on with its entry. */
	| "pending";

/** One thing dropped or picked: a file or a folder, and how it is read. */
export interface UploadRoot {
	readonly name: string;
	readonly kind: "file" | "directory";
	/** Its handle, kept for after a restart; null when the browser gave none in time. */
	readonly handle: HandleLike | null;
	readonly entry: EntryLike | null;
	/** A file as the drop or the picker gave it. */
	readonly file: File | null;
	/** A folder picked through `<input webkitdirectory>`: its files, with their relative paths. */
	readonly files?: readonly File[];
	/** Null when it can be read again after a restart. */
	readonly notResumable: NotResumable | null;
}

/** How long the drop waits for the browser's handles before going on without them. */
export const HANDLE_WAIT_MS = 3_000;

/** What a bounded wait gave: the value, or that it failed or took too long. */
export type Bounded<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: "timeout" | "error"; readonly error?: unknown };

/**
 * Wait for `promise`, at most `ms`: every await on the File System Access API is bounded, so
 * that a promise the browser holds for ever never holds the upload.
 */
export function bounded<T>(promise: Promise<T>, ms: number): Promise<Bounded<T>> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve({ ok: true, value });
			},
			(error: unknown) => {
				clearTimeout(timer);
				resolve({ ok: false, reason: "error", error });
			},
		);
	});
}

/**
 * Read a drop's items. **Call it inside the drop event**: it asks each item for its handle and its
 * entry before returning, and only then awaits the handles, each within `waitMs` together. A
 * handle that comes back in time is kept; otherwise the item goes on with its entry, or its file,
 * and says it cannot be read again after a restart.
 */
export function readDrop(
	items: ArrayLike<DropItemLike>,
	waitMs = HANDLE_WAIT_MS,
): Promise<UploadRoot[]> {
	const asked: {
		handle: Promise<HandleLike | null> | null;
		entry: EntryLike | null;
		file: File | null;
	}[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item === undefined || item.kind !== "file") continue;
		let handle: Promise<HandleLike | null> | null = null;
		try {
			handle =
				typeof item.getAsFileSystemHandle === "function" ? item.getAsFileSystemHandle() : null;
		} catch {
			handle = null;
		}
		let entry: EntryLike | null = null;
		try {
			entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
		} catch {
			entry = null;
		}
		let file: File | null = null;
		try {
			file = item.getAsFile();
		} catch {
			file = null;
		}
		asked.push({ handle, entry, file });
	}
	return Promise.all(
		asked.map(async ({ handle, entry, file }): Promise<UploadRoot | null> => {
			const got = handle === null ? null : await bounded(handle, waitMs);
			const fallbackKind = entry?.isDirectory === true ? "directory" : "file";
			const name = entry?.name ?? file?.name ?? "";
			if (got?.ok === true && got.value !== null) {
				return {
					name: got.value.name,
					kind: got.value.kind,
					handle: got.value,
					entry,
					file,
					notResumable: null,
				};
			}
			if (entry === null && file === null) return null;
			return {
				name,
				kind: fallbackKind,
				handle: null,
				entry,
				file,
				notResumable: handle === null ? "unsupported" : "pending",
			};
		}),
	).then((roots) => roots.filter((root): root is UploadRoot => root !== null));
}

/** Roots from the file picker: a handle per file (`showOpenFilePicker`), resumable. */
export function rootsFromFileHandles(handles: readonly FileHandleLike[]): UploadRoot[] {
	return handles.map((handle) => ({
		name: handle.name,
		kind: "file",
		handle,
		entry: null,
		file: null,
		notResumable: null,
	}));
}

/** The root from the folder picker (`showDirectoryPicker`): one handle for its whole tree. */
export function rootFromDirectoryHandle(handle: DirectoryHandleLike): UploadRoot {
	return {
		name: handle.name,
		kind: "directory",
		handle,
		entry: null,
		file: null,
		notResumable: null,
	};
}

/**
 * Roots from an `<input type=file>`, where the browser has no pickers: its files, or the folder
 * its `webkitdirectory` gave, each file named by its `webkitRelativePath`. Nothing is kept for
 * after a restart.
 */
export function rootsFromInputFiles(files: readonly File[]): UploadRoot[] {
	const folders = new Map<string, File[]>();
	const roots: UploadRoot[] = [];
	for (const file of files) {
		const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
		const top = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "";
		if (top === "") {
			roots.push({
				name: file.name,
				kind: "file",
				handle: null,
				entry: null,
				file,
				notResumable: "unsupported",
			});
			continue;
		}
		const list = folders.get(top) ?? [];
		folders.set(top, list);
		list.push(file);
	}
	for (const [name, list] of folders) {
		roots.push({
			name,
			kind: "directory",
			handle: null,
			entry: null,
			file: null,
			files: list,
			notResumable: "unsupported",
		});
	}
	return roots;
}

// ─── The walk ────────────────────────────────────────────────────────────────

/** How a walked file is read when its bytes are sent, and found again after a restart. */
export interface FileSource {
	/** The root it is under, in the order given. */
	readonly root: number;
	/** Its path under that root, `/`-separated; "" for a root that is the file itself. */
	readonly pathInRoot: string;
	/** The file as read now. */
	readonly file: File;
}

/** One file or folder of the tree, as TRANSFER_START names it, and where its bytes come from. */
export interface WalkedItem {
	readonly relPath: string;
	readonly kind: "file" | "dir";
	readonly size?: number;
	readonly mtime?: number;
	readonly source?: FileSource;
}

/** Something the walk left out, and why. */
export interface WalkSkip {
	readonly relPath: string;
	readonly reason: "link" | "too-deep" | "unreadable";
}

export interface WalkCounts {
	files: number;
	folders: number;
	emptyFolders: number;
	hidden: number;
	bytes: number;
}

export interface WalkResult {
	readonly items: readonly WalkedItem[];
	readonly counts: Readonly<WalkCounts>;
	readonly skipped: readonly WalkSkip[];
	/** More files than an upload may hold: the walk stopped there. */
	readonly tooMany: boolean;
	/** The walk was cancelled. */
	readonly cancelled: boolean;
}

/** The deepest a folder is walked, below a root: a link to a folder above it cannot loop. */
export const WALK_MAX_DEPTH = 32;

export interface WalkOptions {
	readonly signal?: AbortSignal;
	/** Told how far the count is, every so often: "Counting… 12,300 files, 4.1 GB". */
	readonly onProgress?: (counts: Readonly<WalkCounts>) => void;
	readonly maxDepth?: number;
}

/** A dot file, counted as hidden: what the files panel hides unless asked. */
export function isHiddenName(name: string): boolean {
	return name.startsWith(".");
}

function readEntryFile(entry: EntryLike): Promise<File> {
	return new Promise((resolve, reject) => {
		if (typeof entry.file !== "function") {
			reject(new Error("This entry has no file"));
			return;
		}
		entry.file(resolve, reject);
	});
}

async function readAllEntries(entry: EntryLike): Promise<EntryLike[]> {
	const reader = entry.createReader?.();
	if (reader === undefined) return [];
	const all: EntryLike[] = [];
	for (;;) {
		// Each call gives a batch (100 in Chromium), and an empty one at the end.
		const batch = await new Promise<EntryLike[]>((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
		if (batch.length === 0) return all;
		all.push(...batch);
	}
}

async function sameAsAncestor(
	handle: HandleLike,
	ancestors: readonly HandleLike[],
): Promise<boolean> {
	if (typeof handle.isSameEntry !== "function") return false;
	for (const above of ancestors) {
		try {
			if (await handle.isSameEntry(above)) return true;
		} catch {
			// A handle that cannot say is taken as another folder.
		}
	}
	return false;
}

/**
 * Walk what was dropped or picked into the items of one upload: every folder an item is in is
 * an item too, empty folders included. Counting stops past the most files an upload holds
 * (`tooMany`), and at a cancel.
 */
export async function walkRoots(
	roots: readonly UploadRoot[],
	options: WalkOptions = {},
): Promise<WalkResult> {
	const maxDepth = options.maxDepth ?? WALK_MAX_DEPTH;
	const items: WalkedItem[] = [];
	const skipped: WalkSkip[] = [];
	const counts: WalkCounts = { files: 0, folders: 0, emptyFolders: 0, hidden: 0, bytes: 0 };
	let tooMany = false;
	let lastReport = 0;

	const stopped = (): boolean => tooMany || options.signal?.aborted === true;
	const report = (force = false): void => {
		const now = Date.now();
		if (!force && now - lastReport < 100) return;
		lastReport = now;
		options.onProgress?.({ ...counts });
	};
	const addFile = (relPath: string, name: string, file: File, root: number, pathInRoot: string) => {
		if (counts.files >= TRANSFER_MAX_FILES || items.length >= TRANSFER_MAX_ITEMS) {
			tooMany = true;
			return;
		}
		counts.files++;
		counts.bytes += file.size;
		if (isHiddenName(name)) counts.hidden++;
		items.push({
			relPath,
			kind: "file",
			size: file.size,
			mtime: file.lastModified,
			source: { root, pathInRoot, file },
		});
		report();
	};
	const addFolder = (relPath: string, name: string): number => {
		if (items.length >= TRANSFER_MAX_ITEMS) {
			tooMany = true;
			return -1;
		}
		counts.folders++;
		if (isHiddenName(name)) counts.hidden++;
		items.push({ relPath, kind: "dir" });
		return items.length;
	};
	const unreadable = (relPath: string) => skipped.push({ relPath, reason: "unreadable" });

	const walkHandle = async (
		dir: DirectoryHandleLike,
		relPath: string,
		root: number,
		pathInRoot: string,
		depth: number,
		ancestors: readonly HandleLike[],
	): Promise<void> => {
		if (addFolder(relPath, dir.name) === -1) return;
		let children = 0;
		try {
			for await (const child of dir.values()) {
				if (stopped()) return;
				children++;
				const childRel = `${relPath}/${child.name}`;
				const childIn = pathInRoot === "" ? child.name : `${pathInRoot}/${child.name}`;
				if (child.kind === "file") {
					try {
						addFile(childRel, child.name, await child.getFile(), root, childIn);
					} catch {
						unreadable(childRel);
					}
				} else if (await sameAsAncestor(child, [dir, ...ancestors])) {
					skipped.push({ relPath: childRel, reason: "link" });
				} else if (depth + 1 > maxDepth) {
					skipped.push({ relPath: childRel, reason: "too-deep" });
				} else {
					await walkHandle(child, childRel, root, childIn, depth + 1, [dir, ...ancestors]);
				}
			}
		} catch {
			unreadable(relPath);
		}
		if (children === 0) counts.emptyFolders++;
	};

	const walkEntry = async (
		dir: EntryLike,
		relPath: string,
		root: number,
		pathInRoot: string,
		depth: number,
	): Promise<void> => {
		if (addFolder(relPath, dir.name) === -1) return;
		let children: EntryLike[];
		try {
			children = await readAllEntries(dir);
		} catch {
			unreadable(relPath);
			return;
		}
		if (children.length === 0) counts.emptyFolders++;
		for (const child of children) {
			if (stopped()) return;
			const childRel = `${relPath}/${child.name}`;
			const childIn = pathInRoot === "" ? child.name : `${pathInRoot}/${child.name}`;
			if (child.isFile) {
				try {
					addFile(childRel, child.name, await readEntryFile(child), root, childIn);
				} catch {
					unreadable(childRel);
				}
			} else if (child.isDirectory) {
				if (depth + 1 > maxDepth) skipped.push({ relPath: childRel, reason: "too-deep" });
				else await walkEntry(child, childRel, root, childIn, depth + 1);
			}
		}
	};

	const walkInputFolder = (name: string, files: readonly File[], root: number): void => {
		const folders = new Set<string>();
		const folder = (rel: string) => {
			if (folders.has(rel)) return;
			const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
			if (parent !== "") folder(parent);
			folders.add(rel);
			addFolder(rel, rel.slice(rel.lastIndexOf("/") + 1));
		};
		folder(name);
		for (const file of files) {
			if (stopped()) return;
			const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
			if (!rel.startsWith(`${name}/`)) continue;
			const parent = rel.slice(0, rel.lastIndexOf("/"));
			folder(parent);
			addFile(rel, file.name, file, root, rel.slice(name.length + 1));
		}
	};

	for (const [index, root] of roots.entries()) {
		if (stopped()) break;
		const name = root.name;
		if (root.kind === "file") {
			try {
				const file =
					root.handle?.kind === "file"
						? await root.handle.getFile()
						: (root.file ?? (root.entry !== null ? await readEntryFile(root.entry) : null));
				if (file === null) unreadable(name);
				else addFile(name, name, file, index, "");
			} catch {
				unreadable(name);
			}
		} else if (root.handle?.kind === "directory") {
			await walkHandle(root.handle, name, index, "", 0, []);
		} else if (root.entry !== null) {
			await walkEntry(root.entry, name, index, "", 0);
		} else if (root.files !== undefined) {
			walkInputFolder(name, root.files, index);
		} else {
			unreadable(name);
		}
	}
	report(true);
	return {
		items,
		counts: { ...counts },
		skipped,
		tooMany,
		cancelled: options.signal?.aborted === true,
	};
}

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Above this many files, the confirmation warns, even when drop confirmations are off. */
export const WARN_FILES = 10_000;
/** Above this many bytes (10 GB), the confirmation warns too. */
export const WARN_BYTES = 10 * 1024 ** 3;

export interface WalkLimits {
	/** More than an upload may hold (100,000 files): refused, suggesting an archive. */
	readonly refuse: boolean;
	/** Large: the confirmation is shown whatever `transfer_confirm_drop` says, and warns. */
	readonly warn: boolean;
}

export function limitsOf(result: Pick<WalkResult, "counts" | "tooMany">): WalkLimits {
	const refuse = result.tooMany || result.counts.files > TRANSFER_MAX_FILES;
	return {
		refuse,
		warn: !refuse && (result.counts.files > WARN_FILES || result.counts.bytes > WARN_BYTES),
	};
}
