import { describe, expect, it } from "vitest";
import {
	noSshAgentMessage,
	sshAgentAddress,
	WINDOWS_OPENSSH_AGENT_PIPE,
} from "./ssh-agent-address.js";

const noPipe = () => false;
const pipeIsThere = (address: string) => address === WINDOWS_OPENSSH_AGENT_PIPE;

describe("sshAgentAddress", () => {
	it("takes the socket a Unix agent published", () => {
		expect(
			sshAgentAddress({
				env: { SSH_AUTH_SOCK: "/tmp/ssh-XXXX/agent.42" },
				platform: "linux",
				pipeExists: noPipe,
			}),
		).toBe("/tmp/ssh-XXXX/agent.42");
	});

	// Windows' OpenSSH agent is a service on a fixed named pipe and sets no
	// variable: looking only at SSH_AUTH_SOCK declared "no agent" on a machine
	// where `ssh host` had been logging in without a password for months.
	it("finds the Windows agent, which announces itself nowhere", () => {
		expect(sshAgentAddress({ env: {}, platform: "win32", pipeExists: pipeIsThere })).toBe(
			WINDOWS_OPENSSH_AGENT_PIPE,
		);
	});

	// Someone who points it at a Cygwin, Git Bash or forwarded agent means that
	// one, on Windows as anywhere else.
	it("lets SSH_AUTH_SOCK win on Windows too", () => {
		expect(
			sshAgentAddress({
				env: { SSH_AUTH_SOCK: "//./pipe/other-agent" },
				platform: "win32",
				pipeExists: pipeIsThere,
			}),
		).toBe("//./pipe/other-agent");
	});

	it("has no agent to offer when the service is not running", () => {
		expect(sshAgentAddress({ env: {}, platform: "win32", pipeExists: noPipe })).toBeNull();
	});

	it("has no agent to offer when nothing published a socket", () => {
		expect(sshAgentAddress({ env: {}, platform: "linux", pipeExists: noPipe })).toBeNull();
		expect(
			sshAgentAddress({ env: { SSH_AUTH_SOCK: "   " }, platform: "linux", pipeExists: noPipe }),
		).toBeNull();
	});
});

describe("noSshAgentMessage", () => {
	// "No agent" says nothing about what to do next, and the gesture differs.
	it("names the gesture that starts one on this platform", () => {
		expect(noSshAgentMessage("win32")).toContain("OpenSSH Authentication Agent");
		expect(noSshAgentMessage("linux")).toContain("ssh-agent");
	});
});
