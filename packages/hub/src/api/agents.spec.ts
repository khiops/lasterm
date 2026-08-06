import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fastifyMultipart from "@fastify/multipart";
import type {
	AgentFetchDoneMessage,
	AgentFetchErrorMessage,
	AgentFetchProgressMessage,
} from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_FETCH_MAX_BYTES, AGENT_TARGET_TRIPLES } from "../session/agent-cache.js";
import type { AgentFetchImpl } from "../session/agent-fetch.js";
import type { AgentTargetArch, AgentTargetOs, HubPlatform } from "../session/agent-status.js";
import { registerAgentRoutes } from "./agents.js";

const TEST_TOKEN = "a".repeat(64);
const HUB_VERSION = "0.4.1";
const HUB_PLATFORM = { os: "linux", arch: "x64" } as const satisfies HubPlatform;
const BUNDLED_PATH = "/tmp/lasterm-agent-api-test";
const DEFAULT_RELEASE_BASE_URL = "https://github.com/khiops/lasterm";

type AgentTargetEntry = {
	readonly triple: string | null;
	readonly ext: "" | ".exe";
	readonly built: boolean;
};

type AgentFetchMessage = AgentFetchProgressMessage | AgentFetchDoneMessage | AgentFetchErrorMessage;

const AGENT_TARGET_TABLE = AGENT_TARGET_TRIPLES as Record<
	AgentTargetOs,
	Record<AgentTargetArch, AgentTargetEntry>
>;

let server: FastifyInstance | null = null;
let tempDirs: string[] = [];

