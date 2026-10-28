import type { Client as SshClient } from "ssh2";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The most the remote shell's start-up may add to a command's bound (#749).
 *
 * The server runs every command through the account's shell, and that shell
 * may take a while to start before the command does: a PowerShell
 * `DefaultShell` on Windows loads the account's profile first, since sshd
 * passes no `-NoProfile` (six seconds on a development machine). Each command
 * pays it, so a bound that ignored it would leave the command itself little or
 * no time.
 */
export const SHELL_START_CEILING_MS = 30_000;

/** How long the first command of each connection took, its shell's start-up included (#749). */
const shellStarts = new WeakMap<SshClient, number>();

/**
 * What the remote shell's start-up adds to each bound on this connection, as
 * its first command measured it, up to `SHELL_START_CEILING_MS`; null until
 * that command has ended (#749).
 */
export function shellStartAllowance(client: SshClient): number | null {
	return shellStarts.get(client) ?? null;
}

/**
 * Execute a command over SSH and return { stdout, stderr, exitCode }.
 * Resolves when the command exits. Rejects on SSH-level errors or timeout.
 *
 * The bound is `timeoutMs` plus the shell's start-up on this connection
 * (#749): the first command of a connection may take `SHELL_START_CEILING_MS`
 * more, and what it took, the shell's start-up and its own work, up to that
 * ceiling, is what every later command gets on top of its own bound. A host
 * whose shell starts at once keeps its bounds as they were; one with a slow
 * profile gets the time it needs, measured rather than assumed, since nothing
 * says which shell the server runs.
 *
 * Uses ssh2 Client.exec() (not child_process.exec) - no shell injection risk.
 * Commands are sent verbatim over the SSH channel to the remote host.
 */
export function sshExec(
	client: SshClient,
	command: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const boundMs = timeoutMs + (shellStarts.get(client) ?? SHELL_START_CEILING_MS);
	const started = Date.now();
	// The first command of the connection to end says what the shell costs.
	const measure = (): void => {
		if (!shellStarts.has(client)) {
			shellStarts.set(client, Math.min(Date.now() - started, SHELL_START_CEILING_MS));
		}
	};
	return new Promise((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			measure();
			reject(new Error(`SSH exec timed out after ${boundMs}ms: ${command}`));
		}, boundMs);

		client.exec(command, (err, stream) => {
			if (err) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
				return;
			}

			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];

			stream.on("data", (chunk: Buffer) => {
				stdoutChunks.push(chunk);
			});

			stream.stderr.on("data", (chunk: Buffer) => {
				stderrChunks.push(chunk);
			});

			stream.on("close", (code: number | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				measure();
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
					exitCode: code ?? 1,
				});
			});

			stream.on("error", (streamErr: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(streamErr);
			});
		});
	});
}
