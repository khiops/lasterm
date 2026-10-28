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
 * Where the daemon runs on the remote, a systemd scope of its own or the SSH
 * login session that started it, is `remoteDaemonLaunchCommand`'s (#600).
 *
 * Windows remotes are not served by this: their daemon listens on a named pipe,
 * and OpenSSH has no channel type that carries one. They stay on stdio, and
 * their terminals still end with the connection.
 *
 * Nor are hosts whose SSH server refuses socket forwarding
 * (`AllowStreamLocalForwarding no`, `DisableForwarding yes`, a key's
 * `restrict`): `SocketForwardingRefused` says so, and the connection runs its
 * agent on stdio instead (#765).
 */

import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { DEFAULT_AGENT_LOG_FILES_KEPT, type Host } from "@lasterm/shared";
import type { Client } from "ssh2";

/**
 * Whether this host may keep an agent of its own running.
 *
 * The host's own answer wins, because leaving a process behind is a decision
 * about *that* machine: yes for a Raspberry Pi at home, no for a customer's
 * server. No answer defers to the global setting.
 *
 * Windows never qualifies, whatever either says: its daemon listens on a named
 * pipe and no SSH channel carries one, so there would be nothing to reach.
 */
export function hostKeepsDaemon(
	host: { os?: string | null; sshRemoteDaemon?: boolean | null } | undefined,
	globalDefault: boolean,
): boolean {
	if (host === undefined) return false;
	if (host.os === "windows") return false;
	return host.sshRemoteDaemon ?? globalDefault;
}

/**
 * The hosts whose SSH server this hub saw refuse socket forwarding, each with
 * the route it was seen on (`socketForwardingRoute`). In memory only: a hub
 * that restarts tries again (#765).
 */
export type SocketForwardingRefusals = Map<string, string>;

/**
 * What a refusal of socket forwarding was seen through: the server, the
 * account, the key, the jump, and the host's own answer about a daemon. sshd
 * can refuse it for one account (`Match User`), one client address
 * (`Match Address`) or one key (`restrict` in `authorized_keys`), so a change
 * to any of them is worth trying again.
 */
export function socketForwardingRoute(host: Host): string {
	return JSON.stringify([
		host.sshHost ?? null,
		host.sshUser ?? null,
		host.sshPort ?? null,
		host.sshAuth ?? null,
		host.sshKeyPath ?? null,
		host.sshConfigHost ?? null,
		host.sshProxyHostId ?? null,
		host.sshProxySpec ?? null,
		host.sshRemoteDaemon ?? null,
	]);
}

/** Remember that this host's SSH server refused socket forwarding. */
export function rememberSocketForwardingRefused(
	refusals: SocketForwardingRefusals,
	host: Host,
): void {
	refusals.set(host.id, socketForwardingRoute(host));
}

/**
 * Whether this host is meant to keep a daemon, and this hub saw its SSH server
 * refuse the socket forwarding that reaches one, on the route it still has.
 */
export function socketForwardingRefusedOn(
	host: Host | undefined,
	globalDefault: boolean,
	refusals: ReadonlyMap<string, string>,
): boolean {
	if (host === undefined || !hostKeepsDaemon(host, globalDefault)) return false;
	return refusals.get(host.id) === socketForwardingRoute(host);
}

/**
 * Whether reaching this host goes through its daemon: it keeps one, and its
 * SSH server has not refused the forwarding a daemon is reached through. A
 * refused host runs its agent on stdio from the next connection on, without
 * starting a daemon only to stop it, and its terminals end with the
 * connection, which is what everything that asks this says (#765).
 */
export function hostTriesDaemon(
	host: Host | undefined,
	globalDefault: boolean,
	refusals: ReadonlyMap<string, string>,
): boolean {
	return (
		hostKeepsDaemon(host, globalDefault) &&
		!socketForwardingRefusedOn(host, globalDefault, refusals)
	);
}

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
	/**
	 * Daemon log files to keep, one per day; 0 keeps them all (#646). Passed only
	 * to a binary that knows the option; one that does not keeps its log as it
	 * always did.
	 */
	logFilesKept?: number;
	/** Seconds to stay up holding nothing, for nobody. See `IDLE_TIMEOUT_SECONDS`. */
	idleTimeoutSeconds?: number;
	/**
	 * The systemd scope to start the daemon in, where the host has one to give
	 * (#600). A fresh name by default; see `newRemoteDaemonScopeUnit`.
	 */
	scopeUnit?: string;
}

