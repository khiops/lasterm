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
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import {
	attachRemoteDaemon,
	DETACH_SCRIPT,
	describeRemoteDaemonPlacement,
	hostKeepsDaemon,
	IDLE_TIMEOUT_SECONDS,
	newRemoteDaemonScopeUnit,
	parseRemoteDaemonPlacement,
	quotePosix,
	remoteDaemonLaunchCommand,
	remoteDaemonPaths,
	remoteDaemonStopCommand,
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
		expect(launch).toContain('set -- "$@" --log-files-kept 0; fi');
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

// ─── A binary older than the hub (the Pi, on 2026-09-23) ─────────────────────
//
// A build of main carries the last release's version and deploys that release's
// agent. The daemon launch passed `--idle-timeout`, added since: the 0.11.0
// agent on the Pi answered "unexpected argument", exited, and the hub waited
// for a socket that never came, then said only "Agent HELLO timeout".

describe("remoteDaemonLaunchCommand — an agent older than the hub", () => {
	const paths = remoteDaemonPaths("/home/pi/.local/state/lasterm");

	it("asks the binary whether it knows --idle-timeout before passing it", () => {
		const cmd = remoteDaemonLaunchCommand({ agentPath: "/usr/bin/lasterm-agent", paths });
		expect(cmd).toContain("/usr/bin/lasterm-agent --help");
		expect(cmd).toContain("grep -q -- '--idle-timeout'");
		expect(cmd).toContain(`--format jsonl --idle-timeout ${IDLE_TIMEOUT_SECONDS}; else set --`);
		expect(cmd).toMatch(/--format jsonl; fi/);
	});

	it("asks it about --log-files-kept too, and appends it to what was set (#646)", () => {
		const cmd = remoteDaemonLaunchCommand({
			agentPath: "/usr/bin/lasterm-agent",
			paths,
			logFilesKept: 30,
		});
		expect(cmd).toContain(
			"/usr/bin/lasterm-agent --help 2> /dev/null | grep -q -- '--log-files-kept'; " +
				'then set -- "$@" --log-files-kept 30; fi',
		);
		// Once the argv is set, and before the daemon is started with it.
		const asked = cmd.indexOf("grep -q -- '--log-files-kept'");
		expect(asked).toBeGreaterThan(cmd.indexOf("grep -q -- '--idle-timeout'"));
		expect(asked).toBeLessThan(cmd.indexOf("detach="));
	});

	it("keeps seven files unless told otherwise, and passes a whole count, 0 included", () => {
		const count = (logFilesKept?: number) =>
			remoteDaemonLaunchCommand({
				agentPath: "/usr/bin/lasterm-agent",
				paths,
				...(logFilesKept !== undefined && { logFilesKept }),
			}).match(/--log-files-kept (\S+); fi/)?.[1];
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
		help?: string;
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
		for (const tool of ["mkdir", "chmod", "grep", "setsid", "nohup", "id"]) {
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
if [ "$1" = "--help" ]; then printf '%s\\n' ${quotePosix(options.help ?? "      --idle-timeout <SECONDS>")}; exit 0; fi
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

/** What `--help` prints in an agent that knows both options the launch asks about. */
const HELP_WITH_FILES_KEPT = "      --idle-timeout <SECONDS>\n      --log-files-kept <COUNT>";

describe.skipIf(!onPosix)("remoteDaemonLaunchCommand in a shell", () => {
	it("starts an agent that does not know the option without it", () => {
		const { argv } = launchIn({
			help: "Usage: lasterm-agent [OPTIONS]  --daemon  --socket <SOCKET>",
		});
		expect(argv).toContain("--daemon");
		expect(argv).not.toContain("--idle-timeout");
	});

	it("passes it to an agent that does", () => {
		const { argv } = launchIn({ help: "      --idle-timeout <SECONDS>" });
		expect(argv).toContain("--idle-timeout");
		expect(argv).toContain(String(IDLE_TIMEOUT_SECONDS));
	});

	it("passes --log-files-kept, last, to an agent that knows it (#646)", () => {
		const { argv } = launchIn({ help: HELP_WITH_FILES_KEPT, logFilesKept: 30 });
		expect(argv.slice(-4)).toEqual([
			"--idle-timeout",
			String(IDLE_TIMEOUT_SECONDS),
			"--log-files-kept",
			"30",
		]);
	});

	it("starts an agent that does not know --log-files-kept without it", () => {
		const { argv } = launchIn({ logFilesKept: 30 });
		expect(argv).toContain("--idle-timeout");
		expect(argv).not.toContain("--log-files-kept");
	});

	it("passes --log-files-kept to an agent that knows only it", () => {
		const { argv } = launchIn({ help: "      --log-files-kept <COUNT>" });
		expect(argv).not.toContain("--idle-timeout");
		expect(argv.slice(-2)).toEqual(["--log-files-kept", "7"]);
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
				help: HELP_WITH_FILES_KEPT,
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
