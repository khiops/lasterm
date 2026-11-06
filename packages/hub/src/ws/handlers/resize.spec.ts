/**
 * One client decides a terminal's size: the one holding its write lock
 * (#831). The write lock is the real one; only the session manager, which
 * applies the size, is a stand-in.
 */
import type { ResizeMessage } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { WriteLockManager } from "../../session/write-lock.js";
import { handleResize } from "./resize.js";
import type { WsHandlerContext } from "./types.js";

const CHANNEL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function terminalWithTwoClients() {
	const writeLockManager = new WriteLockManager({
		sendToClient: () => undefined,
		broadcastToChannel: () => undefined,
	});
	const sessionManager = { handleResize: vi.fn() };
	const sent = new Map<string, ReturnType<typeof vi.fn>>();

	/** A RESIZE from `clientId`, as the WS route hands it over. */
	function resize(clientId: string, cols: number, rows: number): void {
		const send = sent.get(clientId) ?? vi.fn();
		sent.set(clientId, send);
		const msg: ResizeMessage = { type: "RESIZE", channelId: CHANNEL, cols, rows };
		handleResize(msg, {
			clientId,
			client: { id: clientId, send, attachedChannels: new Set([CHANNEL]) },
			log: {} as never,
			sessionManager,
			writeLockManager,
		} as unknown as WsHandlerContext);
	}

	/** The sizes that reached the session manager, with who asked. */
	function applied(): Array<[string, number, number]> {
		return sessionManager.handleResize.mock.calls.map(([clientId, , cols, rows]) => [
			clientId as string,
			cols as number,
			rows as number,
		]);
	}

	// The first client to attach holds the lock; the second reads.
	writeLockManager.attach(CHANNEL, "writer");
	writeLockManager.attach(CHANNEL, "reader");
	return { writeLockManager, resize, applied, answers: (id: string) => sent.get(id)?.mock.calls };
}

describe("RESIZE: the write lock's holder decides the size (#831)", () => {
	it("applies the holder's", () => {
		const { resize, applied } = terminalWithTwoClients();

		resize("writer", 120, 40);

		expect(applied()).toEqual([["writer", 120, 40]]);
	});

	it("drops a reader's, without an answer: its pane resizing is normal", () => {
		const { resize, applied, answers } = terminalWithTwoClients();

		resize("reader", 90, 20);

		expect(applied()).toEqual([]);
		expect(answers("reader")).toEqual([]);
	});

	it("follows the lock when it changes hands, granted or forced", () => {
		const { writeLockManager, resize, applied } = terminalWithTwoClients();

		writeLockManager.grant(CHANNEL, "writer", "reader");
		resize("writer", 120, 40);
		resize("reader", 90, 20);

		writeLockManager.force(CHANNEL, "writer");
		resize("reader", 91, 21);
		resize("writer", 121, 41);

		expect(applied()).toEqual([
			["reader", 90, 20],
			["writer", 121, 41],
		]);
	});

	it("applies nobody's while nobody holds the lock, then the next holder's", () => {
		const { writeLockManager, resize, applied } = terminalWithTwoClients();

		writeLockManager.release(CHANNEL, "writer");
		resize("writer", 120, 40);
		resize("reader", 90, 20);
		expect(applied()).toEqual([]);

		writeLockManager.claim(CHANNEL, "reader");
		resize("reader", 90, 20);
		expect(applied()).toEqual([["reader", 90, 20]]);
	});

	it("still refuses a size out of bounds, from anyone", () => {
		const { resize, applied, answers } = terminalWithTwoClients();

		resize("reader", 0, 20);

		expect(applied()).toEqual([]);
		expect(answers("reader")).toEqual([
			[{ type: "ERROR", code: "INVALID_INPUT", message: "Invalid dimensions" }],
		]);
	});
});
