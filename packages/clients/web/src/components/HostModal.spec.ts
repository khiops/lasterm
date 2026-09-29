import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useHostsStore } from "../stores/hosts.js";
import HostModal from "./HostModal.vue";

// Replicate the connectionTabHasError logic as a pure function
interface TabValidationInput {
	type: "local" | "ssh";
	sshHost: string;
	sshAuth: "agent" | "key" | "password";
	sshKeyPath: string;
}

function connectionTabHasError(form: TabValidationInput): boolean {
	if (form.type === "ssh") {
		if (!form.sshHost) return true;
		if (form.sshAuth === "key" && !form.sshKeyPath) return true;
	}
	return false;
}

// Replicate the first-errored-tab logic (EFF-08/SC-10b)
function firstErroredTab(
	form: TabValidationInput,
): "connection" | "terminal" | "appearance" | null {
	if (connectionTabHasError(form)) return "connection";
	// Terminal and Appearance have no required fields
	return null;
}

describe("HostModal tab logic", () => {
	it("connectionTabHasError returns true when sshHost is empty", () => {
		expect(
			connectionTabHasError({
				type: "ssh",
				sshHost: "",
				sshAuth: "agent",
				sshKeyPath: "",
			}),
		).toBe(true);
	});

	it("connectionTabHasError returns true when key auth but no keyPath", () => {
		expect(
			connectionTabHasError({
				type: "ssh",
				sshHost: "10.0.0.1",
				sshAuth: "key",
				sshKeyPath: "",
			}),
		).toBe(true);
	});

	it("connectionTabHasError returns false when valid", () => {
		expect(
			connectionTabHasError({
				type: "ssh",
				sshHost: "10.0.0.1",
				sshAuth: "agent",
				sshKeyPath: "",
			}),
		).toBe(false);
	});

	it("SC-10b: firstErroredTab returns connection when hostname empty", () => {
		expect(
			firstErroredTab({
				type: "ssh",
				sshHost: "",
				sshAuth: "agent",
				sshKeyPath: "",
			}),
		).toBe("connection");
	});

	it("firstErroredTab returns null when all valid", () => {
		expect(
			firstErroredTab({
				type: "ssh",
				sshHost: "10.0.0.1",
				sshAuth: "key",
				sshKeyPath: "~/.ssh/id_rsa",
			}),
		).toBeNull();
	});

	it("connectionTabHasError returns false for local type", () => {
		expect(
			connectionTabHasError({
				type: "local",
				sshHost: "",
				sshAuth: "key",
				sshKeyPath: "",
			}),
		).toBe(false);
	});
});

// ─── The dialog, mounted ─────────────────────────────────────────────────────
//
// Mounted with its real stores. Only the request to the hub is stood in for,
// at fetch, which is what hubFetch calls outside the desktop.

const STAMP = "2026-09-29T00:00:00.000Z";

const LOCAL: Host = {
	id: "01LOCALHOST0000000000000000",
	type: "local",
	label: "local",
	iconType: "auto",
	trustRemoteHints: "apply",
	sortOrder: 0,
	os: "windows",
	arch: "x64",
	createdAt: STAMP,
	updatedAt: STAMP,
};

const SSH: Host = {
	...LOCAL,
	id: "01SSHHOST000000000000000000",
	type: "ssh",
	label: "pi",
	sshHost: "192.168.1.20",
	sshAuth: "agent",
	os: "linux",
	arch: "arm64",
};

let app: App | null = null;
let root: HTMLElement;

function mountModal(editHost: Host) {
	const pinia = createPinia();
	setActivePinia(pinia);
	useHostsStore().hosts = [{ ...LOCAL }, { ...SSH }];
	const onSaved = vi.fn();
	const onClose = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(HostModal, { visible: true, editHost, onSaved, onClose }) });
	app.use(pinia);
	app.mount(root);
	return { onSaved, onClose };
}

