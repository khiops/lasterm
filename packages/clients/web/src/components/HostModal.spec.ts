import { type Host, toSnakeCase } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { getColorFromLabel } from "../composables/useHostIcon.js";
import { useAuthStore } from "../stores/auth.js";
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
		// What was changed, and nothing else (#789).
		expect(body).toEqual({ color: "#ff8800", icon_type: "emoji", icon_value: "🚀" });
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

describe("HostModal when the hub refuses a save (#703)", () => {
	/** The hub's refusal, as it sends one. */
	function refusal(code: string, message: string): Response {
		return new Response(JSON.stringify({ error: { code, message } }), {
			status: 409,
			headers: { "Content-Type": "application/json" },
		});
	}

	/** The SSH host as the hub answers its update, snake_case as on the wire. */
	function stored(label: string): Response {
		return new Response(
			JSON.stringify({
				id: SSH.id,
				type: "ssh",
				label,
				ssh_host: "192.168.1.20",
				ssh_auth: "agent",
				icon_type: "auto",
				trust_remote_hints: "apply",
				sort_order: 0,
				os: "linux",
				arch: "arm64",
				created_at: STAMP,
				updated_at: STAMP,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	function type(selector: string, value: string): void {
		const input = el<HTMLInputElement>(selector);
		if (!input) throw new Error(`no ${selector}`);
		input.value = value;
		input.dispatchEvent(new Event("input"));
	}

	async function clickSave(): Promise<void> {
		el<HTMLButtonElement>(".dialog-actions .btn-primary")?.click();
		await settle();
	}

	const alert = (): HTMLElement | null => el(".dialog-actions [role='alert']");

	it("shows the hub's reason beside Save, keeps the dialog and the edit, and clears it once saved", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(refusal("CONFLICT", "Host with this label already exists"))
			.mockResolvedValueOnce(stored("pi-2"));
		const { onSaved, onClose } = mountModal(SSH);
		expect(alert()).toBeNull();
		type("input[placeholder='prod-server']", "pi-2");
		await nextTick();

		await clickSave();

		expect(alert()?.textContent).toBe("Host with this label already exists");
		expect(onSaved).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(el<HTMLInputElement>("input[placeholder='prod-server']")?.value).toBe("pi-2");
		expect(el<HTMLButtonElement>(".dialog-actions .btn-primary")?.disabled).toBe(false);

		await clickSave();

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(alert()).toBeNull();
		expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: SSH.id, label: "pi-2" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("says why a host reached through its daemon cannot become Windows (#674)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			refusal("DAEMON_CONNECTED", "Use Stop keeping an agent here to stop the connected daemon."),
		);
		const { onClose } = mountModal(SSH);
		useHostsStore().rememberConnectedThroughRemoteDaemon(SSH.id, true);
		const os = Array.from(document.body.querySelectorAll<HTMLSelectElement>("select")).find(
			(select) => Array.from(select.options).some((option) => option.value === "darwin"),
		);
		if (!os) throw new Error("no OS select");
		os.value = "windows";
		os.dispatchEvent(new Event("change"));
		await nextTick();

		await clickSave();

		expect(alert()?.textContent).toBe(
			"Use Stop keeping an agent here to stop the connected daemon.",
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(os.value).toBe("windows");
	});

	it("says so when the hub does not answer", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const { onClose } = mountModal(SSH);

		await clickSave();

		expect(alert()?.textContent).toBe("Could not reach the hub: Failed to fetch");
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe("HostModal open while another window changes the hosts (#783)", () => {
	const OTHER: Host = { ...SSH, id: "01OTHERHOST0000000000000000", label: "pi-2" };

	function type(selector: string, value: string): HTMLInputElement {
		const input = el<HTMLInputElement>(selector);
		if (!input) throw new Error(`no ${selector}`);
		input.value = value;
		input.dispatchEvent(new Event("input"));
		return input;
	}

	it("keeps what was typed, and finds the name taken once another window took it", async () => {
		mountModal(SSH);
		useAuthStore().setToken("token");
		const label = type("input[placeholder='prod-server']", "pi-2");
		const address = type("input[placeholder='192.168.1.100']", "10.0.0.7");
		await nextTick();
		const labelError = () => label.parentElement?.querySelector(".field-error") ?? null;
		const save = () => el<HTMLButtonElement>(".dialog-actions .btn-primary");
		expect(labelError()).toBeNull();
		expect(save()?.disabled).toBe(false);

		// Another window names a new host pi-2, and the hub says the hosts changed.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const body = String(input).includes("/api/host-groups")
				? []
				: toSnakeCase([LOCAL, SSH, OTHER]);
			return new Response(JSON.stringify(body), {
				headers: { "Content-Type": "application/json" },
			});
		});
		useHostsStore().hubChanged("hosts");

		await vi.waitFor(() =>
			expect(labelError()?.textContent?.trim()).toBe("Host name already exists"),
		);
		expect(save()?.disabled).toBe(true);
		expect(label.value).toBe("pi-2");
		expect(address.value).toBe("10.0.0.7");
	});
});

describe("HostModal open while the hub detects the host's OS (#789)", () => {
	/** The host as this window knew it when the dialog opened, and as the hub has it since. */
	const UNDETECTED: Host = { ...SSH, os: null, arch: null };
	const DETECTED: Host = { ...SSH, os: "linux", arch: "arm64" };

	/** The hub: its lists as they are now, and every save it is sent, as sent. */
	function hubWithDetectedOs(): Array<Record<string, unknown>> {
		const saves: Array<Record<string, unknown>> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			let body: unknown = String(input).includes("/api/host-groups")
				? []
				: toSnakeCase([LOCAL, DETECTED]);
			if (init?.method === "PUT") {
				const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
				saves.push(sent);
				body = { ...(toSnakeCase(DETECTED) as Record<string, unknown>), ...sent };
			}
			return new Response(JSON.stringify(body), {
				headers: { "Content-Type": "application/json" },
			});
		});
		return saves;
	}

	function osSelect(): HTMLSelectElement {
		const select = Array.from(document.body.querySelectorAll<HTMLSelectElement>("select")).find(
			(candidate) => Array.from(candidate.options).some((option) => option.value === "darwin"),
		);
		if (!select) throw new Error("no OS select");
		return select;
	}

	function type(selector: string, value: string): void {
		const input = el<HTMLInputElement>(selector);
		if (!input) throw new Error(`no ${selector}`);
		input.value = value;
		input.dispatchEvent(new Event("input"));
	}

	async function clickSave(): Promise<void> {
		el<HTMLButtonElement>(".dialog-actions .btn-primary")?.click();
		await settle();
	}

	/** The dialog on the host as this window knows it, its OS not detected yet. */
	function mountUndetected(): ReturnType<typeof mountModal> {
		const mounted = mountModal(UNDETECTED);
		useHostsStore().hosts = [{ ...LOCAL }, { ...UNDETECTED }];
		useAuthStore().setToken("token");
		return mounted;
	}

	/** The hub said the hosts changed, and this window has read them again. */
	async function hubDetectedTheOs(): Promise<void> {
		useHostsStore().hubChanged("hosts");
		await vi.waitFor(() =>
			expect(useHostsStore().hosts.find((host) => host.id === SSH.id)?.os).toBe("linux"),
		);
		await nextTick();
	}

	it("leaves the OS detected meanwhile to the hub when a save did not touch it", async () => {
		const saves = hubWithDetectedOs();
		const { onSaved } = mountUndetected();
		type("input[placeholder='prod-server']", "pi-renamed");
		await nextTick();

		await hubDetectedTheOs();
		await clickSave();

		expect(saves).toEqual([{ label: "pi-renamed" }]);
		expect(onSaved).toHaveBeenCalledWith(
			expect.objectContaining({ label: "pi-renamed", os: "linux", arch: "arm64" }),
		);
	});

	it("shows the OS detected meanwhile, keeping what was typed", async () => {
		hubWithDetectedOs();
		mountUndetected();
		type("input[placeholder='prod-server']", "pi-renamed");
		await nextTick();
		expect(osSelect().value).not.toBe("linux");

		await hubDetectedTheOs();

		expect(osSelect().value).toBe("linux");
		expect(el<HTMLInputElement>("input[placeholder='prod-server']")?.value).toBe("pi-renamed");
	});

	it("keeps an OS the user chose, and sends it, whatever the hub detected meanwhile", async () => {
		const saves = hubWithDetectedOs();
		mountUndetected();
		const os = osSelect();
		os.value = "windows";
		os.dispatchEvent(new Event("change"));
		await nextTick();

		await hubDetectedTheOs();
		expect(osSelect().value).toBe("windows");
		await clickSave();

		expect(saves).toEqual([{ os: "windows" }]);
	});
});

describe("HostModal reading the hub's SSH config (#734, #757)", () => {
	/** The hub's answers to its SSH config, in turn; anything else it is not asked. */
	function sshConfigAnswers(...answers: Array<Response | Error>) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (!String(input).includes("/api/ssh-config")) throw new Error(`unexpected ${input}`);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more SSH config answers");
			if (next instanceof Error) throw next;
			return next;
		});
	}

	function json(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	async function chooseSshConfig(): Promise<void> {
		const tab = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".source-tab")).find(
			(button) => button.textContent?.includes("From SSH config"),
		);
		if (!tab) throw new Error("no SSH config source");
		tab.click();
		await settle();
		await nextTick();
	}

	const alert = (): HTMLElement | null => el(".ssh-config-error[role='alert']");

	it("says the hub's reason in the dialog, and clears it once a retry reads it", async () => {
		sshConfigAnswers(
			json(500, { error: { code: "INTERNAL", message: "EACCES: permission denied" } }),
			json(200, { entries: [{ name: "pi", hostname: "pi.test" }], has_include: false }),
		);
		const { onClose } = mountModal(null);

		await chooseSshConfig();

		expect(alert()?.textContent?.trim()).toBe("EACCES: permission denied");
		expect(onClose).not.toHaveBeenCalled();

		await chooseSshConfig();

		expect(alert()).toBeNull();
		const options = Array.from(document.body.querySelectorAll<HTMLOptionElement>("option")).map(
			(option) => option.value,
		);
		expect(options).toContain("pi");
	});

	it("says so when the hub does not answer, with no unhandled rejection", async () => {
		sshConfigAnswers(new TypeError("Failed to fetch"));
		mountModal(null);

		await chooseSshConfig();

		expect(alert()?.textContent?.trim()).toBe("Could not reach the hub: Failed to fetch");
	});

	it("reads its snake_case entries: git hosts left out, the chosen one's key path filled in (#757)", async () => {
		const entry = (name: string, fields: Record<string, unknown>) => ({
			name,
			hostname: `${name}.test`,
			port: 22,
			user: null,
			identity_file: null,
			proxy_jump: null,
			is_git_host: false,
			...fields,
		});
		sshConfigAnswers(
			json(200, {
				entries: [
					entry("pi", { identity_file: "~/.ssh/id_pi" }),
					entry("github", { hostname: "github.com", user: "git", is_git_host: true }),
				],
				has_include: false,
			}),
		);
		mountModal(null);

		await chooseSshConfig();

		const select = Array.from(document.body.querySelectorAll<HTMLSelectElement>("select")).find(
			(candidate) => Array.from(candidate.options).some((option) => option.value === "pi"),
		);
		if (!select) throw new Error("no SSH host select");
		expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "pi"]);

		select.value = "pi";
		select.dispatchEvent(new Event("change"));
		await nextTick();

		expect(el<HTMLInputElement>("input[placeholder='~/.ssh/id_ed25519']")?.value).toBe(
			"~/.ssh/id_pi",
		);
	});
});

describe("live daemon edit guard", () => {
	it.each([true, false])(
		"disables the daemon select only for a daemon connection: %s",
		async (connected) => {
			mountModal(SSH);
			useHostsStore().rememberConnectedThroughRemoteDaemon(SSH.id, connected);
			await nextTick();
			const select = Array.from(document.body.querySelectorAll("select")).find((candidate) =>
				Array.from(candidate.options).some((option) => option.value === "yes"),
			);
			expect(select).toBeDefined();
			expect(select?.disabled).toBe(connected);
			expect(
				document.body.textContent?.includes(
					"To stop it, use Stop keeping an agent here in the host menu.",
				),
			).toBe(connected);
		},
	);
});
