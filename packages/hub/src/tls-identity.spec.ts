import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStateDir, requestHub } from "./cli.js";
import { createServer, startServer } from "./server.js";
import {
	certificateSpki,
	HUB_TLS_CERTIFICATE_NAME,
	resolveHubTlsIdentity,
} from "./tls-identity.js";

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

		await expect(
			requestHub(
				{ pid: process.pid, port, started_at: new Date().toISOString(), spki: "other-key" },
				"/api/health",
			),
		).rejects.toThrow("does not match runtime SPKI");
	});

	it("refuses a different leaf even when it chains to the operator bundle CA", async () => {
		originalStateRoot = process.env.XDG_STATE_HOME;
		stateRoot = join(tmpdir(), `lasterm-tls-ca-${randomBytes(8).toString("hex")}`);
		process.env.XDG_STATE_HOME = stateRoot;
		const stateDir = getStateDir();
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });

		const runOpenSsl = (...args: string[]) =>
			execFileSync("openssl", args, { cwd: stateDir, stdio: "pipe" });
		runOpenSsl(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=test-ca",
			"-keyout",
			"ca-key.pem",
			"-out",
			"ca.pem",
		);
		for (const leaf of ["recorded", "other"]) {
			runOpenSsl(
				"req",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-subj",
				`/CN=${leaf}`,
				"-keyout",
				`${leaf}-key.pem`,
				"-out",
				`${leaf}.csr`,
			);
			runOpenSsl(
				"x509",
				"-req",
				"-days",
				"1",
				"-CA",
				"ca.pem",
				"-CAkey",
				"ca-key.pem",
				"-CAcreateserial",
				"-in",
				`${leaf}.csr`,
				"-out",
				`${leaf}.pem`,
			);
		}
		const recordedCertificate = readFileSync(join(stateDir, "recorded.pem"), "utf8");
		const caCertificate = readFileSync(join(stateDir, "ca.pem"), "utf8");
		writeFileSync(join(stateDir, HUB_TLS_CERTIFICATE_NAME), recordedCertificate + caCertificate, {
			mode: 0o600,
		});
		server = await createServer({
			logger: false,
			tls: {
				cert: readFileSync(join(stateDir, "other.pem"), "utf8"),
				key: readFileSync(join(stateDir, "other-key.pem"), "utf8"),
			},
		});
		const port = Number(new URL(await startServer(server)).port);

		await expect(
			requestHub(
				{
					pid: process.pid,
					port,
					started_at: new Date().toISOString(),
					spki: certificateSpki(recordedCertificate),
				},
				"/api/health",
			),
		).rejects.toThrow("peer SPKI does not match runtime.json");
	});
});
