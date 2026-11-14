/**
 * The pane lifecycle across event orders (#984).
 *
 * The window is the real `PaneLayout` over a real `useLayout()`, every tab
 * mounted under `v-show` and wired as `App.vue` wires it, so a split, a move or
 * a filled empty slot remounts `TerminalPane` as the app does. The hub is a
 * model (`World`): it holds every SPAWN and ATTACH the window sends and answers
 * them in any order; it prints and ends terminals; and, in a scenario with
 * `timeouts`, time can reach the window's next deadline, after which the hub
 * may still answer that request once. A terminal may print once the window has
 * asked for it, before its attach is answered: the pane drops that output, as
 * the hub's order allows (#931). Each scenario is a short sequence of user
 * gestures; every interleaving of them with the hub's events is run, each from
 * a fresh window, depth first, within the scenario's bound.
 *
 * What it rejects is `Kind`: each kind is raised in one place, which its
 * comment names.
 *
 * Open defects it reaches are named by `knownDefect` and marked on each
 * scenario that reaches them (`stillReaches`): their violations are kept out of
 * its verdict, and the scenario fails once it no longer reaches one. Until the
 * defect is fixed, a marked scenario cannot tell another cause of the same
 * violations from it. Whoever fixes the defect drops the mark.
 */

import { describe, expect, it, vi } from "vitest";
import { computed, defineComponent, h, provide, vShow, withDirectives } from "vue";
import { CHANNELS_ON_SCREEN_KEY, channelsOnScreen } from "../composables/displayedChannels.js";
import {
	collectTerminalChannelIds,
	countPanes,
	type DropZone,
	findChannelByPaneId,
	type PaneNode,
	useLayout,
} from "../composables/useLayout.js";
import { MAX_PANE_COUNT } from "../composables/usePaneTree.js";
import { useChannelsStore } from "../stores/channels.js";
import { useSessionStore } from "../stores/session.js";
import { useWriteLockStore } from "../stores/writelock.js";
import {
	CLIENT,
	closePane,
	drain,
	type Frame,
	forgetWindow,
	freshWindow,
	HOST,
	hear,
	listening,
	mountRoot,
	root,
	S,
	type StandInTerminal,
	sent,
	settle,
	T,
	xterm,
} from "./TerminalPane.fixture.js";

// After the fixture, which registers its module mocks as it loads: the layout
// imports the pane, and the pane xterm, which must be the stand-in.
const { default: PaneLayout } = await import("./PaneLayout.vue");

const ulid = (tail: string): string => `01H${"Z".repeat(21)}${tail}`;
const U = ulid("U4");
const pendingId = (k: number): string => `pending-${k}`;
const hostOf = (k: number): string => ulid(`H${k}`);
/** The terminal the `attempt`-th SPAWN for pending id `k` starts. */
const realId = (k: number, attempt: number): string => ulid(`${k}${attempt}`);

/** A short name for a terminal, as markers and reports spell it. */
function nameOf(id: string): string {
	if (id === T) return "T";
	if (id === U) return "U";
	if (id === S) return "S";
	if (id.startsWith("pending-")) return `P${id.slice("pending-".length)}`;
	return `R${id.slice(-2)}`;
}

function idOf(name: string): string {
	if (name === "T") return T;
	if (name === "U") return U;
	if (name === "S") return S;
	if (name.startsWith("P")) return pendingId(Number(name.slice(1)));
	return ulid(name.slice(1));
}

/** What App does on each gesture, as `App.vue` wires it to the layout, the sidebar and the tab bar. */
interface Gestures {
	layout: ReturnType<typeof useLayout>;
	onSplit(channelId: string, direction: "horizontal" | "vertical"): void;
	onChannelSpawned(tempId: string, realId: string): void;
	onClosePane(channelId: string): void;
	onFillVacant(vacantId: string, channelId: string): void;
	onNewTerminalVacant(vacantId: string, hostId: string): void;
	onDropPane(source: string, targetPaneId: string, targetTabId: string, zone: DropZone): void;
	onMoveToNewTab(source: string, insertAtIndex: number): void;
	onSidebarOpenCurrentTab(channelId: string): void;
	/** A new terminal in a new tab, as App's `openPendingTab`. */
	openPendingTab(hostId: string): void;
}

/**
 * What the harness rejects, and where:
 * - `xterm-count` (`checkPanes`, after every step and once quiet): a terminal
 *   leaf of the layout whose pane is missing or holds other than one xterm.
 * - `xterm-answer-to-other-terminal` (`observe`, after every step): an INPUT
 *   carrying xterm's answer to one terminal's query, sent to another.
 * - `written-into-other-pane` (`onWrite`, as the write is taken): a snapshot or
 *   output written into a pane whose leaf shows another terminal. A snapshot is
 *   matched to its terminal, not to its ATTACH: the UI's ATTACH carries no
 *   request id.
 * - `spawn-answer-to-other-pane` (`onChannelSpawned`, as it is announced): a
 *   spawn's terminal announced for another id than its SPAWN's pending id.
 * - `spawn-lost` (`answerSpawn`, after the step that delivers a SPAWN_OK the
 *   window still waited for): its terminal is not at the pane and tab where its
 *   pending id was, or the pending id is still in the layout.
 * - `retry-lost` (`gesture.retry`, after its step): a Retry after which other
 *   than one SPAWN went out.
 * - `left-connecting` (`checkQuiet`): a pane saying "Connecting…".
 * - `spawn-failure-on-other-terminal` (`checkQuiet`): a spawn's failure shown
 *   by a pane whose leaf does not show that spawn's pending id.
 * - `shows-other-screen` (`checkQuiet`): a settled pane over a live terminal
 *   whose last marked write since its last reset is another terminal's, or
 *   which has none although its terminal is not one a spawn started.
 * - `spawn-doubled` (`checkQuiet`): more SPAWNs for a pending id than one plus
 *   one per Retry.
 * - `spawn-missing` (`checkQuiet`): fewer, while the pending id or a terminal
 *   its spawn started is in the layout.
 * - `pending-left` (`checkQuiet`): a pending id in the layout whose pane shows
 *   no failure.
 */
