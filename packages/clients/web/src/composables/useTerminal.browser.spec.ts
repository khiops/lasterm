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
import { useToastStore } from "../stores/toast.js";
import { PasteStream } from "./paste-stream.js";
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
/** The pane's resolved `pasteWarning` (#1015): unset is "auto". */
let warning: unknown;
let connected: boolean;

beforeEach(() => {
	setActivePinia(createPinia());
	host = document.createElement("div");
	host.style.width = "640px";
	host.style.height = "320px";
	document.body.appendChild(host);
	sent = [];
	warning = undefined;
	connected = true;
	const listeners = new Map<string, Set<(msg: ProtocolMessage) => void>>();
	hear = (msg) => {
		for (const callback of [...(listeners.get(msg.type) ?? [])]) callback(msg);
	};
	const client = {
		get isConnected() {
			return connected;
		},
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
	pane = useTerminal(ref(host), client as unknown as IWsClient, undefined, undefined, {
		pasteWarning: () => warning,
	});
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
		// The size is what this measures, not the card a paste of several lines gets (#1015).
		warning = "never";

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

// A paste of several lines its program would run one by one waits on a card
// (#1015). The decision follows the bracketed paste mode xterm last parsed.
describe("a paste of several lines asks first (#1015)", () => {
	const U = "01HZZZZZZZZZZZZZZZZZZZZZU1";
	const pastes = () => sent.filter((m) => m.type === "PASTE");
	const pasteBytes = () =>
		pastes().map((m) => new TextDecoder().decode((m as { data: Uint8Array }).data));
	const toasts = () => useToastStore().messages.map((t) => t.text);
	/** The paste event, as `paste()` sends it, returned so that a test can look at it. */
	function pasteEvent(text: string, data = new DataTransfer()): ClipboardEvent {
		data.setData("text/plain", text);
		const event = new ClipboardEvent("paste", {
			clipboardData: data,
			bubbles: true,
			cancelable: true,
		});
		xterm().textarea?.dispatchEvent(event);
		return event;
	}
	const OFF = { snapshot: { inputModes: "" } };
	const ON = { snapshot: { inputModes: `${ESC}[?2004h` } };

	it("holds a paste of two lines when the program has bracketed paste off", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		expect(pane.pendingPaste.value).toMatchObject({ lines: 2, bracketed: false });
		expect(inputs()).toEqual([]);
	});

	it("sends a paste of several lines at once when the program waits for Enter", async () => {
		await attachedWith({ adaptsInput: true, ...ON });
		paste("a\nb");
		expect(pane.pendingPaste.value).toBeNull();
		expect(inputs()).toEqual([`${START}a\rb${END}`]);
	});

	it("asks with always even when the program has bracketed paste on", async () => {
		warning = "always";
		await attachedWith({ adaptsInput: true, ...ON });
		paste("a\nb");
		expect(pane.pendingPaste.value).toMatchObject({ lines: 2, bracketed: true });
		expect(inputs()).toEqual([]);
	});

	it("never asks with never", async () => {
		warning = "never";
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		expect(pane.pendingPaste.value).toBeNull();
		expect(inputs()).toEqual([`${START}a\rb${END}`]);
	});

	it("takes a value it does not know for auto", async () => {
		warning = "sometimes";
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		expect(pane.pendingPaste.value).not.toBeNull();
	});

	for (const setting of ["auto", "always"]) {
		it(`sends one line ending in a line break at once, the break kept (${setting})`, async () => {
			warning = setting;
			await attachedWith({ adaptsInput: true, ...OFF });
			paste("ls\n");
			expect(pane.pendingPaste.value).toBeNull();
			expect(inputs()).toEqual([`${START}ls\r${END}`]);
		});
	}

	it("gives the card the first three lines", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("one\ntwo\nthree\nfour\nfive");
		expect(pane.pendingPaste.value).toMatchObject({ lines: 5, preview: ["one", "two", "three"] });
	});

	it("counts a lone CR as a line break", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\rb");
		expect(pane.pendingPaste.value).toMatchObject({ lines: 2 });
	});

	it("follows the mode the program sets later, once xterm has parsed it", async () => {
		await attachedWith({ adaptsInput: true, ...ON });
		print(`${ESC}[?2004l`);
		await parsed();
		paste("a\nb");
		expect(pane.pendingPaste.value).not.toBeNull();
		expect(inputs()).toEqual([]);

		pane.cancelPaste();
		print(`${ESC}[?2004h`);
		await parsed();
		paste("c\nd");
		expect(pane.pendingPaste.value).toBeNull();
		expect(inputs()).toEqual([`${START}c\rd${END}`]);
	});

	it("holds nothing while the socket is down, and sends nothing", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		connected = false;
		paste("a\nb");
		expect(pane.pendingPaste.value).toBeNull();
		expect(inputs()).toEqual([]);
	});

	it("holds nothing without the write lock, and sends nothing", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		pane.canWrite.value = false;
		paste("a\nb");
		expect(pane.pendingPaste.value).toBeNull();
		expect(inputs()).toEqual([]);
	});

	it("sends a held paste on confirm, once, bracketed, to an agent that adapts input", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		expect(pane.pendingPaste.value).not.toBeNull();
		expect(inputs()).toEqual([]);
		pane.confirmPaste();
		expect(inputs()).toEqual([`${START}a\rb${END}`]);
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(inputs()).toHaveLength(1);
	});

	it("streams a held paste on confirm to an agent that streams pastes", async () => {
		await attachedWith({ adaptsInput: true, streamsPaste: true, ...OFF });
		paste("a\nb");
		expect(pane.pendingPaste.value).not.toBeNull();
		expect(pastes()).toEqual([]);
		expect(inputs()).toEqual([]);
		pane.confirmPaste();
		expect(pasteBytes()).toEqual(["a\rb"]);
		expect(inputs()).toEqual([]);
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(pastes()).toHaveLength(1);
	});

	it("gives a held paste to xterm's own paste on confirm for an older agent", async () => {
		await attachedWith(OFF);
		paste("a\nb");
		expect(pane.pendingPaste.value).not.toBeNull();
		expect(inputs()).toEqual([]);
		pane.confirmPaste();
		expect(inputs()).toEqual(["a\rb"]);
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(inputs()).toHaveLength(1);
	});

	it("lets xterm bracket a held paste for an older agent while bracketed paste is on", async () => {
		warning = "always";
		await attachedWith(ON);
		paste("a\nb");
		expect(inputs()).toEqual([]);
		pane.confirmPaste();
		expect(inputs()).toEqual([`${START}a\rb${END}`]);
	});

	it("reads the clipboard once, at the paste, and sends what it read then", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		const data = new DataTransfer();
		const read = data.getData.bind(data);
		let reads = 0;
		data.getData = (format: string) => {
			reads++;
			return reads === 1 ? read(format) : "other";
		};
		pasteEvent("a\nb", data);
		expect(reads).toBe(1);
		pane.confirmPaste();
		expect(reads).toBe(1);
		expect(inputs()).toEqual([`${START}a\rb${END}`]);
	});

	it("cancels the event it holds, so that xterm pastes nothing of it", async () => {
		await attachedWith(OFF);
		const event = pasteEvent("a\nb");
		expect(event.defaultPrevented).toBe(true);
		expect(inputs()).toEqual([]);
	});

	it("checks a streaming paste again on confirm: one started meanwhile wins", async () => {
		await attachedWith({ adaptsInput: true, streamsPaste: true, ...OFF });
		paste("a\nb");
		// Another pane showing the same terminal starts streaming a paste to it.
		const other = new PasteStream({
			send: () => {},
			connected: () => true,
			canSend: () => true,
			toast: { show: () => 0, update: () => {}, dismiss: () => {} },
			sendInput: () => {},
		});
		other.start(T, new TextEncoder().encode("other"));
		try {
			pane.confirmPaste();
			expect(toasts()).toContain("A paste is still being sent to this terminal.");
			expect(pastes()).toEqual([]);
			expect(inputs()).toEqual([]);
		} finally {
			other.interrupt();
		}
	});

	it("drops a held paste on cancel", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		pane.cancelPaste();
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(inputs()).toEqual([]);
	});

	it("drops a held paste when the pane attaches another terminal", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		pane.attachChannel(U, { adaptsInput: true });
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(inputs()).toEqual([]);
	});

	it("drops a held paste when the pane attaches the same terminal again", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		const again = pane.reattachChannel(T);
		expect(pane.pendingPaste.value).toBeNull();
		answer({ adaptsInput: true, ...OFF });
		await again;
		await parsed();
		pane.confirmPaste();
		expect(inputs()).toEqual([]);
	});

	it("drops a held paste when the pane is closed", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		pane.dispose();
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(inputs()).toEqual([]);
	});

	it("replaces a held paste with the next one that asks", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		paste("c\nd\ne");
		expect(pane.pendingPaste.value).toMatchObject({ lines: 3 });
		pane.confirmPaste();
		expect(inputs()).toEqual([`${START}c\rd\re${END}`]);
	});

	it("drops a held paste when the next one goes at once", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		paste("c");
		expect(inputs()).toEqual([`${START}c${END}`]);
		expect(pane.pendingPaste.value).toBeNull();
		pane.confirmPaste();
		expect(inputs()).toHaveLength(1);
	});

	it("drops a held paste when the next one is refused", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		paste("x\n".repeat(40_000));
		expect(toasts()).toContain("This paste is too large to send (64 KiB at most).");
		expect(pane.pendingPaste.value).toBeNull();
	});

	it("keeps a held paste when the write lock goes, and sends nothing on confirm", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		pane.canWrite.value = false;
		expect(pane.pendingPaste.value).not.toBeNull();
		pane.confirmPaste();
		expect(inputs()).toEqual([]);
	});

	it("keeps a held paste when the socket goes, and sends nothing on confirm", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("a\nb");
		connected = false;
		expect(pane.pendingPaste.value).not.toBeNull();
		pane.confirmPaste();
		expect(inputs()).toEqual([]);
	});

	it("refuses a paste over 64 KiB with its toast, without asking", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		paste("x\n".repeat(40_000));
		expect(toasts()).toContain("This paste is too large to send (64 KiB at most).");
		expect(pane.pendingPaste.value).toBeNull();
		expect(inputs()).toEqual([]);
	});

	it("refuses a streamed paste over 16 MiB with its toast, without asking", async () => {
		await attachedWith({ adaptsInput: true, streamsPaste: true, ...OFF });
		paste("x\n".repeat(8 * 1024 * 1024 + 1));
		expect(toasts()).toContain("This paste is too large to send (16 MiB at most).");
		expect(pane.pendingPaste.value).toBeNull();
		expect(pastes()).toEqual([]);
	});

	it("refuses a paste while another of this terminal is still being sent, without asking", async () => {
		await attachedWith({ adaptsInput: true, streamsPaste: true, ...OFF });
		warning = "never";
		paste("x\ny");
		warning = undefined;
		paste("a\nb");
		expect(toasts()).toContain("A paste is still being sent to this terminal.");
		expect(pane.pendingPaste.value).toBeNull();
	});

	it("says a paste is too large before it says nothing for want of the write lock", async () => {
		await attachedWith({ adaptsInput: true, ...OFF });
		pane.canWrite.value = false;
		paste("x\n".repeat(40_000));
		expect(toasts()).toContain("This paste is too large to send (64 KiB at most).");
		expect(pane.pendingPaste.value).toBeNull();
	});
});
