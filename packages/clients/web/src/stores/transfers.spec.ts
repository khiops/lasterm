/**
 * The window's uploads (#837): a drop walked, confirmed or not, started with TRANSFER_START; each
 * file the hub puts in `sending` sent chunk by chunk, at most `max_concurrent` at once; its
 * handles kept by upload and item, then let go once nothing is left; panes closing that stop
 * nothing and say so once; conflict answers saved for the upload's own host; a connection that
 * comes back joining what the window was sending.
 */
import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import type { IWsClient } from "../services/ws-client.js";
import type { DesktopBridge } from "../utils/desktop-uploads.js";
import type { HandleStore, KeptItem, KeptUpload } from "../utils/upload-handles.js";
import type { ChunkAnswer } from "../utils/upload-send.js";
import {
	type DirectoryHandleLike,
	type HandleLike,
	rootFromDirectoryHandle,
} from "../utils/upload-walk.js";
import { useAuthStore } from "./auth.js";
import { useChannelsStore } from "./channels.js";
import { useConfigStore } from "./config.js";
import { useFilesPanelStore } from "./files-panel.js";
import { useToastStore } from "./toast.js";
import { type UploadTarget, useTransfersStore } from "./transfers.js";
import { useWriteLockStore } from "./writelock.js";

const C1 = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const C2 = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
const HOST = "01ARZ3NDEKTSV4RRFFQ69G5FH1";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5FT1";
const MiB = 1024 * 1024;

// ─── A socket, a hand-settled chunk route, and handles kept in memory ────────

function fakeSocket() {
	const handlers = new Map<string, ((msg: ProtocolMessage) => void)[]>();
	const disconnects: (() => void)[] = [];
	const sent: ProtocolMessage[] = [];
	const client: IWsClient = {
		connect: async () => undefined,
		send: (msg) => {
			sent.push(msg);
		},
		on: (type, callback) => {
			handlers.set(type, [...(handlers.get(type) ?? []), callback]);
			return () => undefined;
		},
		onReconnect: () => () => undefined,
		onDisconnect: (callback) => {
			disconnects.push(callback);
			return () => undefined;
		},
		close: () => undefined,
		isConnected: true,
	};
	const hear = (msg: Record<string, unknown>) => {
		for (const handler of handlers.get(String(msg.type)) ?? [])
			handler(msg as unknown as ProtocolMessage);
	};
	const drop = () => {
		for (const disconnect of disconnects) disconnect();
	};
	return { client, sent, hear, drop };
}

function memoryHandles() {
	const uploads = new Map<string, KeptUpload>();
	const items = new Map<string, KeptItem[]>();
	const store: HandleStore = {
		save: async (upload, list) => {
			uploads.set(upload.transferId, upload);
			items.set(upload.transferId, [...list]);
		},
		load: async (id) => {
			const upload = uploads.get(id);
			return upload === undefined ? null : { upload, items: items.get(id) ?? [] };
		},
		list: async () => [...uploads.values()],
		remove: async (id) => {
			uploads.delete(id);
			items.delete(id);
		},
	};
	return { store, uploads, items };
}

function fakeFile(name: string, size: number): File {
	return new File([new Uint8Array(size)], name, { lastModified: 1_700_000_000_000 });
}

function folder(name: string, files: [string, number][]): DirectoryHandleLike {
	return {
		kind: "directory",
		name,
		async *values(): AsyncIterable<HandleLike> {
			for (const [file, size] of files)
				yield { kind: "file", name: file, getFile: async () => fakeFile(file, size) };
		},
	};
}