type Kind =
	| "xterm-count"
	| "xterm-answer-to-other-terminal"
	| "written-into-other-pane"
	| "spawn-answer-to-other-pane"
	| "spawn-lost"
	| "retry-lost"
	| "left-connecting"
	| "spawn-failure-on-other-terminal"
	| "shows-other-screen"
	| "spawn-doubled"
	| "spawn-missing"
	| "pending-left";

interface Violation {
	kind: Kind;
	detail: string;
	/** The pending id's number, when the violation is about a spawn. */
	spawn?: number;
	/** The open issue this violation is, when it is a known defect's. */
	known?: string;
	path: string[];
}

interface SpawnRecord {
	k: number;
	pending: string;
	host: string;
	/** Retries clicked on a pane showing the pending id. */
	retries: number;
	/** Whether a second pane instance came over the pending id: its spawn, sent or failed, was the first one's. */
	remounted: boolean;
	/** Pane instances seen over the pending id, by their xterm. */
	seen: Set<StandInTerminal>;
	/** Each SPAWN that started a terminal: that terminal, and whether its pending id was in a layout then. */
	started: Array<{ real: string; inLayout: boolean }>;
}

interface Step {
	label: string;
	/** Whether the gesture has something to act on now: a step that has not waits. */
	can?(world: World): boolean;
	run(world: World): void | Promise<void>;
}

interface Scenario {
	name: string;
	/** The window's layout before the first step, set as the window opens. */
	setUp(world: World): void;
	steps: Step[];
	/** The window's connection opens as a hub event, not at once. */
	holdConnect?: boolean;
	/** Time reaching the window's next deadline is an event: that request times out. */
	timeouts?: boolean;
	/** xterm parses writes on its timer, an event of its own. */
	parseLater?: boolean;
	/** Terminals that print once, as a hub event, and whether what they print asks xterm for the cursor. */
	prints?: { channels: string[]; query: boolean };
	/** Terminals that end, as a hub event. */
	ends?: string[];
	maxPaths: number;
	/**
	 * The open defects this scenario reaches, marked as known failures: their
	 * violations are left out of its verdict, and it fails once it no longer
	 * reaches one. Whoever fixes the defect removes it here.
	 */
	stillReaches?: string[];
}

/** How long the window waits for an ATTACH's answer: `useTerminal.ts`'s attach deadline. */
const ATTACH_DEADLINE_MS = 10_000;
/** How long it waits for a SPAWN's: `SPAWN_DEADLINE_MS` in `stores/channels.ts`. */
const SPAWN_DEADLINE_MS = 15_000;

const MARKER = /\[([A-Z][0-9]*)@(\d+)\]|<([A-Z][0-9]*)#(\d+)>/g;
const QUERY = "\u001b[6n";

class World {
	ui!: Gestures;
	path: string[] = [];
	violations: Violation[] = [];
	/** Indexes in `sent` of the requests answered, or timed out. */
	done = new Set<number>();
	/** Requests that timed out and are not answered yet: the hub may still answer them. */
	timedOut = new Set<number>();
	live = new Set<string>([T, U]);
	dead = new Set<string>([S]);
	spawns = new Map<number, SpawnRecord>();
	printed = new Set<string>();
	/** Each xterm answer to a query, and the terminal whose output asked it. */
	asks = new Map<string, string>();
	/** The terminal of the last marker each xterm took since its last reset. */
	lastMarker = new Map<StandInTerminal, string>();
	/** The window's clock, as the fake timers keep it, and when each request was sent. */
	clock = 0;
	sentAt = new Map<number, number>();
	connected = true;
	openConnection: () => void = () => {};
	stepsTaken = 0;
	inputsSeen = 0;
	/** Checks to run once the step that queued them has settled. */
	afterStep: Array<() => void> = [];
	constructor(readonly scenario: Scenario) {}

	violate(kind: Kind, detail: string, spawn?: number): void {
		const known = knownDefect(kind, spawn === undefined ? undefined : this.spawns.get(spawn));
		this.violations.push({
			kind,
			detail,
			...(spawn !== undefined && { spawn }),
			...(known !== undefined && { known }),
			path: [...this.path],
		});
	}

	/** Every tab's tree. */
	trees(): PaneNode[] {
		return Object.values(this.ui.layout.layouts.value).filter((n): n is PaneNode => n != null);
	}

	inLayout(channelId: string): boolean {
		return this.trees().some((tree) => collectTerminalChannelIds(tree).includes(channelId));
	}

	paneIdOf(channelId: string): { paneId: string; tabId: string } | null {
		for (const [tabId, tree] of Object.entries(this.ui.layout.layouts.value)) {
			const found = tree == null ? null : findPane(tree, channelId);
			if (found !== null) return { paneId: found, tabId };
		}
		return null;
	}

	/** The terminal the pane with this id shows, from the layout. */
	shownByPane(paneId: string): string | null {
		for (const tree of this.trees()) {
			const channelId = findChannelByPaneId(tree, paneId);
			if (channelId !== null) return channelId;
		}
		return null;
	}

	/** The terminal the pane holding this xterm shows; null for an xterm in no pane on the page. */
	shownBy(terminal: StandInTerminal): string | null {
		const paneId = terminal.element.closest("[data-pane-id]")?.getAttribute("data-pane-id");
		return paneId == null || !root.contains(terminal.element) ? null : this.shownByPane(paneId);
	}

