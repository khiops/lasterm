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

describe("stop-keeping store", () => {
	it("sets, deletes and replaces the per-host daemon map", () => {
		const store = load();
		expect(store.isConnectedThroughRemoteDaemon("pi")).toBe(false);
		store.rememberConnectedThroughRemoteDaemon("pi", true);
		expect(store.isConnectedThroughRemoteDaemon("pi")).toBe(true);
		store.rememberConnectedThroughRemoteDaemon("pi", undefined);
		expect(store.isConnectedThroughRemoteDaemon("pi")).toBe(false);
		store.rememberConnectedThroughRemoteDaemon("pi", true);
		store.rememberConnectedThroughRemoteDaemon("pi", false);
		expect(store.isConnectedThroughRemoteDaemon("pi")).toBe(false);
		store.setConnectedThroughRemoteDaemon(["pi", "nas"]);
		store.setConnectedThroughRemoteDaemon(["nas"]);
		expect(store.isConnectedThroughRemoteDaemon("pi")).toBe(false);
		expect(store.isConnectedThroughRemoteDaemon("nas")).toBe(true);
	});

	it("posts consent without client_id and converts the returned host for the cache", async () => {
		const store = load();
		await store.fetchHosts();
		useAuthStore().setClientId("window-id");
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					outcome: "disabled_not_stopped",
					message: "may still run",
					host: { ...hostRow("pi", "Pi"), ssh_remote_daemon: false },
				}),
			),
		);
		vi.stubGlobal("fetch", fetch);
		const answer = await store.stopKeepingAgent("pi", { end_terminals: true, force: true });
		expect(fetch.mock.calls[0]?.[0]).toMatch(/\/api\/hosts\/pi\/agent\/stop-keeping$/);
		expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ end_terminals: true, force: true });
		expect(answer.body.host?.sshRemoteDaemon).toBe(false);
		if (!answer.body.host) throw new Error("missing host");
		store.replaceCachedHost(answer.body.host);
		expect(store.hosts.find((h) => h.id === "pi")?.sshRemoteDaemon).toBe(false);
	});
});

describe("a host's save, refused (#703)", () => {
	/** The hub's answer to the next request: a refusal in its own words, or a body. */
	function answerOnce(status: number, body: unknown): void {
		fetchStub.mockImplementationOnce(
			async () =>
				new Response(body === undefined ? null : JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
		);
	}

	it("hands back the hub's code and message for a label already taken", async () => {
		const store = load();
		await store.fetchHosts();
		answerOnce(409, {
			error: { code: "CONFLICT", message: "Host with this label already exists" },
		});

		const answer = await store.updateHost("pi", { label: "NAS" });

		expect(answer).toEqual({
			ok: false,
			status: 409,
			code: "CONFLICT",
			message: "Host with this label already exists",
		});
		expect(store.hosts.find((h) => h.id === "pi")?.label).toBe("Pi");
	});

	it("hands back why a host reached through its daemon cannot become Windows (#674)", async () => {
		const store = load();
		answerOnce(409, {
			error: {
				code: "DAEMON_CONNECTED",
				message: "Use Stop keeping an agent here to stop the connected daemon.",
			},
		});

		const answer = await store.updateHost("pi", { os: "windows" });

		expect(answer).toMatchObject({
			ok: false,
			code: "DAEMON_CONNECTED",
			message: "Use Stop keeping an agent here to stop the connected daemon.",
		});
	});

	it("says the status when the hub gave no reason", async () => {
		const store = load();
		answerOnce(502, undefined);

		expect(await store.updateHost("pi", { label: "pi2" })).toEqual({
			ok: false,
			status: 502,
			code: null,
			message: "The hub answered 502.",
		});
	});

	it("adds no host the hub refused", async () => {
		const store = load();
		await store.fetchHosts();
		answerOnce(400, {
			error: { code: "VALIDATION_ERROR", message: "Label must be 1-64 characters" },
		});

		const answer = await store.createHost({ label: "" });

		expect(answer).toMatchObject({ ok: false, message: "Label must be 1-64 characters" });
		expect(store.hosts).toHaveLength(3);
	});

	it("hands back a refused group's reason", async () => {
		const store = load();
		answerOnce(409, {
			error: { code: "CONFLICT", message: "Host group with this name already exists" },
		});

		expect(await store.createHostGroup("Prod")).toMatchObject({
			ok: false,
			code: "CONFLICT",
			message: "Host group with this name already exists",
		});
		expect(store.hostGroups).toEqual([]);
	});

	it("hands back the host it stored, and keeps it in the list", async () => {
		const store = load();
		await store.fetchHosts();
		answerOnce(200, hostRow("pi", "pi2"));

		const answer = await store.updateHost("pi", { label: "pi2" });

		expect(answer).toMatchObject({ ok: true, host: { id: "pi", label: "pi2", sortOrder: 0 } });
		expect(store.hosts.find((h) => h.id === "pi")?.label).toBe("pi2");
	});

	it("throws when the hub does not answer, for the dialog to say so", async () => {
		const store = load();
		fetchStub.mockImplementationOnce(async () => {
			throw new TypeError("Failed to fetch");
		});

		await expect(store.updateHost("pi", { label: "pi2" })).rejects.toThrow("Failed to fetch");
	});
});

describe("the name of a host's group (#731)", () => {
	const STAMP = "2026-01-01T00:00:00Z";
	const prod = { id: "g1", name: "Prod", sortOrder: 0, createdAt: STAMP, updatedAt: STAMP };

	it("is the name of the group its groupId points at, and follows a rename", async () => {
		const store = load();
		store.hostGroups = [{ ...prod }];
		const pi = { id: "pi", label: "Pi", type: "ssh", hostGroupId: "g1" } as never;
		expect(store.getHostGroupName(pi)).toBe("Prod");

		await store.renameHostGroup("g1", "Live");
		expect(store.getHostGroupName(pi)).toBe("Live");
	});

	it("is null for a host in no group, or in one the list no longer has", () => {
		const store = load();
		store.hostGroups = [{ ...prod }];
		expect(store.getHostGroupName({ id: "a", hostGroupId: null } as never)).toBeNull();
		expect(store.getHostGroupName({ id: "b" } as never)).toBeNull();
		expect(store.getHostGroupName({ id: "c", hostGroupId: "gone" } as never)).toBeNull();
	});
});
