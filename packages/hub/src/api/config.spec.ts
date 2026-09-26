import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigRoutes, UI_VALUE_VALIDATORS } from "../api/config.js";
import { ConfigResolver } from "../config.js";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";

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

let dbs: DatabaseManager;
let server: FastifyInstance;
let configDir: string;

/** A whole hub server, for the describes that test a route through one. */
function useHubServer(): void {
	beforeEach(async () => {
		configDir = makeTempDir("lasterm-config-spec-");
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir,
		});
	});

	afterEach(async () => {
		// Survives a setup that never finished: see config.spec.ts.
		await server?.close();
		dbs?.close();
		if (configDir !== undefined) await removeTempDir(configDir);
	});
}

// ─── UI_VALUE_VALIDATORS — the rules PUT /api/config/ui applies ───────────────
//
// A table of pure functions: each rule is asserted here, where it lives, so a
// broken one fails under its own name. The route keeps one test, below, proving
// it consults the table.

describe("UI_VALUE_VALIDATORS", () => {
	type Case = [section: string, key: string, verdict: "accepts" | "refuses", value: unknown];
	const cases: Case[] = [
		["tabs", "closeButton", "accepts", true],
		["tabs", "closeButton", "refuses", "yes"],
		["tabs", "newTabPosition", "accepts", "afterActive"],
		["tabs", "newTabPosition", "refuses", "first"],
		["panes", "maxPanes", "accepts", 4],
		["panes", "maxPanes", "refuses", 0],
		["panes", "maxPanes", "refuses", 2.5],
		["panes", "keepEnded", "accepts", true],
		["panes", "keepEnded", "refuses", "yes"],
		["channels", "autoGroup", "accepts", "first"],
		["channels", "autoGroup", "refuses", "last"],
		["search", "historySize", "accepts", 50],
		["search", "historySize", "refuses", 101],
		["search", "position", "accepts", "bottom-bar"],
		["search", "position", "refuses", "top-left"],
		["layout", "hostRailWidth", "accepts", 48],
		["layout", "sidebarWidth", "accepts", 200],
		["layout", "sidebarWidth", "refuses", -1],
	];

	it.each(cases)("%s.%s %s %j", (section, key, verdict, value) => {
		const validator = UI_VALUE_VALIDATORS[section]?.[key];
		expect(validator, `no validator for ${section}.${key}`).toBeTypeOf("function");
		expect(validator?.(value)).toBe(verdict === "accepts");
	});
});

// ─── PUT /api/config/ui — consults UI_VALUE_VALIDATORS ────────────────────────

describe("PUT /api/config/ui value validation", () => {
	useHubServer();

	it("refuses a value UI_VALUE_VALIDATORS rejects, and stores one it accepts", async () => {
		const refused = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { closeButton: "yes" } },
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual({
			error: { code: "INVALID_VALUE", message: 'Invalid value for "tabs.closeButton": "yes"' },
		});

		const accepted = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { closeButton: false } },
		});
		expect(accepted.statusCode).toBe(200);
		const read = await server.inject({ method: "GET", url: "/api/config/ui" });
		expect(read.json<{ tabs: { closeButton: boolean } }>().tabs.closeButton).toBe(false);
	});

	it("still rejects unknown keys (existing behaviour)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { unknownKey: true } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("still rejects unknown sections (existing behaviour)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { bogusSection: { foo: 1 } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── broadcastDisplayTitles: called on PUT /api/config/ui with title section ──

describe("PUT /api/config/ui — broadcastDisplayTitles integration", () => {
	let miniServer: FastifyInstance;
	let testDbs: ReturnType<typeof openTestDatabases>;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = makeTempDir("lasterm-bdt-");
		testDbs = openTestDatabases();
		miniServer = Fastify({ logger: false });
	});

	afterEach(async () => {
		await miniServer.close();
		testDbs.close();
		await removeTempDir(tempDir);
	});

	it("calls sessionManager.broadcastDisplayTitles() when title section is in body", async () => {
		const called: boolean[] = [];
		const mockSessionManager = {
			broadcastDisplayTitles: () => {
				called.push(true);
			},
			broadcastToAllClients: () => {},
		};

		const metaDal = new MetaDAL(testDbs.meta);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(tempDir);
		registerConfigRoutes(miniServer, metaDal, resolver, mockSessionManager);

		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { title: { source: "static", staticTitle: "My Tab" } },
		});

		expect(res.statusCode).toBe(200);
		expect(called.length).toBeGreaterThan(0);
	});

	it("does NOT call broadcastDisplayTitles() when title section is absent", async () => {
		const called: boolean[] = [];
		const mockSessionManager = {
			broadcastDisplayTitles: () => {
				called.push(true);
			},
			broadcastToAllClients: () => {},
		};

		const metaDal = new MetaDAL(testDbs.meta);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(tempDir);
		registerConfigRoutes(miniServer, metaDal, resolver, mockSessionManager);

		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { closeButton: false } },
		});

		expect(res.statusCode).toBe(200);
		expect(called.length).toBe(0);
	});

	it("does NOT call broadcastDisplayTitles() when no sessionManager provided", async () => {
		// Regression guard: omitting sessionManager (old call-site) must not throw
		const metaDal = new MetaDAL(testDbs.meta);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(tempDir);
		registerConfigRoutes(miniServer, metaDal, resolver); // no sessionManager

		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { title: { source: "dynamic" } },
		});

		expect(res.statusCode).toBe(200);
	});
});