afterEach(async () => {
	if (server) await server.close();
	server = null;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("GET /api/agents/targets", () => {
	it("requires Bearer auth at the route level without global daemon auth", async () => {
		const cacheDir = makeTempDir();
		let statusReads = 0;
		server = Fastify({ logger: false });
		registerAgentRoutes(server, {
			authToken: TEST_TOKEN,
			getBinaryCacheDir: () => {
				statusReads++;
				return cacheDir;
			},
		});

		const missing = await server.inject({ method: "GET", url: "/api/agents/targets" });
		const wrong = await server.inject({
			method: "GET",
			url: "/api/agents/targets",
			headers: { authorization: `Bearer ${"b".repeat(64)}` },
		});

		expect(missing.statusCode).toBe(401);
		expect(missing.json().error).toEqual({
			code: "AUTH_REQUIRED",
			message: "Authorization header required",
		});
		expect(wrong.statusCode).toBe(401);
		expect(wrong.json().error.code).toBe("AUTH_INVALID");
		expect(statusReads).toBe(0);
	});

	it("rejects all Bearer tokens when no route auth token is configured", async () => {
		server = Fastify({ logger: false });
		registerAgentRoutes(server);

		const res = await server.inject({
			method: "GET",
			url: "/api/agents/targets",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});

		expect(res.statusCode).toBe(401);
		expect(res.json().error.code).toBe("AUTH_INVALID");
	});

	it("returns the SC-01 target status shape for an authorized request", async () => {
		const cacheDir = makeTempDir();
		writeFileSync(agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION), "agent");
		server = Fastify({ logger: false });
		registerAgentRoutes(server, {
			authToken: TEST_TOKEN,
			getBinaryCacheDir: () => cacheDir,
			hubVersion: HUB_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => BUNDLED_PATH,
			versionReader: () => HUB_VERSION,
		});

		const res = await server.inject({
			method: "GET",
			url: "/api/agents/targets",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.hub_version).toBe(HUB_VERSION);
		expect(body.targets).toHaveLength(6);
		expect(targetStatus(body, "linux", "x64")).toBe("bundled");
		expect(targetStatus(body, "linux", "arm64")).toBe("cached");
		expect(targetStatus(body, "windows", "x64")).toBe("missing");
		expect(targetStatus(body, "windows", "arm64")).toBe("unsupported");
		expect(targetStatus(body, "darwin", "x64")).toBe("unsupported");
		expect(targetStatus(body, "darwin", "arm64")).toBe("unsupported");
	});
});

describe("POST /api/agents/fetch", () => {
	it("SC-05 streams progress, completes, and makes /targets show cached", async () => {
		const cacheDir = makeTempDir();
		const messages: AgentFetchMessage[] = [];
		const assetBody = "linux-arm64-agent";
		const { fetchImpl } = agentAssetFetch("linux", "arm64", HUB_VERSION, assetBody);
		server = makeAgentRouteServer(cacheDir, { fetchImpl, messages });

		const res = await postFetch({ os: "linux", arch: "arm64" });

		expect(res.statusCode).toBe(202);
		const jobId = res.json().job_id as string;
		expect(jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(res.json().snapshot).toMatchObject({
			os: "linux",
			arch: "arm64",
			downloaded: 0,
			phase: "download",
		});

		await waitForMessage<AgentFetchProgressMessage>(
			messages,
			(msg): msg is AgentFetchProgressMessage =>
				msg.type === "AGENT_FETCH_PROGRESS" && msg.jobId === jobId,
		);
		const done = await waitForMessage<AgentFetchDoneMessage>(
			messages,
			(msg): msg is AgentFetchDoneMessage => msg.type === "AGENT_FETCH_DONE" && msg.jobId === jobId,
		);
		expect(done.path).toBe(agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION));

		const targets = await server!.inject({
			method: "GET",
			url: "/api/agents/targets",
			headers: authHeaders(),
		});
		expect(targets.statusCode).toBe(200);
		expect(targetStatus(targets.json(), "linux", "arm64")).toBe("cached");
	});

	it("sends the 202 response before starting the fetch job", async () => {
		const cacheDir = makeTempDir();
		const messages: AgentFetchMessage[] = [];
		const assetBody = "linux-arm64-agent";
		const { fetchImpl: upstreamFetchImpl } = agentAssetFetch(
			"linux",
			"arm64",
			HUB_VERSION,
			assetBody,
		);
		let responseReturned = false;
		let startedBeforeResponse = false;
		const fetchImpl = vi.fn<AgentFetchImpl>(async (url, init) => {
			if (!responseReturned) startedBeforeResponse = true;
			return upstreamFetchImpl(url, init);
		});
		server = makeAgentRouteServer(cacheDir, { fetchImpl, messages });

		const res = await postFetch({ os: "linux", arch: "arm64" });
		responseReturned = true;

		expect(res.statusCode).toBe(202);
		const jobId = res.json().job_id as string;
		await waitForMessage<AgentFetchDoneMessage>(
			messages,
			(msg): msg is AgentFetchDoneMessage => msg.type === "AGENT_FETCH_DONE" && msg.jobId === jobId,
		);
		expect(startedBeforeResponse).toBe(false);
	});

	it("SC-06 rejects an unsupported target before any network call", async () => {
		const cacheDir = makeTempDir();
		const fetchImpl = vi.fn<AgentFetchImpl>();
		server = makeAgentRouteServer(cacheDir, { fetchImpl });

		const res = await postFetch({ os: "darwin", arch: "arm64" });

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("UNSUPPORTED_TARGET");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("SC-24 rejects fetches for the hub platform before any network call", async () => {
		const cacheDir = makeTempDir();
		const fetchImpl = vi.fn<AgentFetchImpl>();
		server = makeAgentRouteServer(cacheDir, { fetchImpl });

		const res = await postFetch({ os: "linux", arch: "x64" });

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("BUNDLED_TARGET");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("SC-07 broadcasts a verbatim NETWORK FetchError message on connectivity failure", async () => {
		const cacheDir = makeTempDir();
		const messages: AgentFetchMessage[] = [];
		const fetchImpl = vi.fn<AgentFetchImpl>(async () => {
			throw new Error("offline");
		});
		server = makeAgentRouteServer(cacheDir, { fetchImpl, messages });

		const res = await postFetch({ os: "linux", arch: "arm64" });

		expect(res.statusCode).toBe(202);
		const jobId = res.json().job_id as string;
		const error = await waitForMessage<AgentFetchErrorMessage>(
			messages,
			(msg): msg is AgentFetchErrorMessage =>
				msg.type === "AGENT_FETCH_ERROR" && msg.jobId === jobId,
		);
		expect(error.code).toBe("NETWORK");
		expect(error.message).toBe(
			`Network error while downloading ${versionedAssetUrl("linux", "arm64", HUB_VERSION)}: offline. Retry the agent fetch, or manually download the asset and rename it to ${agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION)}; Node fetch does not honor proxy environment variables here.`,
		);
	});

	it("SC-17 returns already_cached for a trusted current cache hit without starting a job", async () => {
		const cacheDir = makeTempDir();
		const cachedPath = agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION);
		writeFileSync(cachedPath, "cached-agent");
		chmodSync(cachedPath, 0o755);
		const messages: AgentFetchMessage[] = [];
		const fetchImpl = vi.fn<AgentFetchImpl>();
		server = makeAgentRouteServer(cacheDir, { fetchImpl, messages });

		const res = await postFetch({ os: "linux", arch: "arm64" });

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: "already_cached" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(messages).toEqual([]);
	});

	it("SC-20 collapses concurrent duplicate fetches for one target into one job", async () => {
		const cacheDir = makeTempDir();
		const messages: AgentFetchMessage[] = [];
		const assetBody = "deduped-agent";
		const assetUrl = versionedAssetUrl("linux", "arm64", HUB_VERSION);
		const assetName = versionedAssetName("linux", "arm64", HUB_VERSION);
		let resolveAsset: ((response: Response) => void) | null = null;
		const pendingAsset = new Promise<Response>((resolve) => {
			resolveAsset = resolve;
		});
		let assetDownloads = 0;
		const fetchImpl = vi.fn<AgentFetchImpl>(async (url) => {
			if (url === assetUrl) {
				assetDownloads++;
				return pendingAsset;
			}
			if (url === checksumUrl(HUB_VERSION)) return response(sums(assetName, assetBody));
			throw new Error(`unexpected URL ${url}`);
		});
		server = makeAgentRouteServer(cacheDir, { fetchImpl, messages });

		const first = postFetch({ os: "linux", arch: "arm64" });
		const second = postFetch({ os: "linux", arch: "arm64" });
		const [firstRes, secondRes] = await Promise.all([first, second]);

		expect(firstRes.statusCode).toBe(202);
		expect(secondRes.statusCode).toBe(202);
		expect(secondRes.json().job_id).toBe(firstRes.json().job_id);
		await waitForCondition(
			() => assetDownloads === 1,
			"Timed out waiting for deduped asset download to start",
		);
		expect(assetDownloads).toBe(1);

		resolveAsset?.(
			response(assetBody, { headers: { "content-length": String(assetBody.length) } }),
		);
		const done = await waitForMessage<AgentFetchDoneMessage>(
			messages,
			(msg): msg is AgentFetchDoneMessage =>
				msg.type === "AGENT_FETCH_DONE" && msg.jobId === firstRes.json().job_id,
		);
		expect(done.path).toBe(agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION));
		expect(listCache(cacheDir).filter((name) => name === path.basename(done.path))).toHaveLength(1);
	});

	it("keeps concurrent fetches for different versions of one target in distinct jobs", async () => {
		const cacheDir = makeTempDir();
		const messages: AgentFetchMessage[] = [];
		const otherVersion = "0.4.2";
		const currentAssetBody = "linux-arm64-current-agent";
		const otherAssetBody = "linux-arm64-other-agent";
		const currentAsset = deferredResponse();
		const otherAsset = deferredResponse();
		let currentDownloads = 0;
		let otherDownloads = 0;
		const fetchImpl = vi.fn<AgentFetchImpl>(async (url) => {
			if (url === versionedAssetUrl("linux", "arm64", HUB_VERSION)) {
				currentDownloads++;
				return currentAsset.promise;
			}
			if (url === versionedAssetUrl("linux", "arm64", otherVersion)) {
				otherDownloads++;
				return otherAsset.promise;
			}
			if (url === checksumUrl(HUB_VERSION)) {
				return response(sums(versionedAssetName("linux", "arm64", HUB_VERSION), currentAssetBody));
			}
			if (url === checksumUrl(otherVersion)) {
				return response(sums(versionedAssetName("linux", "arm64", otherVersion), otherAssetBody));
			}
			throw new Error(`unexpected URL ${url}`);
		});
		server = makeAgentRouteServer(cacheDir, { fetchImpl, messages });

		const current = postFetch({ os: "linux", arch: "arm64", version: HUB_VERSION });
		const other = postFetch({ os: "linux", arch: "arm64", version: otherVersion });
		const [currentRes, otherRes] = await Promise.all([current, other]);

		expect(currentRes.statusCode).toBe(202);
		expect(otherRes.statusCode).toBe(202);
		expect(otherRes.json().job_id).not.toBe(currentRes.json().job_id);
		await waitForCondition(
			() => currentDownloads === 1 && otherDownloads === 1,
			"Timed out waiting for versioned asset downloads to start",
		);
		expect(currentDownloads).toBe(1);
		expect(otherDownloads).toBe(1);

		currentAsset.resolve(
			response(currentAssetBody, {
				headers: { "content-length": String(currentAssetBody.length) },
			}),
		);
		otherAsset.resolve(
			response(otherAssetBody, {
				headers: { "content-length": String(otherAssetBody.length) },
			}),
		);
		const currentDone = await waitForMessage<AgentFetchDoneMessage>(
			messages,
			(msg): msg is AgentFetchDoneMessage =>
				msg.type === "AGENT_FETCH_DONE" && msg.jobId === currentRes.json().job_id,
		);
		const otherDone = await waitForMessage<AgentFetchDoneMessage>(
			messages,
			(msg): msg is AgentFetchDoneMessage =>
				msg.type === "AGENT_FETCH_DONE" && msg.jobId === otherRes.json().job_id,
		);

		expect(currentDone.path).toBe(agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION));
		expect(otherDone.path).toBe(agentCachePath(cacheDir, "linux", "arm64", otherVersion));
		expect(readFileSync(currentDone.path, "utf8")).toBe(currentAssetBody);
		expect(readFileSync(otherDone.path, "utf8")).toBe(otherAssetBody);
		expect(listCache(cacheDir)).toEqual(
			[path.basename(currentDone.path), path.basename(otherDone.path)].sort(),
		);
	});
});

describe("POST /api/agents/prune", () => {
	it("SC-08 removes non-current versions and keeps the current one", async () => {
		const cacheDir = makeTempDir();
		const current = agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION);
		const stale = agentCachePath(cacheDir, "linux", "arm64", "0.3.4");
		writeFileSync(current, "current");
		writeFileSync(stale, "stale");
		server = makeAgentRouteServer(cacheDir);

		const res = await postPrune({});

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ removed: 1 });
		expect(existsSync(current)).toBe(true);
		expect(existsSync(stale)).toBe(false);
	});
});

