import type { Database } from "./sqlite.js";

// ─── PairRateLimitsDAL ───────────────────────────────────────────────────────

interface RateLimitRow {
	ip: string;
	attempts: number;
	window_start: string;
}

export class PairRateLimitsDAL {
	constructor(private db: Database) {}

	/**
	 * Atomically increments the attempt counter for the given IP within the
	 * current time window.  Returns `true` if the request is allowed, `false`
	 * if the caller should respond with 429.
	 *
	 * Exponential backoff: after `backoffThreshold` attempts the effective
	 * window is doubled, quadrupled, etc. up to a maximum of 8x the base window.
	 */
	checkAndIncrement(
		ip: string,
		maxAttempts: number,
		windowMs: number,
		backoffThreshold = 5,
	): boolean {
		const now = Date.now();
		const nowIso = new Date(now).toISOString();

		const row = this.db
			.prepare("SELECT ip, attempts, window_start FROM pair_rate_limits WHERE ip = ?")
			.get(ip) as RateLimitRow | undefined;

		if (!row) {
			// First attempt from this IP -- insert fresh record and allow.
			this.db
				.prepare("INSERT INTO pair_rate_limits (ip, attempts, window_start) VALUES (?, 1, ?)")
				.run(ip, nowIso);
			return true;
		}

		const windowStart = new Date(row.window_start).getTime();

		// Compute effective window with exponential backoff.
		// After backoffThreshold attempts, double per additional batch, capped at 8x.
		const multiplier =
			row.attempts >= backoffThreshold
				? Math.min(8, 2 ** Math.floor((row.attempts - backoffThreshold) / maxAttempts + 1))
				: 1;
		const effectiveWindow = windowMs * multiplier;

		if (now - windowStart >= effectiveWindow) {
			// Window expired -- reset counter and allow.
			this.db
				.prepare("UPDATE pair_rate_limits SET attempts = 1, window_start = ? WHERE ip = ?")
				.run(nowIso, ip);
			return true;
		}

		// Within the window -- increment and check.
		this.db.prepare("UPDATE pair_rate_limits SET attempts = attempts + 1 WHERE ip = ?").run(ip);

		return row.attempts + 1 <= maxAttempts;
	}

	/** Delete records whose window has fully expired.  Call periodically to prevent table growth. */
	cleanExpired(windowMs: number): void {
		const cutoff = new Date(Date.now() - windowMs * 8).toISOString();
		this.db.prepare("DELETE FROM pair_rate_limits WHERE window_start < ?").run(cutoff);
	}
}
