import { randomBytes, X509Certificate } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import type { Server as HttpsServer } from "node:https";
import { createServer as createHttpsServer } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createServer as createNetServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { getStateDir, requestHub } from "./cli.js";
import { HUB_TLS_HANDSHAKE_TIMEOUT_MS, HUB_TLS_PIN_MISMATCH_CODE } from "./hub-transport.js";
import { createServer, startServer } from "./server.js";
import { getTestTlsMaterial } from "./test-tls.fixture.js";
import { getHubCertificatePath, resolveHubTlsIdentity } from "./tls-identity.js";

describe("generated hub TLS identity", () => {
	let server: Awaited<ReturnType<typeof createServer>> | undefined;
	let tlsServers: HttpsServer[] = [];
	let stateRoot: string | undefined;
	let originalStateRoot: string | undefined;

	afterEach(async () => {
		if (server) await server.close();
		server = undefined;
		await Promise.all(
			tlsServers.map(
				(tlsServer) =>
					new Promise<void>((resolve, reject) =>
						tlsServer.close((error) => (error ? reject(error) : resolve())),
					),
			),
		);
		tlsServers = [];
		if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
		stateRoot = undefined;
		process.env.XDG_STATE_HOME = originalStateRoot;
	});

	function prepareStateDir(): string {
		originalStateRoot = process.env.XDG_STATE_HOME;
		stateRoot = join(tmpdir(), `lasterm-tls-${randomBytes(8).toString("hex")}`);
		process.env.XDG_STATE_HOME = stateRoot;
		const stateDir = getStateDir();
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		return stateDir;
	}

	async function listenTlsServer(
		identity: { certificate: string; key: string },
		onRequest: (
			request: import("node:http").IncomingMessage,
			response: import("node:http").ServerResponse,
		) => void,
	): Promise<{ port: number; applicationBytes: Buffer[] }> {
		const applicationBytes: Buffer[] = [];
		const tlsServer = createHttpsServer(
			{ cert: identity.certificate, key: identity.key },
			onRequest,
		);
		tlsServer.on("secureConnection", (socket) => {
			socket.on("data", (chunk: Buffer) => applicationBytes.push(Buffer.from(chunk)));
		});
		tlsServers.push(tlsServer);
		await new Promise<void>((resolve, reject) => {
			tlsServer.once("error", reject);
			tlsServer.listen(0, "127.0.0.1", resolve);
		});
		const address = tlsServer.address();
		if (address === null || typeof address === "string")
			throw new Error("TLS listener has no TCP port");
		return { port: address.port, applicationBytes };
	}

	it("serves only through TLS on an OS-assigned port and accepts its pinned key without the stored certificate", async () => {
		const stateDir = prepareStateDir();
		const identity = resolveHubTlsIdentity(stateDir, {});
		unlinkSync(getHubCertificatePath(stateDir));
		server = await createServer({ logger: false, tls: identity.tls });
		server.get("/test/no-content", async (_request, reply) => reply.code(204).send());
		server.get("/test/reset-content", async (_request, reply) => reply.code(205).send());
		server.get("/test/not-modified", async (_request, reply) => reply.code(304).send());
		const address = await startServer(server);
		const port = Number(new URL(address).port);

		expect(new URL(address).protocol).toBe("https:");
		expect(Number.isInteger(port)).toBe(true);
		const response = await requestHub(
			{ pid: process.pid, port, started_at: new Date().toISOString(), spki: identity.spki },
			"/api/health",
		);
		expect(response.ok).toBe(true);
		expect(await response.json()).toMatchObject({ status: "ok" });

		for (const [path, expectedStatus] of [
			["/test/no-content", 204],
			["/test/reset-content", 205],
			["/test/not-modified", 304],
		] as const) {
			const noContent = await requestHub(
				{ pid: process.pid, port, started_at: new Date().toISOString(), spki: identity.spki },
				path,
			);
			expect(noContent.status).toBe(expectedStatus);
			if (expectedStatus !== 304) expect(noContent.ok).toBe(true);
			expect(await noContent.text()).toBe("");
		}

		const head = await requestHub(
			{ pid: process.pid, port, started_at: new Date().toISOString(), spki: identity.spki },
			"/api/health",
			{ method: "HEAD" },
		);
		expect(head.status).toBe(200);
		expect(head.ok).toBe(true);
		expect(await head.text()).toBe("");
	});

	it("accepts a pinned key with an expired certificate", async () => {
		const tls = getTestTlsMaterial();
		const listener = await listenTlsServer(tls.expired, (_request, response) => {
			response.end("accepted");
		});

		const response = await requestHub(
			{
				pid: process.pid,
				port: listener.port,
				started_at: new Date().toISOString(),
				spki: tls.expired.spki,
			},
			"/expired",
		);
		expect(await response.text()).toBe("accepted");
		expect(Buffer.concat(listener.applicationBytes).toString("utf8")).toContain(
			"GET /expired HTTP/1.1",
		);
	});

	it("refuses a different leaf under the same CA before any Authorization header or body reaches it", async () => {
		const tls = getTestTlsMaterial();
		const listener = await listenTlsServer(
			{ certificate: tls.other.certificate + tls.authority.certificate, key: tls.other.key },
			(_request, response) => {
				response.end("unexpected request");
			},
		);

		await expect(
			requestHub(
				{
					pid: process.pid,
					port: listener.port,
					started_at: new Date().toISOString(),
					spki: tls.pinned.spki,
				},
				"/sensitive",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer private-token",
						"content-type": "application/octet-stream",
					},
					body: "private request body",
				},
			),
		).rejects.toMatchObject({ code: HUB_TLS_PIN_MISMATCH_CODE });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(Buffer.concat(listener.applicationBytes)).toHaveLength(0);
	});

	it("names an unusable runtime key and a deliberately refused endpoint separately", async () => {
		await expect(
			requestHub(
				{ pid: process.pid, port: 1, started_at: new Date().toISOString(), spki: "not a key" },
				"/",
			),
		).rejects.toThrow("runtime has no usable TLS SPKI");

		const material = getTestTlsMaterial();
		const originalConnect = tls.connect;
		tls.connect = (() => {
			const socket = new tls.TLSSocket(new Socket());
			queueMicrotask(() => {
				socket.emit(
					"error",
					Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
						code: "ECONNREFUSED",
					}),
				);
			});
			return socket;
		}) as typeof tls.connect;
		syncBuiltinESMExports();
		try {
			const error = await requestHub(
				{
					pid: process.pid,
					port: 1,
					started_at: new Date().toISOString(),
					spki: material.pinned.spki,
				},
				"/",
			).catch((error: unknown) => error);
			expect(error).toMatchObject({
				code: "ECONNREFUSED",
				message: expect.stringContaining("TLS endpoint could not be reached"),
				cause: { code: "ECONNREFUSED" },
			});
		} finally {
			tls.connect = originalConnect;
			syncBuiltinESMExports();
		}
	});

	it("mints material valid beyond a day-long watch session while keeping the expired fixture expired", () => {
		const tls = getTestTlsMaterial();
		const now = Date.now();
		expect(Date.parse(new X509Certificate(tls.pinned.certificate).validTo)).toBeGreaterThan(
			now + 365 * 24 * 60 * 60 * 1000,
		);
		expect(Date.parse(new X509Certificate(tls.expired.certificate).validTo)).toBeLessThan(now);
	});

	it("refuses non-canonical Base64 runtime pins before connecting", async () => {
		const canonical = getTestTlsMaterial().pinned.spki;
		for (const spki of [
			`${canonical.slice(0, 12)}!${canonical.slice(12)}`,
			`${canonical.slice(0, 12)}\n${canonical.slice(12)}`,
			canonical.slice(0, -1),
		]) {
			await expect(
				requestHub({ pid: process.pid, port: 1, started_at: new Date().toISOString(), spki }, "/"),
			).rejects.toThrow("runtime has no usable TLS SPKI");
		}
	});

	it("abandons a TCP peer that accepts but never completes TLS", async () => {
		const tls = getTestTlsMaterial();
		let peerSocket: Socket | undefined;
		const stalledPeer = createNetServer((socket) => {
			peerSocket = socket;
			socket.resume();
		});
		await new Promise<void>((resolve, reject) => {
			stalledPeer.once("error", reject);
			stalledPeer.listen(0, "127.0.0.1", resolve);
		});
		const address = stalledPeer.address();
		if (address === null || typeof address === "string")
			throw new Error("stall listener has no port");

		try {
			const startedAt = Date.now();
			await expect(
				requestHub(
					{
						pid: process.pid,
						port: address.port,
						started_at: new Date().toISOString(),
						spki: tls.pinned.spki,
					},
					"/",
				),
			).rejects.toThrow("Hub TLS endpoint could not be reached: TLS handshake timed out");
			expect(Date.now() - startedAt).toBeLessThan(HUB_TLS_HANDSHAKE_TIMEOUT_MS + 1_000);

			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			expect(peerSocket?.readableEnded).toBe(true);
			await expect(
				new Promise<number>((resolve, reject) =>
					stalledPeer.getConnections((error, count) => (error ? reject(error) : resolve(count))),
				),
			).resolves.toBe(0);
		} finally {
			peerSocket?.destroy();
			if (stalledPeer.listening) {
				await new Promise<void>((resolve, reject) =>
					stalledPeer.close((error) => (error ? reject(error) : resolve())),
				);
			}
		}
		expect(stalledPeer.listening).toBe(false);
	});
});