	/** Where new terminal `k` is now: its pending id, or what its spawn started, as the layout holds it. */
	whereIs(k: number): string | null {
		const record = this.spawns.get(k);
		if (record === undefined) return null;
		if (this.inLayout(record.pending)) return record.pending;
		const started = record.started.map((s) => s.real).find((real) => this.inLayout(real));
		return started ?? null;
	}

	/** A pending id for a new terminal on `hostId`, as App makes one. */
	pendingFor(hostId: string): string {
		const k = Number(hostId.slice(-1));
		this.spawns.set(k, {
			k,
			pending: pendingId(k),
			host: hostId,
			retries: 0,
			remounted: false,
			seen: new Set(),
			started: [],
		});
		return pendingId(k);
	}

	spawnsSentFor(record: SpawnRecord): number {
		return sent.filter((m) => m.type === "SPAWN" && m.hostId === record.host).length;
	}

	/** The Retry, or Connect, button of the pane showing new terminal `k`'s pending id. */
	retryButtonOf(k: number): HTMLButtonElement | undefined {
		const at = this.paneIdOf(pendingId(k));
		const wrapper = at === null ? null : root.querySelector(`[data-pane-id="${at.paneId}"]`);
		return [...(wrapper?.querySelectorAll("button") ?? [])].find((b) =>
			["Retry", "Connect"].includes(b.textContent?.trim() ?? ""),
		);
	}

	spawnOf(frame: Frame): SpawnRecord {
		const record = [...this.spawns.values()].find((s) => s.host === frame.hostId);
		if (record === undefined) throw new Error(`a SPAWN for no pending id: ${String(frame.hostId)}`);
		return record;
	}

	// --- What the window does, seen as it does it -----------------------------------

	onWrite(terminal: StandInTerminal, text: string): void {
		// Every record below is keyed by the terminals the stand-in made: a write
		// from anything else would leave them silently empty.
		if (!(xterm.terminals as StandInTerminal[]).includes(terminal)) {
			throw new Error("a write from an xterm the stand-in did not make");
		}
		for (const match of text.matchAll(MARKER)) {
			const name = match[1] ?? match[3] ?? "";
			this.lastMarker.set(terminal, name);
			const shown = this.shownBy(terminal);
			if (shown !== null && shown !== idOf(name)) {
				this.violate(
					"written-into-other-pane",
					`${match[0]} written into the pane showing ${nameOf(shown)}`,
				);
			}
		}
	}

	/** xterm's own answer to a cursor-position query in what it parses. */
	answerFor(text: string): string | null {
		if (!text.includes(QUERY)) return null;
		const asker = [...text.matchAll(MARKER)].map((m) => m[3]).find((n) => n !== undefined);
		if (asker === undefined) return null;
		const answer = `\u001b[${this.asks.size + 1};1R`;
		this.asks.set(answer, idOf(asker));
		return answer;
	}

	onChannelSpawned(tempId: string, real: string): void {
		const record = [...this.spawns.values()].find((s) => s.started.some((st) => st.real === real));
		if (record === undefined || record.pending !== tempId) {
			this.violate(
				"spawn-answer-to-other-pane",
				`${nameOf(real)} announced for ${nameOf(tempId)}`,
				record?.k,
			);
		}
	}

	/** Each terminal leaf of the layout has one pane on the page, holding one xterm. */
	checkPanes(): void {
		for (const tree of this.trees()) {
			for (const leaf of terminalLeaves(tree)) {
				const wrapper = root.querySelector(`[data-pane-id="${leaf.paneId}"]`);
				const panes = wrapper?.querySelectorAll(".terminal-pane").length ?? 0;
				const xterms = wrapper?.querySelectorAll(".xterm").length ?? 0;
				if (panes !== 1 || xterms !== 1) {
					this.violate(
						"xterm-count",
						`${nameOf(leaf.channelId)}'s leaf has ${panes} panes and ${xterms} xterms`,
					);
				}
			}
		}
	}

	/** After each step: its queued checks, the panes, instances over a pending id, input sent. */
	observe(): void {
		sent.forEach((frame, i) => {
			if ((frame.type === "SPAWN" || frame.type === "ATTACH") && !this.sentAt.has(i)) {
				this.sentAt.set(i, this.clock);
			}
		});
		for (const check of this.afterStep.splice(0)) check();
		this.checkPanes();
		for (const record of this.spawns.values()) {
			for (const terminal of xterm.terminals as StandInTerminal[]) {
				if (this.shownBy(terminal) !== record.pending) continue;
				if (record.seen.size > 0 && !record.seen.has(terminal)) record.remounted = true;
				record.seen.add(terminal);
			}
		}
		const inputs = sent.filter((m) => m.type === "INPUT");
		for (const input of inputs.slice(this.inputsSeen)) {
			const data =
				input.data instanceof Uint8Array
					? new TextDecoder().decode(input.data)
					: String(input.data);
			const asker = this.asks.get(data);
			if (asker !== undefined && input.channelId !== asker) {
				this.violate(
					"xterm-answer-to-other-terminal",
					`xterm's answer to ${nameOf(asker)}'s query sent to ${nameOf(String(input.channelId))}`,
				);
			}
		}
		this.inputsSeen = inputs.length;
	}

	// --- The choices at each step ----------------------------------------------------

