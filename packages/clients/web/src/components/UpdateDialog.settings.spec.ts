/**
 * The update dialog with the real Settings panel and the real dialogs it yields to (#1214, AC-8
 * and AC-18). A file of its own: SettingsPanel.spec.ts stands in for DesktopCategory file-wide,
 * and App.spec.ts mounts the window outside the desktop runtime, where Settings hides its Desktop
 * category. Here the runtime is the desktop's, every other category is stood in for, and the
 * desktop's commands are answered by the test.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useDesktopUpdatesStore } from "../stores/desktopUpdates.js";
import { useSettingsStore } from "../stores/settings.js";
import type { UpdateState } from "../utils/desktop-updates.js";
import HubExitedModal from "./HubExitedModal.vue";
import SettingsPanel from "./settings/SettingsPanel.vue";
import UpdateDialog from "./UpdateDialog.vue";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const stubCategory = vi.hoisted(() => async () => {
	const { defineComponent, h: render } = await import("vue");
	return { default: defineComponent({ setup: () => () => render("div", "a category") }) };
});
vi.mock("./settings/categories/SchemaCategory.vue", stubCategory);
vi.mock("./settings/categories/AppearanceCategory.vue", stubCategory);
vi.mock("./settings/categories/WallpaperCategory.vue", stubCategory);
vi.mock("./settings/categories/EnvironmentCategory.vue", stubCategory);
vi.mock("./settings/categories/FileTransferCategory.vue", stubCategory);
vi.mock("./settings/categories/ElevationCategory.vue", stubCategory);
vi.mock("./settings/categories/AgentManagerCategory.vue", stubCategory);
vi.mock("./settings/categories/ConfirmationsCategory.vue", stubCategory);
vi.mock("./settings/ProfilesSettings.vue", stubCategory);

const KEY_25 = "O2CSI.Lasterm_0.25.0.0_x64__sx7tynvv0nmw4";

function eligible(overrides: Partial<UpdateState> = {}): UpdateState {
	return {
		seq: 1,
		eligible: true,
		mode: "off",
		runningVersion: "0.24.0.0",
		checking: "idle",
		offer: { key: KEY_25, version: "0.25.0", mandatory: false, signal: "true" },
		wantsDialog: false,
		notices: [],
		...overrides,
	};
}

let app: App | null = null;
let pinia: ReturnType<typeof createPinia>;
const settingsOpen = ref(false);
const hubExit = ref<number | null | undefined>(undefined);

beforeEach(() => {
	pinia = createPinia();
	setActivePinia(pinia);
	settingsOpen.value = false;
	hubExit.value = undefined;
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		configurable: true,
		value: { invoke: () => undefined },
	});
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	mocks.invoke.mockReset();
	mocks.invoke.mockImplementation(async (command: string) => {
		if (command === "get_close_behavior") return "ask";
		if (command === "is_tray_available") return true;
		if (command === "get_update_state") return useDesktopUpdatesStore().state;
		return undefined;
	});
	mocks.listen.mockReset();
	mocks.listen.mockResolvedValue(() => undefined);
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

async function mountAll(state: UpdateState) {
	const settings = useSettingsStore();
	vi.spyOn(settings, "loadCascade").mockResolvedValue();
	settings.activeCategory = "desktop";
	settings.activeScope = "global";
	const updates = useDesktopUpdatesStore();
	updates.state = state;
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () => [
			h(SettingsPanel, {
				visible: settingsOpen.value,
				onClose: () => (settingsOpen.value = false),
			}),
			h(HubExitedModal, { code: hubExit.value }),
			h(UpdateDialog),
		],
	});
	app.use(pinia);
	app.mount(root);
	await settle();
	return updates;
}

const updateDialog = () => document.querySelector<HTMLElement>("[data-update-dialog]");
const opener = () => document.querySelector<HTMLButtonElement>("[data-update-opener]");

describe("the update dialog opened from Settings › Desktop (AC-8)", () => {
	it("opens above the panel in mode off, takes the keyboard, and gives it back on close", async () => {
		await mountAll(eligible());
		settingsOpen.value = true;
		await settle();
		expect(opener()).not.toBeNull();
		opener()?.focus();
		opener()?.click();
		await settle();
		expect(updateDialog()).not.toBeNull();
		expect(document.querySelector(".settings-panel")).not.toBeNull();
		expect(updateDialog()?.contains(document.activeElement)).toBe(true);

		updateDialog()?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
		await settle();
		expect(updateDialog()).toBeNull();
		expect(document.querySelector(".settings-panel")).not.toBeNull();
		expect(document.activeElement).toBe(opener());
		expect(mocks.invoke.mock.calls.some(([command]) => command === "snooze_update")).toBe(false);
	});
});

describe("the update dialog yields to a dialog that comes after it (AC-18)", () => {
	it("hides for the hub-exited dialog without a snooze, and comes back when it goes", async () => {
		await mountAll(eligible({ mode: "ask", wantsDialog: true }));
		expect(updateDialog()).not.toBeNull();
		hubExit.value = 1;
		await settle();
		expect(updateDialog()).toBeNull();
		expect(mocks.invoke.mock.calls.some(([command]) => command === "snooze_update")).toBe(false);
		hubExit.value = undefined;
		await settle();
		expect(updateDialog()).not.toBeNull();
	});

	it("opened from Settings, comes back only while Settings and its Update now… are there", async () => {
		const updates = await mountAll(eligible());
		settingsOpen.value = true;
		await settle();
		opener()?.click();
		await settle();
		expect(updateDialog()).not.toBeNull();
		hubExit.value = 1;
		await settle();
		expect(updateDialog()).toBeNull();
		settingsOpen.value = false;
		await settle();
		hubExit.value = undefined;
		await settle();
		expect(updateDialog()).toBeNull();
		expect(updates.openedFromSettings).toBe(false);
	});
});