function target(overrides: Partial<UploadTarget> = {}): UploadTarget {
	return {
		channelId: C1,
		hostId: HOST,
		dir: "/home/pi",
		origin: "terminal",
		place: "pane",
		paneId: "p1",
		onConflict: "ask",
		confirm: false,
		...overrides,
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let socket: ReturnType<typeof fakeSocket>;
let handles: ReturnType<typeof memoryHandles>;
let puts: {
	transferId: string;
	itemId: number;
	offset: number;
	size: number;
	settle: (answer: ChunkAnswer) => void;
}[];

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	mocks.hubFetch.mockReset();
	socket = fakeSocket();
	handles = memoryHandles();
	puts = [];
	const transfers = useTransfersStore();
	transfers.registerHandlers(socket.client);
	transfers.setSeamsForTests({
		handles: handles.store,
		put: (transferId, itemId, offset, chunk) =>
			new Promise((settle) => puts.push({ transferId, itemId, offset, size: chunk.size, settle })),
	});
	useChannelsStore().registerChannelHost(C1, HOST);
	useChannelsStore().registerChannelHost(C2, HOST);
	useConfigStore().uiConfig = { onChannelDead: "readonly", transfer: { maxConcurrent: 2 } };
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Drop `photos/` (three files) and answer its start; the upload's id is T1. */
async function startPhotos(t: UploadTarget = target()) {
	const transfers = useTransfersStore();
	const root = folder("photos", [
		["a.jpg", 2 * MiB + 1],
		["b.jpg", 10],
		["c.jpg", 20],
	]);
	const begun = transfers.begin(t, [rootFromDirectoryHandle(root)]);
	await flush();
	const start = socket.sent.find((msg) => msg.type === "TRANSFER_START");
	if (start?.type !== "TRANSFER_START") throw new Error("no TRANSFER_START");
	socket.hear({
		type: "TRANSFER_ACCEPTED",
		requestId: start.requestId,
		transferId: T1,
		channelId: C1,
		hostId: HOST,
		dir: "/home/pi",
		joined: false,
		items: start.items.map((_, itemId) => ({ itemId, state: "queued" })),
		folderConflicts: [],
	});
	await begun;
	return { start, root };
}

describe("starting and sending", () => {
	it("starts the tree as walked, keeps its handles by upload and item, and sends what the hub takes", async () => {
		const { start, root } = await startPhotos();
		expect(start).toMatchObject({
			channelId: C1,
			dir: "/home/pi",
			onConflict: "ask",
			items: [
				{ relPath: "photos", kind: "dir" },
				{ relPath: "photos/a.jpg", kind: "file", size: 2 * MiB + 1 },
				{ relPath: "photos/b.jpg", kind: "file", size: 10 },
				{ relPath: "photos/c.jpg", kind: "file", size: 20 },
			],
		});
		await flush();
		// One directory handle for the tree, each file by its item id, its size and its date.
		expect(handles.uploads.get(T1)?.roots).toEqual([
			{ name: "photos", kind: "directory", handle: root },
		]);
		expect(
			handles.items.get(T1)?.map((i) => [i.itemId, i.pathInRoot, i.size, i.lastModified]),
		).toEqual([
			[1, "a.jpg", 2 * MiB + 1, 1_700_000_000_000],
			[2, "b.jpg", 10, 1_700_000_000_000],
			[3, "c.jpg", 20, 1_700_000_000_000],
		]);
		expect(puts).toHaveLength(0);

		// The hub puts the three in `sending`: two go at once, as max_concurrent says.
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [1, 2, 3].map((itemId) => ({ itemId, state: "sending", acked: 0 })),
			folders: [],
			totals: { files: 3, bytes: 2 * MiB + 31, acked: 0, states: { sending: 3 } },
		});
		await flush();
		expect(puts.map((p) => [p.itemId, p.offset, p.size])).toEqual([
			[1, 0, MiB],
			[2, 0, 10],
		]);
		// One answered: the next chunk of that file, and the third file now there is room.
		puts[0]?.settle({ ok: true, acked: MiB });
		puts[1]?.settle({ ok: true, acked: 10 });
		await flush();
		expect(puts.slice(2).map((p) => [p.itemId, p.offset])).toEqual([
			[1, MiB],
			[3, 0],
		]);
	});

	it("resumes a file from the hub's acked, and lets the handles go once everything is placed", async () => {
		await startPhotos();
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [{ itemId: 1, state: "sending", acked: 2 * MiB }],
			folders: [],
			totals: { files: 3, bytes: 2 * MiB + 31, acked: 2 * MiB, states: { sending: 1, queued: 2 } },
		});
		await flush();
		expect(puts.map((p) => [p.itemId, p.offset, p.size])).toEqual([[1, 2 * MiB, 1]]);
		await flush();
		expect(handles.uploads.has(T1)).toBe(true);
		socket.hear({
			type: "TRANSFER_DONE",
			transferId: T1,
			channelId: C1,
			totals: { files: 3, bytes: 2 * MiB + 31, acked: 2 * MiB + 31, states: { placed: 3 } },
		});
		await flush();
		expect(handles.uploads.has(T1)).toBe(false);
	});

	it("sends a file the hub no longer takes no more, until the hub says it is sending it anew", async () => {
		await startPhotos();
		const sending = (acked: number) =>
			socket.hear({
				type: "TRANSFER_PROGRESS",
				transferId: T1,
				channelId: C1,
				items: [{ itemId: 2, state: "sending", acked }],
				folders: [],
				totals: { files: 3, bytes: 2 * MiB + 31, acked, states: { sending: 1, queued: 2 } },
			});
		sending(0);
		await flush();
		expect(puts).toHaveLength(1);
		// Cancelled at the hub while the chunk went: the window hears it after the answer.
		puts[0]?.settle({
			ok: false,
			status: 409,
			code: "ITEM_NOT_SENDING",
			message: "",
			state: "cancelled",
		});
		await flush();
		expect(puts).toHaveLength(1);
		// A word that changes nothing does not start it again; a Retry that sends it anew does.
		sending(0);
		await flush();
		expect(puts).toHaveLength(1);
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [{ itemId: 2, state: "cancelled", acked: 0 }],
			folders: [],
			totals: { files: 3, bytes: 2 * MiB + 31, acked: 0, states: { cancelled: 1, queued: 2 } },
		});
		sending(0);
		await flush();
		expect(puts.map((p) => [p.itemId, p.offset])).toEqual([
			[2, 0],
			[2, 0],
		]);
	});

	it("asks first when transfer_confirm_drop is on, and saves Don't ask again for the upload's host", async () => {
		const configStore = useConfigStore();
		vi.spyOn(configStore, "readProfileLayers").mockResolvedValue({});
		const save = vi.spyOn(configStore, "saveProfileWrite").mockResolvedValue(true);
		const transfers = useTransfersStore();
		void transfers.begin(target({ confirm: true }), [
			rootFromDirectoryHandle(folder("docs", [["a.txt", 3]])),
		]);
		await flush();
		expect(transfers.pending?.phase).toBe("ready");
		expect(transfers.pendingShown).toBe(true);
		expect(socket.sent.some((msg) => msg.type === "TRANSFER_START")).toBe(false);
		void transfers.confirmPending({ dontAskAgain: "host" });
		await flush();
		expect(save.mock.calls[0]?.[0].requests[0]).toEqual({
			method: "PATCH",
			path: `/api/hosts/${HOST}/profile`,
			body: { profile: { transferConfirmDrop: false } },
		});
		expect(socket.sent.some((msg) => msg.type === "TRANSFER_START")).toBe(true);
	});

	it("stops what the hub started when its card was cancelled meanwhile", async () => {
		const transfers = useTransfersStore();
		void transfers.begin(target(), [rootFromDirectoryHandle(folder("docs", [["a.txt", 3]]))]);
		await flush();
		const start = socket.sent.find((msg) => msg.type === "TRANSFER_START");
		if (start?.type !== "TRANSFER_START") throw new Error("no start");
		expect(transfers.pending?.phase).toBe("starting");
		transfers.cancelPending();
		socket.hear({
			type: "TRANSFER_ACCEPTED",
			requestId: start.requestId,
			transferId: T1,
			channelId: C1,
			hostId: HOST,
			dir: "/home/pi",
			joined: false,
			items: start.items.map((_, itemId) => ({ itemId, state: "queued" })),
			folderConflicts: [],
		});
		await flush();
		expect(socket.sent.at(-1)).toEqual({
			type: "TRANSFER_CANCEL",
			transferId: T1,
			scope: "upload",
		});
	});

	it("says a refused start in its card, nothing sent", async () => {
		const transfers = useTransfersStore();
		void transfers.begin(target(), [rootFromDirectoryHandle(folder("docs", [["a.txt", 3]]))]);
		await flush();
		const start = socket.sent.find((msg) => msg.type === "TRANSFER_START");
		if (start?.type !== "TRANSFER_START") throw new Error("no start");
		socket.hear({
			type: "TRANSFER_ERROR",
			requestId: start.requestId,
			code: "INSUFFICIENT_SPACE",
			message: "No room",
		});
		await flush();
		expect(transfers.pending?.error).toBe("No room");
		expect(transfers.pendingShown).toBe(true);
		expect(transfers.uploads).toHaveLength(0);
	});
});

