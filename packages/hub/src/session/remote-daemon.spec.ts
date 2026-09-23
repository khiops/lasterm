import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import {
	attachRemoteDaemon,
	hostKeepsDaemon,
	IDLE_TIMEOUT_SECONDS,
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
		expect(cmd).toContain("< /dev/null");
		expect(cmd).toContain(`>> ${paths.log} 2>&1`);
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
		expect(cmd).toContain("--format jsonl $idle");
	});
});

// The shell logic itself, run: a fake agent that records how it was started.
describe.skipIf(process.platform === "win32")("remoteDaemonLaunchCommand in a shell", () => {
	function launchWith(help: string): string[] {
		const root = mkdtempSync(path.join(os.tmpdir(), "daemon-launch-"));
		try {
			const agent = path.join(root, "lasterm-agent");
			const argv = path.join(root, "argv");
			writeFileSync(
				agent,
				`#!/bin/sh
if [ "$1" = "--help" ]; then printf '%s\n' '${help}'; exit 0; fi
printf '%s\n' "$@" > '${argv}'
`,
			);
			chmodSync(agent, 0o755);
			const cmd = remoteDaemonLaunchCommand({ agentPath: agent, paths: remoteDaemonPaths(root) });
			execFileSync("sh", ["-c", `${cmd}; wait`]);
			for (let i = 0; i < 50; i++) {
				try {
					return readFileSync(argv, "utf8").trim().split("\n");
				} catch {
					execFileSync("sleep", ["0.1"]);
				}
			}
			throw new Error("the fake agent was never started");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("starts an agent that does not know the option without it", () => {
		const argv = launchWith("Usage: lasterm-agent [OPTIONS]  --daemon  --socket <SOCKET>");
		expect(argv).toContain("--daemon");
		expect(argv).not.toContain("--idle-timeout");
	});

	it("passes it to an agent that does", () => {
		const argv = launchWith("      --idle-timeout <SECONDS>");
		expect(argv).toContain("--idle-timeout");
		expect(argv).toContain(String(IDLE_TIMEOUT_SECONDS));
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
