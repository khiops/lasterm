import { expect } from "vitest";
import { FileAccessError, type FileErrorCode } from "./host-files.js";

/**
 * Names a host's files must come back with, byte for byte, whichever way the
 * hub reaches them (#832): spaces, quotes, `%`, `$`, backticks and non-ASCII
 * everywhere; a double quote, a line feed and a backslash only where the file
 * system that holds them allows them, which NTFS does not.
 */
export function roundTripNames(fileSystem: "posix" | "windows"): string[] {
	return [
		"with space",
		"it's",
		"100% done",
		"$HOME and %PATH%",
		"back`tick",
		"ünïcødé 日本",
		...(fileSystem === "windows" ? [] : ['dq"uote', "new\nline", "back\\slash"]),
	];
}

/** The names this machine's own file system can hold. */
export const LOCAL_ROUND_TRIP_NAMES = roundTripNames(
	process.platform === "win32" ? "windows" : "posix",
);

/** That `promise` rejects with a `FileAccessError` of `code`; its message, for more checks. */
export async function failsWith(promise: Promise<unknown>, code: FileErrorCode): Promise<string> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(FileAccessError);
	expect((error as FileAccessError).code).toBe(code);
	return (error as FileAccessError).message;
}
