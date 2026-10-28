import type { SshConfigEntry } from "@lasterm/shared";

/** An entry of `GET /api/ssh-config` as the hub sends it: snake_case, like its other answers. */
export interface SshConfigWireEntry {
	name: string;
	hostname: string | null;
	port: number;
	user: string | null;
	identity_file: string | null;
	proxy_jump: string | null;
	is_git_host: boolean;
}

/** The hub's answer to `GET /api/ssh-config`. */
export interface SshConfigWireAnswer {
	entries: SshConfigWireEntry[];
	has_include: boolean;
}

/**
 * An entry as the client reads it, in camelCase. The host dialog once kept the
 * entries as they arrived, so it never saw an entry's identity file nor that it
 * was a git host (#757): the dialog and the batch import both read them here.
 */
export function sshConfigEntryFromWire(wire: SshConfigWireEntry): SshConfigEntry {
	return {
		name: wire.name,
		hostname: wire.hostname,
		port: wire.port,
		user: wire.user,
		identityFile: wire.identity_file,
		proxyJump: wire.proxy_jump,
		isGitHost: wire.is_git_host,
	};
}
