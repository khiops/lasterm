import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { etagOf, registerFileContentRoutes } from "../api/file-content.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { DownloadTickets } from "./download-tickets.js";
import { FileAccessError } from "./host-files.js";
import { HostFilesService } from "./host-files-service.js";
import { joinHostPath, normaliseHostPath, type PathStyle } from "./host-paths.js";
import { LocalFileBackend, localHostOs } from "./local-files.js";
import { LocalReadBackend, type ReadBackend } from "./read-backend.js";
import { type MockSshHost, startMockSshHost } from "./ssh-host.fixture.js";
import { machineStyle, windowsMachine } from "./upload-backends.fixture.js";

/**
 * A download's read side (#840), over the three ways the hub reaches a host's
 * files, each through the content route a client calls: the hub's own file
 * system, SFTP on a mock host, and SSH commands on a mock host without SFTP.
 */

const CHANNEL = "01K840CHAN0000000000000001";

interface ReadHarness {
	readonly server: FastifyInstance;
	/** The host path of `name` in the harness's folder. */
	at(...names: string[]): string;
	/** Where `name` is on this machine. */
	local(...names: string[]): string;
	/** Bytes the source read so far. */
	read(): number;
	/** How many opened sources were closed so far. */
	closed(): number;
	/** List the harness's folder through the same host's files, as the panel does. */
	list(): Promise<unknown>;
	/** Download responses the route counts as holding the host now. */
	holding(): number;
	readonly host: MockSshHost | null;
	/** Set what runs between the `lstat` and the open (local only). */
	between(hook: ((path: string) => Promise<void>) | null): void;
	/** Set what runs before the second look (local only). */
	beforeRecheck(hook: ((path: string) => Promise<void>) | null): void;
	close(): Promise<void>;
}

interface ReadBackendKind {
	readonly name: string;
	readonly runs: boolean;
	readonly transport: "local" | "sftp" | "exec";
	start(options?: {
		fstat?: boolean;
		prelude?: string;
		rewriteStdout?: (stdout: Buffer) => Buffer;
		sftpIdleMs?: number;
		sftpBetween?: (path: string) => Promise<void>;
		sftpBeforeRecheck?: (path: string) => Promise<void>;
	}): Promise<ReadHarness>;
}

/** Download responses holding their host, as the session manager counts them. */
let holding = 0;

async function serverFor(files: HostFilesService): Promise<FastifyInstance> {
	const server = Fastify({ logger: false, forceCloseConnections: true });
	registerFileContentRoutes(server, {
		files,
		tickets: new DownloadTickets(),
		enabled: () => true,
		responseOpen: () => {
			holding++;
			let released = false;
			return () => {
				if (!released) holding--;
				released = true;
			};
		},
	});
	await server.ready();
	return server;
}

function hostPath(path: string, style: PathStyle): string {
	const normalised = normaliseHostPath(path, style);
	if (!normalised.ok) throw new Error(normalised.reason);
	return normalised.path;
}

const LOCAL: ReadBackendKind = {
	name: "the hub's own file system",
	runs: true,
	transport: "local",
	start: async () => {
		const root = makeTempDir("lasterm-read-local-");
		let count = 0;
		let between: ((path: string) => Promise<void>) | null = null;
		let beforeRecheck: ((path: string) => Promise<void>) | null = null;
		let closes = 0;
		const files = new HostFilesService({
			channelHost: () => ({ hostId: "local", hostType: "local" }),
			hostOs: () => null,
			sshHost: () => null,
			local: {
				backend: new LocalFileBackend(),
				os: localHostOs(),
				read: new LocalReadBackend({
					betweenLookAndOpen: async (path) => {
						await between?.(path);
					},
					beforeRecheck: async (path) => {
						await beforeRecheck?.(path);
					},
					onRead: (bytes) => {
						count += bytes;
					},
					onClose: () => {
						closes++;
					},
				}),
			},
		});
		const server = await serverFor(files);
		const dir = hostPath(root, machineStyle);
		return {
			server,
			at: (...names) => names.reduce((path, name) => joinHostPath(path, name, machineStyle), dir),
			local: (...names) => join(root, ...names),
			read: () => count,
			closed: () => closes,
			list: () => files.list(CHANNEL, dir, false),
			holding: () => holding,
			host: null,
			between: (hook) => {
				between = hook;
			},
			beforeRecheck: (hook) => {
				beforeRecheck = hook;
			},
			close: async () => {
				await server.close();
				await removeTempDir(root);
			},
		};
	},
};

