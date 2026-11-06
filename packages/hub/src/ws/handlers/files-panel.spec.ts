/**
 * The writer's files panel, as the hub keeps it per terminal (#838): only the write lock's holder
 * says it, every client attached hears it, and a client attaching or connecting reads it in
 * ATTACH_OK and STATE_SYNC. The session manager and the write lock are the real ones, wired as
 * the WS route wires them; only the agent is a stand-in.
 */
import type { FilesPanelMessage, ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type WsClient } from "../../session/session-manager.js";
import { WriteLockManager } from "../../session/write-lock.js";
import { openTestDatabases } from "../../storage/db.js";
import { handleFilesPanel } from "./files-panel.js";
import type { WsHandlerContext } from "./types.js";

vi.mock("../../session/agent-launcher.js", async () => {
	const { EventEmitter } = await import("node:events");
	const { generateId } = await import("@lasterm/shared");
	class MockLocalAgent extends EventEmitter {
		connected = true;
		start = vi.fn().mockResolvedValue(undefined);
		waitForChannelState = vi.fn(() => Promise.resolve([]));
		close = vi.fn(() => {
			this.connected = false;
		});
		send = vi.fn((msg: Record<string, unknown>) => {
			if (msg.type === "SPAWN") {
				const channelId = (msg.channelId as string | undefined) ?? generateId();
				setImmediate(() =>
					this.emit("message", { type: "SPAWN_OK", requestId: msg.requestId, channelId }),
				);
			} else if (msg.type === "ATTACH") {
				setImmediate(() =>
					this.emit("message", {
						type: "ATTACH_OK",
						channelId: msg.channelId,
						requestId: msg.requestId,
						snapshot: { serialized: "", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
						lastSeq: 0,
					}),
				);
			}
		});
	}
	return {
		connectOrLaunch: vi.fn().mockImplementation(() => Promise.resolve(new MockLocalAgent())),
		resolveAgentPath: () => "/mock/agent/path",
		isAgentBinary: () => true,
	};
});

const WRITER = "01ARZ3NDEKTSV4RRFFQ69G5WRT";
const READER = "01ARZ3NDEKTSV4RRFFQ69G5RDR";
const LATE = "01ARZ3NDEKTSV4RRFFQ69G5LAT";

describe("the writer's files panel, kept by the hub (#838)", () => {
	let dbManager: ReturnType<typeof openTestDatabases>;
	let sm: SessionManager;
	let locks: WriteLockManager;
	const received = new Map<string, ProtocolMessage[]>();
	const sockets = new Map<string, WsClient>();

	function client(id: string): WsClient {
		const inbox: ProtocolMessage[] = [];
		received.set(id, inbox);
		const ws: WsClient = { id, send: (msg) => inbox.push(msg), attachedChannels: new Set() };
		sockets.set(id, ws);
		sm.addClient(ws);
		return ws;
	}

	/** What `id` heard of the writer's panel. */
	function heard(id: string): ProtocolMessage[] {
		return (received.get(id) ?? []).filter(
			(msg) => msg.type === "FILES_PANEL" || (msg.type === "ERROR" && msg.code !== "INVALID_INPUT"),
		);
	}

	function forget(): void {
		for (const inbox of received.values()) inbox.length = 0;
	}

	/** A FILES_PANEL from `id`, as the WS route hands it over. */
	function say(id: string, channelId: string, open: boolean): void {
		const ws = sockets.get(id);
		if (ws === undefined) throw new Error(`no client ${id}`);
		const msg: FilesPanelMessage = { type: "FILES_PANEL", channelId, open };
		handleFilesPanel(msg, {
			clientId: id,
			tokenId: null,
			client: ws,
			log: {} as never,
			sessionManager: sm,
			writeLockManager: locks,
		} as WsHandlerContext);
	}

	/** A terminal the writer starts, with the lock it gets for being first. */
	async function terminal(): Promise<string> {
		const channelId = await sm.handleSpawn(WRITER, { type: "SPAWN", hostId: "local" });
		if (channelId === null) throw new Error("expected a channel");
		await new Promise((resolve) => setImmediate(resolve));
		locks.attach(channelId, WRITER);
		return channelId;
	}

	async function attach(id: string, channelId: string): Promise<ProtocolMessage | undefined> {
		expect(await sm.handleAttach(id, channelId)).toBe(true);
		locks.attach(channelId, id);
		return received
			.get(id)
			?.filter((msg) => msg.type === "ATTACH_OK" && msg.channelId === channelId)
			.at(-1);
	}

	function stateSyncEntry(channelId: string) {
		return sm.getStateSnapshot().channels.find((entry) => entry.channelId === channelId);
	}

	beforeEach(() => {
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		received.clear();
		sockets.clear();
		locks = new WriteLockManager({
			sendToClient: (id, msg) => sockets.get(id)?.send(msg as ProtocolMessage),
			broadcastToChannel: (channelId, msg) => {
				for (const ws of sm.getClientsForChannel(channelId)) ws.send(msg as ProtocolMessage);
			},
		});
		sm.setGetWriteLockHolder((channelId) => locks.getHolder(channelId));
		client(WRITER);
		client(READER);
		client(LATE);
	});

	afterEach(async () => {
		locks.shutdown();
		await sm.shutdown();
		dbManager.close();
	});

	it("takes it from the write lock's holder only, refusing a reader as its INPUT is", async () => {
		const a = await terminal();
		await attach(READER, a);
		forget();

		say(READER, a, true);

		expect(heard(READER)).toEqual([
			expect.objectContaining({ type: "ERROR", code: "WRITE_LOCK_DENIED", channelId: a }),
		]);
		expect(heard(WRITER)).toEqual([]);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: false });

		say(WRITER, a, true);

		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: true });
	});

	it("tells every client attached, the writer included, and gives it in ATTACH_OK and STATE_SYNC", async () => {
		const a = await terminal();
		const before = await attach(READER, a);
		expect(before).toMatchObject({ type: "ATTACH_OK", filesPanel: { open: false } });
		expect(stateSyncEntry(a)).toMatchObject({ filesPanel: { open: false } });
		forget();

		say(WRITER, a, true);

		const opened = { type: "FILES_PANEL", channelId: a, open: true };
		expect(heard(WRITER)).toEqual([opened]);
		expect(heard(READER)).toEqual([opened]);
		// Not attached: it reads it when it attaches, or connects.
		expect(heard(LATE)).toEqual([]);
		expect(await attach(LATE, a)).toMatchObject({ filesPanel: { open: true } });
		expect(stateSyncEntry(a)).toMatchObject({ filesPanel: { open: true } });

		// Said again, nothing changed: nobody is told.
		forget();
		say(WRITER, a, true);
		expect(heard(READER)).toEqual([]);

		say(WRITER, a, false);
		expect(heard(READER)).toEqual([{ type: "FILES_PANEL", channelId: a, open: false }]);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: false });
	});

	it("closes it on A as it opens on B, when the writer's panel moves from one to the other", async () => {
		const a = await terminal();
		const b = await terminal();
		await attach(READER, a);
		await attach(LATE, b);
		say(WRITER, a, true);
		forget();

		// The window says only where it is now: one panel, on one terminal.
		say(WRITER, b, true);

		expect(heard(READER)).toEqual([{ type: "FILES_PANEL", channelId: a, open: false }]);
		expect(heard(LATE)).toEqual([{ type: "FILES_PANEL", channelId: b, open: true }]);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: false });
		expect(stateSyncEntry(b)?.filesPanel).toEqual({ open: true });
	});

	it("leaves a terminal another client writes alone when the writer's panel opens elsewhere", async () => {
		const a = await terminal();
		const b = await terminal();
		await attach(READER, a);
		say(WRITER, a, true);
		locks.grant(a, WRITER, READER);
		forget();

		say(WRITER, b, true);

		expect(heard(READER)).toEqual([]);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: true });
	});

	it("follows the lock: the last state stands while nobody holds it, and the new writer's wins", async () => {
		const a = await terminal();
		await attach(READER, a);
		say(WRITER, a, true);

		// Released: nobody may say it, and it stays as the writer left it.
		locks.release(a, WRITER);
		forget();
		say(WRITER, a, false);
		say(READER, a, false);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: true });
		expect(heard(READER)).toEqual([
			expect.objectContaining({ type: "ERROR", code: "WRITE_LOCK_DENIED" }),
		]);

		// The reader takes the lock and says its own; the former writer is refused.
		locks.claim(a, READER);
		forget();
		say(READER, a, false);
		say(WRITER, a, true);
		expect(heard(WRITER)).toEqual([
			{ type: "FILES_PANEL", channelId: a, open: false },
			expect.objectContaining({ type: "ERROR", code: "WRITE_LOCK_DENIED" }),
		]);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: false });

		// Forced back: the writer's own state wins again.
		locks.force(a, WRITER);
		say(WRITER, a, true);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: true });
	});

	it("refuses what is not a terminal's id or an open state", async () => {
		const a = await terminal();
		const ws = sockets.get(WRITER) as WsClient;
		const ctx = {
			clientId: WRITER,
			client: ws,
			sessionManager: sm,
			writeLockManager: locks,
		} as unknown as WsHandlerContext;
		forget();

		handleFilesPanel({ type: "FILES_PANEL", channelId: "nope", open: true }, ctx);
		handleFilesPanel(
			{ type: "FILES_PANEL", channelId: a, open: "yes" } as unknown as FilesPanelMessage,
			ctx,
		);

		expect(received.get(WRITER)).toEqual([
			{ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" },
			{ type: "ERROR", code: "INVALID_INPUT", message: "Invalid open" },
		]);
		expect(stateSyncEntry(a)?.filesPanel).toEqual({ open: false });
	});
});
