/**
 * The desktop's update dialog and its notices (STORE-UPDATE-NOTICE, #1214): when it shows, what
 * each button asks the desktop, its keyboard, and the notices shown once as toasts.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useDesktopUpdatesStore } from "../stores/desktopUpdates.js";
import { useToastStore } from "../stores/toast.js";
import { connectUpdateState, type UpdateState } from "../utils/desktop-updates.js";
import UpdateDialog from "./UpdateDialog.vue";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	/** The native window, as `@tauri-apps/api/window` gives it. */
	win: {
		isVisible: vi.fn(),
		isMinimized: vi.fn(),
		onResized: vi.fn(),
		onFocusChanged: vi.fn(),
	},
	windowEvents: [] as (() => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.win }));

const KEY_25 = "O2CSI.Lasterm_0.25.0.0_x64__sx7tynvv0nmw4";
const KEY_26 = "O2CSI.Lasterm_0.26.0.0_x64__sx7tynvv0nmw4";

/** An eligible state; `offer: null` leaves the offer out. */
function eligible(
	overrides: Omit<Partial<UpdateState>, "offer"> & { offer?: UpdateState["offer"] | null } = {},
): UpdateState {
	const { offer, ...rest } = overrides;
	const state: UpdateState = {
		seq: 1,
		eligible: true,
		mode: "ask",
		runningVersion: "0.24.0.0",
		checking: "idle",
		offer: { key: KEY_25, version: "0.25.0", mandatory: false, signal: "true" },
		wantsDialog: true,
		notices: [],
		...rest,
	};
	if (offer === null) delete state.offer;
	else if (offer !== undefined) state.offer = offer;
	return state;
}

let app: App | null = null;
let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
	pinia = createPinia();
	setActivePinia(pinia);
	mocks.invoke.mockReset();
	mocks.invoke.mockResolvedValue(undefined);
	mocks.listen.mockReset();
	mocks.windowEvents.length = 0;
	mocks.win.isVisible.mockReset().mockResolvedValue(true);
	mocks.win.isMinimized.mockReset().mockResolvedValue(false);
	for (const subscribe of [mocks.win.onResized, mocks.win.onFocusChanged]) {
		subscribe.mockReset().mockImplementation(async (handler: () => void) => {
			mocks.windowEvents.push(handler);
			return () => undefined;
		});
	}
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = "";
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

/** The page runs in the desktop app, whose window the dialog follows. */
function inDesktop(): void {
	Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
}

/** The window moved: minimized, restored, hidden or shown again. */
function windowEvent(): void {
	for (const handler of mocks.windowEvents) handler();
}

/** Lets the dynamic imports, the commands and Vue's updates run their course. */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

async function mountDialog(state: UpdateState | null) {
	const store = useDesktopUpdatesStore();
	store.state = state;
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(UpdateDialog) });
	app.use(pinia);
	app.mount(root);
	await settle();
	return store;
}

const dialog = () => document.querySelector<HTMLElement>("[data-update-dialog]");
const button = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("[data-update-dialog] button")].find(
		(element) => element.textContent?.trim() === label,
	);
const invoked = (command: string) =>
	mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

