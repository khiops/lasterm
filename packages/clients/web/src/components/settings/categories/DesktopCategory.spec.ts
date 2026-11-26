/**
 * Settings › Desktop's update rows (STORE-UPDATE-NOTICE, #1214): shown only for the Store build,
 * the selector following the desktop's state, the status lines, and errors where they happen.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useDesktopUpdatesStore } from "../../../stores/desktopUpdates.js";
import type { UpdateState } from "../../../utils/desktop-updates.js";
import DesktopCategory from "./DesktopCategory.vue";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

function eligible(overrides: Partial<UpdateState> = {}): UpdateState {
	return {
		seq: 1,
		eligible: true,
		mode: "auto",
		runningVersion: "0.24.0.0",
		checking: "idle",
		wantsDialog: false,
		notices: [],
		...overrides,
	};
}

let app: App | null = null;
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
	pinia = createPinia();
	setActivePinia(pinia);
	mocks.invoke.mockReset();
	mocks.invoke.mockImplementation(async (command: string) =>
		command === "get_close_behavior" ? "ask" : undefined,
	);
	mocks.listen.mockReset();
	mocks.listen.mockResolvedValue(() => undefined);
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = "";
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

async function mountCategory(state: UpdateState | null) {
	const store = useDesktopUpdatesStore();
	store.state = state;
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(DesktopCategory) });
	app.use(pinia);
	app.mount(root);
	await settle();
	return store;
}

const text = () => document.body.textContent ?? "";
const select = (): HTMLSelectElement => {
	const found = document.querySelectorAll<HTMLSelectElement>("select")[1];
	if (found === undefined) throw new Error("no update select");
	return found;
};
const button = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(element) => element.textContent?.trim() === label,
	);

describe("Settings › Desktop's update rows (AC-3)", () => {
	it("shows only the close row to a build that is not the Store's", async () => {
		await mountCategory({ ...eligible(), eligible: false });
		expect(text()).toContain("Window Close Behavior");
		expect(text()).not.toContain("Check for updates");
		expect(document.querySelectorAll("select")).toHaveLength(1);
	});

	it("shows the setting, the Store line, the version and the check to the Store build", async () => {
		await mountCategory(eligible());
		expect([...select().options].map((option) => option.textContent?.trim())).toEqual([
			"Notify me",
			"Leave updates to the Microsoft Store",
			"Don't check",
		]);
		expect(select().value).toBe("auto");
		expect(text()).toContain("it may also install them while Lasterm is closed");
		expect(text()).toContain("0.24.0");
		expect(text()).not.toContain("0.24.0.0");
		expect(text()).toContain("Not checked yet");
	});

	it("words each status from the state", async () => {
		const store = await mountCategory(eligible({ checking: "running" }));
		expect(text()).toContain("Checking…");
		store.state = eligible({ checking: "waiting" });
		await settle();
		expect(text()).toContain("Waiting for the Microsoft Store");
		store.state = eligible({ lastCheckedAt: "2026-11-26T10:00:00Z" });
		await settle();
		expect(text()).toContain("The Microsoft Store reports no update");
		store.state = eligible({
			storeError: "The Microsoft Store is not available on this computer right now",
		});
		await settle();
		expect(text()).toContain("The Microsoft Store is not available on this computer right now");
	});

	it("keeps a known offer and its buttons beside a failed check", async () => {
		await mountCategory(
			eligible({
				offer: { key: "k", version: "0.25.0", mandatory: false, signal: "true" },
				checkError: "The Microsoft Store did not answer",
				lastAttemptAt: "2026-11-26T10:00:00Z",
			}),
		);
		expect(text()).toContain("Lasterm 0.25.0 is available");
		expect(button("Update now…")).toBeDefined();
		expect(button("What's new")).toBeDefined();
		expect(text()).toContain("The last check failed: The Microsoft Store did not answer");
	});

	it("dates a failure when it was seen, not by the next attempt, and says the Store's absence once", async () => {
		const seen = "2026-11-26T10:00:00Z";
		const next = "2026-11-26T11:30:00Z";
		const store = await mountCategory(
			eligible({
				checking: "running",
				checkError: "The Microsoft Store could not answer (0x80072EE7)",
				checkFailedAt: seen,
				lastAttemptAt: next,
			}),
		);
		expect(text()).toContain(
			`The last check failed: The Microsoft Store could not answer (0x80072EE7) (${new Date(seen).toLocaleString()})`,
		);
		expect(text()).not.toContain(new Date(next).toLocaleString());

		const absent = "The Microsoft Store is not available on this computer right now";
		store.state = eligible({ storeError: absent, checkError: absent, checkFailedAt: seen });
		await settle();
		expect(text().split(absent)).toHaveLength(2);
	});

	it("follows the desktop's mode after a failed save, and is disabled while saving", async () => {
		let reject: (reason: unknown) => void = () => undefined;
		mocks.invoke.mockImplementation((command: string) => {
			if (command === "set_update_mode") {
				return new Promise((_resolve, rejectWith) => {
					reject = rejectWith;
				});
			}
			return Promise.resolve(command === "get_close_behavior" ? "ask" : undefined);
		});
		await mountCategory(eligible({ mode: "auto" }));
		select().value = "off";
		select().dispatchEvent(new Event("change"));
		await settle();
		expect(select().disabled).toBe(true);
		reject("failed to replace update preference");
		await settle();
		expect(select().disabled).toBe(false);
		expect(select().value).toBe("auto");
		expect(text()).toContain(
			"The update preference could not be saved: failed to replace update preference",
		);
	});

	it("opens the dialog from Update now… and shows a refused What's new there", async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "open_store_page") throw "The Microsoft Store could not be opened.";
			return command === "get_close_behavior" ? "ask" : undefined;
		});
		const store = await mountCategory(
			eligible({ offer: { key: "k", mandatory: false, signal: "true" } }),
		);
		button("Update now…")?.click();
		expect(store.openedFromSettings).toBe(true);
		button("What's new")?.click();
		await settle();
		expect(text()).toContain("The Microsoft Store could not be opened.");
	});
});
