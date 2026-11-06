/**
 * Settings › File transfer (#835), mounted with the real settings store and
 * the real schema rows: the experimental switch alone while it is off, at
 * every scope; once on, the upload keys at each scope they apply to, with the
 * override bar and the inheritance of other categories, and the files panel's
 * keys globally.
 */
import {
	type CascadeResponse,
	DEFAULT_APPEARANCE,
	DEFAULT_ELEVATION_CONFIG,
	DEFAULT_EXPERIMENTAL_CONFIG,
	DEFAULT_PROFILE,
	DEFAULT_SSH_CONFIG,
	DEFAULT_TRANSFER_CONFIG,
	deepMerge,
	type TerminalProfile,
	type UiConfig,
} from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";
import { type Scope, useSettingsStore } from "../../../stores/settings.js";
import FileTransferCategory from "./FileTransferCategory.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

/** A cascade where the host overrides one upload key, and the switch is as given. */
function cascadeWith(fileTransfer: boolean): CascadeResponse {
	const host: Partial<TerminalProfile> = { transferOnConflict: "replace" };
	const ui = {
		transfer: { ...DEFAULT_TRANSFER_CONFIG },
		experimental: { ...DEFAULT_EXPERIMENTAL_CONFIG, fileTransfer },
	} as unknown as UiConfig;
	return {
		terminal: {
			defaults: DEFAULT_PROFILE,
			global: {},
			host,
			channel: {},
			resolved: deepMerge<TerminalProfile>(DEFAULT_PROFILE, host),
		},
		ui: {
			defaults: ui,
			global: fileTransfer ? { experimental: { fileTransfer: true } } : {},
			resolved: ui,
		},
		appearance: DEFAULT_APPEARANCE,
		elevation: DEFAULT_ELEVATION_CONFIG,
		ssh: DEFAULT_SSH_CONFIG,
	};
}

function mount(scope: Scope, fileTransfer: boolean) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const settingsStore = useSettingsStore();
	settingsStore.cascade = cascadeWith(fileTransfer);
	const update = vi.spyOn(settingsStore, "updateSetting").mockResolvedValue();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(FileTransferCategory, { scope, hostName: "build-box" });
	app.use(pinia);
	app.mount(root);
	return { settingsStore, update };
}

function labels(): string[] {
	return [...root.querySelectorAll(".setting-label")].map((el) => el.textContent?.trim() ?? "");
}

function headings(): string[] {
	return [...root.querySelectorAll("h3")].map((el) => el.firstChild?.textContent?.trim() ?? "");
}

function row(label: string): HTMLElement {
	const found = [...root.querySelectorAll<HTMLElement>(".setting-row")].find(
		(el) => el.querySelector(".setting-label")?.textContent?.trim() === label,
	);
	if (found === undefined) throw new Error(`no row ${label}`);
	return found;
}

const UPLOADS = [
	"Files dropped on a terminal",
	"Confirm before uploading",
	"When a file already exists",
	"Upload to the shell's folder",
];
const HOST_ONLY = ["Upload folder", "Verify uploads without SFTP"];
const PANEL = [
	"Panel side",
	"Open when files are dragged in",
	"Transfers at once",
	"Show hidden files",
];

describe("Settings › File transfer, while the switch is off", () => {
	it.each(["global", "host", "channel"] as const)(
		"shows the switch and one line, and nothing else, at %s scope",
		(scope) => {
			mount(scope, false);
			expect(labels()).toEqual(["File transfer"]);
			expect(root.querySelectorAll('input[role="switch"]')).toHaveLength(1);
			expect(root.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
			expect(root.querySelector(".transfer-off")?.textContent).toMatch(/^\s*Off: /);
			expect(root.querySelector(".experimental-badge")?.textContent).toBe("Experimental");
		},
	);

	it("turns it on for every host, whatever the scope shown", async () => {
		const { update } = mount("host", false);
		const toggle = root.querySelector<HTMLInputElement>('input[role="switch"]');
		if (toggle === null) throw new Error("no switch");
		toggle.checked = true;
		toggle.dispatchEvent(new Event("change"));
		await nextTick();
		expect(update).toHaveBeenCalledExactlyOnceWith(
			"global",
			"ui",
			"experimental.fileTransfer",
			true,
		);
		// The switch is global: no override bar, no reset, at host scope.
		expect(row("File transfer").querySelector(".override-bar")).toBeNull();
		expect(row("File transfer").querySelector(".reset-button")).toBeNull();
	});
});

describe("Settings › File transfer, once the switch is on", () => {
	it("shows the upload keys and the panel's at global scope", () => {
		mount("global", true);
		expect(root.querySelector(".transfer-off")).toBeNull();
		expect(labels()).toEqual(["File transfer", ...UPLOADS, ...HOST_ONLY, ...PANEL]);
		expect(headings()).toEqual(["File transfer", "Uploads", "Panel"]);
	});

	it("shows every upload key at host scope, with the override and what is inherited", () => {
		mount("host", true);
		expect(labels()).toEqual(["File transfer", ...UPLOADS, ...HOST_ONLY]);
		expect(headings()).toEqual(["File transfer", "Uploads"]);

		const overridden = row("When a file already exists");
		expect(overridden.querySelector(".override-bar")).not.toBeNull();
		expect(overridden.querySelector(".reset-button")?.textContent?.trim()).toBe("reset to global");
		expect(overridden.querySelector("select")?.value).toBe("replace");

		const inherited = row("Files dropped on a terminal");
		expect(inherited.querySelector(".override-bar")).toBeNull();
		expect(inherited.querySelector(".setting-inherited")?.textContent).toMatch(
			/\(inherited: upload\s+— default\s*\)/,
		);
	});

	it("leaves the host's keys out at a terminal's scope", () => {
		mount("channel", true);
		expect(labels()).toEqual(["File transfer", ...UPLOADS]);
		expect(
			row("When a file already exists").querySelector(".setting-inherited")?.textContent,
		).toMatch(/\(inherited: replace\s+— from Host: build-box\s*\)/);
	});

	it("writes an upload key at the scope shown, and a panel key globally", async () => {
		const { update } = mount("host", true);
		const select = row("When a file already exists").querySelector("select");
		if (select === null) throw new Error("no select");
		select.value = "skip";
		select.dispatchEvent(new Event("change"));
		await nextTick();
		expect(update).toHaveBeenLastCalledWith("host", "terminal", "transferOnConflict", "skip");

		app?.unmount();
		root.remove();
		const global = mount("global", true);
		const side = row("Panel side").querySelector("select");
		if (side === null) throw new Error("no select");
		side.value = "left";
		side.dispatchEvent(new Event("change"));
		await nextTick();
		expect(global.update).toHaveBeenLastCalledWith("global", "ui", "transfer.panelSide", "left");
	});
});