describe("when the update dialog shows (AC-8)", () => {
	it("waits for another modal dialog and for a hidden window, then shows", async () => {
		const other = document.createElement("div");
		other.setAttribute("aria-modal", "true");
		document.body.appendChild(other);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await mountDialog(eligible());
		expect(dialog()).toBeNull();

		other.remove();
		await settle();
		expect(dialog()).toBeNull();

		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(dialog()).not.toBeNull();
	});

	it("hides, unsnoozed, for a dialog that comes after it, and comes back", async () => {
		await mountDialog(eligible());
		expect(dialog()).not.toBeNull();
		const prompt = document.createElement("div");
		prompt.setAttribute("aria-modal", "true");
		prompt.setAttribute("aria-label", "SSH password");
		document.body.appendChild(prompt);
		await settle();
		expect(dialog()).toBeNull();
		expect(invoked("snooze_update")).toEqual([]);
		prompt.remove();
		await settle();
		expect(dialog()).not.toBeNull();
	});

	it("does not show by itself when the desktop does not want it", async () => {
		await mountDialog(eligible({ wantsDialog: false }));
		expect(dialog()).toBeNull();
	});

	it("opened from Settings, shows above the Settings panel in every mode", async () => {
		const settings = document.createElement("div");
		settings.className = "settings-panel";
		settings.setAttribute("aria-modal", "true");
		const opener = document.createElement("button");
		opener.setAttribute("data-update-opener", "");
		settings.appendChild(opener);
		document.body.appendChild(settings);
		const store = await mountDialog(eligible({ mode: "off", wantsDialog: false }));
		expect(dialog()).toBeNull();
		store.openFromSettings();
		await settle();
		expect(dialog()).not.toBeNull();
	});

	it("carries the sessions warning, which describes it", async () => {
		await mountDialog(eligible());
		const body = document.getElementById("update-dialog-body");
		expect(dialog()?.getAttribute("aria-describedby")).toBe("update-dialog-body");
		expect(document.querySelector(".update-sessions")?.textContent).toBe(
			"Installing the update may close Lasterm, or the Microsoft Store may ask you to close it. Save your work first: terminals on this computer can end, whoever is viewing them, and file transfers in progress stop. Terminals kept by a Lasterm agent on another host usually keep running (a host that ends a user's processes at logout may end them): select the host after the update to reattach them. Other SSH terminals end.",
		);
		expect(body?.textContent).toContain("Update now opens the Microsoft Store");
		expect(dialog()?.querySelector("#update-dialog-title")?.textContent).toBe(
			"Lasterm 0.25.0 is available",
		);
	});

	it("names no version when the Store's entry does not give a higher one", async () => {
		await mountDialog(eligible({ offer: { key: KEY_25, mandatory: false, signal: "true" } }));
		expect(dialog()?.querySelector("#update-dialog-title")?.textContent).toBe(
			"A newer version of Lasterm is available",
		);
	});
});

describe("the update dialog's buttons (AC-9)", () => {
	it("Update now opens the Store's updates page, then snoozes the shown offer and closes", async () => {
		mocks.invoke.mockImplementation(async (command: string) =>
			command === "snooze_update" ? true : undefined,
		);
		const store = await mountDialog(eligible());
		button("Update now")?.click();
		await settle();
		expect(mocks.invoke.mock.calls.map(([name]) => name)).toEqual([
			"open_store_updates",
			"snooze_update",
		]);
		expect(invoked("snooze_update")).toEqual([{ key: KEY_25 }]);
		store.state = eligible({ wantsDialog: false });
		await settle();
		expect(dialog()).toBeNull();
	});

	it("Update now refused: the message, no snooze, and it can be tried again", async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "open_store_updates") throw "The Microsoft Store could not be opened.";
			return undefined;
		});
		await mountDialog(eligible());
		button("Update now")?.click();
		await settle();
		expect(invoked("snooze_update")).toEqual([]);
		expect(dialog()?.querySelector(".update-error")?.textContent).toBe(
			"The Microsoft Store could not be opened.",
		);
		expect(button("Update now")?.disabled).toBe(false);
	});

	it("See what's new opens Lasterm's Store page and stays", async () => {
		await mountDialog(eligible());
		button("See what's new")?.click();
		await settle();
		expect(invoked("open_store_page")).toHaveLength(1);
		expect(dialog()).not.toBeNull();
	});

	it("Always update writes auto with the shown offer, then closes with its toast", async () => {
		const store = await mountDialog(eligible());
		store.openFromSettings();
		button("Always update")?.click();
		await settle();
		expect(invoked("choose_always_update")).toEqual([{ key: KEY_25 }]);
		expect(invoked("set_update_mode")).toEqual([]);
		expect(store.openedFromSettings).toBe(false);
		expect(useToastStore().messages.at(-1)?.text).toContain(
			"Lasterm will no longer ask about ordinary updates",
		);
	});

	it("Always update that fails keeps the dialog, with the error", async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "choose_always_update") throw "failed to replace update preference";
			return undefined;
		});
		const store = await mountDialog(eligible());
		store.openFromSettings();
		button("Always update")?.click();
		await settle();
		expect(store.openedFromSettings).toBe(true);
		expect(dialog()?.querySelector(".update-error")?.textContent).toBe(
			"failed to replace update preference",
		);
	});

	it("Later and Esc snooze the shown offer; opened from Settings they do not", async () => {
		mocks.invoke.mockResolvedValue(true);
		const store = await mountDialog(eligible());
		button("Later")?.click();
		await settle();
		expect(invoked("snooze_update")).toEqual([{ key: KEY_25 }]);

		dialog()?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
		await settle();
		expect(invoked("snooze_update")).toHaveLength(2);

		store.state = eligible({ wantsDialog: false });
		store.openFromSettings();
		await settle();
		button("Later")?.click();
		await settle();
		expect(invoked("snooze_update")).toHaveLength(2);
		expect(store.openedFromSettings).toBe(false);
	});

	it("has no Always update in auto", async () => {
		await mountDialog(
			eligible({ mode: "auto", offer: { key: KEY_25, mandatory: false, signal: "false" } }),
		);
		expect(button("Always update")).toBeUndefined();
		expect(button("Update now")).toBeDefined();
	});
});

