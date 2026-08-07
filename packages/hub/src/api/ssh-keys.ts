import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SshKeyEntry } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import ssh2 from "ssh2";
import { sanitizeFilename } from "./upload-utils.js";

/** Maximum file size considered when scanning for keys (1 MB). */
const MAX_KEY_SCAN_SIZE = 1 * 1024 * 1024;

/** Maximum upload size for key files (100 KB). */
const MAX_KEY_UPLOAD_SIZE = 100 * 1024;

function mapAlgorithm(type: string): string {
	if (type === "ssh-ed25519") return "ED25519";
	if (type === "ssh-rsa") return "RSA";
	if (type === "ssh-dss") return "DSA";
	if (type.startsWith("ecdsa-sha2-")) return "ECDSA";
	return type.toUpperCase();
}

function ecdsaBits(type: string): number {
	const m = /nistp(\d+)$/.exec(type);
	return m ? Number(m[1]) : 256;
}

function deriveBits(parsed: ssh2.ParsedKey): number {
	const type = parsed.type;
	if (type === "ssh-ed25519") return 256;
	if (type === "ssh-dss") return 1024;
	if (type.startsWith("ecdsa-sha2-")) return ecdsaBits(type);
	if (type === "ssh-rsa") {
		try {
			const pub = parsed.getPublicSSH();
			const typeLen = pub.readUInt32BE(0);
			const eOffset = 4 + typeLen;
			const eLen = pub.readUInt32BE(eOffset);
			const nOffset = eOffset + 4 + eLen;
			const nLen = pub.readUInt32BE(nOffset);
			return nLen * 8;
		} catch {
			return 2048;
		}
	}
	return 256;
}

function tryParseKey(
	filePath: string,
): { key: ssh2.ParsedKey; encrypted?: false } | { encrypted: true } | null {
	let buf: Buffer;
	try {
		buf = readFileSync(filePath);
	} catch {
		return null;
	}
	const result = ssh2.utils.parseKey(buf);
	if (result instanceof Error) {
		if (result.message.toLowerCase().includes("encrypted")) {
			return { encrypted: true };
		}
		return null;
	}
	const parsed = Array.isArray(result) ? result[0] : result;
	if (!parsed || parsed instanceof Error) return null;
	return { key: parsed };
}

function buildKeyEntry(name: string, filePath: string): SshKeyEntry | null {
	const stat = statSync(filePath);
	const mtime = stat.mtime.toISOString();
	const parseResult = tryParseKey(filePath);
	if (!parseResult) return null;
	if ("encrypted" in parseResult && parseResult.encrypted) {
		return { name, type: "key", encrypted: true, mtime };
	}
	const { key } = parseResult;
	const algorithm = mapAlgorithm(key.type);
	const bits = deriveBits(key);
	const fingerprint = `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64")}`;
	return { name, type: "key", algorithm, bits, fingerprint, encrypted: false, mtime };
}

function containedPath(base: string, ...parts: string[]): string | null {
	const resolvedBase = resolve(base);
	const resolved = resolve(join(base, ...parts));
	if (!resolved.startsWith(`${resolvedBase}/`) && resolved !== resolvedBase) {
		return null;
	}
	return resolved;
}

