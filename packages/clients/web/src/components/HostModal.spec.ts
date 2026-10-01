import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { getColorFromLabel } from "../composables/useHostIcon.js";
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

function mountModal(editHost: Host | null = null) {
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

describe("HostModal visual profile: a border in the host's colour (#663)", () => {
	/** The local host, with a border of a colour of its own and another setting beside it. */
	const BORDERED: Host = {
		...LOCAL,
		profileJson: JSON.stringify({
			fontSize: 15,
			visualProfile: {
				preset: "custom",
				banner: { enabled: false, text: "", bgColor: "#e06c75", textColor: "#ffffff" },
				border: { style: "subtle", color: "#123456" },
				tint: { enabled: false, color: "#e06c75", opacity: 0 },
			},
		}),
	};

	function check(selector: string, checked: boolean): void {
		const box = el<HTMLInputElement>(selector);
		if (!box) throw new Error(`no ${selector}`);
		box.checked = checked;
		box.dispatchEvent(new Event("change"));
	}

	it("shows the host's colour as its badge has it, and follows the one being picked", async () => {
		mountModal(BORDERED);
		expect(el<HTMLInputElement>("#panel-appearance input.border-inherit")?.checked).toBe(false);
		check("#panel-appearance input.border-inherit", true);
		await nextTick();
		// The local host has no colour: its badge, and so its border, take the label's.
		expect(el(".host-swatch")?.getAttribute("aria-label")).toBe(
			`Host color ${getColorFromLabel("local")}`,
		);

		const identity = el<HTMLInputElement>(".identity-color-input");
		if (!identity) throw new Error("no host colour input");
		identity.value = "#ff8800";
		identity.dispatchEvent(new Event("input"));
		await nextTick();
		expect(el(".host-swatch")?.getAttribute("aria-label")).toBe("Host color #ff8800");
	});

	it("saves no border colour once Use host color is checked again", async () => {
		const answer = {
			id: LOCAL.id,
			type: "local",
			label: "local",
			icon_type: "auto",
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
		mountModal(BORDERED);
		check("#panel-appearance input.border-inherit", true);
		await nextTick();

		el<HTMLButtonElement>(".dialog-actions .btn-primary")?.click();
		await settle();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [, init] = fetchSpy.mock.calls[0] ?? [];
		const body = JSON.parse(String(init?.body)) as { profile_json: string };
		const saved = JSON.parse(body.profile_json) as {
			fontSize: number;
			visualProfile: { border: unknown };
		};
		expect(saved.visualProfile.border).toEqual({ style: "subtle", color: "" });
		expect(saved.fontSize).toBe(15);
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

describe("HostModal remote daemon choice", () => {
	function selectWithOption(text: string): HTMLSelectElement {
		const select = Array.from(document.body.querySelectorAll<HTMLSelectElement>("select")).find(
			(candidate) => Array.from(candidate.options).some((option) => option.textContent === text),
		);
		if (!select) throw new Error(`no select with ${text}`);
		return select;
	}

	function choose(select: HTMLSelectElement, value: string): void {
		select.value = value;
		select.dispatchEvent(new Event("change"));
	}

	async function prepareNewHost(): Promise<() => Promise<Record<string, unknown>>> {
		const answer = {
			...SSH,
			id: "01NEWSSHHOST00000000000000",
			label: "daemon-host",
			ssh_host: "10.0.0.8",
			ssh_auth: "agent",
			ssh_remote_daemon: true,
			created_at: STAMP,
			updated_at: STAMP,
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(answer), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);
		mountModal();
		const name = el<HTMLInputElement>("input[placeholder='prod-server']");
		const host = el<HTMLInputElement>("input[placeholder='192.168.1.100']");
		if (!name || !host) throw new Error("no new-host inputs");
		name.value = "daemon-host";
		name.dispatchEvent(new Event("input"));
		host.value = "10.0.0.8";
		host.dispatchEvent(new Event("input"));
		choose(selectWithOption("SSH Agent"), "agent");
		await nextTick();
		return () =>
			new Promise((resolve) => {
				const save = el<HTMLButtonElement>(".dialog-actions .btn-primary");
				if (!save) throw new Error("no save button");
				save.click();
				setTimeout(() => {
					const [, init] = fetchSpy.mock.calls[0] ?? [];
					resolve(JSON.parse(String(init?.body)));
				}, 0);
			});
	}

	it("discloses the preselected Yes choice and saves true for a new host", async () => {
		const save = await prepareNewHost();
		expect(el("#panel-connection")?.textContent).toContain(
			"30 minutes with no terminal and no hub connected",
		);
		const body = await save();
		expect(body).toHaveProperty("ssh_remote_daemon", true);
	});

	it("saves false after choosing No", async () => {
		const save = await prepareNewHost();
		choose(selectWithOption("No — leave nothing behind"), "no");
		expect(await save()).toHaveProperty("ssh_remote_daemon", false);
	});

	it("saves null after choosing Follow the global setting", async () => {
		const save = await prepareNewHost();
		choose(selectWithOption("Follow the global setting"), "");
		expect(await save()).toHaveProperty("ssh_remote_daemon", null);
	});

	it("hides the choice and saves null when Windows is selected", async () => {
		const save = await prepareNewHost();
		choose(selectWithOption("Windows"), "windows");
		await nextTick();
		expect(el("#panel-connection")?.textContent).toContain("Not available on Windows hosts");
		expect(document.body.querySelector("select option[value='yes']")).toBeNull();
		expect(await save()).toHaveProperty("ssh_remote_daemon", null);
	});

	it("shows the setting as unavailable when editing a Windows host", () => {
		mountModal({ ...SSH, os: "windows", sshRemoteDaemon: true });
		expect(el("#panel-connection")?.textContent).toContain("Not available on Windows hosts");
		expect(document.body.querySelector("select option[value='yes']")).toBeNull();
	});
});
