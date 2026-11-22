import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { encodeFrame, type Host, type ProtocolMessage } from "@lasterm/shared";
import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import {
	attachRemoteDaemon,
	DaemonUnreachable,
	DETACH_SCRIPT,
	describeRemoteDaemonPlacement,
	detachOutcome,
	hostKeepsDaemon,
	IDLE_TIMEOUT_SECONDS,
	NoRunningDaemon,
	NothingListens,
	newRemoteDaemonScopeUnit,
	openRelay,
	parseRemoteDaemonPlacement,
	parseRemoteSocketState,
	quotePosix,
	RelayFailed,
	RemoteDaemonUnavailable,
	relayCommand,
	rememberSocketForwardingRefused,
	remoteDaemonLaunchCommand,
	remoteDaemonPaths,
	remoteDaemonStopCommand,
	remoteSocketStateCommand,
	type SocketForwardingRefusals,
	socketForwardingRefusedOn,
	windowsDaemonStopCommand,
} from "./remote-daemon.js";

const conn = {} as Client;

/** A relay that finds nothing listening, for a host whose probe says nothing (#755). */
const nothingListens = async (): Promise<never> => {
	throw new NothingListens();
};

function stateDirReply(dir: string) {
	return { stdout: dir, exitCode: 0 };
}

describe("remoteDaemonPaths", () => {
	it("puts the socket and the log under the state directory", () => {
		const paths = remoteDaemonPaths("/home/pi/.local/state/lasterm");
		expect(paths.socket).toBe("/home/pi/.local/state/lasterm/agent.sock");
		expect(paths.log).toBe("/home/pi/.local/state/lasterm/agent-daemon.log");
	});

	it("does not double a trailing slash", () => {
		expect(remoteDaemonPaths("/var/lib/lasterm/").socket).toBe("/var/lib/lasterm/agent.sock");
	});
});

describe("hostKeepsDaemon", () => {
	it("follows the global setting when the host has no answer of its own", () => {
		expect(hostKeepsDaemon({ os: "linux" }, true)).toBe(true);
		expect(hostKeepsDaemon({ os: "linux" }, false)).toBe(false);
	});

	it("lets the host override the global setting, both ways", () => {
		expect(hostKeepsDaemon({ os: "linux", sshRemoteDaemon: false }, true)).toBe(false);
		expect(hostKeepsDaemon({ os: "linux", sshRemoteDaemon: true }, false)).toBe(true);
	});

	it("keeps one on Windows as elsewhere, reached through the relay (#755)", () => {
		expect(hostKeepsDaemon({ os: "windows", sshRemoteDaemon: true }, false)).toBe(true);
		expect(hostKeepsDaemon({ os: "windows", sshRemoteDaemon: null }, true)).toBe(true);
		expect(hostKeepsDaemon({ os: "windows", sshRemoteDaemon: false }, true)).toBe(false);
	});

	it("says no for a host it does not know", () => {
		expect(hostKeepsDaemon(undefined, true)).toBe(false);
	});
});

describe("quotePosix", () => {
	it("leaves an ordinary path alone", () => {
		expect(quotePosix("/home/pi/.local/bin/lasterm-agent")).toBe(
			"/home/pi/.local/bin/lasterm-agent",
		);
	});

	it("quotes a path with a space", () => {
		expect(quotePosix("/home/pi/my agent")).toBe("'/home/pi/my agent'");
	});

	it("survives a single quote in the path", () => {
		expect(quotePosix("/home/o'brien/agent")).toBe("'/home/o'\\''brien/agent'");
	});
});

describe("remoteDaemonLaunchCommand", () => {
	const paths = remoteDaemonPaths("/home/pi/.local/state/lasterm");

	it("starts the daemon on the socket the hub will reach", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(cmd).toContain("--daemon");
		expect(cmd).toContain(`--socket ${paths.socket}`);
	});

	it("detaches, so the agent outlives the SSH session that started it", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(cmd).toContain("setsid");
		expect(cmd).toContain("nohup");
		expect(cmd).toContain("&");
	});

	it("lets go of the exec channel: no stdin, both outputs to the log", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(cmd).toContain('< /dev/null >> "$log" 2>&1');
		// The log is the detaching script's first argument, whichever placement.
		expect(cmd).toContain(`/bin/sh -c "$detach" lasterm-agent ${paths.log} "$@"`);
	});

	it("makes the state directory the owner's alone", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(cmd).toContain(`mkdir -p ${paths.dir}`);
		expect(cmd).toContain(`chmod 700 ${paths.dir}`);
	});

	it("asks the daemon to end itself when it holds nothing for nobody", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(cmd).toContain(`--idle-timeout ${IDLE_TIMEOUT_SECONDS}`);
	});

	it("takes a caller's idle timeout, floored at zero and whole", () => {
		const cmd = remoteDaemonLaunchCommand({
			agentPath: "/usr/bin/lasterm-agent",
			paths,
			idleTimeoutSeconds: -5,
		});
		expect(cmd).toContain("--idle-timeout 0");
	});

	it("quotes an agent path with a space", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/opt/my tools/lasterm-agent", paths });
		expect(cmd).toContain("'/opt/my tools/lasterm-agent'");
	});
});

describe("remoteDaemonStopCommand", () => {
	const paths = remoteDaemonPaths("/home/pi/.local/state/lasterm");

	it("asks the daemon to stop, on the socket the hub reached it on", () => {
		const cmd = remoteDaemonStopCommand("/usr/bin/lasterm-agent", paths);
		expect(cmd).toBe(`/usr/bin/lasterm-agent --stop --socket ${paths.socket}`);
	});

	it("quotes a path with a space", () => {
		expect(remoteDaemonStopCommand("/opt/my tools/lasterm-agent", paths)).toContain(
			"'/opt/my tools/lasterm-agent'",
		);
	});
});