	choices(): Step[] {
		const next: Step[] = [];
		const step = this.scenario.steps[this.stepsTaken];
		if (step !== undefined && (step.can?.(this) ?? true)) {
			next.push({
				label: step.label,
				run: async (world) => {
					world.stepsTaken++;
					await step.run(world);
				},
			});
		}
		if (!this.connected) {
			next.push({
				label: "hub: the connection opens",
				run: (world) => {
					world.connected = true;
					world.openConnection();
				},
			});
		}
		const open = sent.map((frame, i) => ({ frame, i })).filter(({ i }) => !this.done.has(i));
		for (const { frame, i } of open) {
			if (frame.type === "SPAWN") {
				const k = this.spawnOf(frame).k;
				next.push({ label: `hub: spawn ${k} (#${i}) starts`, run: (w) => w.answerSpawn(i, true) });
				next.push({ label: `hub: spawn ${k} (#${i}) fails`, run: (w) => w.answerSpawn(i, false) });
			} else if (frame.type === "ATTACH") {
				const name = nameOf(String(frame.channelId));
				next.push({ label: `hub: answers ATTACH ${name} (#${i})`, run: (w) => w.answerAttach(i) });
			}
		}
		if (
			this.scenario.timeouts === true &&
			open.some(({ frame }) => frame.type === "SPAWN" || frame.type === "ATTACH")
		) {
			next.push({ label: "time: the window's next deadline passes", run: (w) => w.timeout() });
		}
		// A request the window gave up on can still be answered, once, after its time.
		for (const i of this.timedOut) {
			const frame = sent[i] as Frame;
			if (frame.type === "SPAWN") {
				const k = this.spawnOf(frame).k;
				next.push({
					label: `hub: spawn ${k} (#${i}) starts, after its time`,
					run: (w) => w.answerSpawn(i, true),
				});
				next.push({
					label: `hub: spawn ${k} (#${i}) fails, after its time`,
					run: (w) => w.answerSpawn(i, false),
				});
			} else {
				const name = nameOf(String(frame.channelId));
				next.push({
					label: `hub: answers ATTACH ${name} (#${i}), after its time`,
					run: (w) => w.answerAttach(i),
				});
			}
		}
		for (const channelId of this.scenario.prints?.channels ?? []) {
			const attached = sent.some((m) => m.type === "ATTACH" && m.channelId === channelId);
			if (this.printed.has(channelId) || !attached || !this.live.has(channelId)) continue;
			next.push({ label: `hub: ${nameOf(channelId)} prints`, run: (w) => w.print(channelId) });
		}
		for (const channelId of this.scenario.ends ?? []) {
			if (!this.live.has(channelId)) continue;
			next.push({ label: `hub: ${nameOf(channelId)} ends`, run: (w) => w.end(channelId) });
		}
		if (xterm.queue.length > 0) next.push({ label: "xterm parses", run: () => drain() });
		return next;
	}

	answerSpawn(i: number, ok: boolean): void {
		const frame = sent[i] as Frame;
		const record = this.spawnOf(frame);
		// The window gave up on it: the pane says so, and owes the terminal no place.
		const late = this.timedOut.delete(i);
		this.done.add(i);
		const attempt = sent
			.slice(0, i + 1)
			.filter((m) => m.type === "SPAWN" && m.hostId === record.host).length;
		if (ok) {
			const real = realId(record.k, attempt);
			this.live.add(real);
			const was = late ? null : this.paneIdOf(record.pending);
			record.started.push({ real, inLayout: was !== null });
			hear({ type: "SPAWN_OK", channelId: real, requestId: frame.requestId });
			grantWriteLock(real);
			// Once the answer is taken: its terminal is at the pane and tab its pending id was.
			if (was !== null) {
				this.afterStep.push(() => {
					const now = this.paneIdOf(real);
					const placed = now !== null && now.paneId === was.paneId && now.tabId === was.tabId;
					const left = this.inLayout(record.pending);
					if (!placed || left) {
						this.violate(
							"spawn-lost",
							`P${record.k}'s spawn started ${nameOf(real)}, which ${placed ? "is" : "is not"} where P${record.k} was, with P${record.k} ${left ? "still there" : "gone"}`,
							record.k,
						);
					}
				});
			}
		} else {
			hear({
				type: "ERROR",
				code: "SPAWN_FAILED",
				message: `spawn ${record.k} failed`,
				requestId: frame.requestId,
			});
		}
	}

