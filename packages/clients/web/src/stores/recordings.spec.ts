// AC-UI-SAVE, AC-UI-STATE-ORDER, AC-UI-CAP (#80). New file: the recordings store is new.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { setHubPortForTests } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { type RecordingRow, useRecordingsStore } from "./recordings.js";
import { useToastStore } from "./toast.js";

const ID = "01K80REC000000000000000000";

function row(over: Partial<RecordingRow> = {}): RecordingRow {
	return {
		id: ID,
		channel_id: "ch-1",
		host_label: "pi",
		title: "build",
		started_at: "2026-11-22T10:00:00.000Z",
		ended_at: null,
		end_reason: null,
		cols: 80,
		rows: 24,
		duration_ms: 0,
		bytes: 0,
		...over,
	};
}

/** The hub's answers, and every request in the order sent. */
function hub(
	answers: {
		list?: () => Response;
		parts?: string[];
		failPart?: number;
		stop?: number;
		/** The export's cursor headers kept from the page, as a cross-origin page without them exposed. */
		noCursor?: boolean;
		deleteStatus?: number;
		/** The export's last seq, when not the number of parts (a recording without blocks: 0). */
		lastSeq?: string;
	} = {},
) {
	const requests: string[] = [];
	mocks.hubFetch.mockImplementation(async (url, init) => {
		const u = new URL(url, "http://hub.test");
		const method = init?.method ?? "GET";
		requests.push(`${method} ${u.pathname}${u.search}`);
		if (u.pathname === "/api/recordings" && method === "GET") {
			return answers.list?.() ?? Response.json({ recordings: [], used_bytes: 0, cap_bytes: 1024 });
		}
		if (u.pathname.endsWith("/stop")) return new Response("{}", { status: answers.stop ?? 200 });
		if (u.pathname.endsWith("/cast")) {
			const parts = answers.parts ?? ["header\n"];
			const index = u.searchParams.has("from_seq") ? Number(u.searchParams.get("from_seq")) - 1 : 0;
			if (answers.failPart === index) return new Response("", { status: 404 });
			const headers: Record<string, string> = answers.noCursor
				? {}
				: {
						"X-Lasterm-Cast-Last-Seq": answers.lastSeq ?? String(parts.length),
						"X-Lasterm-Cast-Lost": "0",
					};
			if (!answers.noCursor && index + 1 < parts.length)
				headers["X-Lasterm-Cast-Next-Seq"] = String(index + 2);
			return new Response(parts[index], { status: 200, headers });
		}
		if (method === "DELETE") return new Response(null, { status: answers.deleteStatus ?? 204 });
		return new Response("{}", { status: 200 });
	});
	return requests;
}

interface FakeWritable {
	written: string[];
	closed: boolean;
	aborted: boolean;
	write: (d: string) => Promise<void>;
	close: () => Promise<void>;
	abort: () => Promise<void>;
}

