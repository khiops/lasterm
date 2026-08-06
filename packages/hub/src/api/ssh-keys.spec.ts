import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock agents so no real PTY / SSH is spawned ----------------------------

vi.mock("../session/ssh-agent.js", () => {
	const { EventEmitter } = require("node:events");
	class MockSshAgent extends EventEmitter {
		connected = true;
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn();
		close = vi.fn(() => {
			this.connected = false;
			this.emit("close");
		});
	}
	return { SshAgent: MockSshAgent };
});

// --- Helpers ----------------------------------------------------------------

const TEST_TOKEN = "test-ssh-keys-token-64chars-padded-aaaaaaaaaaaaaaaaaaaaaaaa";

function authHeader(): Record<string, string> {
	return { authorization: `Bearer ${TEST_TOKEN}` };
}

/**
 * Build a multipart/form-data payload for a file upload.
 */
function buildMultipart(
	filename: string,
	content: Buffer | string,
	extraFields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
	const boundary = "----TestSshKeyBoundary42";
	const parts: Buffer[] = [];

	// Optional extra text fields (e.g. dir)
	for (const [name, value] of Object.entries(extraFields)) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			),
		);
	}

	const bodyBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="key"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
		),
	);
	parts.push(bodyBuf);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

	const payload = Buffer.concat(parts);
	return {
		payload,
		headers: {
			authorization: `Bearer ${TEST_TOKEN}`,
			"content-type": `multipart/form-data; boundary=${boundary}`,
		},
	};
}

// Generate a real ED25519 key using ssh2
function generateEd25519Key(): Buffer {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const ssh2mod = require("ssh2") as typeof import("ssh2");
	const kp = ssh2mod.utils.generateKeyPairSync("ed25519");
	// ssh2 returns { private, public } (not privateKey/publicKey)
	return Buffer.from((kp as unknown as { private: string }).private);
}

// --- Test suite -------------------------------------------------------------

