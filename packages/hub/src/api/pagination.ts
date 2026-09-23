// The one reading of `?limit=&offset=` for every list route that pages (#530).
// Routes that parsed them themselves drifted apart: two answered a bad value
// with 200, most read "10abc" or "1.5" as a number, and the entity lists passed
// SQLite an offset it cannot bind, which failed as a 500.

/** The largest page a route serves. */
const MAX_PAGE_LIMIT = 1000;

/**
 * The largest offset. Past it a JavaScript number no longer holds every
 * integer, and SQLite refuses the value it is given as a datatype mismatch.
 */
const MAX_PAGE_OFFSET = Number.MAX_SAFE_INTEGER;

/** Decimal digits only: no sign, no point, no exponent, no whitespace. */
const DIGITS_RE = /^\d+$/;

export const LIMIT_ERROR = `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`;
export const OFFSET_ERROR = `offset must be an integer from 0 to ${MAX_PAGE_OFFSET}`;

export type PageRequest =
	| {
			readonly ok: true;
			/** Absent when the query gave none; the route picks its own default. */
			readonly limit: number | undefined;
			readonly offset: number;
	  }
	| {
			readonly ok: false;
			/** What a route answers as `{ error }`, with HTTP 400. */
			readonly error: { readonly code: "VALIDATION_ERROR"; readonly message: string };
	  };

/**
 * Reads `limit` and `offset` from a route's query. Either may be absent; one
 * that is present must be a string of decimal digits within its range. The
 * parameters are typed `unknown` because a key given twice arrives as an array.
 */
export function parsePagination(query: { limit?: unknown; offset?: unknown }): PageRequest {
	const limit = readInteger(query.limit, 1, MAX_PAGE_LIMIT);
	if (limit === null) return refuse(LIMIT_ERROR);
	const offset = readInteger(query.offset, 0, MAX_PAGE_OFFSET);
	if (offset === null) return refuse(OFFSET_ERROR);
	return { ok: true, limit, offset: offset ?? 0 };
}

/** `undefined` when absent, `null` when present but not an integer in `[min, max]`. */
function readInteger(raw: unknown, min: number, max: number): number | undefined | null {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || !DIGITS_RE.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function refuse(message: string): PageRequest {
	return { ok: false, error: { code: "VALIDATION_ERROR", message } };
}
