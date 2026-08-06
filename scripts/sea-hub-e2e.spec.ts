/**
 * sea-hub-e2e.spec.ts
 *
 * End-to-end tests that validate the lasterm-hub SEA binary works correctly.
 *
 * Prerequisites:
 *   pnpm run package:sea-hub   (builds dist/sea/lasterm-hub)
 *
 * All tests skip gracefully when the binary has not been built yet.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEA_DIR = join(ROOT, "dist", "sea");
const SEA_BINARY = join(SEA_DIR, process.platform === "win32" ? "lasterm-hub.exe" : "lasterm-hub");
const AGENT_BINARY = join(
	SEA_DIR,
	process.platform === "win32" ? "lasterm-agent.exe" : "lasterm-agent",
);

// ─── Availability ─────────────────────────────────────────────────────────────

/** True when the hub SEA binary has been built and is executable. */
function isBinaryAvailable(): boolean {
	if (!existsSync(SEA_BINARY)) return false;
	try {
		accessSync(SEA_BINARY, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** SEA E2E tests only run in CI (after build-sea produces a fresh binary).
 *  Locally the binary may be stale/incompatible — skip to avoid 7× 30s timeouts. */
const RUN_SEA_TESTS = !!process.env.CI && isBinaryAvailable();

// ─── Types ────────────────────────────────────────────────────────────────────

interface HubProcess {
	proc: ChildProcess;
	port: number;
	stateDir: string;
	configDir: string;
	baseUrl: string;
	kill(): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pick a random port in the ephemeral range to avoid conflicts. */
function randomPort(): number {
	return 49_000 + Math.floor(Math.random() * 16_000);
}

/**
 * Poll a URL until it returns a 2xx status or the timeout expires.
 * Returns the response on success, throws on timeout.
 */
async function pollUntilReady(
	url: string,
	timeoutMs = 30_000,
	intervalMs = 300,
): Promise<Response> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			if (res.ok) return res;
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	throw new Error(
		`Hub at ${url} did not become ready within ${timeoutMs}ms. Last error: ${String(lastErr)}`,
	);
}

/**
 * Spawn the lasterm-hub SEA binary in foreground mode on a random port,
 * wait for /api/health to respond, then return a handle.
 */
async function startHub(extraEnv: Record<string, string> = {}): Promise<HubProcess> {
	const port = randomPort();
	const stateDir = mkdtempSync(join(tmpdir(), "lasterm-hub-state-"));
	const configDir = mkdtempSync(join(tmpdir(), "lasterm-hub-config-"));

	const env: NodeJS.ProcessEnv = {
		...process.env,
		XDG_STATE_HOME: stateDir,
		XDG_CONFIG_HOME: configDir,
		LASTERM_PORT: String(port),
		// Disable browser opening during tests
		LASTERM_OPEN: "0",
		// Suppress any TTY-related output noise
		NO_COLOR: "1",
		...extraEnv,
	};

	const proc = spawn(SEA_BINARY, ["start"], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Collect stderr for diagnostics — don't let it block
	const stderrLines: string[] = [];
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderrLines.push(chunk.toString());
	});

	const baseUrl = `http://127.0.0.1:${port}`;

	// Wait for hub to be ready; kill on failure to avoid orphaned processes
	try {
		await pollUntilReady(`${baseUrl}/api/health`, 30_000);
	} catch (err) {
		proc.kill("SIGKILL");
		throw new Error(
			`Hub failed to start on port ${port}.\n` +
				`stderr: ${stderrLines.join("")}\n` +
				`original: ${String(err)}`,
		);
	}

	// Widen to EventEmitter-compatible type so .once/.on are available
	const procEE = proc as unknown as import("node:events").EventEmitter & {
		exitCode: number | null;
		kill(signal?: string): boolean;
	};

	const kill = (): Promise<void> =>
		new Promise((resolve) => {
			if (procEE.exitCode !== null) {
				resolve();
				return;
			}
			procEE.once("exit", () => resolve());
			procEE.kill("SIGTERM");
			// Force-kill after 5 s if SIGTERM is ignored
			setTimeout(() => {
				if (procEE.exitCode === null) procEE.kill("SIGKILL");
			}, 5_000);
		});

	return { proc, port, stateDir, configDir, baseUrl, kill };
}

/** Read the auth token from the config dir that the hub wrote at startup. */
function readAuthToken(configDir: string): string {
	// configDir is XDG_CONFIG_HOME; hub appends "lasterm/auth.json"
	const authPath = join(configDir, "lasterm", "auth.json");
	const raw = readFileSync(authPath, "utf-8");
	const parsed = JSON.parse(raw) as { token: string };
	return parsed.token;
}

/** Perform a pairing flow: POST /api/pair (authenticated) → POST /api/pair/verify → token. */
async function pairHub(hub: HubProcess): Promise<string> {
	const authToken = readAuthToken(hub.configDir);

	// Generate a pairing code (requires auth)
	const pairRes = await fetch(`${hub.baseUrl}/api/pair`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${authToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({}),
	});
	expect(pairRes.status).toBe(201);
	const pairBody = (await pairRes.json()) as { code: string };
	expect(typeof pairBody.code).toBe("string");
	expect(pairBody.code).toMatch(/^\d{6}$/);

	// Exchange the code for a token (unauthenticated)
	const verifyRes = await fetch(`${hub.baseUrl}/api/pair/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code: pairBody.code }),
	});
	expect(verifyRes.status).toBe(200);
	const verifyBody = (await verifyRes.json()) as { token: string };
	expect(typeof verifyBody.token).toBe("string");
	expect(verifyBody.token.length).toBeGreaterThan(0);

	return verifyBody.token;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("lasterm-hub SEA binary E2E", { timeout: 120_000 }, () => {
	let hub: HubProcess | null = null;

	beforeEach(() => {
		hub = null;
	});

	afterEach(async () => {
		if (hub !== null) {
			await hub.kill();
			// Clean up temp dirs
			rmSync(hub.stateDir, { recursive: true, force: true });
			rmSync(hub.configDir, { recursive: true, force: true });
			hub = null;
		}
	});

	// ── Test 1: binary exists and is executable ───────────────────────────

	it.skipIf(!RUN_SEA_TESTS)("binary exists and is executable", () => {
		expect(existsSync(SEA_BINARY)).toBe(true);

		// Must be executable
		expect(() => accessSync(SEA_BINARY, fsConstants.X_OK)).not.toThrow();

		// Must be > 10 MB (includes the Node.js runtime)
		const stat = statSync(SEA_BINARY);
		expect(stat.size).toBeGreaterThan(10 * 1024 * 1024);
	});

	// ── Test 2: hub starts and responds to /api/health ───────────────────

	it.skipIf(!RUN_SEA_TESTS)(
		"starts and responds to /api/health with status ok",
		{ timeout: 60_000 },
		async () => {
			hub = await startHub();

			const res = await fetch(`${hub.baseUrl}/api/health`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("ok");
		},
	);

	// ── Test 3: hub serves web UI from SEA assets ────────────────────────

	it.skipIf(!RUN_SEA_TESTS)(
		"serves web UI index.html and JS assets from SEA embedded assets",
		{ timeout: 60_000 },
		async () => {
			hub = await startHub();

			// Root path must return HTML containing the Vue app mount point
			const htmlRes = await fetch(`${hub.baseUrl}/`);
			expect(htmlRes.status).toBe(200);

			const contentType = htmlRes.headers.get("content-type") ?? "";
			expect(contentType).toContain("text/html");

			const html = await htmlRes.text();
			expect(html).toContain('<div id="app">');

			// Scan for a JS asset link in the HTML (Vite embeds them as /assets/...)
			const jsMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
			if (jsMatch?.[1]) {
				const jsRes = await fetch(`${hub.baseUrl}${jsMatch[1]}`);
				expect(jsRes.status).toBe(200);
				const jsContentType = jsRes.headers.get("content-type") ?? "";
				expect(jsContentType).toContain("javascript");
			} else {
				// If no JS asset found in the HTML, just verify that the /assets/ path
				// exists by checking that a 404 is returned (not a 500 or crash)
				const assetsRes = await fetch(`${hub.baseUrl}/assets/`);
				// A 404 is fine — proves the server is alive and routing works
				expect([200, 404]).toContain(assetsRes.status);
			}
		},
	);

	// ── Test 4: API requires authentication ──────────────────────────────

	it.skipIf(!RUN_SEA_TESTS)(
		"API routes require authentication — returns 401 without token",
		{ timeout: 60_000 },
		async () => {
			hub = await startHub();

			// Unauthenticated request to a protected endpoint must return 401
			const res = await fetch(`${hub.baseUrl}/api/hosts`);
			expect(res.status).toBe(401);
		},
	);

	// ── Test 5: pairing flow works ────────────────────────────────────────

	it.skipIf(!RUN_SEA_TESTS)(
		"pairing flow: POST /api/pair → /api/pair/verify → authenticated /api/hosts",
		{ timeout: 60_000 },
		async () => {
			hub = await startHub();

			// Complete pairing to obtain an auth token
			const token = await pairHub(hub);

			// The token must work for authenticated requests
			const hostsRes = await fetch(`${hub.baseUrl}/api/hosts`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(hostsRes.status).toBe(200);

			const hosts = (await hostsRes.json()) as unknown[];
			expect(Array.isArray(hosts)).toBe(true);
			expect(hosts).toHaveLength(0); // fresh DB, no hosts configured
		},
	);

	// ── Test 6: hub + agent integration (optional) ───────────────────────

	it.skipIf(!RUN_SEA_TESTS || !existsSync(AGENT_BINARY))(
		"agent binary is co-located with hub binary (resolver can find it)",
		{ timeout: 60_000 },
		async () => {
			// Both binaries must be in the same dist/sea/ directory.
			// The hub's sea-agent-resolver looks next to process.execPath first.
			// In this test we verify the static co-location property — no spawning needed.

			expect(existsSync(AGENT_BINARY)).toBe(true);
			expect(() => accessSync(AGENT_BINARY, fsConstants.X_OK)).not.toThrow();

			// Both must live in the same directory
			const hubDir = join(SEA_BINARY, "..");
			const agentDir = join(AGENT_BINARY, "..");
			expect(resolve(agentDir)).toBe(resolve(hubDir));

			// Start hub with PATH set to include dist/sea/ so the resolver finds agent
			hub = await startHub({ PATH: `${SEA_DIR}:${process.env.PATH ?? ""}` });

			// Hub must still be healthy even with agent binary available
			const res = await fetch(`${hub.baseUrl}/api/health`);
			expect(res.status).toBe(200);

			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("ok");
		},
	);

	// ── Test 7: hub writes auth.json on first start ───────────────────────

	it.skipIf(!RUN_SEA_TESTS)(
		"writes auth.json with a hex token on first start",
		{ timeout: 60_000 },
		async () => {
			hub = await startHub();

			const authPath = join(hub.configDir, "lasterm", "auth.json");
			expect(existsSync(authPath)).toBe(true);

			const raw = readFileSync(authPath, "utf-8");
			const parsed = JSON.parse(raw) as { token?: unknown };
			expect(typeof parsed.token).toBe("string");

			// Token must be a 64-char hex string (32 bytes × 2)
			expect(parsed.token as string).toMatch(/^[0-9a-f]{64}$/);
		},
	);

	// ── Test 8: hub creates databases on startup ──────────────────────────

	it.skipIf(!RUN_SEA_TESTS)(
		"creates meta.db and spool.db in the state directory on startup",
		{ timeout: 60_000 },
		async () => {
			hub = await startHub();

			const metaDb = join(hub.stateDir, "lasterm", "meta.db");
			const spoolDb = join(hub.stateDir, "lasterm", "spool.db");

			expect(existsSync(metaDb)).toBe(true);
			expect(existsSync(spoolDb)).toBe(true);

			// Both must be non-trivial SQLite files (> 4 KB header)
			expect(statSync(metaDb).size).toBeGreaterThan(4096);
			expect(statSync(spoolDb).size).toBeGreaterThan(4096);
		},
	);
});