	answerAttach(i: number): void {
		const frame = sent[i] as Frame;
		const channelId = String(frame.channelId);
		this.timedOut.delete(i);
		this.done.add(i);
		if (this.live.has(channelId)) {
			grantWriteLock(channelId);
			hear({
				type: "ATTACH_OK",
				channelId,
				snapshot: {
					serialized: `[${nameOf(channelId)}@${i}]`,
					cols: 100,
					rows: 30,
					cursorX: 0,
					cursorY: 0,
				},
				tail: [],
				// The window is the hub's only client: the write lock is its own.
				writeLockHolder: CLIENT,
				cached: false,
				cols: 100,
				rows: 30,
			});
		} else if (this.dead.has(channelId)) {
			hear({ type: "ERROR", code: "CHANNEL_DEAD", message: "This terminal has ended.", channelId });
		} else {
			hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId });
		}
	}

	deadlineOf(i: number): number {
		const wait = (sent[i] as Frame).type === "SPAWN" ? SPAWN_DEADLINE_MS : ATTACH_DEADLINE_MS;
		return (this.sentAt.get(i) ?? 0) + wait;
	}

	openRequests(): number[] {
		return sent
			.map((frame, i) => ({ frame, i }))
			.filter(
				({ frame, i }) => (frame.type === "SPAWN" || frame.type === "ATTACH") && !this.done.has(i),
			)
			.map(({ i }) => i);
	}

	/** Time reaches the window's next deadline: every request due by then times out. */
	timeout(): void {
		const next = Math.min(...this.openRequests().map((i) => this.deadlineOf(i)));
		vi.advanceTimersByTime(next - this.clock + 1);
		this.clock = next + 1;
		for (const i of this.openRequests()) {
			if (this.deadlineOf(i) < this.clock) {
				this.done.add(i);
				this.timedOut.add(i);
			}
		}
		// The window must have stopped waiting for what the model says it gave up
		// on, and only that: a deadline of the window's that drifted from the
		// model's would otherwise turn late answers into timely ones in silence.
		const awaited = this.openRequests().filter((i) => (sent[i] as Frame).type === "SPAWN").length;
		if (listening("SPAWN_OK") !== awaited) {
			throw new Error(
				`the window waits for ${listening("SPAWN_OK")} SPAWNs, the model for ${awaited}: its spawn deadline is not ${SPAWN_DEADLINE_MS} ms`,
			);
		}
		const attaches = this.openRequests().filter((i) => (sent[i] as Frame).type === "ATTACH");
		if (attaches.length === 0 && listening("ATTACH_OK") > 0) {
			throw new Error(
				`the window still waits for an ATTACH: its attach deadline is not ${ATTACH_DEADLINE_MS} ms`,
			);
		}
	}

	print(channelId: string): void {
		this.printed.add(channelId);
		const query = this.scenario.prints?.query === true ? QUERY : "";
		hear({
			type: "OUTPUT",
			channelId,
			data: new TextEncoder().encode(`<${nameOf(channelId)}#1>${query}`),
		});
	}

	/** The terminal ends: the hub's CHANNEL_STATE, as the session store takes it. */
	end(channelId: string): void {
		this.live.delete(channelId);
		this.dead.add(channelId);
		useChannelsStore().updateChannelStatus(channelId, "dead", 0);
	}

	// --- Once the window is quiet ----------------------------------------------------

	checkQuiet(): void {
		for (const wrapper of root.querySelectorAll<HTMLElement>(".pane-drop-wrapper")) {
			const pane = wrapper.querySelector(".terminal-pane");
			if (pane === null) continue;
			const paneId = wrapper.getAttribute("data-pane-id") ?? "";
			const shown = this.shownByPane(paneId);
			const name = shown === null ? "?" : nameOf(shown);
			if (pane.querySelector(".terminal-loading") !== null) {
				this.violate(
					"left-connecting",
					`the pane showing ${name} still says Connecting…`,
					this.kOf(shown),
				);
			}
			const failure = pane.querySelector(".terminal-error")?.textContent ?? "";
			for (const match of failure.matchAll(/spawn (\d+) failed/g)) {
				if (shown !== pendingId(Number(match[1]))) {
					this.violate(
						"spawn-failure-on-other-terminal",
						`${match[0]} shown over ${name}`,
						Number(match[1]),
					);
				}
			}
			const settled =
				pane.querySelector(".terminal-loading, .terminal-error, .exit-overlay") === null;
			const terminal = (xterm.terminals as StandInTerminal[]).find((t) =>
				wrapper.contains(t.element),
			);
			const last = terminal === undefined ? undefined : this.lastMarker.get(terminal);
			if (settled && shown !== null && this.live.has(shown)) {
				// A spawned terminal is shown from its first output, with no snapshot.
				const spawned = this.kOf(shown) !== undefined;
				if (last === undefined ? !spawned : idOf(last) !== shown) {
					this.violate(
						"shows-other-screen",
						`the pane showing ${name} shows ${last === undefined ? "no" : `${last}'s`} screen`,
					);
				}
			}
		}
		for (const record of this.spawns.values()) {
			const spawnsSent = sent.filter((m) => m.type === "SPAWN" && m.hostId === record.host).length;
			if (spawnsSent > 1 + record.retries) {
				this.violate(
					"spawn-doubled",
					`${spawnsSent} SPAWNs for P${record.k}, ${record.retries} retries`,
					record.k,
				);
			}
			const due =
				this.inLayout(record.pending) || record.started.some((st) => this.inLayout(st.real));
			if (due && spawnsSent < 1 + record.retries) {
				this.violate(
					"spawn-missing",
					`${spawnsSent} SPAWNs for P${record.k}, ${record.retries} retries, while it is in the layout`,
					record.k,
				);
			}
			if (this.inLayout(record.pending)) {
				const at = this.paneIdOf(record.pending);
				const wrapper = at === null ? null : root.querySelector(`[data-pane-id="${at.paneId}"]`);
				if (wrapper?.querySelector(".terminal-error") == null) {
					const shows = wrapper?.querySelector(".exit-overlay--gone")
						? "says it is gone"
						: "shows no failure";
					this.violate(
						"pending-left",
						`P${record.k} left in the layout; its pane ${shows}`,
						record.k,
					);
				}
			}
		}
	}

	kOf(channelId: string | null): number | undefined {
		if (channelId === null) return undefined;
		const record = [...this.spawns.values()].find(
			(s) => s.pending === channelId || s.started.some((st) => st.real === channelId),
		);
		return record?.k;
	}
}

/**
 * The hub's WRITE_LOCK naming this window, its only client, as the holder, as
 * the session store takes it: the fixture's socket has none of the store's handlers.
 */
function grantWriteLock(channelId: string): void {
	useWriteLockStore().handleWriteLock(channelId, CLIENT);
}

/** What each open defect looks like to the harness. */
function knownDefect(kind: Kind, spawn: SpawnRecord | undefined): string | undefined {
	// #966: xterm answers a query after the pane switched, as typed input to the terminal switched to.
	if (kind === "xterm-answer-to-other-terminal") return "#966";
	// #980: a pane remounted over its pending id loses its spawn: what the spawn
	// starts is shown nowhere, and a failed one can no longer be retried.
	const spawnKinds: Kind[] = ["spawn-lost", "pending-left"];
	if (spawn?.remounted === true && spawnKinds.includes(kind)) return "#980";
	return undefined;
}

function findPane(node: PaneNode, channelId: string): string | null {
	if (node.type === "terminal") return node.channelId === channelId ? node.paneId : null;
	if (node.type === "vacant") return null;
	return findPane(node.first, channelId) ?? findPane(node.second, channelId);
}

