/**
 * A pane's xterm, the real one, in a browser (#1012): the state an ATTACH_OK
 * restores and how a paste goes out, which a stand-in xterm cannot show. The
 * other specs mock xterm module-wide, so this one drives `useTerminal` itself,
 * with a hub the test speaks for.
 */
import type { ProtocolMessage, SnapshotData, UiAttachOkMessage } from "@lasterm/shared";
import "@xterm/xterm/css/xterm.css";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useTerminal } from "./useTerminal.js";

const T = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const ESC = "\u001b";
const START = `${ESC}[200~`;
const END = `${ESC}[201~`;
/** What vt100's `contents_formatted` starts with. */
const CLEAR = `${ESC}[?25h${ESC}[m${ESC}[H${ESC}[J`;

let host: HTMLDivElement;
let pane: ReturnType<typeof useTerminal>;
let sent: ProtocolMessage[];
let hear: (msg: ProtocolMessage) => void;

beforeEach(() => {
	setActivePinia(createPinia());
	host = document.createElement("div");
	host.style.width = "640px";
	host.style.height = "320px";
	document.body.appendChild(host);
	sent = [];
	const listeners = new Map<string, Set<(msg: ProtocolMessage) => void>>();
	hear = (msg) => {
		for (const callback of [...(listeners.get(msg.type) ?? [])]) callback(msg);
	};
	const client = {
		isConnected: true,
		send: (msg: ProtocolMessage) => sent.push(msg),
		on(type: string, callback: (msg: ProtocolMessage) => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(callback);
			listeners.set(type, set);
			return () => set.delete(callback);
		},
		onReconnect: () => () => {},
		onDisconnect: () => () => {},
		connect: () => Promise.resolve(),
		close() {},
	};
	pane = useTerminal(ref(host), client as unknown as IWsClient);
	pane.init();
});

afterEach(() => {
	pane.dispose();
	host.remove();
});

const xterm = () => {
	const term = pane.terminal.value;
	if (term === null) throw new Error("no xterm");
	return term;
};
/** Let xterm parse all it was given. */
const parsed = () => new Promise<void>((resolve) => xterm().write("", resolve));
const row = (n: number) =>
	xterm()
		.buffer.active.getLine(xterm().buffer.active.baseY + n)
		?.translateToString(true) ?? "";
const inputs = () =>
	sent
		.filter((m) => m.type === "INPUT")
		.map((m) => new TextDecoder().decode((m as { data: Uint8Array }).data));
function print(text: string): void {
	hear({
		type: "OUTPUT",
		channelId: T,
		data: new TextEncoder().encode(text),
	} as unknown as ProtocolMessage);
}
function answer(
	over: Omit<Partial<UiAttachOkMessage>, "snapshot"> & { snapshot?: Partial<SnapshotData> },
): void {
	const { snapshot, ...rest } = over;
	hear({
		type: "ATTACH_OK",
		channelId: T,
		snapshot: {
			serialized: `${CLEAR}SNAP`,
			cols: 80,
			rows: 10,
			cursorX: 0,
			cursorY: 0,
			...snapshot,
		},
		tail: [],
		writeLockHolder: null,
		cached: false,
		...rest,
	} as unknown as ProtocolMessage);
}
/** The pane attaches T and the hub answers as given. */
async function attachedWith(over: Parameters<typeof answer>[0]): Promise<void> {
	const attached = pane.reattachChannel(T);
	answer(over);
	await attached;
	await parsed();
}
function paste(text: string): void {
	const data = new DataTransfer();
	data.setData("text/plain", text);
	xterm().textarea?.dispatchEvent(
		new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
	);
}