function sftpKind(style: PathStyle): ReadBackendKind {
	return {
		name: `SFTP, ${style === "windows" ? "Windows-shaped" : "POSIX"}`,
		runs: true,
		transport: "sftp",
		start: async (options = {}) => {
			const root = makeTempDir("lasterm-read-sftp-");
			let count = 0;
			let closes = 0;
			const host = await startMockSshHost({
				view: { style, root },
				onRead: (bytes) => {
					count += bytes;
				},
				onCloseFile: () => {
					closes++;
				},
				...(options.fstat === false ? { fstat: false } : {}),
			});
			const files = new HostFilesService({
				channelHost: () => ({ hostId: "remote", hostType: "ssh" }),
				hostOs: () => (style === "windows" ? "windows" : "linux"),
				sshHost: () => ({ sshConnection: host.client, sftpSupport: { offered: true } }),
				...(options.sftpIdleMs !== undefined ? { sftpIdleMs: options.sftpIdleMs } : {}),
				...(options.sftpBetween !== undefined
					? { sftpBetweenLookAndOpen: options.sftpBetween }
					: {}),
				...(options.sftpBeforeRecheck !== undefined
					? { sftpBeforeRecheck: options.sftpBeforeRecheck }
					: {}),
			});
			const server = await serverFor(files);
			const base = style === "windows" ? join(root, "C", "dl") : join(root, "dl");
			mkdirSync(base, { recursive: true });
			const dir = style === "windows" ? "C:\\dl" : "/dl";
			return {
				server,
				at: (...names) => names.reduce((path, name) => joinHostPath(path, name, style), dir),
				local: (...names) => join(base, ...names),
				read: () => count,
				closed: () => closes,
				list: () => files.list(CHANNEL, dir, false),
				holding: () => holding,
				host,
				between: () => {
					throw new Error("local only");
				},
				beforeRecheck: () => {
					throw new Error("local only");
				},
				close: async () => {
					await server.close();
					await host.close();
					await removeTempDir(root);
				},
			};
		},
	};
}

function execKind(style: PathStyle): ReadBackendKind {
	return {
		name: `SSH commands, ${style === "windows" ? "Windows" : "POSIX"}`,
		runs: style === machineStyle,
		transport: "exec",
		start: async (options = {}) => {
			const root = makeTempDir("lasterm-read-exec-");
			let count = 0;
			let closes = 0;
			const host = await startMockSshHost({
				sftp: false,
				...(style === "windows" ? { shell: "cmd" as const } : {}),
				...(options.prelude !== undefined ? { prelude: options.prelude } : {}),
				...(options.rewriteStdout !== undefined ? { rewriteStdout: options.rewriteStdout } : {}),
			});
			const files = new HostFilesService({
				channelHost: () => ({ hostId: "remote", hostType: "ssh" }),
				hostOs: () => (style === "windows" ? "windows" : "linux"),
				sshHost: () => ({
					sshConnection: host.client,
					sftpSupport: { offered: false, reason: "not offered" },
				}),
				onExecRead: (bytes) => {
					count += bytes;
				},
				onExecClose: () => {
					closes++;
				},
			});
			const server = await serverFor(files);
			const dir = hostPath(root, style);
			return {
				server,
				at: (...names) => names.reduce((path, name) => joinHostPath(path, name, style), dir),
				local: (...names) => join(root, ...names),
				read: () => count,
				closed: () => closes,
				list: () => files.list(CHANNEL, dir, false),
				holding: () => holding,
				host,
				between: () => {
					throw new Error("local only");
				},
				beforeRecheck: () => {
					throw new Error("local only");
				},
				close: async () => {
					await server.close();
					await host.close();
					await removeTempDir(root);
				},
			};
		},
	};
}

const KINDS: readonly ReadBackendKind[] = [
	LOCAL,
	sftpKind("posix"),
	sftpKind("windows"),
	execKind("posix"),
	execKind("windows"),
];