/** The dialog is teleported to the body. */
function el<T extends Element = HTMLElement>(selector: string): T | null {
	return document.body.querySelector<T>(selector);
}

function shown(element: HTMLElement | null): boolean {
	return element !== null && element.style.display !== "none";
}

/** Every promise the save chains, settled. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("HostModal for the local host (#656)", () => {
	it("opens on its identity, with no connection to set up", () => {
		mountModal(LOCAL);
		expect(el("#tab-connection")).toBeNull();
		expect(el("#panel-connection")).toBeNull();
		expect(el("input[placeholder='192.168.1.100']")).toBeNull();
		expect(el("#tab-terminal")).not.toBeNull();
		expect(el("#tab-appearance")?.getAttribute("aria-selected")).toBe("true");
		const appearance = el("#panel-appearance");
		expect(shown(appearance)).toBe(true);
		expect(appearance?.textContent).toContain("Host Identity");
		expect(appearance?.querySelector("input[type='color']")).not.toBeNull();
		for (const iconType of ["auto", "emoji", "image"]) {
			expect(appearance?.querySelector(`input[type='radio'][value='${iconType}']`)).not.toBeNull();
		}
	});

	it("keeps the terminal settings that apply to it, and no remote hints", () => {
		mountModal(LOCAL);
		const terminal = el("#panel-terminal");
		expect(terminal?.textContent).toContain("Elevation Method");
		expect(terminal?.textContent).toContain("Default Shell");
		expect(terminal?.textContent).not.toContain("Remote Hints");
	});

	it("saves the colour and emoji it is given, and nothing of SSH", async () => {
		// The host as the hub answers the update: snake_case, as on the wire.
		const answer = {
			id: LOCAL.id,
			type: "local",
			label: "local",
			icon_type: "emoji",
			icon_value: "🚀",
			color: "#ff8800",
			trust_remote_hints: "apply",
			sort_order: 0,
			os: "windows",
			arch: "x64",
			created_at: STAMP,
			updated_at: STAMP,
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(answer), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const { onSaved, onClose } = mountModal(LOCAL);

		const color = el<HTMLInputElement>("#panel-appearance input[type='color']");
		if (!color) throw new Error("no colour input");
		color.value = "#ff8800";
		color.dispatchEvent(new Event("input"));
		const emojiRadio = el<HTMLInputElement>("#panel-appearance input[type='radio'][value='emoji']");
		if (!emojiRadio) throw new Error("no emoji choice");
		emojiRadio.checked = true;
		emojiRadio.dispatchEvent(new Event("change"));
		await nextTick();
		const emoji = el<HTMLInputElement>("#icon-value");
		if (!emoji) throw new Error("no emoji input");
		emoji.value = "🚀";
		emoji.dispatchEvent(new Event("input"));
		await nextTick();

		el<HTMLButtonElement>(".dialog-actions .btn-primary")?.click();
		await settle();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(String(url)).toBe(`/api/hosts/${LOCAL.id}`);
		expect(init?.method).toBe("PUT");
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({
			type: "local",
			label: "local",
			color: "#ff8800",
			icon_type: "emoji",
			icon_value: "🚀",
		});
		expect(Object.keys(body).filter((key) => key.startsWith("ssh_"))).toEqual([]);
		expect(onSaved).toHaveBeenCalledWith(
			expect.objectContaining({
				id: LOCAL.id,
				color: "#ff8800",
				iconType: "emoji",
				iconValue: "🚀",
			}),
		);
		expect(onClose).toHaveBeenCalled();
	});
});

describe("HostModal for an SSH host", () => {
	it("still opens on its connection, with its remote hints", () => {
		mountModal(SSH);
		expect(el("#tab-connection")?.getAttribute("aria-selected")).toBe("true");
		expect(shown(el("#panel-connection"))).toBe(true);
		expect(shown(el("#panel-appearance"))).toBe(false);
		expect(el("#panel-terminal")?.textContent).toContain("Remote Hints");
	});
});
