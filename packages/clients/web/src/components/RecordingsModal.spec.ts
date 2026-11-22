// AC-UI-LIST (#80): the list, Discard behind a confirmation, the privacy line.
// New file: the modal is new.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

vi.mock("../utils/hub-fetch.js", () => ({
	hubFetch: vi.fn(async () => Response.json({ recordings: [], used_bytes: 0, cap_bytes: 0 })),
}));

import { type RecordingRow, useRecordingsStore } from "../stores/recordings.js";
import RecordingsModal from "./RecordingsModal.vue";

let app: App | null = null;

const ROW: RecordingRow = {
	id: "01K80REC000000000000000000",
	channel_id: "ch-1",
	host_label: "pi",
	title: "build",
	started_at: "2026-11-22T10:00:00.000Z",
	ended_at: "2026-11-22T10:05:00.000Z",
	end_reason: "exited",
	cols: 80,
	rows: 24,
	duration_ms: 300_000,
	bytes: 2048,
};

function buttonByText(text: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(b) => b.textContent?.trim() === text,
	);
}

describe("RecordingsModal", () => {
	let store: ReturnType<typeof useRecordingsStore>;

	beforeEach(async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		store = useRecordingsStore();
		vi.spyOn(store, "refresh").mockResolvedValue();
		store.rows = [ROW];
		store.usedBytes = 2048;
		store.capBytes = 1024 * 1024;
		const root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(RecordingsModal) });
		app.use(pinia);
		app.mount(root);
		await nextTick();
	});

	afterEach(() => {
		app?.unmount();
		app = null;
		document.body.replaceChildren();
	});

	it("lists what waits, and says what a recording holds", () => {
		const text = document.body.textContent ?? "";
		expect(text).toContain("build");
		expect(text).toContain("pi");
		expect(text).toContain(
			"A recording holds everything the terminal printed, secrets included. It stays on this computer.",
		);
	});

	// Mutation caught: Discard without a confirmation.
	it("discards only after asking", async () => {
		const discard = vi.spyOn(store, "discard").mockResolvedValue(true);
		buttonByText("Discard")?.click();
		await nextTick();
		expect(discard).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Discard this recording?");
		const confirm = [
			...document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"),
		].find((b) => b.textContent?.trim() === "Discard");
		confirm?.click();
		await nextTick();
		expect(discard).toHaveBeenCalledWith(ROW.id);
	});

	// AC-PLAYER-PARSE / too-large. Mutation caught: the file read before its size is checked.
	it("refuses a file over 1 GiB without reading it", async () => {
		const input = document.querySelector<HTMLInputElement>(".rec-file");
		const file = new File(["x"], "big.cast");
		Object.defineProperty(file, "size", { value: 1024 * 1024 * 1024 + 1 });
		const read = vi.spyOn(file, "text");
		Object.defineProperty(input, "files", { value: [file], configurable: true });
		input?.dispatchEvent(new Event("change"));
		await nextTick();
		expect(read).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("This file is larger than 1 GiB");
	});

	it("says full when the space is used up", async () => {
		store.usedBytes = store.capBytes;
		await nextTick();
		expect(document.querySelector(".rec-usage--full")?.textContent).toContain("Full");
	});
});
