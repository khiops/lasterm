import { timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentRoutes } from "./api/agents.js";
import { tokensEqual } from "./auth.js";

// Every call still reaches the real timingSafeEqual; the spy only says whether
// a comparison went through it.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

/**
 * CLAUDE.md: a token is compared in constant time. A plain `===` stops at the
 * first character that differs, so how long it takes tells a guesser how much of
 * the token was right (#514). The hub's one comparison is `tokensEqual`; a plain
 * equality on a secret's name in a hub source is refused by the linter
 * (lint/no-plain-secret-comparison.grit).
 */

const PRIMARY_TOKEN = "5a".repeat(32);
const HUB_VERSION = "0.4.1";

let server: FastifyInstance | null = null;

afterEach(async () => {
	await server?.close();
	server = null;
	vi.mocked(timingSafeEqual).mockClear();
});

describe("tokensEqual", () => {
	it("accepts the token expected, and refuses one wrong only in its last character", () => {
		expect(tokensEqual(PRIMARY_TOKEN, "5a".repeat(32))).toBe(true);
		expect(tokensEqual(`${PRIMARY_TOKEN.slice(0, -1)}b`, PRIMARY_TOKEN)).toBe(false);
	});

	it("refuses a token of another length without throwing, bytes counted rather than characters", () => {
		expect(tokensEqual("", PRIMARY_TOKEN)).toBe(false);
		expect(tokensEqual(PRIMARY_TOKEN.slice(0, -1), PRIMARY_TOKEN)).toBe(false);
		expect(tokensEqual(`${PRIMARY_TOKEN}0`, PRIMARY_TOKEN)).toBe(false);
		// As many characters as the token, twice as many bytes: timingSafeEqual
		// throws on buffers of different sizes.
		expect(tokensEqual("é".repeat(64), PRIMARY_TOKEN)).toBe(false);
	});
});

describe("the primary token on the agent routes (#514)", () => {
	function startAgentRoutes(): FastifyInstance {
		const app = Fastify({ logger: false });
		// No token store: the primary token is all the routes can check against.
		// The cache is only listed, and a directory that is not there lists empty.
		registerAgentRoutes(app, {
			authToken: PRIMARY_TOKEN,
			getBinaryCacheDir: () => join(tmpdir(), "lasterm-token-comparison-no-cache"),
			hubVersion: HUB_VERSION,
			hubPlatform: { os: "linux", arch: "x64" },
			resolveAgentBinaryPath: () => null,
			versionReader: () => HUB_VERSION,
		});
		server = app;
		return app;
	}

	it("is compared with timingSafeEqual, whether the guess is right or wrong", async () => {
		const app = startAgentRoutes();
		const request = (token: string) =>
			app.inject({
				method: "GET",
				url: "/api/agents/targets",
				headers: { authorization: `Bearer ${token}` },
			});

		const wrong = await request(`${PRIMARY_TOKEN.slice(0, -1)}b`);
		expect(wrong.statusCode).toBe(401);
		expect(timingSafeEqual).toHaveBeenCalledTimes(1);

		const right = await request(PRIMARY_TOKEN);
		expect(right.statusCode).toBe(200);
		expect(timingSafeEqual).toHaveBeenCalledTimes(2);
	});
});
