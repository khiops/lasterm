// Types of tauri-channel.mjs, which plain Node runs as the package's tauri script.
export function channelArgs(
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): string[];
