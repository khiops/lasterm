/**
 * Where the running SSH agent is to be found.
 *
 * On Unix an agent publishes its socket in `SSH_AUTH_SOCK`, and everything that
 * speaks SSH reads it there. Windows does not: its OpenSSH agent is a service
 * listening on a named pipe, always at the same address, and it sets no
 * variable at all. A hub that only looked at `SSH_AUTH_SOCK` therefore declared
 * "no agent" on the very machine where `ssh host` had been logging in without a
 * password for months (#436).
 *
 * The pipe address is spelled with forward slashes: that is the form ssh2
 * recognises as a pipe rather than a Cygwin socket, and it needs no escaping to
 * survive a config file or a log line.
 */

import { readdirSync } from "node:fs";

/** The address Windows' OpenSSH agent service always listens on. */
export const WINDOWS_OPENSSH_AGENT_PIPE = "//./pipe/openssh-ssh-agent";

/**
 * Whether the Windows agent is listening.
 *
 * `existsSync` cannot answer this: a named pipe does not live in the
 * filesystem, and a stat of one fails whether or not it is there. The pipe
 * namespace does list, though, and a name in that listing is a pipe with
 * something behind it.
 */
export function windowsAgentPipeExists(address: string = WINDOWS_OPENSSH_AGENT_PIPE): boolean {
	const name = address.split(/[/\\]/).pop();
	if (!name) return false;
	try {
		return readdirSync("//./pipe/").includes(name);
	} catch {
		return false;
	}
}

export interface SshAgentLookup {
	/** The environment to read `SSH_AUTH_SOCK` from. */
	env: NodeJS.ProcessEnv;
	/** The platform, as `process.platform` spells it. */
	platform: string;
	/** Whether the Windows agent pipe is there. */
	pipeExists: (address: string) => boolean;
}

/**
 * The agent's address, or null when no agent is reachable.
 *
 * `SSH_AUTH_SOCK` wins wherever it is set, including on Windows: someone who
 * points it at a Cygwin, Git Bash or forwarded agent means that one.
 */
export function sshAgentAddress(lookup: SshAgentLookup): string | null {
	const declared = lookup.env.SSH_AUTH_SOCK?.trim();
	if (declared) return declared;
	if (lookup.platform !== "win32") return null;
	return lookup.pipeExists(WINDOWS_OPENSSH_AGENT_PIPE) ? WINDOWS_OPENSSH_AGENT_PIPE : null;
}

/**
 * What to tell someone whose host asks for agent auth and has no agent.
 *
 * Each platform gets the one gesture that starts one, because "no agent" says
 * nothing about what to do next.
 */
export function noSshAgentMessage(platform: string): string {
	return platform === "win32"
		? "No SSH agent to authenticate with: start the OpenSSH Authentication Agent service, add your key with `ssh-add`, or set SSH_AUTH_SOCK to another agent."
		: "No SSH agent to authenticate with: SSH_AUTH_SOCK is not set. Start an agent (`eval $(ssh-agent)`) and add your key with `ssh-add`.";
}
