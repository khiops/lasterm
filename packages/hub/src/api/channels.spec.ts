import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SharedSessionContext } from "../session/session-context.js";
import { SessionManager } from "../session/session-manager.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { SpoolDAL } from "../storage/spool.js";
import { registerChannelRoutes } from "./channels.js";

// ─── POST /api/channels/:id/restart while its host is away (#605) ────────────
//
// The route answers what the session manager says: a host the hub is
// reconnecting is refused at once, and said to be away, with its status, for
// a pane to wait for it rather than show a failure of the terminal's.

describe("POST /api/channels/:id/restart", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		dbs = openTestDatabases();
		sessionManager = new SessionManager(dbs);
		server = Fastify({ logger: false });
		registerChannelRoutes(server, new MetaDAL(dbs.meta), sessionManager, new SpoolDAL(dbs.spool));
		await server.ready();
	});

	afterEach(async () => {
		await server.close();
		await sessionManager.shutdown();
		dbs.close();
	});

	/** A terminal of the Pi that ended, the Pi's connection gone, and the hub reconnecting. */
	function endedOnAHostAway(reconnecting: boolean): { hostId: string; channelId: string } {
		const dal = new MetaDAL(dbs.meta);
		const host = dal.createHost({
			type: "ssh",
			label: "raspberrypi",
			sshHost: "pi@raspberrypi.test",
			sshAuth: "agent",
		});
		const sessionId = "01K605SESS0000000000000000";
		const channelId = "01K605CHAN0000000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "disconnected" });
		dal.createChannel({ id: channelId, sessionId, status: "dead", cols: 80, rows: 24 });
		const ctx = (sessionManager as unknown as { ctx: SharedSessionContext }).ctx;
		(ctx.sessions as unknown as Map<string, unknown>).set(host.id, {
			id: sessionId,
			hostId: host.id,
			status: "disconnected",
		});
		// The reconnect the drop scheduled, waiting its turn.
		if (reconnecting) {
			const pending = setTimeout(() => {}, 60_000);
			ctx.reconnectTimers.set(host.id, pending);
		}
		return { hostId: host.id, channelId };
	}

	it("says the host is away while the hub reconnects it", async () => {
		const { hostId, channelId } = endedOnAHostAway(true);

		const res = await server.inject({ method: "POST", url: `/api/channels/${channelId}/restart` });

		expect(res.statusCode).toBe(503);
		expect(res.json()).toEqual({
			error: {
				code: "HOST_UNREACHABLE",
				message: "raspberrypi cannot be reached right now.",
				host_id: hostId,
				host_status: "disconnected",
			},
		});
	});

	// Nothing reaches for it: whatever failed is said as before.
	it("says only that it failed otherwise", async () => {
		const { channelId } = endedOnAHostAway(false);

		const res = await server.inject({ method: "POST", url: `/api/channels/${channelId}/restart` });

		expect(res.statusCode).toBe(503);
		expect(res.json<{ error: { code: string } }>().error.code).toBe("RESTART_FAILED");
	});
});
