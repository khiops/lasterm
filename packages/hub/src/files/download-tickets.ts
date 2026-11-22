import { randomBytes } from "node:crypto";
import { tokensEqual } from "../auth.js";

/**
 * Download tickets (#840): what lets a browser's ordinary download, an `<a>`
 * that carries no header, reach a download route. A ticket is made for one
 * token's request through the bearer, for one host and one normalised path (or
 * one archive manifest), used once, within `TICKET_TTL_MS`, and only on the
 * route of its kind. Kept in memory: a restart forgets them.
 */

/** How long a ticket stays usable. */
export const TICKET_TTL_MS = 60_000;

/** How many tickets one token may hold; a new one drops the oldest. */
export const TICKETS_PER_TOKEN = 32;

export type TicketKind = "file" | "archive";

/** What a ticket opens. */
export interface TicketGrant<T = unknown> {
	readonly kind: TicketKind;
	readonly hostId: string;
	/** The normalised path of a file ticket, or an archive ticket's manifest. */
	readonly payload: T;
}

interface Held extends TicketGrant {
	readonly ticket: string;
	readonly tokenId: string;
	readonly expires: number;
}

export class DownloadTickets {
	private readonly held: Held[] = [];

	constructor(private readonly now: () => number = () => Date.now()) {}

	issue(tokenId: string, grant: TicketGrant): { ticket: string; expiresIn: number } {
		this.sweep();
		const ticket = randomBytes(32).toString("base64url");
		const mine = this.held.filter((held) => held.tokenId === tokenId);
		if (mine.length >= TICKETS_PER_TOKEN) {
			const oldest = mine[0];
			if (oldest !== undefined) this.held.splice(this.held.indexOf(oldest), 1);
		}
		this.held.push({ ...grant, ticket, tokenId, expires: this.now() + TICKET_TTL_MS });
		return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
	}

	/**
	 * Use `ticket` for a request of `kind` on `hostId`: its grant, once, or null
	 * when it is unknown, expired, used, of another kind or for another host.
	 */
	take(ticket: string, kind: TicketKind, hostId: string): TicketGrant | null {
		this.sweep();
		const index = this.held.findIndex((held) => tokensEqual(held.ticket, ticket));
		if (index === -1) return null;
		const held = this.held[index] as Held;
		if (held.kind !== kind || held.hostId !== hostId) return null;
		this.held.splice(index, 1);
		return { kind: held.kind, hostId: held.hostId, payload: held.payload };
	}

	private sweep(): void {
		const now = this.now();
		for (let i = this.held.length - 1; i >= 0; i--) {
			if ((this.held[i] as Held).expires <= now) this.held.splice(i, 1);
		}
	}
}

declare module "fastify" {
	interface FastifyRequest {
		/** The grant of the download ticket the auth hook took for this request (#840), or null. */
		downloadGrant: TicketGrant | null;
	}
}
