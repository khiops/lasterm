/**
 * Settings › Agents: what the remote daemon setting says of the process it
 * leaves on another machine (#805).
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";
import AgentManagerCategory from "./AgentManagerCategory.vue";

// No hub: every request the category makes as it opens gets nothing.
vi.mock("../../../utils/hub-fetch.js", () => ({
	hubFetch: vi.fn(async () => new Response("{}", { status: 404 })),
}));

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("Settings › Agents › Keep an agent running on remote hosts", () => {
	it("says when the agent ends by itself, and that an update replaces it once it runs none of this Lasterm's terminals", async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp(AgentManagerCategory);
		app.use(pinia);
		app.mount(root);
		await nextTick();

		const note = root.querySelector(".daemon-row .daemon-note")?.textContent?.replace(/\s+/g, " ");
		expect(note?.trim()).toBe(
			"Their terminals then survive a dropped connection and a Lasterm restart. It is a process left on the other machine, which ends by itself half an hour after it holds no terminals and no Lasterm is connected to it. After an update, Lasterm replaces it as soon as it runs none of this Lasterm's terminals. Windows hosts are unaffected.",
		);
	});
});