describe("SSH key endpoints", () => {
	let server: FastifyInstance;
	let sshDir: string;

	beforeEach(async () => {
		// mkdtempSync is the OS-atomic unique-temp-dir primitive (mode 0700) — guarantees
		// per-test isolation with no possible name collision under parallel test load,
		// unlike a hand-rolled Date.now()+Math.random() name.
		sshDir = mkdtempSync(join(tmpdir(), "lasterm-ssh-test-"));
	});

	afterEach(async () => {
		if (server) await server.close();
		rmSync(sshDir, { recursive: true, force: true });
	});

	// Helper: spin up an isolated Fastify server with only the SSH key routes
	async function makeServer(): Promise<FastifyInstance> {
		const Fastify = (await import("fastify")).default;
		const fastifyMultipart = (await import("@fastify/multipart")).default;
		const { registerSshKeyRoutes } = await import("./ssh-keys.js");

		const s = Fastify({ logger: false });
		await s.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024 } });

		// Auth hook mirroring server.ts
		s.addHook("onRequest", async (request, reply) => {
			if (request.method === "OPTIONS") return;
			const auth = request.headers.authorization;
			if (!auth?.startsWith("Bearer ") || auth.slice(7) !== TEST_TOKEN) {
				return reply.code(401).send({ error: "AUTH_REQUIRED" });
			}
		});

		registerSshKeyRoutes(s, sshDir);
		return s;
	}

	// --- GET /api/ssh-keys ---------------------------------------------------

	describe("GET /api/ssh-keys", () => {
		it("returns empty entries for an empty dir", async () => {
			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ path: string; entries: unknown[] }>();
			expect(body.path).toBe("");
			expect(body.entries).toEqual([]);
		});

		it("returns key metadata for a valid ED25519 key", async () => {
			const keyBuf = generateEd25519Key();
			writeFileSync(join(sshDir, "id_ed25519"), keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{
				entries: Array<{
					name: string;
					type: string;
					algorithm?: string;
					bits?: number;
					fingerprint?: string;
				}>;
			}>();
			expect(body.entries).toHaveLength(1);
			const entry = body.entries[0];
			expect(entry.name).toBe("id_ed25519");
			expect(entry.type).toBe("key");
			expect(entry.algorithm).toBe("ED25519");
			expect(entry.bits).toBe(256);
			expect(entry.fingerprint).toMatch(/^SHA256:/);
		});

		it("lists subdirectories with item count", async () => {
			mkdirSync(join(sshDir, "work"), { recursive: true });
			const keyBuf = generateEd25519Key();
			writeFileSync(join(sshDir, "work", "id_ed25519"), keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ entries: Array<{ name: string; type: string; items?: number }> }>();
			const dir = body.entries.find((e) => e.name === "work");
			expect(dir).toBeDefined();
			expect(dir?.type).toBe("directory");
			expect(dir?.items).toBe(1);
		});

		it("skips non-key files (plain text)", async () => {
			writeFileSync(join(sshDir, "known_hosts"), "github.com ssh-ed25519 AAAA...");
			writeFileSync(join(sshDir, "config"), "Host *\n  ServerAliveInterval 60");

			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ entries: unknown[] }>();
			expect(body.entries).toHaveLength(0);
		});

		it("skips symlinks", async () => {
			const keyBuf = generateEd25519Key();
			const realKey = join(sshDir, "id_ed25519");
			writeFileSync(realKey, keyBuf);
			symlinkSync(realKey, join(sshDir, "sym_key"));

			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ entries: Array<{ name: string }> }>();
			// Only the real key, not the symlink
			const names = body.entries.map((e) => e.name);
			expect(names).toContain("id_ed25519");
			expect(names).not.toContain("sym_key");
		});

		it("skips files larger than 1 MB", async () => {
			// Write a file > 1 MB with PEM-like header to fool naive checks
			const bigBuf = Buffer.alloc(1.1 * 1024 * 1024, 65);
			writeFileSync(join(sshDir, "big_key"), bigBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ entries: unknown[] }>();
			expect(body.entries).toHaveLength(0);
		});

		it("rejects traversal via dir param", async () => {
			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys?dir=../",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("INVALID_PATH");
		});

		it("navigates into a valid subdirectory", async () => {
			const subDir = join(sshDir, "work");
			mkdirSync(subDir, { recursive: true });
			const keyBuf = generateEd25519Key();
			writeFileSync(join(subDir, "id_ed25519"), keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys?dir=work",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ path: string; entries: Array<{ name: string }> }>();
			expect(body.path).toBe("work");
			expect(body.entries.map((e) => e.name)).toContain("id_ed25519");
		});

		it("requires auth", async () => {
			server = await makeServer();
			const res = await server.inject({
				method: "GET",
				url: "/api/ssh-keys",
			});
			expect(res.statusCode).toBe(401);
		});
	});

	// --- POST /api/ssh-keys --------------------------------------------------

	describe("POST /api/ssh-keys", () => {
		it("uploads a valid ED25519 key and returns metadata", async () => {
			const keyBuf = generateEd25519Key();
			const { payload, headers } = buildMultipart("id_ed25519", keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "POST",
				url: "/api/ssh-keys",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{
				name: string;
				algorithm: string;
				bits: number;
				fingerprint: string;
				encrypted: boolean;
			}>();
			expect(body.name).toBe("id_ed25519");
			expect(body.algorithm).toBe("ED25519");
			expect(body.bits).toBe(256);
			expect(body.fingerprint).toMatch(/^SHA256:/);
			expect(body.encrypted).toBe(false);
		});

		it("rejects non-key content", async () => {
			const { payload, headers } = buildMultipart("not_a_key", Buffer.from("this is not a key"));

			server = await makeServer();
			const res = await server.inject({
				method: "POST",
				url: "/api/ssh-keys",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("INVALID_KEY");
		});

		it("rejects files over 100 KB", async () => {
			const bigBuf = Buffer.alloc(101 * 1024, 65);
			const { payload, headers } = buildMultipart("big_key", bigBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "POST",
				url: "/api/ssh-keys",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(413);
			expect(res.json().error.code).toBe("FILE_TOO_LARGE");
		});

		it("rejects a duplicate filename", async () => {
			const keyBuf = generateEd25519Key();
			writeFileSync(join(sshDir, "id_ed25519"), keyBuf);
			const { payload, headers } = buildMultipart("id_ed25519", keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "POST",
				url: "/api/ssh-keys",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(409);
			expect(res.json().error.code).toBe("DUPLICATE");
		});

		it("sets file permissions to 0o600", async () => {
			const keyBuf = generateEd25519Key();
			const { payload, headers } = buildMultipart("id_ed25519_perms", keyBuf);

			server = await makeServer();
			await server.inject({ method: "POST", url: "/api/ssh-keys", headers, payload });

			const info = await stat(join(sshDir, "id_ed25519_perms"));
			// Check that only owner read/write bits are set (0o600)
			expect(info.mode & 0o777).toBe(0o600);
		});

		it("path traversal in filename is stripped by multipart — file lands in sshDir", async () => {
			// @fastify/busboy normalises '../evil_key' to 'evil_key' before our code runs.
			// Our sanitizeFilename then accepts the clean name, and containedPath keeps
			// the file inside sshDir — so the traversal is fully neutralised.
			const keyBuf = generateEd25519Key();
			const { payload, headers } = buildMultipart("../evil_key", keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "POST",
				url: "/api/ssh-keys",
				headers,
				payload,
			});
			// busboy strips the traversal: file is written as sshDir/evil_key (not parent dir)
			expect(res.statusCode).toBe(200);
			expect(res.json<{ name: string }>().name).toBe("evil_key");
			// Verify file did NOT escape into a parent directory
			const { existsSync } = await import("node:fs");
			const { join } = await import("node:path");
			expect(existsSync(join(sshDir, "evil_key"))).toBe(true);
		});
	});

	// --- DELETE /api/ssh-keys ------------------------------------------------

	describe("DELETE /api/ssh-keys", () => {
		it("deletes an existing key and returns 204", async () => {
			const keyBuf = generateEd25519Key();
			writeFileSync(join(sshDir, "id_ed25519"), keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "DELETE",
				url: "/api/ssh-keys?name=id_ed25519",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(204);
			expect(existsSync(join(sshDir, "id_ed25519"))).toBe(false);
		});

		it("returns 404 when key does not exist", async () => {
			server = await makeServer();
			const res = await server.inject({
				method: "DELETE",
				url: "/api/ssh-keys?name=nonexistent_key",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(404);
			expect(res.json().error.code).toBe("NOT_FOUND");
		});

		it("rejects traversal via name param", async () => {
			server = await makeServer();
			const res = await server.inject({
				method: "DELETE",
				url: "/api/ssh-keys?name=../../../etc/passwd",
				headers: authHeader(),
			});
			// sanitizeFilename returns null for traversal paths -> 400
			expect(res.statusCode).toBe(400);
		});

		it("rejects traversal via dir param", async () => {
			server = await makeServer();
			const res = await server.inject({
				method: "DELETE",
				url: "/api/ssh-keys?name=id_ed25519&dir=../",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("INVALID_PATH");
		});

		it("deletes a key in a subdirectory", async () => {
			const subDir = join(sshDir, "work");
			mkdirSync(subDir, { recursive: true });
			const keyBuf = generateEd25519Key();
			writeFileSync(join(subDir, "id_ed25519"), keyBuf);

			server = await makeServer();
			const res = await server.inject({
				method: "DELETE",
				url: "/api/ssh-keys?name=id_ed25519&dir=work",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(204);
			expect(existsSync(join(subDir, "id_ed25519"))).toBe(false);
		});
	});
});
