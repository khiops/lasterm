import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

/** Resolve the only state root used by the hub. */
export function getStateDir(): string {
	let stateDir: string;
	let environmentVariable: string;
	if (process.platform === "win32") {
		stateDir = join(process.env.LOCALAPPDATA ?? "", "lasterm");
		environmentVariable = "LOCALAPPDATA";
	} else {
		stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "lasterm");
		environmentVariable = "XDG_STATE_HOME";
	}
	return requireAbsoluteDirectory(stateDir, environmentVariable);
}

/** Resolve the only config root used by the hub. */
export function getConfigDir(): string {
	let configDir: string;
	let environmentVariable: string;
	if (process.platform === "win32") {
		configDir = join(process.env.APPDATA ?? "", "lasterm");
		environmentVariable = "APPDATA";
	} else {
		configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lasterm");
		environmentVariable = "XDG_CONFIG_HOME";
	}
	return requireAbsoluteDirectory(configDir, environmentVariable);
}

function requireAbsoluteDirectory(directory: string, environmentVariable: string): string {
	const isWindows = process.platform === "win32";
	const driveQualified = /^[A-Za-z]:[\\/]/.test(directory);
	const isUnc = directory.startsWith("\\\\");
	if (
		!(isWindows ? win32.isAbsolute(directory) && driveQualified && !isUnc : isAbsolute(directory))
	) {
		throw new Error(
			`${environmentVariable} must resolve to an absolute directory on ${process.platform}; set ${environmentVariable} to an absolute path`,
		);
	}
	return directory;
}
