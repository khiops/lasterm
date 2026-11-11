/**
 * A pane over a terminal that has ended (#927). It asks the hub for it even
 * when its list says it ended, and shows what the terminal last printed under
 * its exit card. It keeps an ending it watched when its socket comes back,
 * writes nothing of a terminal it has left, and Restart keeps the last output
 * above the new shell.
 *
 * The pane is mounted whole over its real terminal composable, as
 * TerminalPane.fixture.ts sets it up: only xterm and its addons are stood in,
 * and the hub is a socket the test answers.
 */
import type { EndedOutput } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useSessionStore } from "../stores/session.js";
import {
	attaches,
	attachOk,
	bellSound,
	button,
	drain,
	HOST,
	hear,
	lastOutput,
	MOUSE_OFF,
	mountPane,
	paneText,
	refuse,
	S,
	sent,
	settle,
	spawns,
	T,
	xterm,
} from "./TerminalPane.fixture.js";

describe("TerminalPane over a terminal that has ended (#927)", () => {
	it("opens an ended terminal with what it last printed under its card", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		expect(attaches()[0]).toMatchObject({ channelId: T });

		refuse(T, lastOutput());

		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
		expect(button("Close")).toBeDefined();
		expect(paneText()).toContain("exited");
		expect(xterm.events).toContain("LAST-SCREEN");
		expect(xterm.events).toContain("fail: no such file");
		expect(spawns()).toEqual([]);
	});

	it("shows the card when the hub does not answer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(button("Restart")).toBeDefined();
		expect(paneText()).not.toContain("timeout");
		expect(xterm.events).toEqual([]);
	});

	it("asks the new socket when its socket was replaced while it waited", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		// The socket is replaced while the pane opens: the ATTACH went out on the old one.
		useSessionStore().reconnectCount++;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(button("Restart")).toBeDefined();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T, lastOutput());
		await settle();
		expect(xterm.events).toContain("LAST-SCREEN");
	});

	it("keeps the last output above the restarted shell", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T, lastOutput());
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
		const replay = [...xterm.events];

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		const spawn = spawns()[0];
		expect(spawn).toMatchObject({ hostId: HOST, reuseChannelId: T });
		hear({ type: "SPAWN_OK", channelId: T, requestId: spawn?.requestId });
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "NEW-SHELL");
		await settle();

		// Not cleared, and the new shell's screen not drawn over it.
		expect(xterm.events).toEqual(replay);
		expect(replay.slice(0, 2)).toEqual(["<reset>", "LAST-SCREEN"]);
	});

	it("writes nothing of a terminal it left while opening", async () => {
		const channel = ref(T);
		mountPane(channel, "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = S;
		await settle();
		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).not.toContain("LAST-SCREEN");
		expect(xterm.events).not.toContain("fail: no such file");
		expect(xterm.events).toEqual([]);
	});
});

describe("TerminalPane over an ending it watched (#927)", () => {
	/** A pane attached live to T, which ends while it watches. */
	async function watchItEnd(): Promise<void> {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "WHOLE");
		await settle();
		useChannelsStore().updateChannelStatus(T, "dead", 1);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
	}

	/** The socket is replaced and the pane's re-attach is refused with `last`. */
	async function socketComesBack(last: EndedOutput): Promise<void> {
		const before = attaches().length;
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(before + 1));
		refuse(T, last);
		await settle();
	}

	it("turns mouse reporting off over a terminal that ended while watched", async () => {
		await watchItEnd();

		expect(xterm.events.at(-1)).toBe(MOUSE_OFF);
		// In its own xterm only.
		expect(sent.filter((m) => m.type === "INPUT" || m.type === "RESIZE")).toEqual([]);
	});

	it("keeps the whole ending it watched when its socket comes back", async () => {
		await watchItEnd();
		expect(xterm.events).toEqual(["<reset>", "WHOLE", MOUSE_OFF]);
		// Kept: no clear, no output, no notice; only the mouse reset (C12).
		const keptAgain = () => ["<reset>", "WHOLE", MOUSE_OFF, ...extraResets];
		const extraResets: string[] = [];

		await socketComesBack(lastOutput());
		extraResets.push(MOUSE_OFF);
		expect(xterm.events).toEqual(keptAgain());

		// Again: the refusal before reported the end as found, not as watched.
		await socketComesBack(lastOutput());
		extraResets.push(MOUSE_OFF);
		expect(xterm.events).toEqual(keptAgain());

		await socketComesBack(lastOutput({ snapshot: null, tail: [], truncated: true }));
		extraResets.push(MOUSE_OFF);
		expect(xterm.events).toEqual(keptAgain());
	});

	it("takes the hub's copy again once a terminal attached since", async () => {
		await watchItEnd();

		// Restarted, attached, then ended while its socket was down: found, not watched.
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		hear({ type: "SPAWN_OK", channelId: T, requestId: spawns()[0]?.requestId });
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "AGAIN");
		await settle();
		useSessionStore().connected = false;
		await settle();
		useSessionStore().connected = true;
		xterm.events.length = 0;

		await socketComesBack(
			lastOutput({ snapshot: null, tail: [new TextEncoder().encode("FOUND")] }),
		);

		expect(xterm.events).toEqual(["<reset>", "FOUND", MOUSE_OFF]);
	});

	it("takes a live terminal's screen when its socket comes back to it restarted", async () => {
		await watchItEnd();
		xterm.events.length = 0;

		// Restarted from another window while this pane's socket was down.
		const before = attaches().length;
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(before + 1));
		attachOk(T, "RESTARTED");
		await settle();

		expect(xterm.events).toEqual(["<reset>", "RESTARTED"]);
	});

	it("forgets the ending it watched when its terminal changes", async () => {
		const channel = ref(T);
		mountPane(channel, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "WHOLE");
		await settle();
		useChannelsStore().updateChannelStatus(T, "dead", 1);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());

		channel.value = S;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(S, lastOutput({ snapshot: null, tail: [new TextEncoder().encode("S-OUT")] }));
		await settle();
		channel.value = T;
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		refuse(T, lastOutput({ snapshot: null, tail: [new TextEncoder().encode("T-OUT")] }));
		await settle();
		expect(xterm.events.slice(-3)).toEqual(["<reset>", "T-OUT", MOUSE_OFF]);

		// Its screen is the hub's copy now, not the ending it watched.
		xterm.events.length = 0;
		await socketComesBack(
			lastOutput({ snapshot: null, tail: [new TextEncoder().encode("T-FINAL")] }),
		);
		expect(xterm.events).toEqual(["<reset>", "T-FINAL", MOUSE_OFF]);
	});

	it("turns no mouse off for a late answer about another terminal", async () => {
		const channel = ref(S);
		mountPane(channel, "live");
		useChannelsStore().updateChannelStatus(S, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(S, "S-LIVE");
		await settle();

		channel.value = T;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		channel.value = S;
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(S, "S-AGAIN");
		await settle();
		xterm.events.length = 0;

		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).toEqual([]);
	});
});