describe("POST /api/agents/import", () => {
	it("SC-10 verifies and caches a matching attested import with mode 755", async () => {
		const cacheDir = makeTempDir();
		const version = "0.4.2";
		const binary = "windows-agent";
		const assetName = versionedAssetName("windows", "x64", version);
		server = makeAgentRouteServer(cacheDir);

		const res = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary,
			manifest: sums(assetName, binary),
		});

		const finalPath = agentCachePath(cacheDir, "windows", "x64", version);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ path: finalPath, version, verified: true });
		expect(readFileSync(finalPath, "utf8")).toBe(binary);
		expect(statSync(finalPath).mode & 0o777).toBe(0o755);
		expect(listTempFiles(cacheDir)).toEqual([]);
	});

	it("accepts a valid import when the binary part arrives before the fields", async () => {
		const cacheDir = makeTempDir();
		const version = "0.4.2";
		const binary = "windows-agent";
		const assetName = versionedAssetName("windows", "x64", version);
		server = makeAgentRouteServer(cacheDir);

		const res = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary,
			manifest: sums(assetName, binary),
			binaryFirst: true,
		});

		const finalPath = agentCachePath(cacheDir, "windows", "x64", version);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ path: finalPath, version, verified: true });
		expect(readFileSync(finalPath, "utf8")).toBe(binary);
		expect(listTempFiles(cacheDir)).toEqual([]);
	});

	it("SC-11 rejects a mismatched hash and leaves no cached binary or temp file", async () => {
		const cacheDir = makeTempDir();
		const version = "0.4.2";
		const assetName = versionedAssetName("windows", "x64", version);
		server = makeAgentRouteServer(cacheDir);

		const res = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary: "corrupt",
			manifest: sums(assetName, "expected"),
		});

		expect(res.statusCode).toBe(422);
		expect(res.json().error.code).toBe("CHECKSUM_MISMATCH");
		expect(existsSync(agentCachePath(cacheDir, "windows", "x64", version))).toBe(false);
		expect(listTempFiles(cacheDir)).toEqual([]);
	});

	it("SC-12 rejects a manifest with no expected entry", async () => {
		const cacheDir = makeTempDir();
		const version = "0.4.2";
		server = makeAgentRouteServer(cacheDir);

		const res = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary: "agent",
			manifest: sums("other-file", "agent"),
		});

		expect(res.statusCode).toBe(422);
		expect(res.json().error.code).toBe("CHECKSUM_MISSING");
		expect(existsSync(agentCachePath(cacheDir, "windows", "x64", version))).toBe(false);
		expect(listTempFiles(cacheDir)).toEqual([]);
	});

	it("SC-13 rejects oversized and surplus-part imports without orphan temps", async () => {
		const oversizedCacheDir = makeTempDir();
		const version = "0.4.2";
		const assetName = versionedAssetName("windows", "x64", version);
		server = makeAgentRouteServer(oversizedCacheDir);

		const oversized = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary: Buffer.alloc(AGENT_FETCH_MAX_BYTES + 1),
			manifest: sums(assetName, "unused"),
		});

		expect(oversized.statusCode).toBe(413);
		expect(existsSync(agentCachePath(oversizedCacheDir, "windows", "x64", version))).toBe(false);
		expect(listTempFiles(oversizedCacheDir)).toEqual([]);

		await server!.close();
		server = null;
		const surplusCacheDir = makeTempDir();
		server = makeAgentRouteServer(surplusCacheDir);

		const surplus = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary: "agent",
			manifest: sums(assetName, "agent"),
			extraFiles: [{ fieldname: "extra", filename: "extra.bin", content: "extra" }],
		});

		expect(surplus.statusCode).toBe(400);
		expect(surplus.json().error.code).toBe("BAD_MULTIPART");
		expect(existsSync(agentCachePath(surplusCacheDir, "windows", "x64", version))).toBe(false);
		expect(listTempFiles(surplusCacheDir)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"SC-14 maps an insecure cache dir to INSECURE_CACHE_DIR and places nothing",
		async () => {
			const realDir = makeTempDir();
			const linkParent = makeTempDir();
			const linkDir = path.join(linkParent, "agent-cache-link");
			symlinkSync(realDir, linkDir);
			const version = "0.4.2";
			const binary = "agent";
			const assetName = versionedAssetName("windows", "x64", version);
			server = makeAgentRouteServer(linkDir);

			const res = await postImport({
				fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
				binary,
				manifest: sums(assetName, binary),
			});

			expect(res.statusCode).toBe(409);
			expect(res.json().error.code).toBe("INSECURE_CACHE_DIR");
			expect(existsSync(agentCachePath(realDir, "windows", "x64", version))).toBe(false);
			expect(listTempFiles(realDir)).toEqual([]);
		},
	);

	it("SC-18 rejects bad target/version without placing cache entries", async () => {
		const cacheDir = makeTempDir();
		server = makeAgentRouteServer(cacheDir);

		const unsupported = await postImport({
			fields: importFields({
				os: "darwin",
				arch: "arm64",
				version: "0.4.2",
				attested: "true",
			}),
			binary: "agent",
			manifest: sums("unused", "agent"),
		});
		const badVersion = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version: "0.0.0", attested: "true" }),
			binary: "agent",
			manifest: sums("unused", "agent"),
		});
		const bundled = await postImport({
			fields: importFields({ os: "linux", arch: "x64", version: "0.4.2", attested: "true" }),
			binary: "agent",
			manifest: sums("unused", "agent"),
		});

		expect(unsupported.statusCode).toBe(400);
		expect(unsupported.json().error.code).toBe("UNSUPPORTED_TARGET");
		expect(badVersion.statusCode).toBe(400);
		expect(badVersion.json().error.code).toBe("BAD_VERSION");
		expect(bundled.statusCode).toBe(400);
		expect(bundled.json().error.code).toBe("BUNDLED_TARGET");
		expect(listCache(cacheDir)).toEqual([]);
	});

	it("SC-22 rejects imports without explicit attestation without placing cache entries", async () => {
		const cacheDir = makeTempDir();
		server = makeAgentRouteServer(cacheDir);
		const version = "0.4.2";
		const assetName = versionedAssetName("windows", "x64", version);

		const res = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version }),
			binary: "agent",
			manifest: sums(assetName, "agent"),
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error.code).toBe("ATTESTATION_REQUIRED");
		expect(listCache(cacheDir)).toEqual([]);
	});

	it("rejects binary-first invalid fields and removes the temporary import", async () => {
		const cacheDir = makeTempDir();
		const version = "0.4.2";
		const assetName = versionedAssetName("windows", "x64", version);
		server = makeAgentRouteServer(cacheDir);

		const unsupported = await postImport({
			fields: importFields({
				os: "darwin",
				arch: "arm64",
				version,
				attested: "true",
			}),
			binary: "agent",
			manifest: sums("unused", "agent"),
			binaryFirst: true,
		});
		const missingAttestation = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version }),
			binary: "agent",
			manifest: sums(assetName, "agent"),
			binaryFirst: true,
		});

		expect(unsupported.statusCode).toBe(400);
		expect(unsupported.json().error.code).toBe("UNSUPPORTED_TARGET");
		expect(missingAttestation.statusCode).toBe(400);
		expect(missingAttestation.json().error.code).toBe("ATTESTATION_REQUIRED");
		expect(existsSync(agentCachePath(cacheDir, "windows", "x64", version))).toBe(false);
		expect(listCache(cacheDir)).toEqual([]);
	});

	it("SC-25 rejects disallowed browser Origin but allows no-Origin Bearer requests", async () => {
		const cacheDir = makeTempDir();
		const version = "0.4.2";
		const binary = "agent";
		const assetName = versionedAssetName("windows", "x64", version);
		server = makeAgentRouteServer(cacheDir);

		const blocked = await postImport(
			{
				fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
				binary,
				manifest: sums(assetName, binary),
			},
			{ origin: "https://evil.example", host: "127.0.0.1:4100" },
		);

		expect(blocked.statusCode).toBe(403);
		expect(blocked.json().error.code).toBe("ORIGIN_FORBIDDEN");

		const allowed = await postImport({
			fields: importFields({ os: "windows", arch: "x64", version, attested: "true" }),
			binary,
			manifest: sums(assetName, binary),
		});

		expect(allowed.statusCode).toBe(200);
		expect(existsSync(agentCachePath(cacheDir, "windows", "x64", version))).toBe(true);
	});

	it("SC-27 refuses to overwrite a trusted current binary without force", async () => {
		const cacheDir = makeTempDir();
		const existing = agentCachePath(cacheDir, "windows", "x64", HUB_VERSION);
		writeFileSync(existing, "existing");
		chmodSync(existing, 0o755);
		const assetName = versionedAssetName("windows", "x64", HUB_VERSION);
		server = makeAgentRouteServer(cacheDir);

		const res = await postImport({
			fields: importFields({
				os: "windows",
				arch: "x64",
				version: HUB_VERSION,
				attested: "true",
			}),
			binary: "replacement",
			manifest: sums(assetName, "replacement"),
		});

		expect(res.statusCode).toBe(409);
		expect(res.json().error.code).toBe("ALREADY_CURRENT");
		expect(readFileSync(existing, "utf8")).toBe("existing");
		expect(listTempFiles(cacheDir)).toEqual([]);
	});
});

