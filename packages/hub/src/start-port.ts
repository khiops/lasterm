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

function validPort(value: number, source: string, raw: string): number {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`Invalid ${source}: ${raw} — must be an integer between 1 and 65535`);
	}
	return value;
}
