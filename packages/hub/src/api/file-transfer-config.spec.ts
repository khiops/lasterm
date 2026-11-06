// biome-ignore-all lint/suspicious/noTemplateCurlyInString: test data holds a literal ${HOME}, which the hub must store as written for the agent to expand
/**
 * File transfer's settings (#835), through a whole hub: every key from its
 * route to config.toml or the database and back, the cascade they resolve
 * in, and the scoped write "Always do this", the files panel and an upload's
 * conflict step share (`planProfileWrite`), made against the real routes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CascadeResponse,
	type ProfileWritePlan,
	planProfileWrite,
	type TerminalProfile,
	type UiConfig,
} from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigResolver, loadUiConfig } from "../config.js";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";

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

beforeEach(async () => {
	configDir = makeTempDir("lasterm-transfer-config-");
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
	await server?.close();
	dbs?.close();
	if (configDir !== undefined) await removeTempDir(configDir);
});

function configToml(): string {
	const path = join(configDir, "config.toml");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function createHost(label: string): Promise<string> {
	const res = await server.inject({
		method: "POST",
		url: "/api/hosts",
		payload: { type: "local", label },
	});
	expect(res.statusCode).toBe(201);
	return res.json<{ id: string }>().id;
}

function createChannel(hostId: string, id: string): string {
	const meta = new MetaDAL(dbs.meta);
	meta.createSession({ id: `ses-${id}`, hostId, status: "starting" });
	meta.createChannel({ id, sessionId: `ses-${id}`, status: "born" });
	return id;
}

async function cascade(hostId?: string, channelId?: string): Promise<CascadeResponse> {
	const query = new URLSearchParams();
	if (hostId !== undefined) query.set("host_id", hostId);
	if (channelId !== undefined) query.set("channel_id", channelId);
	const res = await server.inject({ method: "GET", url: `/api/config/cascade?${query}` });
	expect(res.statusCode).toBe(200);
	return res.json<CascadeResponse>();
}

async function send(method: "PUT" | "PATCH", url: string, payload: object): Promise<void> {
	const res = await server.inject({ method, url, payload });
	expect(res.statusCode, `${method} ${url} ${JSON.stringify(payload)}: ${res.body}`).toBe(200);
}

/** Make a plan's requests, in order, as the client's `saveProfileWrite` does. */
async function apply(plan: ProfileWritePlan | null): Promise<void> {
	expect(plan).not.toBeNull();
	for (const request of plan?.requests ?? []) {
		await send(request.method, request.path, request.body);
	}
}

// ─── Every key round-trips ───────────────────────────────────────────────────

