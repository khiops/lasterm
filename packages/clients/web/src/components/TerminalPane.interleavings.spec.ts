/**
 * The pane lifecycle across event orders (#984).
 *
 * The window is the real `PaneLayout` over a real `useLayout()`, every tab
 * mounted under `v-show` and wired as `App.vue` wires it, so a split, a move or
 * a filled empty slot remounts `TerminalPane` as the app does. The hub is a
 * model: it holds every SPAWN and ATTACH the window sends and answers them in
 * any order, or lets them time out; it also prints. Each scenario is a short
 * sequence of user gestures, and every interleaving of those gestures with the
 * hub's answers is run, each from a fresh window, up to the scenario's bound.
 *
 * After every step and once the window is quiet, it checks:
 * 1. A binding has exactly one xterm: each pane holds one, and what an xterm
 *    answers by itself to a terminal's output goes to that terminal only.
 * 2. No pane is left spawning forever: once every request is answered or has
 *    timed out, no pane says "Connecting…".
 * 3. A reply is applied only to the pane and request it answers: a snapshot or
 *    output is written only into a pane showing its terminal, a SPAWN's answer
 *    replaces only the pending id it was sent for, and a pane shows the screen
 *    of the terminal it shows.
 * 4. No spawn is lost or doubled across remounts: one SPAWN per pending id, plus
 *    one per Retry; a spawn completing while its pending id is in the layout
 *    leaves its terminal in that place.
 *
 * Open defects it reaches are listed in `KNOWN`: their violations are kept out
 * of each scenario's verdict, and a test per defect says it is still reached.
 * Once a defect is fixed, that test fails: drop it and its entry.
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

type Kind =
	| "xterm-count"
	| "xterm-answer-to-other-terminal"
	| "left-connecting"
	| "written-into-other-pane"
	| "spawn-answer-to-other-pane"
	| "spawn-failure-on-other-terminal"
	| "shows-other-screen"
	| "spawn-doubled"
	| "spawn-lost"
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
	/** Each answered SPAWN: the terminal it started, and whether its pending id was in a layout then. */
	started: Array<{ real: string; inLayout: boolean }>;
	answered: boolean;
}

interface Step {
	label: string;
	run(world: World): void | Promise<void>;
}

