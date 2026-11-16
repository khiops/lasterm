import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import {
	identityAgentIsNone,
	parseSshConfig,
	resolveConnectTimeout,
	resolveIdentityAgent,
	sshConfigConnectTimeout,
} from "./ssh-config-parser.js";

describe("SSH Config Parser", () => {
	// An IdentityFile counts only when its file exists (#1038): the keys the
	// cases below name are made in a home of their own.
	const home = makeTempDir("lasterm-ssh-config-");
	for (const key of [".ssh/id_ed25519", ".ssh/id_rsa", "my-keys/id_rsa", "abs/id_rsa"]) {
		mkdirSync(join(home, key, ".."), { recursive: true });
		writeFileSync(join(home, key), "not a real key\n");
	}
	const absoluteKey = join(home, "abs", "id_rsa");

	afterAll(async () => {
		await removeTempDir(home);
	});

	it("parses a simple host block", () => {
		const config = `
Host myserver
  HostName 192.168.1.100
  User admin
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("myserver");
		expect(result.entries[0]?.hostname).toBe("192.168.1.100");
		expect(result.entries[0]?.user).toBe("admin");
		expect(result.entries[0]?.port).toBe(22);
		expect(result.entries[0]?.isGitHost).toBe(false);
		expect(result.hasInclude).toBe(false);
	});

	it("parses multiple host blocks", () => {
		const config = `
Host server1
  HostName 10.0.0.1
  User root

Host server2
  HostName 10.0.0.2
  User deploy
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0]?.name).toBe("server1");
		expect(result.entries[0]?.hostname).toBe("10.0.0.1");
		expect(result.entries[1]?.name).toBe("server2");
		expect(result.entries[1]?.hostname).toBe("10.0.0.2");
	});

	it("handles HostName, Port, User, IdentityFile, ProxyJump", () => {
		const config = `
Host full-config
  HostName example.com
  Port 2222
  User deploy
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion.example.com
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry?.name).toBe("full-config");
		expect(entry?.hostname).toBe("example.com");
		expect(entry?.port).toBe(2222);
		expect(entry?.user).toBe("deploy");
		expect(entry?.identityFile).toBe(resolve(home, ".ssh/id_ed25519"));
		expect(entry?.proxyJump).toBe("bastion.example.com");
	});

	it("skips wildcard hosts (Host *)", () => {
		const config = `
Host *
  ServerAliveInterval 60
  ServerAliveCountMax 3

Host myserver
  HostName 10.0.0.1
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("myserver");
	});

	it("detects git hosts by hostname", () => {
		const config = `
Host gh
  HostName github.com
  User git
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.isGitHost).toBe(true);
	});

	it("detects git hosts by alias", () => {
		const config = `
Host github.com
  User git
  IdentityFile ~/.ssh/github_key
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.isGitHost).toBe(true);
	});

	it("detects Include directives", () => {
		const config = `
Include config.d/*

Host myserver
  HostName 10.0.0.1
`;
		const result = parseSshConfig(config, home);
		expect(result.hasInclude).toBe(true);
		expect(result.entries).toHaveLength(1);
	});

	it("handles empty/comment-only input", () => {
		const config = `
# This is a comment
# Another comment

`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(0);
		expect(result.hasInclude).toBe(false);
	});

	it("handles malformed port (non-numeric)", () => {
		const config = `
Host badport
  HostName example.com
  Port abc
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.port).toBe(22); // default preserved
	});

	// Mutation: read the value with parseInt again, and `1.5` gives port 1 and
	// `2222abc` port 2222, where OpenSSH refuses the line (#902).
	it.each(["1.5", "2222abc", "0x16", "0", "70000", "2222#office", "2222 extra"])(
		"keeps 22 for the malformed Port %j (#902)",
		(value) => {
			const result = parseSshConfig(`Host badport\n  Port ${value}\n`, home);
			expect(result.entries[0]?.port).toBe(22);
		},
	);

	// OpenSSH ends a line's arguments at a word starting with `#`: `ssh -G`
	// gives port 2222 for this line. Mutation: read the whole value as the port,
	// and the comment turns it into 22.
	it("reads the port of a Port line ending in a comment, as OpenSSH does (#902)", () => {
		const result = parseSshConfig("Host office\n  Port 2222 # office firewall\n", home);
		expect(result.entries[0]?.port).toBe(2222);
	});

	it("resolves ~ in IdentityFile paths", () => {
		const config = `
Host tilde-test
  IdentityFile ~/my-keys/id_rsa
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.identityFile).toBe(resolve(home, "my-keys/id_rsa"));
	});

	it("handles multiple patterns on one Host line", () => {
		const config = `
Host web1 web2 web3
  HostName 10.0.0.1
  User deploy
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(3);
		expect(result.entries[0]?.name).toBe("web1");
		expect(result.entries[1]?.name).toBe("web2");
		expect(result.entries[2]?.name).toBe("web3");
		// All should share the same settings
		for (const entry of result.entries) {
			expect(entry.hostname).toBe("10.0.0.1");
			expect(entry.user).toBe("deploy");
		}
	});

	it("is case-insensitive for directives", () => {
		const config = `
Host case-test
  HOSTNAME example.com
  PORT 3333
  USER admin
  IDENTITYFILE ~/.ssh/id_rsa
  PROXYJUMP bastion
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry?.hostname).toBe("example.com");
		expect(entry?.port).toBe(3333);
		expect(entry?.user).toBe("admin");
		expect(entry?.identityFile).toBe(resolve(home, ".ssh/id_rsa"));
		expect(entry?.proxyJump).toBe("bastion");
	});

	it("skips wildcard patterns but keeps non-wildcard on same Host line", () => {
		const config = `
Host *.example.com myserver
  HostName 10.0.0.1
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("myserver");
	});

	it("detects all known git hosts", () => {
		const config = `
Host gitlab.com
  User git

Host bitbucket.org
  User git

Host azure-devops
  HostName ssh.dev.azure.com

Host vs-ssh
  HostName vs-ssh.visualstudio.com
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(4);
		for (const entry of result.entries) {
			expect(entry.isGitHost).toBe(true);
		}
	});

	it("handles Host line with = separator", () => {
		const config = `
Host=eqtest
  HostName=example.com
  Port=4444
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("eqtest");
		expect(result.entries[0]?.hostname).toBe("example.com");
		expect(result.entries[0]?.port).toBe(4444);
	});

	it("handles empty input", () => {
		const result = parseSshConfig("", home);
		expect(result.entries).toHaveLength(0);
		expect(result.hasInclude).toBe(false);
	});

	it("handles absolute IdentityFile path without resolving", () => {
		const config = `
Host abs-path
  IdentityFile ${absoluteKey}
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.identityFile).toBe(absoluteKey);
	});

	it("handles alias-only Host block (no HostName directive)", () => {
		// When a Host block has no HostName, the alias is NOT treated as a hostname.
		// hostname should be undefined; the caller uses the alias as the connect target.
		const config = `
Host myalias
  User admin
  Port 2222
`;
		const result = parseSshConfig(config, home);
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry?.name).toBe("myalias");
		expect(entry?.hostname).toBeNull();
		expect(entry?.user).toBe("admin");
		expect(entry?.port).toBe(2222);
	});

	// ─── Resolved as ssh resolves it (#1038) ───────────────────────────────────

	/** The entries of `lines`, keyed by alias, each reduced to the fields asked for. */
	function resolved(lines: string[]) {
		return Object.fromEntries(
			parseSshConfig(lines.join("\n"), home).entries.map((entry) => [entry.name, entry]),
		);
	}

	it("keeps the first value even from a generic block", () => {
		const { "box.lan": box } = resolved([
			"Host *.lan",
			"  HostName gen.example",
			"  ProxyJump j1",
			"Host box.lan",
			"  HostName lit.example",
			"  ProxyJump j2",
		]);
		expect(box).toMatchObject({ hostname: "gen.example", proxyJump: "j1" });
	});

	it("reads none in any case as no key and no jump", () => {
		const entries = resolved([
			"Host a",
			"  IdentityFile none",
			"Host b",
			"  IdentityFile NoNe",
			"Host c",
			"  ProxyJump NONE",
			"Host a c",
			"  IdentityFile ~/.ssh/id_rsa",
			"  ProxyJump gw",
		]);
		expect(entries.a?.identityFile).toBe(resolve(home, ".ssh/id_rsa"));
		expect(entries.b?.identityFile).toBeNull();
		expect(entries.c?.proxyJump).toBeNull();
	});

	it("lets the first of ProxyCommand and ProxyJump decide the jump", () => {
		const entries = resolved([
			"Host a",
			"  ProxyCommand none",
			"Host b",
			"  ProxyCommand nc %h %p",
			"Host c",
			"  ProxyJump gw",
			"  ProxyCommand none",
			"Host *",
			"  ProxyJump gw",
		]);
		expect(entries.a?.proxyJump).toBeNull();
		expect(entries.b?.proxyJump).toBeNull();
		expect(entries.c?.proxyJump).toBe("gw");
	});

	it("skips a malformed Port line for the next one", () => {
		const entries = resolved([
			"Host a",
			"  Port 2222abc",
			"Host b",
			"  Port 22",
			"Host a b",
			"  Port 2300",
			"Host c",
			"  Port 2222abc",
		]);
		expect(entries.a?.port).toBe(2300);
		expect(entries.b?.port).toBe(22);
		expect(entries.c?.port).toBe(22);
	});

	it("splits lines as ssh does: comments, quotes, spaced =, escapes", () => {
		const entries = resolved([
			"Host a # production",
			"  User deploy # account",
			"  Port = 2222",
			"  ProxyJump gw # office",
			'Host "q"',
			'  Port "2201"',
			'  User "a b"',
			'  ProxyJump "j1"',
			"Host r",
			"  User 'c d'",
			'  HostName x"y"',
			"Host s",
			"  User DOMAIN\\alice",
			"Host e1",
			'  User a\\"b',
			"Host e2",
			"  User a\\'b",
			"Host e3",
			"  User a\\\\b",
			"Host h",
			'  User "#x"',
			"Host h2",
			'  User "a #b"',
			"Host u",
			'  User "a b',
			"  User ok",
			"Host v",
			"  User one two",
			"  HostName h1 h2",
			"  User three",
		]);
		expect(Object.keys(entries)).toEqual([
			"a",
			"q",
			"r",
			"s",
			"e1",
			"e2",
			"e3",
			"h",
			"h2",
			"u",
			"v",
		]);
		expect(entries.a).toMatchObject({ user: "deploy", port: 2222, proxyJump: "gw" });
		expect(entries.q).toMatchObject({ user: "a b", port: 2201, proxyJump: "j1" });
		expect(entries.r).toMatchObject({ user: "c d", hostname: "xy" });
		expect(entries.s?.user).toBe("DOMAIN\\alice");
		expect(entries.e1?.user).toBe('a"b');
		expect(entries.e2?.user).toBe("a'b");
		expect(entries.e3?.user).toBe("a\\b");
		expect(entries.h?.user).toBe("#x");
		expect(entries.h2?.user).toBe("a #b");
		expect(entries.u?.user).toBe("ok");
		expect(entries.v).toMatchObject({ user: "three", hostname: null });
	});

	it("expands %h and %% in HostName as ssh does", () => {
		const entries = resolved([
			"Host d",
			"  HostName %%h",
			"Host c",
			'  HostName "%h.x"',
			"Host Up",
			"  HostName %h.example.com",
			"Host EthX",
			"  HostName fe80::1%%%h",
		]);
		expect(entries.d?.hostname).toBe("%h");
		expect(entries.c?.hostname).toBe("c.x");
		expect(entries.Up?.hostname).toBe("Up.example.com");
		expect(entries.EthX?.hostname).toBe("fe80::1%EthX");
	});

	it("lists only the aliases a Host line applies to", () => {
		expect(parseSshConfig("Host foo !foo\n  User x\n", home).entries).toEqual([]);
		expect(parseSshConfig("Host * !skip\n  User x\n", home).entries).toEqual([]);
		expect(parseSshConfig("Host a b\n", home).entries.map((entry) => entry.name)).toEqual([
			"a",
			"b",
		]);
		expect(resolved(["Host w?b", "  User q", "Host web"]).web?.user).toBe("q");
	});

	it("detects a git host by a HostName from another block", () => {
		expect(resolved(["Host gh", "Host g?", "  HostName github.com"]).gh?.isGitHost).toBe(true);
	});

	it("detects Include in a part that applies to no alias", () => {
		expect(parseSshConfig("Match all\n  Include extra\nHost a\n", home).hasInclude).toBe(true);
	});

	it("lists a ProxyJump URI in the form the jump reads", () => {
		const entries = resolved([
			"Host t",
			"  ProxyJump ssh://jump@bastion.example:2222",
			"Host u",
			"  ProxyJump ssh://bastion.example/",
			"Host v",
			"  ProxyJump ssh://a@h1,ssh://h2:2200",
		]);
		expect(entries.t?.proxyJump).toBe("jump@bastion.example:2222");
		expect(entries.u?.proxyJump).toBe("bastion.example");
		expect(entries.v?.proxyJump).toBe("a@h1,h2:2200");
	});
});

// `IdentityAgent none` keeps the agent from signing a key-auth host's key (#876).
describe("resolveIdentityAgent", () => {
	it("gives the value of the alias's own block", () => {
		const config = "Host box\n  HostName 10.0.0.5\n  IdentityAgent none\n";
		expect(resolveIdentityAgent(config, "box")).toBe("none");
	});

	it("gives none for an alias no block names", () => {
		expect(resolveIdentityAgent("Host other\n  IdentityAgent none\n", "box")).toBeNull();
	});

	it("keeps the first value obtained, as ssh(1) does", () => {
		const config = [
			"Host box",
			"  IdentityAgent none",
			"Host *",
			"  IdentityAgent ~/.agent.sock",
		].join("\n");
		expect(resolveIdentityAgent(config, "box")).toBe("none");
		expect(resolveIdentityAgent(config, "other")).toBe("~/.agent.sock");
	});

	it("reads the lines before any Host as applying to every host", () => {
		expect(resolveIdentityAgent("IdentityAgent none\nHost box\n  User me\n", "box")).toBe("none");
	});

	it("takes wildcards, several patterns and negations", () => {
		const config = "Host web-* !web-public db\n  IdentityAgent none\n";
		expect(resolveIdentityAgent(config, "web-01")).toBe("none");
		expect(resolveIdentityAgent(config, "db")).toBe("none");
		// ssh matches Host patterns case-sensitively (#1038)
		expect(resolveIdentityAgent(config, "DB")).toBeNull();
		expect(resolveIdentityAgent(config, "web-public")).toBeNull();
	});

	it("reads Key=Value, a quoted value, and CRLF line ends", () => {
		expect(resolveIdentityAgent('Host box\r\n  IdentityAgent="none"\r\n', "box")).toBe("none");
	});

	it("matches Host patterns case-sensitively, as ssh does", () => {
		const config = "Host Web\n  IdentityAgent none\n";
		expect(resolveIdentityAgent(config, "web")).toBeNull();
		expect(resolveIdentityAgent(config, "Web")).toBe("none");
		expect(resolveIdentityAgent('Host "box"\n  IdentityAgent = none # account\n', "box")).toBe(
			"none",
		);
	});

	it("does not evaluate a Match block, and counts it as not applying", () => {
		const config = "Match host box\n  IdentityAgent none\nHost box\n  User me\n";
		expect(resolveIdentityAgent(config, "box")).toBeNull();
	});
});

describe("identityAgentIsNone", () => {
	const home = makeTempDir("lasterm-identity-agent-");
	mkdirSync(join(home, ".ssh"));
	writeFileSync(
		join(home, ".ssh", "config"),
		"Host box\n  IdentityAgent NONE\nHost forwarded\n  IdentityAgent SSH_AUTH_SOCK\n",
	);
	const empty = makeTempDir("lasterm-identity-agent-empty-");

	afterAll(async () => {
		await removeTempDir(home);
		await removeTempDir(empty);
	});

	it("is true for IdentityAgent none in the alias's block, whatever its case", () => {
		expect(identityAgentIsNone("box", home)).toBe(true);
	});

	it("is false for another value, or none at all", () => {
		expect(identityAgentIsNone("forwarded", home)).toBe(false);
		expect(identityAgentIsNone("elsewhere", home)).toBe(false);
	});

	it("is false where there is no ~/.ssh/config to read", () => {
		expect(identityAgentIsNone("box", empty)).toBe(false);
	});
});

// A host without a connection timeout of its own takes ConnectTimeout from
// ~/.ssh/config, never under the hub's own 20 s and never over 120 s (#1034).
describe("resolveConnectTimeout", () => {
	const of = (line: string): number | null => resolveConnectTimeout(`Host box\n  ${line}\n`, "box");

	it("reads ConnectTimeout in the forms Lasterm takes, never under 20 s (#1034)", () => {
		const expected: Array<[string, number | null]> = [
			["ConnectTimeout 25", 25],
			["ConnectTimeout=25", 25],
			["ConnectTimeout = 25 # slow", 25],
			['ConnectTimeout "25"', 25],
			["ConnectTimeout '25'", 25],
			["ConnectTimeout 25.5", null],
			["ConnectTimeout 1m", 60],
			["ConnectTimeout 1m30s", 90],
			["ConnectTimeout 2M", 120],
			["ConnectTimeout 1h", 120],
			["ConnectTimeout 1H", 120],
			["ConnectTimeout 1d", 120],
			["ConnectTimeout 1D", 120],
			["ConnectTimeout 1w", 120],
			["ConnectTimeout 1W", 120],
			["ConnectTimeout 1S", null],
			["ConnectTimeout 20S", 20],
			["ConnectTimeout 300", 120],
			["ConnectTimeout 20", 20],
			["ConnectTimeout 19", null],
			["ConnectTimeout 5", null],
			["ConnectTimeout 0", null],
			["ConnectTimeout none", null],
			["ConnectTimeout abc", null],
			["ConnectTimeout 25 30", null],
			["connecttimeout 25", 25],
		];
		expect(expected.map(([line]) => [line, of(line)])).toEqual(expected);
	});

	it("applies Host *, lines before any Host, and the first value only (#1034)", () => {
		expect(resolveConnectTimeout("Host *\n  ConnectTimeout 40\n", "box")).toBe(40);
		expect(resolveConnectTimeout("ConnectTimeout 40\nHost box\n  User me\n", "box")).toBe(40);
		expect(
			resolveConnectTimeout("Host box\n  ConnectTimeout 30\nHost *\n  ConnectTimeout 90\n", "box"),
		).toBe(30);
	});

	it("ignores Match blocks, other hosts and negated patterns (#1034)", () => {
		expect(resolveConnectTimeout("Match host box\n  ConnectTimeout 40\n", "box")).toBeNull();
		expect(resolveConnectTimeout("Host other\n  ConnectTimeout 40\n", "box")).toBeNull();
		expect(resolveConnectTimeout("Host box !box\n  ConnectTimeout 40\n", "box")).toBeNull();
	});

	it("gives none where there is no ~/.ssh/config to read (#1034)", async () => {
		const empty = makeTempDir("lasterm-connect-timeout-empty-");
		try {
			expect(sshConfigConnectTimeout(["box"], empty)).toBeNull();
		} finally {
			await removeTempDir(empty);
		}
	});
});