function targetStatus(
	body: { targets: Array<{ os: string; arch: string; status: string }> },
	os: AgentTargetOs,
	arch: AgentTargetArch,
): string {
	const target = body.targets.find((row) => row.os === os && row.arch === arch);
	expect(target).toBeDefined();
	return target!.status;
}

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lasterm-api-agents-"));
	chmodSync(dir, 0o700);
	tempDirs.push(dir);
	return dir;
}

function makeAgentRouteServer(
	cacheDir: string,
	opts: {
		readonly fetchImpl?: AgentFetchImpl;
		readonly messages?: AgentFetchMessage[];
		readonly getBinaryCacheDir?: () => string;
	} = {},
): FastifyInstance {
	const instance = Fastify({ logger: false });
	void instance.register(fastifyMultipart, { limits: { fileSize: AGENT_FETCH_MAX_BYTES } });
	registerAgentRoutes(instance, {
		authToken: TEST_TOKEN,
		getBinaryCacheDir: opts.getBinaryCacheDir ?? (() => cacheDir),
		hubVersion: HUB_VERSION,
		hubPlatform: HUB_PLATFORM,
		resolveAgentBinaryPath: () => BUNDLED_PATH,
		versionReader: () => HUB_VERSION,
		...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
		broadcastAgentFetchMessage: (message) => {
			opts.messages?.push(message);
		},
	});
	return instance;
}

