import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
 * the token was right (#514). The hub's one comparison is `tokensEqual`.
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

// ─── A plain comparison does not come back ────────────────────────────────────

/** A name that holds a secret. */
const SECRET_NAME = /(?:token|secret|password|passphrase)$/i;
/** What a secret may be compared with plainly: nothing, or a constant. */
const NOT_A_SECRET = /^(?:null|undefined|true|false|\d+)$/;
/**
 * `a === b`, `a !== b` and their loose forms, where each side is a name or a
 * member chain. Neither side is cut out of a longer name, and the right one is
 * not a function being called: `hashToken(token)` is not a token.
 */
const EQUALITY =
	/(?<![\w$.?])([\w$][\w$]*(?:\??\.[\w$]+)*)\s*(?:===|!==|==|!=)\s*([\w$][\w$]*(?:\??\.[\w$]+)*)(?![\w$(]|\s*\()/g;

/**
 * Plain equalities that weigh no guess, by file and text, each with the reason.
 * Timing only leaks to whoever supplies one side; here the hub supplies both.
 */
const NO_GUESS_COMPARED = new Map([
	[
		"cli.ts: current.ownerToken === expected.ownerToken",
		"runtimeMatches: two runtime records the hub wrote itself, to tell whether runtime.json is still this hub's",
	],
]);

function lastName(operand: string): string {
	return operand.split(/\??\./).pop() ?? operand;
}

/** Each plain equality in `source` that has a secret on one side and not a constant on the other. */
function plainSecretComparisons(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
	const found: string[] = [];
	for (const match of code.matchAll(EQUALITY)) {
		const [text, left = "", right = ""] = match;
		const secretCompared =
			(SECRET_NAME.test(lastName(left)) && !NOT_A_SECRET.test(right)) ||
			(SECRET_NAME.test(lastName(right)) && !NOT_A_SECRET.test(left));
		if (secretCompared) found.push(text);
	}
	return found;
}

function hubSources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) return hubSources(file);
		const isTestOnly = /\.(?:spec|fixture|setup)\.ts$/.test(entry.name);
		return entry.name.endsWith(".ts") && !isTestOnly ? [file] : [];
	});
}

describe("no hub source compares a token with a plain equality", () => {
	it("finds none, and would find the one #514 removed", () => {
		// The pattern this guards against, as it stood in api/agents.ts.
		expect(
			plainSecretComparisons(
				"return deps.authToken !== undefined && deps.authToken !== null && token === deps.authToken;",
			),
		).toEqual(["token === deps.authToken"]);
		expect(plainSecretComparisons("if (previous.tokenHash !== hashToken(primaryToken)) {")).toEqual(
			[],
		);

		const root = dirname(fileURLToPath(import.meta.url));
		const found = hubSources(root).flatMap((file) =>
			plainSecretComparisons(readFileSync(file, "utf8")).map(
				(comparison) => `${relative(root, file).replaceAll(sep, "/")}: ${comparison}`,
			),
		);
		const offenders = found.filter((comparison) => !NO_GUESS_COMPARED.has(comparison));
		expect(offenders, "compare tokens with tokensEqual from auth.ts").toEqual([]);
		// An exception whose comparison is gone is removed with it.
		expect(found.filter((comparison) => NO_GUESS_COMPARED.has(comparison))).toEqual([
			...NO_GUESS_COMPARED.keys(),
		]);
	});
});
