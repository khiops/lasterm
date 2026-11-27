/**
 * The host key question: what it says about the key from the known_hosts files the hub read, and
 * when it offers the setting that skips the question. That setting applies to first connections
 * only, so a changed key does not offer it (#1217).
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useHostVerifyStore } from "../stores/host-verify.js";
import HostKeyWarning from "./HostKeyWarning.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
});

const text = (selector: string): string | undefined =>
	document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();

async function ask(
	firstConnect: boolean,
	knownHosts: { verdict: "trusted" | "other-key"; file: string; line: number },
): Promise<void> {
	const pinia = createPinia();
	setActivePinia(pinia);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(HostKeyWarning) });
	app.use(pinia);
	app.mount(root);
	useHostVerifyStore().handleHostVerify(
		"host-1",
		"build.example",
		"SHA256:new",
		"SHA256",
		firstConnect ? "" : "SHA256:old",
		"prompt-1",
		firstConnect,
		knownHosts,
	);
	await nextTick();
}

describe("the host key question", () => {
	it("says where the key was found and offers the setting on a first connection", async () => {
		await ask(true, { verdict: "trusted", file: "/home/me/.ssh/known_hosts", line: 3 });

		expect(text(".hkw-known")).toBe("This exact key is already in /home/me/.ssh/known_hosts:3.");
		expect(text(".hkw-known-choice")).toBe(
			"Take that as reason enough from now on — Lasterm will not ask about a first connection to a host whose key is already in known_hosts.",
		);
	});

	it("says where the key was found but offers no setting when the key changed", async () => {
		await ask(false, { verdict: "trusted", file: "/home/me/.ssh/known_hosts", line: 3 });

		expect(text(".hkw-known")).toBe("This exact key is already in /home/me/.ssh/known_hosts:3.");
		expect(document.querySelector(".hkw-known-choice")).toBeNull();
	});

	it("warns of a different key listed for the host, with no setting", async () => {
		await ask(true, { verdict: "other-key", file: "/home/me/.ssh/known_hosts2", line: 7 });

		expect(text(".hkw-known-warning")).toBe(
			"⚠ A different key is listed for this host in /home/me/.ssh/known_hosts2:7. Do not trust this one unless you know why they differ.",
		);
		expect(document.querySelector(".hkw-known-choice")).toBeNull();
		expect(document.querySelector(".hkw-known")).toBeNull();
	});
});
