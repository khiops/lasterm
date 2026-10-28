import { describe, expect, it } from "vitest";
import { sshConfigEntryFromWire } from "./ssh-config.js";

describe("an SSH config entry, as the hub sends it (#757)", () => {
	it("is read in camelCase, identity file and git host included", () => {
		expect(
			sshConfigEntryFromWire({
				name: "github",
				hostname: "github.com",
				port: 22,
				user: "git",
				identity_file: "~/.ssh/id_github",
				proxy_jump: "bastion",
				is_git_host: true,
			}),
		).toEqual({
			name: "github",
			hostname: "github.com",
			port: 22,
			user: "git",
			identityFile: "~/.ssh/id_github",
			proxyJump: "bastion",
			isGitHost: true,
		});
	});
});