describe("panes closing, and the connection coming back", () => {
	it("stops nothing when a tab closes, and says so once for the gesture", async () => {
		const transfers = useTransfersStore();
		transfers.noteChannelsInTabs(new Set([C1, C2]));
		await startPhotos();
		const show = vi.spyOn(useToastStore(), "show");
		transfers.noteChannelsInTabs(new Set());
		expect(show).toHaveBeenCalledTimes(1);
		expect(show.mock.calls[0]?.[1]).toBe("1 upload continues in Transfers");
		expect(transfers.uploads).toHaveLength(1);
		expect(transfers.originOf({ channelId: C1 })).toBe("pane closed");
		expect(socket.sent.some((msg) => msg.type === "TRANSFER_CANCEL")).toBe(false);
	});

	it("joins what it was sending once the connection is back, and goes on from the hub's offsets", async () => {
		const { start } = await startPhotos();
		socket.drop();
		expect(transfers().uploads[0]?.sender).toBe(false);
		transfers().rejoin();
		await flush();
		const again = socket.sent.filter((msg) => msg.type === "TRANSFER_START");
		expect(again).toHaveLength(2);
		const rejoin = again[1];
		if (rejoin?.type !== "TRANSFER_START") throw new Error("no rejoin");
		// The same tree to the same folder: the hub joins it.
		expect(rejoin.items).toEqual(start.items);
		socket.hear({
			type: "TRANSFER_ACCEPTED",
			requestId: rejoin.requestId,
			transferId: T1,
			channelId: C1,
			hostId: HOST,
			dir: "/home/pi",
			joined: true,
			items: rejoin.items.map((_, itemId) => ({
				itemId,
				state: itemId === 2 ? "placed" : "queued",
			})),
			folderConflicts: [],
		});
		await flush();
		expect(transfers().uploads).toHaveLength(1);
		expect(transfers().uploads[0]?.sender).toBe(true);
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [{ itemId: 1, state: "sending", acked: MiB }],
			folders: [],
			totals: {
				files: 3,
				bytes: 2 * MiB + 31,
				acked: MiB + 10,
				states: { sending: 1, placed: 1, queued: 1 },
			},
		});
		await flush();
		expect(puts.map((p) => [p.itemId, p.offset])).toEqual([[1, MiB]]);
	});
});

