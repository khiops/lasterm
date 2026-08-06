import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonMap } from "@iarna/toml";
import type { CascadeResponse, ElevationMethod } from "@lasterm/shared";
import {
	DEFAULT_AGENT_CONFIG,
	DEFAULT_APPEARANCE,
	DEFAULT_ELEVATION_CONFIG,
	DEFAULT_PROFILE,
	deepMerge,
	generateId,
} from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ConfigResolver,
	DEFAULT_CHANNELS_CONFIG,
	DEFAULT_GC_CONFIG,
	DEFAULT_LOG_CONFIG,
	DEFAULT_PANES_CONFIG,
	DEFAULT_SEARCH_CONFIG,
	DEFAULT_STARTUP_CONFIG,
	DEFAULT_TABS_CONFIG,
	DEFAULT_TITLE_CONFIG,
	DEFAULT_UI_CONFIG,
	extractAgentConfig,
	extractAppearanceConfig,
	extractElevationConfig,
	extractLogConfig,
	extractUiConfig,
	loadGcConfig,
	loadUiConfig,
} from "./config.js";
import { createServer } from "./server.js";
import type { DatabaseManager } from "./storage/db.js";
import { openTestDatabases } from "./storage/db.js";
import { MetaDAL } from "./storage/meta.js";

// ─── Mock agents so no real PTY / SSH is spawned ─────────────────────────────

vi.mock("./session/ssh-agent.js", () => {
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

// ─── deepMerge unit tests ─────────────────────────────────────────────────────

describe("deepMerge", () => {
	it("scalar override: later value wins", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, { a: 2 });
		expect(result).toEqual({ a: 2 });
	});

	it("nested object merge: keys merged recursively", () => {
		const result = deepMerge<Record<string, unknown>>(
			{ a: { x: 1, y: 2 } },
			{ a: { y: 99, z: 3 } },
		);
		expect(result).toEqual({ a: { x: 1, y: 99, z: 3 } });
	});

	it("null removes a key from base", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1, b: 2 }, { a: null });
		expect(result).not.toHaveProperty("a");
		expect(result.b).toBe(2);
	});

	it("arrays replace entirely (no element merge)", () => {
		const result = deepMerge<Record<string, unknown>>({ arr: [1, 2, 3] }, { arr: [4, 5] });
		expect(result.arr).toEqual([4, 5]);
	});

	it("empty override: base is returned unchanged", () => {
		const base: Record<string, unknown> = { fontFamily: "monospace", fontSize: 14 };
		const result = deepMerge<Record<string, unknown>>(base, {});
		expect(result).toEqual(base);
	});

	it("undefined sources are skipped", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, undefined, { b: 2 });
		expect(result).toEqual({ a: 1, b: 2 });
	});

	it("null sources are skipped", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, null, { b: 2 });
		expect(result).toEqual({ a: 1, b: 2 });
	});

	it("multiple layers: last wins for scalars", () => {
		const result = deepMerge<Record<string, unknown>>(
			{ fontSize: 12, fontFamily: "monospace" },
			{ fontSize: 13 },
			{ fontSize: 14 },
		);
		expect(result.fontSize).toBe(14);
		expect(result.fontFamily).toBe("monospace");
	});
});

// ─── ConfigResolver unit tests ────────────────────────────────────────────────

describe("ConfigResolver.resolve", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("no overrides → returns DEFAULT_PROFILE", () => {
		const resolver = new ConfigResolver(metaDal);
		const result = resolver.resolve();
		expect(result).toEqual(DEFAULT_PROFILE);
	});

	it("layer 2: config.toml overrides defaults", () => {
		const dir = join(tmpdir(), `lasterm-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			`[terminal]\nfont_size = 16\nfont_family = "JetBrains Mono"\n`,
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const result = resolver.resolve();

		expect(result.fontSize).toBe(16);
		expect(result.fontFamily).toBe("JetBrains Mono");
		// Unchanged defaults remain
		expect(result.scrollback).toBe(DEFAULT_PROFILE.scrollback);
		expect(result.cursorStyle).toBe(DEFAULT_PROFILE.cursorStyle);
	});

	it("layer 2: theme_overrides converted to themeOverrides", () => {
		const dir = join(tmpdir(), `lasterm-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			`[terminal]\n[terminal.theme_overrides]\nbackground = "#1a1b26"\n`,
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const result = resolver.resolve();

		expect(result.themeOverrides).toEqual({ background: "#1a1b26" });
	});

	it("layer 2: missing config.toml silently skipped", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile("/nonexistent/path");
		expect(resolver.resolve()).toEqual(DEFAULT_PROFILE);
	});

	it("layer 3: host profile_json overrides layer 2", () => {
		const dir = join(tmpdir(), `lasterm-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[terminal]\nfont_size = 16\n");

		const host = metaDal.createHost({ type: "local", label: "test-host" });
		metaDal.updateHostProfile(host.id, JSON.stringify({ fontSize: 20, scrollback: 9999 }));

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const result = resolver.resolve(host.id);

		expect(result.fontSize).toBe(20); // host overrides toml layer 2
		expect(result.scrollback).toBe(9999);
		expect(result.fontFamily).toBe('"Consolas", "Liberation Mono", "Courier New", monospace'); // layer 1 default still present
	});

	it("layer 3.5: agent hints override host profile", () => {
		const host = metaDal.createHost({ type: "local", label: "test-host-hints" });
		metaDal.updateHostProfile(host.id, JSON.stringify({ fontSize: 20 }));

		const resolver = new ConfigResolver(metaDal);
		resolver.setAgentHints("session-1", { fontSize: 18, theme: "dark" });
		const result = resolver.resolve(host.id, undefined, "session-1");

		expect(result.fontSize).toBe(18); // agent hints override host profile
		expect(result.theme).toBe("dark");
	});

	it("layer 4: channel profile_json overrides all lower layers", () => {
		const host = metaDal.createHost({ type: "local", label: "test-host-ch" });
		metaDal.updateHostProfile(host.id, JSON.stringify({ fontSize: 20 }));

		metaDal.createSession({ id: "ses-01", hostId: host.id, status: "starting" });
		metaDal.createChannel({ id: "ch-01", sessionId: "ses-01", status: "born" });
		metaDal.updateChannelProfile("ch-01", JSON.stringify({ fontSize: 24, bellSound: true }));

		const resolver = new ConfigResolver(metaDal);
		const result = resolver.resolve(host.id, "ch-01");

		expect(result.fontSize).toBe(24); // channel wins
		expect(result.bellSound).toBe(true);
	});

	it("full cascade order: layer 4 is final winner", () => {
		const dir = join(tmpdir(), `lasterm-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[terminal]\nfont_size = 13\n");

		const host = metaDal.createHost({ type: "local", label: "test-cascade" });
		metaDal.updateHostProfile(host.id, JSON.stringify({ fontSize: 15 }));

		metaDal.createSession({ id: "ses-cascade", hostId: host.id, status: "starting" });
		metaDal.createChannel({ id: "ch-cascade", sessionId: "ses-cascade", status: "born" });
		metaDal.updateChannelProfile("ch-cascade", JSON.stringify({ fontSize: 17 }));

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		resolver.setAgentHints("ses-cascade", { fontSize: 16 });
		const result = resolver.resolve(host.id, "ch-cascade", "ses-cascade");

		// Layer 4 (channel=17) beats layer 3.5 (agent=16) beats layer 3 (host=15)
		// beats layer 2 (toml=13) beats layer 1 (default=14)
		expect(result.fontSize).toBe(17);
	});

	it("clearAgentHints removes hints for session", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.setAgentHints("ses-x", { fontSize: 99 });
		resolver.clearAgentHints("ses-x");
		const result = resolver.resolve(undefined, undefined, "ses-x");
		expect(result.fontSize).toBe(DEFAULT_PROFILE.fontSize);
	});

	it("wallpaper fields cascade through resolve()", () => {
		// Layer 3: host sets wallpaper + blur
		const host = metaDal.createHost({ type: "local", label: "cascade-wp-test" });
		metaDal.updateHostProfile(host.id, JSON.stringify({ wallpaper: "host.jpg", wallpaperBlur: 5 }));

		// Layer 4: channel adds dim
		metaDal.createSession({ id: "ses-wp", hostId: host.id, status: "starting" });
		metaDal.createChannel({ id: "ch-wp", sessionId: "ses-wp", status: "born" });
		metaDal.updateChannelProfile("ch-wp", JSON.stringify({ wallpaperDim: 40 }));

		const resolver = new ConfigResolver(metaDal);
		const resolved = resolver.resolve(host.id, "ch-wp");

		// Wallpaper fields merged across layers
		expect(resolved.wallpaper).toBe("host.jpg");
		expect(resolved.wallpaperBlur).toBe(5);
		expect(resolved.wallpaperDim).toBe(40);

		// Unrelated defaults still cascade correctly
		expect(resolved.fontSize).toBe(DEFAULT_PROFILE.fontSize);
		expect(resolved.cursorStyle).toBe(DEFAULT_PROFILE.cursorStyle);
	});

	it("background mode and window effect cascade through resolve()", () => {
		const dir = join(tmpdir(), `lasterm-bg-mode-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[terminal]\nbackground_mode = "solid"\nwindow_effect = "blur"\n',
		);

		const host = metaDal.createHost({ type: "local", label: "cascade-bg-test" });
		metaDal.updateHostProfile(
			host.id,
			JSON.stringify({ backgroundMode: "transparent", windowEffect: "auto" }),
		);

		metaDal.createSession({ id: "ses-bg", hostId: host.id, status: "starting" });
		metaDal.createChannel({ id: "ch-bg", sessionId: "ses-bg", status: "born" });
		metaDal.updateChannelProfile(
			"ch-bg",
			JSON.stringify({ backgroundMode: "image", windowEffect: "none" }),
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const resolved = resolver.resolve(host.id, "ch-bg");

		expect(resolved.backgroundMode).toBe("image");
		expect(resolved.windowEffect).toBe("none");
		expect(resolved.fontSize).toBe(DEFAULT_PROFILE.fontSize);
	});

	it("malformed host/channel profileJson does not block lower-layer background fields", () => {
		const dir = join(tmpdir(), `lasterm-bg-malformed-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[terminal]\nbackground_mode = "transparent"\nwindow_effect = "auto"\n',
		);

		const host = metaDal.createHost({ type: "local", label: "malformed-bg-test" });
		metaDal.updateHostProfile(host.id, "{not-json");

		metaDal.createSession({ id: "ses-bg-bad", hostId: host.id, status: "starting" });
		metaDal.createChannel({ id: "ch-bg-bad", sessionId: "ses-bg-bad", status: "born" });
		metaDal.updateChannelProfile("ch-bg-bad", "{also-not-json");

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const resolved = resolver.resolve(host.id, "ch-bg-bad");

		expect(resolved.backgroundMode).toBe("transparent");
		expect(resolved.windowEffect).toBe("auto");
	});
});