function picker(opts: { cancel?: boolean; writeFails?: boolean; closeFails?: boolean } = {}) {
	const state: { calledBeforeAwait: boolean; suggestedName?: string; writable?: FakeWritable } = {
		calledBeforeAwait: false,
	};
	let sync = true;
	queueMicrotask(() => {
		sync = false;
	});
	const fn = vi.fn(async (options: { suggestedName: string }) => {
		state.calledBeforeAwait = sync && mocks.hubFetch.mock.calls.length === 0;
		state.suggestedName = options.suggestedName;
		if (opts.cancel) throw new DOMException("cancelled", "AbortError");
		const writable: FakeWritable = {
			written: [],
			closed: false,
			aborted: false,
			write: async (d) => {
				if (opts.writeFails) throw new Error("disk");
				writable.written.push(d);
			},
			close: async () => {
				if (opts.closeFails) throw new Error("close");
				writable.closed = true;
			},
			abort: async () => {
				writable.aborted = true;
			},
		};
		state.writable = writable;
		return { createWritable: async () => writable };
	});
	(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = fn;
	return state;
}

describe("recordings store", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		setHubPortForTests(4100);
		useAuthStore().setToken("bearer-1");
		mocks.hubFetch.mockReset();
	});

	afterEach(() => {
		delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});

	const settle = () => new Promise((r) => setTimeout(r, 0));

	describe("save", () => {
		const rec = { id: ID, title: "build", startedAt: "2026-11-22T10:00:00.000Z" };

		// (a) Mutations caught: the picker after the fetch; DELETE before close.
		it("opens the dialog first, stops, writes every part, closes, then deletes", async () => {
			const requests = hub({ parts: ["header\n", "part-2\n", "part-3\n"] });
			const state = picker();
			await useRecordingsStore().save(rec, true);
			expect(state.calledBeforeAwait).toBe(true);
			expect(state.writable?.written).toEqual(["header\n", "part-2\n", "part-3\n"]);
			expect(state.writable?.closed).toBe(true);
			const order = requests.filter((r) => r !== "GET /api/recordings");
			expect(order).toEqual([
				`POST /api/recordings/${ID}/stop`,
				`GET /api/recordings/${ID}/cast`,
				`GET /api/recordings/${ID}/cast?from_seq=2&last_seq=3&lost=0`,
				`GET /api/recordings/${ID}/cast?from_seq=3&last_seq=3&lost=0`,
				`DELETE /api/recordings/${ID}`,
			]);
		});

		it("says so when the dialog cannot open for another reason, and sends nothing", async () => {
			const requests = hub();
			(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => {
				throw new DOMException("denied", "SecurityError");
			});
			await useRecordingsStore().save(rec, true);
			expect(requests).toEqual([]);
			expect(useToastStore().messages.at(-1)?.text).toContain("The save dialog could not open");
		});

		it("(b) sends nothing when the dialog is cancelled", async () => {
			const requests = hub();
			picker({ cancel: true });
			await useRecordingsStore().save(rec, true);
			expect(requests).toEqual([]);
		});

		// (c)-(e), (h). Mutation caught: DELETE after a failure.
		it.each([
			["a part's fetch fails", { failPart: 1 }, {}],
			["a write fails", {}, { writeFails: true }],
			["close fails", {}, { closeFails: true }],
			["the stop fails", { stop: 500 }, {}],
		])("deletes nothing when %s", async (_label, hubOpts, pickOpts) => {
			const requests = hub({ parts: ["header\n", "part-2\n"], ...hubOpts });
			const state = picker(pickOpts);
			await useRecordingsStore().save(rec, true);
			expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
			expect(useToastStore().messages.at(-1)?.text).toBe(
				"The recording could not be saved. It is still in Recordings.",
			);
			// Every failure after the dialog aborts the file it opened.
			expect(state.writable?.aborted).toBe(true);
			if ("stop" in hubOpts) expect(requests.some((r) => r.includes("/cast"))).toBe(false);
		});

		// Mutation caught: the export's first part taken as the whole when its cursor is missing.
		it("deletes nothing when the export's cursor headers do not reach the page", async () => {
			const requests = hub({ parts: ["header\n", "part-2\n"], noCursor: true });
			const state = picker();
			await useRecordingsStore().save(rec, true);
			expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
			expect(state.writable?.closed).toBe(false);
			expect(state.writable?.aborted).toBe(true);
		});

		// Mutation caught: a failed DELETE after the save left unsaid.
		it("says so when the copy cannot be removed after a save", async () => {
			hub({ deleteStatus: 500 });
			const state = picker();
			await useRecordingsStore().save(rec, true);
			expect(state.writable?.closed).toBe(true);
			expect(useToastStore().messages.at(-1)?.text).toBe(
				"The recording was saved, but its copy could not be removed from Recordings.",
			);
		});

		// (f) Mutation caught: the URL revoked in the same turn as the click.
		it("downloads without the dialog, and keeps the hub's copy", async () => {
			const requests = hub();
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			const { createObjectURL, revokeObjectURL } = globalThis.URL;
			const revoke = vi.fn();
			globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
			globalThis.URL.revokeObjectURL = revoke;
			try {
				await useRecordingsStore().save(rec, false);
				expect(click).toHaveBeenCalled();
				expect(revoke).not.toHaveBeenCalled();
				expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
			} finally {
				click.mockRestore();
				globalThis.URL.createObjectURL = createObjectURL;
				globalThis.URL.revokeObjectURL = revokeObjectURL;
			}
		});

		// AC-EMPTY-EXPORT: a recording without blocks exports its header alone, with
		// last seq 0, and Save deletes the copy. Mutation caught: a cursor of "0"
		// taken as missing.
		it("saves a recording without blocks, then deletes the copy", async () => {
			const requests = hub({ parts: ["header\n"], lastSeq: "0" });
			const state = picker();
			await useRecordingsStore().save(rec, false);
			expect(state.writable?.written).toEqual(["header\n"]);
			expect(state.writable?.closed).toBe(true);
			expect(requests).toContain(`DELETE /api/recordings/${ID}`);
		});

		// (g) The pane suggests the hub's name from what RECORDING_STATE said.
		it("suggests the hub's file name for a recording never listed", async () => {
			hub();
			const state = picker();
			const store = useRecordingsStore();
			store.onState({
				type: "RECORDING_STATE",
				channelId: "ch-1",
				recordingId: ID,
				title: "build",
				hostLabel: "pi",
				startedAt: "2026-11-22T10:00:00.900Z",
			});
			const open = store.open.get("ch-1");
			if (!open) throw new Error("not open");
			await store.save(
				{ id: open.recordingId, title: open.title, startedAt: open.startedAt },
				true,
			);
			expect(state.suggestedName).toBe("lasterm-build-20261122-100000.cast");
		});
	});

	describe("which terminals record", () => {
		it("knows a terminal records before its channel is known", () => {
			hub();
			const store = useRecordingsStore();
			store.onState({
				type: "RECORDING_STATE",
				channelId: "not-listed-yet",
				recordingId: ID,
				title: "t",
				hostLabel: "pi",
				startedAt: "2026-11-22T10:00:00.000Z",
			});
			expect(store.open.get("not-listed-yet")?.recordingId).toBe(ID);
		});

		// Mutation caught: a list answer older than the news replacing it.
		it("keeps news heard during a list fetch over the older answer", async () => {
			let release!: () => void;
			mocks.hubFetch.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = () =>
							resolve(Response.json({ recordings: [row()], used_bytes: 0, cap_bytes: 1 }));
					}),
			);
			const store = useRecordingsStore();
			const fetch = store.refresh();
			hub();
			store.onState({
				type: "RECORDING_STATE",
				channelId: "ch-1",
				recordingId: null,
				endReason: "stopped",
			});
			release();
			await fetch;
			await settle();
			expect(store.open.has("ch-1")).toBe(false);
		});

		// Mutations caught: resync of the active host only; open rows added without removing ended ones.
		it("rebuilds every host's state from the list after a reconnection", async () => {
			hub({
				list: () =>
					Response.json({
						recordings: [
							row({ id: "A", channel_id: "other-host" }),
							row({ id: "B", channel_id: "ended", ended_at: "x" }),
						],
						used_bytes: 0,
						cap_bytes: 1,
					}),
			});
			const store = useRecordingsStore();
			store.open.set("ended", { recordingId: "B", title: "", hostLabel: "", startedAt: "" });
			await store.refresh();
			expect(store.open.get("other-host")?.recordingId).toBe("A");
			expect(store.open.has("ended")).toBe(false);
		});

		// AC-UI-CAP. Mutation caught: a refusal ignored, or a toast that does not name the terminal.
		it("says which terminal was not recorded for lack of space", () => {
			hub();
			useRecordingsStore().onState({
				type: "RECORDING_STATE",
				channelId: "ch-1",
				recordingId: null,
				title: "build",
				refused: "cap",
			});
			expect(useToastStore().messages.at(-1)?.text).toBe(
				"“build” was not recorded: recordings take all the space allowed. Save or discard some in Recordings.",
			);
		});

		// K1/CONC2: an older list answer arriving last changes nothing.
		// Mutation caught: one list fetch per state, a reconnection's burst of them included.
		it("reads the list once for a burst of states, each in its own message", async () => {
			vi.useFakeTimers();
			const requests = hub();
			const store = useRecordingsStore();
			for (const channelId of ["ch-1", "ch-2", "ch-3"]) {
				await vi.advanceTimersByTimeAsync(20); // each message is its own task
				store.onState({
					type: "RECORDING_STATE",
					channelId,
					recordingId: `01REC-${channelId}`,
					title: "t",
					hostLabel: "h",
					startedAt: "2026-11-22T10:00:00.000Z",
				});
			}
			await vi.advanceTimersByTimeAsync(150);
			vi.useRealTimers();
			expect(requests.filter((r) => r === "GET /api/recordings")).toHaveLength(1);
		});

		// Each connect registers again on the same client. Mutation caught: a
		// second handler, which shows every refusal twice.
		it("handles each state once when its client registers again", () => {
			const handlers: Array<(msg: { type: string }) => void> = [];
			const socket = {
				on: (_type: string, fn: (msg: { type: string }) => void) => handlers.push(fn),
			};
			const store = useRecordingsStore();
			store.registerHandlers(socket as never);
			store.registerHandlers(socket as never);
			expect(handlers).toHaveLength(1);
		});

		// AC-UI-STATE-ORDER: the list is the one source, so a read that fails is
		// tried again until one succeeds (agreed with Codex on CTR1).
		describe("when the list cannot be read", () => {
			const listed = () =>
				Response.json({
					recordings: [row({ id: "01RECNEW", channel_id: "ch-new" })],
					used_bytes: 0,
					cap_bytes: 1024,
				});
			const stale = {
				recordingId: "01RECOLD",
				title: "t",
				hostLabel: "h",
				startedAt: "2026-11-22T10:00:00.000Z",
			};
			const lists = (requests: string[]) =>
				requests.filter((r) => r === "GET /api/recordings").length;

			beforeEach(() => {
				vi.useFakeTimers();
				vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: the delays as written
			});
			afterEach(() => {
				vi.useRealTimers();
			});

			// Mutation caught: a failed read left as it is until the next event.
			it("reads it again, restoring a missed start and removing a missed end with no other event", async () => {
				const answers = [() => new Response("", { status: 503 }), listed];
				const requests = hub({ list: () => (answers.shift() ?? listed)() });
				const store = useRecordingsStore();
				store.open = new Map([["ch-old", stale]]);
				await store.refresh();
				expect(store.open.has("ch-old")).toBe(true);
				await vi.advanceTimersByTimeAsync(999);
				expect(lists(requests)).toBe(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(lists(requests)).toBe(2);
				expect([...store.open.keys()]).toEqual(["ch-new"]);
			});

			it("tries again after 1 s, 2 s, 4 s, and never waits more than 30 s", async () => {
				const requests = hub({ list: () => new Response("", { status: 503 }) });
				await useRecordingsStore().refresh();
				for (const [wait, total] of [
					[1000, 2],
					[2000, 3],
					[4000, 4],
					[8000, 5],
					[16000, 6],
					[30000, 7],
					[30000, 8],
				] as const) {
					await vi.advanceTimersByTimeAsync(wait - 1);
					expect(lists(requests)).toBe(total - 1);
					await vi.advanceTimersByTimeAsync(1);
					expect(lists(requests)).toBe(total);
				}
			});

			it("tries again when the answer is not a list", async () => {
				const answers = [() => Response.json({}), listed];
				const requests = hub({ list: () => (answers.shift() ?? listed)() });
				const store = useRecordingsStore();
				await store.refresh();
				await vi.advanceTimersByTimeAsync(1000);
				expect(lists(requests)).toBe(2);
				expect(store.open.has("ch-new")).toBe(true);
			});

			it("tries again when a read never answers", async () => {
				let first = true;
				const requests = hub({
					list: () => {
						if (first) {
							first = false;
							return new Promise<Response>(() => {}) as never;
						}
						return listed();
					},
				});
				const store = useRecordingsStore();
				void store.refresh();
				await vi.advanceTimersByTimeAsync(15000); // its deadline
				await vi.advanceTimersByTimeAsync(1000); // then the first wait
				expect(lists(requests)).toBe(2);
				expect(store.open.has("ch-new")).toBe(true);
			});

			// Mutation caught: a try of an older chain going on beside the new one.
			it("leaves one chain of tries: a newer read takes over", async () => {
				const requests = hub({ list: () => new Response("", { status: 503 }) });
				const store = useRecordingsStore();
				await store.refresh(); // fails: a try in 1 s
				await vi.advanceTimersByTimeAsync(500);
				await store.refresh(); // fails too: its own try in 1 s
				await vi.advanceTimersByTimeAsync(1000);
				expect(lists(requests)).toBe(3); // the two reads and one try, not two
			});

			// Mutation caught: tries going on after the connection is let go.
			it("stops trying once the connection is let go", async () => {
				const requests = hub({ list: () => new Response("", { status: 503 }) });
				const store = useRecordingsStore();
				await store.refresh();
				store.stopRetrying();
				await vi.advanceTimersByTimeAsync(60000);
				expect(lists(requests)).toBe(1);
			});

			// Mutation caught: a read answered after the connection was let go applied.
			it("applies nothing read before the connection was let go", async () => {
				let answer: (r: Response) => void = () => {};
				hub({ list: () => new Promise<Response>((resolve) => (answer = resolve)) as never });
				const store = useRecordingsStore();
				store.open = new Map([["ch-old", stale]]);
				const reading = store.refresh();
				await vi.advanceTimersByTimeAsync(0);
				store.stopRetrying();
				answer(listed());
				await reading;
				expect([...store.open.keys()]).toEqual(["ch-old"]);
			});
		});

		it("drops a list answer older than one already applied", async () => {
			const answers: Array<(r: Response) => void> = [];
			mocks.hubFetch.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
			const store = useRecordingsStore();
			const older = store.refresh();
			const newer = store.refresh();
			answers[1]?.(Response.json({ recordings: [], used_bytes: 0, cap_bytes: 1 }));
			await newer;
			answers[0]?.(Response.json({ recordings: [row()], used_bytes: 0, cap_bytes: 1 }));
			await older;
			expect(store.rows).toEqual([]);
			expect(store.open.has("ch-1")).toBe(false);
		});

		it("says so when the hub does not answer a start", async () => {
			mocks.hubFetch.mockRejectedValue(new TypeError("network"));
			await useRecordingsStore().start("ch-1");
			expect(useToastStore().messages.at(-1)?.text).toBe(
				"The recording could not start: the hub did not answer.",
			);
		});
	});
});
