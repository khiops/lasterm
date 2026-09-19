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

function validPort(value: number, source: string, raw: string): number {
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`Invalid ${source}: ${raw} — must be an integer between 1 and 65535`);
	}
	return value;
}
