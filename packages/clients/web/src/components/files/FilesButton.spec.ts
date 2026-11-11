/**
 * A pane's folder button (#836): the panel opens on that pane's terminal, closes when pressed
 * again, shows pressed while the panel shows that terminal, and is not there at all while file
 * transfer is off (#835). Its place in the pane header, and the pane's "Files" menu item, on a
 * pane mounted whole but for xterm, below.
 */
import { createPinia, getActivePinia, type Pinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

// xterm needs a real canvas: the pane gets a terminal that draws nothing.
vi.mock("../../composables/useTerminal.js", async () => {
	const { useTerminalSearch } = await import("../../composables/useTerminalSearch.js");
	return {
		useTerminal: () => ({
			terminal: ref({ cols: 80, rows: 24, onBell: () => {}, scrollToBottom: () => {} }),
			awaitFont: async () => {},
			canWrite: ref(false),
			currentDynamicTitle: ref(""),
			search: useTerminalSearch(),
			init: () => ({ cols: 80, rows: 24 }),
			attachChannel: () => {},
			reattachChannel: async () => ({ writeLockHolder: null, cached: false, truncated: false }),
			applyProfile: () => {},
			suppressNextResize: () => {},
			syncChannelSize: () => {},
			setDecidesSize: () => {},
			dispose: () => {},
			fitAddon: {},
		}),
	};
});

import { useChannelsStore } from "../../stores/channels.js";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useSessionStore } from "../../stores/session.js";
import TerminalPane from "../TerminalPane.vue";
import FilesButton from "./FilesButton.vue";

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FAB";

let app: App | null = null;
let root: HTMLElement;

function mountButton(channelId: string | null): void {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(FilesButton, { channelId }) });
	app.mount(root);
}

const button = (): HTMLButtonElement | null => root.querySelector("button.files-button");

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
	const store = useFilesPanelStore();
	store.setChannelsInTabs(new Set([A, B]));
	store.setFocused(A);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("a pane's folder button", () => {
	it("opens the panel on its terminal, pressed, and closes it when pressed again", async () => {
		mountButton(A);
		await nextTick();
		expect(button()?.getAttribute("aria-pressed")).toBe("false");
		expect(button()?.getAttribute("aria-controls")).toBe("files-panel");
		expect(button()?.getAttribute("aria-label")).toBe("Files (Ctrl+Shift+E)");
		button()?.click();
		await nextTick();
		expect(useFilesPanelStore().isOpenOn(A)).toBe(true);
		expect(button()?.getAttribute("aria-pressed")).toBe("true");
		button()?.click();
		await nextTick();
		expect(useFilesPanelStore().open).toBe(false);
		expect(button()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("is not pressed while the panel shows another terminal", async () => {
		mountButton(B);
		useFilesPanelStore().openFor(null);
		await nextTick();
		expect(useFilesPanelStore().isOpenOn(A)).toBe(true);
		expect(button()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("is not there while file transfer is off, nor on a pane with no terminal yet", async () => {
		useConfigStore().uiConfig = { onChannelDead: "readonly" };
		mountButton(A);
		await nextTick();
		expect(button()).toBeNull();
		useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
		await nextTick();
		expect(button()).not.toBeNull();
		app?.unmount();
		root.remove();
		mountButton(null);
		await nextTick();
		expect(button()).toBeNull();
	});
});

describe("the pane's entry points", () => {
	const HOST = "01ARZ3NDEKTSV4RRFFQ69G5FHH";

	/** A's pane, mounted whole but for xterm, on a hub socket that answers nothing. */
	async function mountPane(): Promise<HTMLElement> {
		const sessionStore = useSessionStore();
		sessionStore.wsClient = {
			isConnected: true,
			on: vi.fn(() => () => {}),
			send: vi.fn(),
		} as unknown as typeof sessionStore.wsClient;
		vi.spyOn(sessionStore, "connect").mockResolvedValue();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		vi.spyOn(console, "error").mockImplementation(() => {});
		useChannelsStore().registerChannelHost(A, HOST);
		// The keyboard is on another pane, B's: what this pane opens is for its own terminal, and
		// the panel asks App.vue to bring this pane forward.
		useFilesPanelStore().setFocused(B);
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(TerminalPane, { channelId: A, hostId: HOST }) });
		app.use(getActivePinia() as Pinia);
		app.mount(root);
		await nextTick();
		return root.querySelector(".terminal-pane") as HTMLElement;
	}

	/** The pane's menu, opened as a right click opens it. */
	async function menu(pane: HTMLElement): Promise<HTMLButtonElement[]> {
		pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await nextTick();
		return [...root.querySelectorAll<HTMLButtonElement>(".context-menu button")];
	}

	const files = (items: HTMLButtonElement[]): HTMLButtonElement | undefined =>
		items.find((item) => item.querySelector("span")?.textContent === "Files");

	it("puts the folder button left of the write-lock indicator", async () => {
		await mountPane();
		const header = root.querySelector(".pane-header") as HTMLElement;
		const folder = header.querySelector("button.files-button") as HTMLButtonElement;
		const lock = header.querySelector(".wl-indicator") as HTMLElement;
		expect(folder).not.toBeNull();
		expect(lock).not.toBeNull();
		expect(folder.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		folder.click();
		await nextTick();
		const panel = useFilesPanelStore();
		expect([panel.open, panel.paneRequest?.channelId]).toEqual([true, A]);
	});

	it("offers Files in the pane's menu while file transfer is on, the keyboard going into the panel", async () => {
		const pane = await mountPane();
		const panel = useFilesPanelStore();
		const asked = panel.keyboardRequests;
		const item = files(await menu(pane));
		expect(item?.textContent).toContain("Files");
		item?.click();
		await nextTick();
		expect([panel.open, panel.paneRequest?.channelId]).toEqual([true, A]);
		expect(panel.keyboardRequests).toBe(asked + 1);

		panel.close();
		useConfigStore().uiConfig = { onChannelDead: "readonly" };
		await nextTick();
		expect(files(await menu(pane))).toBeUndefined();
	});
});
