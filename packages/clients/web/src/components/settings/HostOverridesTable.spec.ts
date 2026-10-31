/**
 * Settings › Profiles › Per-Host Overrides speaks the hub's snake_case (#800): it sent
 * `overrideType`, which the hub refused with 400, so "Set as Default" never set anything, and it
 * read `overrideType` from an answer that says `override_type`, so it showed no override.
 */
import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";
import { useAuthStore } from "../../stores/auth.js";
import { useHostsStore } from "../../stores/hosts.js";
import HostOverridesTable from "./HostOverridesTable.vue";

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

const HOST = { id: "H1", type: "ssh", label: "pi", sshHost: "pi.test" } as Host;
const PROFILE_ID = "P1";

let app: App | null = null;
let root: HTMLElement;

/** The hub's answer to GET /api/hosts/H1/profiles: this profile, with the override given. */
function hostProfiles(overrideType?: string): Response {
	return new Response(
		JSON.stringify([
			{
				id: PROFILE_ID,
				name: "fish",
				shell: "/usr/bin/fish",
				...(overrideType !== undefined && { override_type: overrideType }),
			},
		]),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

async function mount(): Promise<void> {
	const pinia = createPinia();
	setActivePinia(pinia);
	useAuthStore().token = "token";
	useHostsStore().hosts = [HOST];
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(HostOverridesTable, { profileId: PROFILE_ID });
	app.use(pinia);
	app.mount(root);
	await settle();
}

const badge = () => root.querySelector("td.col-status")?.textContent?.trim();
const select = () => root.querySelector<HTMLSelectElement>("select.override-select");

beforeEach(() => {
	mocks.hubFetch.mockReset();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

describe("Per-Host Overrides", () => {
	it("shows the override the hub reports for a host", async () => {
		mocks.hubFetch.mockResolvedValueOnce(hostProfiles("default"));

		await mount();

		expect(badge()).toBe("Default");
		expect(select()?.value).toBe("default");
	});

	it('sends "Set as Default" as the hub reads it', async () => {
		mocks.hubFetch.mockResolvedValueOnce(hostProfiles());
		await mount();
		expect(badge()).toBe("—");
		mocks.hubFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const control = select();
		if (!control) throw new Error("no override select");
		control.value = "default";
		control.dispatchEvent(new Event("change"));
		await settle();

		const [url, init] = mocks.hubFetch.mock.calls[1] as [string, RequestInit];
		expect(url).toBe(`/api/hosts/H1/profiles/${PROFILE_ID}`);
		expect(init.method).toBe("PUT");
		expect(JSON.parse(init.body as string)).toEqual({ override_type: "default" });
		expect(badge()).toBe("Default");
	});
});
