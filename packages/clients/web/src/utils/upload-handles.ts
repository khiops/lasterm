/**
 * The File System Access handles of an upload, kept in IndexedDB (#837, part of #721), so that
 * the upload can be resumed after a crash or a restart: what the resume (#860's follow-up) reads
 * back, asks permission for on a click, checks against what was sent, and sends the rest of.
 *
 * Kept per upload and per item:
 * - `uploads`, keyed by the upload's id: its host, terminal and destination, when it was saved,
 *   and its roots, each with its handle: a dropped or picked folder keeps **one** directory
 *   handle, so that one permission covers its tree; a file keeps its own;
 * - `items`, keyed by `[upload id, item id]`: each file's relative path, the root it is under and
 *   its path there, its size and `lastModified` when it was sent, which a resume checks a fresh
 *   `getFile()` against (a handle follows the path, not the file).
 *
 * Only roots that came with a handle are kept; an upload none of whose roots did keeps nothing.
 * The records go once nothing of the upload is left to send.
 *
 * A handle read back after a restart is in the "prompt" state: reading it needs
 * `requestPermission`, on a click, never decided from `queryPermission` (WebView2 keeps
 * answering "prompt" when the grant is saved).
 */

/** A root of a kept upload: a dropped or picked file or folder, with its handle. */
export interface KeptRoot {
	readonly name: string;
	readonly kind: "file" | "directory";
	/** A `FileSystemHandle`: structured-cloned into IndexedDB as it is. */
	readonly handle: unknown;
}

export interface KeptUpload {
	readonly transferId: string;
	readonly hostId: string;
	readonly channelId: string;
	readonly dir: string;
	/** Milliseconds since the epoch. */
	readonly savedAt: number;
	readonly roots: readonly KeptRoot[];
}

/** One file of a kept upload. */
export interface KeptItem {
	readonly transferId: string;
	readonly itemId: number;
	readonly relPath: string;
	/** The root it is under, an index into `KeptUpload.roots`. */
	readonly root: number;
	/** Its path under that root, `/`-separated; "" for a root that is the file itself. */
	readonly pathInRoot: string;
	readonly size: number;
	readonly lastModified: number;
}

/** Where the handles are kept. */
export interface HandleStore {
	save(upload: KeptUpload, items: readonly KeptItem[]): Promise<void>;
	load(transferId: string): Promise<{ upload: KeptUpload; items: KeptItem[] } | null>;
	list(): Promise<KeptUpload[]>;
	remove(transferId: string): Promise<void>;
}

export const HANDLES_DB = "lasterm-transfers";
export const HANDLES_DB_VERSION = 1;
const UPLOADS = "uploads";
const ITEMS = "items";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

/** The key range of every item of one upload. */
function itemsOf(transferId: string): IDBKeyRange {
	return IDBKeyRange.bound([transferId, 0], [transferId, Number.MAX_SAFE_INTEGER]);
}

/** The IndexedDB store, on `factory` (the page's `indexedDB` by default). */
export function indexedDbHandleStore(factory: IDBFactory = indexedDB): HandleStore {
	let opened: Promise<IDBDatabase> | null = null;
	const open = (): Promise<IDBDatabase> => {
		opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const req = factory.open(HANDLES_DB, HANDLES_DB_VERSION);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(UPLOADS))
					db.createObjectStore(UPLOADS, { keyPath: "transferId" });
				if (!db.objectStoreNames.contains(ITEMS)) {
					db.createObjectStore(ITEMS, { keyPath: ["transferId", "itemId"] });
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => {
				opened = null;
				reject(req.error);
			};
		});
		return opened;
	};
	return {
		async save(upload, items) {
			const db = await open();
			const tx = db.transaction([UPLOADS, ITEMS], "readwrite");
			tx.objectStore(UPLOADS).put(upload);
			const store = tx.objectStore(ITEMS);
			for (const item of items) store.put(item);
			await done(tx);
		},
		async load(transferId) {
			const db = await open();
			const tx = db.transaction([UPLOADS, ITEMS], "readonly");
			const upload = await request(
				tx.objectStore(UPLOADS).get(transferId) as IDBRequest<KeptUpload | undefined>,
			);
			const items = await request(
				tx.objectStore(ITEMS).getAll(itemsOf(transferId)) as IDBRequest<KeptItem[]>,
			);
			return upload === undefined ? null : { upload, items };
		},
		async list() {
			const db = await open();
			const tx = db.transaction(UPLOADS, "readonly");
			return request(tx.objectStore(UPLOADS).getAll() as IDBRequest<KeptUpload[]>);
		},
		async remove(transferId) {
			const db = await open();
			const tx = db.transaction([UPLOADS, ITEMS], "readwrite");
			tx.objectStore(UPLOADS).delete(transferId);
			tx.objectStore(ITEMS).delete(itemsOf(transferId));
			await done(tx);
		},
	};
}

/** A store that keeps nothing: a browser without IndexedDB. */
export const NO_HANDLE_STORE: HandleStore = {
	save: async () => undefined,
	load: async () => null,
	list: async () => [],
	remove: async () => undefined,
};

/** The page's store: IndexedDB where the page has it. */
export function defaultHandleStore(): HandleStore {
	try {
		return typeof indexedDB === "undefined" ? NO_HANDLE_STORE : indexedDbHandleStore(indexedDB);
	} catch {
		return NO_HANDLE_STORE;
	}
}

/**
 * The records for an upload: its roots that have a handle, and each of its files under one,
 * by item id. Null when none of its roots has one: nothing could be read again after a restart.
 */
export function keptRecords(
	upload: Omit<KeptUpload, "roots">,
	roots: readonly { name: string; kind: "file" | "directory"; handle: unknown | null }[],
	files: readonly {
		itemId: number;
		relPath: string;
		root: number;
		pathInRoot: string;
		size: number;
		lastModified: number;
	}[],
): { upload: KeptUpload; items: KeptItem[] } | null {
	const kept: KeptRoot[] = [];
	const index = new Map<number, number>();
	for (const [i, root] of roots.entries()) {
		if (root.handle === null || root.handle === undefined) continue;
		index.set(i, kept.length);
		kept.push({ name: root.name, kind: root.kind, handle: root.handle });
	}
	if (kept.length === 0) return null;
	const items: KeptItem[] = [];
	for (const file of files) {
		const root = index.get(file.root);
		if (root === undefined) continue;
		items.push({
			transferId: upload.transferId,
			itemId: file.itemId,
			relPath: file.relPath,
			root,
			pathInRoot: file.pathInRoot,
			size: file.size,
			lastModified: file.lastModified,
		});
	}
	return { upload: { ...upload, roots: kept }, items };
}