describe("the state an attach that replaces the screen restores (#1012)", () => {
	for (const cached of [false, true]) {
		it(`draws the screen in the alternate buffer and sets the input modes, ${cached ? "cached" : "live"}`, async () => {
			await attachedWith({
				cached,
				snapshot: { alternateScreen: true, inputModes: `${ESC}[?2004h${ESC}[?1h` },
			});

			expect(xterm().buffer.active.type).toBe("alternate");
			expect(row(0)).toBe("SNAP");
			expect(xterm().modes.bracketedPasteMode).toBe(true);
			expect(xterm().modes.applicationCursorKeysMode).toBe(true);
		});
	}

	it("stays in the normal buffer when the program is not in the alternate screen", async () => {
		await attachedWith({ snapshot: { alternateScreen: false, inputModes: "" } });

		expect(xterm().buffer.active.type).toBe("normal");
		expect(row(0)).toBe("SNAP");
	});

	it("lets a mode the tail sets win over the snapshot's", async () => {
		await attachedWith({
			cached: true,
			snapshot: { inputModes: `${ESC}[?2004h` },
			tail: [new TextEncoder().encode(`${ESC}[?2004l`)],
		});

		expect(xterm().modes.bracketedPasteMode).toBe(false);
	});
});

describe("an attach that keeps the screen (#1012)", () => {
	it("writes no state, and a sequence the live output was in the middle of is finished", async () => {
		await attachedWith({ snapshot: { inputModes: "" } });

		const kept = pane.reattachChannel(T, { preserveContent: true });
		print(`${ESC}[?100`);
		// xterm holds the start of the sequence when the answer comes.
		await parsed();
		answer({ snapshot: { alternateScreen: true, inputModes: `${ESC}[?1004l` } });
		await kept;
		print("4h");
		await parsed();

		expect(xterm().modes.sendFocusMode).toBe(true);
		expect(xterm().buffer.active.type).toBe("normal");
		expect(row(0)).toBe("SNAP");
	});
});

describe("no focus report from a replay (#1012)", () => {
	it("sends no report for the snapshot's ?1004h", async () => {
		await attachedWith({ snapshot: { inputModes: `${ESC}[?1004h` } });
		// The report alone is held back: xterm still takes the mode.
		expect(xterm().modes.sendFocusMode).toBe(true);
		print(`${ESC}[?1004l`);
		await parsed();

		expect(inputs()).toEqual([]);
	});

	it("sends no report for a replayed ?1004 given twice in one sequence", async () => {
		await attachedWith({ snapshot: { inputModes: `${ESC}[?1004;1004h` } });

		expect(inputs()).toEqual([]);
	});

	it("sends a focus change the user makes while a long replay is parsed", async () => {
		const attached = pane.reattachChannel(T);
		answer({
			snapshot: { serialized: `${CLEAR}${"x".repeat(2_000_000)}`, inputModes: `${ESC}[?1004h` },
			tail: [new TextEncoder().encode("y".repeat(2_000_000))],
		});
		await attached;
		const cursorLine = () =>
			xterm()
				.buffer.active.getLine(xterm().buffer.active.baseY + xterm().buffer.active.cursorY)
				?.translateToString(true) ?? "";
		// The focus change comes while the replay is still parsed: its tail is not drawn yet.
		let midReplay = false;
		setTimeout(() => {
			midReplay = !cursorLine().includes("y");
			xterm().input(`${ESC}[I`, true);
		}, 0);
		await parsed();

		expect(midReplay).toBe(true);
		expect(cursorLine()).toContain("y");
		expect(inputs()).toEqual([`${ESC}[I`]);
	});

	it("sends the report of a program's own ?1004h", async () => {
		await attachedWith({ snapshot: { inputModes: `${ESC}[?1004l` } });
		print(`${ESC}[?1004h`);
		await parsed();

		expect(inputs()).toHaveLength(1);
		expect([`${ESC}[I`, `${ESC}[O`]).toContain(inputs()[0]);
	});
});