describe("the update dialog's keyboard and names (AC-10)", () => {
	it("starts on Later, keeps Tab inside, and is a labelled modal dialog", async () => {
		await mountDialog(eligible());
		await settle();
		expect(document.activeElement?.textContent?.trim()).toBe("Later");
		expect(dialog()?.getAttribute("role")).toBe("dialog");
		expect(dialog()?.getAttribute("aria-modal")).toBe("true");
		expect(dialog()?.getAttribute("aria-labelledby")).toBe("update-dialog-title");
		const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
		document.activeElement?.dispatchEvent(tab);
		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement?.textContent?.trim()).toBe("Update now");
	});
});

describe("a required update (AC-11)", () => {
	it("says so, and can still be put off", async () => {
		await mountDialog(
			eligible({ offer: { key: KEY_25, version: "0.25.0", mandatory: true, signal: "true" } }),
		);
		expect(dialog()?.textContent).toContain(
			"This update is marked as required. It may fix a security problem.",
		);
		expect(button("Later")).toBeDefined();
	});
});

describe("the auto fallback (AC-13)", () => {
	it("says why for a false signal and for an unreadable one", async () => {
		const store = await mountDialog(
			eligible({ mode: "auto", offer: { key: KEY_25, mandatory: false, signal: "false" } }),
		);
		expect(dialog()?.textContent).toContain(
			"its automatic app updates are off, or the network is metered",
		);
		store.state = eligible({
			mode: "auto",
			offer: { key: KEY_25, mandatory: false, signal: "error" },
		});
		await settle();
		expect(dialog()?.textContent).toContain(
			"Lasterm could not tell whether the Microsoft Store will install",
		);
	});
});

describe("a Later that cannot be saved (AC-4)", () => {
	it("closes and says it holds until Lasterm restarts", async () => {
		mocks.invoke.mockImplementation(async (command: string) =>
			command === "snooze_update" ? false : undefined,
		);
		await mountDialog(eligible());
		button("Later")?.click();
		await settle();
		expect(useToastStore().messages.at(-1)?.text).toBe(
			"Lasterm could not save this choice; it holds until Lasterm restarts.",
		);
	});
});

