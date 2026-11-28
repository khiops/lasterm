import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
	createFolderOpener,
	type FolderOpenerDeps,
	hasOpenFolderRequests,
	listenOpenFolderRequested,
	takeOpenFolderRequests,
} from "./desktop-open-folder.js";

describe("the desktop's folder commands", () => {
	beforeEach(() => {
		mocks.invoke.mockReset();
		mocks.listen.mockReset();
	});

	it("calls the commands and listens to the event the desktop registers", async () => {
		mocks.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(["C:\\A"]);
		expect(await hasOpenFolderRequests()).toBe(true);
		expect(mocks.invoke).toHaveBeenLastCalledWith("has_open_folder_requests", undefined);
		expect(await takeOpenFolderRequests("t1")).toEqual(["C:\\A"]);
		expect(mocks.invoke).toHaveBeenLastCalledWith("take_open_folder_requests", { token: "t1" });

		const unlisten = () => {};
		let handler: (() => void) | undefined;
		mocks.listen.mockImplementationOnce(async (_event: string, onEvent: () => void) => {
			handler = onEvent;
			return unlisten;
		});
		const onRequest = vi.fn();
		expect(await listenOpenFolderRequested(onRequest)).toBe(unlisten);
		expect(mocks.listen).toHaveBeenCalledWith("open-folder-requested", expect.any(Function));
		handler?.();
		expect(onRequest).toHaveBeenCalledTimes(1);
	});
});

