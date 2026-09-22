/**
 * Reaching a remote agent that outlives its SSH connection.
 *
 * Over stdio the agent is a child of the SSH session: the transport drops and
 * the agent dies, taking every PTY with it. That is why a remote terminal does
 * not survive a hub restart while a local one does (#79).
 *
 * A daemon does not die with the transport. It is started detached, it listens
 * on a socket of its own, and the SSH connection becomes a way to *reach* that
 * socket rather than the thing holding the agent up. `direct-streamlocal`, the
 * OpenSSH channel type behind `ssh -L`, carries the bytes; from the hub's side
 * what comes back is a duplex stream that speaks exactly what the local daemon
 * speaks, so `LastermAgent` drives it unchanged.
 *
 * **Connect before launching, always.** The agent's `bind_with_retry` treats a
 * socket it cannot bind as stale and unlinks it, so a second daemon started on
 * a live one's socket takes its place and leaves it holding PTYs nobody can
 * reach. The order here is the same order the local path uses, and it is what
 * keeps that from happening.
 *
 * Windows remotes are not served by this: their daemon listens on a named pipe,
 * and OpenSSH has no channel type that carries one. They stay on stdio, and
 * their terminals still end with the connection.
 */

import type { Duplex } from "node:stream";
import type { Client } from "ssh2";

/** Where a remote daemon keeps its socket and its log, under one directory. */
export interface RemoteDaemonPaths {
	/** The directory holding both, `0700` so the socket is the owner's alone. */
	dir: string;
	socket: string;
	log: string;
}

/**
 * The shell that resolves those paths on the remote, and prints the directory.
 *
 * It honours `XDG_STATE_HOME` and falls back to `$HOME/.local/state`, which is
 * the rule the agent itself follows — deciding here instead would put the
 * socket somewhere the agent would not have put it.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, read by the remote's shell, not a JavaScript template
export const REMOTE_STATE_DIR_COMMAND = 'printf %s "${XDG_STATE_HOME:-$HOME/.local/state}/lasterm"';

/** What a resolved state directory holds. */
export function remoteDaemonPaths(stateDir: string): RemoteDaemonPaths {
	const dir = stateDir.replace(/\/+$/, "");
	return { dir, socket: `${dir}/agent.sock`, log: `${dir}/agent-daemon.log` };
}

/** Quote for a POSIX shell. Windows remotes never reach this module. */
export function quotePosix(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface RemoteDaemonLaunch {
	agentPath: string;
	paths: RemoteDaemonPaths;
	logLevel?: string;
	logFormat?: string;
}

/**
 * The command that starts the daemon and lets go of it.
 *
 * `setsid` where it exists, `nohup` where it does not: either way the agent
 * must outlive the SSH session that started it, which means a session of its
 * own or an ignored SIGHUP. stdin comes from `/dev/null` and both outputs go to
 * the log, so nothing of it is left hanging off the exec channel — a process
 * still holding that channel keeps the exec from returning.
 */
export function remoteDaemonLaunchCommand(launch: RemoteDaemonLaunch): string {
	const { agentPath, paths } = launch;
	const agent = quotePosix(agentPath);
	const socket = quotePosix(paths.socket);
	const log = quotePosix(paths.log);
	const dir = quotePosix(paths.dir);
	const level = quotePosix(launch.logLevel ?? "info");
	const format = quotePosix(launch.logFormat ?? "jsonl");

	const run = `${agent} --daemon --socket ${socket} --log-level ${level} --format ${format}`;
	const redirect = `< /dev/null >> ${log} 2>&1`;
	return [
		`mkdir -p ${dir}`,
		`chmod 700 ${dir}`,
		`if command -v setsid > /dev/null 2>&1; then setsid ${run} ${redirect} & else nohup ${run} ${redirect} & fi`,
	].join(" && ");
}

/**
 * Open a stream to a socket on the remote.
 *
 * Rejects rather than throwing asynchronously: a socket nobody listens on is
 * the ordinary case on a first connect, and the caller answers it by starting
 * the daemon.
 */
export function openRemoteSocket(conn: Client, socketPath: string): Promise<Duplex> {
	return new Promise((resolve, reject) => {
		conn.openssh_forwardOutStreamLocal(socketPath, (err, stream) => {
			if (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			resolve(stream as unknown as Duplex);
		});
	});
}

/** How long to keep trying the socket after starting the daemon. */
const READY_DEADLINE_MS = 5_000;
/** How long to wait between those attempts. */
const READY_POLL_MS = 150;

export interface AttachRemoteDaemonOptions {
	conn: Client;
	/** The agent binary on the remote, as the deployer resolved it. */
	agentPath: string;
	logLevel?: string;
	logFormat?: string;
	/** Injected in tests; defaults to the real `sshExec`. */
	exec?: (client: Client, command: string) => Promise<{ stdout: string; exitCode: number }>;
	/** Injected in tests; defaults to a real `direct-streamlocal` channel. */
	open?: (client: Client, socketPath: string) => Promise<Duplex>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface RemoteDaemonAttachment {
	stream: Duplex;
	paths: RemoteDaemonPaths;
	/** Whether this call is what started the daemon. */
	started: boolean;
}

/**
 * Reach the remote daemon, starting it only if nothing answers.
 *
 * The order matters more than it looks: see the note at the top of this file
 * about `bind_with_retry`. Starting first would take the socket from a daemon
 * that is holding someone's terminals.
 */
export async function attachRemoteDaemon(
	options: AttachRemoteDaemonOptions,
): Promise<RemoteDaemonAttachment> {
	const exec = options.exec ?? (await defaultExec());
	const open = options.open ?? openRemoteSocket;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

	const resolved = await exec(options.conn, REMOTE_STATE_DIR_COMMAND);
	const stateDir = resolved.stdout.trim();
	if (resolved.exitCode !== 0 || stateDir === "" || !stateDir.startsWith("/")) {
		throw new Error(
			`The remote could not say where its state directory is (exit ${resolved.exitCode}). ` +
				"A daemon needs an absolute path for its socket.",
		);
	}
	const paths = remoteDaemonPaths(stateDir);

	try {
		return { stream: await open(options.conn, paths.socket), paths, started: false };
	} catch {
		// Nothing listening yet — the ordinary case on a first connect.
	}

	const launch = await exec(
		options.conn,
		remoteDaemonLaunchCommand({
			agentPath: options.agentPath,
			paths,
			...(options.logLevel !== undefined && { logLevel: options.logLevel }),
			...(options.logFormat !== undefined && { logFormat: options.logFormat }),
		}),
	);
	if (launch.exitCode !== 0) {
		throw new Error(
			`The remote agent daemon would not start (exit ${launch.exitCode}). Its log is at ${paths.log}.`,
		);
	}

	const deadline = now() + READY_DEADLINE_MS;
	let lastError: unknown;
	while (now() < deadline) {
		await sleep(READY_POLL_MS);
		try {
			return { stream: await open(options.conn, paths.socket), paths, started: true };
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`The remote agent daemon did not answer on ${paths.socket} within ${READY_DEADLINE_MS}ms. ` +
			`Its log is at ${paths.log}. Last error: ${String(lastError)}`,
	);
}

/** The real exec, loaded lazily so this module stays testable without ssh2. */
async function defaultExec(): Promise<
	(client: Client, command: string) => Promise<{ stdout: string; exitCode: number }>
> {
	const { sshExec } = await import("./ssh-exec.js");
	return (client, command) => sshExec(client, command);
}
