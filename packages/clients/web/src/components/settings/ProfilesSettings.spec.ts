/**
 * Deleting a profile from the keyboard (#637). The confirmation is a modal alertdialog: the
 * keyboard goes onto Cancel, the harmless answer; Esc cancels and Tab stays inside; the keyboard
 * then comes back to the Delete button it came from, or, once that profile is gone, to the list.
 */
import type { LaunchProfile } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useProfilesStore } from "../../stores/profiles.js";
import ProfilesSettings from "./ProfilesSettings.vue";

const STAMP = "2026-09-29T00:00:00.000Z";

function profile(id: string, name: string, sortOrder: number): LaunchProfile {
	return {
		id,
		name,
		shell: "bash",
		mode: "shell",
		elevated: false,
		supportedOs: "any",
		iconType: "auto",
		sortOrder,
		createdAt: STAMP,
		updatedAt: STAMP,
	} as LaunchProfile;
}

let app: App | null = null;
let root: HTMLElement;
let pinia: ReturnType<typeof createPinia>;

function mountProfiles() {
	const profilesStore = useProfilesStore();
	vi.spyOn(profilesStore, "fetchProfiles").mockResolvedValue();
	const remove = vi.spyOn(profilesStore, "deleteProfile").mockImplementation(async (id: string) => {
		profilesStore.profiles = profilesStore.profiles.filter((p) => p.id !== id);
	});
	profilesStore.profiles = [profile("p1", "Bash", 0), profile("p2", "Zsh", 1)];
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(ProfilesSettings) });
	app.use(pinia);
	app.mount(root);
	return { remove };
}

beforeEach(() => {
	pinia = createPinia();
	setActivePinia(pinia);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await nextTick();
}

const deleteButtons = (): HTMLButtonElement[] => [
	...root.querySelectorAll<HTMLButtonElement>('button[aria-label="Delete profile"]'),
];

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	(document.activeElement ?? document.body).dispatchEvent(event);
	await settle();
	return event;
}

describe("Deleting a profile", () => {
	it("asks in a modal alertdialog, with the keyboard on Cancel", async () => {
		mountProfiles();
		await settle();
		deleteButtons()[1]?.focus();
		deleteButtons()[1]?.click();
		await settle();
		const dialog = root.querySelector('[role="alertdialog"]') as HTMLElement;
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
			"Delete Profile",
		);
		expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
	});

	it("cancels on Esc, which it keeps, and gives the keyboard back to the Delete button", async () => {
		mountProfiles();
		await settle();
		const second = deleteButtons()[1] as HTMLButtonElement;
		second.focus();
		second.click();
		await settle();
		const esc = await press("Escape");
		// Kept from Settings, whose Esc would otherwise go to the menu.
		expect(esc.defaultPrevented).toBe(true);
		expect(root.querySelector('[role="alertdialog"]')).toBeNull();
		expect(document.activeElement).toBe(second);
	});

	it("keeps Tab inside", async () => {
		mountProfiles();
		await settle();
		deleteButtons()[0]?.click();
		await settle();
		const back = await press("Tab", { shiftKey: true });
		expect(back.defaultPrevented).toBe(true);
		expect(root.querySelector('[role="alertdialog"]')?.contains(document.activeElement)).toBe(true);
	});

	it("gives the keyboard to the list once the profile is gone with its button", async () => {
		const { remove } = mountProfiles();
		await settle();
		deleteButtons()[1]?.focus();
		deleteButtons()[1]?.click();
		await settle();
		(root.querySelector(".btn-danger") as HTMLButtonElement).click();
		await settle();
		expect(remove).toHaveBeenCalledWith("p2");
		expect(root.querySelector('[role="alertdialog"]')).toBeNull();
		expect(root.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(document.body);
	});
});