function postFetch(payload: unknown) {
	return server!.inject({
		method: "POST",
		url: "/api/agents/fetch",
		headers: authHeaders(),
		payload,
	});
}

function postPrune(payload: unknown) {
	return server!.inject({
		method: "POST",
		url: "/api/agents/prune",
		headers: authHeaders(),
		payload,
	});
}

function postImport(
	args: {
		readonly fields: Record<string, string>;
		readonly binary: Buffer | string;
		readonly manifest: Buffer | string;
		readonly extraFiles?: Array<{
			readonly fieldname: string;
			readonly filename: string;
			readonly content: Buffer | string;
		}>;
		readonly binaryFirst?: boolean;
	},
	extraHeaders: Record<string, string> = {},
) {
	const { payload, headers } = buildAgentImportMultipart(args);
	return server!.inject({
		method: "POST",
		url: "/api/agents/import",
		headers: { ...headers, ...extraHeaders },
		payload,
	});
}

function authHeaders(): { authorization: string } {
	return { authorization: `Bearer ${TEST_TOKEN}` };
}

function agentCachePath(
	cacheDir: string,
	osName: AgentTargetOs,
	arch: AgentTargetArch,
	version: string,
): string {
	const target = AGENT_TARGET_TABLE[osName][arch];
	return path.join(cacheDir, `lasterm-agent-${osName}-${arch}-${version}${target.ext}`);
}

