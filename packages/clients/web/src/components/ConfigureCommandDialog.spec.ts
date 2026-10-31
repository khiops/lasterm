/**
 * "Apply & Restart" says why a restart failed, as the store kept it for the
 * pane, and says nothing when nothing failed: the person cancelled the password
 * or passphrase its host asked for (#815).
 */
import type { Channel } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { useSessionStore } from "../stores/session.js";
import ConfigureCommandDialog from "./ConfigureCommandDialog.vue";

let app: App | null = null;
let root: HTMLElement;

const DEAD: Channel = {
	id: "ch-dead",
	sessionId: "s-1",
	shell: "/bin/bash",
	cols: 80,
	rows: 24,
	status: "dead",
} as Channel;

/** A hub that answers every SPAWN with this ERROR. */
function hubAnswering(error: { code: string; message: string }): void {
	const listeners = new Map<string, ((msg: unknown) => void)[]>();
	const sessionStore = useSessionStore();
	// @ts-expect-error — overwrite reactive wsClient for test
	sessionStore.wsClient = {
		on: vi.fn((type: string, cb: (msg: unknown) => void) => {
			listeners.set(type, [...(listeners.get(type) ?? []), cb]);
			return () => {
				listeners.set(
					type,
					(listeners.get(type) ?? []).filter((c) => c !== cb),
				);
			};
		}),
		send: vi.fn(() => {
			for (const cb of listeners.get("ERROR") ?? []) cb({ type: "ERROR", ...error });
		}),
	};
}

async function mountDialog() {
	const pinia = createPinia();
	setActivePinia(pinia);
	const channelsStore = useChannelsStore();
	channelsStore.channels = [DEAD];
	channelsStore.activeHostId = "host-pi";
	vi.spyOn(channelsStore, "updateChannelConfig").mockResolvedValue(true);
	const onApplied = vi.fn();
	const visible = ref(false);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(ConfigureCommandDialog, { visible: visible.value, channelId: DEAD.id, onApplied }),
	});
	app.use(pinia);
	app.mount(root);
	// Opened, as its parent opens it: it reads the terminal's command then.
	visible.value = true;
	await nextTick();
	return { onApplied };
}

/** The dialog is teleported to the body. */
const shownError = (): string | null =>
	document.body.querySelector(".field-error")?.textContent ?? null;

/** Click it, and wait for the restart it starts, the real one, to end. */
async function applyAndRestart(): Promise<void> {
	const restart = vi.spyOn(useChannelsStore(), "restartChannel");
	document.body.querySelector<HTMLButtonElement>(".dialog-actions .btn-accent")?.click();
	await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
	expect(await restart.mock.results[0]?.value).toBe(false);
	restart.mockRestore();
	await nextTick();
}

beforeEach(() => {
	localStorage.setItem("lasterm_token", "test-token");
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("ConfigureCommandDialog's Apply & Restart (#815)", () => {
	it("says why the restart failed, in the hub's words", async () => {
		const { onApplied } = await mountDialog();
		hubAnswering({ code: "SSH_CONNECT_FAILED", message: "connect ECONNREFUSED 192.0.2.7:22" });

		await applyAndRestart();

		expect(shownError()).toBe("connect ECONNREFUSED 192.0.2.7:22");
		expect(onApplied).not.toHaveBeenCalled();
	});

	it("says nothing when the person cancelled the password asked for", async () => {
		const { onApplied } = await mountDialog();
		hubAnswering({ code: "AUTH_CANCELLED", message: "Authentication cancelled by user" });

		await applyAndRestart();

		expect(shownError()).toBeNull();
		expect(onApplied).not.toHaveBeenCalled();
	});

	it("drops the last failure when the next attempt is cancelled", async () => {
		await mountDialog();
		hubAnswering({ code: "SSH_CONNECT_FAILED", message: "Agent HELLO timeout" });
		await applyAndRestart();
		expect(shownError()).toBe("Agent HELLO timeout");

		hubAnswering({ code: "AUTH_CANCELLED", message: "Authentication cancelled by user" });
		await applyAndRestart();

		expect(shownError()).toBeNull();
	});
});
