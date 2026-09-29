/**
 * Saving a launch profile (#665). The form sends the hub's snake_case body. A field the user
 * emptied goes as null, which the hub stores as none; a field left as it was goes as it was, or not
 * at all when it was empty, so a save clears nothing the user did not. A colour picker cannot be
 * emptied, so the colour has a "No color" box.
 */
import type { LaunchProfile } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import ProfileForm from "./ProfileForm.vue";

const STAMP = "2026-09-29T00:00:00.000Z";

/** A profile with nothing but what every profile holds. */
const BARE: LaunchProfile = {
	id: "01PROFILE0000000000000000A",
	name: "Plain",
	shell: "/bin/bash",
	mode: "shell",
	elevated: false,
	supportedOs: "any",
	iconType: "auto",
	sortOrder: 0,
	createdAt: STAMP,
	updatedAt: STAMP,
};

/** A profile with every field that may be empty set. */
const FULL: LaunchProfile = {
	...BARE,
	id: "01PROFILE0000000000000000B",
	name: "Dev shell",
	shell: "/bin/zsh",
	args: ["-l"],
	cwd: "/srv/app",
	env: { EDITOR: "vim" },
	supportedOs: "linux",
	iconType: "emoji",
	iconValue: "🐚",
	color: "#123456",
};

/** The fields of a profile that may be empty, as the hub names them. */
const CLEARABLE = ["args", "cwd", "env", "icon_value", "color", "profile_overrides"];

let app: App | null = null;
let root: HTMLElement | null = null;
let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("lasterm_token", "test-token");
	// The hub, stood in for at fetch, which is what hubFetch calls outside the desktop: a save
	// is answered with the profile, and anything else with an empty list.
	fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		const saving = init?.method === "PUT" || init?.method === "POST";
		const answer = saving
			? {
					id: BARE.id,
					name: "Saved",
					shell: "/bin/bash",
					mode: "shell",
					elevated: false,
					supported_os: "any",
					icon_type: "auto",
					sort_order: 0,
					created_at: STAMP,
					updated_at: STAMP,
				}
			: [];
		return new Response(JSON.stringify(answer), {
			status: init?.method === "POST" ? 201 : 200,
			headers: { "Content-Type": "application/json" },
		});
	});
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	root = null;
	vi.restoreAllMocks();
	localStorage.clear();
});

/** The form as ProfilesSettings mounts it: on a profile to edit, or on none for a new one. */
function mountForm(profile?: LaunchProfile) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const onSaved = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () => h(ProfileForm, profile ? { profile, onSaved } : { onSaved }),
	});
	app.use(pinia);
	app.mount(root);
	return { onSaved };
}

function el<T extends Element = HTMLElement>(selector: string): T | null {
	return root?.querySelector<T>(selector) ?? null;
}

function type(selector: string, value: string): void {
	const input = el<HTMLInputElement>(selector);
	if (!input) throw new Error(`no ${selector}`);
	input.value = value;
	input.dispatchEvent(new Event("input"));
}

function setNoColor(checked: boolean): void {
	const box = el<HTMLInputElement>("#pf-no-color");
	if (!box) throw new Error("no No color box");
	box.checked = checked;
	box.dispatchEvent(new Event("change"));
}

/** Clicks Save, and returns the request it sent to the hub: its method and its body. */
async function save(): Promise<{ method: string; url: string; body: Record<string, unknown> }> {
	el<HTMLButtonElement>(".form-header-actions .btn-primary")?.click();
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	const saves = fetchSpy.mock.calls.filter(
		([, init]) => init?.method === "PUT" || init?.method === "POST",
	);
	expect(saves).toHaveLength(1);
	const [url, init] = saves[0] ?? [];
	return {
		method: String(init?.method),
		url: String(url),
		body: JSON.parse(String(init?.body)) as Record<string, unknown>,
	};
}