// ─── CONFIG_CHANGED: every client hears of a write (#479) ────────────────────
//
// A setting changed in one window stayed unseen in every other until a reload:
// only the title section was ever re-broadcast.

describe("config writes — CONFIG_CHANGED to every client", () => {
	let miniServer: FastifyInstance;
	let testDbs: ReturnType<typeof openTestDatabases>;
	let tempDir: string;
	let announced: unknown[];
	let metaDal: MetaDAL;

	beforeEach(async () => {
		tempDir = makeTempDir("lasterm-cfgchg-");
		testDbs = openTestDatabases();
		miniServer = Fastify({ logger: false });
		announced = [];
		metaDal = new MetaDAL(testDbs.meta);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(tempDir);
		registerConfigRoutes(miniServer, metaDal, resolver, {
			broadcastDisplayTitles: () => {},
			broadcastToAllClients: (msg) => {
				announced.push(msg);
			},
		});
	});

	afterEach(async () => {
		await miniServer.close();
		testDbs.close();
		await removeTempDir(tempDir);
	});

	it("announces a UI section written", async () => {
		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { hostMarker: "initials" } },
		});
		expect(res.statusCode).toBe(200);
		expect(announced).toEqual([{ type: "CONFIG_CHANGED", scope: "ui" }]);
	});

	it("announces nothing for a write it refused", async () => {
		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { hostMarker: "sparkles" } },
		});
		expect(res.statusCode).toBe(400);
		expect(announced).toEqual([]);
	});

	it("announces the appearance, the theme in use among it", async () => {
		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/appearance",
			payload: { theme: "nord" },
		});
		expect(res.statusCode).toBe(200);
		expect(announced).toEqual([{ type: "CONFIG_CHANGED", scope: "appearance" }]);
	});

	it("announces the global terminal profile", async () => {
		const res = await miniServer.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { fontSize: 15 } },
		});
		expect(res.statusCode).toBe(200);
		expect(announced).toEqual([{ type: "CONFIG_CHANGED", scope: "global" }]);
	});

	it("announces a host's profile, naming the host", async () => {
		const host = metaDal.createHost({ type: "ssh", label: "pi", sshHost: "pi@rpi" });
		const res = await miniServer.inject({
			method: "PATCH",
			url: `/api/hosts/${host.id}/profile`,
			payload: { profile: { fontSize: 13 } },
		});
		expect(res.statusCode).toBe(200);
		expect(announced).toEqual([{ type: "CONFIG_CHANGED", scope: "host", hostId: host.id }]);
	});
});

// ─── GET /api/config/elevation ────────────────────────────────────────────────

describe("GET /api/config/elevation", () => {
	useHubServer();

	it("returns elevation config with expected shape", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/config/elevation",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ methodLinux: string; methodDarwin: string; methodWindows: string }>();
		// Verify shape — specific values depend on the real config.toml on disk
		const linuxDarwinValid = ["sudo", "doas", "pkexec", "custom"];
		const windowsValid = ["gsudo", "custom"];
		expect(linuxDarwinValid).toContain(body.methodLinux);
		expect(linuxDarwinValid).toContain(body.methodDarwin);
		expect(windowsValid).toContain(body.methodWindows);
	});
});

// ─── PUT /api/config/elevation ────────────────────────────────────────────────

describe("PUT /api/config/elevation", () => {
	useHubServer();

	it("accepts valid methodLinux value", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { methodLinux: "doas" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ ok: boolean }>();
		expect(body.ok).toBe(true);
	});

	it("rejects unknown elevation key", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { unknownKey: "value" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects invalid methodLinux value", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { methodLinux: "runas" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("INVALID_VALUE");
	});

	it("rejects invalid methodWindows value (sudo is linux-only)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { methodWindows: "sudo" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("INVALID_VALUE");
	});

	it("accepts valid methodWindows value", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { methodWindows: "custom" },
		});
		expect(res.statusCode).toBe(200);
	});

	it("accepts non-empty customCommandLinux", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { customCommandLinux: "/usr/local/bin/myelev" },
		});
		expect(res.statusCode).toBe(200);
	});

	it("accepts non-empty customCommandDarwin", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { customCommandDarwin: "/usr/local/bin/myelev-mac" },
		});
		expect(res.statusCode).toBe(200);
	});

	it("accepts non-empty customCommandWindows", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { customCommandWindows: "C:\\tools\\myelev.exe" },
		});
		expect(res.statusCode).toBe(200);
	});

	it("rejects empty customCommandLinux", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { customCommandLinux: "" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("INVALID_VALUE");
	});

	it("rejects unknown key customCommand (old name)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: { customCommand: "/usr/bin/sudo" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects non-object body", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/elevation",
			payload: "not-an-object",
			headers: { "content-type": "text/plain" },
		});
		expect(res.statusCode).toBe(400);
	});
});
