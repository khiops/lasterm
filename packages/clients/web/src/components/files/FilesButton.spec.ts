/**
 * A pane's folder button (#836): the panel opens on that pane's terminal, closes when pressed
 * again, shows pressed while the panel shows that terminal, and is not there at all while file
 * transfer is off (#835). Its place in the pane header, and the pane's "Files" menu item, are
 * read from TerminalPane.vue below.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import TERMINAL_PANE from "../TerminalPane.vue?raw";
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
	const flat = TERMINAL_PANE.replace(/\s+/g, " ");

	it("puts the folder button left of the write-lock indicator", () => {
		const header = /class="pane-header"[\s\S]*?<\/div>/.exec(TERMINAL_PANE)?.[0] ?? "";
		expect(header.indexOf('<FilesButton :channel-id="effectiveChannelId" />')).toBeGreaterThan(-1);
		expect(header.indexOf("<FilesButton")).toBeLessThan(header.indexOf("<WriteLockIndicator"));
	});

	it("offers Files in the pane's menu while file transfer is on, the keyboard going into the panel", () => {
		expect(flat).toContain('<template v-if="configStore.fileTransferEnabled">');
		expect(flat).toContain('@click="onShowFiles"> <span>Files</span>');
		expect(flat).toContain("if (chId !== null) filesPanel.openFor(chId, { keyboard: true });");
	});
});
