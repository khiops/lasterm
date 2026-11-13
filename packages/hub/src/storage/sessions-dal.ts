import type { Session, SessionStatus } from "@lasterm/shared";
import type { CreateSessionInput } from "./meta-types.js";
import type { Database } from "./sqlite.js";

// ─── Row types ───────────────────────────────────────────────────────────────

interface SessionRow {
	id: string;
	host_id: string;
	status: string;
	created_at: string;
	updated_at: string;
}

// ─── Row mapper ──────────────────────────────────────────────────────────────

function rowToSession(row: SessionRow): Session {
	return {
		id: row.id,
		hostId: row.host_id,
		status: row.status as SessionStatus,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ─── SessionsDAL ─────────────────────────────────────────────────────────────

export class SessionsDAL {
	constructor(private db: Database) {}

	// ─── Sessions ───────────────────────────────────────────────────────────

	createSession(input: CreateSessionInput): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO sessions (id, host_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(input.id, input.hostId, input.status, now, now);
	}

	getSession(id: string): Session | undefined {
		const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
			| SessionRow
			| undefined;
		return row ? rowToSession(row) : undefined;
	}

	listSessions(hostId?: string): Session[] {
		const rows = (
			hostId
				? this.db
						.prepare("SELECT * FROM sessions WHERE host_id = ? ORDER BY created_at ASC")
						.all(hostId)
				: this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all()
		) as SessionRow[];
		return rows.map(rowToSession);
	}

	/** The sessions that are not closed, oldest first: what `GET /api/sessions` lists by default. */
	listOpenSessions(hostId?: string): Session[] {
		const rows = (
			hostId
				? this.db
						.prepare(
							"SELECT * FROM sessions WHERE host_id = ? AND status != 'closed' ORDER BY created_at ASC",
						)
						.all(hostId)
				: this.db
						.prepare("SELECT * FROM sessions WHERE status != 'closed' ORDER BY created_at ASC")
						.all()
		) as SessionRow[];
		return rows.map(rowToSession);
	}

	/**
	 * What a hub start leaves of the sessions (#911): every session it does not
	 * hold is closed, and every closed session no terminal belongs to goes. A
	 * closed session a terminal still names stays, for that terminal's host is
	 * found through it. Says how many it closed and deleted.
	 */
	sweepSessions(heldIds: readonly string[]): { closed: number; deleted: number } {
		const now = new Date().toISOString();
		const closed = this.db
			.prepare(
				`UPDATE sessions SET status = 'closed', updated_at = ?
				 WHERE status != 'closed' AND id NOT IN (SELECT value FROM json_each(?))`,
			)
			.run(now, JSON.stringify(heldIds)).changes;
		const deleted = this.db
			.prepare(
				`DELETE FROM sessions WHERE status = 'closed'
				 AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.session_id = sessions.id)`,
			)
			.run().changes;
		return { closed, deleted };
	}

	updateSessionStatus(id: string, status: SessionStatus): void {
		const now = new Date().toISOString();
		this.db
			.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
			.run(status, now, id);
	}

	deleteSession(id: string): void {
		this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
	}

	markAllSessionsClosed(): number {
		const now = new Date().toISOString();
		const result = this.db
			.prepare("UPDATE sessions SET status = 'closed', updated_at = ? WHERE status != 'closed'")
			.run(now);
		return result.changes;
	}

	/** Mark non-closed sessions for a host as disconnected. */
	markHostSessionDisconnected(hostId: string): number {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`UPDATE sessions SET status = 'disconnected', updated_at = ?
				 WHERE host_id = ? AND status != 'closed'`,
			)
			.run(now, hostId);
		return result.changes;
	}
}