// ─── loadGcConfig + ConfigResolver.gcConfig ──────────────────────────────────

describe("loadGcConfig", () => {
	it("returns defaults when config.toml does not exist", () => {
		const config = loadGcConfig("/nonexistent/path");
		expect(config).toEqual(DEFAULT_GC_CONFIG);
	});

	it("returns defaults when config.toml has no [gc] section", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[terminal]\nfont_size = 16\n");

		const config = loadGcConfig(dir);
		expect(config).toEqual(DEFAULT_GC_CONFIG);
	});

	it("parses dead_retention_hours from [gc] section", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[gc]\ndead_retention_hours = 48\n");

		const config = loadGcConfig(dir);
		expect(config.deadRetentionHours).toBe(48);
		expect(config.maxSizePerChannelMb).toBe(DEFAULT_GC_CONFIG.maxSizePerChannelMb);
	});

	it("parses max_size_per_channel_mb from [gc] section", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[gc]\nmax_size_per_channel_mb = 50\n");

		const config = loadGcConfig(dir);
		expect(config.maxSizePerChannelMb).toBe(50);
		expect(config.deadRetentionHours).toBe(DEFAULT_GC_CONFIG.deadRetentionHours);
	});

	it("parses both gc keys together", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			"[gc]\ndead_retention_hours = 0\nmax_size_per_channel_mb = 100\n",
		);

		const config = loadGcConfig(dir);
		expect(config.deadRetentionHours).toBe(0);
		expect(config.maxSizePerChannelMb).toBe(100);
	});

	it("ignores non-number values in [gc] section", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), '[gc]\ndead_retention_hours = "not-a-number"\n');

		const config = loadGcConfig(dir);
		expect(config.deadRetentionHours).toBe(DEFAULT_GC_CONFIG.deadRetentionHours);
	});

	it("returns defaults for malformed TOML", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[gc\nbroken");

		const config = loadGcConfig(dir);
		expect(config).toEqual(DEFAULT_GC_CONFIG);
	});
});