interface Scenario {
	name: string;
	/** The window's layout before the first step, set as the window opens. */
	setUp(world: World): void;
	steps: Step[];
	/** The window's connection opens as a hub event, not at once. */
	holdConnect?: boolean;
	/** Ten seconds passing is a hub event: unanswered requests time out. */
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

const MARKER = /\[([A-Z][0-9]*)@(\d+)\]|<([A-Z][0-9]*)#(\d+)>/g;
const QUERY = "\u001b[6n";

class World {
	ui!: Gestures;
	path: string[] = [];
	violations: Violation[] = [];
	/** Indexes in `sent` of the requests answered, or given up on by a timeout. */
	done = new Set<number>();
	live = new Set<string>([T, U]);
	dead = new Set<string>([S]);
	spawns = new Map<number, SpawnRecord>();
	printed = new Set<string>();
	/** Each xterm answer to a query, and the terminal whose output asked it. */
	asks = new Map<string, string>();
	/** The terminal of the last marker each xterm took. */
	lastMarker = new Map<StandInTerminal, string>();
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
			answered: false,
		});
		return pendingId(k);
	}

	spawnOf(frame: Frame): SpawnRecord {
		const record = [...this.spawns.values()].find((s) => s.host === frame.hostId);
		if (record === undefined) throw new Error(`a SPAWN for no pending id: ${String(frame.hostId)}`);
		return record;
	}

	// --- What the window does, seen as it does it -----------------------------------

	onWrite(terminal: StandInTerminal, text: string): void {
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

	/** Bookkeeping after each step: spawns sent, pane instances over a pending id, input sent. */
	observe(): void {
		for (const check of this.afterStep.splice(0)) check();
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
		if (step !== undefined) {
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
			next.push({ label: "time: 10 s pass", run: (w) => w.timeout() });
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
		this.done.add(i);
		const attempt = sent
			.slice(0, i + 1)
			.filter((m) => m.type === "SPAWN" && m.hostId === record.host).length;
		if (ok) {
			const real = realId(record.k, attempt);
			this.live.add(real);
			const owed = this.inLayout(record.pending);
			record.started.push({ real, inLayout: owed });
			record.answered = true;
			hear({ type: "SPAWN_OK", channelId: real, requestId: frame.requestId });
			grantWriteLock(real);
			// Once the answer is taken: its terminal is where its pending id was.
			if (owed) {
				this.afterStep.push(() => {
					const placed = this.inLayout(real);
					const left = this.inLayout(record.pending);
					if (!placed || left) {
						this.violate(
							"spawn-lost",
							`P${record.k}'s spawn started ${nameOf(real)}, which ${placed ? "is" : "is not"} in the layout, with P${record.k} ${left ? "still there" : "gone"}`,
							record.k,
						);
					}
				});
			}
		} else {
			record.answered = true;
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

	timeout(): void {
		sent.forEach((frame, i) => {
			if (frame.type === "SPAWN" || frame.type === "ATTACH") this.done.add(i);
		});
		for (const record of this.spawns.values()) {
			if (sent.some((m) => m.type === "SPAWN" && m.hostId === record.host)) record.answered = true;
		}
		vi.advanceTimersByTime(10_001);
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
			const xterms = wrapper.querySelectorAll(".xterm");
			if (xterms.length !== 1)
				this.violate("xterm-count", `the pane showing ${name} holds ${xterms.length} xterms`);
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
			if (
				settled &&
				shown !== null &&
				this.live.has(shown) &&
				last !== undefined &&
				idOf(last) !== shown
			) {
				this.violate("shows-other-screen", `the pane showing ${name} shows ${last}'s screen`);
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

/** Run one path: take `prefix`'s choices, then the first choice at each further step. */
async function runPath(
	scenario: Scenario,
	prefix: number[],
): Promise<{ taken: number[]; widths: number[]; world: World }> {
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
	mountLayout(world);
	await settle();
	world.observe();

	const taken: number[] = [];
	const widths: number[] = [];
	let flushed = false;
	for (let depth = 0; depth < 200; depth++) {
		const choices = world.choices();
		if (choices.length === 0) {
			if (flushed) break;
			// Whatever the window still has on a timer runs: a request it sends then is a choice.
			flushed = true;
			vi.advanceTimersByTime(60_000);
			await settle();
			world.observe();
			continue;
		}
		flushed = false;
		const pick = prefix[taken.length] ?? 0;
		const choice = choices[pick] as Step;
		taken.push(pick);
		widths.push(choices.length);
		world.path.push(choice.label);
		await choice.run(world);
		await settle();
		world.observe();
	}
	world.checkQuiet();
	closePane();
	root.remove();
	vi.clearAllTimers();
	return { taken, widths, world };
}

interface Outcome {
	paths: number;
	exhausted: boolean;
	violations: Violation[];
}

/** Every order of `scenario`'s steps and the hub's answers, depth first, up to its bound. */
async function explore(scenario: Scenario): Promise<Outcome> {
	let prefix: number[] = [];
	let paths = 0;
	const violations: Violation[] = [];
	for (;;) {
		const { taken, widths, world } = await runPath(scenario, prefix);
		paths++;
		violations.push(...world.violations);
		let depth = taken.length - 1;
		while (depth >= 0 && (taken[depth] as number) + 1 >= (widths[depth] as number)) depth--;
		if (depth < 0) return { paths, exhausted: true, violations };
		if (paths >= scenario.maxPaths) return { paths, exhausted: false, violations };
		prefix = [...taken.slice(0, depth), (taken[depth] as number) + 1];
	}
}

// --- Gestures ---------------------------------------------------------------------

const gesture = {
	split: (k: number): Step => ({
		label: `user: splits new terminal ${k}'s pane`,
		run: (w) => {
			const at = w.whereIs(k);
			if (at !== null) w.ui.onSplit(at, "vertical");
		},
	}),
	splitTerminal: (channelId: string): Step => ({
		label: `user: splits ${nameOf(channelId)}'s pane`,
		run: (w) => w.ui.onSplit(channelId, "vertical"),
	}),
	moveTerminalToNewTab: (channelId: string): Step => ({
		label: `user: moves ${nameOf(channelId)}'s pane to a new tab`,
		run: (w) => w.ui.onMoveToNewTab(channelId, w.ui.layout.tabs.value.length),
	}),
	fillEmptySlot: (channelId: string): Step => ({
		label: `user: puts ${nameOf(channelId)} in the empty slot`,
		run: (w) => {
			const active = w.ui.layout.activeTab.value;
			const vacant = vacantIds(active === null ? null : w.ui.layout.layouts.value[active.id])[0];
			if (vacant !== undefined) w.ui.onFillVacant(vacant, channelId);
		},
	}),
	moveToNewTab: (k: number): Step => ({
		label: `user: moves new terminal ${k}'s pane to a new tab`,
		run: (w) => {
			const at = w.whereIs(k);
			if (at !== null) w.ui.onMoveToNewTab(at, w.ui.layout.tabs.value.length);
		},
	}),
	dropBeside: (k: number, target: string, zone: DropZone): Step => ({
		label: `user: drops new terminal ${k}'s pane ${zone} of ${nameOf(target)}'s`,
		run: (w) => {
			const at = w.whereIs(k);
			const onto = w.paneIdOf(target);
			if (at !== null && onto !== null) w.ui.onDropPane(at, onto.paneId, onto.tabId, zone);
		},
	}),
	close: (k: number): Step => ({
		label: `user: closes new terminal ${k}'s pane`,
		run: (w) => {
			const at = w.whereIs(k);
			if (at !== null) w.ui.onClosePane(at);
		},
	}),
	open: (channelId: string): Step => ({
		label: `user: opens ${nameOf(channelId)} in the pane from the sidebar`,
		run: (w) => w.ui.onSidebarOpenCurrentTab(channelId),
	}),
	openStarted: (k: number): Step => ({
		label: `user: opens what new terminal ${k} started in the pane, once it is listed`,
		run: (w) => {
			const real = w.spawns.get(k)?.started.at(-1)?.real;
			if (real !== undefined) w.ui.onSidebarOpenCurrentTab(real);
		},
	}),
	newTerminalInEmptySlot: (k: number): Step => ({
		label: `user: starts new terminal ${k} in the empty slot`,
		run: (w) => {
			const active = w.ui.layout.activeTab.value;
			const vacant = vacantIds(active === null ? null : w.ui.layout.layouts.value[active.id])[0];
			if (vacant !== undefined) w.ui.onNewTerminalVacant(vacant, hostOf(k));
		},
	}),
	retry: (k: number): Step => ({
		label: `user: clicks Retry on new terminal ${k}'s pane`,
		run: async (w) => {
			const at = w.paneIdOf(pendingId(k));
			const wrapper = at === null ? null : root.querySelector(`[data-pane-id="${at.paneId}"]`);
			const retry = [...(wrapper?.querySelectorAll("button") ?? [])].find((b) =>
				["Retry", "Connect"].includes(b.textContent?.trim() ?? ""),
			);
			if (retry === undefined) return;
			const record = w.spawns.get(k);
			if (record !== undefined) record.retries++;
			retry.click();
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
		maxPaths: 100,
	},
	{
		name: "a pane switched to another terminal and back",
		setUp: terminalTab(T),
		steps: [gesture.open(U), gesture.open(T)],
		timeouts: true,
		maxPaths: 200,
	},
	{
		name: "Retry after a new terminal failed to start",
		setUp: newTerminalTab(1),
		steps: [gesture.retry(1)],
		timeouts: true,
		maxPaths: 30,
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
			const unknown = outcome.violations.filter((v) => v.known === undefined);
			expect(unknown, report(unknown)).toEqual([]);
			const reached = [...new Set(outcome.violations.map((v) => v.known))].sort();
			expect(reached, "the open defects it reaches").toEqual(scenario.stillReaches ?? []);
		}, 120_000);
	}
});
