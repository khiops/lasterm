import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { FastifyInstance } from "fastify";
import { severityForLevel } from "../logging/levels.js";
import { parsePagination } from "./pagination.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogQueryParams {
	level?: string; // filter by min severity level
	from_t?: string; // min offset ms (channel) or ISO date (hub)
	to_t?: string; // max offset ms (channel) or ISO date (hub)
	search?: string; // case-insensitive substring match on msg
	limit?: string; // max entries (default LOG_PAGE_SIZE); range in pagination.ts
	offset?: string; // skip first N entries
}

/** The page a log route serves when the query names no `limit`. */
const LOG_PAGE_SIZE = 100;

// ULID: 26 chars, alphanumeric (Crockford base32). Relaxed to [0-9A-Za-z] to
// prevent path traversal while covering all valid ULIDs.
const CHANNEL_ID_RE = /^[0-9A-Za-z]{26}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read a JSONL file and return parsed entries, skipping empty/malformed lines.
 * Uses readline streaming to avoid slurping the entire file into memory.
 */
async function readJsonl(filePath: string): Promise<Record<string, unknown>[]> {
	let stream: fs.ReadStream;
	try {
		stream = fs.createReadStream(filePath, { encoding: "utf8" });
		// Surface ENOENT / permission errors before we await lines
		await new Promise<void>((resolve, reject) => {
			stream.once("error", reject);
			stream.once("readable", resolve);
			stream.once("end", resolve);
		});
	} catch {
		return [];
	}

	const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	const entries: Record<string, unknown>[] = [];
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				entries.push(parsed as Record<string, unknown>);
			}
		} catch {
			// Skip malformed lines
		}
	}
	return entries;
}

/**
 * Filter entries by minimum severity level.
 * E.g. level="warn" keeps warn + error.
 */
function filterByLevel(
	entries: Record<string, unknown>[],
	level: string | undefined,
): Record<string, unknown>[] {
	if (!level) return entries;
	const minSev = severityForLevel(level);
	if (minSev === undefined) return entries;
	return entries.filter((e) => {
		const lvl = e.lvl;
		if (typeof lvl !== "string") return false;
		const sev = severityForLevel(lvl);
		return sev !== undefined && sev >= minSev;
	});
}

/**
 * Filter channel log entries by `t` (ms offset) range.
 */
function filterChannelByTime(
	entries: Record<string, unknown>[],
	fromT: string | undefined,
	toT: string | undefined,
): Record<string, unknown>[] {
	if (!fromT && !toT) return entries;
	const from = fromT !== undefined ? Number(fromT) : undefined;
	const to = toT !== undefined ? Number(toT) : undefined;
	return entries.filter((e) => {
		const t = e.t;
		if (typeof t !== "number") return true;
		if (from !== undefined && t < from) return false;
		if (to !== undefined && t > to) return false;
		return true;
	});
}

/**
 * Filter hub log entries by `ts` (ISO 8601 string) range.
 */
function filterHubByTime(
	entries: Record<string, unknown>[],
	fromT: string | undefined,
	toT: string | undefined,
): Record<string, unknown>[] {
	if (!fromT && !toT) return entries;
	const from = fromT !== undefined ? new Date(fromT).getTime() : undefined;
	const to = toT !== undefined ? new Date(toT).getTime() : undefined;
	return entries.filter((e) => {
		const ts = e.ts;
		if (typeof ts !== "string") return true;
		const t = new Date(ts).getTime();
		if (Number.isNaN(t)) return true;
		if (from !== undefined && t < from) return false;
		if (to !== undefined && t > to) return false;
		return true;
	});
}

/**
 * Filter entries by case-insensitive substring match in the `msg` field.
 */
function filterBySearch(
	entries: Record<string, unknown>[],
	search: string | undefined,
): Record<string, unknown>[] {
	if (!search) return entries;
	const lower = search.toLowerCase();
	return entries.filter((e) => {
		const msg = e.msg;
		return typeof msg === "string" && msg.toLowerCase().includes(lower);
	});
}

// ─── Route registration ───────────────────────────────────────────────────────

export async function registerLogRoutes(app: FastifyInstance, logsDir: string): Promise<void> {
	// GET /api/logs/channels/:channelId
	app.get<{ Params: { channelId: string }; Querystring: LogQueryParams }>(
		"/api/logs/channels/:channelId",
		async (request, reply) => {
			const { channelId } = request.params;

			// Path traversal protection: channelId must be 26 alphanumeric chars
			if (!CHANNEL_ID_RE.test(channelId)) {
				return reply.code(400).send({
					error: {
						code: "INVALID_CHANNEL_ID",
						message: "channelId must be 26 alphanumeric characters",
					},
				});
			}

			const { level, from_t, to_t, search } = request.query;

			const paging = parsePagination(request.query);
			if (!paging.ok) return reply.code(400).send({ error: paging.error });
			const { limit = LOG_PAGE_SIZE, offset } = paging;

			const filePath = path.join(logsDir, "channels", `${channelId}.jsonl`);
			let entries = await readJsonl(filePath);

			entries = filterByLevel(entries, level);
			entries = filterChannelByTime(entries, from_t, to_t);
			entries = filterBySearch(entries, search);

			const total = entries.length;
			const page = entries.slice(offset, offset + limit);

			return { entries: page, total };
		},
	);

	// GET /api/logs/hub
	app.get<{ Querystring: LogQueryParams }>("/api/logs/hub", async (request, reply) => {
		const { level, from_t, to_t, search } = request.query;

		const paging = parsePagination(request.query);
		if (!paging.ok) return reply.code(400).send({ error: paging.error });
		const { limit = LOG_PAGE_SIZE, offset } = paging;

		const filePath = path.join(logsDir, "hub.jsonl");
		let entries = await readJsonl(filePath);

		entries = filterByLevel(entries, level);
		entries = filterHubByTime(entries, from_t, to_t);
		entries = filterBySearch(entries, search);

		const total = entries.length;
		const page = entries.slice(offset, offset + limit);

		return { entries: page, total };
	});
}
