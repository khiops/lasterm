/**
 * The card shown when the agent a host needs is not in the cache: where its link takes the user
 * to download it (#936). The page is written out, so a link bound to another of the app's pages
 * fails here.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useAgentVerifyStore } from "../stores/agent-verify.js";
import AgentDeployFailed from "./AgentDeployFailed.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
});

describe("Agent binary not available", () => {
	it("sends the user to the latest release to download it", async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(AgentDeployFailed) });
		app.use(pinia);
		app.mount(root);
		useAgentVerifyStore().handleDeployError(
			"Agent binary not found in cache: /home/me/.cache/lasterm/agents/lasterm-agent-linux-arm64. Download it.",
			"pi",
		);
		await nextTick();

		// Teleported to the body.
		const links = [...document.querySelectorAll<HTMLAnchorElement>(".adf-card a[href]")].map(
			(a) => [a.textContent?.trim(), a.getAttribute("href")],
		);
		expect(links).toEqual([["releases page", "https://github.com/khiops/lasterm/releases/latest"]]);
	});
});
