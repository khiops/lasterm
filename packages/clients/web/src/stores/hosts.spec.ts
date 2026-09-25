import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth.js";
import { SELECTED_HOST_KEY, useHostsStore } from "./hosts.js";

function hostRow(id: string, label: string, type = "ssh"): Record<string, unknown> {
	return {
		id,
		label,
		type,
		host_group_id: null,
		sort_order: 0,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
	};
}

let hostRows: Record<string, unknown>[] = [];

/** The hub's answer to the hosts and host-groups listings. */
const fetchStub = vi.fn(async (url: string) => {
	const body = String(url).includes("/api/host-groups") ? [] : hostRows;
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
});

/** A page load: a fresh app state in the same tab, whose sessionStorage outlives it. */
function load(): ReturnType<typeof useHostsStore> {
	setActivePinia(createPinia());
	useAuthStore().setToken("token");
	return useHostsStore();
}

beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	hostRows = [
		hostRow("local", "This machine", "local"),
		hostRow("pi", "Pi"),
		hostRow("nas", "NAS"),
	];
	vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("the selected host across a reload (#561)", () => {
	it("comes back on the host the tab was showing", async () => {
		const before = load();
		await before.fetchHosts();
		expect(before.selectedHostId).toBe("local");
		before.selectHost("pi");

		const after = load();
		await after.fetchHosts();

		expect(after.selectedHostId).toBe("pi");
	});

	it("comes back on the first host when the hub no longer has that one", async () => {
		const before = load();
		await before.fetchHosts();
		before.selectHost("nas");

		hostRows = hostRows.filter((row) => row.id !== "nas");
		const after = load();
		await after.fetchHosts();

		expect(after.selectedHostId).toBe("local");
	});

	it("keeps it for the tab alone, so a new tab opens on the first host", async () => {
		const before = load();
		await before.fetchHosts();
		before.selectHost("pi");

		expect(sessionStorage.getItem(SELECTED_HOST_KEY)).toBe("pi");
		expect(localStorage.getItem(SELECTED_HOST_KEY)).toBeNull();
	});

	it("lands on the first host, as before, when the tab's storage refuses", async () => {
		const refused = (): never => {
			throw new DOMException("storage refused", "SecurityError");
		};
		// Stubbed rather than spied on: vi.restoreAllMocks() leaves a spy on
		// happy-dom's Storage in place for the tests after it.
		vi.stubGlobal("sessionStorage", {
			getItem: refused,
			setItem: refused,
			removeItem: refused,
			clear: refused,
		});
		const before = load();
		await before.fetchHosts();
		before.selectHost("pi");

		const after = load();
		await after.fetchHosts();

		expect(after.selectedHostId).toBe("local");
	});
});
