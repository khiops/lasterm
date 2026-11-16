import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";
import { validateSshConfigImportEntries } from "./host-ssh-import.js";

describe("validateSshConfigImportEntries", () => {
	it("accepts true for an explicit daemon choice", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: "a", sshRemoteDaemon: true }],
			}),
		).toEqual({
			entries: [{ name: "a", label: "a", sshRemoteDaemon: true }],
		});
	});

	it("accepts false for an explicit no", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: "a", sshRemoteDaemon: false }],
			}),
		).toEqual({
			entries: [{ name: "a", label: "a", sshRemoteDaemon: false }],
		});
	});

	it("accepts explicit null", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: "a", sshRemoteDaemon: null }],
			}),
		).toEqual({
			entries: [{ name: "a", label: "a", sshRemoteDaemon: null }],
		});
	});

	it("accepts an absent choice for older clients", () => {
		expect(validateSshConfigImportEntries({ entries: [{ name: "a", label: "a" }] })).toEqual({
			entries: [{ name: "a", label: "a" }],
		});
	});

	it("refuses a whitespace-only label", () => {
		expect(validateSshConfigImportEntries({ entries: [{ name: "a", label: "   " }] })).toEqual({
			error: "Label is required",
		});
	});

	it("refuses a label longer than 64 characters after trimming", () => {
		expect(
			validateSshConfigImportEntries({ entries: [{ name: "a", label: "a".repeat(65) }] }),
		).toEqual({ error: "Label must be 64 characters or fewer" });
	});

	it("accepts a 64-character label surrounded by whitespace", () => {
		expect(
			validateSshConfigImportEntries({
				entries: [{ name: "a", label: ` ${"a".repeat(64)} ` }],
			}),
		).toEqual({ entries: [{ name: "a", label: ` ${"a".repeat(64)} ` }] });
	});

	it("accepts SSH config alias characters not accepted by create-host", () => {
		expect(
			validateSshConfigImportEntries({ entries: [{ name: "a", label: "prod+blue" }] }),
		).toEqual({
			entries: [{ name: "a", label: "prod+blue" }],
		});
	});

	it.each(["yes", 1, {}])("refuses a non-boolean, non-null choice: %j", (sshRemoteDaemon) => {
		expect(
			validateSshConfigImportEntries({ entries: [{ name: "a", label: "a", sshRemoteDaemon }] }),
		).toEqual({ error: "sshRemoteDaemon must be a boolean or null when provided" });
	});
});

// ─── The two routes, on a real ~/.ssh/config (#1038) ─────────────────────────
//
// The other route specs replace the parser for the whole file; here the hub
// reads a config written to a temporary home, as it reads the user's own.

/**
 * The fixture whose values `ssh -G -F <file> <alias>` printed with OpenSSH
 * 10.6p1 (Windows) and 10.6p2 (Debian), identical on both:
 * web: user alice, hostname web.example.com, port 2201, identityfile ~/.ssh/star
 * db.internal: user deploy, port 2222, identityfile "~/.ssh/db key" first, proxyjump gw.internal
 * gw.internal: user deploy, port 2222, identityfile ~/.ssh/star, no proxyjump
 * Web: user upper, port 2300, identityfile ~/.ssh/star
 * skip: user local, port 22, the default identity files only
 */
const OPENSSH_FIXTURE = [
	"Host web",
	"  HostName %h.example.com",
	"  User alice",
	"  User bob",
	"Host db.internal",
	'  IdentityFile "~/.ssh/db key"',
	"  IdentityFile ~/.ssh/db2",
	"Host gw.internal",
	"  ProxyJump none",
	"Host web",
	"  Port 2201",
	"  User carol",
	"Host *.internal",
	"  ProxyJump gw.internal",
	"  Port 2222",
	"Host Web",
	"  User upper",
	"Match localuser no-such-user-1038",
	"  User matched",
	"  Port 2399",
	"Host * !skip",
	"  User deploy",
	"  IdentityFile ~/.ssh/star",
	"  Port 2300",
	"Host skip",
	"  User local",
	"",
].join("\n");

