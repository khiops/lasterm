import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigResolver } from "../config.js";
import { createServer } from "../server.fixture.js";
import type { HostConnectionOutcome, SessionManager } from "../session/session-manager.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";
import { registerConfigRoutes } from "./config.js";
import { registerHostConnectionRoutes } from "./host-connection.js";
import { registerHostGroupRoutes } from "./host-groups.js";
import { registerHostRoutes } from "./hosts.js";
import {
	createHostsChangeAnnouncer,
	HOSTS_CHANGED_MAX_WAIT_MS,
	HOSTS_CHANGED_QUIET_MS,
	type HostsChangeScope,
} from "./hosts-changed.js";

vi.mock("../ssh/ssh-config-parser.js", () => ({
	readSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
	parseSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
}));

// Whether an agent runs here is a fact about the machine the tests run on.
vi.mock("../session/ssh-agent-address.js", () => ({
	sshAgentAddress: vi.fn(() => null),
	windowsAgentPipeExists: vi.fn(() => false),
}));

vi.mock("ssh2", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
		on: vi.fn().mockReturnThis(),
	})),
}));

vi.mock("../session/ssh-agent.js", () => {
	const { EventEmitter } = require("node:events");
	class MockSshAgent extends EventEmitter {
		connected = true;
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn();
		close = vi.fn(() => {
			this.connected = false;
			this.emit("close");
		});
	}
	return { SshAgent: MockSshAgent };
});

// ─── One message for a burst ─────────────────────────────────────────────────

describe("createHostsChangeAnnouncer", () => {
	let sent: ProtocolMessage[];
	let announcer: ReturnType<typeof createHostsChangeAnnouncer>;

	beforeEach(() => {
		vi.useFakeTimers();
		sent = [];
		announcer = createHostsChangeAnnouncer((message) => sent.push(message));
	});

	afterEach(() => {
		announcer.cancel();
		vi.useRealTimers();
	});

	it("says a write once the writes have gone quiet", () => {
		announcer.announce("hosts");
		vi.advanceTimersByTime(HOSTS_CHANGED_QUIET_MS - 1);
		expect(sent).toEqual([]);

		vi.advanceTimersByTime(1);
		expect(sent).toEqual([{ type: "HOSTS_CHANGED", scope: "hosts" }]);
	});

	it("says twenty hosts written one request at a time in one message", () => {
		for (let i = 0; i < 20; i++) {
			announcer.announce("hosts");
			vi.advanceTimersByTime(10);
		}
		vi.advanceTimersByTime(HOSTS_CHANGED_QUIET_MS);

		expect(sent).toEqual([{ type: "HOSTS_CHANGED", scope: "hosts" }]);
	});

	it("names both lists when a burst changed both", () => {
		announcer.announce("groups");
		announcer.announce("hosts");
		vi.advanceTimersByTime(HOSTS_CHANGED_QUIET_MS);

		expect(sent).toEqual([{ type: "HOSTS_CHANGED", scope: "both" }]);
	});

	it("names only the groups when only they changed", () => {
		announcer.announce("groups");
		vi.advanceTimersByTime(HOSTS_CHANGED_QUIET_MS);

		expect(sent).toEqual([{ type: "HOSTS_CHANGED", scope: "groups" }]);
	});

	it("still says a steady stream of writes, no later than its longest wait", () => {
		for (let elapsed = 0; elapsed < HOSTS_CHANGED_MAX_WAIT_MS; elapsed += 50) {
			announcer.announce("hosts");
			vi.advanceTimersByTime(50);
		}

		expect(sent).toEqual([{ type: "HOSTS_CHANGED", scope: "hosts" }]);
	});

	it("says a write after the burst in a message of its own", () => {
		announcer.announce("hosts");
		vi.advanceTimersByTime(HOSTS_CHANGED_QUIET_MS);
		announcer.announce("groups");
		vi.advanceTimersByTime(HOSTS_CHANGED_QUIET_MS);

		expect(sent).toEqual([
			{ type: "HOSTS_CHANGED", scope: "hosts" },
			{ type: "HOSTS_CHANGED", scope: "groups" },
		]);
	});

	it("says nothing once cancelled, as the hub closes", () => {
		announcer.announce("hosts");
		announcer.cancel();
		vi.advanceTimersByTime(HOSTS_CHANGED_MAX_WAIT_MS);

		expect(sent).toEqual([]);
	});
});

// ─── Each write of the host and group routes says so (#783) ─────────────────
//
// A host or a group created, edited or deleted from one client appeared in the
// others only after a reload: no route said anything.

