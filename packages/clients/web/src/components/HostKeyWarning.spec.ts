/**
 * The host key question: what it says about the key from the known_hosts files the hub read, and
 * when it offers the setting that skips the question. That setting applies to first connections
 * only, so a changed key does not offer it (#1217). Ticking it saves at once; a save the hub
 * refuses leaves the box as it was, with the reason on screen (#1223).
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: vi.fn() }));

import { useHostVerifyStore } from "../stores/host-verify.js";
import { hubFetch } from "../utils/hub-fetch.js";
import HostKeyWarning from "./HostKeyWarning.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
	vi.mocked(hubFetch).mockReset();
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

const KNOWN = { verdict: "trusted", file: "/home/me/.ssh/known_hosts", line: 3 } as const;

const checkbox = (): HTMLInputElement => {
	const box = document.querySelector<HTMLInputElement>(".hkw-known-choice input");
	if (!box) throw new Error("no known_hosts checkbox");
	return box;
};

/** Long enough for a save, and for anything a save's outcome might start, to finish. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 3; turn++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

/** What each request asked the hub to store. */
const saved = (): unknown[] =>
	vi.mocked(hubFetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

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

	it("saves the setting when the box is ticked, and again when it is cleared", async () => {
		vi.mocked(hubFetch).mockImplementation(async () => new Response("{}", { status: 200 }));
		await ask(true, KNOWN);

		checkbox().click();
		await settle();

		expect(saved()).toEqual([{ trustKnownHosts: true }]);
		expect(vi.mocked(hubFetch).mock.calls[0]?.[0]).toMatch(/\/api\/config\/ssh$/);
		expect(vi.mocked(hubFetch).mock.calls[0]?.[1]?.method).toBe("PUT");
		expect(checkbox().checked).toBe(true);
		expect(checkbox().disabled).toBe(false);
		expect(document.querySelector(".hkw-known-error")).toBeNull();

		checkbox().click();
		await settle();

		expect(saved()).toEqual([{ trustKnownHosts: true }, { trustKnownHosts: false }]);
		expect(checkbox().checked).toBe(false);
		expect(document.querySelector(".hkw-known-error")).toBeNull();
	});

	it("puts the box back and keeps the reason when the hub refuses the save", async () => {
		// Only the first request is refused: a second one, if the dialog sent it, would
		// go through, and the call count below would show it.
		vi.mocked(hubFetch)
			.mockImplementation(async () => new Response("{}", { status: 200 }))
			.mockImplementationOnce(async () => new Response("", { status: 500 }));
		await ask(true, KNOWN);

		checkbox().click();
		await settle();

		expect(saved()).toEqual([{ trustKnownHosts: true }]);
		expect(checkbox().checked).toBe(false);
		expect(checkbox().disabled).toBe(false);
		expect(text(".hkw-known-error")).toBe("Could not save that preference: hub answered 500");
	});

	it("puts a cleared box back to ticked when clearing it cannot be saved", async () => {
		vi.mocked(hubFetch).mockImplementation(async () => new Response("{}", { status: 200 }));
		await ask(true, KNOWN);
		checkbox().click();
		await settle();
		vi.mocked(hubFetch).mockImplementationOnce(async () => {
			throw new Error("the hub is unreachable");
		});

		checkbox().click();
		await settle();

		expect(saved()).toEqual([{ trustKnownHosts: true }, { trustKnownHosts: false }]);
		expect(checkbox().checked).toBe(true);
		expect(text(".hkw-known-error")).toBe("Could not save that preference: the hub is unreachable");
	});

	it("clears an earlier failure once a save goes through", async () => {
		vi.mocked(hubFetch)
			.mockImplementation(async () => new Response("{}", { status: 200 }))
			.mockImplementationOnce(async () => new Response("", { status: 503 }));
		await ask(true, KNOWN);
		checkbox().click();
		await settle();
		expect(text(".hkw-known-error")).toBe("Could not save that preference: hub answered 503");

		checkbox().click();
		await settle();

		expect(saved()).toEqual([{ trustKnownHosts: true }, { trustKnownHosts: true }]);
		expect(checkbox().checked).toBe(true);
		expect(document.querySelector(".hkw-known-error")).toBeNull();
	});
});