describe("notices and the state's order (AC-15)", () => {
	it("subscribes before the snapshot, keeps a change in between, and ignores an older snapshot", async () => {
		let handler = null as ((event: { payload: UpdateState }) => void) | null;
		const order: string[] = [];
		mocks.listen.mockImplementation(async (_event: string, callback: typeof handler) => {
			order.push("listen");
			handler = callback;
			return () => undefined;
		});
		mocks.invoke.mockImplementation(async () => {
			order.push("snapshot");
			// A change lands between the subscription and the snapshot.
			handler?.({ payload: eligible({ seq: 5 }) });
			return eligible({ seq: 4, wantsDialog: false });
		});
		const applied: number[] = [];
		await connectUpdateState((state) => applied.push(state.seq));
		expect(order).toEqual(["listen", "snapshot"]);
		expect(applied).toEqual([5]);
		handler?.({ payload: eligible({ seq: 6 }) });
		expect(applied).toEqual([5, 6]);
	});

	it("shows each notice once, sticky, acknowledges on close, and drops a removed one unacknowledged", async () => {
		const updated = { id: 1, kind: "updated" as const, text: "Lasterm was updated to 0.25.0." };
		const store = await mountDialog(eligible({ offer: null, notices: [updated] }));
		const toasts = useToastStore();
		expect(toasts.messages.map((message) => message.text)).toEqual([updated.text]);

		// A new state carrying the same notice: no second toast.
		store.state = eligible({ seq: 2, offer: null, notices: [updated] });
		await settle();
		expect(toasts.messages).toHaveLength(1);

		// The user closes it: acknowledged by id.
		toasts.close(toasts.messages[0]?.id ?? -1);
		await settle();
		expect(invoked("acknowledge_notice")).toEqual([{ noticeId: 1 }]);

		// A notice the state drops goes, unacknowledged.
		const mandatory = {
			id: 2,
			kind: "mandatory" as const,
			text: "A required Lasterm update is available.",
		};
		store.state = eligible({ seq: 3, notices: [mandatory] });
		await settle();
		expect(toasts.messages.map((message) => message.text)).toEqual([mandatory.text]);
		store.state = eligible({ seq: 4, notices: [] });
		await settle();
		expect(toasts.messages).toEqual([]);
		expect(invoked("acknowledge_notice")).toEqual([{ noticeId: 1 }]);
	});

	it("waits for the window to be shown before showing a notice", async () => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		const updated = { id: 7, kind: "updated" as const, text: "Lasterm was updated to 0.25.0." };
		await mountDialog(eligible({ offer: null, notices: [updated] }));
		expect(useToastStore().messages).toEqual([]);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(useToastStore().messages.map((message) => message.text)).toEqual([updated.text]);
	});

	it("What's new opens the Store page and acknowledges; refused, it stays unacknowledged", async () => {
		const updated = { id: 3, kind: "updated" as const, text: "Lasterm was updated to 0.25.0." };
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "open_store_page") throw "The Microsoft Store could not be opened.";
			return undefined;
		});
		await mountDialog(eligible({ offer: null, notices: [updated] }));
		const toasts = useToastStore();
		const notice = toasts.messages[0]?.id ?? -1;
		toasts.act(notice);
		await settle();
		expect(invoked("open_store_page")).toHaveLength(1);
		expect(invoked("acknowledge_notice")).toEqual([]);
		expect(toasts.messages.map((message) => message.text)).toContain(
			"The Microsoft Store could not be opened.",
		);
		// The same toast, still there to be tried again.
		expect(toasts.messages.find((message) => message.text === updated.text)?.id).toBe(notice);

		mocks.invoke.mockResolvedValue(undefined);
		toasts.act(notice);
		await settle();
		expect(invoked("acknowledge_notice")).toEqual([{ noticeId: 3 }]);
		expect(toasts.messages.map((message) => message.id)).not.toContain(notice);
	});

	it("Open Settings acknowledges and asks for Settings › Desktop", async () => {
		const waiting = {
			id: 4,
			kind: "waiting" as const,
			text: "A Lasterm update has been waiting 7 days.",
		};
		const store = await mountDialog(eligible({ notices: [waiting], wantsDialog: false }));
		const toasts = useToastStore();
		toasts.act(toasts.messages[0]?.id ?? -1);
		await settle();
		expect(invoked("acknowledge_notice")).toEqual([{ noticeId: 4 }]);
		expect(store.settingsRequests).toBe(1);
	});
});

