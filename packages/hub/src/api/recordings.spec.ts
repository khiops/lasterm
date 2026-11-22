/**
 * The recording routes (#80, spec freeze 1): what each answers, its refusals,
 * the export's parts and headers, deletion, and the bearer every route needs.
 * New file: these routes are a new area; `channels.spec.ts` covers `/api/channels`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { DEFAULT_GC_CONFIG } from "../config.js";
import { createServer } from "../server.fixture.js";
import type { SharedSessionContext } from "../session/session-context.js";
import { SessionManager } from "../session/session-manager.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { RecordingsDAL } from "../storage/recordings.js";
import { getTestTls } from "../test-tls.fixture.js";
import { registerChannelRoutes } from "./channels.js";
import { registerRecordingRoutes } from "./recordings.js";

const SESSION = "01K80SESS00000000000000000";
const CHANNEL = "01K80CHAN00000000000000000";

describe("recording routes", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let sm: SessionManager;
	let hostId: string;
	let agentSend: ReturnType<typeof vi.fn>;

	function ctx(): SharedSessionContext {
		return (sm as unknown as { ctx: SharedSessionContext }).ctx;
	}

	async function build(capMb?: number): Promise<void> {
		dbs = openTestDatabases();
		sm = new SessionManager(
			dbs,
			capMb === undefined ? undefined : { ...DEFAULT_GC_CONFIG, recordingMaxTotalMb: capMb },
		);
		server = Fastify({ logger: false });
		const meta = new MetaDAL(dbs.meta);
		registerChannelRoutes(server, meta, sm);
		registerRecordingRoutes(server, sm);
		await server.ready();
		hostId = meta.createHost({
			type: "ssh",
			label: "pi",
			sshHost: "pi@pi.test",
			sshAuth: "agent",
		}).id;
		meta.createSession({ id: SESSION, hostId, status: "active" });
		meta.createChannel({ id: CHANNEL, sessionId: SESSION, status: "live", cols: 80, rows: 24 });
	}

	/** The terminal live in the hub, its host's agent connected (or not). */
	function live(status: "live" | "orphan" = "live", agentConnected = true): void {
		agentSend = vi.fn();
		(ctx().agents as unknown as Map<string, unknown>).set(hostId, {
			connected: agentConnected,
			send: agentSend,
			helloMessage: { type: "HELLO", version: 1, agentVersion: HUB_VERSION },
		});
		ctx().channels.set(CHANNEL, {
			sessionId: SESSION,
			hostId,
			status,
			clients: new Set(),
			cols: 80,
			rows: 24,
		} as never);
	}

	afterEach(async () => {
		await server.close();
		await sm.shutdown();
		dbs.close();
	});

	describe("POST /api/channels/:id/recording", () => {
		beforeEach(() => build());

		it("starts a recording and asks the agent for the screen", async () => {
			live();
			const res = await server.inject({
				method: "POST",
				url: `/api/channels/${CHANNEL}/recording`,
			});
			expect(res.statusCode).toBe(201);
			expect(res.json()).toMatchObject({ channel_id: CHANNEL, host_label: "pi", ended_at: null });
			expect(agentSend).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "ATTACH",
					channelId: CHANNEL,
					requestId: expect.any(String),
				}),
			);
		});

		// AC-REFUSE / R-404, R-NOT-LIVE, R-DUP. Mutation caught: a guard removed (a recording opens).
		it("refuses an unknown terminal", async () => {
			const res = await server.inject({
				method: "POST",
				url: "/api/channels/01K80NONE00000000000000000/recording",
			});
			expect(res.statusCode).toBe(404);
			expect(res.json().error.code).toBe("CHANNEL_NOT_FOUND");
		});

		it.each([
			["unknown to the hub's live set", () => undefined],
			// A dead terminal stays in the map until it is forgotten.
			["dead", () => live("dead" as never)],
			["orphan", () => live("orphan")],
			["live with its agent gone", () => live("live", false)],
		])("refuses a terminal that is %s", async (_label, arrange) => {
			arrange();
			const res = await server.inject({
				method: "POST",
				url: `/api/channels/${CHANNEL}/recording`,
			});
			expect(res.statusCode).toBe(409);
			expect(res.json().error.code).toBe("CHANNEL_NOT_LIVE");
			expect(sm.recordingIdOf(CHANNEL)).toBeNull();
		});

		it("refuses a second recording, naming the open one", async () => {
			live();
			const first = await server.inject({
				method: "POST",
				url: `/api/channels/${CHANNEL}/recording`,
			});
			const second = await server.inject({
				method: "POST",
				url: `/api/channels/${CHANNEL}/recording`,
			});
			expect(second.statusCode).toBe(409);
			expect(second.json().error).toMatchObject({
				code: "ALREADY_RECORDING",
				recording_id: first.json().id,
			});
		});
	});

	// R-CAP.
	it("refuses a start once the cap is reached", async () => {
		await build(1);
		const dal = new RecordingsDAL(dbs.spool);
		dal.open(
			{
				id: "01K80FULL00000000000000000",
				channelId: "other",
				hostLabel: "pi",
				title: "t",
				startedAt: new Date().toISOString(),
				cols: 80,
				rows: 24,
			},
			[],
			{ reason: "crashed", endedAt: new Date().toISOString() },
		);
		dal.writeBlock({
			recordingId: "01K80FULL00000000000000000",
			seq: 1,
			lines: Buffer.alloc(1024 * 1024),
			durationMs: 0,
			resetLost: false,
		});
		live();
		const res = await server.inject({ method: "POST", url: `/api/channels/${CHANNEL}/recording` });
		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("RECORDING_CAP");
	});

	// AC-CONTROL-ERRORS / open-fails through the route. Mutation caught: the storage error answered 409.
	it("answers 500 when the recording cannot be stored", async () => {
		await build();
		live();
		const open = vi.spyOn(RecordingsDAL.prototype, "open").mockImplementationOnce(() => {
			throw Object.assign(new Error("full"), { code: "SQLITE_FULL" });
		});
		try {
			const res = await server.inject({
				method: "POST",
				url: `/api/channels/${CHANNEL}/recording`,
			});
			expect(res.statusCode).toBe(500);
			expect(res.json().error.code).toBe("RECORDING_STORAGE_ERROR");
		} finally {
			open.mockRestore();
		}
	});

	describe("a recording", () => {
		let id: string;

		beforeEach(async () => {
			await build();
			live();
			id = (
				await server.inject({ method: "POST", url: `/api/channels/${CHANNEL}/recording` })
			).json().id;
			sm.recorder.onOutput(CHANNEL, new TextEncoder().encode("hello"));
		});

		// AC-LIST.
		it("is listed with the space used and allowed", async () => {
			const res = await server.inject({ method: "GET", url: "/api/recordings" });
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.recordings.map((r: { id: string }) => r.id)).toEqual([id]);
			expect(body.cap_bytes).toBe(1024 * 1024 * 1024);
			expect(typeof body.used_bytes).toBe("number");
		});

		// AC-CHANNELS-FIELD. Mutation caught: the field kept after the end.
		it("is named by its terminal's row in /api/channels while open", async () => {
			const open = await server.inject({ method: "GET", url: `/api/channels?host_id=${hostId}` });
			expect(open.json()[0].recording_id).toBe(id);
			await server.inject({ method: "POST", url: `/api/recordings/${id}/stop` });
			const ended = await server.inject({ method: "GET", url: `/api/channels?host_id=${hostId}` });
			expect(ended.json()[0].recording_id).toBeNull();
		});

		// AC-STOP through the route.
		it("stops, and a second stop answers the same row", async () => {
			const first = await server.inject({ method: "POST", url: `/api/recordings/${id}/stop` });
			expect(first.statusCode).toBe(200);
			expect(first.json()).toMatchObject({ id, end_reason: "stopped" });
			const second = await server.inject({ method: "POST", url: `/api/recordings/${id}/stop` });
			expect(second.json()).toEqual(first.json());
			const unknown = await server.inject({
				method: "POST",
				url: "/api/recordings/01K80NONE00000000000000000/stop",
			});
			expect(unknown.statusCode).toBe(404);
		});

		// AC-HEADER (headers).
		it("exports as asciicast v3, with its file name and cursor headers", async () => {
			const res = await server.inject({ method: "GET", url: `/api/recordings/${id}/cast` });
			expect(res.statusCode).toBe(200);
			expect(res.headers["content-type"]).toBe("application/x-asciicast; charset=utf-8");
			expect(res.headers["content-disposition"]).toMatch(
				/^attachment; filename="lasterm-terminal-\d{8}-\d{6}\.cast"$/,
			);
			expect(res.headers["x-lasterm-cast-last-seq"]).toBe("1");
			expect(res.headers["x-lasterm-cast-lost"]).toBe("0");
			expect(res.headers["x-lasterm-cast-next-seq"]).toBeUndefined();
			const lines = res.body.split("\n");
			expect(JSON.parse(lines[0] as string).version).toBe(3);
			expect(lines).toContain(
				'[0.000, "m", "lasterm: the screen before this point is not available"]',
			);
		});

		// AC-EXPORT-PARAMS. Mutation caught: validation removed.
		it.each([
			"from_seq=x&last_seq=1&lost=0",
			"from_seq=1&last_seq=-1&lost=0",
			"from_seq=1&last_seq=1&lost=1.5",
			"from_seq=1",
			"from_seq=1&last_seq=1",
		])("refuses the parameters %s", async (query) => {
			const res = await server.inject({
				method: "GET",
				url: `/api/recordings/${id}/cast?${query}`,
			});
			expect(res.statusCode).toBe(400);
		});

		// AC-DELETE through the route.
		it("is deleted: 204, then unknown to the list and the export", async () => {
			const res = await server.inject({ method: "DELETE", url: `/api/recordings/${id}` });
			expect(res.statusCode).toBe(204);
			const cast = await server.inject({ method: "GET", url: `/api/recordings/${id}/cast` });
			expect(cast.statusCode).toBe(404);
			const list = await server.inject({ method: "GET", url: "/api/recordings" });
			expect(list.json().recordings).toEqual([]);
			const again = await server.inject({ method: "DELETE", url: `/api/recordings/${id}` });
			expect(again.statusCode).toBe(404);
		});
	});
});

