/**
 * Options, the Files part's last row (#836): the attached host's file transfer settings as they
 * hold for its terminal, where each comes from, and a change that asks its scope before anything
 * is written, through #835's shared scoped write, which drops the nearer overrides.
 */
import { DEFAULT_PROFILE } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useSettingsStore } from "../../stores/settings.js";
import FilesOptions from "./FilesOptions.vue";

const HOST = "01ARZ3NDEKTSV4RRFFQ69G5FHH";
const CHANNEL = "01ARZ3NDEKTSV4RRFFQ69G5FCC";

interface Layers {
	global: Record<string, unknown>;
	host: Record<string, unknown>;
	channel: Record<string, unknown>;
}

/** The hub's layers for the terminal: what each scope holds, read afresh at each request. */
let layers: Layers;
/** The writes the panel sent, in order. */
let writes: { method: string; path: string; body: unknown }[];

function cascadeBody(): unknown {
	const resolved = { ...DEFAULT_PROFILE, ...layers.global, ...layers.host, ...layers.channel };
	return { terminal: { defaults: DEFAULT_PROFILE, ...layers, resolved } };
}

function respond(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	layers = {
		global: {},
		host: { transferOnConflict: "keep_both", transferFollowCwd: true },
		channel: { transferConfirmDrop: false },
	};
	writes = [];
	mocks.hubFetch.mockReset();
	mocks.hubFetch.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.startsWith("/api/config/cascade")) return respond(cascadeBody());
		writes.push({
			method: init?.method ?? "GET",
			path,
			body: JSON.parse(String(init?.body ?? "null")),
		});
		return respond({ ok: true });
	});
	useConfigStore().uiConfig = {
		onChannelDead: "readonly",
		transfer: { showHidden: false, openOnDrag: true },
	};
	useFilesPanelStore().setOptionsExpanded(true);
});

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

