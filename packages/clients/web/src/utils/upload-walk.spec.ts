/**
 * Reading a drop (#837): each item asked for its handle and its entry inside the drop event, the
 * handle awaited within a bound (a folder under %LOCALAPPDATA% can leave it pending for ever in
 * WebView2), the entry taken past it; then the walk, its counts, and its limits.
 */
import { TRANSFER_MAX_FILES } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bounded,
	type DirectoryHandleLike,
	type DropItemLike,
	type EntryLike,
	type FileHandleLike,
	type HandleLike,
	limitsOf,
	readDrop,
	rootsFromInputFiles,
	WARN_BYTES,
	WARN_FILES,
	walkRoots,
} from "./upload-walk.js";

afterEach(() => {
	vi.useRealTimers();
});

function fakeFile(name: string, size: number, lastModified = 1_700_000_000_000): File {
	return { name, size, lastModified } as File;
}

function fileHandle(name: string, size: number): FileHandleLike {
	return { kind: "file", name, getFile: async () => fakeFile(name, size) };
}

function dirHandle(
	name: string,
	children: HandleLike[],
	same?: () => HandleLike[],
): DirectoryHandleLike {
	const handle: DirectoryHandleLike = {
		kind: "directory",
		name,
		async *values() {
			for (const child of children) yield child;
		},
		isSameEntry: async (other) => other === handle || (same?.().includes(other) ?? false),
	};
	return handle;
}

function fileEntry(name: string, size: number): EntryLike {
	return { name, isFile: true, isDirectory: false, file: (ok) => ok(fakeFile(name, size)) };
}

/** A folder entry whose reader gives its children in batches, then an empty one. */
function dirEntry(name: string, children: EntryLike[], batch = 2): EntryLike {
	return {
		name,
		isFile: false,
		isDirectory: true,
		createReader: () => {
			let at = 0;
			return {
				readEntries: (ok) => {
					const next = children.slice(at, at + batch);
					at += batch;
					queueMicrotask(() => ok(next));
				},
			};
		},
	};
}