// AC-AUTH / R-AUTH. Mutation caught: the paths added to the asset-token prefixes.
describe("recording routes — bearer", () => {
	const TOKEN = "a".repeat(64);
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	it("needs the bearer on every route, and an asset token opens none", async () => {
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		const routes: Array<[string, string]> = [
			["GET", "/api/recordings"],
			["POST", "/api/channels/01K80CHAN00000000000000000/recording"],
			["GET", "/api/recordings/01K80REC000000000000000000/cast"],
			["POST", "/api/recordings/01K80REC000000000000000000/stop"],
			["DELETE", "/api/recordings/01K80REC000000000000000000"],
		];
		const token = await server.inject({
			method: "GET",
			url: "/api/assets/token",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		const assetToken = token.json<{ assetToken: string }>().assetToken;
		for (const [method, url] of routes) {
			const bare = await server.inject({ method: method as "GET", url });
			expect(bare.statusCode, `${method} ${url}`).toBe(401);
			const signed = await server.inject({
				method: method as "GET",
				url: `${url}?asset_token=${assetToken}`,
			});
			expect(signed.statusCode, `${method} ${url} with an asset token`).toBe(401);
		}
		const authed = await server.inject({
			method: "GET",
			url: "/api/recordings",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(authed.statusCode).toBe(200);
	});
});