/**
 * How long a remote daemon stays up with no terminals and no hub connected.
 *
 * This process lives on someone else's machine, so it has to end by itself.
 * Long enough that a hub restarting, or a person switching machines, finds it
 * where they left it; short enough that a machine is not left carrying a
 * daemon for a terminal that ended this morning.
 *
 * A daemon still holding a terminal never exits on this timer: that terminal
 * is the whole reason the daemon exists.
 */
export const IDLE_TIMEOUT_SECONDS = 1_800;

/**
 * A name for the scope a daemon is started in, new at every launch.
 *
 * Not one per socket: `systemd-run` refuses a name that is still loaded, and a
 * scope stays loaded as long as anything in it runs. That can be a daemon the
 * hub replaced (#456) still finishing its exit when the next one starts, or a
 * job someone left running from one of its terminals (`nohup`, a `tmux`
 * server) after it ended. Nothing finds the daemon by its unit anyway: the
 * hub, `--stop` and the identity record all go by the socket.
 */
export function newRemoteDaemonScopeUnit(): string {
	return `lasterm-agent-${randomBytes(6).toString("hex")}.scope`;
}

/**
 * What detaches the agent, whichever placement it gets. Run as
 * `sh -c SCRIPT lasterm-agent LOG AGENT ARGS…`: the paths arrive as arguments,
 * so none of them is quoted twice.
 *
 * `setsid` where it exists, `nohup` where it does not: either way the agent
 * must outlive the SSH session that started it, which means a session of its
 * own or an ignored SIGHUP. stdin comes from `/dev/null` and both outputs go to
 * the log, so nothing of it is left hanging off the exec channel — a process
 * still holding that channel keeps the exec from returning.
 *
 * `INVOCATION_ID` is what `systemd-run --scope` adds to the environment; it
 * goes, so that the daemon, and every terminal inheriting from it, starts with
 * the session's environment in either placement. An SSH session has none.
 *
 * No `${` and no `$$` in here: a recent `systemd-run` (262 does) expands both
 * in the arguments it is handed, and would have this script's parameters
 * replaced with its own environment before the shell ever saw them.
 */
export const DETACH_SCRIPT =
	'log=$1; shift; unset INVOCATION_ID; if command -v setsid > /dev/null 2>&1; then setsid "$@" < /dev/null >> "$log" 2>&1 & ' +
	'else nohup "$@" < /dev/null >> "$log" 2>&1 & fi';

/** What the launch command prints last, so the hub can say where the daemon went. */
const PLACEMENT_MARKER = "lasterm-daemon-placement:";

/** Why a daemon was started in the SSH login session rather than a scope of its own. */
export type RemoteDaemonSessionReason =
	| "no-systemd-run"
	| "no-linger"
	| "no-user-manager"
	| "systemd-run-failed";

const SESSION_REASONS: readonly RemoteDaemonSessionReason[] = [
	"no-systemd-run",
	"no-linger",
	"no-user-manager",
	"systemd-run-failed",
];

/** Where a launch put the daemon. */
export type RemoteDaemonPlacement =
	| { kind: "scope"; unit: string }
	| { kind: "session"; reason: RemoteDaemonSessionReason };

