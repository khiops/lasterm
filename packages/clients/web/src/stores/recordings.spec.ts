// AC-UI-SAVE, AC-UI-STATE-ORDER, AC-UI-CAP (#80). New file: the recordings store is new.
import { recordingFileName } from "@lasterm/shared";
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
	answers: { list?: () => Response; parts?: string[]; failPart?: number; stop?: number } = {},
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
			const headers: Record<string, string> = {
				"X-Lasterm-Cast-Last-Seq": String(parts.length),
				"X-Lasterm-Cast-Lost": "0",
			};
			if (index + 1 < parts.length) headers["X-Lasterm-Cast-Next-Seq"] = String(index + 2);
			return new Response(parts[index], { status: 200, headers });
		}
		if (method === "DELETE") return new Response(null, { status: 204 });
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
			if (pickOpts !== undefined && "closeFails" in pickOpts)
				expect(state.writable?.aborted).toBe(true);
			if ("stop" in hubOpts) expect(requests.some((r) => r.includes("/cast"))).toBe(false);
		});

		// (f)
		it("downloads without the dialog, and keeps the hub's copy", async () => {
			const requests = hub();
			const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
			globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
			globalThis.URL.revokeObjectURL = vi.fn();
			await useRecordingsStore().save(rec, false);
			expect(click).toHaveBeenCalled();
			expect(requests.some((r) => r.startsWith("DELETE"))).toBe(false);
			click.mockRestore();
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
			expect(state.suggestedName).toBe(recordingFileName("build", "2026-11-22T10:00:00.900Z"));
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

		// AC-UI-CAP. Mutation caught: a refusal ignored.
		it("says when a terminal was not recorded for lack of space", () => {
			hub();
			useRecordingsStore().onState({
				type: "RECORDING_STATE",
				channelId: "ch-1",
				recordingId: null,
				refused: "cap",
			});
			expect(useToastStore().messages.at(-1)?.text).toContain(
				"recordings take all the space allowed",
			);
		});
	});
});
