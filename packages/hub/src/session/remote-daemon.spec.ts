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
import type { Host } from "@lasterm/shared";
import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import {
	attachRemoteDaemon,
	DETACH_SCRIPT,
	describeRemoteDaemonPlacement,
	hostKeepsDaemon,
	hostTriesDaemon,
	IDLE_TIMEOUT_SECONDS,
	newRemoteDaemonScopeUnit,
	parseRemoteDaemonPlacement,
	parseRemoteSocketState,
	quotePosix,
	rememberSocketForwardingRefused,
	remoteDaemonLaunchCommand,
	remoteDaemonPaths,
	remoteDaemonStopCommand,
	remoteSocketStateCommand,
	SOCKET_FORWARDING_REFUSED_MESSAGE,
	type SocketForwardingRefusals,
	SocketForwardingRefused,
	socketForwardingRefusedOn,
} from "./remote-daemon.js";

const conn = {} as Client;

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

	it("refuses Windows whatever anyone says: no SSH channel carries a named pipe", () => {
		expect(hostKeepsDaemon({ os: "windows", sshRemoteDaemon: true }, true)).toBe(false);
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
		writeFileSync(
			agent,
			`#!/bin/sh
printf 'started\\n' >> ${quotePosix(starts)}
printf '%s\\n' "$@" > ${quotePosix(argv)}
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

describe("attachRemoteDaemon — a server that refuses socket forwarding (#765)", () => {
	const dir = "/home/pi/.local/state/lasterm";
	const socket = `${dir}/agent.sock`;
	/**
	 * What OpenSSH answers for `AllowStreamLocalForwarding no`, and for a
	 * socket nobody listens on alike: CONNECT_FAILED, "open failed".
	 */
	const openFailed = (): Error =>
		Object.assign(new Error("(SSH) Channel open failure: open failed"), { reason: 2 });

	/**
	 * A remote whose probe sees the daemon listening once it is launched, until
	 * a `--stop` says `stopped`; `stopSays` is what each `--stop` prints.
	 * `probe: false` is a remote that cannot say, and `binds: false` one whose
	 * daemon never listens.
	 */
	function remote(
		options: { listening?: boolean; stopSays?: string[]; probe?: boolean; binds?: boolean } = {},
	) {
		let listening = options.listening ?? false;
		const stopSays = [...(options.stopSays ?? ["stopped"])];
		const commands: string[] = [];
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
			if (command.includes("--stop")) {
				const said = stopSays.shift() ?? "stopped";
				if (said === "stopped") listening = false;
				return { stdout: `${said}\n`, exitCode: said === "stopped" ? 0 : 1 };
			}
			return stateDirReply(dir);
		};
		return {
			exec,
			commands,
			listening: () => listening,
			stops: () => commands.filter((c) => c.includes("--stop")),
		};
	}

	/** What the attempt was rejected with, which must be a refusal. */
	async function refusal(attempt: Promise<unknown>): Promise<SocketForwardingRefused> {
		const err = await attempt.then(
			() => new Error("reached a daemon that cannot be reached"),
			(caught: unknown) => caught,
		);
		expect(err).toBeInstanceOf(SocketForwardingRefused);
		return err as SocketForwardingRefused;
	}

	it("starts nothing when the server prohibits the channel type outright", async () => {
		const host = remote();
		const err = await refusal(
			attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				open: async () => {
					throw Object.assign(new Error("(SSH) Channel open failure: "), { reason: 1 });
				},
				sleep: async () => {},
			}),
		);

		expect(err.daemon).toEqual({ kind: "none" });
		expect(err.message).toBe(SOCKET_FORWARDING_REFUSED_MESSAGE);
		expect(host.commands.some((c) => c.includes("--daemon"))).toBe(false);
		expect(host.stops()).toEqual([]);
	});

	it("leaves a daemon that already listens alone", async () => {
		// Another connection, through another key or from another address, may
		// reach it and hold terminals there: stopping it is not this one's call.
		const host = remote({ listening: true });
		const err = await refusal(
			attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				open: async () => {
					throw openFailed();
				},
				sleep: async () => {},
			}),
		);

		expect(err.daemon).toEqual({ kind: "already-running" });
		expect(host.commands.some((c) => c.includes("--daemon"))).toBe(false);
		expect(host.stops()).toEqual([]);
		expect(host.listening()).toBe(true);
	});

	it("stops the daemon it started once it listens and the channel still fails", async () => {
		const host = remote();
		let clock = 0;
		const err = await refusal(
			attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				open: async () => {
					throw openFailed();
				},
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			}),
		);

		expect(err.daemon).toEqual({ kind: "stopped" });
		expect(err.message).toBe(
			"This host's SSH server refuses socket forwarding (AllowStreamLocalForwarding or " +
				"DisableForwarding in its sshd_config); the remote daemon needs it, see " +
				"docs/SSH_SERVER.md. The daemon this connection started there is stopped.",
		);
		expect(host.stops()).toEqual([`/usr/bin/lasterm-agent --stop --socket ${socket}`]);
		expect(host.listening()).toBe(false);
		// Said at the first poll that saw it listening, not at the deadline.
		expect(clock).toBeLessThan(1_000);
	});

	it("asks again when its stop came before the daemon published its record", async () => {
		const host = remote({ stopSays: ["no record", "stopped"] });
		const err = await refusal(
			attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				open: async () => {
					throw openFailed();
				},
				sleep: async () => {},
			}),
		);

		expect(err.daemon).toEqual({ kind: "stopped" });
		expect(host.stops()).toHaveLength(2);
	});

	it("says what --stop said when the daemon could not be stopped", async () => {
		const host = remote({ stopSays: ["still running at the bound"] });
		const err = await refusal(
			attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				open: async () => {
					throw openFailed();
				},
				sleep: async () => {},
			}),
		);

		expect(err.daemon).toEqual({ kind: "not-stopped", said: "still running at the bound" });
		expect(err.message).toMatch(
			/could not be stopped \(still running at the bound\); it ends by itself after 30 minutes/,
		);
	});

	it("waits for a daemon that does not listen yet, and stops nothing", async () => {
		const host = remote({ binds: false });
		let opens = 0;
		const attachment = await attachRemoteDaemon({
			conn,
			agentPath: "/usr/bin/lasterm-agent",
			exec: host.exec,
			open: async () => {
				opens += 1;
				if (opens < 4) throw openFailed();
				return new PassThrough();
			},
			sleep: async () => {},
		});

		expect(attachment.started).toBe(true);
		expect(host.stops()).toEqual([]);
	});

	it("names the server as a cause it cannot rule out only when the host cannot say", async () => {
		const failure = async (probe: boolean): Promise<string> => {
			let clock = 0;
			const host = remote({ probe, binds: false });
			const err = await attachRemoteDaemon({
				conn,
				agentPath: "/usr/bin/lasterm-agent",
				exec: host.exec,
				open: async () => {
					throw openFailed();
				},
				now: () => {
					clock += 1_000;
					return clock;
				},
				sleep: async () => {},
			}).then(
				() => new Error("reached a daemon that never listened"),
				(caught: unknown) => caught as Error,
			);
			return err.message;
		};

		expect(await failure(false)).toMatch(
			/did not answer.*could not say whether it listens.*docs\/SSH_SERVER\.md/,
		);
		const probed = await failure(true);
		expect(probed).toMatch(/did not answer/);
		expect(probed).not.toMatch(/SSH_SERVER/);
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

	it("keeps the next connection off the daemon, for the route it was seen on", () => {
		const refusals: SocketForwardingRefusals = new Map();
		expect(hostTriesDaemon(host(), false, refusals)).toBe(true);

		rememberSocketForwardingRefused(refusals, host());

		expect(hostTriesDaemon(host(), false, refusals)).toBe(false);
		expect(socketForwardingRefusedOn(host(), false, refusals)).toBe(true);
	});

	it.each([
		["another address", { sshHost: "pi.lan" }],
		["another account", { sshUser: "olivier" }],
		["another port", { sshPort: 2222 }],
		["another key", { sshKeyPath: "~/.ssh/other" }],
		["another jump", { sshProxySpec: "bastion.example" }],
		["its own answer about a daemon changed", { sshRemoteDaemon: null }],
	] as const)("tries the daemon again through %s", (_what, change) => {
		const refusals: SocketForwardingRefusals = new Map();
		rememberSocketForwardingRefused(refusals, host());

		expect(hostTriesDaemon(host(change), true, refusals)).toBe(true);
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