/**
 * The command that starts the daemon and lets go of it.
 *
 * **Where it runs (#600).** Started from the hub's SSH exec, the daemon lands in
 * that connection's logind session, `session-N.scope`. A host with
 * `KillUserProcesses=yes`, or a `loginctl terminate-session`, ends that scope
 * at logout, and every terminal the daemon holds with it: the very terminals it
 * exists to keep. So where systemd can give it a place of its own, it gets one:
 * `systemd-run --user --scope` moves it into a transient scope under
 * `user@UID.service`, outside every login session.
 *
 * A scope, not a service. A scope holds a process the caller started, so the
 * daemon keeps the environment it had before — the one its terminals inherit
 * (#576) — rather than the user manager's, and its output goes to its log as
 * before. And a scope ends when the last process in it does, not when the
 * daemon does: a job someone left running from a terminal outlives the daemon
 * as it did in the session. A service would kill it (`KillMode=control-group`)
 * or leave it in a dead unit (`KillMode=process`). The daemon's own ways of
 * ending, STOP, `--stop`, the idle timeout and the hub's replace (#456), tear
 * its terminals down themselves, as before; systemd kills nothing.
 *
 * Only with lingering on. The scope lives in the user manager, and without
 * linger that manager stops at the user's last logout, taking the scope along,
 * while the session scope outlives the logout wherever `KillUserProcesses=no`,
 * Debian's default. So without linger the daemon stays where it was: neither
 * placement is ever worse than before. Every other case falls back to the
 * session too: no `systemd-run` (no systemd, a container), a user manager this
 * connection cannot reach, or a `systemd-run` that refuses. A refusal leaves
 * nothing started, since `systemd-run --scope` in the foreground either makes
 * the scope and runs the command in it, or fails before running anything. So
 * the fallback never starts a second daemon.
 *
 * The last line printed says which, for `parseRemoteDaemonPlacement`.
 */
export function remoteDaemonLaunchCommand(launch: RemoteDaemonLaunch): string {
	const { agentPath, paths } = launch;
	const agent = quotePosix(agentPath);
	const socket = quotePosix(paths.socket);
	const log = quotePosix(paths.log);
	const dir = quotePosix(paths.dir);
	const level = quotePosix(launch.logLevel ?? "info");
	const format = quotePosix(launch.logFormat ?? "jsonl");
	const unit = launch.scopeUnit ?? newRemoteDaemonScopeUnit();

	const idle = Math.max(0, Math.trunc(launch.idleTimeoutSeconds ?? IDLE_TIMEOUT_SECONDS));
	const kept = Math.max(0, Math.trunc(launch.logFilesKept ?? DEFAULT_AGENT_LOG_FILES_KEPT));
	// The agent's argv, as the positional parameters, which both placements pass
	// on unchanged. Set whole, word by word, rather than through an unquoted
	// variable: zsh, a login shell the exec may well run in, does not split one.
	const argv =
		`set -- ${agent} --daemon --socket ${socket} --log-level ${level} --format ${format} ` +
		`--idle-timeout ${idle} --log-files-kept ${kept}`;
	// `$detach` is the shell's copy of DETACH_SCRIPT, set below.
	const detachCall = `/bin/sh -c "$detach" lasterm-agent ${log} "$@"`;
	const scope = [
		"systemd-run --user --scope --quiet --collect",
		quotePosix(`--unit=${unit}`),
		quotePosix(`--description=lasterm agent daemon on ${paths.socket}`),
		// Its own complaint, if it refuses, goes where a person looking for why
		// the daemon is where it is will read.
		`${detachCall} 2>> ${log}`,
	].join(" ");
	const place =
		"if ! command -v systemd-run > /dev/null 2>&1; then placed='session no-systemd-run'; " +
		// `-p Linger` rather than `--value`, which older systemd lacks.
		`elif [ "$(loginctl show-user "$(id -u)" -p Linger 2> /dev/null)" != Linger=yes ]; then placed='session no-linger'; ` +
		"elif ! systemctl --user show-environment > /dev/null 2>&1; then placed='session no-user-manager'; " +
		`elif ${scope}; then placed=${quotePosix(`scope ${unit}`)}; ` +
		"else placed='session systemd-run-failed'; fi";
	return [
		`mkdir -p ${dir}`,
		`chmod 700 ${dir}`,
		argv,
		`detach=${quotePosix(DETACH_SCRIPT)}`,
		place,
		`case $placed in scope*) ;; *) ${detachCall} ;; esac`,
		`printf '%s %s\\n' ${PLACEMENT_MARKER} "$placed"`,
	].join(" && ");
}

/**
 * Where the launch command says it put the daemon, from what it printed.
 *
 * The last marker line wins: a login script that prints something of its own
 * comes before it. `null` for output that carries none, a launch cut short
 * for instance.
 */
export function parseRemoteDaemonPlacement(stdout: string): RemoteDaemonPlacement | null {
	const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(PLACEMENT_MARKER));
	const last = lines.at(-1);
	if (last === undefined) return null;
	const [kind, detail, ...rest] = last.slice(PLACEMENT_MARKER.length).trim().split(/\s+/);
	if (rest.length > 0 || detail === undefined) return null;
	if (kind === "scope" && /^lasterm-agent-[A-Za-z0-9_-]+\.scope$/.test(detail)) {
		return { kind: "scope", unit: detail };
	}
	const reason = SESSION_REASONS.find((known) => known === detail);
	if (kind === "session" && reason !== undefined) return { kind: "session", reason };
	return null;
}