describe("GET /api/ssh-config and POST /api/hosts/import, as ssh resolves the file", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let meta: MetaDAL;
	let home: string;

	/** Write `config` as the temporary home's `~/.ssh/config`, beside the key files it names. */
	function writeConfig(config: string, keys: string[] = ["star", "db key"]): void {
		mkdirSync(join(home, ".ssh"), { recursive: true });
		for (const key of keys) writeFileSync(join(home, ".ssh", key), "not a real key\n");
		writeFileSync(join(home, ".ssh", "config"), config);
	}

	async function entries(): Promise<unknown[]> {
		const res = await server.inject({ method: "GET", url: "/api/ssh-config" });
		expect(res.statusCode, res.body).toBe(200);
		return res.json<{ entries: unknown[] }>().entries;
	}

	function entry(name: string, fields: Record<string, unknown>) {
		return {
			name,
			hostname: null,
			port: 22,
			user: null,
			identity_file: null,
			proxy_jump: null,
			is_git_host: false,
			...fields,
		};
	}

	/** The entries `ssh -G` resolves for `OPENSSH_FIXTURE`, as the hub sends them. */
	function fixtureEntries() {
		return [
			entry("web", {
				hostname: "web.example.com",
				port: 2201,
				user: "alice",
				identity_file: resolve(home, ".ssh/star"),
			}),
			entry("db.internal", {
				port: 2222,
				user: "deploy",
				identity_file: resolve(home, ".ssh/db key"),
				proxy_jump: "gw.internal",
			}),
			entry("gw.internal", {
				port: 2222,
				user: "deploy",
				identity_file: resolve(home, ".ssh/star"),
			}),
			entry("Web", { port: 2300, user: "upper", identity_file: resolve(home, ".ssh/star") }),
			entry("skip", { user: "local" }),
		];
	}

	beforeEach(async () => {
		home = makeTempDir("lasterm-1038-home-");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		dbs = openTestDatabases();
		meta = new MetaDAL(dbs.meta);
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
		vi.unstubAllEnvs();
		await removeTempDir(home);
	});

	it("lists each alias once with the values ssh -G resolves", async () => {
		writeConfig(OPENSSH_FIXTURE);
		const res = await server.inject({ method: "GET", url: "/api/ssh-config" });

		expect(res.statusCode, res.body).toBe(200);
		expect(res.json()).toEqual({ entries: fixtureEntries(), has_include: false });
	});

	it("reads a CRLF file as its LF twin", async () => {
		writeConfig(OPENSSH_FIXTURE.replaceAll("\n", "\r\n"));

		expect(await entries()).toEqual(fixtureEntries());
	});

	it("imports each alias with the values ssh -G resolves", async () => {
		writeConfig(OPENSSH_FIXTURE);
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts/import",
			payload: {
				entries: [
					{ name: "web", label: "web" },
					{ name: "db.internal", label: "db" },
					{ name: "gw.internal", label: "gw" },
				],
			},
		});

		expect(res.statusCode, res.body).toBe(201);
		const gw = meta.getHostByLabel("gw");
		expect(meta.getHostByLabel("web")).toMatchObject({
			sshHost: "web.example.com",
			sshPort: 2201,
			sshUser: "alice",
			sshAuth: "key",
			sshKeyPath: resolve(home, ".ssh/star"),
			sshConfigHost: "web",
		});
		expect(meta.getHostByLabel("db")).toMatchObject({
			sshHost: "db.internal",
			sshPort: 2222,
			sshUser: "deploy",
			sshAuth: "key",
			sshKeyPath: resolve(home, ".ssh/db key"),
			sshProxyHostId: gw?.id,
		});
		expect(gw).toMatchObject({
			sshHost: "gw.internal",
			sshPort: 2222,
			sshUser: "deploy",
			sshAuth: "key",
			sshKeyPath: resolve(home, ".ssh/star"),
		});
		// A host stored without a jump has neither field: no link, and no spec,
		// `none` included, that a connection would try to reach.
		for (const label of ["web", "db", "gw"]) {
			expect(meta.getHostByLabel(label)?.sshProxySpec ?? null, label).toBeNull();
		}
		for (const label of ["web", "gw"]) {
			expect(meta.getHostByLabel(label)?.sshProxyHostId ?? null, label).toBeNull();
		}
	});

	it("applies the lines before any Host to every alias", async () => {
		writeConfig(
			[
				"Port 2200",
				"HostName top.example",
				"User top",
				"IdentityFile ~/.ssh/star",
				"ProxyJump top-jump",
				"Host a b",
				"  HostName other",
				"  User other",
				"  Port 2300",
				'  IdentityFile "~/.ssh/db key"',
				"  ProxyJump other-jump",
				"",
			].join("\n"),
		);
		const top = {
			hostname: "top.example",
			user: "top",
			port: 2200,
			identity_file: resolve(home, ".ssh/star"),
			proxy_jump: "top-jump",
		};

		expect(await entries()).toEqual([entry("a", top), entry("b", top)]);
	});

	it("skips an IdentityFile that is missing, holds a token or is not a file", async () => {
		writeConfig(
			[
				"Host a",
				"  IdentityFile ~/.ssh/missing",
				"  IdentityFile ~",
				"  IdentityFile ~/.ssh/%h",
				"  IdentityFile ~/.ssh/${USER}",
				"  IdentityFile ~/.ssh/star",
				"Host b",
				"  IdentityFile ~/.ssh/missing",
				"",
			].join("\n"),
			["star", "%h", "${USER}"],
		);

		expect(await entries()).toEqual([
			entry("a", { identity_file: resolve(home, ".ssh/star") }),
			entry("b", {}),
		]);
	});

	it("unescapes a space in an IdentityFile path", async () => {
		writeConfig("Host t\n  IdentityFile ~/.ssh/review\\ key\n", ["review key"]);

		expect(await entries()).toEqual([
			entry("t", { identity_file: resolve(home, ".ssh/review key") }),
		]);
	});
});
