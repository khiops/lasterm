import { randomBytes } from "node:crypto";
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
import { startHub } from "./hub-startup.js";
import { PreviousInstallationError } from "./previous-installation.js";
import { openTestDatabases } from "./storage/db.js";

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
					openDatabases: () => dbs,
					createServer,
				},
			),
		).rejects.toMatchObject({ code: "AUTH_TOKEN_SWEEP_FAILED" });

		expect(createServer).not.toHaveBeenCalled();
	});
});