describe("a paste through an agent that adapts input (#1012)", () => {
	it("goes to the bottom and clears the selection, as xterm's own paste does", async () => {
		await attachedWith({ adaptsInput: true, snapshot: { inputModes: "" } });
		print(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\r\n"));
		await parsed();
		xterm().scrollLines(-20);
		xterm().select(0, 0, 5);
		expect(xterm().buffer.active.viewportY).toBeLessThan(xterm().buffer.active.baseY);
		expect(xterm().hasSelection()).toBe(true);

		paste("x");

		expect(inputs()).toEqual([`${START}x${END}`]);
		expect(xterm().buffer.active.viewportY).toBe(xterm().buffer.active.baseY);
		expect(xterm().hasSelection()).toBe(false);
	});

	it("brackets the paste itself while xterm's own bracketed paste is on", async () => {
		await attachedWith({ adaptsInput: true, snapshot: { inputModes: `${ESC}[?2004h` } });
		expect(xterm().modes.bracketedPasteMode).toBe(true);

		paste(`a\nb${END}c${START}d`);

		expect(inputs()).toEqual([`${START}a\rbcd${END}`]);
	});

	it("sends a paste whose bracketed form is exactly the INPUT limit", async () => {
		await attachedWith({ adaptsInput: true, snapshot: { inputModes: "" } });

		paste("x".repeat(65_536 - START.length - END.length));

		expect(inputs()).toHaveLength(1);
		expect(new TextEncoder().encode(inputs()[0]).byteLength).toBe(65_536);
	});

	it("sends a Windows paste whose CRLF text is over the limit but whose bracketed form is not", async () => {
		await attachedWith({ adaptsInput: true, snapshot: { inputModes: "" } });

		// 65,536 units of text, a 49,164-byte bracketed form.
		paste("xx\r\n".repeat(16_384));

		expect(inputs()).toEqual([`${START}${"xx\r".repeat(16_384)}${END}`]);
	});
});

// The agent stores DEC line drawing as the characters xterm draws for it and
// ends `serialized` with the program's character sets (#1013). These check
// the pane's side of that: xterm, writing `serialized` before the tail, draws
// what follows it in those sets.
describe("the character sets a snapshot carries (#1013)", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);
	/** A border, then G1 designated DEC Special Graphics and shifted in. */
	const BORDER = `${CLEAR}┌──┐${ESC})0\u000e`;

	for (const cached of [false, true]) {
		it(`draws the tail and live output in the program's sets, ${cached ? "cached" : "live"}`, async () => {
			await attachedWith({ cached, snapshot: { serialized: BORDER }, tail: [bytes("q\u000fq")] });

			expect(row(0)).toBe("┌──┐─q");
			print("\u000eq");
			await parsed();
			expect(row(0)).toBe("┌──┐─q─");
		});
	}

	it("restores the normal screen's set when the program leaves the alternate screen", async () => {
		await attachedWith({
			snapshot: { serialized: `${CLEAR}┌──┐${ESC}(0`, alternateScreen: true },
			tail: [bytes("q")],
		});
		// xterm clears the alternate screen when it leaves it: read it first.
		expect(xterm().buffer.active.type).toBe("alternate");
		expect(row(0)).toBe("┌──┐─");

		print(`${ESC}[?1049lq`);
		await parsed();
		expect(xterm().buffer.active.type).toBe("normal");
		expect(row(0)).toBe("q");
	});

	it("draws an ended terminal's tail in its sets", async () => {
		const ended = pane.reattachChannel(T).catch((error: unknown) => error);
		hear({
			type: "ERROR",
			code: "CHANNEL_DEAD",
			message: "This terminal has ended.",
			channelId: T,
			lastOutput: {
				snapshot: { serialized: BORDER, cols: 80, rows: 10, cursorX: 0, cursorY: 0 },
				tail: [bytes("q\u000fq")],
				cols: 80,
				rows: 10,
			},
		} as unknown as ProtocolMessage);
		await ended;
		await parsed();

		expect(row(0)).toBe("┌──┐─q");
	});
});