function transfers() {
	return useTransfersStore();
}

describe("answering a conflict", () => {
	it("saves Always do this for the upload's own host, then answers", async () => {
		await startPhotos();
		const configStore = useConfigStore();
		vi.spyOn(configStore, "readProfileLayers").mockResolvedValue({
			host: { transferOnConflict: "skip" },
		});
		const save = vi.spyOn(configStore, "saveProfileWrite").mockResolvedValue(true);
		await transfers().resolve(T1, "upload", "replace", "host");
		expect(save.mock.calls[0]?.[0].requests[0]).toEqual({
			method: "PATCH",
			path: `/api/hosts/${HOST}/profile`,
			body: { profile: { transferOnConflict: "replace" } },
		});
		expect(socket.sent.at(-1)).toEqual({
			type: "TRANSFER_RESOLVE",
			transferId: T1,
			scope: "upload",
			action: "replace",
		});
	});

	it("saves nothing for this time only", async () => {
		await startPhotos();
		const save = vi.spyOn(useConfigStore(), "saveProfileWrite");
		await transfers().resolve(T1, 2, "skip");
		expect(save).not.toHaveBeenCalled();
		expect(socket.sent.at(-1)).toEqual({
			type: "TRANSFER_RESOLVE",
			transferId: T1,
			scope: 2,
			action: "skip",
		});
	});
});

describe("a quit the desktop holds for these uploads", () => {
	const ME = "01ARZ3NDEKTSV4RRFFQ69G5FME";
	const quitting: DesktopBridge = {
		invoke: async () => ({ pending: "quit" }),
		listen: async () => () => undefined,
	};

	function focusOn(holder: string): ReturnType<typeof useFilesPanelStore> {
		useAuthStore().setClientId(ME);
		useWriteLockStore().handleWriteLock(C1, holder);
		const panel = useFilesPanelStore();
		panel.setChannelsInTabs(new Set([C1]));
		panel.setFocused(C1);
		panel.setTransfersCollapsed(true);
		return panel;
	}

	it("opens this window's own panel on its Transfers, to say so", async () => {
		const panel = focusOn(ME);
		const stop = transfers().startWindowGuards(Promise.resolve(quitting));
		await flush();
		expect(transfers().quitPending).toBe("quit");
		expect(panel.shown).toBe(true);
		expect(panel.transfersCollapsed).toBe(false);
		stop();
	});

	it("leaves a reader's choice of panel on a terminal it reads as it was (#838)", async () => {
		const panel = focusOn("01ARZ3NDEKTSV4RRFFQ69G5FOT");
		const stop = transfers().startWindowGuards(Promise.resolve(quitting));
		await flush();
		expect(transfers().quitPending).toBe("quit");
		expect(panel.shown).toBe(false);
		expect(panel.readerChoice(C1)).toBe("none");
		expect(panel.transfersCollapsed).toBe(false);
		stop();
	});
});

describe("a re-drop after a reload", () => {
	it("goes to the folder of the interrupted upload of the same tree, which the hub joins", async () => {
		mocks.hubFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					transfer_id: T1,
					channel_id: C1,
					host_id: HOST,
					dir: "/srv/kept",
					state: "interrupted",
					totals: { files: 1, bytes: 3, acked: 1, states: { interrupted: 1 } },
					items: [
						{ item_id: 0, rel_path: "docs", kind: "dir", size: null, state: "placed" },
						{
							item_id: 1,
							rel_path: "docs/a.txt",
							kind: "file",
							size: 3,
							state: "interrupted",
							acked: 1,
						},
					],
				}),
			),
		);
		// This window lists it after its reload, as the hub reports it.
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [],
			folders: [],
			totals: { files: 1, bytes: 3, acked: 1, states: { interrupted: 1 } },
		});
		await flush();
		expect(transfers().uploads[0]).toMatchObject({ id: T1, sender: false });
		// The same folder dropped again, on a terminal now in another directory.
		void transfers().begin(target({ dir: "/home/pi" }), [
			rootFromDirectoryHandle(folder("docs", [["a.txt", 3]])),
		]);
		await flush();
		const start = socket.sent.find((msg) => msg.type === "TRANSFER_START");
		if (start?.type !== "TRANSFER_START") throw new Error("no start");
		expect(start.dir).toBe("/srv/kept");
		socket.hear({
			type: "TRANSFER_ACCEPTED",
			requestId: start.requestId,
			transferId: T1,
			channelId: C1,
			hostId: HOST,
			dir: "/srv/kept",
			joined: true,
			items: [
				{ itemId: 0, state: "placed" },
				{ itemId: 1, state: "queued" },
			],
			folderConflicts: [],
		});
		await flush();
		expect(transfers().uploads).toHaveLength(1);
		expect(transfers().uploads[0]).toMatchObject({ id: T1, sender: true });
	});
});