function agentAssetFetch(
	osName: AgentTargetOs,
	arch: AgentTargetArch,
	version: string,
	body: string,
): { fetchImpl: AgentFetchImpl } {
	const assetUrl = versionedAssetUrl(osName, arch, version);
	const assetName = versionedAssetName(osName, arch, version);
	const fetchImpl = vi.fn<AgentFetchImpl>(async (url) => {
		if (url === assetUrl) {
			return response(body, { headers: { "content-length": String(body.length) } });
		}
		if (url === checksumUrl(version)) return response(sums(assetName, body));
		throw new Error(`unexpected URL ${url}`);
	});
	return { fetchImpl };
}

function versionedAssetName(osName: AgentTargetOs, arch: AgentTargetArch, version: string): string {
	const target = AGENT_TARGET_TABLE[osName][arch];
	if (!target.triple) throw new Error(`unsupported test target ${osName}/${arch}`);
	return `lasterm-agent-${target.triple}-${version}${target.ext}`;
}

function versionedAssetUrl(osName: AgentTargetOs, arch: AgentTargetArch, version: string): string {
	return `${DEFAULT_RELEASE_BASE_URL}/releases/download/v${version}/${versionedAssetName(osName, arch, version)}`;
}

function checksumUrl(version: string): string {
	return `${DEFAULT_RELEASE_BASE_URL}/releases/download/v${version}/SHA256SUMS-${version}.txt`;
}

