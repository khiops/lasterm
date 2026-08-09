import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStateDir, requestHub } from "./cli.js";
import { createServer, startServer } from "./server.js";
import { resolveHubTlsIdentity } from "./tls-identity.js";

describe("generated hub TLS identity", () => {
	let server: Awaited<ReturnType<typeof createServer>> | undefined;
	let stateRoot: string | undefined;
	let originalStateRoot: string | undefined;

	afterEach(async () => {
		if (server) await server.close();
		server = undefined;
		if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
		stateRoot = undefined;
		process.env.XDG_STATE_HOME = originalStateRoot;
	});

	it("serves only through TLS on an OS-assigned port and trusts its recorded identity", async () => {
		originalStateRoot = process.env.XDG_STATE_HOME;
		stateRoot = join(tmpdir(), `lasterm-tls-${randomBytes(8).toString("hex")}`);
		process.env.XDG_STATE_HOME = stateRoot;
		const stateDir = getStateDir();
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const identity = resolveHubTlsIdentity(stateDir, {});
		server = await createServer({ logger: false, tls: identity.tls });
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

		await expect(
			requestHub(
				{ pid: process.pid, port, started_at: new Date().toISOString(), spki: "other-key" },
				"/api/health",
			),
		).rejects.toThrow("does not match runtime SPKI");
	});
});