/** Where the daemon went, in words for the hub's log. */
export function describeRemoteDaemonPlacement(placement: RemoteDaemonPlacement): string {
	if (placement.kind === "scope") {
		return `in its own systemd scope, ${placement.unit}, outside any login session`;
	}
	const why: Record<RemoteDaemonSessionReason, string> = {
		"no-systemd-run": "the host has no systemd-run",
		"no-linger":
			"lingering is off for this user, so a scope would end at their last logout; " +
			"`loginctl enable-linger` there changes that",
		"no-user-manager": "this connection cannot reach the user's systemd manager",
		"systemd-run-failed": "systemd-run refused; its reason is in the daemon's log",
	};
	return `in the SSH login session: ${why[placement.reason]}`;
}

/**
 * The command that asks a remote daemon to stop.
 *
 * The agent's own `--stop`, which asks rather than kills: it tears its
 * terminals down in order and writes what it confirmed. Everything it was
 * holding ends here — that is the price of replacing it, and the only honest
 * way to pay it is to have said so first (#456).
 */
export function remoteDaemonStopCommand(agentPath: string, paths: RemoteDaemonPaths): string {
	return `${quotePosix(agentPath)} --stop --socket ${quotePosix(paths.socket)}`;
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

/**
 * Channel open failure reasons (RFC 4254 § 5.1) that refuse a channel type
 * outright, whatever listens on the socket: a server that prohibits it (1), or
 * one that has no such channel type (3).
 *
 * OpenSSH says neither. For `AllowStreamLocalForwarding no`,
 * `DisableForwarding yes` or a key's `no-port-forwarding`, sshd answers
 * CONNECT_FAILED (2), "open failed": exactly what it answers for a socket
 * nobody listens on (`server_request_direct_streamlocal` and
 * `server_input_channel_open` in serverloop.c). Telling those two apart takes
 * asking the remote, `remoteSocketStateCommand`.
 */
const REFUSED_OUTRIGHT_REASONS: ReadonlySet<unknown> = new Set([1, 3]);

function refusedOutright(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		REFUSED_OUTRIGHT_REASONS.has((err as { reason?: unknown }).reason)
	);
}

/** What the socket probe prints, before its answer. */
const SOCKET_STATE_MARKER = "lasterm-socket:";

/**
 * Whether anything listens on a socket of the remote: `unknown` where the
 * remote cannot say (no `/proc/net/unix`, no awk, an answer cut short).
 */
export type RemoteSocketState = "listening" | "silent" | "unknown";

/**
 * The command that says whether anything listens on `socket`, from the
 * kernel's own table of UNIX sockets. Each line of `/proc/net/unix` ends with
 * the socket's path, and its fourth field, the flags, is `00010000`
 * (`__SO_ACCEPTCON`) for one that listens. The connections a listener
 * accepted carry its path too, with other flags, so only a listener counts.
 *
 * Nothing here connects to the socket: a connection would be a client the
 * daemon has to deal with. The path travels in the environment, which awk
 * reads as it is, where `-v` would interpret its backslashes.
 *
 * `table` is for tests.
 */
export function remoteSocketStateCommand(socket: string, table = "/proc/net/unix"): string {
	const program =
		'BEGIN { p = " " ENVIRON["LASTERM_SOCKET"]; s = "silent" } ' +
		'$4 == "00010000" && length($0) > length(p) && substr($0, length($0) - length(p) + 1) == p { s = "listening" } ' +
		`END { print "${SOCKET_STATE_MARKER} " s }`;
	const file = quotePosix(table);
	return (
		`if [ -r ${file} ]; then LASTERM_SOCKET=${quotePosix(socket)} awk ${quotePosix(program)} ${file}; ` +
		`else echo '${SOCKET_STATE_MARKER} unknown'; fi`
	);
}