describe("attachRemoteDaemon", () => {
	const dir = "/home/pi/.local/state/lasterm";

	it("uses a daemon that is already answering, and starts nothing", async () => {
		const commands: string[] = [];
		const attachment = await attachRemoteDaemon({
			conn,
			relay: nothingListens,
			agentPath: "/usr/bin/lasterm-agent",
			exec: async (_c, command) => {
				commands.push(command);
				return stateDirReply(dir);
			},
			open: async () => new PassThrough(),
		});

		expect(attachment.started).toBe(false);
		expect(attachment.paths.socket).toBe(`${dir}/agent.sock`);
		// Starting a second daemon on a live socket would unlink it and take the
		// first one's place, leaving it holding terminals nobody can reach.
		expect(commands.filter((c) => c.includes("--daemon"))).toHaveLength(0);
	});

	it("starts the daemon when nothing answers, then reaches it", async () => {
		let opens = 0;
		const commands: string[] = [];
		const attachment = await attachRemoteDaemon({
			conn,
			relay: nothingListens,
			agentPath: "/usr/bin/lasterm-agent",
			exec: async (_c, command) => {
				commands.push(command);
				return stateDirReply(dir);
			},
			open: async () => {
				opens += 1;
				if (opens === 1) throw new Error("ENOENT");
				return new PassThrough();
			},
			sleep: async () => {},
		});

		expect(attachment.started).toBe(true);
		expect(commands.some((c) => c.includes("--daemon"))).toBe(true);
	});

	it("hands the daemon it starts the number of log files to keep (#646)", async () => {
		let opens = 0;
		const commands: string[] = [];
		await attachRemoteDaemon({
			conn,
			relay: nothingListens,
			agentPath: "/usr/bin/lasterm-agent",
			logFilesKept: 0,
			exec: async (_c, command) => {
				commands.push(command);
				return stateDirReply(dir);
			},
			open: async () => {
				opens += 1;
				if (opens === 1) throw new Error("ENOENT");
				return new PassThrough();
			},
			sleep: async () => {},
		});

		const launch = commands.find((c) => c.includes("--daemon"));
		expect(launch).toMatch(/ --log-files-kept 0 && /);
	});

	it("says where it started the daemon, from what the launch printed", async () => {
		let opens = 0;
		const attachment = await attachRemoteDaemon({
			conn,
			relay: nothingListens,
			agentPath: "/usr/bin/lasterm-agent",
			exec: async (_c, command) =>
				command.includes("--daemon")
					? { stdout: "lasterm-daemon-placement: scope lasterm-agent-aa.scope\n", exitCode: 0 }
					: stateDirReply(dir),
			open: async () => {
				opens += 1;
				if (opens === 1) throw new Error("ENOENT");
				return new PassThrough();
			},
			sleep: async () => {},
		});

		expect(attachment.placement).toEqual({ kind: "scope", unit: "lasterm-agent-aa.scope" });
	});

	it("claims no placement for a daemon it did not start", async () => {
		const attachment = await attachRemoteDaemon({
			conn,
			relay: nothingListens,
			agentPath: "/usr/bin/lasterm-agent",
			exec: async () => stateDirReply(dir),
			open: async () => new PassThrough(),
		});

		expect(attachment.placement).toBeNull();
	});

	it("refuses a state directory that is not an absolute path", async () => {
		await expect(
			attachRemoteDaemon({
				conn,
				relay: nothingListens,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async () => ({ stdout: "lasterm", exitCode: 0 }),
				open: async () => new PassThrough(),
			}),
		).rejects.toThrow(/absolute path/);
	});

	it("says where the log is when the daemon will not start", async () => {
		await expect(
			attachRemoteDaemon({
				conn,
				relay: nothingListens,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async (_c, command) =>
					command.includes("--daemon") ? { stdout: "", exitCode: 127 } : stateDirReply(dir),
				open: async () => {
					throw new Error("ENOENT");
				},
				sleep: async () => {},
			}),
		).rejects.toThrow(`${dir}/agent-daemon.log`);
	});

	it("gives up with the log path when the daemon never answers", async () => {
		let clock = 0;
		await expect(
			attachRemoteDaemon({
				conn,
				relay: nothingListens,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async () => stateDirReply(dir),
				open: async () => {
					throw new Error("ECONNREFUSED");
				},
				now: () => {
					clock += 1_000;
					return clock;
				},
				sleep: async () => {},
			}),
		).rejects.toThrow(/did not answer/);
	});

	// A host with a connection timeout gives its daemon until 15 s short of it
	// to answer (#1034): 10 s for 25 s, where the hub's own limit is 5 s.
	it("waits for a slow daemon as long as its deadline allows (#1034)", async () => {
		const attach = (connectTimeoutMs: number | undefined) => {
			let clock = 0;
			let launchedAt: number | null = null;
			return attachRemoteDaemon({
				conn,
				relay: nothingListens,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async (_c, command) => {
					if (command.includes("--daemon")) launchedAt = clock;
					return stateDirReply(dir);
				},
				open: async () => {
					if (launchedAt === null || clock - launchedAt < 8_000) throw new Error("ECONNREFUSED");
					return new PassThrough();
				},
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
				...(connectTimeoutMs !== undefined && { connectTimeoutMs }),
			});
		};
		await expect(attach(25_000)).resolves.toMatchObject({ started: true });
		await expect(attach(undefined)).rejects.toThrow(/did not answer .* within 5000ms/);
	});
});

// ─── The daemon's options ────────────────────────────────────────────────────
//
// A hub deploys the released agent of its version, a build of main the last
// release's, and every agent it can deploy knows `--idle-timeout` (0.12) and
// `--log-files-kept` (0.14): both are passed, and the binary is not asked first.

describe("remoteDaemonLaunchCommand — the daemon's options", () => {
	const paths = remoteDaemonPaths("/home/pi/.local/state/lasterm");

	it("passes --idle-timeout and --log-files-kept without asking the binary", () => {
		const cmd = remoteDaemonLaunchCommand({
			agentPath: "/usr/bin/lasterm-agent",
			paths,
			logFilesKept: 30,
		});
		expect(cmd).not.toContain("--help");
		expect(cmd).toContain(
			`--format jsonl --idle-timeout ${IDLE_TIMEOUT_SECONDS} --log-files-kept 30 && detach=`,
		);
	});

	it("keeps seven files unless told otherwise, and passes a whole count, 0 included", () => {
		const count = (logFilesKept?: number) =>
			remoteDaemonLaunchCommand({
				agentPath: "/usr/bin/lasterm-agent",
				paths,
				...(logFilesKept !== undefined && { logFilesKept }),
			}).match(/--log-files-kept (\S+) && /)?.[1];
		expect(count()).toBe("7");
		expect(count(0)).toBe("0");
		expect(count(2.7)).toBe("2");
		expect(count(-3)).toBe("0");
	});
});

// ─── Its own systemd scope (#600) ────────────────────────────────────────────
//
// Started from the hub's SSH exec, the daemon lived in that connection's logind
// session: on the Pi, a `session-N.scope` shown `closing` long after the SSH
// connection ended. A host with KillUserProcesses=yes ends such a scope at
// logout, and every terminal the daemon holds with it.

describe("remoteDaemonLaunchCommand — its own systemd scope", () => {
	const paths = remoteDaemonPaths("/home/pi/.local/state/lasterm");
	const unit = "lasterm-agent-0123456789ab.scope";
	const cmd = remoteDaemonLaunchCommand({
		agentPath: "/usr/bin/lasterm-agent",
		paths,
		scopeUnit: unit,
	});

	it("starts it in a transient user scope, which it leaves when it ends", () => {
		expect(cmd).toContain(`systemd-run --user --scope --quiet --collect --unit=${unit}`);
	});

	it("names the socket in the unit's description", () => {
		expect(cmd).toContain(`'--description=lasterm agent daemon on ${paths.socket}'`);
	});

	it("gets a fresh unit name at every launch", () => {
		const a = newRemoteDaemonScopeUnit();
		const b = newRemoteDaemonScopeUnit();
		expect(a).toMatch(/^lasterm-agent-[0-9a-f]{12}\.scope$/);
		expect(a).not.toBe(b);
		const generated = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(generated).toMatch(/--unit=lasterm-agent-[0-9a-f]{12}\.scope /);
	});

	it("asks, in order: systemd-run, lingering, the user manager, then systemd-run itself", () => {
		const steps = [
			"command -v systemd-run",
			`loginctl show-user "$(id -u)" -p Linger`,
			"systemctl --user show-environment",
			"systemd-run --user --scope",
		].map((step) => cmd.indexOf(step));
		expect(steps.every((at) => at >= 0)).toBe(true);
		expect([...steps].sort((a, b) => a - b)).toEqual(steps);
	});

	it("takes the scope only when lingering is on", () => {
		expect(cmd).toContain("!= Linger=yes ]; then placed='session no-linger'");
	});

	it("falls back to the session, detached as before, unless the scope was made", () => {
		expect(cmd).toContain(
			`case $placed in scope*) ;; *) /bin/sh -c "$detach" lasterm-agent ${paths.log} "$@" ;; esac`,
		);
		expect(cmd).toContain("else placed='session systemd-run-failed'; fi");
	});

	it("hands systemd-run nothing it would expand itself", () => {
		// A recent systemd-run (262 does) replaces `${NAME}` and `$$` in its
		// arguments with its own environment; `$NAME` only as a whole argument.
		expect(DETACH_SCRIPT).not.toContain("${");
		expect(DETACH_SCRIPT).not.toContain("$$");
		expect(DETACH_SCRIPT.startsWith("$")).toBe(false);
	});

	it("drops the INVOCATION_ID systemd-run adds, keeping the session's environment", () => {
		expect(DETACH_SCRIPT).toContain("unset INVOCATION_ID;");
		expect(DETACH_SCRIPT.indexOf("unset INVOCATION_ID")).toBeLessThan(
			DETACH_SCRIPT.indexOf("setsid"),
		);
	});

	it("says where the daemon went, last", () => {
		expect(cmd.endsWith(`printf '%s %s\\n' lasterm-daemon-placement: "$placed"`)).toBe(true);
		expect(cmd).toContain(`then placed='scope ${unit}'`);
	});

	it("quotes every path it hands systemd-run", () => {
		const odd = remoteDaemonPaths("/home/o'brien/state dir/lasterm");
		const quoted = remoteDaemonLaunchCommand({
			agentPath: "/opt/my tools/lasterm-agent",
			paths: odd,
			scopeUnit: unit,
		});
		expect(quoted).toContain(`'--description=lasterm agent daemon on ${quotedInside(odd.socket)}'`);
		expect(quoted).toContain(
			`lasterm-agent ${quotePosix(odd.log)} "$@" 2>> ${quotePosix(odd.log)}`,
		);
		expect(quoted).toContain(
			`set -- '/opt/my tools/lasterm-agent' --daemon --socket ${quotePosix(odd.socket)}`,
		);
	});
});

