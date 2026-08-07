import net from "node:net";
import os from "node:os";
import path from "node:path";

/** Timeout for waiting for agent daemon socket (ms) */
export const AGENT_SOCKET_TIMEOUT = 5000;

/** Poll interval when waiting for agent socket (ms) */
export const AGENT_SOCKET_POLL_MS = 100;

/**
 * Get the platform-appropriate socket path for the agent daemon.
 *
 * - Linux/macOS: `$XDG_RUNTIME_DIR/lasterm/agent.sock` (fallback: `/tmp/lasterm-<UID>/agent.sock`)
 * - Windows: `\\.\pipe\lasterm-agent-<username>`
 *
 * @param override Optional override path from config.toml [agent].socket_path
 */
export function getSocketPath(override?: string): string {
	if (override) return override;

	if (process.platform === "win32") {
		const username = os.userInfo().username;
		return `\\\\.\\pipe\\lasterm-agent-${username}`;
	}

	// Unix: prefer XDG_RUNTIME_DIR, fallback to /tmp/lasterm-<UID>
	const xdgRuntime = process.env.XDG_RUNTIME_DIR;
	if (xdgRuntime) {
		return path.join(xdgRuntime, "lasterm", "agent.sock");
	}

	const uid = os.userInfo().uid;
	return path.join("/tmp", `lasterm-${uid}`, "agent.sock");
}

/**
 * Probe a socket path to check if an agent daemon is listening.
 *
 * @returns true if agent is listening, false if socket is absent/stale
 * @throws Error with code EACCES if permission denied (different user's socket — do NOT unlink)
 */
export function probeSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);

		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});

		socket.once("error", (err: NodeJS.ErrnoException) => {
			socket.destroy();
			if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
				resolve(false);
			} else if (err.code === "EACCES") {
				const msg = `Permission denied probing socket: ${socketPath} (owned by different user)`;
				reject(new Error(msg));
			} else {
				reject(err);
			}
		});
	});
}