/** The probe's answer, from what it printed: the last marker line wins. */
export function parseRemoteSocketState(stdout: string): RemoteSocketState {
	const last = stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith(SOCKET_STATE_MARKER))
		.at(-1);
	const state = last?.slice(SOCKET_STATE_MARKER.length).trim();
	return state === "listening" || state === "silent" ? state : "unknown";
}

/** What the hub says when a host's SSH server refuses socket forwarding (#765). */
export const SOCKET_FORWARDING_REFUSED_MESSAGE =
	"This host's SSH server refuses socket forwarding (AllowStreamLocalForwarding or " +
	"DisableForwarding in its sshd_config); the remote daemon needs it, see docs/SSH_SERVER.md.";

/** What became of the daemon when the socket forwarding was refused. */
export type RefusedDaemon =
	/** None was started: the server refused the channel type before any launch. */
	| { kind: "none" }
	/** One was already listening, which this connection cannot reach. Left alone. */
	| { kind: "already-running" }
	/** This connection started one and stopped it, through its `--stop`. */
	| { kind: "stopped" }
	/** This connection started one, and its `--stop` said this. */
	| { kind: "not-stopped"; said: string };

/**
 * The host's SSH server will not carry a channel to the daemon's socket. The
 * daemon cannot be reached however long one waits, so nothing waits: the
 * caller runs the agent on stdio instead (#765).
 */
export class SocketForwardingRefused extends Error {
	constructor(
		readonly paths: RemoteDaemonPaths,
		readonly daemon: RefusedDaemon,
	) {
		super(`${SOCKET_FORWARDING_REFUSED_MESSAGE}${describeRefusedDaemon(daemon, paths)}`);
		this.name = "SocketForwardingRefused";
	}
}

function describeRefusedDaemon(daemon: RefusedDaemon, paths: RemoteDaemonPaths): string {
	switch (daemon.kind) {
		case "none":
			return "";
		case "already-running":
			return ` A daemon already listens on ${paths.socket}; it is left as it is.`;
		case "stopped":
			return " The daemon this connection started there is stopped.";
		case "not-stopped":
			return (
				` The daemon this connection started there could not be stopped (${daemon.said}); ` +
				`it ends by itself after ${IDLE_TIMEOUT_SECONDS / 60} minutes with nothing to do.`
			);
	}
}

/** How long to keep trying the socket after starting the daemon. */
const READY_DEADLINE_MS = 5_000;
/** How long to wait between those attempts. */
const READY_POLL_MS = 150;
/**
 * How many times to ask a daemon this connection started to stop. It
 * publishes the record `--stop` goes by just after it starts listening, so a
 * stop sent in between finds none.
 */
const STOP_ATTEMPTS = 4;

export interface AttachRemoteDaemonOptions {
	conn: Client;
	/** The agent binary on the remote, as the deployer resolved it. */
	agentPath: string;
	logLevel?: string;
	logFormat?: string;
	/** Daemon log files a daemon this call starts keeps. See `RemoteDaemonLaunch`. */
	logFilesKept?: number;
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
	/**
	 * Where this call started it: its own systemd scope, or the SSH login
	 * session (#600). `null` when it did not start it, or the launch did not say.
	 */
	placement: RemoteDaemonPlacement | null;
}