function terminalLeaves(node: PaneNode): Array<{ channelId: string; paneId: string }> {
	if (node.type === "terminal") return [{ channelId: node.channelId, paneId: node.paneId }];
	if (node.type === "vacant") return [];
	return [...terminalLeaves(node.first), ...terminalLeaves(node.second)];
}

function vacantIds(node: PaneNode | null | undefined): string[] {
	if (node == null || node.type === "terminal") return [];
	if (node.type === "vacant") return [node.id];
	return [...vacantIds(node.first), ...vacantIds(node.second)];
}

/** Mount the window: every tab's `PaneLayout`, under `v-show`, wired as App wires it. */
function mountLayout(world: World): void {
	try {
		localStorage.removeItem("lasterm:layout");
	} catch {
		// No storage: the layout starts empty all the same.
	}
	const Window = defineComponent({
		setup() {
			const layout = useLayout();
			const channels = useChannelsStore();
			provide(
				CHANNELS_ON_SCREEN_KEY,
				computed(() => channelsOnScreen(layout.layouts.value, layout.activeTab.value?.id ?? null)),
			);
			const ui: Gestures = {
				layout,
				onSplit: (channelId, direction) => {
					layout.splitPane(channelId, direction, MAX_PANE_COUNT);
				},
				onChannelSpawned: (tempId, real) => {
					world.onChannelSpawned(tempId, real);
					layout.replaceChannelId(tempId, real);
					channels.selectChannel(real);
					if (channels.activeHostId) void channels.fetchChannels(channels.activeHostId);
				},
				// App also deletes an ended terminal whose pane closes; the scenarios close live ones.
				onClosePane: (channelId) => layout.closePane(channelId),
				onFillVacant: (vacantId, channelId) => {
					layout.fillVacant(vacantId, channelId);
				},
				onNewTerminalVacant: (vacantId, hostId) => {
					const tempId = world.pendingFor(hostId);
					channels.registerPendingSpawn(tempId, hostId);
					layout.fillVacant(vacantId, tempId);
				},
				onDropPane: (source, targetPaneId, targetTabId, zone) => {
					if (zone !== "center") {
						const target = layout.layouts.value[targetTabId];
						if (target && countPanes(target) >= 4) return;
					}
					layout.movePaneTo(source, targetPaneId, targetTabId, zone);
				},
				onMoveToNewTab: (source, insertAtIndex) => layout.moveToNewTab(source, insertAtIndex),
				onSidebarOpenCurrentTab: (channelId) => {
					const active = layout.activeTab.value;
					const activeChannel = active === null ? null : layout.getActiveChannelId(active.id);
					if (activeChannel !== null) layout.replaceChannelId(activeChannel, channelId);
					else layout.openTab(channelId);
					channels.selectChannel(channelId);
				},
				openPendingTab: (hostId) => {
					const tempId = world.pendingFor(hostId);
					channels.registerPendingSpawn(tempId, hostId);
					layout.openTab(tempId);
				},
			};
			world.ui = ui;
			world.scenario.setUp(world);
			return () =>
				layout.tabs.value.map((tab, index) => {
					const node = layout.layouts.value[tab.id];
					return withDirectives(
						h("div", { key: tab.id, class: "pane-tab-container" }, [
							node
								? h(PaneLayout, {
										node,
										hostId: HOST,
										tabId: tab.id,
										hasMultiplePanes: countPanes(node) > 1,
										onSplit: ui.onSplit,
										onClosePane: ui.onClosePane,
										onChannelSpawned: ui.onChannelSpawned,
										onFillVacant: ui.onFillVacant,
										onNewTerminalVacant: ui.onNewTerminalVacant,
										onDropPane: ui.onDropPane,
									})
								: null,
						]),
						[[vShow, index === layout.activeTabIndex.value]],
					);
				});
		},
	});
	mountRoot(Window);
}

const MAX_STEPS = 200;

/**
 * Let the window run until two passes in a row leave unchanged what this
 * measures: the frames it sent, the writes its xterms took, the xterms it made,
 * its layout and its page.
 */
async function quiesce(world: World): Promise<void> {
	let before = "";
	for (let round = 0; round < 20; round++) {
		await settle();
		const now = [
			sent.length,
			xterm.queue.length,
			xterm.events.length,
			xterm.terminals.length,
			JSON.stringify(world.ui.layout.layouts.value),
			root.innerHTML,
		].join("|");
		if (now === before) return;
		before = now;
	}
	throw new Error(`the window never settled, after: ${world.path.join(" → ")}`);
}

/**
 * Run one path: take `prefix`'s choices, then the first choice at each further
 * step. `offered` are the choices the path being replayed was offered at each
 * of those steps: a replay offered others is not deterministic, and says so.
 */
async function runPath(
	scenario: Scenario,
	prefix: number[],
	offered: string[][],
): Promise<{ taken: number[]; offers: string[][]; world: World }> {
	const world = new World(scenario);
	forgetWindow();
	freshWindow();
	const channels = useChannelsStore();
	for (const id of [T, U]) {
		channels.registerChannelHost(id, HOST);
		channels.updateChannelStatus(id, "live");
	}
	channels.registerChannelHost(S, HOST);
	channels.updateChannelStatus(S, "dead", 1);
	if (scenario.holdConnect === true) {
		world.connected = false;
		const opened = new Promise<void>((resolve) => {
			world.openConnection = resolve;
		});
		vi.spyOn(useSessionStore(), "connect").mockImplementation(() => opened);
	}
	xterm.parse = scenario.parseLater === true ? "later" : "now";
	xterm.onWrite = (terminal, text) => world.onWrite(terminal, text);
	xterm.answer = (text) => world.answerFor(text);
	xterm.onReset = (terminal) => world.lastMarker.delete(terminal);
	mountLayout(world);
	try {
		await quiesce(world);
		world.observe();
		return await walk(world, prefix, offered);
	} finally {
		closePane();
		root.remove();
		vi.clearAllTimers();
	}
}