let harness: ReadHarness | null = null;

afterEach(async () => {
	await harness?.close();
	harness = null;
});

function content(h: ReadHarness, path: string, headers: Record<string, string> = {}) {
	return h.server.inject({
		method: "GET",
		url: `/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(path)}`,
		headers,
	});
}

const MiB = 1024 * 1024;

/**
 * Download `name` over HTTP, pause after the first chunk, run `change` while
 * the hub cannot have read the end, then take the rest: the bytes that came
 * and the length the response promised.
 */
async function pausedDownload(
	h: ReadHarness,
	name: string,
	change: () => Promise<void>,
): Promise<{ got: number; promised: number }> {
	await h.server.listen({ port: 0, host: "127.0.0.1" });
	const port = (h.server.server.address() as AddressInfo).port;
	const url = `http://127.0.0.1:${port}/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(h.at(name))}`;
	return new Promise((resolve, reject) => {
		const request = get(url, (response) => {
			const promised = Number(response.headers["content-length"]);
			let got = 0;
			let changed = false;
			const done = () => resolve({ got, promised });
			response.on("data", (chunk: Buffer) => {
				got += chunk.length;
				if (!changed) {
					changed = true;
					response.pause();
					void change()
						.then(() => new Promise((r) => setTimeout(r, 300)))
						.then(() => response.resume());
				}
			});
			response.on("end", done);
			response.on("aborted", done);
			response.on("error", done);
			response.on("close", done);
		});
		request.on("error", reject);
	});
}