/**
 * Reach the remote daemon, starting it only if nothing answers.
 *
 * The order matters more than it looks: see the note at the top of this file
 * about `bind_with_retry`. Starting first would take the socket from a daemon
 * that is holding someone's terminals.
 *
 * A server that refuses socket forwarding rejects with
 * `SocketForwardingRefused`, as soon as that is known (#765): the channel
 * fails while the remote's own table shows the socket listening. A daemon this
 * call started is stopped first; one that was there before is left alone,
 * since it may hold terminals another connection reaches.
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
	const socketState = async (): Promise<RemoteSocketState> => {
		try {
			return parseRemoteSocketState(
				(await exec(options.conn, remoteSocketStateCommand(paths.socket))).stdout,
			);
		} catch {
			return "unknown";
		}
	};

	// What listened before anything was started. Only `silent` makes the
	// daemon found listening later this call's own, and so one it may stop.
	let before: RemoteSocketState;
	try {
		return {
			stream: await open(options.conn, paths.socket),
			paths,
			started: false,
			placement: null,
		};
	} catch (err) {
		if (refusedOutright(err)) throw new SocketForwardingRefused(paths, { kind: "none" });
		// Nothing listening yet, the ordinary case on a first connect, or a
		// server that refuses the channel in the same words.
		before = await socketState();
	}
	if (before === "listening") {
		try {
			return {
				stream: await open(options.conn, paths.socket),
				paths,
				started: false,
				placement: null,
			};
		} catch {
			throw new SocketForwardingRefused(paths, { kind: "already-running" });
		}
	}

	const launch = await exec(
		options.conn,
		remoteDaemonLaunchCommand({
			agentPath: options.agentPath,
			paths,
			...(options.logLevel !== undefined && { logLevel: options.logLevel }),
			...(options.logFormat !== undefined && { logFormat: options.logFormat }),
			...(options.logFilesKept !== undefined && { logFilesKept: options.logFilesKept }),
		}),
	);
	if (launch.exitCode !== 0) {
		throw new Error(
			`The remote agent daemon would not start (exit ${launch.exitCode}). Its log is at ${paths.log}.` +
				(await logTail(exec, options.conn, paths.log)),
		);
	}

	const placement = parseRemoteDaemonPlacement(launch.stdout);
	const deadline = now() + READY_DEADLINE_MS;
	let lastError: unknown;
	while (now() < deadline) {
		await sleep(READY_POLL_MS);
		try {
			return { stream: await open(options.conn, paths.socket), paths, started: true, placement };
		} catch (err) {
			lastError = err;
		}
		// Listening first, then the channel still refused: the server's doing,
		// not a daemon still starting. The other order would race its bind.
		if (before !== "unknown" && (await socketState()) === "listening") {
			try {
				return { stream: await open(options.conn, paths.socket), paths, started: true, placement };
			} catch {
				const said = await stopStartedDaemon(exec, options.conn, options.agentPath, paths, sleep);
				throw new SocketForwardingRefused(
					paths,
					said === null ? { kind: "stopped" } : { kind: "not-stopped", said },
				);
			}
		}
	}
	throw new Error(
		`The remote agent daemon did not answer on ${paths.socket} within ${READY_DEADLINE_MS}ms. ` +
			`Its log is at ${paths.log}. Last error: ${String(lastError)}` +
			(await logTail(exec, options.conn, paths.log)) +
			// The remote could not say whether the daemon listens: the one cause
			// this message cannot rule out is the server's.
			(before === "unknown"
				? " The host could not say whether it listens: if its SSH server refuses socket " +
					"forwarding (AllowStreamLocalForwarding or DisableForwarding), see docs/SSH_SERVER.md."
				: ""),
	);
}

/**
 * Stop the daemon this connection started, through its own `--stop`: null
 * once it says it stopped, else what it said.
 */
async function stopStartedDaemon(
	exec: (client: Client, command: string) => Promise<{ stdout: string; exitCode: number }>,
	conn: Client,
	agentPath: string,
	paths: RemoteDaemonPaths,
	sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
	let said = "";
	for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
		if (attempt > 0) await sleep(READY_POLL_MS);
		try {
			const stop = await exec(conn, remoteDaemonStopCommand(agentPath, paths));
			if (stop.exitCode === 0) return null;
			said = stop.stdout.trim().split(/\r?\n/).at(-1)?.trim() || `exit ${stop.exitCode}`;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
		if (said !== "no record") return said;
	}
	return said;
}

/**
 * The end of the daemon's log, for a message that would otherwise only say
 * where to look. A daemon that dies at launch says why there — an option it
 * does not know, a socket it cannot bind — and that is what a person needs,
 * not the path of a file on another machine.
 */
async function logTail(
	exec: (client: Client, command: string) => Promise<{ stdout: string; exitCode: number }>,
	conn: Client,
	log: string,
): Promise<string> {
	try {
		const tail = await exec(conn, `tail -n 5 ${quotePosix(log)} 2> /dev/null`);
		const text = tail.stdout.trim();
		return text === "" ? "" : ` It says: ${text.replace(/\s*\n\s*/g, " / ")}`;
	} catch {
		return "";
	}
}

/** The real exec, loaded lazily so this module stays testable without ssh2. */
async function defaultExec(): Promise<
	(client: Client, command: string) => Promise<{ stdout: string; exitCode: number }>
> {
	const { sshExec } = await import("./ssh-exec.js");
	return (client, command) => sshExec(client, command);
}