async function walk(
	world: World,
	prefix: number[],
	offered: string[][],
): Promise<{ taken: number[]; offers: string[][]; world: World }> {
	const scenario = world.scenario;
	const taken: number[] = [];
	const offers: string[][] = [];
	let flushed = false;
	let quiet = false;
	for (let depth = 0; depth < MAX_STEPS && !quiet; depth++) {
		const choices = world.choices();
		if (choices.length === 0) {
			if (flushed) {
				quiet = true;
				continue;
			}
			// Whatever the window still has on a timer runs: a request it sends then is a choice.
			flushed = true;
			vi.advanceTimersByTime(60_000);
			world.clock += 60_000;
			await quiesce(world);
			world.observe();
			continue;
		}
		flushed = false;
		const pick = prefix[taken.length] ?? 0;
		const choice = choices[pick];
		const labels = choices.map((c) => c.label);
		const expected = offered[taken.length];
		if (
			choice === undefined ||
			(expected !== undefined && expected.join("\n") !== labels.join("\n"))
		) {
			throw new Error(
				`the replay of "${scenario.name}" diverged at step ${taken.length}: offered ${labels.join("; ")}, where it was offered ${expected?.join("; ") ?? "nothing"}, choice ${pick}`,
			);
		}
		taken.push(pick);
		offers.push(labels);
		world.path.push(choice.label);
		await choice.run(world);
		await quiesce(world);
		world.observe();
	}
	if (!quiet) {
		throw new Error(
			`"${scenario.name}" still had choices after ${MAX_STEPS} steps: ${world.path.join(" → ")}`,
		);
	}
	world.checkQuiet();
	return { taken, offers, world };
}

interface Outcome {
	paths: number;
	exhausted: boolean;
	/** Whether some path took every gesture of the scenario. */
	everyGesture: boolean;
	violations: Violation[];
}

/** Every order of `scenario`'s steps and the hub's answers, depth first, up to its bound. */
async function explore(scenario: Scenario): Promise<Outcome> {
	let prefix: number[] = [];
	let offered: string[][] = [];
	let paths = 0;
	let everyGesture = false;
	const violations: Violation[] = [];
	for (;;) {
		const { taken, offers, world } = await runPath(scenario, prefix, offered);
		paths++;
		violations.push(...world.violations);
		if (world.stepsTaken === scenario.steps.length) everyGesture = true;
		let depth = taken.length - 1;
		while (depth >= 0 && (taken[depth] as number) + 1 >= (offers[depth] as string[]).length)
			depth--;
		if (depth < 0) return { paths, exhausted: true, everyGesture, violations };
		if (paths >= scenario.maxPaths) return { paths, exhausted: false, everyGesture, violations };
		prefix = [...taken.slice(0, depth), (taken[depth] as number) + 1];
		// The replay is offered, up to the step that changes, what this path was.
		offered = offers.slice(0, depth + 1);
	}
}

// --- Gestures ---------------------------------------------------------------------

/** The empty slot of the tab in front, if it has one. */
function emptySlot(w: World): string | undefined {
	const active = w.ui.layout.activeTab.value;
	return vacantIds(active === null ? null : w.ui.layout.layouts.value[active.id])[0];
}

const gesture = {
	split: (k: number): Step => ({
		label: `user: splits new terminal ${k}'s pane`,
		can: (w) => w.whereIs(k) !== null,
		run: (w) => w.ui.onSplit(w.whereIs(k) as string, "vertical"),
	}),
	splitTerminal: (channelId: string): Step => ({
		label: `user: splits ${nameOf(channelId)}'s pane`,
		can: (w) => w.paneIdOf(channelId) !== null,
		run: (w) => w.ui.onSplit(channelId, "vertical"),
	}),
	moveTerminalToNewTab: (channelId: string): Step => ({
		label: `user: moves ${nameOf(channelId)}'s pane to a new tab`,
		can: (w) => w.paneIdOf(channelId) !== null,
		run: (w) => w.ui.onMoveToNewTab(channelId, w.ui.layout.tabs.value.length),
	}),
	fillEmptySlot: (channelId: string): Step => ({
		label: `user: puts ${nameOf(channelId)} in the empty slot`,
		can: (w) => emptySlot(w) !== undefined,
		run: (w) => w.ui.onFillVacant(emptySlot(w) as string, channelId),
	}),
	moveToNewTab: (k: number): Step => ({
		label: `user: moves new terminal ${k}'s pane to a new tab`,
		can: (w) => w.whereIs(k) !== null,
		run: (w) => w.ui.onMoveToNewTab(w.whereIs(k) as string, w.ui.layout.tabs.value.length),
	}),
	dropBeside: (k: number, target: string, zone: DropZone): Step => ({
		label: `user: drops new terminal ${k}'s pane ${zone} of ${nameOf(target)}'s`,
		can: (w) => w.whereIs(k) !== null && w.paneIdOf(target) !== null,
		run: (w) => {
			const onto = w.paneIdOf(target) as { paneId: string; tabId: string };
			w.ui.onDropPane(w.whereIs(k) as string, onto.paneId, onto.tabId, zone);
		},
	}),
	close: (k: number): Step => ({
		label: `user: closes new terminal ${k}'s pane`,
		can: (w) => w.whereIs(k) !== null,
		run: (w) => w.ui.onClosePane(w.whereIs(k) as string),
	}),
	open: (channelId: string): Step => ({
		label: `user: opens ${nameOf(channelId)} in the pane from the sidebar`,
		run: (w) => w.ui.onSidebarOpenCurrentTab(channelId),
	}),
	openStarted: (k: number): Step => ({
		label: `user: opens what new terminal ${k} started in the pane, from the sidebar`,
		can: (w) => w.spawns.get(k)?.started.at(-1) !== undefined,
		run: (w) => w.ui.onSidebarOpenCurrentTab(w.spawns.get(k)?.started.at(-1)?.real as string),
	}),
	newTerminalInEmptySlot: (k: number): Step => ({
		label: `user: starts new terminal ${k} in the empty slot`,
		can: (w) => emptySlot(w) !== undefined,
		run: (w) => w.ui.onNewTerminalVacant(emptySlot(w) as string, hostOf(k)),
	}),
	retry: (k: number): Step => ({
		label: `user: clicks Retry on new terminal ${k}'s pane`,
		can: (w) => w.retryButtonOf(k) !== undefined,
		run: (w) => {
			const record = w.spawns.get(k) as SpawnRecord;
			const before = w.spawnsSentFor(record);
			record.retries++;
			(w.retryButtonOf(k) as HTMLButtonElement).click();
			// One Retry, one SPAWN, once the click has been handled.
			w.afterStep.push(() => {
				const sentNow = w.spawnsSentFor(record);
				if (sentNow !== before + 1) {
					w.violate("retry-lost", `Retry on P${k} sent ${sentNow - before} SPAWNs`, k);
				}
			});
		},
	}),
};