describe("an upload another window sends", () => {
	it("is read whole the first time it is heard of, and sends nothing", async () => {
		mocks.hubFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					transfer_id: T1,
					channel_id: C1,
					host_id: HOST,
					dir: "/srv",
					state: "running",
					totals: { files: 1, bytes: 5, acked: 0, states: { sending: 1 } },
					items: [
						{ item_id: 0, rel_path: "x.bin", kind: "file", size: 5, state: "sending", acked: 0 },
					],
				}),
				{ status: 200 },
			),
		);
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [{ itemId: 0, state: "sending", acked: 0 }],
			folders: [],
			totals: { files: 1, bytes: 5, acked: 0, states: { sending: 1 } },
		});
		await flush();
		expect(String(mocks.hubFetch.mock.calls[0]?.[0])).toMatch(new RegExp(`/api/transfers/${T1}$`));
		expect(transfers().uploads[0]).toMatchObject({ id: T1, label: "x.bin", sender: false });
		expect(puts).toHaveLength(0);
		// Not this window's: nothing to ask before leaving, nothing for the desktop shell.
		expect(transfers().report.inProgress).toBe(0);
	});
});

// ─── After a crash or a restart (#837) ───────────────────────────────────────

describe("resuming after a crash or a restart", () => {
	const T2 = "01ARZ3NDEKTSV4RRFFQ69G5FT2";
	const WHEN = 1_700_000_000_000;

	function domError(name: string): Error {
		return Object.assign(new Error(name), { name });
	}

	function keptFile(name: string, size: number, lastModified = WHEN): File {
		return new File([new Uint8Array(size)], name, { lastModified });
	}

	/** The kept folder `photos`, as IndexedDB gives it back, its access answered by `access`. */
	function photosHandle(files: Record<string, File>, access: () => Promise<string>) {
		const requestPermission = vi.fn(access);
		const queryPermission = vi.fn(async () => "prompt");
		const handle = {
			kind: "directory",
			name: "photos",
			requestPermission,
			queryPermission,
			getDirectoryHandle: async () => {
				throw domError("NotFoundError");
			},
			getFileHandle: async (name: string) => {
				const found = files[name];
				if (found === undefined) throw domError("NotFoundError");
				return { kind: "file", name, getFile: async () => found };
			},
		};
		return { handle, requestPermission, queryPermission };
	}

	/** What IndexedDB kept of an upload of photos/ (a.jpg, b.jpg, c.jpg, 10 bytes each). */
	function keep(transferId: string, handle: unknown): void {
		handles.uploads.set(transferId, {
			transferId,
			hostId: HOST,
			channelId: C1,
			dir: "/home/pi",
			savedAt: WHEN,
			roots: [{ name: "photos", kind: "directory", handle }],
		});
		handles.items.set(
			transferId,
			["a.jpg", "b.jpg", "c.jpg"].map((name, i) => ({
				transferId,
				itemId: i + 1,
				relPath: `photos/${name}`,
				root: 0,
				pathInRoot: name,
				size: 10,
				lastModified: WHEN,
			})),
		);
	}

	/** The upload as the hub describes it after its restart: a.jpg placed, b.jpg half there. */
	function described(transferId: string, extra: Record<string, unknown> = {}) {
		return {
			transfer_id: transferId,
			channel_id: C1,
			host_id: HOST,
			dir: "/home/pi",
			state: "interrupted",
			updated_at: "2026-11-05T09:00:00.000Z",
			from_this_device: true,
			totals: { files: 3, bytes: 30, acked: 15, states: { placed: 1, interrupted: 2 } },
			items: [
				{ item_id: 0, rel_path: "photos", kind: "dir", size: null, state: "placed" },
				{
					item_id: 1,
					rel_path: "photos/a.jpg",
					kind: "file",
					size: 10,
					state: "placed",
					acked: 10,
				},
				{
					item_id: 2,
					rel_path: "photos/b.jpg",
					kind: "file",
					size: 10,
					state: "interrupted",
					acked: 5,
				},
				{
					item_id: 3,
					rel_path: "photos/c.jpg",
					kind: "file",
					size: 10,
					state: "interrupted",
					acked: 0,
				},
			],
			...extra,
		};
	}

	/** The hub: each upload described as given, and listed. */
	function hubHolds(...bodies: ReturnType<typeof described>[]): void {
		mocks.hubFetch.mockImplementation(async (url: unknown) => {
			const path = String(url);
			const one = /\/api\/transfers\/([0-9A-Z]+)$/.exec(path);
			if (one !== null) {
				const body = bodies.find((b) => b.transfer_id === one[1]);
				return body === undefined
					? new Response("{}", { status: 404 })
					: new Response(JSON.stringify(body));
			}
			return new Response(JSON.stringify({ transfers: bodies }));
		});
	}

	/** STATE_SYNC as a window hears it at its start, listing the interrupted uploads. */
	async function started(...entries: { id: string; fromThisDevice?: boolean; label?: string }[]) {
		socket.hear({
			type: "STATE_SYNC",
			sessions: [],
			channels: [],
			transfers: entries.map((entry) => ({
				transferId: entry.id,
				channelId: C1,
				hostId: HOST,
				dir: "/home/pi",
				state: "interrupted",
				totals: { files: 3, bytes: 30, acked: 15, states: { placed: 1, interrupted: 2 } },
				updatedAt: "2026-11-05T09:00:00.000Z",
				fromThisDevice: entry.fromThisDevice ?? true,
				...(entry.label !== undefined ? { deviceLabel: entry.label } : {}),
			})),
		});
		await flush();
	}

	const resumes = () => socket.sent.filter((msg) => msg.type === "TRANSFER_RESUME");

	beforeEach(() => {
		useConfigStore().uiConfig = {
			onChannelDead: "readonly",
			transfer: { maxConcurrent: 2 },
			experimental: { fileTransfer: true },
		};
	});

	it("lists what the hub reports interrupted, reads its handles, says so once, and resumes nothing by itself", async () => {
		const photos = photosHandle({}, async () => "granted");
		keep(T1, photos.handle);
		hubHolds(described(T1));
		const show = vi.spyOn(useToastStore(), "show");
		await started({ id: T1 });
		expect(transfers().interrupted).toEqual([
			expect.objectContaining({
				id: T1,
				label: "photos/",
				state: "interrupted",
				fromThisDevice: true,
				kept: "kept",
				resume: null,
			}),
		]);
		expect(show.mock.calls.map((call) => call[1])).toEqual([
			"1 upload was interrupted: resume it in Transfers",
		]);
		await started({ id: T1 });
		expect(show).toHaveBeenCalledTimes(1);
		expect(resumes()).toEqual([]);
		expect(photos.requestPermission).not.toHaveBeenCalled();
	});

	it("asks access inside the click, never from queryPermission, and sends only what is not placed, from the hub's offsets", async () => {
		const photos = photosHandle(
			{
				"a.jpg": keptFile("a.jpg", 10),
				"b.jpg": keptFile("b.jpg", 10),
				"c.jpg": keptFile("c.jpg", 10),
			},
			async () => "granted",
		);
		keep(T1, photos.handle);
		hubHolds(described(T1));
		await started({ id: T1 });

		transfers().resumeUploads([T1]);
		// Asked before the click's handler returns: its activation is what lets it through.
		expect(photos.requestPermission).toHaveBeenCalledWith({ mode: "read" });
		expect(photos.queryPermission).not.toHaveBeenCalled();
		expect(transfers().interrupted[0]?.resume).toEqual({ phase: "asking" });
		await flush();
		expect(resumes()).toEqual([{ type: "TRANSFER_RESUME", transferIds: [T1] }]);
		expect(transfers().interrupted[0]).toMatchObject({
			sender: true,
			resume: { phase: "resuming" },
		});

		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [
				{ itemId: 2, state: "sending", acked: 5 },
				{ itemId: 3, state: "sending", acked: 0 },
			],
			folders: [],
			totals: { files: 3, bytes: 30, acked: 15, states: { placed: 1, sending: 2 } },
		});
		socket.hear({
			type: "TRANSFER_STATE",
			transferId: T1,
			channelId: C1,
			hostId: HOST,
			state: "running",
		});
		await flush();
		expect(puts.map((p) => [p.transferId, p.itemId, p.offset, p.size])).toEqual([
			[T1, 2, 5, 5],
			[T1, 3, 0, 10],
		]);
		// Running again, it leaves the interrupted ones for its group.
		expect(transfers().interrupted).toEqual([]);
		expect(transfers().uploads[0]).toMatchObject({ id: T1, state: "running", resume: null });
		expect(transfers().report.inProgress).toBe(1);
	});

	it("asks about a file changed since it was sent, leaves out one gone, and sends the changed one again from the start if asked", async () => {
		const grown = keptFile("b.jpg", 12, WHEN + 5_000);
		const photos = photosHandle(
			{ "a.jpg": keptFile("a.jpg", 10), "b.jpg": grown },
			async () => "granted",
		);
		keep(T1, photos.handle);
		hubHolds(described(T1));
		await started({ id: T1 });

		transfers().resumeUploads([T1]);
		await flush();
		// Nothing goes before its answer.
		expect(resumes()).toEqual([]);
		expect(transfers().interrupted[0]?.resume).toEqual({
			phase: "changed",
			files: [
				{
					itemId: 2,
					relPath: "photos/b.jpg",
					was: { size: 10, lastModified: WHEN },
					now: { size: 12, lastModified: WHEN + 5_000 },
					answer: null,
				},
			],
			gone: 1,
			unreadable: 0,
		});

		transfers().answerChanged(T1, 2, "restart");
		expect(resumes()).toEqual([
			{
				type: "TRANSFER_RESUME",
				transferIds: [T1],
				files: [
					{ transferId: T1, itemId: 3, action: "skip", why: "gone" },
					{ transferId: T1, itemId: 2, action: "restart", size: 12, mtime: WHEN + 5_000 },
				],
			},
		]);
		expect(transfers().interrupted[0]?.items.find((item) => item.itemId === 2)).toMatchObject({
			size: 12,
			acked: 0,
		});
		expect(transfers().interrupted[0]?.leftOut).toEqual({ gone: 1, unreadable: 0 });
		socket.hear({
			type: "TRANSFER_PROGRESS",
			transferId: T1,
			channelId: C1,
			items: [{ itemId: 2, state: "sending", acked: 0 }],
			folders: [],
			totals: { files: 3, bytes: 32, acked: 10, states: { placed: 1, sending: 1, skipped: 1 } },
		});
		await flush();
		expect(puts.map((p) => [p.itemId, p.offset, p.size])).toEqual([[2, 0, 12]]);
	});

	it("leaves a changed file out when told to skip it", async () => {
		const photos = photosHandle(
			{
				"a.jpg": keptFile("a.jpg", 10),
				"b.jpg": keptFile("b.jpg", 10, WHEN + 1),
				"c.jpg": keptFile("c.jpg", 9),
			},
			async () => "granted",
		);
		keep(T1, photos.handle);
		hubHolds(described(T1));
		await started({ id: T1 });
		transfers().resumeUploads([T1]);
		await flush();
		expect(resumes()).toEqual([]);
		transfers().answerChanged(T1, "all", "skip");
		expect(resumes()[0]).toEqual({
			type: "TRANSFER_RESUME",
			transferIds: [T1],
			files: [
				{ transferId: T1, itemId: 2, action: "skip", why: "changed" },
				{ transferId: T1, itemId: 3, action: "skip", why: "changed" },
			],
		});
	});

	it("falls back to a drop, without hanging, when access is refused or never answered", async () => {
		const refused = photosHandle({}, async () => {
			throw domError("NotAllowedError");
		});
		keep(T1, refused.handle);
		const silent = photosHandle({}, () => new Promise<string>(() => undefined));
		keep(T2, silent.handle);
		hubHolds(described(T1), described(T2));
		await started({ id: T1 }, { id: T2 });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			transfers().resumeUploads([T1, T2]);
			await vi.advanceTimersByTimeAsync(14_000);
			expect(transfers().interrupted.map((u) => u.resume)).toEqual([
				{ phase: "redrop", why: "denied" },
				{ phase: "asking" },
			]);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(transfers().interrupted.map((u) => u.resume)).toEqual([
				{ phase: "redrop", why: "denied" },
				{ phase: "redrop", why: "timeout" },
			]);
		} finally {
			vi.useRealTimers();
		}
		expect(resumes()).toEqual([]);
	});

	it("keeps it interrupted, saying why, when the host's passphrase is cancelled; Resume asks again", async () => {
		const photos = photosHandle(
			{
				"a.jpg": keptFile("a.jpg", 10),
				"b.jpg": keptFile("b.jpg", 10),
				"c.jpg": keptFile("c.jpg", 10),
			},
			async () => "granted",
		);
		keep(T1, photos.handle);
		hubHolds(described(T1));
		await started({ id: T1 });
		transfers().resumeUploads([T1]);
		await flush();
		expect(resumes()).toHaveLength(1);
		socket.hear({
			type: "TRANSFER_STATE",
			transferId: T1,
			channelId: C1,
			hostId: HOST,
			state: "interrupted",
			reason: "needs_passphrase",
		});
		expect(transfers().interrupted[0]).toMatchObject({
			id: T1,
			reason: "needs_passphrase",
			sender: false,
			resume: null,
		});
		transfers().resumeUploads([T1]);
		await flush();
		expect(resumes()).toHaveLength(2);
		expect(photos.requestPermission).toHaveBeenCalledTimes(2);
	});

	it("resumes all in one request, so that the hub asks one host at a time", async () => {
		const files = { "b.jpg": keptFile("b.jpg", 10), "c.jpg": keptFile("c.jpg", 10) };
		keep(T1, photosHandle(files, async () => "granted").handle);
		keep(T2, photosHandle(files, async () => "granted").handle);
		hubHolds(described(T1), described(T2));
		await started({ id: T1 }, { id: T2 });
		transfers().resumeUploads([T1, T2]);
		await flush();
		expect(resumes()).toEqual([{ type: "TRANSFER_RESUME", transferIds: [T1, T2] }]);
	});

	it("does not resume another device's upload, nor one whose files were not kept", async () => {
		hubHolds(
			described(T1),
			described(T2, { from_this_device: false, device_label: "Paired from 10.0.0.2" }),
		);
		const load = vi.spyOn(handles.store, "load");
		await started({ id: T1 }, { id: T2, fromThisDevice: false, label: "Paired from 10.0.0.2" });
		expect(transfers().interrupted).toEqual([
			expect.objectContaining({ id: T1, fromThisDevice: true, kept: "none" }),
			expect.objectContaining({
				id: T2,
				fromThisDevice: false,
				deviceLabel: "Paired from 10.0.0.2",
				kept: "none",
			}),
		]);
		// Only this device holds its files: nothing of the other's is looked for.
		expect(load.mock.calls.map((call) => call[0])).toEqual([T1]);
		transfers().resumeUploads([T1, T2]);
		await flush();
		expect(resumes()).toEqual([]);
		expect(transfers().interrupted.map((u) => u.resume)).toEqual([
			{ phase: "redrop", why: "unsupported" },
			null,
		]);
	});

	it("keeps them on Not now, and Discard lets the handles go once the hub says it discarded them", async () => {
		keep(T1, photosHandle({}, async () => "granted").handle);
		hubHolds(described(T1));
		await started({ id: T1 });
		transfers().notNow();
		expect(transfers().interruptedFolded).toBe(true);
		// Not over: Clear finished keeps it too.
		transfers().dismissFinished();
		expect(transfers().interrupted).toHaveLength(1);
		expect(handles.uploads.has(T1)).toBe(true);

		transfers().discardUploads([T1]);
		expect(socket.sent.filter((msg) => msg.type === "TRANSFER_DISCARD")).toEqual([
			{ type: "TRANSFER_DISCARD", transferIds: [T1] },
		]);
		expect(transfers().interrupted[0]?.resume).toEqual({ phase: "discarding" });
		socket.hear({
			type: "TRANSFER_STATE",
			transferId: T1,
			channelId: C1,
			hostId: HOST,
			state: "discarded",
		});
		await flush();
		expect(transfers().interrupted).toEqual([]);
		expect(handles.uploads.has(T1)).toBe(false);
	});

	it("offers a resume again once a connection lost while it was asked for is back", async () => {
		const photos = photosHandle(
			{ "b.jpg": keptFile("b.jpg", 10), "c.jpg": keptFile("c.jpg", 10) },
			async () => "granted",
		);
		keep(T1, photos.handle);
		hubHolds(described(T1));
		await started({ id: T1 });
		transfers().resumeUploads([T1]);
		await flush();
		expect(transfers().interrupted[0]?.resume).toMatchObject({ phase: "resuming" });
		socket.drop();
		transfers().rejoin();
		await started({ id: T1 });
		expect(transfers().interrupted[0]).toMatchObject({ sender: false, resume: null });
		transfers().resumeUploads([T1]);
		await flush();
		expect(resumes()).toHaveLength(2);
	});

	it("lets go of handles the hub no longer lists once they are 7 days old, and of no other", async () => {
		const old = WHEN - 8 * 24 * 60 * 60_000;
		vi.spyOn(Date, "now").mockReturnValue(WHEN);
		for (const [id, savedAt] of [
			[T1, old],
			[T2, old],
			["01ARZ3NDEKTSV4RRFFQ69G5FT3", WHEN - 60_000],
		] as const) {
			keep(id, null);
			handles.uploads.set(id, { ...(handles.uploads.get(id) as KeptUpload), savedAt });
		}
		// The hub still holds T1; T2 and the young one it no longer lists.
		hubHolds(described(T1));
		await started({ id: T1 });
		expect([...handles.uploads.keys()].sort()).toEqual([T1, "01ARZ3NDEKTSV4RRFFQ69G5FT3"].sort());
	});
});