describe.each(KINDS.filter((kind) => kind.runs))(
	"a download's read side over $name (#840)",
	(kind) => {
		it("streams a whole file", async () => {
			harness = await kind.start();
			const bytes = randomBytes(3 * MiB);
			writeFileSync(harness.local("big.bin"), bytes);
			const response = await content(harness, harness.at("big.bin"));
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-length"]).toBe("3145728");
			expect(response.rawPayload.equals(bytes)).toBe(true);
			expect(response.headers.etag).toMatch(/^"3145728-(ms|s|t)\d+"$/);
			expect(response.headers["accept-ranges"]).toBe("bytes");
			expect(response.headers["content-type"]).toBe("application/octet-stream");
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.headers["x-content-type-options"]).toBe("nosniff");
			expect(Number.isNaN(Date.parse(String(response.headers["last-modified"])))).toBe(false);
		});

		it("serves a single range", async () => {
			harness = await kind.start();
			const bytes = randomBytes(3 * MiB);
			writeFileSync(harness.local("big.bin"), bytes);
			const path = harness.at("big.bin");
			const slice = await content(harness, path, { range: "bytes=1000-1999" });
			expect(slice.statusCode).toBe(206);
			expect(slice.headers["content-range"]).toBe("bytes 1000-1999/3145728");
			expect(slice.rawPayload.equals(bytes.subarray(1000, 2000))).toBe(true);
			const tail = await content(harness, path, { range: "bytes=3145000-" });
			expect(tail.statusCode).toBe(206);
			expect(tail.rawPayload.equals(bytes.subarray(3145000))).toBe(true);
			const last = await content(harness, path, { range: "bytes=-10" });
			expect(last.rawPayload.equals(bytes.subarray(3145728 - 10))).toBe(true);
			const clamped = await content(harness, path, { range: "bytes=3145000-9999999" });
			expect(clamped.headers["content-range"]).toBe("bytes 3145000-3145727/3145728");
			expect(clamped.rawPayload.equals(bytes.subarray(3145000))).toBe(true);
		});

		it("if-range mismatch sends the whole file; a match serves the range", async () => {
			harness = await kind.start();
			const bytes = randomBytes(200_000);
			writeFileSync(harness.local("f.bin"), bytes);
			const path = harness.at("f.bin");
			const stale = await content(harness, path, { range: "bytes=10-", "if-range": '"1-ms1"' });
			expect(stale.statusCode).toBe(200);
			expect(stale.rawPayload.equals(bytes)).toBe(true);
			const etag = stale.headers.etag as string;
			const fresh = await content(harness, path, { range: "bytes=10-", "if-range": etag });
			expect(fresh.statusCode).toBe(206);
			expect(fresh.rawPayload.equals(bytes.subarray(10))).toBe(true);
		});

		it("unsatisfiable ranges answer 416", async () => {
			harness = await kind.start();
			writeFileSync(harness.local("f.bin"), randomBytes(3 * MiB));
			for (const range of ["bytes=5000000-", "bytes=-0"]) {
				const response = await content(harness, harness.at("f.bin"), { range });
				expect(response.statusCode, range).toBe(416);
				expect(response.headers["content-range"], range).toBe("bytes */3145728");
			}
		});

		it("ignored ranges send the whole file", async () => {
			harness = await kind.start();
			const bytes = randomBytes(4096);
			writeFileSync(harness.local("f.bin"), bytes);
			writeFileSync(harness.local("empty.bin"), "");
			for (const range of ["bytes=0-1,5-6", "bytes=9-3", "bytes=abc"]) {
				const response = await content(harness, harness.at("f.bin"), { range });
				expect(response.statusCode, range).toBe(200);
				expect(response.rawPayload.equals(bytes), range).toBe(true);
			}
			const empty = await content(harness, harness.at("empty.bin"), { range: "bytes=0-" });
			expect(empty.statusCode).toBe(200);
			expect(empty.headers["content-length"]).toBe("0");
		});

		// Over SSH commands on Windows a file link is read as a file: the junction
		// and file-link cases below cover that host.
		it.skipIf(windowsMachine && kind.transport === "exec")(
			"a link is not followed",
			async (context) => {
				harness = await kind.start();
				writeFileSync(harness.local("target.txt"), "target");
				mkdirSync(harness.local("folder"));
				try {
					symlinkSync(harness.local("target.txt"), harness.local("to-file"));
					symlinkSync(harness.local("folder"), harness.local("to-folder"));
					symlinkSync(harness.local("missing"), harness.local("dangling"));
				} catch {
					// On Windows, making a symlink needs a privilege this account may not hold.
					context.skip();
				}
				for (const name of ["to-file", "to-folder", "dangling"]) {
					const response = await content(harness, harness.at(name));
					expect(response.statusCode, name).toBe(409);
					expect(response.json().error.code, name).toBe("LINK_NOT_FOLLOWED");
				}
			},
		);

		it.runIf(windowsMachine && kind.transport !== "sftp")(
			"a junction is not followed",
			async () => {
				// A folder reparse point, which needs no privilege to make.
				harness = await kind.start();
				mkdirSync(harness.local("folder"));
				symlinkSync(harness.local("folder"), harness.local("junction"), "junction");
				const response = await content(harness, harness.at("junction"));
				expect(response.statusCode).toBe(409);
				expect(response.json().error.code).toBe("LINK_NOT_FOLLOWED");
			},
		);

		it("a file dated before 1970", async () => {
			harness = await kind.start();
			const bytes = randomBytes(1000);
			writeFileSync(harness.local("old.bin"), bytes);
			utimesSync(harness.local("old.bin"), new Date(1960, 0, 1), new Date(1960, 0, 1));
			const response = await content(harness, harness.at("old.bin"));
			expect(response.statusCode).toBe(200);
			expect(response.rawPayload.equals(bytes)).toBe(true);
		});

		it.runIf(windowsMachine && kind.transport !== "sftp")(
			"a junction whose target is gone is still a link",
			async () => {
				harness = await kind.start();
				mkdirSync(harness.local("gone"));
				symlinkSync(harness.local("gone"), harness.local("dangling"), "junction");
				rmSync(harness.local("gone"), { recursive: true });
				const response = await content(harness, harness.at("dangling"));
				expect(response.statusCode).toBe(409);
				expect(response.json().error.code).toBe("LINK_NOT_FOLLOWED");
			},
		);

		it.runIf(!windowsMachine && process.getuid?.() !== 0)("an unreadable file", async () => {
			harness = await kind.start();
			writeFileSync(harness.local("secret.bin"), "secret");
			chmodSync(harness.local("secret.bin"), 0o000);
			const response = await content(harness, harness.at("secret.bin"));
			expect(response.statusCode).toBe(403);
			expect(response.json().error.code).toBe("PERMISSION_DENIED");
		});

		it("not a regular file", async () => {
			harness = await kind.start();
			mkdirSync(harness.local("folder"));
			const response = await content(harness, harness.at("folder"));
			expect(response.statusCode).toBe(409);
			expect(response.json().error.code).toBe("NOT_A_FILE");
			const missing = await content(harness, harness.at("nothing"));
			expect(missing.statusCode).toBe(404);
			expect(missing.json().error.code).toBe("NOT_FOUND");
		});

		it("a file changed during the read is not delivered whole", async () => {
			for (const change of ["grown by one byte", "touched to another time"] as const) {
				harness = await kind.start();
				const h = harness;
				writeFileSync(h.local("huge.bin"), randomBytes(16 * MiB));
				const { got, promised } = await pausedDownload(h, "huge.bin", async () => {
					if (change === "grown by one byte") await appendFile(h.local("huge.bin"), "x");
					else utimesSync(h.local("huge.bin"), new Date(2001, 0, 1), new Date(2001, 0, 1));
				});
				expect(promised, change).toBe(16 * MiB);
				// Cut before the 64 KiB held back for the second look.
				expect(got, change).toBeLessThanOrEqual(16 * MiB - 65536);
				await h.close();
				harness = null;
			}
		});

		it("reading pauses with its consumer", async () => {
			harness = await kind.start();
			writeFileSync(harness.local("huge.bin"), randomBytes(16 * MiB));
			const address = await harness.server.listen({ port: 0, host: "127.0.0.1" });
			void address;
			const port = (harness.server.server.address() as AddressInfo).port;
			const url = `http://127.0.0.1:${port}/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(harness.at("huge.bin"))}`;
			const taken = await new Promise<number>((resolve, reject) => {
				const request = get(url, (response) => {
					let got = 0;
					response.on("data", (chunk: Buffer) => {
						got += chunk.length;
						if (got >= 64 * 1024) {
							response.pause();
							resolve(got);
						}
					});
				});
				request.on("error", reject);
			});
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(harness.read() - taken).toBeLessThanOrEqual(4 * MiB);
			expect(harness.read()).toBeGreaterThan(0);
		});

		it("a client leaving stops the read", async () => {
			let holdingWhileRunning = -1;
			harness = await kind.start();
			writeFileSync(harness.local("huge.bin"), randomBytes(16 * MiB));
			await harness.server.listen({ port: 0, host: "127.0.0.1" });
			const port = (harness.server.server.address() as AddressInfo).port;
			const url = `http://127.0.0.1:${port}/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(harness.at("huge.bin"))}`;
			await new Promise<void>((resolve, reject) => {
				const request = get(url, (response) => {
					response.once("data", () => {
						// The response holds its host while it runs.
						holdingWhileRunning = holding;
						request.destroy();
						resolve();
					});
				});
				request.on("error", () => {});
				request.on("timeout", reject);
			});
			const h = harness;
			expect(holdingWhileRunning).toBe(1);
			await vi.waitFor(() => expect(h.closed()).toBe(1), { timeout: 2000 });
			// The response held its host while it ran, and let go when the client left.
			await vi.waitFor(() => expect(h.holding()).toBe(0), { timeout: 2000 });
			const after = harness.read();
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(harness.read()).toBe(after);
			expect(after).toBeLessThan(16 * MiB);
		});
	},
);

