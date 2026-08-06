import type { Session, SessionStatus } from "@lasterm/shared";
import type Database from "better-sqlite3";

import type { CreateSessionInput } from "./meta-types.js";

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
	constructor(private db: Database.Database) {}

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