describe("ConfigResolver.gcConfig", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns defaults when no config.toml loaded", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.gcConfig).toEqual(DEFAULT_GC_CONFIG);
	});

	it("returns overridden values after loadFromFile with [gc] section", () => {
		const dir = join(tmpdir(), `lasterm-gc-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			"[gc]\ndead_retention_hours = 72\nmax_size_per_channel_mb = 25\n",
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.gcConfig.deadRetentionHours).toBe(72);
		expect(resolver.gcConfig.maxSizePerChannelMb).toBe(25);
	});
});

// ─── REST endpoint integration tests ─────────────────────────────────────────

describe("GET /api/config/defaults", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({ logger: false, dbManager: dbs, skipShellDiscovery: true });
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns DEFAULT_PROFILE", async () => {
		const res = await server.inject({ method: "GET", url: "/api/config/defaults" });
		expect(res.statusCode).toBe(200);
		const body = res.json<typeof DEFAULT_PROFILE>();
		expect(body.fontFamily).toBe(DEFAULT_PROFILE.fontFamily);
		expect(body.fontSize).toBe(DEFAULT_PROFILE.fontSize);
		expect(body.scrollback).toBe(DEFAULT_PROFILE.scrollback);
	});
});

describe("GET /api/config/cascade (resolved layer)", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		// Use tmpdir as configDir to avoid loading the real ~/.config/lasterm/config.toml
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir: tmpdir(),
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("no params → terminal.resolved matches defaults", async () => {
		const res = await server.inject({ method: "GET", url: "/api/config/cascade" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ terminal: { resolved: typeof DEFAULT_PROFILE } }>();
		expect(body.terminal.resolved).toMatchObject(DEFAULT_PROFILE);
	});

	it("with host_id → terminal.resolved merges host profile", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "test-resolved-host" },
		});
		expect(createRes.statusCode).toBe(201);
		const { id } = createRes.json<{ id: string }>();

		const patchRes = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${id}/profile`,
			payload: { profile: { fontSize: 22 } },
		});
		expect(patchRes.statusCode).toBe(200);

		const res = await server.inject({
			method: "GET",
			url: `/api/config/cascade?host_id=${id}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ terminal: { resolved: { fontSize: number } } }>();
		expect(body.terminal.resolved.fontSize).toBe(22);
	});
});

describe("PATCH /api/hosts/:id/profile", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({ logger: false, dbManager: dbs, skipShellDiscovery: true });
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns 404 for unknown host", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/hosts/nonexistent/profile",
			payload: { profile: { fontSize: 14 } },
		});
		expect(res.statusCode).toBe(404);
	});

	it("updates host profile and returns ok", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "host-profile-test" },
		});
		const { id } = createRes.json<{ id: string }>();

		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${id}/profile`,
			payload: { profile: { fontSize: 18, cursorStyle: "bar" } },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });

		const cascadeRes = await server.inject({
			method: "GET",
			url: `/api/config/cascade?host_id=${id}`,
		});
		const body = cascadeRes.json<{
			terminal: { resolved: { fontSize: number; cursorStyle: string } };
		}>();
		expect(body.terminal.resolved.fontSize).toBe(18);
		expect(body.terminal.resolved.cursorStyle).toBe("bar");
	});

	it("returns 400 when profile field is missing from body", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "host-profile-bad" },
		});
		const { id } = createRes.json<{ id: string }>();

		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${id}/profile`,
			payload: {},
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("PATCH /api/channels/:id/profile", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({ logger: false, dbManager: dbs, skipShellDiscovery: true });
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns 404 for unknown channel", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/channels/nonexistent/profile",
			payload: { profile: { fontSize: 14 } },
		});
		expect(res.statusCode).toBe(404);
	});
});

// ─── extractUiConfig unit tests ──────────────────────────────────────────────

describe("extractUiConfig", () => {
	it("returns defaults when no [ui] section", () => {
		const config = extractUiConfig({});
		expect(config).toEqual(DEFAULT_UI_CONFIG);
	});

	it('parses on_channel_dead = "close"', () => {
		const config = extractUiConfig({ ui: { on_channel_dead: "close" } });
		expect(config.onChannelDead).toBe("close");
	});

	it('parses on_channel_dead = "readonly"', () => {
		const config = extractUiConfig({ ui: { on_channel_dead: "readonly" } });
		expect(config.onChannelDead).toBe("readonly");
	});

	it("falls back to default for invalid on_channel_dead value", () => {
		const config = extractUiConfig({ ui: { on_channel_dead: "invalid" } });
		expect(config.onChannelDead).toBe(DEFAULT_UI_CONFIG.onChannelDead);
	});
});

// ─── loadUiConfig ────────────────────────────────────────────────────────────

describe("loadUiConfig", () => {
	it("returns defaults when config.toml does not exist", () => {
		const config = loadUiConfig("/nonexistent/path");
		expect(config).toEqual(DEFAULT_UI_CONFIG);
	});

	it("returns defaults when config.toml has no [ui] section", () => {
		const dir = join(tmpdir(), `lasterm-ui-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[terminal]\nfont_size = 16\n");

		const config = loadUiConfig(dir);
		expect(config).toEqual(DEFAULT_UI_CONFIG);
	});

	it('parses on_channel_dead = "readonly" from [ui] section', () => {
		const dir = join(tmpdir(), `lasterm-ui-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), '[ui]\non_channel_dead = "readonly"\n');

		const config = loadUiConfig(dir);
		expect(config.onChannelDead).toBe("readonly");
	});

	it("returns defaults for malformed TOML", () => {
		const dir = join(tmpdir(), `lasterm-ui-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[ui\nbroken");

		const config = loadUiConfig(dir);
		expect(config).toEqual(DEFAULT_UI_CONFIG);
	});
});

// ─── ConfigResolver.uiConfig ────────────────────────────────────────────────

