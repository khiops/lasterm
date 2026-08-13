import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	createToken,
	sweepNonPrimaryTokens,
	upsertPrimaryToken,
	validateTokenRecord,
} from "./auth.js";
import { getStateDir, loadRuntime } from "./cli.js";
import { startHub } from "./hub-startup.js";
import { PreviousInstallationError } from "./previous-installation.js";
import { openTestDatabases } from "./storage/db.js";

const TEST_TLS_IDENTITY = {
	tls: { cert: "certificate", key: "key" },
	certificate: "certificate",
	spki: "test-spki",
};

// The refusal has to belong to the operation that constructs a hub, not to the
// `start` command handler: the daemon child re-enters through the CLI, `pnpm dev`
// enters through `main.ts`, and both would otherwise take the new lock and serve
// alongside a Termora hub that knows nothing about it.
describe("startHub refuses beside a previous installation", () => {
	it("throws instead of constructing, and takes no authority on the way out", async () => {
		const acquireHubLock = vi.fn();
		const getStateDir = vi.fn(() => "/nonexistent/state");
		const openDatabases = vi.fn();
		const createServer = vi.fn();

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => "Found a Termora installation.",
					acquireHubLock,
					getStateDir,
					openDatabases,
					createServer,
				},
			),
		).rejects.toThrow(PreviousInstallationError);

		// The whole point of the ordering: nothing was claimed, opened or created.
		// If the check ever moves below the lock, this is what notices.
		expect(acquireHubLock).not.toHaveBeenCalled();
		expect(getStateDir).not.toHaveBeenCalled();
		expect(openDatabases).not.toHaveBeenCalled();
		expect(createServer).not.toHaveBeenCalled();
	});

	it("carries the description as the error message, since that text is the diagnosis", async () => {
		const description = "Found a Termora installation. Lasterm will not run beside it:\n  /x/y";
		await expect(
			startHub({ port: 4100 }, { describePreviousInstallation: () => description }),
		).rejects.toThrow(description);
	});

	it("consults the probe before anything else on every call", async () => {
		const describePreviousInstallation = vi.fn(() => "Found a Termora installation.");
		await expect(startHub({ port: 4100 }, { describePreviousInstallation })).rejects.toThrow(
			PreviousInstallationError,
		);
		expect(describePreviousInstallation).toHaveBeenCalledTimes(1);
	});
});

describe("startHub token restart sweep", () => {
	it("leaves no readable runtime record when publication fails after TLS bind", async () => {
		const originalStateRoot = process.env.XDG_STATE_HOME;
		const stateRoot = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);
		process.env.XDG_STATE_HOME = stateRoot;
		const dbs = openTestDatabases();
		try {
			await expect(
				startHub(
					{},
					{
						describePreviousInstallation: () => undefined,
						getStateDir,
						getConfigDir: () => getStateDir(),
						acquireHubLock: () => null as never,
						initAuth: () => randomBytes(32).toString("hex"),
						createOwnerToken: () => "owner-token",
						openDatabases: () => dbs,
						createServer: async () => ({ close: async () => undefined }) as never,
						startServer: async () => "https://127.0.0.1:4321",
						addStartupCorsOrigins: () => 4321,
						persistRuntime: () => {
							throw new Error("injected failure between bind and publish");
						},
					},
				),
			).rejects.toThrow("injected failure between bind and publish");

			expect(loadRuntime()).toEqual({ kind: "absent" });
			expect(existsSync(join(getStateDir(), "runtime.json"))).toBe(false);
		} finally {
			dbs.close();
			rmSync(stateRoot, { recursive: true, force: true });
			process.env.XDG_STATE_HOME = originalStateRoot;
		}
	});

	it("commits the sweep before constructing or binding the server", async () => {
		const dbs = openTestDatabases();
		const primaryToken = randomBytes(32).toString("hex");
		upsertPrimaryToken(dbs.meta, primaryToken);
		const pairing = createToken(dbs.meta, { label: "browser", expiresAt: null });
		const steps: string[] = [];
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);

		await startHub(
			{ port: 4100 },
			{
				describePreviousInstallation: () => undefined,
				getStateDir: () => stateDir,
				getConfigDir: () => stateDir,
				acquireHubLock: () => null as never,
				initAuth: () => primaryToken,
				createOwnerToken: () => "owner-token",
				resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
				openDatabases: () => dbs,
				sweepNonPrimaryTokens: (db) => {
					steps.push("sweep");
					sweepNonPrimaryTokens(db);
				},
				createServer: async () => {
					steps.push("create-server");
					return {} as never;
				},
				startServer: async () => {
					steps.push("listen");
					expect(validateTokenRecord(dbs.meta, pairing.token)).toBeNull();
					return "http://127.0.0.1:4100";
				},
				addStartupCorsOrigins: () => 4100,
				persistRuntime: () => undefined,
				deleteRuntime: () => undefined,
			},
		);

		expect(steps).toEqual(["sweep", "create-server", "listen"]);
		dbs.close();
	});

	it("announces the same SPKI that it published for the TLS listener", async () => {
		const dbs = openTestDatabases();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);
		let announced: { address: string; port: number; spki: string } | undefined;

		await startHub(
			{
				port: 4100,
				announce: (details) => {
					announced = details;
				},
			},
			{
				describePreviousInstallation: () => undefined,
				getStateDir: () => stateDir,
				getConfigDir: () => stateDir,
				acquireHubLock: () => null as never,
				initAuth: () => randomBytes(32).toString("hex"),
				createOwnerToken: () => "owner-token",
				resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
				openDatabases: () => dbs,
				createServer: async () => ({}) as never,
				startServer: async () => "https://127.0.0.1:4100",
				addStartupCorsOrigins: () => 4100,
				persistRuntime: () => undefined,
				deleteRuntime: () => undefined,
			},
		);

		expect(announced).toMatchObject({
			address: "https://127.0.0.1:4100",
			port: 4100,
			spki: TEST_TLS_IDENTITY.spki,
		});
		dbs.close();
	});

	it("refuses startup before server construction when the sweep column is missing", async () => {
		const meta = new Database(":memory:");
		meta.exec(`CREATE TABLE auth_tokens (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT,
			revoked_at TEXT,
			last_used_at TEXT
		)`);
		const spool = new Database(":memory:");
		const createServer = vi.fn();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => null as never,
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => ({
						meta,
						spool,
						close: () => {
							meta.close();
							spool.close();
						},
					}),
					createServer,
				},
			),
		).rejects.toMatchObject({ code: "AUTH_TOKEN_SWEEP_FAILED" });

		expect(createServer).not.toHaveBeenCalled();
	});

	it("refuses startup before server construction when the database is unreadable", async () => {
		const dbs = openTestDatabases();
		dbs.meta.close();
		const createServer = vi.fn();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => null as never,
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => dbs,
					createServer,
				},
			),
		).rejects.toMatchObject({ code: "AUTH_TOKEN_SWEEP_FAILED" });

		expect(createServer).not.toHaveBeenCalled();
	});
});
