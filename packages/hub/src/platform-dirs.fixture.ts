/**
 * Test-only: redirect the directories the hub resolves per platform.
 *
 * getStateDir() and getConfigDir() read LOCALAPPDATA and APPDATA on Windows and
 * XDG_STATE_HOME and XDG_CONFIG_HOME elsewhere. A spec that sets only the XDG
 * variable still reaches the developer's real %LOCALAPPDATA%\lasterm on Windows
 * (#333), so each root here sets both names that can carry it.
 */

const VARIABLES = {
	state: ["XDG_STATE_HOME", "LOCALAPPDATA"],
	config: ["XDG_CONFIG_HOME", "APPDATA"],
	cache: ["XDG_CACHE_HOME"],
} as const;

export interface PlatformDirRoots {
	/** Parent of the hub state directory: `<state>/lasterm` on every platform. */
	state?: string;
	/** Parent of the hub configuration directory: `<config>/lasterm`. */
	config?: string;
	/** XDG cache root; on Windows the cache lives under the state root. */
	cache?: string;
}

/** The same variables as an environment for a child process. */
export function platformDirEnv(roots: PlatformDirRoots): Record<string, string> {
	const env: Record<string, string> = {};
	for (const kind of Object.keys(VARIABLES) as (keyof typeof VARIABLES)[]) {
		const root = roots[kind];
		if (root === undefined) continue;
		for (const name of VARIABLES[kind]) env[name] = root;
	}
	return env;
}

/**
 * Point the platform-directory variables at the given roots and return a
 * function that restores them. A variable that was unset is deleted again:
 * assigning `undefined` would store the string "undefined".
 */
export function usePlatformDirs(roots: PlatformDirRoots): () => void {
	const saved = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(platformDirEnv(roots))) {
		saved.set(name, process.env[name]);
		process.env[name] = value;
	}
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}