describe("ConfigResolver.uiConfig", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns defaults when no config.toml loaded", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.uiConfig).toEqual(DEFAULT_UI_CONFIG);
	});

	it("returns overridden values after loadFromFile with [ui] section", () => {
		const dir = join(tmpdir(), `lasterm-ui-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), '[ui]\non_channel_dead = "readonly"\n');

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.uiConfig.onChannelDead).toBe("readonly");
	});
});

// ─── GET /api/config/ui integration test ─────────────────────────────────────

describe("GET /api/config/ui", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir: tmpdir(),
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns default UiConfig with tabs/panes/channels/startup", async () => {
		const res = await server.inject({ method: "GET", url: "/api/config/ui" });
		expect(res.statusCode).toBe(200);
		const body = res.json<typeof DEFAULT_UI_CONFIG>();
		expect(body.onChannelDead).toBe("readonly");
		expect(body.tabs).toEqual(DEFAULT_TABS_CONFIG);
		expect(body.panes).toEqual(DEFAULT_PANES_CONFIG);
		expect(body.channels).toEqual(DEFAULT_CHANNELS_CONFIG);
		expect(body.startup).toEqual(DEFAULT_STARTUP_CONFIG);
	});
});

// ─── extractUiConfig: tabs/panes/channels/startup ───────────────────────────

describe("extractUiConfig — tabs section", () => {
	it("returns default tabs config when no [tabs] section", () => {
		const config = extractUiConfig({});
		expect(config.tabs).toEqual(DEFAULT_TABS_CONFIG);
	});

	it("parses confirm_close_all = false", () => {
		const config = extractUiConfig({ tabs: { confirm_close_all: false } });
		expect(config.tabs.confirmCloseAll).toBe(false);
	});

	it("parses confirm_close_others = false", () => {
		const config = extractUiConfig({ tabs: { confirm_close_others: false } });
		expect(config.tabs.confirmCloseOthers).toBe(false);
	});

	it("parses close_button = false", () => {
		const config = extractUiConfig({ tabs: { close_button: false } });
		expect(config.tabs.closeButton).toBe(false);
	});

	it('parses new_tab_position = "afterActive"', () => {
		const config = extractUiConfig({ tabs: { new_tab_position: "afterActive" } });
		expect(config.tabs.newTabPosition).toBe("afterActive");
	});

	it("ignores invalid new_tab_position value", () => {
		const config = extractUiConfig({ tabs: { new_tab_position: "invalid" } });
		expect(config.tabs.newTabPosition).toBe(DEFAULT_TABS_CONFIG.newTabPosition);
	});
});

describe("extractUiConfig — panes section", () => {
	it("returns default panes config when no [panes] section", () => {
		const config = extractUiConfig({});
		expect(config.panes).toEqual(DEFAULT_PANES_CONFIG);
	});

	it("parses max_panes", () => {
		const config = extractUiConfig({ panes: { max_panes: 6 } });
		expect(config.panes.maxPanes).toBe(6);
	});

	it("ignores max_panes < 1", () => {
		const config = extractUiConfig({ panes: { max_panes: 0 } });
		expect(config.panes.maxPanes).toBe(DEFAULT_PANES_CONFIG.maxPanes);
	});

	it('parses default_split_direction = "vertical"', () => {
		const config = extractUiConfig({ panes: { default_split_direction: "vertical" } });
		expect(config.panes.defaultSplitDirection).toBe("vertical");
	});
});

describe("extractUiConfig — channels section", () => {
	it("returns default channels config when no [channels] section", () => {
		const config = extractUiConfig({});
		expect(config.channels).toEqual(DEFAULT_CHANNELS_CONFIG);
	});

	it("parses default_shell", () => {
		const config = extractUiConfig({ channels: { default_shell: "/bin/zsh" } });
		expect(config.channels.defaultShell).toBe("/bin/zsh");
	});

	it("parses auto_group = first", () => {
		const config = extractUiConfig({ channels: { auto_group: "first" } });
		expect(config.channels.autoGroup).toBe("first");
	});

	it("parses auto_group = none", () => {
		const config = extractUiConfig({ channels: { auto_group: "none" } });
		expect(config.channels.autoGroup).toBe("none");
	});

	it("ignores invalid auto_group value", () => {
		const config = extractUiConfig({ channels: { auto_group: "always" } });
		expect(config.channels.autoGroup).toBe("none");
	});
});

describe("extractUiConfig — startup section", () => {
	it("returns default startup config when no [startup] section", () => {
		const config = extractUiConfig({});
		expect(config.startup).toEqual(DEFAULT_STARTUP_CONFIG);
	});

	it("parses auto_open_welcome = false", () => {
		const config = extractUiConfig({ startup: { auto_open_welcome: false } });
		expect(config.startup.autoOpenWelcome).toBe(false);
	});
});

describe("ConfigResolver.uiConfig — tabs/panes", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns default tabs config when no config.toml loaded", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.uiConfig.tabs).toEqual(DEFAULT_TABS_CONFIG);
	});

	it("returns overridden tabs values after loadFromFile", () => {
		const dir = join(tmpdir(), `lasterm-tabs-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[tabs]\nconfirm_close_all = false\nnew_tab_position = "afterActive"\n',
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.uiConfig.tabs.confirmCloseAll).toBe(false);
		expect(resolver.uiConfig.tabs.newTabPosition).toBe("afterActive");
		// Unchanged defaults
		expect(resolver.uiConfig.tabs.confirmCloseOthers).toBe(true);
	});

	it("returns overridden panes values after loadFromFile", () => {
		const dir = join(tmpdir(), `lasterm-panes-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[panes]\nmax_panes = 8\ndefault_split_direction = "vertical"\n',
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.uiConfig.panes.maxPanes).toBe(8);
		expect(resolver.uiConfig.panes.defaultSplitDirection).toBe("vertical");
	});
});

// ─── extractUiConfig: title section ──────────────────────────────────────────

describe("extractUiConfig — title section", () => {
	it("returns default title config when no [title] section", () => {
		const config = extractUiConfig({});
		expect(config.title).toEqual(DEFAULT_TITLE_CONFIG);
	});

	it('parses source = "static"', () => {
		const config = extractUiConfig({ title: { source: "static" } });
		expect(config.title.source).toBe("static");
	});

	it('parses source = "dynamic"', () => {
		const config = extractUiConfig({ title: { source: "dynamic" } });
		expect(config.title.source).toBe("dynamic");
	});

	it("ignores invalid source value", () => {
		const config = extractUiConfig({ title: { source: "invalid" } });
		expect(config.title.source).toBe(DEFAULT_TITLE_CONFIG.source);
	});

	it("parses max_length", () => {
		const config = extractUiConfig({ title: { max_length: 30 } });
		expect(config.title.maxLength).toBe(30);
	});

	it("ignores max_length < 1", () => {
		const config = extractUiConfig({ title: { max_length: 0 } });
		expect(config.title.maxLength).toBe(DEFAULT_TITLE_CONFIG.maxLength);
	});

	it('parses truncation = "middle"', () => {
		const config = extractUiConfig({ title: { truncation: "middle" } });
		expect(config.title.truncation).toBe("middle");
	});

	it('parses truncation = "start"', () => {
		const config = extractUiConfig({ title: { truncation: "start" } });
		expect(config.title.truncation).toBe("start");
	});

	it("ignores invalid truncation value", () => {
		const config = extractUiConfig({ title: { truncation: "invalid" } });
		expect(config.title.truncation).toBe(DEFAULT_TITLE_CONFIG.truncation);
	});

	it("parses prefix string", () => {
		const config = extractUiConfig({ title: { prefix: "PROD " } });
		expect(config.title.prefix).toBe("PROD ");
	});

	it("parses window_title = false", () => {
		const config = extractUiConfig({ title: { window_title: false } });
		expect(config.title.windowTitle).toBe(false);
	});

	it("parses window_format string", () => {
		const config = extractUiConfig({ title: { window_format: "[{host}] {title}" } });
		expect(config.title.windowFormat).toBe("[{host}] {title}");
	});

	it("parses all title fields together", () => {
		const config = extractUiConfig({
			title: {
				source: "static",
				static_title: "My Term",
				max_length: 25,
				truncation: "middle",
				prefix: "DEV ",
				window_title: true,
				window_format: "{prefix}{host}: {title}",
			},
		});
		expect(config.title).toEqual({
			source: "static",
			staticTitle: "My Term",
			maxLength: 25,
			truncation: "middle",
			prefix: "DEV ",
			windowTitle: true,
			windowFormat: "{prefix}{host}: {title}",
		});
	});
});

describe("ConfigResolver.uiConfig — title", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns default title config when no config.toml loaded", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.uiConfig.title).toEqual(DEFAULT_TITLE_CONFIG);
	});

	it("returns overridden title values after loadFromFile", () => {
		const dir = join(tmpdir(), `lasterm-title-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[title]\nsource = "static"\nprefix = "PROD "\nwindow_title = false\n',
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.uiConfig.title.source).toBe("static");
		expect(resolver.uiConfig.title.prefix).toBe("PROD ");
		expect(resolver.uiConfig.title.windowTitle).toBe(false);
		// Unchanged defaults
		expect(resolver.uiConfig.title.maxLength).toBe(50);
		expect(resolver.uiConfig.title.truncation).toBe("end");
	});
});

// ─── extractUiConfig: search section ─────────────────────────────────────────

describe("extractUiConfig — search section", () => {
	it("returns default search config when no [search] section", () => {
		const config = extractUiConfig({});
		expect(config.search).toEqual(DEFAULT_SEARCH_CONFIG);
	});

	it('parses position = "bottom-right"', () => {
		const config = extractUiConfig({ search: { position: "bottom-right" } });
		expect(config.search.position).toBe("bottom-right");
	});

	it('parses position = "bottom-bar"', () => {
		const config = extractUiConfig({ search: { position: "bottom-bar" } });
		expect(config.search.position).toBe("bottom-bar");
	});

	it("ignores invalid position value", () => {
		const config = extractUiConfig({ search: { position: "invalid" } });
		expect(config.search.position).toBe(DEFAULT_SEARCH_CONFIG.position);
	});

	it('parses highlight_on_close = "fade"', () => {
		const config = extractUiConfig({ search: { highlight_on_close: "fade" } });
		expect(config.search.highlightOnClose).toBe("fade");
	});

	it('parses highlight_on_close = "persist"', () => {
		const config = extractUiConfig({ search: { highlight_on_close: "persist" } });
		expect(config.search.highlightOnClose).toBe("persist");
	});

	it("ignores invalid highlight_on_close value", () => {
		const config = extractUiConfig({ search: { highlight_on_close: "invalid" } });
		expect(config.search.highlightOnClose).toBe(DEFAULT_SEARCH_CONFIG.highlightOnClose);
	});

	it("parses scrollbar_markers = false", () => {
		const config = extractUiConfig({ search: { scrollbar_markers: false } });
		expect(config.search.scrollbarMarkers).toBe(false);
	});

	it("parses history_size", () => {
		const config = extractUiConfig({ search: { history_size: 50 } });
		expect(config.search.historySize).toBe(50);
	});

	it("ignores history_size < 1", () => {
		const config = extractUiConfig({ search: { history_size: 0 } });
		expect(config.search.historySize).toBe(DEFAULT_SEARCH_CONFIG.historySize);
	});

	it("parses all search fields together", () => {
		const config = extractUiConfig({
			search: {
				position: "bottom-bar",
				highlight_on_close: "persist",
				scrollbar_markers: false,
				history_size: 10,
			},
		});
		expect(config.search).toEqual({
			position: "bottom-bar",
			highlightOnClose: "persist",
			scrollbarMarkers: false,
			historySize: 10,
		});
	});
});