describe("the update dialog and the native window (AC-8)", () => {
	it("waits while the window is minimized or hidden, notices too, and shows when it is back", async () => {
		inDesktop();
		mocks.win.isMinimized.mockResolvedValue(true);
		const updated = { id: 9, kind: "updated" as const, text: "Lasterm was updated to 0.25.0." };
		await mountDialog(eligible({ notices: [updated] }));
		expect(dialog()).toBeNull();
		expect(useToastStore().messages).toEqual([]);

		mocks.win.isMinimized.mockResolvedValue(false);
		windowEvent();
		await settle();
		expect(dialog()).not.toBeNull();
		expect(useToastStore().messages.map((message) => message.text)).toEqual([updated.text]);

		mocks.win.isVisible.mockResolvedValue(false);
		windowEvent();
		await settle();
		expect(dialog()).toBeNull();
		expect(invoked("snooze_update")).toEqual([]);
	});
});

describe("an opening from Settings belongs to its offer (AC-8)", () => {
	it("does not come back for a later offer once its own has gone", async () => {
		const settings = document.createElement("div");
		settings.className = "settings-panel";
		settings.setAttribute("aria-modal", "true");
		const opener = document.createElement("button");
		opener.setAttribute("data-update-opener", "");
		settings.appendChild(opener);
		document.body.appendChild(settings);
		const store = await mountDialog(eligible({ mode: "off", wantsDialog: false }));
		store.openFromSettings();
		await settle();
		expect(dialog()).not.toBeNull();

		store.state = eligible({ seq: 2, mode: "off", wantsDialog: false, offer: null });
		await settle();
		expect(dialog()).toBeNull();
		store.state = eligible({
			seq: 3,
			mode: "off",
			wantsDialog: false,
			offer: { key: KEY_26, version: "0.26.0", mandatory: false, signal: "true" },
		});
		await settle();
		expect(dialog()).toBeNull();
		expect(store.openedFromSettings).toBe(false);
	});
});

describe("Update now (AC-9)", () => {
	it("opened from Settings: opens the Store, snoozes the offer shown, and closes", async () => {
		const settings = document.createElement("div");
		settings.className = "settings-panel";
		settings.setAttribute("aria-modal", "true");
		const opener = document.createElement("button");
		opener.setAttribute("data-update-opener", "");
		settings.appendChild(opener);
		document.body.appendChild(settings);
		const store = await mountDialog(eligible({ mode: "off", wantsDialog: false }));
		store.openFromSettings();
		await settle();
		button("Update now")?.click();
		await settle();
		expect(invoked("open_store_updates")).toHaveLength(1);
		expect(invoked("snooze_update")).toEqual([{ key: KEY_25 }]);
		expect(dialog()).toBeNull();
		expect(store.openedFromSettings).toBe(false);
	});

	it("snoozes the offer the user saw, not one that arrived while the Store opened", async () => {
		let opened: (() => void) | undefined;
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "open_store_updates") {
				await new Promise<void>((resolve) => {
					opened = resolve;
				});
			}
			return command === "snooze_update" ? true : undefined;
		});
		const store = await mountDialog(eligible());
		button("Update now")?.click();
		await settle();
		store.state = eligible({
			seq: 2,
			offer: { key: KEY_26, version: "0.26.0", mandatory: false, signal: "true" },
		});
		await settle();
		opened?.();
		await settle();
		expect(invoked("snooze_update")).toEqual([{ key: KEY_25 }]);
	});
});