describe("host and group routes — every write announced, nothing else", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let metaDal: MetaDAL;
	let tempDir: string;
	let announced: HostsChangeScope[];
	let piId: string;
	let localId: string;
	let groupA: string;
	let groupB: string;
	const connections = {
		stopKeepingAgent: vi.fn<SessionManager["stopKeepingAgent"]>(),
		connectHost: vi.fn<(hostId: string, options?: object) => HostConnectionOutcome>(),
		reconnectHost: vi.fn<(hostId: string, options?: object) => HostConnectionOutcome>(),
		disconnectHost: vi.fn<(hostId: string, options?: object) => HostConnectionOutcome>(),
	};

	beforeEach(async () => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
		tempDir = makeTempDir("lasterm-hostschg-");
		announced = [];
		const announce = (scope: HostsChangeScope): void => {
			announced.push(scope);
		};
		localId = metaDal.createHost({ type: "local", label: "local" }).id;
		piId = metaDal.createHost({ type: "ssh", label: "pi", sshHost: "pi.local" }).id;
		groupA = metaDal.createHostGroup("lab", null).id;
		groupB = metaDal.createHostGroup("prod", null).id;
		for (const fn of Object.values(connections)) fn.mockReset();

		server = Fastify({ logger: false });
		registerHostRoutes(
			server,
			metaDal,
			{ hostIsBeingStopped: () => false, daemonPolicyWouldBeRevoked: () => false },
			announce,
		);
		registerHostGroupRoutes(server, metaDal, announce);
		registerHostConnectionRoutes(server, metaDal, connections, announce);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(tempDir);
		registerConfigRoutes(server, metaDal, resolver, undefined, announce);
		await server.ready();
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
		await removeTempDir(tempDir);
	});

	interface Write {
		readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
		readonly url: () => string;
		readonly payload?: () => unknown;
		readonly scope: HostsChangeScope;
	}

	const writes: Record<string, Write> = {
		"a host created": {
			method: "POST",
			url: () => "/api/hosts",
			payload: () => ({ type: "ssh", label: "nas", ssh_host: "nas.local" }),
			scope: "hosts",
		},
		"a host edited": {
			method: "PUT",
			url: () => `/api/hosts/${piId}`,
			payload: () => ({ label: "pi-2" }),
			scope: "hosts",
		},
		"a host moved into a group": {
			method: "PUT",
			url: () => `/api/hosts/${piId}`,
			payload: () => ({ host_group_id: groupA }),
			scope: "hosts",
		},
		"the hosts reordered": {
			method: "PUT",
			url: () => "/api/hosts/order",
			payload: () => ({ group_id: null, host_ids: [piId, localId] }),
			scope: "hosts",
		},
		"a host duplicated": {
			method: "POST",
			url: () => `/api/hosts/${piId}/duplicate`,
			scope: "hosts",
		},
		"a host deleted": {
			method: "DELETE",
			url: () => `/api/hosts/${piId}`,
			scope: "hosts",
		},
		"a host's profile written": {
			method: "PATCH",
			url: () => `/api/hosts/${piId}/profile`,
			payload: () => ({ profile: { fontSize: 13 } }),
			scope: "hosts",
		},
		"a group created": {
			method: "POST",
			url: () => "/api/host-groups",
			payload: () => ({ name: "edge" }),
			scope: "groups",
		},
		"a group renamed": {
			method: "PUT",
			url: () => `/api/host-groups/${groupA}`,
			payload: () => ({ name: "bench" }),
			scope: "groups",
		},
		"the groups reordered": {
			method: "PUT",
			url: () => "/api/host-groups/order",
			payload: () => ({ group_ids: [groupB, groupA] }),
			scope: "groups",
		},
		"a group deleted, its hosts left in none": {
			method: "DELETE",
			url: () => `/api/host-groups/${groupA}`,
			scope: "both",
		},
	};

	it.each(Object.entries(writes))("announces %s", async (_name, write) => {
		const res = await server.inject({
			method: write.method,
			url: write.url(),
			...(write.payload !== undefined && { payload: write.payload() as object }),
		});

		expect(res.statusCode).toBeLessThan(300);
		expect(announced).toEqual([write.scope]);
	});

	it("announces an SSH config import once, however many hosts it adds", async () => {
		const { readSshConfig } = await import("../ssh/ssh-config-parser.js");
		const names = ["web-1", "web-2", "web-3", "db-1", "bastion"];
		vi.mocked(readSshConfig).mockReturnValueOnce({
			entries: names.map((name) => ({
				name,
				hostname: `${name}.example.test`,
				port: 22,
				user: null,
				identityFile: null,
				proxyJump: name === "bastion" ? null : "bastion",
				isGitHost: false,
			})),
			hasInclude: false,
		});

		const res = await server.inject({
			method: "POST",
			url: "/api/hosts/import",
			payload: { entries: names.map((name) => ({ name, label: name })) },
		});

		expect(res.statusCode).toBe(201);
		expect(res.json()).toHaveLength(names.length);
		expect(announced).toEqual(["hosts"]);
	});

	it("announces the setting Stop keeping an agent stores on the host", async () => {
		const host = metaDal.getHost(piId);
		if (!host) throw new Error("no pi");
		connections.stopKeepingAgent.mockResolvedValue({
			kind: "done",
			response: { outcome: "stopped", ended: 0, host },
		});

		const res = await server.inject({
			method: "POST",
			url: `/api/hosts/${piId}/agent/stop-keeping`,
			payload: {},
		});

		expect(res.statusCode).toBe(200);
		expect(announced).toEqual(["hosts"]);
	});

	it.each([
		["the hosts", "/api/hosts"],
		["a page of hosts", "/api/hosts?limit=1&offset=0"],
		["a host", () => `/api/hosts/${piId}`],
		["the groups", "/api/host-groups"],
		["the SSH config", "/api/ssh-config"],
		["a host's profile", () => `/api/hosts/${piId}/profile`],
		["a host's launch profiles", () => `/api/hosts/${piId}/profiles`],
	] as const)("announces nothing for a read of %s", async (_name, url) => {
		await server.inject({ method: "GET", url: typeof url === "string" ? url : url() });

		expect(announced).toEqual([]);
	});

	it("announces nothing for a write it refused", async () => {
		const refused = [
			await server.inject({
				method: "POST",
				url: "/api/hosts",
				payload: { type: "ssh", label: "pi", ssh_host: "other.local" },
			}),
			await server.inject({
				method: "PUT",
				url: "/api/hosts/01ARZ3NDEKTSV4RRFFQ69G5FAV",
				payload: { label: "ghost" },
			}),
			await server.inject({ method: "DELETE", url: "/api/hosts/01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
			await server.inject({
				method: "PUT",
				url: "/api/hosts/order",
				payload: { group_id: null, host_ids: [] },
			}),
			await server.inject({ method: "POST", url: "/api/host-groups", payload: { name: "lab" } }),
			await server.inject({
				method: "DELETE",
				url: "/api/host-groups/01ARZ3NDEKTSV4RRFFQ69G5FAV",
			}),
			await server.inject({
				method: "PUT",
				url: "/api/host-groups/order",
				payload: { group_ids: [groupA] },
			}),
		];

		expect(refused.map((res) => res.statusCode >= 400)).toEqual(refused.map(() => true));
		expect(announced).toEqual([]);
	});

	it("announces nothing for a Stop keeping an agent that changed nothing", async () => {
		connections.stopKeepingAgent.mockResolvedValue({
			kind: "error",
			status: 409,
			code: "HOST_NOT_CONNECTED",
			message: "This host has no connected agent.",
		});

		const res = await server.inject({
			method: "POST",
			url: `/api/hosts/${piId}/agent/stop-keeping`,
			payload: {},
		});

		expect(res.statusCode).toBe(409);
		expect(announced).toEqual([]);
	});

	it("announces nothing for a connection, which writes no host", async () => {
		connections.connectHost.mockReturnValue({ kind: "connected" });

		const res = await server.inject({
			method: "POST",
			url: `/api/hosts/${piId}/connect`,
			payload: {},
		});

		expect(res.statusCode).toBe(200);

		expect(announced).toEqual([]);
	});
});