describe("TerminalPane given another terminal while it opens (#927)", () => {
	it("attaches the terminal it was given while it opened, once T is answered", async () => {
		const channel = ref(T);
		mountPane(channel, "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = S;
		await settle();
		refuse(T, lastOutput());

		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		expect(attaches()[1]).toMatchObject({ channelId: S });
	});

	it("attaches the terminal it was given while it opened, once T's attach timed out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const channel = ref(T);
		mountPane(channel, "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = S;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		expect(attaches()[1]).toMatchObject({ channelId: S });
	});
});

describe("TerminalPane rings no bell for a replay (#927)", () => {
	const BEL = "\u0007";
	const bytes = (text: string) => new TextEncoder().encode(text);

	for (const mode of ["now", "later"] as const) {
		it(`with writes parsed ${mode === "now" ? "inside write()" : "later"}`, async () => {
			xterm.parse = mode;
			xterm.profile = { bellSound: "system" };
			mountPane(ref(T), "live");
			await vi.waitFor(() => expect(attaches()).toHaveLength(1));
			// A live ATTACH_OK's snapshot is a replay.
			attachOk(T, `LIVE${BEL}`);
			await settle();
			drain();

			// A live bell taken before the replay, then a cached ATTACH_OK's snapshot
			// and tail, then a live bell after it: parsed in that order.
			hear({ type: "OUTPUT", channelId: T, data: bytes(`before${BEL}`) });
			useSessionStore().reconnectCount++;
			await vi.waitFor(() => expect(attaches()).toHaveLength(2));
			hear({
				type: "ATTACH_OK",
				channelId: T,
				snapshot: { serialized: `CACHED${BEL}`, cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
				tail: [bytes(`TAIL${BEL}`)],
				writeLockHolder: null,
				cached: true,
				cols: 100,
				rows: 30,
			});
			await settle();
			hear({ type: "OUTPUT", channelId: T, data: bytes(`after${BEL}`) });

			// A live ATTACH_OK's snapshot, now that the pane listens for bells.
			useSessionStore().reconnectCount++;
			await vi.waitFor(() => expect(attaches()).toHaveLength(3));
			attachOk(T, `AGAIN${BEL}`);
			await settle();

			// And an ended terminal's last output, snapshot and tail.
			useSessionStore().reconnectCount++;
			await vi.waitFor(() => expect(attaches()).toHaveLength(4));
			refuse(
				T,
				lastOutput({
					snapshot: { serialized: `ENDSCREEN${BEL}`, cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
					tail: [bytes(`ENDED${BEL}`)],
				}),
			);
			await settle();
			drain();
			await settle();

			expect(xterm.events).toEqual(
				expect.arrayContaining([`AGAIN${BEL}`, `ENDSCREEN${BEL}`, `ENDED${BEL}`]),
			);
			expect(useNotificationStore().bellCounts.get(T)).toBe(2);
			expect(bellSound).toHaveBeenCalledTimes(2);
		});
	}
});
