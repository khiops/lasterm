import type Database from "better-sqlite3";

import type { PairingCodeRow } from "./meta-types.js";

// ─── PairingCodesDAL ─────────────────────────────────────────────────────────

/**
 * Pairing codes, known here only by their keyed hash: the code itself is never
 * stored, and the key never reaches this table (SECURITY.md § 2.3, #521). The
 * route computes the hash and hands it in.
 */
export class PairingCodesDAL {
	constructor(private db: Database.Database) {}

	// ─── Pairing Codes ───────────────────────────────────────────────────────

	createPairingCode(id: string, codeHash: string, createdAt: string, expiresAt: string): void {
		this.db
			.prepare(
				"INSERT INTO pairing_codes (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
			)
			.run(id, codeHash, createdAt, expiresAt);
	}

	getPairingCodeByHash(codeHash: string): PairingCodeRow | undefined {
		return this.db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ?").get(codeHash) as
			| PairingCodeRow
			| undefined;
	}

	markPairingCodeUsed(id: string, usedAt: string, usedByIp: string): void {
		this.db
			.prepare("UPDATE pairing_codes SET used = 1, used_at = ?, used_by_ip = ? WHERE id = ?")
			.run(usedAt, usedByIp, id);
	}

	countActivePairingCodes(): number {
		const now = new Date().toISOString();
		const row = this.db
			.prepare("SELECT COUNT(*) as n FROM pairing_codes WHERE used = 0 AND expires_at > ?")
			.get(now) as { n: number };
		return row.n;
	}

	cleanExpiredPairingCodes(): void {
		const now = new Date().toISOString();
		this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ? AND used = 0").run(now);
	}

	/**
	 * Every code not yet redeemed, expired or not. A hub that starts calls this:
	 * the key that hashed those codes died with the run before, so none of them
	 * can be redeemed any more, and left in place they would still count against
	 * the three a hub allows at once.
	 */
	deleteUnredeemedPairingCodes(): void {
		this.db.prepare("DELETE FROM pairing_codes WHERE used = 0").run();
	}
}