/** Every request answered and every render done: a response's body is read in a later task. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

async function mountOptions(props: Record<string, unknown> = {}): Promise<void> {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(FilesOptions, {
				hostId: HOST,
				channelId: CHANNEL,
				hostLabel: "nas",
				verifyApplies: true,
				verifyReason: "only over SSH commands: this host has SFTP",
				...props,
			}),
	});
	app.mount(root);
	await settle();
}

function row(label: string): HTMLElement {
	const found = [...root.querySelectorAll<HTMLElement>(".files-option")].find(
		(el) => el.querySelector(".files-option__label")?.textContent?.trim() === label,
	);
	if (found === undefined) throw new Error(`no row ${label}`);
	return found;
}

const sourceOf = (label: string): string =>
	row(label).querySelector(".files-option__source")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const switchOf = (label: string): HTMLInputElement =>
	row(label).querySelector<HTMLInputElement>('input[role="switch"]') as HTMLInputElement;
const question = (): HTMLElement | null => root.querySelector('.files-scope[role="group"]');
const choiceButtons = (): string[] =>
	[...(question()?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim() ?? "");

function flip(input: HTMLInputElement): void {
	input.checked = !input.checked;
	input.dispatchEvent(new Event("change"));
}

describe("Options collapsed and expanded", () => {
	it("names the effective values in one line when collapsed, and opens on its button", async () => {
		useFilesPanelStore().setOptionsExpanded(false);
		await mountOptions();
		const toggle = root.querySelector<HTMLButtonElement>(
			".files-options__toggle",
		) as HTMLButtonElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.textContent?.trim()).toBe("Options · Keep both · Following · Verify");
		toggle.click();
		await settle();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(useFilesPanelStore().optionsExpanded).toBe(true);
	});

	it("names Verify only for a host without SFTP", async () => {
		useFilesPanelStore().setOptionsExpanded(false);
		await mountOptions({ verifyApplies: false });
		expect(root.querySelector(".files-options__toggle")?.textContent?.trim()).toBe(
			"Options · Keep both · Following",
		);
	});

	it("shows each value with where it comes from: everywhere, the host, or this terminal", async () => {
		layers.global = { transferVerify: false };
		await mountOptions();
		expect(sourceOf("When a file already exists")).toBe("from nas");
		expect(sourceOf("Show the destination before a dropped upload")).toBe("from this terminal");
		expect(sourceOf("Follow the terminal's directory")).toBe("from nas");
		expect(sourceOf("Verify uploads by SHA-256")).toBe("from everywhere");
		expect(row("When a file already exists").querySelector("select")?.value).toBe("keep_both");
		expect(switchOf("Show the destination before a dropped upload").checked).toBe(false);
		expect(switchOf("Verify uploads by SHA-256").checked).toBe(false);
		expect(sourceOf("Show hidden files")).toBe("everywhere only");
	});

	it("dims Verify with its reason on a host with SFTP", async () => {
		await mountOptions({ verifyApplies: false });
		expect(row("Verify uploads by SHA-256").classList).toContain("files-option--dim");
		expect(sourceOf("Verify uploads by SHA-256")).toContain(
			"only over SSH commands: this host has SFTP",
		);
	});
});

describe("a change asks its scope", () => {
	it("writes nothing before a scope is chosen, then writes it for the host and drops the terminal's", async () => {
		layers.channel = { transferFollowCwd: true };
		await mountOptions();
		flip(switchOf("Follow the terminal's directory"));
		await settle();
		expect(writes).toEqual([]);
		expect(question()?.getAttribute("aria-label")).toBe(
			"Keep Follow the terminal's directory: Off for",
		);
		expect(choiceButtons()).toEqual(["nas", "Everywhere", "Cancel"]);
		// The keyboard moves into the question.
		expect(document.activeElement?.textContent?.trim()).toBe("nas");
		expect(sourceOf("Follow the terminal's directory")).toBe("changed, not saved");
		// It says first what each scope would drop.
		expect(question()?.textContent).toContain("nas also drops this terminal's own value (On).");

		question()?.querySelector<HTMLButtonElement>("button")?.click();
		await settle();
		expect(writes).toEqual([
			{
				method: "PATCH",
				path: `/api/hosts/${HOST}/profile`,
				body: { profile: { transferFollowCwd: false } },
			},
			{
				method: "PATCH",
				path: `/api/channels/${CHANNEL}/profile`,
				body: { profile: { transferFollowCwd: null } },
			},
		]);
		expect(question()).toBeNull();
	});

	it("writes everywhere, dropping the host's own value, and says so first", async () => {
		await mountOptions();
		const select = row("When a file already exists").querySelector("select") as HTMLSelectElement;
		select.value = "replace";
		select.dispatchEvent(new Event("change"));
		await settle();
		expect(question()?.textContent).toContain("Everywhere also drops nas's own value (Keep both).");
		const everywhere = [...(question()?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent?.trim() === "Everywhere",
		) as HTMLButtonElement;
		// What the hub holds after the write, read again for the rows.
		mocks.hubFetch.mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.startsWith("/api/config/cascade")) return respond(cascadeBody());
			writes.push({
				method: init?.method ?? "GET",
				path,
				body: JSON.parse(String(init?.body ?? "null")),
			});
			if (path === "/api/config/global") layers.global = { transferOnConflict: "replace" };
			if (path.startsWith("/api/hosts/")) layers.host = { transferFollowCwd: true };
			return respond({ ok: true });
		});
		everywhere.click();
		await settle();
		expect(writes.map((w) => [w.method, w.path, w.body])).toEqual([
			["PUT", "/api/config/global", { terminal: { transferOnConflict: "replace" } }],
			["PATCH", `/api/hosts/${HOST}/profile`, { profile: { transferOnConflict: null } }],
			["PATCH", `/api/channels/${CHANNEL}/profile`, { profile: { transferOnConflict: null } }],
		]);
		expect(sourceOf("When a file already exists")).toBe("from everywhere");
		expect(select.value).toBe("replace");
	});

	it("puts the control back on Esc or Cancel, writing nothing", async () => {
		await mountOptions();
		const follow = switchOf("Follow the terminal's directory");
		flip(follow);
		await settle();
		expect(follow.checked).toBe(false);
		question()?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
		await settle();
		expect(question()).toBeNull();
		expect(follow.checked).toBe(true);
		expect(document.activeElement).toBe(follow);
		// The window leaves that Esc to the question (App.vue).
		flip(follow);
		await settle();
		expect(question()?.hasAttribute("data-own-escape")).toBe(true);
		const cancel = [...(question()?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent?.trim() === "Cancel",
		) as HTMLButtonElement;
		cancel.click();
		await settle();
		expect(follow.checked).toBe(true);
		expect(writes).toEqual([]);
	});

	it("updates live when a value changes in Settings or another window", async () => {
		await mountOptions();
		expect(sourceOf("Follow the terminal's directory")).toBe("from nas");
		layers.host = { transferOnConflict: "keep_both" };
		layers.global = { transferFollowCwd: false };
		// CONFIG_CHANGED, as every window turns it into a profile change (stores/session.ts).
		useConfigStore().emitProfileChange({ scope: "host", hostId: HOST });
		await settle();
		expect(sourceOf("Follow the terminal's directory")).toBe("from everywhere");
		expect(switchOf("Follow the terminal's directory").checked).toBe(false);
	});
});

describe("the window's own options, and the way to Settings", () => {
	it("applies Show hidden files and Open on drag at once, everywhere", async () => {
		await mountOptions();
		flip(switchOf("Show hidden files"));
		await settle();
		expect(question()).toBeNull();
		expect(writes).toEqual([
			{ method: "PUT", path: "/api/config/ui", body: { transfer: { showHidden: true } } },
		]);
		expect(useConfigStore().uiConfig.transfer?.showHidden).toBe(true);
	});

	it("opens Settings › File transfer at this host's scope", async () => {
		await mountOptions();
		root.querySelector<HTMLButtonElement>(".files-options__all")?.click();
		const settings = useSettingsStore();
		expect(settings.panelOpen).toBe(true);
		expect(settings.activeCategory).toBe("transfer");
		expect(settings.activeScope).toBe("host");
		expect(settings.target).toEqual({ hostId: HOST, channelId: CHANNEL });
	});
});
