/**
 * The handles of an upload, kept for the resume to come (#837): in IndexedDB, keyed by the upload
 * and by each of its items, one directory handle for a dropped folder, each file's path, size and
 * `lastModified`. fake-indexeddb is not a dependency: the IndexedDB store runs here on a small
 * in-memory factory with the same calls, and the transfers store's spec uses the `HandleStore`
 * seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HANDLES_DB,
	indexedDbHandleStore,
	type KeptItem,
	type KeptUpload,
	keptRecords,
} from "./upload-handles.js";

// ─── A small IndexedDB, as much of it as the store uses ──────────────────────

type Key = string | number | (string | number)[];

function compare(a: Key, b: Key): number {
	const x = Array.isArray(a) ? a : [a];
	const y = Array.isArray(b) ? b : [b];
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const p = x[i] as string | number;
		const q = y[i] as string | number;
		if (p < q) return -1;
		if (p > q) return 1;
	}
	return x.length - y.length;
}

class Range {
	constructor(
		readonly lower: Key,
		readonly upper: Key,
	) {}
	includes(key: Key): boolean {
		return compare(this.lower, key) <= 0 && compare(key, this.upper) <= 0;
	}
}

function fakeIndexedDb(): { factory: IDBFactory; dump: () => Record<string, unknown[]> } {
	const stores = new Map<
		string,
		{ keyPath: string | string[]; rows: Map<string, { key: Key; value: unknown }> }
	>();
	let version = 0;
	const keyOf = (keyPath: string | string[], value: Record<string, unknown>): Key =>
		Array.isArray(keyPath)
			? keyPath.map((k) => value[k] as string | number)
			: (value[keyPath] as Key);
	const request = <T>(run: () => T) => {
		const req: {
			result?: T;
			error: null;
			onsuccess: (() => void) | null;
			onerror: (() => void) | null;
		} = {
			error: null,
			onsuccess: null,
			onerror: null,
		};
		queueMicrotask(() => {
			req.result = run();
			req.onsuccess?.();
		});
		return req;
	};
	const db = {
		objectStoreNames: { contains: (name: string) => stores.has(name) },
		createObjectStore: (name: string, options: { keyPath: string | string[] }) => {
			stores.set(name, { keyPath: options.keyPath, rows: new Map() });
		},
		transaction: (names: string | string[]) => {
			const tx: {
				oncomplete: (() => void) | null;
				onerror: null;
				onabort: null;
				objectStore: (n: string) => unknown;
			} = {
				oncomplete: null,
				onerror: null,
				onabort: null,
				objectStore: (name: string) => {
					const store = stores.get(name);
					if (store === undefined || !(Array.isArray(names) ? names : [names]).includes(name)) {
						throw new Error(`no store ${name} in this transaction`);
					}
					return {
						put: (value: Record<string, unknown>) =>
							request(() => {
								const key = keyOf(store.keyPath, value);
								store.rows.set(JSON.stringify(key), { key, value });
							}),
						get: (key: Key) => request(() => store.rows.get(JSON.stringify(key))?.value),
						getAll: (range?: Range) =>
							request(() =>
								[...store.rows.values()]
									.filter((row) => range === undefined || range.includes(row.key))
									.sort((a, b) => compare(a.key, b.key))
									.map((row) => row.value),
							),
						delete: (key: Key | Range) =>
							request(() => {
								for (const [id, row] of store.rows) {
									if (key instanceof Range ? key.includes(row.key) : compare(key, row.key) === 0)
										store.rows.delete(id);
								}
							}),
					};
				},
			};
			// Completes once the requests made in it have run.
			setTimeout(() => tx.oncomplete?.(), 0);
			return tx;
		},
	};
	const factory = {
		open: (name: string, v: number) => {
			const req: {
				result: typeof db;
				onupgradeneeded: (() => void) | null;
				onsuccess: (() => void) | null;
				onerror: null;
			} = {
				result: db,
				onupgradeneeded: null,
				onsuccess: null,
				onerror: null,
			};
			expect(name).toBe(HANDLES_DB);
			queueMicrotask(() => {
				if (v > version) {
					version = v;
					req.onupgradeneeded?.();
				}
				req.onsuccess?.();
			});
			return req;
		},
	};
	return {
		factory: factory as unknown as IDBFactory,
		dump: () =>
			Object.fromEntries(
				[...stores].map(([name, store]) => [name, [...store.rows.values()].map((r) => r.value)]),
			),
	};
}

beforeEach(() => {
	vi.stubGlobal("IDBKeyRange", { bound: (lower: Key, upper: Key) => new Range(lower, upper) });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const T1 = "01ARZ3NDEKTSV4RRFFQ69G5FT1";
const T2 = "01ARZ3NDEKTSV4RRFFQ69G5FT2";

describe("what is kept of an upload", () => {
	const folder = {
		name: "photos",
		kind: "directory" as const,
		handle: { kind: "directory", name: "photos" },
	};
	const picked = {
		name: "notes.md",
		kind: "file" as const,
		handle: { kind: "file", name: "notes.md" },
	};
	const entryOnly = { name: "tmp", kind: "directory" as const, handle: null };

	it("keeps one directory handle for a folder and each file under it by item, with its size and date", () => {
		const records = keptRecords(
			{ transferId: T1, hostId: "h", channelId: "c", dir: "/srv", savedAt: 5 },
			[entryOnly, folder, picked],
			[
				{ itemId: 3, relPath: "tmp/x", root: 0, pathInRoot: "x", size: 1, lastModified: 1 },
				{
					itemId: 5,
					relPath: "photos/2026/a.jpg",
					root: 1,
					pathInRoot: "2026/a.jpg",
					size: 10,
					lastModified: 2,
				},
				{ itemId: 9, relPath: "notes.md", root: 2, pathInRoot: "", size: 20, lastModified: 3 },
			],
		);
		// The root that came without a handle (past the bound) keeps nothing.
		expect(records?.upload.roots).toEqual([folder, picked]);
		expect(records?.items).toEqual([
			{
				transferId: T1,
				itemId: 5,
				relPath: "photos/2026/a.jpg",
				root: 0,
				pathInRoot: "2026/a.jpg",
				size: 10,
				lastModified: 2,
			},
			{
				transferId: T1,
				itemId: 9,
				relPath: "notes.md",
				root: 1,
				pathInRoot: "",
				size: 20,
				lastModified: 3,
			},
		]);
	});

	it("keeps nothing when no root came with a handle", () => {
		expect(
			keptRecords(
				{ transferId: T1, hostId: "h", channelId: "c", dir: "/", savedAt: 0 },
				[entryOnly],
				[],
			),
		).toBeNull();
	});
});

describe("the IndexedDB store", () => {
	const upload = (transferId: string): KeptUpload => ({
		transferId,
		hostId: "h",
		channelId: "c",
		dir: "/srv",
		savedAt: 1,
		roots: [{ name: "photos", kind: "directory", handle: { name: "photos" } }],
	});
	const item = (transferId: string, itemId: number): KeptItem => ({
		transferId,
		itemId,
		relPath: `photos/${itemId}`,
		root: 0,
		pathInRoot: String(itemId),
		size: itemId,
		lastModified: 7,
	});

	it("saves an upload with its items, keyed by upload and item, and reads them back", async () => {
		const { factory, dump } = fakeIndexedDb();
		const store = indexedDbHandleStore(factory);
		await store.save(upload(T1), [item(T1, 2), item(T1, 1)]);
		await store.save(upload(T2), [item(T2, 1)]);
		expect(await store.load(T1)).toEqual({ upload: upload(T1), items: [item(T1, 1), item(T1, 2)] });
		expect((await store.list()).map((u) => u.transferId)).toEqual([T1, T2]);
		expect(dump().items).toHaveLength(3);
	});

	it("removes an upload and only its items", async () => {
		const { factory, dump } = fakeIndexedDb();
		const store = indexedDbHandleStore(factory);
		await store.save(upload(T1), [item(T1, 1), item(T1, 2)]);
		await store.save(upload(T2), [item(T2, 1)]);
		await store.remove(T1);
		expect(await store.load(T1)).toBeNull();
		expect(dump().items).toEqual([item(T2, 1)]);
	});
});
