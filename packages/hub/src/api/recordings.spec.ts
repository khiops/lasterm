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

	// AC-PARTS / cursor and AC-WFAIL / fixed-at-first-part over HTTP: the client follows
	// X-Lasterm-Cast-Next-Seq with ?from_seq=&last_seq=&lost= until it is absent, and the
	// loss the first response fixed ends the last part, though a block written meanwhile
	// reset the stored count. Mutations caught: the Next-Seq header renamed or dropped;
	// from_seq and last_seq swapped; `lost: 0` passed to the recorder.
	it("serves a recording in parts that follow the cursor, the first part's loss marked last", async () => {
		await build();
		live();
		const MiB = 1024 * 1024;
		const clock = vi.spyOn(performance, "now").mockReturnValue(0); // every delay 0.000
		const writeBlock = vi.spyOn(RecordingsDAL.prototype, "writeBlock");
		try {
			const start = await server.inject({
				method: "POST",
				url: `/api/channels/${CHANNEL}/recording`,
			});
			const id = start.json().id as string;
			const { requestId } = agentSend.mock.calls[0]?.[0] ?? {};
			ctx().pendingRequests.get(requestId)?.({
				type: "ATTACH_OK",
				channelId: CHANNEL,
				requestId,
				snapshot: { serialized: "S", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
				lastSeq: 0,
			} as never);
			// Each 3 MiB output fills a block of its own: 3 blocks, over 4 MiB in all.
			for (const letter of ["a", "b", "c"]) {
				sm.recorder.onOutput(CHANNEL, new TextEncoder().encode(letter.repeat(3 * MiB)));
			}
			// Four bytes buffered, whose block the first request's flush fails to write.
			writeBlock.mockImplementationOnce(() => {
				throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
			});
			sm.recorder.onOutput(CHANNEL, new TextEncoder().encode("lost"));

			const first = await server.inject({ method: "GET", url: `/api/recordings/${id}/cast` });
			expect(first.statusCode).toBe(200);
			expect(first.headers["x-lasterm-cast-last-seq"]).toBe("3");
			expect(first.headers["x-lasterm-cast-lost"]).toBe("4");
			// Written after the first request: it opens with the loss marker and resets the
			// stored count, past last_seq, so in no part of this export.
			sm.recorder.onOutput(CHANNEL, new TextEncoder().encode("d".repeat(3 * MiB)));
			expect(new RecordingsDAL(dbs.spool).get(id)?.unmarkedLostBytes).toBe(0);

			const lastSeq = String(first.headers["x-lasterm-cast-last-seq"]);
			const lost = String(first.headers["x-lasterm-cast-lost"]);
			const bodies = [first.body];
			let next = first.headers["x-lasterm-cast-next-seq"];
			while (next !== undefined && bodies.length < 10) {
				const part = await server.inject({
					method: "GET",
					url: `/api/recordings/${id}/cast?from_seq=${next}&last_seq=${lastSeq}&lost=${lost}`,
				});
				expect(part.statusCode).toBe(200);
				bodies.push(part.body);
				next = part.headers["x-lasterm-cast-next-seq"];
			}

			const whole = bodies.join("");
			const [header, ...events] = whole.split("\n");
			expect(header).toMatch(
				/^\{"version":3,"term":\{"cols":80,"rows":24,"type":"xterm-256color"\},"timestamp":\d+,"title":"Terminal — pi"\}$/,
			);
			const expected = [
				'[0.000, "o", "S"]',
				`[0.000, "o", "${"a".repeat(3 * MiB)}"]`,
				`[0.000, "o", "${"b".repeat(3 * MiB)}"]`,
				`[0.000, "o", "${"c".repeat(3 * MiB)}"]`,
				'[0.000, "m", "lasterm: 4 bytes not recorded (storage error)"]',
				"",
			];
			// Long lines shown by their start and length, so a failure stays readable.
			const brief = (lines: string[]) =>
				lines.map((l) => (l.length > 64 ? `${l.slice(0, 16)}…(${l.length})` : l));
			expect(brief(events)).toEqual(brief(expected));
			expect(events.join("\n") === expected.join("\n")).toBe(true);
			// One part a block: none of 3 MiB joins another under the 4 MiB part.
			expect(bodies).toHaveLength(3);
		} finally {
			clock.mockRestore();
			writeBlock.mockRestore();
		}
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

		// AC-LIST. Mutation caught: `used_bytes` other than the sum of the rows' bytes (the cap).
		it("is listed with the space used and allowed", async () => {
			// The export's flush writes the abandoned wait's marker and the held "hello" as
			// one block: 71 + 22 bytes of export lines. The recording stays open.
			await server.inject({ method: "GET", url: `/api/recordings/${id}/cast` });
			const res = await server.inject({ method: "GET", url: "/api/recordings" });
			expect(res.statusCode).toBe(200);
			const body = res.json();
			expect(body.recordings.map((r: { id: string }) => r.id)).toEqual([id]);
			expect(body.recordings[0]).toMatchObject({ ended_at: null, bytes: 93 });
			expect(body.used_bytes).toBe(93);
			expect(body.cap_bytes).toBe(1024 * 1024 * 1024);
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