describe("reading a drop inside its event", () => {
	it("asks every item for its handle and its entry before returning", () => {
		const calls: string[] = [];
		const item: DropItemLike = {
			kind: "file",
			getAsFile: () => {
				calls.push("file");
				return null;
			},
			webkitGetAsEntry: () => {
				calls.push("entry");
				return fileEntry("a.txt", 1);
			},
			getAsFileSystemHandle: () => {
				calls.push("handle");
				return Promise.resolve(fileHandle("a.txt", 1));
			},
		};
		void readDrop([item, item]);
		// Synchronously: the items are unreadable once the event returns.
		expect(calls).toEqual(["handle", "entry", "file", "handle", "entry", "file"]);
	});

	it("keeps a handle that comes in time: the upload can be resumed after a restart", async () => {
		const handle = dirHandle("photos", []);
		const roots = await readDrop([
			{
				kind: "file",
				getAsFile: () => null,
				webkitGetAsEntry: () => dirEntry("photos", []),
				getAsFileSystemHandle: () => Promise.resolve(handle),
			},
		]);
		expect(roots).toHaveLength(1);
		expect(roots[0]?.handle).toBe(handle);
		expect(roots[0]?.notResumable).toBeNull();
	});

	it("goes on with the entry past the bound, and says it cannot be resumed after a restart", async () => {
		vi.useFakeTimers();
		const entry = dirEntry("AppData-folder", []);
		const read = readDrop(
			[
				{
					kind: "file",
					getAsFile: () => null,
					webkitGetAsEntry: () => entry,
					// What WebView2 did for a folder under %LOCALAPPDATA%: never settled.
					getAsFileSystemHandle: () => new Promise<HandleLike | null>(() => undefined),
				},
			],
			3_000,
		);
		let done = false;
		void read.then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(2_999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const roots = await read;
		expect(roots).toEqual([
			{
				name: "AppData-folder",
				kind: "directory",
				handle: null,
				entry,
				file: null,
				notResumable: "pending",
			},
		]);
	});

	it("takes the entry when the handle fails, and when the browser has no such API", async () => {
		const failed = await readDrop([
			{
				kind: "file",
				getAsFile: () => fakeFile("a.txt", 3),
				webkitGetAsEntry: () => fileEntry("a.txt", 3),
				getAsFileSystemHandle: () => Promise.reject(new Error("no")),
			},
		]);
		expect(failed[0]?.notResumable).toBe("pending");
		const firefox = await readDrop([
			{
				kind: "file",
				getAsFile: () => fakeFile("a.txt", 3),
				webkitGetAsEntry: () => fileEntry("a.txt", 3),
			},
		]);
		expect(firefox[0]?.notResumable).toBe("unsupported");
		expect(firefox[0]?.kind).toBe("file");
	});

	it("bounds a wait: the value in time, a timeout after", async () => {
		vi.useFakeTimers();
		const late = bounded(new Promise(() => undefined), 50);
		await vi.advanceTimersByTimeAsync(50);
		expect(await late).toEqual({ ok: false, reason: "timeout" });
		expect(await bounded(Promise.resolve(7), 50)).toEqual({ ok: true, value: 7 });
	});
});

describe("walking what was dropped", () => {
	it("walks a folder's handle: every folder an item, empty ones too, hidden files counted", async () => {
		const root = dirHandle("photos", [
			fileHandle("a.jpg", 100),
			fileHandle(".DS_Store", 6),
			dirHandle("2026", [fileHandle("b.jpg", 50)]),
			dirHandle("empty", []),
		]);
		const result = await walkRoots([
			{
				name: "photos",
				kind: "directory",
				handle: root,
				entry: null,
				file: null,
				notResumable: null,
			},
		]);
		expect(result.items.map((item) => [item.relPath, item.kind])).toEqual([
			["photos", "dir"],
			["photos/a.jpg", "file"],
			["photos/.DS_Store", "file"],
			["photos/2026", "dir"],
			["photos/2026/b.jpg", "file"],
			["photos/empty", "dir"],
		]);
		expect(result.counts).toEqual({ files: 3, folders: 3, emptyFolders: 1, hidden: 1, bytes: 156 });
		// Each file is found again under its root after a restart: one directory handle for the tree.
		expect(result.items[4]?.source).toMatchObject({ root: 0, pathInRoot: "2026/b.jpg" });
	});

	it("walks an entry, reading each folder until it gives no more", async () => {
		const root = dirEntry("src", [
			fileEntry("a", 1),
			fileEntry("b", 2),
			fileEntry("c", 3),
			dirEntry("lib", []),
		]);
		const result = await walkRoots([
			{
				name: "src",
				kind: "directory",
				handle: null,
				entry: root,
				file: null,
				notResumable: "pending",
			},
		]);
		expect(result.items.map((item) => item.relPath)).toEqual([
			"src",
			"src/a",
			"src/b",
			"src/c",
			"src/lib",
		]);
		expect(result.counts.emptyFolders).toBe(1);
	});

	it("skips a folder that is the same as one above it, as a link, and one deeper than the bound", async () => {
		let root: DirectoryHandleLike;
		const loop = dirHandle("loop", [], () => [root]);
		root = dirHandle("top", [loop, dirHandle("a", [dirHandle("b", [dirHandle("c", [])])])]);
		const result = await walkRoots(
			[
				{
					name: "top",
					kind: "directory",
					handle: root,
					entry: null,
					file: null,
					notResumable: null,
				},
			],
			{ maxDepth: 2 },
		);
		expect(result.skipped).toEqual([
			{ relPath: "top/loop", reason: "link" },
			{ relPath: "top/a/b/c", reason: "too-deep" },
		]);
	});

	it("takes a folder an <input webkitdirectory> gave, by its files' relative paths", async () => {
		const files = [
			Object.assign(fakeFile("a.txt", 1), { webkitRelativePath: "docs/a.txt" }),
			Object.assign(fakeFile("b.txt", 2), { webkitRelativePath: "docs/sub/b.txt" }),
		];
		const result = await walkRoots(rootsFromInputFiles(files));
		expect(result.items.map((item) => item.relPath)).toEqual([
			"docs",
			"docs/a.txt",
			"docs/sub",
			"docs/sub/b.txt",
		]);
	});

	it("stops at a cancel", async () => {
		const abort = new AbortController();
		abort.abort();
		const result = await walkRoots(
			[
				{
					name: "x",
					kind: "directory",
					handle: dirHandle("x", [fileHandle("a", 1)]),
					entry: null,
					file: null,
					notResumable: null,
				},
			],
			{ signal: abort.signal },
		);
		expect(result.cancelled).toBe(true);
	});
});

describe("the limits", () => {
	it("warns above 10,000 files or 10 GB, even when drop confirmations are off", () => {
		const counts = (files: number, bytes: number) => ({
			files,
			folders: 0,
			emptyFolders: 0,
			hidden: 0,
			bytes,
		});
		expect(limitsOf({ counts: counts(WARN_FILES, 1), tooMany: false })).toEqual({
			refuse: false,
			warn: false,
		});
		expect(limitsOf({ counts: counts(WARN_FILES + 1, 1), tooMany: false })).toEqual({
			refuse: false,
			warn: true,
		});
		expect(limitsOf({ counts: counts(1, WARN_BYTES + 1), tooMany: false })).toEqual({
			refuse: false,
			warn: true,
		});
		expect(WARN_BYTES).toBe(10 * 1024 ** 3);
	});

	it("refuses above 100,000 files: the walk stops counting there", async () => {
		const many: EntryLike[] = [];
		for (let i = 0; i <= TRANSFER_MAX_FILES; i++) many.push(fileEntry(`f${i}`, 0));
		const result = await walkRoots([
			{
				name: "big",
				kind: "directory",
				handle: null,
				entry: dirEntry("big", many, 5_000),
				file: null,
				notResumable: "unsupported",
			},
		]);
		expect(result.tooMany).toBe(true);
		expect(result.counts.files).toBe(TRANSFER_MAX_FILES);
		expect(limitsOf(result)).toEqual({ refuse: true, warn: false });
	}, 30_000);
});
