import type { AgentSpawnMessage, EnvMode, Host } from "@lasterm/shared";

/**
 * What a SPAWN says about the environment its terminal starts with (#576).
 *
 * The agent builds that environment itself, from its own: the base for the
 * mode, its identity variables, then `envUnset`, then `env`. The hub's part is
 * to resolve the cascade — global, host, channel, then the launch profile and
 * the request — into values and removals.
 */
export type SpawnEnvironmentFields = Pick<
	AgentSpawnMessage,
	"env" | "envUnset" | "envMode" | "loginShell"
>;

/** The variables a spawn sets, and the ones it removes. */
export interface EnvironmentChanges {
	env: Record<string, string>;
	unset: string[];
}

/**
 * Whether a host's variable names compare without regard to case: Windows,
 * where `Path` and `PATH` are one variable. A host whose OS was never
 * detected is told by where it runs: the local one is this machine.
 */
export function envNamesIgnoreCase(host: Pick<Host, "type" | "os">): boolean {
	if (host.os != null) return host.os === "windows";
	return host.type === "local" && process.platform === "win32";
}

/**
 * Resolve layers of changes, outermost first, into what the agent applies.
 *
 * A value sets the variable, `null` removes it, and the same name set closer
 * wins either way: a channel can restore what its host removed, and remove
 * what the global scope set. Each layer comes from `profile_json` or
 * `config.toml`, which are data: a name that is empty, or a value that is
 * neither a string nor `null`, is not a change a platform can make, and is
 * left out.
 *
 * Names keep the case they were written with. Where the host reads them
 * without case, a closer layer's `PATH` replaces an outer one's `Path`: to the
 * shell they are one variable, and the closer scope speaks last.
 */
export function resolveEnvironmentChanges(
	layers: readonly unknown[],
	ignoreCase: boolean,
): EnvironmentChanges {
	const changes = new Map<string, { name: string; value: string | null }>();
	const keyOf = (name: string): string => (ignoreCase ? name.toUpperCase() : name);

	for (const layer of layers) {
		if (layer === null || typeof layer !== "object" || Array.isArray(layer)) continue;
		for (const [name, value] of Object.entries(layer as Record<string, unknown>)) {
			if (name === "") continue;
			if (typeof value !== "string" && value !== null) continue;
			const key = keyOf(name);
			changes.delete(key);
			changes.set(key, { name, value });
		}
	}

	const env: Record<string, string> = {};
	const unset: string[] = [];
	for (const { name, value } of changes.values()) {
		if (value === null) unset.push(name);
		else env[name] = value;
	}
	return { env, unset };
}

/**
 * Whether a terminal starts as a login shell.
 *
 * `ssh host` gives one, and a remote terminal takes its place: it reads
 * `~/.profile`, and `PATH` is right whatever the agent was started with. So a
 * terminal on an SSH host asks for one when it runs the host's default shell —
 * the one its agent reported, or none named, which is the agent's own default
 * — with no arguments, as a shell rather than a direct process. Local
 * terminals are unchanged: the desktop session already read the profile.
 */
export function wantsLoginShell(
	host: Pick<Host, "type" | "defaultShell">,
	shell: string | undefined,
	args: readonly string[] | undefined,
	directProcess: boolean | undefined,
): boolean {
	if (host.type !== "ssh") return false;
	if (directProcess === true) return false;
	if (args !== undefined && args.length > 0) return false;
	return shell === undefined || (host.defaultShell !== undefined && shell === host.defaultShell);
}

/** The mode a profile names, read as the agent reads it: anything else is `inherit`. */
export function spawnEnvMode(mode: unknown): EnvMode {
	return mode === "minimal" ? "minimal" : "inherit";
}

/** The environment fields of a SPAWN. */
export function spawnEnvironmentFields(
	changes: EnvironmentChanges,
	envMode: EnvMode,
	loginShell: boolean,
): SpawnEnvironmentFields {
	return {
		env: changes.env,
		...(changes.unset.length > 0 && { envUnset: changes.unset }),
		envMode,
		...(loginShell && { loginShell: true }),
	};
}