/** What `quotePosix` makes of a value inside single quotes it opened elsewhere. */
function quotedInside(value: string): string {
	return value.replace(/'/g, "'\\''");
}

describe("parseRemoteDaemonPlacement", () => {
	it("reads a scope", () => {
		expect(
			parseRemoteDaemonPlacement(
				"lasterm-daemon-placement: scope lasterm-agent-0123456789ab.scope\n",
			),
		).toEqual({ kind: "scope", unit: "lasterm-agent-0123456789ab.scope" });
	});

	it("reads every reason for the session", () => {
		for (const reason of [
			"no-systemd-run",
			"no-linger",
			"no-user-manager",
			"systemd-run-failed",
		] as const) {
			expect(parseRemoteDaemonPlacement(`lasterm-daemon-placement: session ${reason}\n`)).toEqual({
				kind: "session",
				reason,
			});
		}
	});

	it("takes the last marker, after whatever a login script printed", () => {
		expect(
			parseRemoteDaemonPlacement(
				"Welcome to the Pi\r\nlasterm-daemon-placement: session no-linger\r\n" +
					"lasterm-daemon-placement: scope lasterm-agent-aa.scope\r\n",
			),
		).toEqual({ kind: "scope", unit: "lasterm-agent-aa.scope" });
	});

	it("answers null for output that says nothing it knows", () => {
		expect(parseRemoteDaemonPlacement("")).toBeNull();
		expect(parseRemoteDaemonPlacement("/home/pi/.local/state/lasterm")).toBeNull();
		expect(parseRemoteDaemonPlacement("lasterm-daemon-placement: session sideways")).toBeNull();
		expect(parseRemoteDaemonPlacement("lasterm-daemon-placement: scope sshd.service")).toBeNull();
		expect(parseRemoteDaemonPlacement("lasterm-daemon-placement: scope")).toBeNull();
	});
});

describe("describeRemoteDaemonPlacement", () => {
	it("names the unit", () => {
		expect(
			describeRemoteDaemonPlacement({ kind: "scope", unit: "lasterm-agent-aa.scope" }),
		).toContain("lasterm-agent-aa.scope");
	});

	it("says what to run when lingering is what kept it in the session", () => {
		expect(describeRemoteDaemonPlacement({ kind: "session", reason: "no-linger" })).toContain(
			"loginctl enable-linger",
		);
	});
});

// The shell logic itself, run: a fake agent that records how it was started,
// and fake systemd tools, on a PATH that holds nothing else of systemd's — the
// machine running this may well have the real ones.

/** How the host answers the launch's questions about systemd. */
interface FakeSystemd {
	/** `systemd-run` starts the scope and runs the command, or refuses. */
	systemdRun: "works" | "refuses";
	linger: "yes" | "no";
	userManager: boolean;
}

interface ShellLaunch {
	/** What the agent was started with. */
	argv: string[];
	/** How many times it was started. */
	starts: number;
	/** What the launch printed. */
	stdout: string;
	/** What `systemd-run` was asked, or null if it never was. */
	systemdRun: string[] | null;
	log: string;
	paths: ReturnType<typeof remoteDaemonPaths>;
	agent: string;
}

const onPosix = process.platform !== "win32";

function toolOnThisMachine(name: string): string | null {
	try {
		return (
			execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || null
		);
	} catch {
		return null;
	}
}

function launchIn(
	options: {
		systemd?: FakeSystemd;
		/** Part of the directory name, to put odd characters in every path. */
		label?: string;
		/** The shell and its options, before `-c`. `/bin/sh` by default. */
		shell?: string[];
		/** What the launch is asked to pass as `--log-files-kept`. */
		logFilesKept?: number;
	} = {},
): ShellLaunch {
	const root = mkdtempSync(path.join(os.tmpdir(), `daemon-launch-${options.label ?? ""}`));
	try {
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		// What the launch needs besides systemd's tools. `/bin/sh` it names itself.
		for (const tool of ["mkdir", "chmod", "setsid", "nohup", "id"]) {
			const real = toolOnThisMachine(tool);
			if (real !== null) symlinkSync(real, path.join(bin, tool));
		}
		const script = (name: string, body: string) => {
			writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(path.join(bin, name), 0o755);
		};
		const record = path.join(root, "systemd-run.args");
		if (options.systemd !== undefined) {
			const { systemdRun, linger, userManager } = options.systemd;
			script(
				"systemd-run",
				[
					`printf '%s\\n' "$@" > ${quotePosix(record)}`,
					systemdRun === "refuses"
						? `echo 'Failed to start transient scope unit: refused for the test' >&2; exit 1`
						: // A scope runs its command in place: skip the options, run the rest.
							'while [ $# -gt 0 ]; do case $1 in --*) shift ;; *) break ;; esac; done; exec "$@"',
				].join("\n"),
			);
			script("loginctl", `echo Linger=${linger}`);
			script("systemctl", `exit ${userManager ? 0 : 1}`);
		}

		const agent = path.join(root, "lasterm-agent");
		const argv = path.join(root, "argv");
		const starts = path.join(root, "starts");
		// The shell creates `argv` before it writes it: `written` says it is whole (#750).
		const written = path.join(root, "argv-written");
		writeFileSync(
			agent,
			`#!/bin/sh
printf 'started\\n' >> ${quotePosix(starts)}
printf '%s\\n' "$@" > ${quotePosix(argv)}
: > ${quotePosix(written)}
`,
		);
		chmodSync(agent, 0o755);

		const paths = remoteDaemonPaths(path.join(root, "state dir"));
		const cmd = remoteDaemonLaunchCommand({
			agentPath: agent,
			paths,
			...(options.logFilesKept !== undefined && { logFilesKept: options.logFilesKept }),
		});
		const [shell = "/bin/sh", ...shellOptions] = options.shell ?? [];
		const stdout = execFileSync(shell, [...shellOptions, "-c", cmd], {
			encoding: "utf8",
			env: { ...process.env, PATH: bin },
		});
		for (let i = 0; i < 50; i++) {
			try {
				if (!existsSync(written)) throw new Error("not written yet");
				const started = readFileSync(argv, "utf8").trim().split("\n");
				// A second start, if the fallback ever made one, has had its chance.
				execFileSync("sleep", ["0.2"]);
				return {
					argv: started,
					starts: readFileSync(starts, "utf8").trim().split("\n").length,
					stdout,
					systemdRun: existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : null,
					log: existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "",
					paths,
					agent,
				};
			} catch {
				execFileSync("sleep", ["0.1"]);
			}
		}
		throw new Error(`the fake agent was never started; the launch printed: ${stdout}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const systemdReady: FakeSystemd = { systemdRun: "works", linger: "yes", userManager: true };

describe.skipIf(!onPosix)("remoteDaemonLaunchCommand in a shell", () => {
	it("passes --idle-timeout, then --log-files-kept, last (#646)", () => {
		const { argv } = launchIn({ logFilesKept: 30 });
		expect(argv.slice(-4)).toEqual([
			"--idle-timeout",
			String(IDLE_TIMEOUT_SECONDS),
			"--log-files-kept",
			"30",
		]);
	});

	it("with no systemd, starts it in the session, as before", () => {
		const launch = launchIn();
		expect(parseRemoteDaemonPlacement(launch.stdout)).toEqual({
			kind: "session",
			reason: "no-systemd-run",
		});
		expect(launch.argv).toEqual([
			"--daemon",
			"--socket",
			launch.paths.socket,
			"--log-level",
			"info",
			"--format",
			"jsonl",
			"--idle-timeout",
			String(IDLE_TIMEOUT_SECONDS),
			"--log-files-kept",
			"7",
		]);
		expect(launch.starts).toBe(1);
	});

	it("puts it in its own scope when systemd can give it one", () => {
		const launch = launchIn({ systemd: systemdReady });
		const placement = parseRemoteDaemonPlacement(launch.stdout);
		expect(placement?.kind).toBe("scope");
		const unit = placement?.kind === "scope" ? placement.unit : "";
		// The scope runs the same detaching script, on the same argv.
		expect(launch.systemdRun).toEqual([
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			`--unit=${unit}`,
			`--description=lasterm agent daemon on ${launch.paths.socket}`,
			"/bin/sh",
			"-c",
			expect.stringContaining('setsid "$@" < /dev/null >> "$log" 2>&1 &'),
			"lasterm-agent",
			launch.paths.log,
			launch.agent,
			...launch.argv,
		]);
		expect(launch.argv).toContain("--daemon");
		expect(launch.starts).toBe(1);
	});

	it("without lingering, leaves systemd-run alone: the scope would end at logout", () => {
		const launch = launchIn({ systemd: { ...systemdReady, linger: "no" } });
		expect(parseRemoteDaemonPlacement(launch.stdout)).toEqual({
			kind: "session",
			reason: "no-linger",
		});
		expect(launch.systemdRun).toBeNull();
		expect(launch.starts).toBe(1);
	});

	it("without a user manager to reach, starts it in the session", () => {
		const launch = launchIn({ systemd: { ...systemdReady, userManager: false } });
		expect(parseRemoteDaemonPlacement(launch.stdout)).toEqual({
			kind: "session",
			reason: "no-user-manager",
		});
		expect(launch.systemdRun).toBeNull();
		expect(launch.starts).toBe(1);
	});

	it("when systemd-run refuses, starts one daemon in the session and logs why", () => {
		const launch = launchIn({ systemd: { ...systemdReady, systemdRun: "refuses" } });
		expect(parseRemoteDaemonPlacement(launch.stdout)).toEqual({
			kind: "session",
			reason: "systemd-run-failed",
		});
		expect(launch.systemdRun).not.toBeNull();
		expect(launch.starts).toBe(1);
		expect(launch.log).toContain("Failed to start transient scope unit: refused for the test");
	});

	it("survives a quote and spaces in every path, in both placements", () => {
		for (const systemd of [systemdReady, undefined]) {
			const launch = launchIn({ label: "it's a dir ", ...(systemd && { systemd }) });
			expect(launch.argv).toContain(launch.paths.socket);
			expect(launch.starts).toBe(1);
			expect(parseRemoteDaemonPlacement(launch.stdout)?.kind).toBe(
				systemd === undefined ? "session" : "scope",
			);
		}
	});
});

// The exec runs in the user's login shell. zsh does not split an unquoted
// variable, and the launch used to pass `$idle` unquoted: under zsh the agent
// got "--idle-timeout 1800" as one argument, refused it, and never listened.
const zsh = onPosix ? toolOnThisMachine("zsh") : null;
describe.skipIf(zsh === null)("remoteDaemonLaunchCommand in zsh", () => {
	it("hands the agent --idle-timeout and its value as two arguments", () => {
		for (const systemd of [systemdReady, undefined]) {
			// `-f`: no ~/.zshenv, which could put the real systemd back on PATH.
			const { argv } = launchIn({ shell: [zsh ?? "", "-f"], ...(systemd && { systemd }) });
			const at = argv.indexOf("--idle-timeout");
			expect(at).toBeGreaterThan(0);
			expect(argv[at + 1]).toBe(String(IDLE_TIMEOUT_SECONDS));
		}
	});

	it("hands the agent --log-files-kept and its value as two arguments (#646)", () => {
		for (const systemd of [systemdReady, undefined]) {
			const { argv } = launchIn({
				shell: [zsh ?? "", "-f"],
				logFilesKept: 12,
				...(systemd && { systemd }),
			});
			expect(argv.slice(-2)).toEqual(["--log-files-kept", "12"]);
		}
	});
});

describe("attachRemoteDaemon — saying why", () => {
	const dir = "/home/pi/.local/state/lasterm";

	it("quotes the end of the daemon's log when it never answers", async () => {
		let clock = 0;
		await expect(
			attachRemoteDaemon({
				conn,
				relay: nothingListens,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async (_c, command) =>
					command.startsWith("tail ")
						? { stdout: "error: unexpected argument '--idle-timeout' found\n", exitCode: 0 }
						: stateDirReply(dir),
				open: async () => {
					throw new Error("ECONNREFUSED");
				},
				now: () => {
					clock += 1_000;
					return clock;
				},
				sleep: async () => {},
			}),
		).rejects.toThrow(/It says: error: unexpected argument '--idle-timeout' found/);
	});

	it("still fails with the log path when the log cannot be read", async () => {
		let clock = 0;
		await expect(
			attachRemoteDaemon({
				conn,
				relay: nothingListens,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async (_c, command) => {
					if (command.startsWith("tail ")) throw new Error("channel closed");
					return stateDirReply(dir);
				},
				open: async () => {
					throw new Error("ECONNREFUSED");
				},
				now: () => {
					clock += 1_000;
					return clock;
				},
				sleep: async () => {},
			}),
		).rejects.toThrow(`${dir}/agent-daemon.log`);
	});
});

// ─── A server that refuses socket forwarding (#765) ──────────────────────────

describe("attachRemoteDaemon — through the relay (#765, #755)", () => {
	const dir = "/home/pi/.local/state/lasterm";
	const socket = `${dir}/agent.sock`;
	/**
	 * What OpenSSH answers for `AllowStreamLocalForwarding no`, and for a
	 * socket nobody listens on alike: CONNECT_FAILED, "open failed".
	 */
	const openFailed = (): Error =>
		Object.assign(new Error("(SSH) Channel open failure: open failed"), { reason: 2 });
	const refusedWith = (reason: number): Error =>
		Object.assign(new Error("(SSH) Channel open failure: "), { reason });

	/**
	 * A remote whose probe sees the daemon listening once it is launched.
	 * `probe: false` is a remote that cannot say, and `binds: false` one whose
	 * daemon never listens. Its relay reaches the daemon whenever it listens,
	 * and says nothing listens otherwise, unless `relayFails` names what it
	 * fails with (on its `relayFailsAt`th attempt, the first by default).
	 */
	function remote(
		options: {
			listening?: boolean;
			probe?: boolean;
			binds?: boolean;
			relayFails?: string;
			relayFailsAt?: number;
		} = {},
	) {
		let listening = options.listening ?? false;
		const commands: string[] = [];
		const relays: { socket: string | null; waitMs: number }[] = [];
		const exec = async (_c: Client, command: string) => {
			commands.push(command);
			if (command.includes("/proc/net/unix")) {
				if (options.probe === false) return { stdout: "", exitCode: 127 };
				return { stdout: `lasterm-socket: ${listening ? "listening" : "silent"}\n`, exitCode: 0 };
			}
			if (command.includes("--daemon")) {
				if (options.binds !== false) listening = true;
				return { stdout: "", exitCode: 0 };
			}
			return stateDirReply(dir);
		};
		const relay = async (_c: Client, socketPath: string | null, waitMs: number) => {
			relays.push({ socket: socketPath, waitMs });
			if (options.relayFails !== undefined && relays.length === (options.relayFailsAt ?? 1)) {
				throw new RelayFailed(options.relayFails);
			}
			if (!listening) throw new NothingListens();
			return new PassThrough();
		};
		return {
			exec,
			relay,
			commands,
			relays,
			launches: () => commands.filter((c) => c.includes("--daemon")).length,
			stops: () => commands.filter((c) => c.includes("--stop")).length,
		};
	}

	/** A clock that moves a second at each look, so deadlines pass at once. */
	function ticking(): () => number {
		let clock = 0;
		return () => {
			clock += 1_000;
			return clock;
		};
	}

	async function rejection(attempt: Promise<unknown>): Promise<Error> {
		return attempt.then(
			() => new Error("reached a daemon that cannot be reached"),
			(caught: unknown) => caught as Error,
		);
	}

	describe("a channel type refused outright (reasons 1 and 3)", () => {
		it.each([1, 3])(
			"relays to a listening daemon, launches nothing, and proves the refusal (%i)",
			async (reason) => {
				const host = remote({ listening: true });
				const attachment = await attachRemoteDaemon({
					conn,
					agentPath: "/usr/bin/lasterm-agent",
					exec: host.exec,
					relay: host.relay,
					open: async () => {
						throw refusedWith(reason);
					},
					sleep: async () => {},
				});
				expect(attachment.reachedThrough).toBe("relay");
				expect(attachment.refusalProven).toBe(true);
				expect(attachment.started).toBe(false);
				expect(host.launches()).toBe(0);
				expect(host.stops()).toBe(0);
			},
		);

		it.each([1, 3])(
			"launches once when the relay finds nothing, then waits through it (%i)",
			async (reason) => {
				const host = remote();
				const attachment = await attachRemoteDaemon({
					conn,
					agentPath: "/usr/bin/lasterm-agent",
					exec: host.exec,
					relay: host.relay,
					open: async () => {
						throw refusedWith(reason);
					},
					sleep: async () => {},
				});
				expect(attachment.started).toBe(true);
				expect(attachment.refusalProven).toBe(true);
				expect(host.launches()).toBe(1);
				expect(host.relays).toEqual([
					{ socket, waitMs: 0 },
					{ socket, waitMs: 5_000 },
				]);
			},
		);

		it.each([1, 3])(
			"reaching only a running daemon (#701), nothing listening is NoRunningDaemon (%i)",
			async (reason) => {
				const host = remote();
				const err = await rejection(
					attachRemoteDaemon({
						conn,
						agentPath: "lasterm-agent",
						exec: host.exec,
						relay: host.relay,
						open: async () => {
							throw refusedWith(reason);
						},
						sleep: async () => {},
						launch: false,
					}),
				);
				expect(err).toBeInstanceOf(NoRunningDaemon);
				expect(host.launches()).toBe(0);
			},
		);
	});

	it("relays to a daemon seen listening whose channel still fails, and stops nothing", async () => {
		// Another connection, through another key or from another address, may
		// reach it and hold terminals there.
		const host = remote({ listening: true });
		const attachment = await attachRemoteDaemon({
			conn,
			agentPath: "/usr/bin/lasterm-agent",
			exec: host.exec,
			relay: host.relay,
			open: async () => {
				throw openFailed();
			},
			sleep: async () => {},
		});
		expect(attachment.reachedThrough).toBe("relay");
		expect(attachment.refusalProven).toBe(true);
		expect(host.launches()).toBe(0);
		expect(host.stops()).toBe(0);
	});

	it("keeps the daemon it started once it listens and the channel still fails", async () => {
		const host = remote();
		const attachment = await attachRemoteDaemon({
			conn,
			agentPath: "/usr/bin/lasterm-agent",
			exec: host.exec,
			relay: host.relay,
			open: async () => {
				throw openFailed();
			},
			sleep: async () => {},
		});
		expect(attachment.started).toBe(true);
		expect(attachment.reachedThrough).toBe("relay");
		expect(attachment.refusalProven).toBe(true);
		expect(host.launches()).toBe(1);
		expect(host.stops()).toBe(0);
		expect(host.relays).toHaveLength(1);
		expect(host.relays[0]?.waitMs).toBeGreaterThan(0);
	});

	describe("a host that cannot say whether anything listens", () => {
		it("asks the relay before launching, and records nothing when it answers (u1)", async () => {
			const host = remote({ probe: false, listening: true });
			const attachment = await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				relay: host.relay,
				open: async () => {
					throw openFailed();
				},
				sleep: async () => {},
			});
			expect(attachment.reachedThrough).toBe("relay");
			expect(attachment.refusalProven).toBe(false);
			expect(host.launches()).toBe(0);
		});

		it("launches once on nothing listening, then takes the channel that answers (u2)", async () => {
			const host = remote({ probe: false });
			let launched = false;
			const attachment = await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: async (c, command) => {
					if (command.includes("--daemon")) launched = true;
					return host.exec(c, command);
				},
				relay: host.relay,
				open: async () => {
					if (!launched) throw openFailed();
					return new PassThrough();
				},
				sleep: async () => {},
			});
			expect(attachment.reachedThrough).toBe("streamlocal");
			expect(attachment.refusalProven).toBe(false);
			expect(host.relays).toHaveLength(1);
		});

		it("relays once more at the deadline, and records nothing (u3)", async () => {
			const host = remote({ probe: false });
			const attachment = await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				relay: host.relay,
				open: async () => {
					throw openFailed();
				},
				now: ticking(),
				sleep: async () => {},
			});
			expect(attachment.reachedThrough).toBe("relay");
			expect(attachment.refusalProven).toBe(false);
			expect(host.launches()).toBe(1);
			expect(host.relays.at(-1)?.waitMs).toBe(0);
		});

		it("times out after its one launch when the last relay finds nothing either (u3)", async () => {
			const host = remote({ probe: false, binds: false });
			const err = await rejection(
				attachRemoteDaemon({
					conn,
					agentPath: "/usr/bin/lasterm-agent",
					exec: host.exec,
					relay: host.relay,
					open: async () => {
						throw openFailed();
					},
					now: ticking(),
					sleep: async () => {},
				}),
			);
			expect(err.message).toMatch(/did not answer/);
			expect(host.launches()).toBe(1);
		});

		it("fails with the last relay's own reason, after exactly one launch (u3)", async () => {
			const host = remote({
				probe: false,
				binds: false,
				relayFails: "the agent's socket refused this account",
				relayFailsAt: 2,
			});
			const err = await rejection(
				attachRemoteDaemon({
					conn,
					agentPath: "/usr/bin/lasterm-agent",
					exec: host.exec,
					relay: host.relay,
					open: async () => {
						throw openFailed();
					},
					now: ticking(),
					sleep: async () => {},
				}),
			);
			expect(err).toBeInstanceOf(RelayFailed);
			expect(err.message).toMatch(/refused this account/);
			expect(host.launches()).toBe(1);
		});
	});

	describe("the relay route, for a host remembered as refusing", () => {
		it("never tries the channel, and relays first", async () => {
			const host = remote({ listening: true });
			let opens = 0;
			const attachment = await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				relay: host.relay,
				open: async () => {
					opens += 1;
					return new PassThrough();
				},
				route: "relay",
			});
			expect(opens).toBe(0);
			expect(attachment.reachedThrough).toBe("relay");
			expect(host.relays).toEqual([{ socket, waitMs: 0 }]);
		});

		it("launches only when nothing listens, then waits through the relay", async () => {
			const host = remote();
			const attachment = await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				relay: host.relay,
				route: "relay",
			});
			expect(attachment.started).toBe(true);
			expect(host.launches()).toBe(1);
			expect(host.commands.findIndex((c) => c.includes("--daemon"))).toBeGreaterThan(-1);
			expect(host.relays).toEqual([
				{ socket, waitMs: 0 },
				{ socket, waitMs: 5_000 },
			]);
		});

		it("gives up after its one launch when the daemon never answers", async () => {
			const host = remote({ binds: false });
			const err = await rejection(
				attachRemoteDaemon({
					conn,
					agentPath: "/usr/bin/lasterm-agent",
					exec: host.exec,
					relay: host.relay,
					route: "relay",
				}),
			);
			expect(err.message).toMatch(/did not answer on .*agent\.sock within 5000ms/);
			expect(host.launches()).toBe(1);
		});

		it("waits as long as the host's connection timeout allows (#1034)", async () => {
			const host = remote();
			await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				relay: host.relay,
				route: "relay",
				connectTimeoutMs: 25_000,
			});
			expect(host.relays.at(-1)?.waitMs).toBe(10_000);
		});

		it.each([
			"the agent's socket refused this account",
			"the agent's endpoint stayed busy",
			"the agent on this host predates the relay",
		])("fails on a relay that fails (%s), launching nothing", async (reason) => {
			const host = remote({ relayFails: reason });
			const err = await rejection(
				attachRemoteDaemon({
					conn,
					agentPath: "/usr/bin/lasterm-agent",
					exec: host.exec,
					relay: host.relay,
					route: "relay",
				}),
			);
			expect(err).toBeInstanceOf(RelayFailed);
			expect(host.launches()).toBe(0);
		});

		it("reaching only a running daemon (#701): nothing listening is NoRunningDaemon, a failure is unreachable", async () => {
			const none = remote();
			expect(
				await rejection(
					attachRemoteDaemon({
						conn,
						agentPath: "lasterm-agent",
						exec: none.exec,
						relay: none.relay,
						route: "relay",
						launch: false,
					}),
				),
			).toBeInstanceOf(NoRunningDaemon);
			const failing = remote({ relayFails: "exec refused" });
			const err = await rejection(
				attachRemoteDaemon({
					conn,
					agentPath: "lasterm-agent",
					exec: failing.exec,
					relay: failing.relay,
					route: "relay",
					launch: false,
				}),
			);
			expect(err).toBeInstanceOf(DaemonUnreachable);
			expect(err.message).toMatch(/exec refused/);
			expect(none.launches() + failing.launches()).toBe(0);
		});
	});
});

describe("openRelay (#755)", () => {
	const HELLO = Buffer.from(
		encodeFrame({
			type: "HELLO",
			version: 1,
			agentVersion: "0.0.0-test",
			capabilities: ["multiplex"],
		} as ProtocolMessage),
	);

	/** A connection whose exec channel the test drives. */
	function fakeConn(refuse = false) {
		const channel = Object.assign(new PassThrough(), {
			stderr: new PassThrough(),
			close() {
				channel.emit("close");
			},
		});
		const commands: string[] = [];
		const client = {
			exec(command: string, cb: (err: Error | undefined, ch?: typeof channel) => void) {
				commands.push(command);
				if (refuse) cb(new Error("no exec for you"));
				else cb(undefined, channel);
			},
		} as unknown as Client;
		return { client, channel, commands };
	}

	it("decides by the markers, not the exit status a PowerShell shell flattens to 1", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, relayCommand("/a/lasterm-agent", "/s/agent.sock", "linux", 0));
		channel.stderr.write(
			"lasterm-attach: start\nlasterm-attach: nothing-listens\nnothing listens on /s\n",
		);
		channel.emit("exit", 1);
		channel.emit("close");
		await expect(opened).rejects.toBeInstanceOf(NothingListens);
	});

	it.each([
		["lasterm-attach: denied", /refused this account/],
		["lasterm-attach: busy", /stayed busy/],
		["lasterm-attach: failed boom here", /boom here/],
	])("fails on %s", async (marker, reason) => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.stderr.write(`lasterm-attach: start\n${marker}\n`);
		channel.emit("close");
		const err = await opened.then(
			() => null,
			(e: unknown) => e as RelayFailed,
		);
		expect(err).toBeInstanceOf(RelayFailed);
		expect(err?.message).toMatch(reason);
	});

	it("says the agent predates the relay when it never said it started", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.stderr.write("error: unexpected argument '--attach' found\n");
		channel.emit("close");
		const err = await opened.then(
			() => null,
			(e: unknown) => e as RelayFailed,
		);
		expect(err?.predates).toBe(true);
		expect(err?.message).toMatch(/predates the relay/);
	});

	it("says why when a relay that started ended without an outcome", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.stderr.write("lasterm-attach: start\n");
		channel.emit("close");
		await expect(opened).rejects.toThrow(/ended without saying why/);
	});

	it("fails when the server refuses the command", async () => {
		const { client } = fakeConn(true);
		await expect(openRelay(client, "x")).rejects.toThrow(/refused the command/);
	});

	it("skips what the shell printed, and hands the HELLO on first", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.write(Buffer.alloc(40, 0x2e));
		channel.write(HELLO);
		const stream = await opened;
		const first = await new Promise<Buffer>((resolve) => {
			stream.once("data", resolve);
			stream.resume();
		});
		expect(first.subarray(0, HELLO.length).equals(HELLO)).toBe(true);
	});

	it("still finds nothing listening after the shell printed", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.write(Buffer.alloc(40, 0x2e));
		channel.stderr.write("lasterm-attach: start\nlasterm-attach: nothing-listens\n");
		channel.emit("close");
		await expect(opened).rejects.toBeInstanceOf(NothingListens);
	});

	it("ignores every marker once stderr passed 64 KiB, counted in bytes, however it was cut", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.stderr.write("lasterm-attach: start\nlasterm-attach: nothing-listens\n");
		// 40 000 two-byte characters: under 64 Ki characters, over 64 KiB.
		channel.stderr.write("é".repeat(40_000));
		channel.emit("close");
		const err = await opened.then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(RelayFailed);
		expect((err as Error).message).toMatch(/stderr was too long/);
	});

	it("fails, rather than throwing, when the channel errs before HELLO", async () => {
		const { client, channel } = fakeConn();
		const opened = openRelay(client, "x");
		channel.emit("error", new Error("boom"));
		await expect(opened).rejects.toThrow(/relay's channel failed \(boom\)/);
	});

	it("builds the relay command with the socket and the wait", () => {
		expect(
			relayCommand("/home/pi/.local/bin/lasterm-agent", "/home/pi/x y/agent.sock", "linux", 5000.7),
		).toBe(
			"/home/pi/.local/bin/lasterm-agent --attach --socket '/home/pi/x y/agent.sock' --wait 5000",
		);
	});
});

describe("remoteSocketStateCommand", () => {
	it("reads the probe's last answer, and nothing else", () => {
		expect(parseRemoteSocketState("lasterm-socket: listening\n")).toBe("listening");
		expect(parseRemoteSocketState("Welcome!\nlasterm-socket: silent\r\n")).toBe("silent");
		expect(parseRemoteSocketState("lasterm-socket: unknown\n")).toBe("unknown");
		expect(parseRemoteSocketState("sh: awk: not found\n")).toBe("unknown");
		expect(parseRemoteSocketState("lasterm-socket: maybe\n")).toBe("unknown");
	});

	it("passes the path in the environment, quoted", () => {
		const command = remoteSocketStateCommand("/home/o'brien/.local/state/lasterm/agent.sock");
		expect(command).toContain("LASTERM_SOCKET='/home/o'\\''brien/.local/state/lasterm/agent.sock'");
		expect(command).toContain("/proc/net/unix");
	});
});

describe.skipIf(!onPosix)("remoteSocketStateCommand in a shell", () => {
	const table = [
		"Num       RefCount Protocol Flags    Type St Inode Path",
		"0000000000000000: 00000002 00000000 00010000 0001 01 23456 /run/user/1000/bus",
		// A connection the daemon accepted: its path, without the listening flag.
		"0000000000000000: 00000003 00000000 00000000 0001 03 23457 /home/pi/.local/state/lasterm/agent.sock",
		"0000000000000000: 00000002 00000000 00010000 0001 01 23458 /home/pi/my state/lasterm/agent.sock",
		"",
	].join("\n");

	function probe(socket: string, file: string): string {
		return execFileSync("/bin/sh", ["-c", remoteSocketStateCommand(socket, file)], {
			encoding: "utf8",
		});
	}

	it("tells a listener from an accepted connection, a space in the path included", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "socket-table-"));
		try {
			const file = path.join(root, "unix");
			writeFileSync(file, table);
			expect(parseRemoteSocketState(probe("/run/user/1000/bus", file))).toBe("listening");
			expect(parseRemoteSocketState(probe("/home/pi/my state/lasterm/agent.sock", file))).toBe(
				"listening",
			);
			expect(parseRemoteSocketState(probe("/home/pi/.local/state/lasterm/agent.sock", file))).toBe(
				"silent",
			);
			expect(parseRemoteSocketState(probe("/bus", file))).toBe("silent");
			expect(parseRemoteSocketState(probe("/bus", path.join(root, "missing")))).toBe("unknown");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!existsSync("/proc/net/unix"))(
		"sees a socket listen, and stop listening, in this kernel's table",
		async () => {
			const root = mkdtempSync(path.join(os.tmpdir(), "socket-probe-"));
			const socket = path.join(root, "agent.sock");
			const server = net.createServer((accepted) => accepted.end());
			try {
				await new Promise<void>((resolve) => server.listen(socket, resolve));
				// A connection it accepted carries the same path; it is not a listener.
				const client = net.connect(socket);
				await new Promise((resolve) => client.once("connect", resolve));
				expect(parseRemoteSocketState(probe(socket, "/proc/net/unix"))).toBe("listening");
				client.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				expect(parseRemoteSocketState(probe(socket, "/proc/net/unix"))).toBe("silent");
			} finally {
				if (server.listening) server.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

describe("remembering a refused forwarding (#765)", () => {
	const host = (overrides: Partial<Host> = {}): Host =>
		({
			id: "pi",
			type: "ssh",
			sshHost: "pi.example",
			sshUser: "pi",
			sshPort: 22,
			sshAuth: "key",
			sshKeyPath: "~/.ssh/id_ed25519",
			sshRemoteDaemon: true,
			os: "linux",
			...overrides,
		}) as Host;

	it("sends the next connection through the relay, for the route it was seen on (#755)", () => {
		const refusals: SocketForwardingRefusals = new Map();
		expect(socketForwardingRefusedOn(host(), false, refusals)).toBe(false);

		rememberSocketForwardingRefused(refusals, host());

		expect(socketForwardingRefusedOn(host(), false, refusals)).toBe(true);
		// Still a host that keeps its daemon: the relay reaches it.
		expect(hostKeepsDaemon(host(), false)).toBe(true);
	});

	it.each([
		["another address", { sshHost: "pi.lan" }],
		["another account", { sshUser: "olivier" }],
		["another port", { sshPort: 2222 }],
		["another key", { sshKeyPath: "~/.ssh/other" }],
		["another jump", { sshProxySpec: "bastion.example" }],
		["another user for the jump", { sshProxyHostId: "gw", sshProxyUser: "relay" }],
		["another port for the jump", { sshProxyHostId: "gw", sshProxyPort: 2200 }],
		["its own answer about a daemon changed", { sshRemoteDaemon: null }],
	] as const)("tries the channel again through %s", (_what, change) => {
		const refusals: SocketForwardingRefusals = new Map();
		rememberSocketForwardingRefused(refusals, host());

		expect(socketForwardingRefusedOn(host(change), true, refusals)).toBe(false);
	});

	it("says nothing of a host that keeps no daemon", () => {
		const refusals: SocketForwardingRefusals = new Map();
		rememberSocketForwardingRefused(refusals, host({ sshRemoteDaemon: null }));

		expect(socketForwardingRefusedOn(host({ sshRemoteDaemon: null }), false, refusals)).toBe(false);
		expect(socketForwardingRefusedOn(host({ sshRemoteDaemon: null }), true, refusals)).toBe(true);
		expect(socketForwardingRefusedOn(undefined, true, refusals)).toBe(false);
	});
});

describe("a Windows host keeps its daemon through the relay (#755)", () => {
	const HELLO = Buffer.from(
		encodeFrame({
			type: "HELLO",
			version: 1,
			agentVersion: "0.0.0-test",
			capabilities: ["multiplex"],
		} as ProtocolMessage),
	);
	const AGENT = "C:\\Users\\me\\AppData\\Local\\lasterm\\lasterm-agent.exe";
	const ENCODED = "powershell -NoProfile -NonInteractive -EncodedCommand ";

	/** The PowerShell script inside an encoded command. */
	function script(command: string): string {
		expect(command.startsWith(ENCODED), command).toBe(true);
		return Buffer.from(command.slice(ENCODED.length), "base64").toString("utf16le");
	}

	/** The arguments an encoded launch passes to the program. */
	function argsOf(command: string): string {
		const encoded =
			/\$a=\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']*)'\)\)/.exec(
				script(command),
			)?.[1];
		expect(encoded, script(command)).toBeDefined();
		return Buffer.from(encoded ?? "", "base64").toString("utf8");
	}

	/**
	 * A connection whose relays answer in turn: `"nothing"` says nothing
	 * listens, `"hello"` relays the daemon's HELLO. Every outcome closes with
	 * exit status 1, as a PowerShell `DefaultShell` hands it on.
	 */
	function windowsConn(answers: ("nothing" | "hello" | "denied")[]) {
		const relays: string[] = [];
		const client = {
			exec(command: string, cb: (err: Error | undefined, ch?: unknown) => void) {
				relays.push(command);
				const channel = Object.assign(new PassThrough(), {
					stderr: new PassThrough(),
					close() {
						channel.emit("close");
					},
				});
				cb(undefined, channel);
				const answer = answers.shift() ?? "nothing";
				setImmediate(() => {
					channel.stderr.write("lasterm-attach: start\n");
					if (answer === "hello") {
						channel.write(HELLO);
						return;
					}
					channel.stderr.write(
						answer === "denied"
							? "lasterm-attach: denied\nthe pipe refused this account\n"
							: "lasterm-attach: nothing-listens\nnothing listens there\n",
					);
					channel.emit("exit", 1);
					channel.emit("close");
				});
			},
		} as unknown as Client;
		return { client, relays };
	}

	/** An exec whose launch says `stderr`, with `exitCode`; every command recorded. */
	function launchExec(stderr: string, exitCode: number) {
		const commands: string[] = [];
		const exec = async (_c: Client, command: string) => {
			commands.push(command);
			return { stdout: "", stderr, exitCode };
		};
		return { exec, commands };
	}

	it("relays, launches with --detach, then relays with --wait, with no --socket and no POSIX command", async () => {
		const { client, relays } = windowsConn(["nothing", "hello"]);
		const { exec, commands } = launchExec("lasterm-detach: started\n", 0);
		const attachment = await attachRemoteDaemon({
			conn: client,
			agentPath: AGENT,
			exec,
			os: "windows",
			connectTimeoutMs: 25_000,
		});

		expect(attachment.reachedThrough).toBe("relay");
		expect(attachment.started).toBe(true);
		expect(attachment.refusalProven).toBe(false);
		expect(relays).toHaveLength(2);
		expect(argsOf(relays[0] ?? "")).toBe("--attach --wait 0");
		expect(argsOf(relays[1] ?? "")).toBe("--attach --wait 10000");
		expect(commands).toHaveLength(1);
		expect(argsOf(commands[0] ?? "")).toBe(
			"--daemon --detach --log-level info --format jsonl --idle-timeout 1800 --log-files-kept 7",
		);
	});

	it("reaches a daemon already running with no launch", async () => {
		const { client, relays } = windowsConn(["hello"]);
		const { exec, commands } = launchExec("", 0);
		const attachment = await attachRemoteDaemon({
			conn: client,
			agentPath: AGENT,
			exec,
			os: "windows",
		});
		expect(attachment.started).toBe(false);
		expect(relays).toHaveLength(1);
		expect(commands).toEqual([]);
	});

	it("says the host forbids keeping it when breakaway is refused, whatever the exit status", async () => {
		const { client, relays } = windowsConn(["nothing"]);
		const { exec } = launchExec(
			"lasterm-detach: breakaway-refused\nthis SSH session's job does not allow a process to break away; the daemon would end with the connection\n",
			1,
		);
		const err = await attachRemoteDaemon({
			conn: client,
			agentPath: AGENT,
			exec,
			os: "windows",
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RemoteDaemonUnavailable);
		expect((err as RemoteDaemonUnavailable).reason).toBe(
			"this SSH session's job does not allow a process to break away; the daemon would end with the connection",
		);
		expect(relays).toHaveLength(1);
	});

	it.each([
		[
			"a launch that failed",
			"lasterm-detach: failed access is denied\n",
			1,
			/exit 1\): access is denied/,
		],
		["no marker, exit 0", "", 0, /exit 0\), and did not say why/],
		["no marker, exit 1", "something else\n", 1, /exit 1\), and did not say why/],
	])(
		"fails on %s, naming the log directory, with no stdio",
		async (_what, stderr, exitCode, said) => {
			const { client, relays } = windowsConn(["nothing"]);
			const { exec } = launchExec(stderr, exitCode);
			const err = await attachRemoteDaemon({
				conn: client,
				agentPath: AGENT,
				exec,
				os: "windows",
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err).not.toBeInstanceOf(RemoteDaemonUnavailable);
			expect((err as Error).message).toMatch(said);
			expect((err as Error).message).toContain("%LOCALAPPDATA%\\lasterm\\logs");
			expect(relays).toHaveLength(1);
		},
	);

	// The Windows timeout names the log directory and reads no tail (#755).
	// Mutation: the POSIX message, with its `tail` exec.
	it("says it did not answer, naming the log directory, after one launch and no tail", async () => {
		const { client, relays } = windowsConn(["nothing", "nothing"]);
		const { exec, commands } = launchExec("lasterm-detach: started\n", 0);
		const err = await attachRemoteDaemon({
			conn: client,
			agentPath: AGENT,
			exec,
			os: "windows",
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(
			/did not answer on the account's default named pipe within \d+ms/,
		);
		expect((err as Error).message).toContain("Its log is in %LOCALAPPDATA%\\lasterm\\logs.");
		expect(relays).toHaveLength(2);
		expect(commands).toHaveLength(1);
	});

	// The hub's logging settings reach a Windows daemon as a POSIX one's.
	// Mutation: the launch built from the agent path alone (defaults).
	it("passes the configured log level, format and files kept to the Windows launch", async () => {
		const { client } = windowsConn(["nothing", "hello"]);
		const { exec, commands } = launchExec("lasterm-detach: started\n", 0);
		await attachRemoteDaemon({
			conn: client,
			agentPath: AGENT,
			exec,
			os: "windows",
			logLevel: "debug",
			logFormat: "text",
			logFilesKept: 12,
		});
		expect(argsOf(commands[0] ?? "")).toBe(
			"--daemon --detach --log-level debug --format text --idle-timeout 1800 --log-files-kept 12",
		);
	});

	// A launch exec that never returns fails the connection; it is neither a
	// start nor a refused breakaway. Mutation: its rejection taken as either.
	it("fails with the launch exec's own error, with no second relay", async () => {
		const { client, relays } = windowsConn(["nothing"]);
		const exec = async (): Promise<never> => {
			throw new Error("SSH exec timed out after 10426ms");
		};
		const err = await attachRemoteDaemon({
			conn: client,
			agentPath: AGENT,
			exec,
			os: "windows",
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(RemoteDaemonUnavailable);
		expect((err as Error).message).toBe("SSH exec timed out after 10426ms");
		expect(relays).toHaveLength(1);
	});

	// AC-H4 on Windows: a relay that fails is unreachable, not "nothing runs".
	// Mutation: any Windows relay failure turned into NoRunningDaemon.
	it("a daemon-only reach whose relay is denied is unreachable, and launches nothing", async () => {
		const { client } = windowsConn(["denied"]);
		const { exec, commands } = launchExec("", 0);
		await expect(
			attachRemoteDaemon({ conn: client, agentPath: AGENT, exec, os: "windows", launch: false }),
		).rejects.toBeInstanceOf(DaemonUnreachable);
		expect(commands).toEqual([]);
	});

	it("a daemon-only reach finds nothing running, and launches nothing", async () => {
		const { client, relays } = windowsConn(["nothing"]);
		const { exec, commands } = launchExec("", 0);
		await expect(
			attachRemoteDaemon({ conn: client, agentPath: AGENT, exec, os: "windows", launch: false }),
		).rejects.toBeInstanceOf(NoRunningDaemon);
		expect(relays).toHaveLength(1);
		expect(commands).toEqual([]);
	});

	it("builds the Windows stop command with no socket", () => {
		expect(argsOf(windowsDaemonStopCommand(AGENT))).toBe("--stop");
	});
});

describe("detachOutcome (#755)", () => {
	// Read as the relay is, by its last marker, past what the shell wrote on
	// stderr before it. Mutation: the first marker, or the first line.
	it("reads the last marker, past what the shell printed before it", () => {
		expect(detachOutcome("AutoRun: welcome\r\nlasterm-detach: started\r\n", 0)).toBe("started");
		expect(detachOutcome("lasterm-detach: failed first\nlasterm-detach: started\n", 0)).toBe(
			"started",
		);
		expect(
			detachOutcome("lasterm-detach: started\nlasterm-detach: failed later\n", 1),
		).toBeInstanceOf(Error);
	});

	// A marker it does not know is no start, whatever the exit status.
	// Mutation: any marker with exit 0 taken as started.
	it("fails on an outcome it does not know, even with exit 0", () => {
		const outcome = detachOutcome("lasterm-detach: begun\n", 0);
		expect(outcome).toBeInstanceOf(Error);
		expect(outcome).not.toBeInstanceOf(RemoteDaemonUnavailable);
	});

	// A refused breakaway with no line after it still says why.
	// Mutation: an empty reason, which the dialog would not show.
	it("gives a refused breakaway with no line after it the job's reason", () => {
		const outcome = detachOutcome("lasterm-detach: breakaway-refused\n", 1);
		expect(outcome).toBeInstanceOf(RemoteDaemonUnavailable);
		expect((outcome as RemoteDaemonUnavailable).reason).toBe(
			"its SSH session's job does not allow a process to break away",
		);
	});

	it("cuts a stderr past 64 KiB and reads it as saying nothing", () => {
		const long = `${"x".repeat(64 * 1024)}\nlasterm-detach: started\n`;
		expect(detachOutcome(long, 0)).toBeInstanceOf(Error);
		expect(detachOutcome("lasterm-detach: started\n", 0)).toBe("started");
	});
});
