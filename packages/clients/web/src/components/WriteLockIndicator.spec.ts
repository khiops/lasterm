/**
 * The write lock's state as a pane shows it. While the hub keeps the lock for
 * a writer that left (#846), the pane says the writer is reconnecting rather
 * than that nobody holds it, and still offers to take it.
 */
import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useAuthStore } from "../stores/auth.js";
import { useWriteLockStore } from "../stores/writelock.js";
import WriteLockIndicator from "./WriteLockIndicator.vue";

const CHANNEL = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

let app: App | null = null;
let root: HTMLElement;
let sent: ProtocolMessage[];

function mountIndicator(): void {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(WriteLockIndicator, { channelId: CHANNEL }) });
	app.mount(root);
}

const label = (): string | undefined => root.querySelector(".wl-label")?.textContent?.trim();
const buttons = (): string[] =>
	[...root.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");

beforeEach(() => {
	const pinia = createPinia();
	setActivePinia(pinia);
	sent = [];
	useAuthStore().setClientId("this-client");
	useWriteLockStore().setWsClient({
		send: (msg: ProtocolMessage) => sent.push(msg),
	} as unknown as IWsClient);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

describe("WriteLockIndicator", () => {
	it("says the writer is reconnecting while the hub keeps the lock for it, and still offers to take it", async () => {
		const store = useWriteLockStore();
		store.handleWriteLock(CHANNEL, null, true);
		mountIndicator();
		await nextTick();

		expect(label()).toBe("Writer reconnecting");
		expect(buttons()).toEqual(["Request Write", "Force Take"]);

		root.querySelector<HTMLButtonElement>("button")?.click();
		expect(sent).toEqual([{ type: "WRITE_CLAIM", channelId: CHANNEL }]);
	});

	it("stops saying so once someone holds the lock, or it is simply free", async () => {
		const store = useWriteLockStore();
		store.handleWriteLock(CHANNEL, null, true);
		mountIndicator();
		await nextTick();
		expect(label()).toBe("Writer reconnecting");

		store.handleWriteLock(CHANNEL, "writer-reloaded");
		await nextTick();
		expect(label()).toBe("Reader");

		store.handleWriteLock(CHANNEL, null);
		await nextTick();
		expect(label()).toBe("No lock");

		store.handleWriteLock(CHANNEL, "this-client");
		await nextTick();
		expect(label()).toBe("Writer");
	});
});