export function registerSshKeyRoutes(server: FastifyInstance, sshDir?: string): void {
	const dir = sshDir ?? join(homedir(), ".ssh");

	server.get(
		"/api/ssh-keys",
		async (request: FastifyRequest<{ Querystring: { dir?: string } }>, reply: FastifyReply) => {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			}
			const relDir = request.query.dir ?? "";
			let targetDir: string;
			if (relDir === "") {
				targetDir = resolve(dir);
			} else {
				const safe = containedPath(dir, relDir);
				if (!safe) {
					return reply
						.code(400)
						.send({ error: { code: "INVALID_PATH", message: "Path traversal rejected" } });
				}
				targetDir = safe;
			}
			if (!existsSync(targetDir)) {
				return reply
					.code(404)
					.send({ error: { code: "NOT_FOUND", message: "Directory not found" } });
			}
			let names: string[];
			try {
				names = readdirSync(targetDir);
			} catch {
				return reply
					.code(500)
					.send({ error: { code: "READ_ERROR", message: "Failed to read directory" } });
			}
			const entries: SshKeyEntry[] = [];
			for (const name of names) {
				// Skip public key files and common non-key files
				if (
					name.endsWith(".pub") ||
					name === "known_hosts" ||
					name === "known_hosts.old" ||
					name === "config" ||
					name === "authorized_keys"
				)
					continue;
				const fullPath = join(targetDir, name);
				let lstat: ReturnType<typeof lstatSync>;
				try {
					lstat = lstatSync(fullPath);
				} catch {
					continue;
				}
				if (lstat.isSymbolicLink()) continue;
				if (lstat.isDirectory()) {
					let itemCount = 0;
					try {
						itemCount = readdirSync(fullPath).length;
					} catch {
						// non-critical
					}
					entries.push({ name, type: "directory", items: itemCount });
					continue;
				}
				if (!lstat.isFile()) continue;
				if (lstat.size > MAX_KEY_SCAN_SIZE) continue;
				const entry = buildKeyEntry(name, fullPath);
				if (entry) entries.push(entry);
			}
			entries.sort((a, b) => {
				if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			return { path: relDir, entries };
		},
	);

	server.post("/api/ssh-keys", async (request: FastifyRequest, reply: FastifyReply) => {
		const file = await request.file();
		if (!file) {
			return reply.code(400).send({ error: { code: "NO_FILE", message: "No file uploaded" } });
		}
		const sanitized = sanitizeFilename(file.filename);
		if (!sanitized) {
			return reply
				.code(400)
				.send({ error: { code: "INVALID_FILENAME", message: "Invalid filename" } });
		}
		let relDir = "";
		const fields = (request.body as Record<string, { value?: string }> | null) ?? {};
		if (fields.dir?.value) {
			relDir = fields.dir.value;
		}
		const buffer = await file.toBuffer();
		if (buffer.byteLength > MAX_KEY_UPLOAD_SIZE) {
			return reply.code(413).send({
				error: { code: "FILE_TOO_LARGE", message: "Key file exceeds 100 KB limit" },
			});
		}
		const result = ssh2.utils.parseKey(buffer);
		const isEncryptedKey =
			result instanceof Error && result.message.toLowerCase().includes("encrypted");
		const isValidKey = !(result instanceof Error);
		if (!isValidKey && !isEncryptedKey) {
			return reply.code(400).send({
				error: { code: "INVALID_KEY", message: "File is not a valid SSH private key" },
			});
		}
		let targetDir: string;
		if (relDir === "") {
			targetDir = resolve(dir);
		} else {
			const safe = containedPath(dir, relDir);
			if (!safe) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_PATH", message: "Path traversal rejected" } });
			}
			targetDir = safe;
		}
		if (!existsSync(targetDir)) {
			mkdirSync(targetDir, { recursive: true, mode: 0o700 });
		}
		const safeTarget = containedPath(dir, relDir, sanitized);
		if (!safeTarget) {
			return reply.code(400).send({ error: { code: "INVALID_PATH", message: "Invalid filename" } });
		}
		if (existsSync(safeTarget)) {
			return reply.code(409).send({
				error: { code: "DUPLICATE", message: "A key with this filename already exists" },
			});
		}
		await writeFile(safeTarget, buffer);
		await chmod(safeTarget, 0o600);
		if (isEncryptedKey) {
			const mtime = statSync(safeTarget).mtime.toISOString();
			return { name: sanitized, encrypted: true, mtime };
		}
		const parsed = Array.isArray(result) ? result[0] : result;
		if (!parsed || parsed instanceof Error) {
			return { name: sanitized };
		}
		const algorithm = mapAlgorithm(parsed.type);
		const bits = deriveBits(parsed);
		const fingerprint = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64")}`;
		const mtime = statSync(safeTarget).mtime.toISOString();
		return { name: sanitized, algorithm, bits, fingerprint, encrypted: false, mtime };
	});

	server.delete(
		"/api/ssh-keys",
		async (
			request: FastifyRequest<{ Querystring: { name?: string; dir?: string } }>,
			reply: FastifyReply,
		) => {
			const rawName = request.query.name;
			if (!rawName) {
				return reply
					.code(400)
					.send({ error: { code: "MISSING_PARAM", message: "name query parameter required" } });
			}
			const sanitized = sanitizeFilename(rawName);
			if (!sanitized) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_FILENAME", message: "Invalid filename" } });
			}
			const relDir = request.query.dir ?? "";
			const safeTarget = containedPath(dir, relDir, sanitized);
			if (!safeTarget) {
				return reply
					.code(400)
					.send({ error: { code: "INVALID_PATH", message: "Path traversal rejected" } });
			}
			try {
				await unlink(safeTarget);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Key not found" } });
				}
				throw err;
			}
			return reply.code(204).send();
		},
	);
}