describe("the keyboard when the dialog steps aside or closes (AC-10)", () => {
	it("leaves the keyboard to a dialog that comes after it", async () => {
		// The terminal had the keyboard before the dialog showed.
		const terminal = document.createElement("textarea");
		document.body.appendChild(terminal);
		terminal.focus();
		await mountDialog(eligible());
		expect(document.activeElement?.textContent?.trim()).toBe("Later");
		const prompt = document.createElement("div");
		prompt.setAttribute("aria-modal", "true");
		const password = document.createElement("input");
		prompt.appendChild(password);
		document.body.appendChild(prompt);
		password.focus();
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(password);
	});

	it("gives the keyboard to Check for updates when its opener has gone", async () => {
		const settings = document.createElement("div");
		settings.className = "settings-panel";
		settings.setAttribute("aria-modal", "true");
		const opener = document.createElement("button");
		opener.setAttribute("data-update-opener", "");
		const check = document.createElement("button");
		check.setAttribute("data-update-check", "");
		settings.append(opener, check);
		document.body.appendChild(settings);
		opener.focus();
		const store = await mountDialog(eligible({ mode: "off", wantsDialog: false }));
		store.openFromSettings();
		await settle();
		expect(document.activeElement?.textContent?.trim()).toBe("Later");
		opener.remove();
		dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(check);
	});
});

/** What a page reload leaves: a new page and new stores, mounted on the state read again. */
async function reload(state: UpdateState) {
	app?.unmount();
	app = null;
	document.body.innerHTML = "";
	pinia = createPinia();
	setActivePinia(pinia);
	return mountDialog(state);
}

describe("a page reload (AC-18)", () => {
	it("forgets a dialog opened from Settings and brings back a wanted one", async () => {
		const settings = document.createElement("div");
		settings.className = "settings-panel";
		settings.setAttribute("aria-modal", "true");
		const opener = document.createElement("button");
		opener.setAttribute("data-update-opener", "");
		settings.appendChild(opener);
		document.body.appendChild(settings);
		const store = await mountDialog(eligible({ mode: "off", wantsDialog: false }));
		store.openFromSettings();
		await settle();
		expect(dialog()).not.toBeNull();

		// The reload: a new page, Settings closed, its stores new, the desktop state read again.
		await reload(eligible({ mode: "off", wantsDialog: false }));
		expect(dialog()).toBeNull();
		await reload(eligible({ wantsDialog: true }));
		expect(dialog()).not.toBeNull();
	});
});

describe("a notice whose acknowledgement is on its way (AC-15)", () => {
	it("is not shown again by a state sent before the desktop dropped it", async () => {
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "acknowledge_notice") await new Promise(() => undefined);
			return undefined;
		});
		const updated = { id: 5, kind: "updated" as const, text: "Lasterm was updated to 0.25.0." };
		const store = await mountDialog(eligible({ offer: null, notices: [updated] }));
		const toasts = useToastStore();
		toasts.close(toasts.messages[0]?.id ?? -1);
		store.state = eligible({ seq: 2, offer: null, notices: [updated] });
		await settle();
		expect(toasts.messages).toEqual([]);
		expect(invoked("acknowledge_notice")).toEqual([{ noticeId: 5 }]);
	});
});

describe("the page's other dialogs, watched only while the update dialog is wanted", () => {
	it("watches nothing without an offer, and starts with one", async () => {
		const Real = globalThis.MutationObserver;
		let made = 0;
		globalThis.MutationObserver = class extends Real {
			constructor(callback: MutationCallback) {
				super(callback);
				made += 1;
			}
		};
		try {
			const store = await mountDialog(eligible({ offer: null, wantsDialog: false }));
			expect(made).toBe(0);
			store.state = eligible({ seq: 2 });
			await settle();
			expect(made).toBe(1);
			expect(dialog()).not.toBeNull();
		} finally {
			globalThis.MutationObserver = Real;
		}
	});
});