describe("file transfer's keys round-trip", () => {
	const terminal: Partial<TerminalProfile> = {
		transferDrop: "off",
		transferConfirmDrop: false,
		transferOnConflict: "keep_both",
		transferFollowCwd: false,
		transferFallbackDir: "${HOME}/inbox",
		transferVerify: false,
	};

	it("the terminal keys, through PUT /api/config/global and config.toml", async () => {
		await send("PUT", "/api/config/global", { terminal });

		const toml = configToml();
		expect(toml).toContain('transfer_drop = "off"');
		expect(toml).toContain("transfer_confirm_drop = false");
		expect(toml).toContain('transfer_on_conflict = "keep_both"');
		expect(toml).toContain("transfer_follow_cwd = false");
		expect(toml).toContain('transfer_fallback_dir = "${HOME}/inbox"');
		expect(toml).toContain("transfer_verify = false");

		expect((await cascade()).terminal.global).toEqual(terminal);
		// Read back from the file alone, by a hub starting on it.
		const fresh = new ConfigResolver(new MetaDAL(dbs.meta));
		fresh.loadFromFile(configDir);
		expect(fresh.getGlobalTerminalOverrides()).toEqual(terminal);
	});

	it("[transfer], [layout] and [experimental], through PUT /api/config/ui and config.toml", async () => {
		await send("PUT", "/api/config/ui", {
			transfer: { panelSide: "left", openOnDrag: false, maxConcurrent: 3, showHidden: true },
			layout: { transferPanelWidth: 420 },
			experimental: { fileTransfer: true },
		});

		const toml = configToml();
		expect(toml).toMatch(/\[transfer\][^[]*panel_side = "left"/);
		expect(toml).toMatch(/\[transfer\][^[]*open_on_drag = false/);
		expect(toml).toMatch(/\[transfer\][^[]*max_concurrent = 3/);
		expect(toml).toMatch(/\[transfer\][^[]*show_hidden = true/);
		expect(toml).toMatch(/\[layout\][^[]*transfer_panel_width = 420/);
		expect(toml).toMatch(/\[experimental\][^[]*file_transfer = true/);

		const expected: Pick<UiConfig, "transfer" | "experimental"> = {
			transfer: { panelSide: "left", openOnDrag: false, maxConcurrent: 3, showHidden: true },
			experimental: { fileTransfer: true },
		};
		const served = (await server.inject({ method: "GET", url: "/api/config/ui" })).json<UiConfig>();
		expect(served).toMatchObject(expected);
		expect(served.layout.transferPanelWidth).toBe(420);
		const fresh = loadUiConfig(configDir);
		expect(fresh).toMatchObject(expected);
		expect(fresh.layout.transferPanelWidth).toBe(420);
	});

	it("the terminal keys, through a host's and a terminal's profile PATCH", async () => {
		const hostId = await createHost("transfer-roundtrip");
		const channelId = createChannel(hostId, "ch-roundtrip");
		await send("PATCH", `/api/hosts/${hostId}/profile`, { profile: terminal });
		const perTerminal: Partial<TerminalProfile> = {
			transferDrop: "upload",
			transferConfirmDrop: true,
			transferOnConflict: "skip",
			transferFollowCwd: true,
		};
		await send("PATCH", `/api/channels/${channelId}/profile`, { profile: perTerminal });

		const hostRead = await server.inject({ method: "GET", url: `/api/hosts/${hostId}/profile` });
		expect(hostRead.json()).toEqual({ profile: terminal });
		const channelRead = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/profile`,
		});
		expect(channelRead.json()).toEqual({ profile: perTerminal });

		const layers = (await cascade(hostId, channelId)).terminal;
		expect(layers.host).toEqual(terminal);
		expect(layers.channel).toEqual(perTerminal);
		expect(layers.resolved).toMatchObject({
			...perTerminal,
			transferFallbackDir: "${HOME}/inbox",
			transferVerify: false,
		});
	});
});

// ─── The scoped write, per scope ─────────────────────────────────────────────

describe("planProfileWrite, made against the hub", () => {
	/**
	 * `transferOnConflict` set differently at each layer: "skip" globally,
	 * "replace" for host A, "keep_both" for host B and for a terminal on A.
	 */
	async function layered(): Promise<{ hostA: string; hostB: string; channel: string }> {
		const hostA = await createHost("transfer-a");
		const hostB = await createHost("transfer-b");
		const channel = createChannel(hostA, "ch-transfer-a");
		await send("PUT", "/api/config/global", { terminal: { transferOnConflict: "skip" } });
		await send("PATCH", `/api/hosts/${hostA}/profile`, {
			profile: { transferOnConflict: "replace" },
		});
		await send("PATCH", `/api/hosts/${hostB}/profile`, {
			profile: { transferOnConflict: "keep_both" },
		});
		await send("PATCH", `/api/channels/${channel}/profile`, {
			profile: { transferOnConflict: "keep_both" },
		});
		return { hostA, hostB, channel };
	}

	it("for a host: sets it there, drops the terminal's own, and the terminal resolves to it", async () => {
		const { hostA, hostB, channel } = await layered();
		const target = { hostId: hostA, channelId: channel };
		const before = (await cascade(hostA, channel)).terminal;
		expect(before.resolved.transferOnConflict).toBe("keep_both");

		const plan = planProfileWrite("transferOnConflict", "ask", "host", target, before);
		expect(plan?.dropped).toEqual([{ scope: "channel", value: "keep_both" }]);
		await apply(plan);

		const after = (await cascade(hostA, channel)).terminal;
		expect(after.resolved.transferOnConflict).toBe("ask");
		expect(after.host?.transferOnConflict).toBe("ask");
		expect(after.channel).not.toHaveProperty("transferOnConflict");
		// Nothing else moved: the global value, and the other host's.
		expect(after.global.transferOnConflict).toBe("skip");
		expect((await cascade(hostB)).terminal.resolved.transferOnConflict).toBe("keep_both");
	});

	it("globally: sets it in config.toml, drops the host's and the terminal's, and the terminal resolves to it", async () => {
		const { hostA, hostB, channel } = await layered();
		const target = { hostId: hostA, channelId: channel };
		const before = (await cascade(hostA, channel)).terminal;

		const plan = planProfileWrite("transferOnConflict", "ask", "global", target, before);
		expect(plan?.dropped).toEqual([
			{ scope: "host", value: "replace" },
			{ scope: "channel", value: "keep_both" },
		]);
		await apply(plan);

		const after = (await cascade(hostA, channel)).terminal;
		expect(after.resolved.transferOnConflict).toBe("ask");
		expect(after.global.transferOnConflict).toBe("ask");
		expect(configToml()).toContain('transfer_on_conflict = "ask"');
		expect(after.host).not.toHaveProperty("transferOnConflict");
		expect(after.channel).not.toHaveProperty("transferOnConflict");
		// Another host keeps its own, as Settings shows it.
		expect((await cascade(hostB)).terminal.resolved.transferOnConflict).toBe("keep_both");
	});

	it("a key of the host's, globally: drops the host's, and asks nothing of the terminal", async () => {
		const hostId = await createHost("transfer-verify");
		const channelId = createChannel(hostId, "ch-transfer-verify");
		await send("PATCH", `/api/hosts/${hostId}/profile`, { profile: { transferVerify: true } });
		const target = { hostId, channelId };
		const before = (await cascade(hostId, channelId)).terminal;

		const plan = planProfileWrite("transferVerify", false, "global", target, before);
		expect(plan?.requests.map((r) => r.path)).toEqual([
			"/api/config/global",
			`/api/hosts/${hostId}/profile`,
		]);
		expect(plan?.dropped).toEqual([{ scope: "host", value: true }]);
		await apply(plan);

		expect((await cascade(hostId, channelId)).terminal.resolved.transferVerify).toBe(false);
	});
});