const newTerminalTab =
	(k: number) =>
	(w: World): void =>
		w.ui.openPendingTab(hostOf(k));
const terminalTab =
	(...channelIds: string[]) =>
	(w: World): void => {
		for (const id of channelIds) w.ui.layout.openTab(id);
	};

const SCENARIOS: Scenario[] = [
	{ name: "a new terminal", setUp: newTerminalTab(1), steps: [], holdConnect: true, maxPaths: 10 },
	{
		name: "a new terminal split while it starts",
		setUp: newTerminalTab(1),
		steps: [gesture.split(1)],
		holdConnect: true,
		maxPaths: 40,
		stillReaches: ["#980"],
	},
	{
		name: "a new terminal moved to a new tab",
		setUp: newTerminalTab(1),
		steps: [gesture.moveToNewTab(1)],
		holdConnect: true,
		maxPaths: 40,
		stillReaches: ["#980"],
	},
	{
		name: "a new terminal dropped beside another tab's terminal",
		setUp: (w) => {
			terminalTab(T)(w);
			newTerminalTab(1)(w);
		},
		steps: [gesture.dropBeside(1, T, "right")],
		maxPaths: 200,
		stillReaches: ["#980"],
	},
	{
		name: "a new terminal closed while it starts",
		setUp: newTerminalTab(1),
		steps: [gesture.close(1)],
		holdConnect: true,
		maxPaths: 20,
	},
	{
		name: "a new terminal given another terminal while it starts",
		setUp: newTerminalTab(1),
		steps: [gesture.open(U)],
		holdConnect: true,
		maxPaths: 20,
	},
	{
		name: "a new terminal given another, then given back what it started",
		setUp: newTerminalTab(1),
		steps: [gesture.open(U), gesture.openStarted(1)],
		maxPaths: 40,
	},
	{
		name: "a split's empty half given a new terminal",
		setUp: terminalTab(T),
		steps: [gesture.splitTerminal(T), gesture.newTerminalInEmptySlot(2)],
		maxPaths: 100,
	},
	{
		name: "two new terminals in one tab",
		setUp: newTerminalTab(1),
		steps: [gesture.split(1), gesture.newTerminalInEmptySlot(2)],
		maxPaths: 200,
		stillReaches: ["#980"],
	},
	{
		name: "a split's empty half given a terminal while the other half attaches",
		setUp: terminalTab(T),
		steps: [gesture.splitTerminal(T), gesture.fillEmptySlot(U)],
		maxPaths: 50,
	},
	{
		name: "a terminal's pane moved to a new tab while it attaches",
		setUp: terminalTab(T, U),
		steps: [gesture.moveTerminalToNewTab(T)],
		timeouts: true,
		maxPaths: 200,
	},
	{
		name: "a pane switched to another terminal and back",
		setUp: terminalTab(T),
		steps: [gesture.open(U), gesture.open(T)],
		timeouts: true,
		maxPaths: 1000,
	},
	{
		name: "Retry after a new terminal failed to start",
		setUp: newTerminalTab(1),
		steps: [gesture.retry(1)],
		timeouts: true,
		maxPaths: 100,
	},
	{
		name: "a terminal's query answered by xterm after the pane switched",
		setUp: terminalTab(U),
		steps: [gesture.open(T)],
		parseLater: true,
		prints: { channels: [U], query: true },
		maxPaths: 80,
		stillReaches: ["#966"],
	},
	{
		name: "a pane switched to a terminal that ends meanwhile",
		setUp: terminalTab(T),
		steps: [gesture.open(U)],
		prints: { channels: [U], query: false },
		ends: [U],
		maxPaths: 50,
	},
];

function report(violations: Violation[]): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const v of violations) {
		const key = `${v.kind}: ${v.detail}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push(`${key}\n    after: ${v.path.join(" → ")}`);
	}
	return lines.join("\n");
}

describe("TerminalPane across event orders (#984)", () => {
	for (const scenario of SCENARIOS) {
		it(`${scenario.name}: every order keeps the invariants`, async () => {
			const outcome = await explore(scenario);
			expect(outcome.exhausted, `more than ${scenario.maxPaths} orders`).toBe(true);
			expect(outcome.everyGesture, "a path that takes every gesture").toBe(true);
			const unknown = outcome.violations.filter((v) => v.known === undefined);
			expect(unknown, report(unknown)).toEqual([]);
			const reached = [...new Set(outcome.violations.map((v) => v.known))].sort();
			expect(reached, "the open defects it reaches").toEqual(scenario.stillReaches ?? []);
		}, 120_000);
	}
});
