/**
 * What a pane says in its terminal when the hub tells it the input typed there
 * was dropped (#767). Only xterm and its addons are stand-ins.
 */
import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useTerminal } from "./useTerminal.js";

const xterm = vi.hoisted(() => ({
	/** Everything written to a terminal, as text. */
	written: [] as string[],
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "" };
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
		}
		loadAddon(): void {}
		open(): void {}
		onData() {
			return { dispose() {} };
		}
		onResize() {
			return { dispose() {} };
		}
		onTitleChange() {
			return { dispose() {} };
		}
		write(data: string | Uint8Array): void {
			xterm.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
		}
		dispose(): void {}
	},
}));

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit(): void {}
	},
}));

vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

vi.mock("@xterm/addon-search", () => ({
	SearchAddon: class {
		findNext = vi.fn(() => true);
		findPrevious = vi.fn(() => true);
		clearDecorations = vi.fn();
		clearActiveDecoration = vi.fn();
		dispose = vi.fn();
		onDidChangeResults = vi.fn(() => ({ dispose() {} }));
	},
}));

vi.mock("./terminal-font.js", () => ({
	awaitTerminalFont: () => Promise.resolve(),
}));

/** A hub connection the test speaks for. */
function fakeWsClient() {
	const listeners = new Map<string, Set<(msg: ProtocolMessage) => void>>();
	const client = {
		isConnected: true,
		send: vi.fn(),
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
	return {
		client: client as unknown as IWsClient,
		hear(msg: ProtocolMessage): void {
			for (const callback of [...(listeners.get(msg.type) ?? [])]) callback(msg);
		},
		listening(type: string): number {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

const NOTICE = "what you typed was dropped: this terminal is not taking input";

describe("a terminal whose input was dropped (#767)", () => {
	beforeEach(() => {
		xterm.written.length = 0;
		setActivePinia(createPinia());
	});

	function paneOn(channelId: string) {
		const hub = fakeWsClient();
		const pane = useTerminal(ref(document.createElement("div")), hub.client);
		pane.init();
		pane.attachChannel(channelId);
		xterm.written.length = 0;
		return { hub, pane };
	}

	it("says so in that terminal, on a line of its own", () => {
		const { hub } = paneOn("ch-1");

		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-1" });

		expect(xterm.written).toHaveLength(1);
		expect(xterm.written[0]).toContain(NOTICE);
		expect(xterm.written[0]).toMatch(/^\r\n.*\r\n$/s);
	});

	it("says it each time the hub does: once per gap, as the agent says it", () => {
		const { hub } = paneOn("ch-1");

		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-1" });
		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-1" });

		expect(xterm.written.filter((text) => text.includes(NOTICE))).toHaveLength(2);
	});

	it("says nothing of another terminal's", () => {
		const { hub } = paneOn("ch-1");

		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-2" });

		expect(xterm.written).toEqual([]);
	});

	it("stops listening once the pane is gone", () => {
		const { hub, pane } = paneOn("ch-1");
		expect(hub.listening("INPUT_DROPPED")).toBe(1);

		pane.dispose();

		expect(hub.listening("INPUT_DROPPED")).toBe(0);
	});
});