describe("ConfigResolver.uiConfig — search", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns default search config when no config.toml loaded", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.uiConfig.search).toEqual(DEFAULT_SEARCH_CONFIG);
	});

	it("returns overridden search values after loadFromFile", () => {
		const dir = join(tmpdir(), `lasterm-search-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[search]\nposition = "bottom-right"\nhighlight_on_close = "fade"\nscrollbar_markers = false\nhistory_size = 30\n',
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.uiConfig.search.position).toBe("bottom-right");
		expect(resolver.uiConfig.search.highlightOnClose).toBe("fade");
		expect(resolver.uiConfig.search.scrollbarMarkers).toBe(false);
		expect(resolver.uiConfig.search.historySize).toBe(30);
	});
});

// ─── extractAppearanceConfig unit tests ──────────────────────────────────────

describe("extractAppearanceConfig", () => {
	it("returns defaults when no [appearance] section", () => {
		const parsed = {} as import("@iarna/toml").JsonMap;
		const config = extractAppearanceConfig(parsed);
		expect(config).toEqual(DEFAULT_APPEARANCE);
	});

	it("parses theme from [appearance]", () => {
		const parsed = { appearance: { theme: "dracula" } } as unknown as import("@iarna/toml").JsonMap;
		const config = extractAppearanceConfig(parsed);
		expect(config.theme).toBe("dracula");
	});

	it("parses auto_switch subsection", () => {
		const parsed = {
			appearance: {
				auto_switch: { enabled: true, dark_theme: "dark-one", light_theme: "light-one" },
			},
		} as unknown as import("@iarna/toml").JsonMap;
		const config = extractAppearanceConfig(parsed);
		expect(config.autoSwitch.enabled).toBe(true);
		expect(config.autoSwitch.darkTheme).toBe("dark-one");
		expect(config.autoSwitch.lightTheme).toBe("light-one");
	});

	it("parses opacity subsection with snake_case keys", () => {
		const parsed = {
			appearance: {
				opacity: { terminal: 80, sidebar: 90, host_rail: 70, tab_bar: 60 },
			},
		} as unknown as import("@iarna/toml").JsonMap;
		const config = extractAppearanceConfig(parsed);
		expect(config.opacity.terminal).toBe(80);
		expect(config.opacity.sidebar).toBe(90);
		expect(config.opacity.hostRail).toBe(70);
		expect(config.opacity.tabBar).toBe(60);
	});

	it("parses scrollbar subsection with snake_case keys", () => {
		const parsed = {
			appearance: {
				scrollbar: {
					style: "wide",
					thumb_color: "#ff0000",
					track_color: "#00ff00",
					width_thin: 4,
					width_wide: 20,
				},
			},
		} as unknown as import("@iarna/toml").JsonMap;
		const config = extractAppearanceConfig(parsed);
		expect(config.scrollbar.style).toBe("wide");
		expect(config.scrollbar.thumbColor).toBe("#ff0000");
		expect(config.scrollbar.trackColor).toBe("#00ff00");
		expect(config.scrollbar.widthThin).toBe(4);
		expect(config.scrollbar.widthWide).toBe(20);
	});
});

// ─── ConfigResolver.appearance — loading from file ──────────────────────────

describe("ConfigResolver.appearance", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns DEFAULT_APPEARANCE when no config.toml", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(join(tmpdir(), "nonexistent-dir"));
		expect(resolver.appearance).toEqual(DEFAULT_APPEARANCE);
	});

	it("loads appearance from config.toml", () => {
		const dir = join(tmpdir(), `lasterm-appear-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[appearance]\ntheme = "solarized"\n\n[appearance.opacity]\nterminal = 85\n',
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.appearance.theme).toBe("solarized");
		expect(resolver.appearance.opacity.terminal).toBe(85);
		// Defaults preserved for non-overridden fields
		expect(resolver.appearance.opacity.sidebar).toBe(100);
	});
});

// ─── ConfigResolver.getCascade ──────────────────────────────────────────────

describe("ConfigResolver.getCascade", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns all 4 layers with defaults when no overrides", () => {
		const dir = join(tmpdir(), `lasterm-cascade-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const cascade = resolver.getCascade();

		expect(cascade.terminal.defaults).toEqual(DEFAULT_PROFILE);
		expect(cascade.terminal.global).toEqual({});
		expect(cascade.terminal.host).toBeUndefined();
		expect(cascade.terminal.channel).toBeUndefined();
		expect(cascade.terminal.resolved).toEqual(DEFAULT_PROFILE);
		expect(cascade.ui.defaults).toEqual(DEFAULT_UI_CONFIG);
		expect(cascade.ui.resolved).toEqual(DEFAULT_UI_CONFIG);
		expect(cascade.appearance).toEqual(DEFAULT_APPEARANCE);
	});

	it("includes host layer when hostId provided", () => {
		const dir = join(tmpdir(), `lasterm-cascade-host-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		// Create a host with a profile
		const host = metaDal.createHost({ type: "local", label: "cascade-host" });
		metaDal.updateHostProfile(host.id, JSON.stringify({ fontSize: 20 }));

		const cascade = resolver.getCascade(host.id);
		expect(cascade.terminal.host).toEqual({ fontSize: 20 });
		expect(cascade.terminal.resolved.fontSize).toBe(20);
	});

	it("includes channel layer when channelId provided", () => {
		const dir = join(tmpdir(), `lasterm-cascade-chan-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		const host = metaDal.createHost({ type: "local", label: "cascade-chan-host" });
		const sessionId = generateId();
		metaDal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		const channelId = generateId();
		metaDal.createChannel({
			id: channelId,
			sessionId,
			status: "live",
		});
		metaDal.updateChannelProfile(channelId, JSON.stringify({ scrollback: 9999 }));

		const cascade = resolver.getCascade(host.id, channelId);
		expect(cascade.terminal.channel).toEqual({ scrollback: 9999 });
		expect(cascade.terminal.resolved.scrollback).toBe(9999);
	});

	it("includes global terminal overrides from config.toml", () => {
		const dir = join(tmpdir(), `lasterm-cascade-global-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[terminal]\nfont_size = 18\n");
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		const cascade = resolver.getCascade();
		expect(cascade.terminal.global).toEqual({ fontSize: 18 });
		expect(cascade.terminal.resolved.fontSize).toBe(18);
	});

	it("includes background fields at every terminal cascade layer", () => {
		const dir = join(tmpdir(), `lasterm-cascade-bg-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[terminal]\nbackground_mode = "solid"\nwindow_effect = "blur"\n',
		);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		const host = metaDal.createHost({ type: "local", label: "cascade-bg-host" });
		metaDal.updateHostProfile(
			host.id,
			JSON.stringify({ backgroundMode: "transparent", windowEffect: "auto" }),
		);

		const sessionId = generateId();
		metaDal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		const channelId = generateId();
		metaDal.createChannel({ id: channelId, sessionId, status: "live" });
		metaDal.updateChannelProfile(
			channelId,
			JSON.stringify({ backgroundMode: "image", windowEffect: "none" }),
		);

		const cascade = resolver.getCascade(host.id, channelId);
		expect(cascade.terminal.defaults).toMatchObject({
			backgroundMode: "image",
			windowEffect: "none",
		});
		expect(cascade.terminal.global).toEqual({
			backgroundMode: "solid",
			windowEffect: "blur",
		});
		expect(cascade.terminal.host).toEqual({
			backgroundMode: "transparent",
			windowEffect: "auto",
		});
		expect(cascade.terminal.channel).toEqual({
			backgroundMode: "image",
			windowEffect: "none",
		});
		expect(cascade.terminal.resolved).toMatchObject({
			backgroundMode: "image",
			windowEffect: "none",
		});
	});
});

// ─── ConfigResolver.getGlobalTerminalOverrides ──────────────────────────────

describe("ConfigResolver.getGlobalTerminalOverrides", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns empty object when no config.toml loaded", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.getGlobalTerminalOverrides()).toEqual({});
	});

	it("returns fileConfig after loadFromFile", () => {
		const dir = join(tmpdir(), `lasterm-overrides-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), '[terminal]\nfont_family = "Fira Code"\n');
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.getGlobalTerminalOverrides()).toEqual({ fontFamily: "Fira Code" });
	});
});