describe("a download's read side, cases of one backend (#840)", () => {
	it("a client leaving while the file opens lets go of it", async () => {
		harness = await LOCAL.start();
		const h = harness;
		writeFileSync(h.local("big.bin"), randomBytes(3 * MiB));
		h.between(() => new Promise((resolve) => setTimeout(resolve, 400)));
		await h.server.listen({ port: 0, host: "127.0.0.1" });
		const port = (h.server.server.address() as AddressInfo).port;
		const request = get(
			`http://127.0.0.1:${port}/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(h.at("big.bin"))}`,
		);
		request.on("error", () => {});
		setTimeout(() => request.destroy(), 100);
		await vi.waitFor(() => expect(h.closed()).toBe(1), { timeout: 3000 });
		expect(h.holding()).toBe(0);
	});

	it("a read that fails answers its code, and no log names the path", async () => {
		const SECRET = "/private/secret.txt";
		const logs: string[] = [];
		/** A file of 200 000 bytes whose read fails, at once or after `after` bytes. */
		const failing = (after: number): ReadBackend => {
			const late = after > 0;
			return {
				open: async () => ({
					look: { size: 200_000, mtime: "1", unit: "ms" },
					read: async () =>
						new Readable({
							read() {
								if (after > 0) {
									this.push(Buffer.alloc(after, 1));
									after = 0;
								} else {
									const error = new FileAccessError(
										"FILE_ACCESS_FAILED",
										`SFTP said no such thing as ${SECRET}`,
									);
									// After its first bytes, the failure comes once the headers are out.
									if (late) setTimeout(() => this.destroy(error), 100);
									else this.destroy(error);
								}
							},
						}),
					recheck: async () => ({ size: 200_000, mtime: "1", unit: "ms" }),
					close: async () => {},
				}),
			};
		};
		for (const after of [0, 70_000]) {
			const files = new HostFilesService({
				channelHost: () => ({ hostId: "local", hostType: "local" }),
				hostOs: () => null,
				sshHost: () => null,
				local: { backend: new LocalFileBackend(), os: localHostOs(), read: failing(after) },
			});
			const server = Fastify({
				logger: { level: "trace", stream: { write: (line: string) => logs.push(line) } },
				forceCloseConnections: true,
			});
			registerFileContentRoutes(server, {
				files,
				tickets: new DownloadTickets(),
				enabled: () => true,
				responseOpen: () => () => {},
			});
			await server.listen({ port: 0, host: "127.0.0.1" });
			try {
				const port = (server.server.address() as AddressInfo).port;
				const answer = await new Promise<{ status: number; got: number; body: string }>(
					(resolve) => {
						const request = get(
							`http://127.0.0.1:${port}/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(windowsMachine ? "C:\\x" : "/x")}`,
							(response) => {
								let got = 0;
								let body = "";
								response.on("data", (chunk: Buffer) => {
									got += chunk.length;
									if (body.length < 1000) body += chunk.toString("latin1");
								});
								const done = () => resolve({ status: response.statusCode ?? 0, got, body });
								response.on("end", done);
								response.on("aborted", done);
								response.on("close", done);
							},
						);
						request.on("error", () => resolve({ status: 0, got: 0, body: "" }));
					},
				);
				if (after === 0) {
					// Before any header: the backend's code, as the routes answer it.
					expect(answer.status, answer.body).toBe(502);
					expect(JSON.parse(answer.body).error.code).toBe("FILE_ACCESS_FAILED");
				} else {
					// After the headers: the socket ends short of what it promised.
					expect(answer.status).toBe(200);
					expect(answer.got).toBeLessThan(200_000);
				}
			} finally {
				await server.close();
			}
		}
		expect(logs.join("\n")).not.toContain(SECRET);
	});

	describe.runIf(execKind(machineStyle).runs)("an exec read without its second look", () => {
		/** The read script's output with its last line (the second look) removed or replaced. */
		const lastLine = (replacement: string) => (stdout: Buffer) => {
			const text = stdout.toString("latin1");
			// Only the read's output is long; the look's few lines are left alone.
			if (text.length < 1000) return stdout;
			const match = /\r?\n(\d+) (-?\d+)\r?\n?$/.exec(text);
			if (!match) return stdout;
			return Buffer.from(`${text.slice(0, match.index)}${replacement}`, "latin1");
		};
		it("an exec read whose first look changed: 409", async () => {
			// The read script's own first look, after its marker, says another size.
			const otherSize = (stdout: Buffer) => {
				const text = stdout.toString("latin1");
				if (text.length < 1000) return stdout;
				return Buffer.from(
					text.replace(/([0-9a-f]{32}\r?\n)(\d+) /, (_all, marker: string, size: string) => {
						return `${marker}${Number(size) + 1} `;
					}),
					"latin1",
				);
			};
			harness = await execKind(machineStyle).start({ rewriteStdout: otherSize });
			writeFileSync(harness.local("small.bin"), "x".repeat(2000));
			const response = await content(harness, harness.at("small.bin"));
			expect(response.statusCode).toBe(409);
			expect(response.json().error.code).toBe("FILE_CHANGED");
		});

		for (const [variant, replacement] of [
			["missing", ""],
			["malformed", "\n12 abc\n"],
		] as const) {
			it(`small body, line ${variant}: 409`, async () => {
				harness = await execKind(machineStyle).start({ rewriteStdout: lastLine(replacement) });
				writeFileSync(harness.local("small.bin"), "x".repeat(2000));
				const response = await content(harness, harness.at("small.bin"));
				expect(response.statusCode).toBe(409);
				expect(response.json().error.code).toBe("FILE_CHANGED");
			});

			it(`large body, line ${variant}: socket cut before the held bytes`, async () => {
				harness = await execKind(machineStyle).start({ rewriteStdout: lastLine(replacement) });
				writeFileSync(harness.local("big.bin"), randomBytes(MiB));
				const { got, promised } = await pausedDownload(harness, "big.bin", async () => {});
				expect(promised).toBe(MiB);
				expect(got).toBeLessThanOrEqual(MiB - 65536);
			});
		}
	});

	it.runIf(execKind(machineStyle).runs)(
		"a marker past 64 KiB of prelude is not looked for",
		async () => {
			harness = await execKind(machineStyle).start({ prelude: `${"p".repeat(66_000)}\n` });
			writeFileSync(harness.local("f.bin"), "content");
			const response = await content(harness, harness.at("f.bin"));
			expect(response.statusCode).toBe(502);
			expect(response.json().error.code).toBe("FILE_ACCESS_FAILED");
		},
	);

	it("many SFTP downloads leave no listener behind on the session", async () => {
		harness = await sftpKind("posix").start();
		writeFileSync(harness.local("f.bin"), randomBytes(200_000));
		const warnings: string[] = [];
		const onWarning = (warning: Error) => warnings.push(warning.name);
		process.on("warning", onWarning);
		try {
			for (let i = 0; i < 15; i++) {
				const response = await content(harness, harness.at("f.bin"));
				expect(response.statusCode).toBe(200);
			}
			await new Promise((resolve) => setImmediate(resolve));
		} finally {
			process.off("warning", onWarning);
		}
		expect(warnings).not.toContain("MaxListenersExceededWarning");
	});

	it("a small file changed between its looks answers 409", async () => {
		harness = await LOCAL.start();
		const h = harness;
		writeFileSync(h.local("small.bin"), "0123456789");
		h.beforeRecheck(async (path) => {
			await appendFile(path, "x");
		});
		const response = await content(h, h.at("small.bin"));
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe("FILE_CHANGED");
	});

	it("a file swapped after lstat is refused", async () => {
		harness = await LOCAL.start();
		const h = harness;
		writeFileSync(h.local("f.bin"), randomBytes(1000));
		writeFileSync(h.local("other.bin"), randomBytes(1000));
		// Swapped: another file under the same name, same size and time, so only
		// its identity tells them apart.
		const at = new Date(2010, 0, 1);
		utimesSync(h.local("f.bin"), at, at);
		utimesSync(h.local("other.bin"), at, at);
		h.between(async () => {
			renameSync(h.local("other.bin"), h.local("f.bin"));
		});
		const swapped = await content(h, h.at("f.bin"));
		expect(swapped.statusCode).toBe(409);
		expect(swapped.json().error.code).toBe("FILE_CHANGED");
		// Rewritten in place to another size.
		h.between(async (path) => {
			truncateSync(path, 10);
		});
		const rewritten = await content(h, h.at("f.bin"));
		expect(rewritten.json().error.code).toBe("FILE_CHANGED");
		// Touched to another time, the same size.
		h.between(async (path) => {
			utimesSync(path, new Date(2000, 0, 1), new Date(2000, 0, 1));
		});
		const touched = await content(h, h.at("f.bin"));
		expect(touched.json().error.code).toBe("FILE_CHANGED");
	});

	it("sftp without fstat", async () => {
		let grow: (() => Promise<void>) | null = null;
		harness = await sftpKind("posix").start({
			fstat: false,
			sftpBeforeRecheck: async () => {
				await grow?.();
			},
		});
		const h = harness;
		const bytes = randomBytes(300_000);
		writeFileSync(h.local("f.bin"), bytes);
		const response = await content(h, h.at("f.bin"));
		expect(response.statusCode).toBe(200);
		expect(response.rawPayload.equals(bytes)).toBe(true);
		// The second look, by STAT, sees a change: a small body is refused.
		writeFileSync(h.local("small.bin"), "0123456789");
		grow = () => appendFile(h.local("small.bin"), "x");
		const changed = await content(h, h.at("small.bin"));
		expect(changed.statusCode).toBe(409);
		expect(changed.json().error.code).toBe("FILE_CHANGED");
	});

	it("refused paths reach no backend", async () => {
		let opened = 0;
		const real = new LocalReadBackend();
		const files = new HostFilesService({
			channelHost: () => ({ hostId: "local", hostType: "local" }),
			hostOs: () => null,
			sshHost: () => null,
			local: {
				backend: new LocalFileBackend(),
				os: localHostOs(),
				read: {
					open: (path) => {
						opened++;
						return real.open(path);
					},
				},
			},
		});
		const server = await serverFor(files);
		try {
			const refused = windowsMachine
				? ["relative\\x", "C:\\a\\..\\b", "C:\\%USERPROFILE%\\x"]
				: ["relative/x", "/a/../b", "~/x"];
			for (const path of refused) {
				const response = await server.inject({
					method: "GET",
					url: `/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(path)}`,
				});
				expect(response.statusCode, path).toBe(400);
			}
			expect(opened).toBe(0);
		} finally {
			await server.close();
		}
	});

	it.runIf(!windowsMachine)("a FIFO is not a regular file", async () => {
		harness = await LOCAL.start();
		execFileSync("mkfifo", [harness.local("pipe")]);
		const response = await content(harness, harness.at("pipe"));
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe("NOT_A_FILE");
	});

	it.runIf(windowsMachine)(
		"an exec Windows file reparse point is read as a file",
		async (context) => {
			harness = await execKind("windows").start();
			writeFileSync(harness.local("target.txt"), "through the link");
			try {
				symlinkSync(harness.local("target.txt"), harness.local("link.txt"), "file");
			} catch {
				// Making a file symlink needs a privilege this account may not hold.
				context.skip();
			}
			const response = await content(harness, harness.at("link.txt"));
			expect(response.statusCode).toBe(200);
			expect(response.body).toBe("through the link");
		},
	);

	it.runIf(execKind(machineStyle).runs)("exec read after a prelude", async () => {
		harness = await execKind(machineStyle).start({
			prelude: "Welcome to the host\nlasterm-read-not\n",
		});
		const bytes = randomBytes(200_000);
		writeFileSync(harness.local("f.bin"), bytes);
		const response = await content(harness, harness.at("f.bin"));
		expect(response.statusCode).toBe(200);
		expect(response.rawPayload.equals(bytes)).toBe(true);
	});

	it("sftp lstat and fstat disagree", async () => {
		let local: (name: string) => string = (name) => name;
		harness = await sftpKind("posix").start({
			sftpBetween: async () => {
				await appendFile(local("f.bin"), "grown");
			},
		});
		const h = harness;
		local = (name) => h.local(name);
		writeFileSync(h.local("f.bin"), randomBytes(1000));
		const response = await content(h, h.at("f.bin"));
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe("FILE_CHANGED");
	});

	it("sftp read holds its session", async () => {
		// An idle close of 200 ms, and a client that stops reading for 800 ms.
		harness = await sftpKind("posix").start({ sftpIdleMs: 200 });
		const h = harness;
		const bytes = randomBytes(16 * MiB);
		writeFileSync(h.local("huge.bin"), bytes);
		const { got, promised } = await pausedDownload(h, "huge.bin", async () => {
			// A listing takes the session and gives it back meanwhile: unless the
			// paused read holds it, the idle close then runs under that read.
			await h.list();
			await new Promise((resolve) => setTimeout(resolve, 800));
		});
		expect(promised).toBe(16 * MiB);
		expect(got).toBe(promised);
	});

	it("the ETag carries the backend's unit of time", () => {
		expect(etagOf({ size: 3, mtime: "1732190000123", unit: "ms" })).toBe('"3-ms1732190000123"');
		// Windows ticks are past 2^53: kept exact, never rounded.
		expect(etagOf({ size: 3, mtime: "639309069371006125", unit: "t" })).toBe(
			'"3-t639309069371006125"',
		);
	});
});

void vi;