describe("createFolderOpener", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sessionStorage.clear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Deps whose answers the test sets, recording what the opener did. */
	function fakeDeps() {
		const state = {
			usable: true,
			waiting: true,
			waitingRejects: false,
			waitingAsked: 0,
			queue: [] as string[],
			last: null as { token: string; batch: string[] } | null,
			takes: [] as string[],
			processed: [] as string[][],
			failProcessOnce: false,
			rereads: 0,
			shown: 0,
			hidden: 0,
			closeNotice: null as (() => void) | null,
			firstBatches: [] as boolean[],
			/** Runs while a take is in flight, before it answers. */
			duringTake: null as (() => void) | null,
		};
		const deps: FolderOpenerDeps = {
			ready: () => state.usable,
			waiting: async () => {
				state.waitingAsked += 1;
				if (state.waitingRejects) throw new Error("IPC failed");
				return state.waiting;
			},
			take: async (token) => {
				state.takes.push(token);
				state.duringTake?.();
				if (state.last?.token === token) return [...state.last.batch];
				const batch = state.queue.splice(0);
				state.last = { token, batch };
				return [...batch];
			},
			process: (folders) => {
				if (state.failProcessOnce) {
					state.failProcessOnce = false;
					throw new Error("processing failed");
				}
				state.processed.push(folders);
			},
			firstBatch: (nonEmpty) => {
				state.firstBatches.push(nonEmpty);
			},
			reload: () => {
				state.rereads += 1;
			},
			showWaitNotice: (onUserDismiss) => {
				state.shown += 1;
				state.closeNotice = onUserDismiss;
			},
			hideWaitNotice: () => {
				state.hidden += 1;
			},
		};
		return { state, deps };
	}

	it("takes a batch again, with its token, when processing it failed", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		opener.start(false);
		state.queue = ["C:\\A", "C:\\B"];
		state.failProcessOnce = true;
		await expect(opener.drain()).rejects.toThrow("processing failed");
		expect(opener.holdingBatch()).toBe(true);

		await opener.drain();
		expect(state.takes).toHaveLength(2);
		expect(state.takes[1]).toBe(state.takes[0]);
		expect(state.processed).toEqual([["C:\\A", "C:\\B"]]);
		expect(opener.holdingBatch()).toBe(false);
	});

	it("drops the pending re-read once a usable list let the folders open", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		opener.start(false);
		state.usable = false;
		state.queue = ["C:\\A"];
		await opener.drain();
		expect(state.takes).toEqual([]);

		state.usable = true;
		await opener.drain();
		expect(state.processed).toEqual([["C:\\A"]]);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(state.rereads).toBe(0);
	});

	it("takes a folder expected at startup at once on a usable list", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		state.queue = ["C:\\A"];
		opener.start(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.processed).toEqual([["C:\\A"]]);
		expect(state.shown).toBe(0);
	});

	it("says a folder expected at startup waits, and re-reads every 5 s whatever `waiting` answers", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		state.usable = false;
		state.queue = ["C:\\A"];
		state.waitingRejects = true;
		opener.start(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.shown).toBe(1);
		await vi.advanceTimersByTimeAsync(4_900);
		expect(state.rereads).toBe(0);
		await vi.advanceTimersByTimeAsync(200);
		expect(state.rereads).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.rereads).toBe(2);
		expect(state.takes).toEqual([]);

		state.usable = true;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.processed).toEqual([["C:\\A"]]);
		expect(state.hidden).toBe(1);
		// Done waiting: no further re-read.
		const rereads = state.rereads;
		await vi.advanceTimersByTimeAsync(11_000);
		expect(state.rereads).toBe(rereads);
	});

	it("only remembers a drain during the startup, and makes one pass when the startup ends", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		state.queue = ["C:\\A"];
		await opener.drain();
		await opener.drain();
		await opener.drain();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.takes).toEqual([]);

		opener.start(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.takes).toHaveLength(1);
		expect(state.processed).toEqual([["C:\\A"]]);
	});

	it("says nothing and asks nothing during the startup, and says a folder waits once it ends", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		state.usable = false;
		await opener.drain();
		await vi.advanceTimersByTimeAsync(6_000);
		expect(state.waitingAsked).toBe(0);
		expect(state.shown).toBe(0);
		expect(state.rereads).toBe(0);

		opener.start(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.shown).toBe(1);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(state.rereads).toBe(1);
	});

	it("asks again after an unknown startup answer, and shows the notice only for a folder that waits", async () => {
		const { state, deps } = fakeDeps();
		state.usable = false;
		state.waiting = false;
		createFolderOpener(deps).start(null);
		// No folder waits: nothing is said, and what is missing is asked for again, for the
		// startup's first batch.
		await vi.advanceTimersByTimeAsync(6_000);
		expect(state.waitingAsked).toBe(2);
		expect(state.shown).toBe(0);
		expect(state.rereads).toBe(1);

		state.waiting = true;
		const asked = state.waitingAsked;
		createFolderOpener(deps).start(null);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.waitingAsked).toBe(asked + 1);
		expect(state.shown).toBe(1);
	});

	it("keeps re-reading, without a notice, while it cannot tell whether a folder waits", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		state.usable = false;
		state.waitingRejects = true;
		opener.start(null);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(state.rereads).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.rereads).toBe(2);
		expect(state.shown).toBe(0);

		state.waitingRejects = false;
		state.usable = true;
		state.queue = ["C:\\A"];
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.processed).toEqual([["C:\\A"]]);
		expect(state.shown).toBe(0);
	});

	it("re-reads no list that became usable before its timer", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		opener.start(false);
		state.usable = false;
		state.queue = ["C:\\A"];
		await opener.drain();
		state.usable = true;
		await vi.advanceTimersByTimeAsync(5_100);
		expect(state.rereads).toBe(0);
	});

	it("shows the wait notice again for a later folder once the user closed it", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		opener.start(false);
		state.usable = false;
		await opener.drain();
		await opener.drain();
		expect(state.shown).toBe(1);

		state.closeNotice?.();
		await opener.drain();
		expect(state.shown).toBe(2);
	});

	it("shows no notice and takes nothing once stopped, and removes its notice", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		opener.start(false);
		state.usable = false;
		await opener.drain();
		expect(state.shown).toBe(1);
		opener.stop();
		expect(state.hidden).toBe(1);

		const later = createFolderOpener(deps);
		later.start(false);
		const pass = later.drain();
		later.stop();
		await pass;
		expect(state.shown).toBe(1);
	});
	it("says nothing waits when the batch taken as the list became unusable is empty", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		opener.start(false);
		state.duringTake = () => {
			state.usable = false;
		};
		await opener.drain();
		expect(state.takes).toHaveLength(1);
		expect(state.shown).toBe(0);
		expect(opener.holdingBatch()).toBe(false);
		expect(state.firstBatches).toEqual([false]);
	});

	it("keeps asking, silently, for what it lacks until the first batch the startup waits for", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		// The startup could not tell; the preferences are refused; no folder waits.
		state.usable = false;
		state.waiting = false;
		opener.start(null);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(state.rereads).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.rereads).toBe(2);
		expect(state.shown).toBe(0);

		state.usable = true;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.takes).toHaveLength(1);
		expect(state.firstBatches).toEqual([false]);
		const rereads = state.rereads;
		state.usable = false;
		await opener.drain();
		await vi.advanceTimersByTimeAsync(11_000);
		expect(state.rereads).toBe(rereads);
	});
	it("keeps an empty first batch, silently, while the startup's tabs wait for a usable list", async () => {
		const { state, deps } = fakeDeps();
		const opener = createFolderOpener(deps);
		state.duringTake = () => {
			state.usable = false;
		};
		// The startup could not tell; the list goes while the first take is in flight.
		opener.start(null);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.takes).toHaveLength(1);
		expect(state.firstBatches).toEqual([]);
		expect(state.shown).toBe(0);
		expect(opener.holdingBatch()).toBe(true);

		state.duringTake = null;
		state.usable = true;
		await vi.advanceTimersByTimeAsync(5_100);
		expect(state.takes).toHaveLength(2);
		expect(state.takes[1]).toBe(state.takes[0]);
		expect(state.firstBatches).toEqual([false]);
		expect(state.shown).toBe(0);
		expect(opener.holdingBatch()).toBe(false);
	});
});