// ─── ConfigResolver.getGlobalUiOverrides ────────────────────────────────────

describe("ConfigResolver.getGlobalUiOverrides", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns empty object when no overrides", () => {
		const resolver = new ConfigResolver(metaDal);
		expect(resolver.getGlobalUiOverrides()).toEqual({});
	});

	it("returns only non-default values", () => {
		const dir = join(tmpdir(), `lasterm-ui-overrides-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), "[tabs]\nclose_button = false\n");
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		const overrides = resolver.getGlobalUiOverrides();
		expect(overrides.tabs).toEqual({ closeButton: false });
		// Other sections should not appear
		expect(overrides.panes).toBeUndefined();
		expect(overrides.channels).toBeUndefined();
	});
});

// ─── ConfigResolver.saveGlobalKey — config.toml write-back ──────────────────

describe("ConfigResolver.saveGlobalKey", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("creates config.toml if missing", async () => {
		const dir = join(tmpdir(), `lasterm-save-create-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		await resolver.saveGlobalKey("terminal", "fontSize", 18);

		const content = readFileSync(join(dir, "config.toml"), "utf8");
		expect(content).toContain("font_size");
		expect(content).toContain("18");
		// Verify in-memory state reloaded
		expect(resolver.getGlobalTerminalOverrides()).toEqual({ fontSize: 18 });
	});

	it("preserves comments when writing", async () => {
		const dir = join(tmpdir(), `lasterm-save-comment-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const original = "# My config\n[terminal]\nfont_size = 14  # default size\n";
		writeFileSync(join(dir, "config.toml"), original);
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		await resolver.saveGlobalKey("terminal", "fontFamily", "Fira Code");

		const content = readFileSync(join(dir, "config.toml"), "utf8");
		expect(content).toContain("# My config");
		expect(content).toContain("font_size = 14");
		expect(content).toContain("Fira Code");
	});

	it("null value removes key", async () => {
		const dir = join(tmpdir(), `lasterm-save-null-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), '[terminal]\nfont_size = 16\ntheme = "dracula"\n');
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		await resolver.saveGlobalKey("terminal", "fontSize", null);

		const content = readFileSync(join(dir, "config.toml"), "utf8");
		expect(content).not.toContain("font_size");
		expect(content).toContain("dracula");
	});

	it("saveGlobalTerminal rejects unknown keys", async () => {
		const dir = join(tmpdir(), `lasterm-save-reject-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		await expect(resolver.saveGlobalTerminal("badKey", 42)).rejects.toThrow("Unknown terminal key");
	});

	it("saveGlobalUi rejects unknown sections", async () => {
		const dir = join(tmpdir(), `lasterm-save-ui-reject-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		await expect(resolver.saveGlobalUi("badSection", "key", 42)).rejects.toThrow(
			"Unknown UI section",
		);
	});

	it("round-trips terminal values through write and read", async () => {
		const dir = join(tmpdir(), `lasterm-save-roundtrip-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);

		await resolver.saveGlobalTerminal("fontSize", 22);
		await resolver.saveGlobalTerminal("cursorStyle", "bar");

		// Re-read with a fresh resolver
		const resolver2 = new ConfigResolver(metaDal);
		resolver2.loadFromFile(dir);
		expect(resolver2.getGlobalTerminalOverrides()).toMatchObject({
			fontSize: 22,
			cursorStyle: "bar",
		});
	});
});

// ─── REST endpoint: GET /api/config/cascade ─────────────────────────────────

describe("GET /api/config/cascade", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		const dir = join(tmpdir(), `lasterm-cascade-api-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir: dir,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns correct shape with all fields", async () => {
		const res = await server.inject({ method: "GET", url: "/api/config/cascade" });
		expect(res.statusCode).toBe(200);
		const body = res.json<CascadeResponse>();

		expect(body.terminal).toBeDefined();
		expect(body.terminal.defaults).toEqual(DEFAULT_PROFILE);
		expect(body.terminal.global).toEqual({});
		expect(body.terminal.resolved).toEqual(DEFAULT_PROFILE);
		expect(body.ui).toBeDefined();
		expect(body.ui.defaults).toBeDefined();
		expect(body.ui.resolved).toBeDefined();
		expect(body.appearance).toBeDefined();
	});

	it("includes host layer when host_id is provided", async () => {
		// Create a host
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "cascade-host" },
		});
		const { id } = createRes.json<{ id: string }>();

		// Set host profile
		await server.inject({
			method: "PATCH",
			url: `/api/hosts/${id}/profile`,
			payload: { profile: { fontSize: 24 } },
		});

		const res = await server.inject({
			method: "GET",
			url: `/api/config/cascade?host_id=${id}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<CascadeResponse>();
		expect(body.terminal.host).toEqual({ fontSize: 24 });
		expect(body.terminal.resolved.fontSize).toBe(24);
	});
});

// ─── REST endpoint: PUT /api/config/global ──────────────────────────────────

describe("PUT /api/config/global", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `lasterm-global-api-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbs = openTestDatabases();
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir: tempDir,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("writes terminal keys to config.toml", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { fontSize: 20 } },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });

		// Verify via cascade
		const cascade = await server.inject({ method: "GET", url: "/api/config/cascade" });
		const body = cascade.json<CascadeResponse>();
		expect(body.terminal.global).toMatchObject({ fontSize: 20 });
	});

	it("writes background mode and window effect terminal keys to config.toml", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { backgroundMode: "solid", windowEffect: "auto" } },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });

		const content = readFileSync(join(tempDir, "config.toml"), "utf8");
		expect(content).toContain("background_mode");
		expect(content).toContain("window_effect");

		const cascade = await server.inject({ method: "GET", url: "/api/config/cascade" });
		const body = cascade.json<CascadeResponse>();
		expect(body.terminal.global).toMatchObject({
			backgroundMode: "solid",
			windowEffect: "auto",
		});
	});

	it("rejects unknown keys (400)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { unknownKey: "bad" } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects missing terminal field (400)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: {},
		});
		expect(res.statusCode).toBe(400);
	});
});

// ─── REST endpoint: PUT /api/config/ui ──────────────────────────────────────

describe("PUT /api/config/ui", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `lasterm-ui-api-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbs = openTestDatabases();
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir: tempDir,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("writes UI section keys to config.toml", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { closeButton: false } },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });

		// Verify written
		const content = readFileSync(join(tempDir, "config.toml"), "utf8");
		expect(content).toContain("close_button");
	});

	it("rejects unknown UI section (400)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { badSection: { key: "val" } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects unknown key within a valid UI section (400)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { unknownKey: true } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string; message: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
		expect(body.error.message).toContain("unknownKey");
		expect(body.error.message).toContain("tabs");
	});

	it("accepts valid keys within a valid UI section (200)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { closeButton: false, newTabPosition: "afterActive" } },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
	});
});

// ─── REST endpoint: PUT /api/config/appearance ──────────────────────────────

describe("PUT /api/config/appearance", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `lasterm-appear-api-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		dbs = openTestDatabases();
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir: tempDir,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("writes appearance keys to config.toml", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/appearance",
			payload: { theme: "dracula" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });

		// Verify via cascade
		const cascade = await server.inject({ method: "GET", url: "/api/config/cascade" });
		const body = cascade.json<CascadeResponse>();
		expect(body.appearance.theme).toBe("dracula");
	});

	it("writes nested appearance keys (opacity)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/appearance",
			payload: { opacity: { terminal: 80 } },
		});
		expect(res.statusCode).toBe(200);

		const cascade = await server.inject({ method: "GET", url: "/api/config/cascade" });
		const body = cascade.json<CascadeResponse>();
		expect(body.appearance.opacity.terminal).toBe(80);
	});

	it("writes nested autoSwitch keys with correct snake_case section name", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/appearance",
			payload: { autoSwitch: { enabled: true, darkTheme: "dark-one", lightTheme: "light-one" } },
		});
		expect(res.statusCode).toBe(200);

		const cascade = await server.inject({ method: "GET", url: "/api/config/cascade" });
		const body = cascade.json<CascadeResponse>();
		expect(body.appearance.autoSwitch.enabled).toBe(true);
		expect(body.appearance.autoSwitch.darkTheme).toBe("dark-one");
		expect(body.appearance.autoSwitch.lightTheme).toBe("light-one");
	});

	it("rejects unknown appearance keys (400)", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/appearance",
			payload: { badKey: "val" },
		});
		expect(res.statusCode).toBe(400);
	});
});