// ─── Every connected client hears it, once for a burst ───────────────────────

describe("HOSTS_CHANGED reaches every connected client", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;

	type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		await server.ready();
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	/** A window's socket, and what the hub sends it, once the hub acts on its frames. */
	async function connect(): Promise<{ ws: InjectedSocket; received: ProtocolMessage[] }> {
		const ws = await server.injectWS("/ws");
		const received: ProtocolMessage[] = [];
		ws.on("message", (data: Buffer) => received.push(decodeMessage(new Uint8Array(data))));
		ws.send(encodeMessage({ type: "PING" }));
		await vi.waitFor(() => expect(received.map((m) => m.type)).toContain("PONG"));
		return { ws, received };
	}

	const hostsChanged = (received: ProtocolMessage[]) =>
		received.filter((message) => message.type === "HOSTS_CHANGED");

	it("sends a burst of hosts added through the API as one message, to each window", async () => {
		const windows = [await connect(), await connect()];

		for (const label of ["web-1", "web-2", "web-3"]) {
			const res = await server.inject({
				method: "POST",
				url: "/api/hosts",
				payload: { type: "ssh", label, ssh_host: `${label}.local` },
			});
			expect(res.statusCode).toBe(201);
		}
		const group = await server.inject({
			method: "POST",
			url: "/api/host-groups",
			payload: { name: "web" },
		});
		expect(group.statusCode).toBe(201);

		for (const { received } of windows) {
			await vi.waitFor(() => expect(hostsChanged(received)).toHaveLength(1));
		}
		// Nothing more comes once the burst is said, nor for a read.
		await server.inject({ method: "GET", url: "/api/hosts" });
		await new Promise((resolve) => setTimeout(resolve, HOSTS_CHANGED_QUIET_MS * 3));
		for (const { ws, received } of windows) {
			expect(hostsChanged(received)).toEqual([{ type: "HOSTS_CHANGED", scope: "both" }]);
			ws.terminate();
		}
	});
});
