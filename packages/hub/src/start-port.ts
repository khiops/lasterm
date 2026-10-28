/**
 * The port a hub is asked to listen on: the `--port` flag, else `LASTERM_PORT`,
 * else none, and the operating system assigns one (SPEC.md § 3). Both entry
 * points go through here, so `lasterm start` and the bare entry point no longer
 * disagree about the environment variable (#175). An empty variable counts as
 * unset, as shells commonly write it.
 */
export function resolveStartPort(
	flag: number | undefined,
	env: string | undefined,
): number | undefined {
	if (flag !== undefined) return validPort(flag, "--port", String(flag));
	if (env !== undefined && env !== "") return validPort(Number(env), "LASTERM_PORT", env);
	return undefined;
}

/** What a start reads from its environment: its port, and whether to open a browser. */
const START_ENVIRONMENT = ["LASTERM_PORT", "LASTERM_OPEN"] as const;

/**
 * Take a start's own variables out of the environment once the entry point has
 * read them (#540). `lasterm start --daemon` hands the port and `--open` to its
 * child through them, and a user may set them too. The hub's environment passes
 * to the agent it spawns, then to every shell the agent starts, which gets the
 * agent's whole environment. There `LASTERM_OPEN` made any `lasterm start` typed
 * in a terminal open a browser, and `LASTERM_PORT` sent it to the port of the hub
 * already serving. They were meant for this start, as `LASTERM_DAEMON_LOG` is,
 * which the hub also removes (`logging/daemon-log.ts`).
 */
export function forgetStartEnvironment(env: NodeJS.ProcessEnv): void {
	for (const name of START_ENVIRONMENT) delete env[name];
}

const HIGHEST_PORT = 65535;
/** How far above an explicit port a start may move (zero_conf, CLAUDE.md "Port"). */
const PORT_WINDOW = 99;
/** The first port that needs no privilege on Linux and the other POSIX systems. */
const FIRST_UNPRIVILEGED_PORT = 1024;

function validPort(value: number, source: string, raw: string): number {
	if (!Number.isInteger(value) || value < 1 || value > HIGHEST_PORT) {
		throw new Error(`Invalid ${source}: ${raw} — must be an integer between 1 and 65535`);
	}
	return value;
}

/**
 * Listen on an explicit port, or on the first usable one up to 99 above it,
 * never past 65535 (zero_conf). A port is passed over when it is taken
 * (`EADDRINUSE`), or refused (`EACCES`) where a refusal means the port is
 * reserved for something else:
 *
 * - On Windows, always. It refuses the ranges Hyper-V, WSL and Docker reserve
 *   (`netsh interface ipv4 show excludedportrange protocol=tcp`), which move
 *   between boots and which no process may bind. The system never assigns one,
 *   but an explicit port, or the next one up, can fall in one (#573).
 * - On POSIX, from 1024: a policy on that port, such as an SELinux label for
 *   another service. Below 1024 the refusal means the port is privileged and
 *   the hub lacks the right. Every port up to 1023 answers the same, so walking
 *   up would only end on 1024 or above, swapping the well-known port asked for
 *   for an arbitrary one without a word. The start fails there and says why.
 *
 * Any other error ends the start as it came. The system-assigned path (no
 * explicit port) never comes here.
 */
export async function listenFromPort(
	basePort: number,
	listen: (port: number) => Promise<string>,
	platform: NodeJS.Platform = process.platform,
): Promise<{ address: string; port: number }> {
	const lastPort = Math.min(basePort + PORT_WINDOW, HIGHEST_PORT);
	let inUse = 0;
	let refused = 0;
	let lastError: unknown;
	for (let port = basePort; port <= lastPort; port++) {
		try {
			return { address: await listen(port), port };
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "EADDRINUSE") {
				inUse++;
			} else if (code === "EACCES" && (platform === "win32" || port >= FIRST_UNPRIVILEGED_PORT)) {
				refused++;
			} else if (code === "EACCES") {
				throw new Error(
					`Port ${port} is privileged and this process may not bind it (EACCES). ` +
						`Ask for a port from ${FIRST_UNPRIVILEGED_PORT}, or for none and let the system choose one.`,
					{ cause: err },
				);
			} else {
				throw err;
			}
			lastError = err;
		}
	}
	const reasons = [
		...(inUse > 0 ? [`${inUse} in use`] : []),
		...(refused > 0 ? [`${refused} refused by the system`] : []),
	].join(", ");
	const reserved =
		refused > 0 && platform === "win32"
			? " Windows refuses the port ranges it reserves; " +
				"`netsh interface ipv4 show excludedportrange protocol=tcp` lists them."
			: "";
	throw new Error(
		`No port free from ${basePort} to ${lastPort} (${reasons}).${reserved} ` +
			"Ask for another port, or for none and let the system choose one.",
		{ cause: lastError },
	);
}