// ─── REST endpoint: GET /api/hosts/:id/profile ──────────────────────────────

describe("GET /api/hosts/:id/profile", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({ logger: false, dbManager: dbs, skipShellDiscovery: true });
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns empty profile for host with no overrides", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "profile-get-host" },
		});
		const { id } = createRes.json<{ id: string }>();

		const res = await server.inject({ method: "GET", url: `/api/hosts/${id}/profile` });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ profile: {} });
	});

	it("returns profile after PATCH", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "profile-get-host-2" },
		});
		const { id } = createRes.json<{ id: string }>();

		await server.inject({
			method: "PATCH",
			url: `/api/hosts/${id}/profile`,
			payload: { profile: { fontSize: 30 } },
		});

		const res = await server.inject({ method: "GET", url: `/api/hosts/${id}/profile` });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ profile: { fontSize: 30 } });
	});

	it("returns 404 for unknown host", async () => {
		const res = await server.inject({ method: "GET", url: "/api/hosts/nonexistent/profile" });
		expect(res.statusCode).toBe(404);
	});
});

// ─── REST endpoint: GET /api/channels/:id/profile ───────────────────────────

describe("GET /api/channels/:id/profile", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		server = await createServer({ logger: false, dbManager: dbs, skipShellDiscovery: true });
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("returns 404 for unknown channel", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/channels/nonexistent/profile",
		});
		expect(res.statusCode).toBe(404);
	});
});

// ─── Auth enforcement on new endpoints ──────────────────────────────────────

