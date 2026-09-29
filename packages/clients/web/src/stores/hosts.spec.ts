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
const fetchStub = vi.fn(async (url: string, _init?: RequestInit) => {
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

describe("a host's connection, asked for (#648)", () => {
	const WINDOW = "01K6480000000000000000WNDW";

	/** The requests the hub was sent, with their bodies. */
	function sent(): Array<{ url: string; body: unknown }> {
		return fetchStub.mock.calls
			.filter(([url]) => /\/(connect|reconnect|disconnect)$/.test(String(url)))
			.map(([url, init]) => ({
				url: String(url),
				body: JSON.parse(String((init as RequestInit | undefined)?.body)),
			}));
	}

	it("asks for each with this window's id, where the questions it raises go", async () => {
		const store = load();
		useAuthStore().setClientId(WINDOW);
		fetchStub.mockClear();

		await store.connectHost("pi");
		await store.reconnectHost("pi", false);
		await store.disconnectHost("pi", true);

		expect(sent()).toEqual([
			{ url: expect.stringMatching(/\/api\/hosts\/pi\/connect$/), body: { client_id: WINDOW } },
			{
				url: expect.stringMatching(/\/api\/hosts\/pi\/reconnect$/),
				body: { force: false, client_id: WINDOW },
			},
			{
				url: expect.stringMatching(/\/api\/hosts\/pi\/disconnect$/),
				body: { force: true, client_id: WINDOW },
			},
		]);
	});

	it("hands back what the hub answered, refusal included", async () => {
		const store = load();
		fetchStub.mockImplementationOnce(
			async () =>
				new Response(
					JSON.stringify({
						error: { code: "TERMINALS_WOULD_END", message: "2 terminals…", terminals: 2 },
					}),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				),
		);

		const answer = await store.disconnectHost("pi", false);

		expect(answer).toEqual({
			ok: false,
			status: 409,
			body: { error: { code: "TERMINALS_WOULD_END", message: "2 terminals…", terminals: 2 } },
		});
	});

	it("shows a host its user disconnected apart from one offline or lost", () => {
		const store = load();
		store.hosts = [{ id: "pi", label: "Pi", type: "ssh" } as never];
		store.updateSessionStatus("pi", "disconnected");
		expect(store.getHostStatus("pi")).toBe("error");

		store.rememberDisconnectedByUser("pi", true);
		expect(store.getHostStatus("pi")).toBe("disconnected");
		// Still not connected, for a pane waiting on it.
		expect(store.isHostConnected("pi")).toBe(false);

		store.rememberDisconnectedByUser("pi", false);
		expect(store.getHostStatus("pi")).toBe("error");
	});
});