describe("ProfileForm colour: No color (#665)", () => {
	it("is checked when the profile has no colour, with no picker", () => {
		mountForm(BARE);
		const box = el<HTMLInputElement>("#pf-no-color");
		expect(box?.checked).toBe(true);
		expect(box?.closest("label")?.textContent?.trim()).toBe("No color");
		expect(el("#pf-color")).toBeNull();
		const group = el(".color-row");
		expect(group?.getAttribute("role")).toBe("group");
		expect(el(`#${group?.getAttribute("aria-labelledby")}`)?.textContent).toBe("Color");
	});

	it("is unchecked when the profile has a colour, which the picker shows", () => {
		mountForm(FULL);
		expect(el<HTMLInputElement>("#pf-no-color")?.checked).toBe(false);
		const picker = el<HTMLInputElement>("#pf-color");
		expect(picker?.type).toBe("color");
		expect(picker?.value).toBe("#123456");
		expect(picker?.getAttribute("aria-label")).toBe("Profile color");
	});

	it("unchecked, shows the picker on a colour, which the save sends", async () => {
		mountForm(BARE);
		setNoColor(false);
		await nextTick();
		expect(el<HTMLInputElement>("#pf-no-color")?.checked).toBe(false);
		expect(el<HTMLInputElement>("#pf-color")?.value).toBe("#3b82f6");
		type("#pf-color", "#00ff88");
		expect((await save()).body.color).toBe("#00ff88");
	});

	it("checked again, hides the picker, and the save clears the colour", async () => {
		mountForm(FULL);
		setNoColor(true);
		await nextTick();
		expect(el<HTMLInputElement>("#pf-no-color")?.checked).toBe(true);
		expect(el("#pf-color")).toBeNull();
		const { body } = await save();
		expect(body).toHaveProperty("color", null);
	});
});

describe("ProfileForm save (#665)", () => {
	it("sends null for the working directory, icon and colour the user cleared", async () => {
		mountForm(FULL);
		type("#pf-cwd", "");
		type("#pf-icon-value", "");
		setNoColor(true);
		await nextTick();

		const { method, url, body } = await save();
		expect(method).toBe("PUT");
		expect(url).toBe(`/api/launch-profiles/${FULL.id}`);
		expect(body).toMatchObject({ cwd: null, icon_value: null, color: null });
		// What was not touched goes as it was, in the hub's names.
		expect(body).toMatchObject({
			name: "Dev shell",
			shell: "/bin/zsh",
			args: ["-l"],
			env: { EDITOR: "vim" },
			supported_os: "linux",
			icon_type: "emoji",
		});
		expect(Object.keys(body).filter((key) => /[A-Z]/.test(key))).toEqual([]);
	});

	it("sends null for the arguments and variables the user removed", async () => {
		mountForm(FULL);
		el<HTMLButtonElement>(".arg-remove")?.click();
		el<HTMLButtonElement>(".env-remove")?.click();
		await nextTick();

		const { body } = await save();
		expect(body).toMatchObject({ args: null, env: null, cwd: "/srv/app", color: "#123456" });
	});

	it("sends a profile left as it was as it was, clearing nothing", async () => {
		mountForm(FULL);
		const { body } = await save();
		expect(body).toMatchObject({
			args: ["-l"],
			cwd: "/srv/app",
			env: { EDITOR: "vim" },
			icon_value: "🐚",
			color: "#123456",
		});
		expect(Object.entries(body).filter(([, value]) => value === null)).toEqual([]);
	});

	it("leaves out the fields a profile never had, so the edit of another clears none", async () => {
		mountForm(BARE);
		type("#pf-name", "Renamed");
		const { method, body } = await save();
		expect(method).toBe("PUT");
		expect(body.name).toBe("Renamed");
		expect(CLEARABLE.filter((key) => key in body)).toEqual([]);
	});

	it("creates a profile with the fields filled in, and none of the empty ones", async () => {
		const { onSaved } = mountForm();
		type("#pf-name", "New");
		type("#pf-shell", "/bin/fish");
		const { method, url, body } = await save();
		expect(method).toBe("POST");
		expect(url).toBe("/api/launch-profiles");
		expect(body).toEqual({
			name: "New",
			shell: "/bin/fish",
			mode: "shell",
			supported_os: "any",
			elevated: false,
			icon_type: "auto",
		});
		expect(onSaved).toHaveBeenCalled();
	});
});
