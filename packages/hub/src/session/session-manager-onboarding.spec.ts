/**
 * session-manager-onboarding.spec.ts
 *
 * The local host: ensureLocalHost creates it when meta.db has none, and finds
 * it by its type afterwards, whatever the user renamed it to (#658).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubLogger } from "../logging/hub-logger.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { SessionManager } from "./session-manager.js";

/** The lookup a SPAWN goes through: no id, or the alias "local", is the local host. */
function resolveHostId(sm: SessionManager, requestedId?: string): Promise<string> {
	return (
		sm as unknown as { agentMgr: { resolveHostId: (id?: string) => Promise<string> } }
	).agentMgr.resolveHostId(requestedId);
}

/** Moves a host's creation time, so which one is oldest does not depend on the clock. */
function setCreatedAt(dbs: DatabaseManager, hostId: string, createdAt: string): void {
	dbs.meta.prepare("UPDATE hosts SET created_at = ? WHERE id = ?").run(createdAt, hostId);
}

describe("ensureLocalHost", () => {
	let dbs: DatabaseManager;
	let metaDal: MetaDAL;
	let log: ReturnType<typeof vi.fn>;
	const managers: SessionManager[] = [];

	/** A hub starting on this profile. */
	function startHub(): SessionManager {
		const hubLogger = { log, logAlways: vi.fn() } as unknown as HubLogger;
		const sm = new SessionManager(dbs, undefined, undefined, undefined, hubLogger);
		managers.push(sm);
		return sm;
	}

	/** That hub stopping. */
	async function stopHub(sm: SessionManager): Promise<void> {
		managers.splice(managers.indexOf(sm), 1);
		await sm.shutdown();
	}

	beforeEach(() => {
		dbs = openTestDatabases();
		metaDal = new MetaDAL(dbs.meta);
		log = vi.fn();
	});

	afterEach(async () => {
		for (const sm of managers.splice(0)) await sm.shutdown();
		dbs.close();
	});

	it("creates the local host when the profile has none", async () => {
		expect(metaDal.listHosts()).toHaveLength(0);

		const id = await startHub().ensureLocalHost();

		const host = metaDal.getHost(id);
		expect(host?.type).toBe("local");
		expect(host?.label).toBe("local");
		expect(host?.iconType).toBe("auto");
		expect(host?.sshHost).toBeUndefined();
	});

	it("finds the same host on every call", async () => {
		const sm = startHub();
		const first = await sm.ensureLocalHost();

		expect(await sm.ensureLocalHost()).toBe(first);
		expect(await resolveHostId(sm, "local")).toBe(first);
		expect(metaDal.listHosts()).toHaveLength(1);
	});

	it("keeps the renamed local host across a restart, and creates no other (#658)", async () => {
		const before = startHub();
		const id = await before.ensureLocalHost();
		metaDal.updateHost(id, { label: "workstation" });
		await stopHub(before);

		const after = startHub();
		expect(await after.ensureLocalHost()).toBe(id);
		expect(await resolveHostId(after, "local")).toBe(id);
		expect(await resolveHostId(after)).toBe(id);

		const locals = metaDal.listLocalHosts();
		expect(locals.map((host) => [host.id, host.label])).toEqual([[id, "workstation"]]);
		expect(metaDal.listHosts()).toHaveLength(1);
	});

	it("uses the oldest of several local hosts, deletes none, and says so once (#658)", async () => {
		// As the bug left a profile: the renamed host, then one labelled "local"
		// created at the next start. Inserted in the other order, so that neither
		// the label nor the insertion order is what picks.
		const newer = metaDal.createHost({ type: "local", label: "local" });
		const renamed = metaDal.createHost({ type: "local", label: "workstation" });
		setCreatedAt(dbs, renamed.id, "2026-01-01T00:00:00.000Z");
		setCreatedAt(dbs, newer.id, "2026-02-01T00:00:00.000Z");

		const sm = startHub();
		expect(await sm.ensureLocalHost()).toBe(renamed.id);
		expect(await resolveHostId(sm, "local")).toBe(renamed.id);
		expect(await resolveHostId(sm)).toBe(renamed.id);

		expect(metaDal.getHost(newer.id)?.type).toBe("local");
		expect(metaDal.listLocalHosts().map((host) => host.id)).toEqual([renamed.id, newer.id]);

		const reports = log.mock.calls.filter(([, msg]) => String(msg).includes("several local hosts"));
		expect(reports).toEqual([
			[
				"info",
				"agent-connection-manager: several local hosts, using the oldest",
				{ hostId: renamed.id, otherHostIds: [newer.id] },
			],
		]);
	});

	it("creates the local host under another label when a remote host holds 'local'", async () => {
		const remote = metaDal.createHost({ type: "ssh", label: "local", sshHost: "10.0.0.1" });

		const id = await startHub().ensureLocalHost();

		expect(id).not.toBe(remote.id);
		expect(metaDal.getHost(id)).toMatchObject({ type: "local", label: "local-2" });
		expect(metaDal.getHost(remote.id)).toMatchObject({ type: "ssh", label: "local" });
	});
});
