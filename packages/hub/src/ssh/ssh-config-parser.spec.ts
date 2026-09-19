import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSshConfig } from "./ssh-config-parser.js";

describe("SSH Config Parser", () => {
	it("parses a simple host block", () => {
		const config = `
Host myserver
  HostName 192.168.1.100
  User admin
`;
		const result = parseSshConfig(config);
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
		const result = parseSshConfig(config);
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
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry?.name).toBe("full-config");
		expect(entry?.hostname).toBe("example.com");
		expect(entry?.port).toBe(2222);
		expect(entry?.user).toBe("deploy");
		expect(entry?.identityFile).toBe(resolve(homedir(), ".ssh/id_ed25519"));
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
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("myserver");
	});

	it("detects git hosts by hostname", () => {
		const config = `
Host gh
  HostName github.com
  User git
`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.isGitHost).toBe(true);
	});

	it("detects git hosts by alias", () => {
		const config = `
Host github.com
  User git
  IdentityFile ~/.ssh/github_key
`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.isGitHost).toBe(true);
	});

	it("detects Include directives", () => {
		const config = `
Include config.d/*

Host myserver
  HostName 10.0.0.1
`;
		const result = parseSshConfig(config);
		expect(result.hasInclude).toBe(true);
		expect(result.entries).toHaveLength(1);
	});

	it("handles empty/comment-only input", () => {
		const config = `
# This is a comment
# Another comment

`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(0);
		expect(result.hasInclude).toBe(false);
	});

	it("handles malformed port (non-numeric)", () => {
		const config = `
Host badport
  HostName example.com
  Port abc
`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.port).toBe(22); // default preserved
	});

	it("resolves ~ in IdentityFile paths", () => {
		const config = `
Host tilde-test
  IdentityFile ~/my-keys/id_rsa
`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.identityFile).toBe(resolve(homedir(), "my-keys/id_rsa"));
	});

	it("handles multiple patterns on one Host line", () => {
		const config = `
Host web1 web2 web3
  HostName 10.0.0.1
  User deploy
`;
		const result = parseSshConfig(config);
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
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry?.hostname).toBe("example.com");
		expect(entry?.port).toBe(3333);
		expect(entry?.user).toBe("admin");
		expect(entry?.identityFile).toBe(resolve(homedir(), ".ssh/id_rsa"));
		expect(entry?.proxyJump).toBe("bastion");
	});

	it("skips wildcard patterns but keeps non-wildcard on same Host line", () => {
		const config = `
Host *.example.com myserver
  HostName 10.0.0.1
`;
		const result = parseSshConfig(config);
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
		const result = parseSshConfig(config);
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
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.name).toBe("eqtest");
		expect(result.entries[0]?.hostname).toBe("example.com");
		expect(result.entries[0]?.port).toBe(4444);
	});

	it("handles empty input", () => {
		const result = parseSshConfig("");
		expect(result.entries).toHaveLength(0);
		expect(result.hasInclude).toBe(false);
	});

	it("handles absolute IdentityFile path without resolving", () => {
		const config = `
Host abs-path
  IdentityFile /etc/ssh/keys/id_rsa
`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.identityFile).toBe("/etc/ssh/keys/id_rsa");
	});

	it("handles alias-only Host block (no HostName directive)", () => {
		// When a Host block has no HostName, the alias is NOT treated as a hostname.
		// hostname should be undefined; the caller uses the alias as the connect target.
		const config = `
Host myalias
  User admin
  Port 2222
`;
		const result = parseSshConfig(config);
		expect(result.entries).toHaveLength(1);
		const entry = result.entries[0];
		expect(entry?.name).toBe("myalias");
		expect(entry?.hostname).toBeNull();
		expect(entry?.user).toBe("admin");
		expect(entry?.port).toBe(2222);
	});
});
