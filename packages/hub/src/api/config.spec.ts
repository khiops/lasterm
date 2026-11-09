import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSFER_PROFILE_KEYS, UI_SECTION_KEYS } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	profileFieldsError,
	profileShapeError,
	profileValueError,
	registerConfigRoutes,
	TERMINAL_VALUE_VALIDATORS,
	UI_VALUE_VALIDATORS,
} from "../api/config.js";
import { ConfigResolver } from "../config.js";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";

vi.mock("ssh2", () => ({
	// Extended as the key-auth agent signer loads (#876).
	BaseAgent: class {},
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

/** The hub server's config.toml, "" before anything wrote one. */
function readConfigToml(): string {
	const path = join(configDir, "config.toml");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
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
		["layout", "hostRailColumns", "accepts", 1],
		["layout", "hostRailColumns", "accepts", 5],
		["layout", "hostRailColumns", "refuses", 0],
		["layout", "hostRailColumns", "refuses", 6],
		["layout", "hostRailColumns", "refuses", 2.5],
		["layout", "hostRailColumns", "refuses", "3"],
		["layout", "hostRailBadgeSize", "accepts", "small"],
		["layout", "hostRailBadgeSize", "accepts", "large"],
		["layout", "hostRailBadgeSize", "refuses", "huge"],
		["layout", "hostRailBadgeSize", "refuses", 36],
		["layout", "sidebarWidth", "accepts", 200],
		["layout", "sidebarWidth", "refuses", -1],
		["keyboard", "keyHints", "accepts", false],
		["keyboard", "keyHints", "refuses", "off"],
		["keyboard", "keyHints", "refuses", 0],
		// File transfer (#835): the rules are shared, and each is tested beside
		// its table in @lasterm/shared; one case each shows this table uses them.
		["layout", "transferPanelWidth", "accepts", 240],
		["layout", "transferPanelWidth", "refuses", 521],
		["transfer", "panelSide", "accepts", "left"],
		["transfer", "panelSide", "refuses", "top"],
		["transfer", "openOnDrag", "accepts", false],
		["transfer", "openOnDrag", "refuses", "no"],
		["transfer", "maxConcurrent", "accepts", 3],
		["transfer", "maxConcurrent", "refuses", 4],
		["transfer", "showHidden", "accepts", true],
		["transfer", "showHidden", "refuses", 1],
		["experimental", "fileTransfer", "accepts", true],
		["experimental", "fileTransfer", "accepts", false],
		["experimental", "fileTransfer", "refuses", "on"],
		["experimental", "fileTransfer", "refuses", 1],
	];

	it.each(cases)("%s.%s %s %j", (section, key, verdict, value) => {
		const validator = UI_VALUE_VALIDATORS[section]?.[key];
		expect(validator, `no validator for ${section}.${key}`).toBeTypeOf("function");
		expect(validator?.(value)).toBe(verdict === "accepts");
	});

	it("has a rule for every key of the sections file transfer adds", () => {
		expect(Object.keys(UI_VALUE_VALIDATORS.transfer ?? {}).sort()).toEqual([
			"maxConcurrent",
			"openOnDrag",
			"panelSide",
			"showHidden",
		]);
		expect(Object.keys(UI_VALUE_VALIDATORS.experimental ?? {})).toEqual(["fileTransfer"]);
		for (const section of ["transfer", "experimental"]) {
			expect(Object.keys(UI_VALUE_VALIDATORS[section] ?? {}).sort(), section).toEqual(
				[...(UI_SECTION_KEYS[section] ?? [])].sort(),
			);
		}
	});
});

// ─── TERMINAL_VALUE_VALIDATORS — the rules every profile write applies ───────
//
// PUT /api/config/global and the host's and the channel's profile PATCH all
// consult this table; each route keeps one test, below, proving it does.

describe("TERMINAL_VALUE_VALIDATORS", () => {
	type Case = [key: string, verdict: "accepts" | "refuses", value: unknown];
	const cases: Case[] = [
		["transferDrop", "accepts", "upload"],
		["transferDrop", "accepts", "off"],
		["transferDrop", "refuses", "download"],
		["transferConfirmDrop", "accepts", false],
		["transferConfirmDrop", "refuses", "false"],
		["transferOnConflict", "accepts", "keep_both"],
		["transferOnConflict", "refuses", "keepBoth"],
		["transferFollowCwd", "accepts", true],
		["transferFollowCwd", "refuses", 0],
		["transferFallbackDir", "accepts", ""],
		["transferFallbackDir", "accepts", "~/inbox"],
		["transferFallbackDir", "refuses", "x".repeat(1025)],
		["transferVerify", "accepts", true],
		["transferVerify", "refuses", "true"],
	];

	it.each(cases)("%s %s %j", (key, verdict, value) => {
		const validator = TERMINAL_VALUE_VALIDATORS[key];
		expect(validator, `no validator for ${key}`).toBeTypeOf("function");
		expect(validator?.(value)).toBe(verdict === "accepts");
	});

	it("has a rule for every file-transfer key", () => {
		for (const key of TRANSFER_PROFILE_KEYS) {
			expect(TERMINAL_VALUE_VALIDATORS[key], key).toBeTypeOf("function");
		}
	});
});

describe("profileValueError", () => {
	it("refuses a key of the host's at a terminal's scope, and only there", () => {
		for (const key of ["transferFallbackDir", "transferVerify"]) {
			const value = key === "transferVerify" ? false : "/srv";
			expect(profileValueError({ [key]: value }, "channel")?.code, key).toBe("VALIDATION_ERROR");
			expect(profileValueError({ [key]: value }, "host"), key).toBeNull();
			expect(profileValueError({ [key]: value }, "global"), key).toBeNull();
		}
	});

	it("never asks about null, which removes an override", () => {
		expect(profileValueError({ transferDrop: null, transferVerify: null }, "channel")).toBeNull();
	});

	it("names the key and the value refused", () => {
		expect(profileValueError({ fontSize: 12, transferDrop: "both" }, "host")).toEqual({
			code: "INVALID_VALUE",
			message: 'Invalid value for "transferDrop": "both"',
		});
	});
});

/** A value of `levels` objects nested inside one another. */
function nestedValue(levels: number): unknown {
	let value: unknown = "x";
	for (let i = 0; i < levels; i++) value = { a: value };
	return value;
}

describe("profileShapeError", () => {
	it("refuses a number that is not finite, at any depth", () => {
		for (const n of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
			expect(profileShapeError({ fontSize: n })).toEqual({
				code: "INVALID_VALUE",
				message: 'Invalid value for "fontSize": numbers must be finite',
			});
			expect(profileShapeError({ env: { a: [{ b: n }] } })?.message).toBe(
				'Invalid value for "env": numbers must be finite',
			);
		}
	});

	it("takes 32 levels, refuses 33, and refuses thousands without throwing", () => {
		expect(profileShapeError({ themeOverrides: nestedValue(32) })).toBeNull();
		const refusal = {
			code: "INVALID_VALUE",
			message: 'Invalid value for "themeOverrides": nested more than 32 levels deep',
		};
		expect(profileShapeError({ themeOverrides: nestedValue(33) })).toEqual(refusal);
		expect(profileShapeError({ themeOverrides: nestedValue(100_000) })).toEqual(refusal);
	});

	it("takes what a profile holds", () => {
		expect(
			profileShapeError({
				fontSize: 13,
				env: { PATH: null, HOME: "/h" },
				visualProfile: { banner: { enabled: true, text: "x" }, tint: { opacity: 5 } },
			}),
		).toBeNull();
	});
});

describe("profileFieldsError", () => {
	it("checks the names, then the shape of what is stored, then the values", () => {
		const deep = nestedValue(40);
		expect(
			profileFieldsError({ transferDrop: deep, foo: 1 }, { transferDrop: deep, foo: 1 }, "host")
				?.message,
		).toBe("Unknown profile key: foo");
		expect(
			profileFieldsError(
				{ transferDrop: "download", fontSize: Number.POSITIVE_INFINITY },
				{ transferDrop: "download", fontSize: Number.POSITIVE_INFINITY },
				"host",
			)?.message,
		).toBe('Invalid value for "fontSize": numbers must be finite');
		expect(
			profileFieldsError({ transferDrop: "download" }, { transferDrop: "download" }, "host"),
		).toEqual({ code: "INVALID_VALUE", message: 'Invalid value for "transferDrop": "download"' });
	});

	it("checks the shape of members kept from the stored profile, and the names of those written only", () => {
		expect(
			profileFieldsError(
				{ fontSize: 13 },
				{ fontSize: 13, themeOverrides: nestedValue(40) },
				"host",
			)?.message,
		).toBe('Invalid value for "themeOverrides": nested more than 32 levels deep');
		expect(profileFieldsError({ fontSize: 13 }, { fontSize: 13, foo: 1 }, "host")).toBeNull();
	});

	it("takes the extra keys a writer allows by name, and leaves their values to it", () => {
		const profile = { visualProfile: { tint: { color: "red" } } };
		expect(profileFieldsError(profile, profile, "host")?.message).toBe(
			"Unknown profile key: visualProfile",
		);
		expect(profileFieldsError(profile, profile, "host", ["visualProfile"])).toBeNull();
	});
});

// ─── The profile writes consult TERMINAL_VALUE_VALIDATORS ────────────────────

describe("terminal profile writes: value validation", () => {
	useHubServer();

	const refusal = {
		error: { code: "INVALID_VALUE", message: 'Invalid value for "transferDrop": "download"' },
	};

	async function makeChannel(): Promise<{ hostId: string; channelId: string }> {
		const hostId = (
			await server.inject({
				method: "POST",
				url: "/api/hosts",
				payload: { type: "local", label: "t" },
			})
		).json<{ id: string }>().id;
		const meta = new MetaDAL(dbs.meta);
		meta.createSession({ id: "ses-validate", hostId, status: "starting" });
		meta.createChannel({ id: "ch-validate", sessionId: "ses-validate", status: "born" });
		return { hostId, channelId: "ch-validate" };
	}

	it("PUT /api/config/global refuses a value the table refuses, and stores one it accepts", async () => {
		const refused = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { transferDrop: "download" } },
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual(refusal);
		expect(readConfigToml()).not.toContain("transfer_drop");

		const accepted = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { transferDrop: "off" } },
		});
		expect(accepted.statusCode).toBe(200);
		expect(readConfigToml()).toMatch(/transfer_drop = "off"/);
	});

	it("PATCH /api/hosts/:id/profile refuses a value the table refuses, and stores one it accepts", async () => {
		const { hostId } = await makeChannel();
		const url = `/api/hosts/${hostId}/profile`;
		const refused = await server.inject({
			method: "PATCH",
			url,
			payload: { profile: { transferDrop: "download" } },
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual(refusal);

		const accepted = await server.inject({
			method: "PATCH",
			url,
			payload: { profile: { transferDrop: "off", transferVerify: false } },
		});
		expect(accepted.statusCode).toBe(200);
		expect((await server.inject({ method: "GET", url })).json()).toEqual({
			profile: { transferDrop: "off", transferVerify: false },
		});
	});

	it("PATCH /api/channels/:id/profile refuses a value the table refuses, and a key of the host's", async () => {
		const { channelId } = await makeChannel();
		const url = `/api/channels/${channelId}/profile`;
		const refused = await server.inject({
			method: "PATCH",
			url,
			payload: { profile: { transferDrop: "download" } },
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual(refusal);

		const hostOnly = await server.inject({
			method: "PATCH",
			url,
			payload: { profile: { transferFallbackDir: "/tmp" } },
		});
		expect(hostOnly.statusCode).toBe(400);
		expect(hostOnly.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

		const accepted = await server.inject({
			method: "PATCH",
			url,
			payload: { profile: { transferDrop: "off" } },
		});
		expect(accepted.statusCode).toBe(200);
		expect((await server.inject({ method: "GET", url })).json()).toEqual({
			profile: { transferDrop: "off" },
		});
	});

	it("POST and PUT /api/hosts check a profile_json with the same table, names first (#848)", async () => {
		const { hostId } = await makeChannel();
		const writes = [
			(profile: string) =>
				server.inject({
					method: "POST",
					url: "/api/hosts",
					payload: { type: "local", label: "tabled", profile_json: profile },
				}),
			(profile: string) =>
				server.inject({
					method: "PUT",
					url: `/api/hosts/${hostId}`,
					payload: { profile_json: profile },
				}),
		];
		for (const write of writes) {
			const refused = await write('{"transferDrop":"download"}');
			expect(refused.statusCode).toBe(400);
			expect(refused.json()).toEqual(refusal);

			for (const profile of ['{"foo":null}', '{"transferDrop":"download","foo":1}']) {
				const unknown = await write(profile);
				expect(unknown.statusCode, profile).toBe(400);
				expect(unknown.json(), profile).toEqual({
					error: { code: "VALIDATION_ERROR", message: "Unknown profile key: foo" },
				});
			}

			const accepted = await write('{"transferDrop":"off"}');
			expect(accepted.statusCode, accepted.body).toBeLessThan(300);
		}
		expect(new MetaDAL(dbs.meta).getHostProfile(hostId)).toBe('{"transferDrop":"off"}');
	});
});

// ─── The profile PATCH routes check what they will store (#848) ──────────────

describe("profile PATCH: the merged profile is checked before it is stored", () => {
	useHubServer();

	/** `levels` objects nested inside one another, as JSON text. */
	function nested(levels: number): string {
		return `${'{"a":'.repeat(levels)}"x"${"}".repeat(levels)}`;
	}

	async function profileUrls(): Promise<{ host: string; channel: string; hostId: string }> {
		const hostId = (
			await server.inject({
				method: "POST",
				url: "/api/hosts",
				payload: { type: "local", label: "merged" },
			})
		).json<{ id: string }>().id;
		const meta = new MetaDAL(dbs.meta);
		meta.createSession({ id: "ses-merged", hostId, status: "starting" });
		meta.createChannel({ id: "ch-merged", sessionId: "ses-merged", status: "born" });
		return {
			host: `/api/hosts/${hostId}/profile`,
			channel: "/api/channels/ch-merged/profile",
			hostId,
		};
	}

	function patch(url: string, raw: string) {
		return server.inject({
			method: "PATCH",
			url,
			payload: raw,
			headers: { "content-type": "application/json" },
		});
	}

	it("refuses a number that is not finite and a value nested too deep, on both scopes", async () => {
		const urls = await profileUrls();
		const cases: Array<[raw: string, message: string]> = [
			['{"profile":{"fontSize":1e400}}', 'Invalid value for "fontSize": numbers must be finite'],
			[
				`{"profile":{"themeOverrides":${nested(40)}}}`,
				'Invalid value for "themeOverrides": nested more than 32 levels deep',
			],
			[
				`{"profile":{"transferDrop":${nested(10_000)}}}`,
				'Invalid value for "transferDrop": nested more than 32 levels deep',
			],
		];
		for (const url of [urls.host, urls.channel]) {
			for (const [raw, message] of cases) {
				const res = await patch(url, raw);
				expect(res.statusCode, `${url} ${message}`).toBe(400);
				expect(res.json(), `${url} ${message}`).toEqual({
					error: { code: "INVALID_VALUE", message },
				});
			}
			expect((await server.inject({ method: "GET", url })).json()).toEqual({ profile: {} });
		}
	});

	it("reads a stored profile that is not an object as none, never as numbered keys", async () => {
		const urls = await profileUrls();
		const meta = new MetaDAL(dbs.meta);
		meta.updateHostProfile(urls.hostId, '"xy"');
		meta.updateChannelProfile("ch-merged", "[1]");

		for (const url of [urls.host, urls.channel]) {
			const res = await patch(url, '{"profile":{"fontSize":13}}');
			expect(res.statusCode, url).toBe(200);
			expect((await server.inject({ method: "GET", url })).json(), url).toEqual({
				profile: { fontSize: 13 },
			});
		}
	});

	it("refuses a stored profile key it cannot store, until a null removes it", async () => {
		const urls = await profileUrls();
		const meta = new MetaDAL(dbs.meta);
		const deep = `{"themeOverrides":${nested(40)}}`;
		meta.updateHostProfile(urls.hostId, deep);
		meta.updateChannelProfile("ch-merged", deep);

		for (const url of [urls.host, urls.channel]) {
			const refused = await patch(url, '{"profile":{"fontSize":13}}');
			expect(refused.statusCode, url).toBe(400);
			expect(refused.json(), url).toEqual({
				error: {
					code: "INVALID_VALUE",
					message: 'Invalid value for "themeOverrides": nested more than 32 levels deep',
				},
			});

			const removed = await patch(url, '{"profile":{"themeOverrides":null,"fontSize":13}}');
			expect(removed.statusCode, url).toBe(200);
			expect((await server.inject({ method: "GET", url })).json()).toEqual({
				profile: { fontSize: 13 },
			});
		}
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

	// The markers are a terminal setting (#614): Settings writes them through
	// PUT /api/config/global, and one sent here would again reach no terminal.
	it("refuses search.scrollbarMarkers, no longer a UI setting", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { search: { scrollbarMarkers: false } },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: 'Unknown key "scrollbarMarkers" in UI section "search"',
			},
		});
	});

	// The rail keeps its columns now (#623); a width in pixels is only read,
	// from a config.toml written before.
	it("refuses layout.hostRailWidth, now the rail's columns", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { layout: { hostRailWidth: 90 } },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: 'Unknown key "hostRailWidth" in UI section "layout"',
			},
		});
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

// ─── /api/config/logging — consults LOGGING_SETTINGS_VALIDATORS (#646) ────────
//
// The rule itself is tested beside it, in the shared agent-config.spec.ts.

describe("/api/config/logging", () => {
	useHubServer();

	it("reads the daemon log files kept, seven until someone says otherwise", async () => {
		const res = await server.inject({ method: "GET", url: "/api/config/logging" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ agentFilesKept: 7 });
	});

	it("refuses a value the validator rejects, and stores one it accepts", async () => {
		const refused = await server.inject({
			method: "PUT",
			url: "/api/config/logging",
			payload: { agentFilesKept: -1 },
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual({
			error: { code: "INVALID_VALUE", message: 'Invalid value for "logging.agentFilesKept": -1' },
		});

		const accepted = await server.inject({
			method: "PUT",
			url: "/api/config/logging",
			payload: { agentFilesKept: 0 },
		});
		expect(accepted.statusCode).toBe(200);
		expect(accepted.json()).toEqual({ agentFilesKept: 0 });
		const read = await server.inject({ method: "GET", url: "/api/config/logging" });
		expect(read.json()).toEqual({ agentFilesKept: 0 });
		expect(readFileSync(join(configDir, "config.toml"), "utf8")).toMatch(
			/\[logging\][^[]*agent_files_kept = 0/,
		);
	});

	it("refuses a key it does not edit", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/logging",
			payload: { level: "trace" },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message: "Unknown logging key: level" },
		});
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