describe("Auth enforcement on cascade/config endpoints", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		const dir = join(tmpdir(), `lasterm-auth-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		server = await createServer({
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: "abc123",
			configDir: dir,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("GET /api/config/cascade requires auth", async () => {
		const res = await server.inject({ method: "GET", url: "/api/config/cascade" });
		expect(res.statusCode).toBe(401);
	});

	it("PUT /api/config/global requires auth", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/global",
			payload: { terminal: { fontSize: 20 } },
		});
		expect(res.statusCode).toBe(401);
	});

	it("PUT /api/config/ui requires auth", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/ui",
			payload: { tabs: { closeButton: false } },
		});
		expect(res.statusCode).toBe(401);
	});

	it("PUT /api/config/appearance requires auth", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/config/appearance",
			payload: { theme: "dracula" },
		});
		expect(res.statusCode).toBe(401);
	});

	it("accepts request with valid Bearer token", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/config/cascade",
			headers: { authorization: "Bearer abc123" },
		});
		expect(res.statusCode).toBe(200);
	});
});

// ─── extractElevationConfig unit tests ───────────────────────────────────────

describe("extractElevationConfig", () => {
	it("returns empty object when no [elevation] section", () => {
		const parsed = {} as import("@iarna/toml").JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result).toEqual({});
	});

	it("returns empty object when [elevation] is not an object", () => {
		const parsed = { elevation: "invalid" } as unknown as import("@iarna/toml").JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result).toEqual({});
	});

	it("parses method_linux with valid value", () => {
		const parsed = { elevation: { method_linux: "doas" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodLinux).toBe("doas");
	});

	it("rejects method_linux with invalid value", () => {
		const parsed = { elevation: { method_linux: "badvalue" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodLinux).toBeUndefined();
	});

	it("parses method_darwin with valid value", () => {
		const parsed = { elevation: { method_darwin: "doas" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodDarwin).toBe("doas");
	});

	it("rejects method_darwin with linux-only value (pkexec)", () => {
		const parsed = { elevation: { method_darwin: "pkexec" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodDarwin).toBeUndefined();
	});

	it("parses method_windows with valid value", () => {
		const parsed = { elevation: { method_windows: "gsudo" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodWindows).toBe("gsudo");
	});

	it("rejects method_windows with linux-only value", () => {
		const parsed = { elevation: { method_windows: "sudo" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodWindows).toBeUndefined();
	});

	it("parses custom_command_linux", () => {
		const parsed = {
			elevation: { custom_command_linux: "/usr/local/bin/myelevate" },
		} as unknown as import("@iarna/toml").JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.customCommandLinux).toBe("/usr/local/bin/myelevate");
	});

	it("parses custom_command_darwin", () => {
		const parsed = {
			elevation: { custom_command_darwin: "/usr/local/bin/myelevate-mac" },
		} as unknown as import("@iarna/toml").JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.customCommandDarwin).toBe("/usr/local/bin/myelevate-mac");
	});

	it("parses custom_command_windows", () => {
		const parsed = {
			elevation: { custom_command_windows: "C:\\tools\\myelev.exe" },
		} as unknown as import("@iarna/toml").JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.customCommandWindows).toBe("C:\\tools\\myelev.exe");
	});

	it("rejects empty custom_command_linux", () => {
		const parsed = { elevation: { custom_command_linux: "" } } as unknown as JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.customCommandLinux).toBeUndefined();
	});

	it("parses all fields together", () => {
		const parsed = {
			elevation: {
				method_linux: "doas",
				method_darwin: "sudo",
				method_windows: "custom",
				custom_command_linux: "/usr/local/bin/my-elev-linux",
				custom_command_darwin: "/usr/local/bin/my-elev-mac",
				custom_command_windows: "C:\\tools\\my-elev-win.exe",
			},
		} as unknown as import("@iarna/toml").JsonMap;
		const result = extractElevationConfig(parsed);
		expect(result.methodLinux).toBe("doas");
		expect(result.methodDarwin).toBe("sudo");
		expect(result.methodWindows).toBe("custom");
		expect(result.customCommandLinux).toBe("/usr/local/bin/my-elev-linux");
		expect(result.customCommandDarwin).toBe("/usr/local/bin/my-elev-mac");
		expect(result.customCommandWindows).toBe("C:\\tools\\my-elev-win.exe");
	});
});

// ─── ConfigResolver.elevationConfig + resolve methods ────────────────────────

describe("ConfigResolver.elevationConfig", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns DEFAULT_ELEVATION_CONFIG when no config.toml", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(join(tmpdir(), "nonexistent-dir"));
		expect(resolver.elevationConfig).toEqual(DEFAULT_ELEVATION_CONFIG);
	});

	it("loads elevation config from config.toml", () => {
		const dir = join(tmpdir(), `lasterm-elev-test-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.toml"), '[elevation]\nmethod_linux = "doas"\n');

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.elevationConfig.methodLinux).toBe("doas");
		// Defaults preserved for non-overridden fields
		expect(resolver.elevationConfig.methodDarwin).toBe("sudo");
		expect(resolver.elevationConfig.methodWindows).toBe("gsudo");
	});

	it("loads custom_command_linux from config.toml", () => {
		const dir = join(tmpdir(), `lasterm-elev-custom-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'[elevation]\nmethod_linux = "custom"\ncustom_command_linux = "/usr/local/bin/myelevate"\n',
		);

		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(dir);
		expect(resolver.elevationConfig.methodLinux).toBe("custom");
		expect(resolver.elevationConfig.customCommandLinux).toBe("/usr/local/bin/myelevate");
	});
});

// ─── ConfigResolver.resolveElevationMethod ───────────────────────────────────

describe("ConfigResolver.resolveElevationMethod", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;
	let resolver: ConfigResolver;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
		resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(join(tmpdir(), "nonexistent-dir"));
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns host-level method when explicitly set", () => {
		const method = resolver.resolveElevationMethod("doas" as ElevationMethod);
		expect(method).toBe("doas");
	});

	it("returns null-bypassed host value (null → falls back to global)", () => {
		// null means "not set at host level" → use global default
		const method = resolver.resolveElevationMethod(null);
		// On Linux (CI), default is "sudo"
		expect(method).toBeDefined();
	});

	it("returns undefined-bypassed (undefined → falls back to global)", () => {
		const method = resolver.resolveElevationMethod(undefined);
		expect(method).toBeDefined();
	});

	it("global default is platform-dependent — falls through to non-null result", () => {
		const method = resolver.resolveElevationMethod();
		expect(["sudo", "doas", "pkexec", "gsudo", "custom"]).toContain(method);
	});
});

// ─── ConfigResolver.resolveCustomCommand ─────────────────────────────────────

describe("ConfigResolver.resolveCustomCommand", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns host-level custom command when set", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(join(tmpdir(), "nonexistent-dir"));
		const cmd = resolver.resolveCustomCommand("/host/custom/cmd");
		expect(cmd).toBe("/host/custom/cmd");
	});

	it.skipIf(process.platform === "win32")(
		"falls back to global custom_command_linux when host not set (Linux)",
		() => {
			const dir = join(tmpdir(), `lasterm-custom-cmd-${Date.now()}`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.toml"),
				'[elevation]\ncustom_command_linux = "/global/cmd"\n',
			);

			const resolver = new ConfigResolver(metaDal);
			resolver.loadFromFile(dir);
			const cmd = resolver.resolveCustomCommand(null);
			// On Linux CI, resolveCustomCommand falls back to customCommandLinux
			expect(cmd).toBe("/global/cmd");
		},
	);

	it("returns undefined when neither host nor global custom command set", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(join(tmpdir(), "nonexistent-dir"));
		const cmd = resolver.resolveCustomCommand(undefined);
		expect(cmd).toBeUndefined();
	});

	it("returns undefined when host custom_command is empty string", () => {
		const resolver = new ConfigResolver(metaDal);
		resolver.loadFromFile(join(tmpdir(), "nonexistent-dir"));
		const cmd = resolver.resolveCustomCommand("");
		// empty string → falls back to global (which is also undefined by default)
		expect(cmd).toBeUndefined();
	});
});

// ─── extractLogConfig ────────────────────────────────────────────────────────

describe("extractLogConfig", () => {
	it("returns defaults when [logging] section is absent", () => {
		const result = extractLogConfig({});
		expect(result).toEqual(DEFAULT_LOG_CONFIG);
		expect(result.level).toBe("info");
		expect(result.format).toBe("jsonl");
		expect(result.output).toBe("file");
		expect(result.maxAgeDays).toBe(30);
		expect(result.maxSizeMb).toBe(50);
	});

	it("parses all valid fields from [logging] section", () => {
		const result = extractLogConfig({
			logging: {
				level: "debug",
				format: "text",
				output: "both",
				max_age_days: 7,
				max_size_mb: 100,
			},
		});
		expect(result.level).toBe("debug");
		expect(result.format).toBe("text");
		expect(result.output).toBe("both");
		expect(result.maxAgeDays).toBe(7);
		expect(result.maxSizeMb).toBe(100);
	});

	it("accepts all valid level values", () => {
		for (const level of ["trace", "debug", "info", "warn", "error"] as const) {
			const result = extractLogConfig({ logging: { level } });
			expect(result.level).toBe(level);
		}
	});

	it("accepts all valid output values", () => {
		for (const output of ["stderr", "file", "both"] as const) {
			const result = extractLogConfig({ logging: { output } });
			expect(result.output).toBe(output);
		}
	});

	it("accepts all valid format values", () => {
		for (const format of ["text", "jsonl"] as const) {
			const result = extractLogConfig({ logging: { format } });
			expect(result.format).toBe(format);
		}
	});

	it("ignores invalid level — falls back to default", () => {
		const result = extractLogConfig({ logging: { level: "verbose" } });
		expect(result.level).toBe("info");
	});

	it("ignores invalid output — falls back to default", () => {
		const result = extractLogConfig({ logging: { output: "console" } });
		expect(result.output).toBe("file");
	});

	it("ignores invalid format — falls back to default", () => {
		const result = extractLogConfig({ logging: { format: "xml" } });
		expect(result.format).toBe("jsonl");
	});

	it("clamps max_age_days to 0 minimum", () => {
		const result = extractLogConfig({ logging: { max_age_days: -5 } });
		expect(result.maxAgeDays).toBe(0);
	});

	it("clamps max_size_mb to 0 minimum", () => {
		const result = extractLogConfig({ logging: { max_size_mb: -1 } });
		expect(result.maxSizeMb).toBe(0);
	});

	it("ignores non-object [logging] section", () => {
		const result = extractLogConfig({ logging: "not-an-object" });
		expect(result).toEqual(DEFAULT_LOG_CONFIG);
	});

	it("ignores null [logging] section", () => {
		const result = extractLogConfig({ logging: null });
		expect(result).toEqual(DEFAULT_LOG_CONFIG);
	});

	it("partial override — only overrides specified keys", () => {
		const result = extractLogConfig({ logging: { level: "warn" } });
		expect(result.level).toBe("warn");
		expect(result.format).toBe(DEFAULT_LOG_CONFIG.format);
		expect(result.output).toBe(DEFAULT_LOG_CONFIG.output);
		expect(result.maxAgeDays).toBe(DEFAULT_LOG_CONFIG.maxAgeDays);
		expect(result.maxSizeMb).toBe(DEFAULT_LOG_CONFIG.maxSizeMb);
	});

	it("ignores non-number max_age_days", () => {
		const result = extractLogConfig({ logging: { max_age_days: "thirty" } });
		expect(result.maxAgeDays).toBe(DEFAULT_LOG_CONFIG.maxAgeDays);
	});

	it("ignores non-number max_size_mb", () => {
		const result = extractLogConfig({ logging: { max_size_mb: "50mb" } });
		expect(result.maxSizeMb).toBe(DEFAULT_LOG_CONFIG.maxSizeMb);
	});
});

describe("extractAgentConfig", () => {
	it("resolves agent log level and format from [logging]", () => {
		const result = extractAgentConfig({
			agent: {
				buffer_per_channel: "2MB",
				log_level: "error",
			},
			logging: {
				level: "debug",
				format: "text",
			},
		});

		expect(result.bufferPerChannel).toBe(2 * 1024 * 1024);
		expect(result.logLevel).toBe("debug");
		expect(result.logFormat).toBe("text");
	});

	it("falls back to defaults for malformed [agent] and [logging] values", () => {
		const parsed = {
			agent: {
				buffer_per_channel: true,
				buffer_global: [],
				socket_path: false,
				bind_timeout: "fast",
				log_level: 5,
				format: [],
			},
			logging: {
				level: 5,
				format: [],
			},
		} as unknown as JsonMap;

		expect(() => extractAgentConfig(parsed)).not.toThrow();

		const result = extractAgentConfig(parsed);
		expect(result).toEqual(DEFAULT_AGENT_CONFIG);
	});
});
