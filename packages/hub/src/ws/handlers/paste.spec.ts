/**
 * Only a terminal's write-lock holder pastes into it (#1014), and only chunks
 * whose fields the protocol allows. The write lock is the real one; only the
 * session manager, which relays the paste, is a stand-in. No INPUT handler
 * spec exists to extend; this one follows `resize.spec.ts`.
 */
import type { PasteMessage } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { WriteLockManager } from "../../session/write-lock.js";
import { handlePaste } from "./paste.js";
import type { WsHandlerContext } from "./types.js";

const CHANNEL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function terminalWithTwoClients() {
	const writeLockManager = new WriteLockManager({
		sendToClient: () => undefined,
		broadcastToChannel: () => undefined,
	});
	const sessionManager = { handlePaste: vi.fn(), handlePasteCancel: vi.fn() };
	const sent = new Map<string, ReturnType<typeof vi.fn>>();

	/** A PASTE from `clientId`, as the WS route hands it over. */
	function paste(clientId: string, fields: Partial<PasteMessage> = {}): void {
		const send = sent.get(clientId) ?? vi.fn();
		sent.set(clientId, send);
		const msg: PasteMessage = {
			type: "PASTE",
			channelId: CHANNEL,
			pasteId: 1,
			seq: 0,
			data: new Uint8Array([0x61]),
			last: true,
			...fields,
		};
		handlePaste(msg, {
			clientId,
			client: { id: clientId, send, attachedChannels: new Set([CHANNEL]) },
			log: {} as never,
			sessionManager,
			writeLockManager,
		} as unknown as WsHandlerContext);
	}

	writeLockManager.attach(CHANNEL, "writer");
	writeLockManager.attach(CHANNEL, "reader");
	return {
		writeLockManager,
		paste,
		relayed: () => sessionManager.handlePaste.mock.calls.map(([clientId]) => clientId as string),
		answers: (id: string) =>
			(sent.get(id)?.mock.calls ?? []).map(([msg]) => msg as { type: string; code?: string }),
	};
}

describe("PASTE: only the write lock's holder pastes (#1014)", () => {
	it("relays the holder's", () => {
		const { paste, relayed, answers } = terminalWithTwoClients();

		paste("writer");

		expect(relayed()).toEqual(["writer"]);
		expect(answers("writer")).toEqual([]);
	});

	it("refuses another client's with WRITE_LOCK_DENIED", () => {
		const { paste, relayed, answers } = terminalWithTwoClients();

		paste("reader");

		expect(relayed()).toEqual([]);
		expect(answers("reader")).toEqual([expect.objectContaining({ code: "WRITE_LOCK_DENIED" })]);
	});

	it("refuses a paste while nobody holds the lock, which INPUT would let through", () => {
		const { writeLockManager, paste, relayed, answers } = terminalWithTwoClients();
		writeLockManager.release(CHANNEL, "writer");
		expect(writeLockManager.isWriteLockHolder(CHANNEL, "reader")).toBe(true);

		paste("reader");

		expect(relayed()).toEqual([]);
		expect(answers("reader")).toEqual([expect.objectContaining({ code: "WRITE_LOCK_DENIED" })]);
	});

	for (const [label, fields] of [
		["data over 65 536 bytes", { data: new Uint8Array(65_537) }],
		["a negative seq", { seq: -1 }],
		["a seq past a u32", { seq: 2 ** 32 }],
		["a fractional paste id", { pasteId: 1.5 }],
		["a last that is not a boolean", { last: 1 as unknown as boolean }],
	] as const) {
		it(`refuses ${label} with INVALID_INPUT`, () => {
			const { paste, relayed, answers } = terminalWithTwoClients();

			paste("writer", fields);

			expect(relayed()).toEqual([]);
			expect(answers("writer")).toEqual([expect.objectContaining({ code: "INVALID_INPUT" })]);
		});
	}
});
