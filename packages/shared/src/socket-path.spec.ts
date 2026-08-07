import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSocketPath, probeSocket } from "./socket-path.js";

describe("getSocketPath", () => {
	const originalPlatform = process.platform;
	const originalEnv = { ...process.env };

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	describe.skipIf(process.platform === "win32")("on Linux/macOS", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "linux" });
		});

		it("returns XDG_RUNTIME_DIR path when set", () => {
			process.env.XDG_RUNTIME_DIR = "/run/user/1000";

			const result = getSocketPath();

			expect(result).toBe("/run/user/1000/lasterm/agent.sock");
		});

		it("returns /tmp fallback when XDG_RUNTIME_DIR unset", () => {
			process.env.XDG_RUNTIME_DIR = undefined;
			vi.spyOn(os, "userInfo").mockReturnValue({
				uid: 1234,
				gid: 1234,
				username: "testuser",
				homedir: "/home/testuser",
				shell: "/bin/bash",
			});

			const result = getSocketPath();

			expect(result).toBe("/tmp/lasterm-1234/agent.sock");
		});

		it("returns override path when provided", () => {
			const result = getSocketPath("/custom/path/agent.sock");

			expect(result).toBe("/custom/path/agent.sock");
		});
	});

	describe("on Windows", () => {
		it("returns named pipe path with username", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			vi.spyOn(os, "userInfo").mockReturnValue({
				uid: -1,
				gid: -1,
				username: "alice",
				homedir: "C:\\Users\\alice",
				shell: null,
			});

			const result = getSocketPath();

			expect(result).toBe("\\\\.\\pipe\\lasterm-agent-alice");
		});
	});
});

/** Returns a platform-appropriate socket path for probeSocket tests. */
function makeProbeSocketPath(name: string, tmpDir: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\lasterm-probe-${name}-${process.pid}`;
	}
	return path.join(tmpDir, `${name}.sock`);
}

describe("probeSocket", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "lasterm-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("Given a listening server", () => {
		it("returns true", async () => {
			const socketPath = makeProbeSocketPath("active", tmpDir);
			const server = net.createServer();

			await new Promise<void>((resolve) => {
				server.listen(socketPath, () => resolve());
			});

			try {
				const result = await probeSocket(socketPath);
				expect(result).toBe(true);
			} finally {
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
			}
		});
	});

	describe("Given no server (ENOENT)", () => {
		it("returns false", async () => {
			const socketPath = makeProbeSocketPath("nonexistent", tmpDir);

			const result = await probeSocket(socketPath);

			expect(result).toBe(false);
		});
	});

	describe("Given a stale socket (ECONNREFUSED)", () => {
		it.skipIf(process.platform === "win32")("returns false", async () => {
			const socketPath = makeProbeSocketPath("stale", tmpDir);
			const server = net.createServer();

			// Create a real socket file then close the server to make it stale
			await new Promise<void>((resolve) => {
				server.listen(socketPath, () => resolve());
			});
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});

			const result = await probeSocket(socketPath);

			expect(result).toBe(false);
		});
	});

	describe("Given EACCES (permission denied)", () => {
		it("rejects with an error instead of resolving", async () => {
			const socketPath = path.join(tmpDir, "forbidden.sock");
			const eaccesError: NodeJS.ErrnoException = new Error("connect EACCES");
			eaccesError.code = "EACCES";

			const fakeSocket = new net.Socket();
			vi.spyOn(net, "connect").mockImplementation((() => {
				process.nextTick(() => fakeSocket.emit("error", eaccesError));
				return fakeSocket;
			}) as typeof net.connect);

			await expect(probeSocket(socketPath)).rejects.toThrow(/Permission denied probing socket/);

			vi.restoreAllMocks();
		});
	});
});