function response(
	body: BodyInit | null,
	init: { readonly status?: number; readonly headers?: HeadersInit } = {},
): Response {
	return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

function deferredResponse(): {
	readonly promise: Promise<Response>;
	readonly resolve: (response: Response) => void;
} {
	let resolveResponse: (response: Response) => void = () => {};
	const promise = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	return { promise, resolve: resolveResponse };
}

function sums(assetName: string, body: string): string {
	return `${createHash("sha256").update(body).digest("hex")}  ${assetName}\n`;
}

function importFields(fields: {
	readonly os: string;
	readonly arch: string;
	readonly version: string;
	readonly attested?: string;
	readonly force?: string;
}): Record<string, string> {
	return Object.fromEntries(
		Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function buildAgentImportMultipart(args: {
	readonly fields: Record<string, string>;
	readonly binary: Buffer | string;
	readonly manifest: Buffer | string;
	readonly extraFiles?: Array<{
		readonly fieldname: string;
		readonly filename: string;
		readonly content: Buffer | string;
	}>;
	readonly binaryFirst?: boolean;
}): { readonly payload: Buffer; readonly headers: Record<string, string> } {
	const boundary = `----LastermAgentImport${Math.random().toString(16).slice(2)}`;
	const parts: Buffer[] = [];
	const pushFields = () => {
		for (const [name, value] of Object.entries(args.fields)) {
			parts.push(
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
				),
			);
		}
	};
	if (args.binaryFirst) {
		pushFilePart(parts, boundary, "binary", "lasterm-agent", args.binary);
		pushFields();
	} else {
		pushFields();
		pushFilePart(parts, boundary, "binary", "lasterm-agent", args.binary);
	}
	pushFilePart(parts, boundary, "manifest", "SHA256SUMS.txt", args.manifest);
	for (const extra of args.extraFiles ?? []) {
		pushFilePart(parts, boundary, extra.fieldname, extra.filename, extra.content);
	}
	parts.push(Buffer.from(`--${boundary}--\r\n`));
	return {
		payload: Buffer.concat(parts),
		headers: {
			...authHeaders(),
			"content-type": `multipart/form-data; boundary=${boundary}`,
		},
	};
}

function pushFilePart(
	parts: Buffer[],
	boundary: string,
	fieldname: string,
	filename: string,
	content: Buffer | string,
): void {
	const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		),
	);
	parts.push(body);
	parts.push(Buffer.from("\r\n"));
}

function listCache(cacheDir: string): string[] {
	return readdirSync(cacheDir)
		.filter((name) => !name.startsWith("SHA256SUMS-"))
		.sort();
}

function listTempFiles(cacheDir: string): string[] {
	return readdirSync(cacheDir)
		.filter((name) => name.endsWith(".tmp"))
		.sort();
}

async function waitForMessage<T extends AgentFetchMessage>(
	messages: AgentFetchMessage[],
	predicate: (message: AgentFetchMessage) => message is T,
): Promise<T> {
	const deadline = Date.now() + 1_000;
	for (;;) {
		const found = messages.find(predicate);
		if (found) return found;
		if (Date.now() >= deadline) throw new Error("Timed out waiting for agent fetch message");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMessage: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	for (;;) {
		if (predicate()) return;
		if (Date.now() >= deadline) throw new Error(timeoutMessage);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
