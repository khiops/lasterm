import { describe, expect, it } from "vitest";
import {
	baseNameOf,
	joinHostPath,
	normaliseHostPath,
	parentOf,
	pathStyleOf,
	WINDOWS_ROOT,
} from "./host-paths.js";

const posix = (path: string) => normaliseHostPath(path, "posix");
const windows = (path: string) => normaliseHostPath(path, "windows");

describe("normaliseHostPath on a POSIX host", () => {
	it.each([
		["/", "/"],
		["/home/u", "/home/u"],
		["/home/u/", "/home/u"],
		["//home//u///x", "/home/u/x"],
		// Taken literally: nothing in a name is expanded.
		["/home/u/$HOME `x` 'q' \"d\" 100%", "/home/u/$HOME `x` 'q' \"d\" 100%"],
		["/tmp/a\nb", "/tmp/a\nb"],
		["/home/u/%USERPROFILE%", "/home/u/%USERPROFILE%"],
		["/srv/ünï cødé", "/srv/ünï cødé"],
	])("takes %j as %j", (input, expected) => {
		expect(posix(input)).toEqual({ ok: true, path: expected });
	});

	it.each([
		["", "empty"],
		["home/u", "not absolute"],
		["~/x", "~ is not expanded"],
		["$HOME/x", "environment variables are not expanded"],
		["/home/../etc", ". or .. segment"],
		["/home/./u", ". or .. segment"],
		["/a\0b", "NUL"],
		["C:\\Users", "not absolute"],
	])("refuses %j, saying why (%s)", (input, why) => {
		const result = posix(input);
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain(why);
	});
});

describe("normaliseHostPath on a Windows host", () => {
	it.each([
		// The three forms a Windows path takes, as the issue names them.
		["C:\\x", "C:\\x"],
		["C:/x", "C:\\x"],
		["/C:/x", "C:\\x"],
		["c:\\Users\\me\\", "C:\\Users\\me"],
		["C:\\\\a\\\\b", "C:\\a\\b"],
		// A drive's root, however it is spelled.
		["C:\\", "C:\\"],
		["C:", "C:\\"],
		["/C:", "C:\\"],
		["/C:/", "C:\\"],
		// The drives.
		["/", WINDOWS_ROOT],
		["\\", WINDOWS_ROOT],
		// UNC paths are accepted.
		["\\\\server\\share", "\\\\server\\share"],
		["\\\\server\\share\\dir\\", "\\\\server\\share\\dir"],
		["//server/share/dir", "\\\\server\\share\\dir"],
		// Names keep what Windows allows, taken literally.
		["C:\\it's 100% $HOME `x`", "C:\\it's 100% $HOME `x`"],
		["C:\\50% off 20%", "C:\\50% off 20%"],
		["D:\\Données\\ünï", "D:\\Données\\ünï"],
	])("takes %j as %j", (input, expected) => {
		expect(windows(input)).toEqual({ ok: true, path: expected });
	});

	it.each([
		["%USERPROFILE%\\Desktop", "environment variable (%NAME%)"],
		["C:\\Users\\%USERNAME%", "environment variable (%NAME%)"],
		["%ProgramFiles(x86)%", "environment variable (%NAME%)"],
		["Users\\me", "not absolute"],
		["\\Windows", "names no drive"],
		["C:Windows", "drive-relative"],
		["\\\\server", "server and a share"],
		["\\\\?\\C:\\x", "device paths"],
		["\\\\.\\pipe\\x", "device paths"],
		["C:\\a\\..\\b", ". or .. segment"],
		['C:\\a"b', "no Windows name may"],
		["C:\\a|b", "no Windows name may"],
		["C:\\a\nb", "no Windows name may"],
		["C:\\file:stream", "no Windows name may"],
		["", "empty"],
	])("refuses %j, saying why (%s)", (input, why) => {
		const result = windows(input);
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain(why);
	});
});

describe("paths built from a listing", () => {
	it("joins a name onto a folder, the drives' root included", () => {
		expect(joinHostPath("/", "etc", "posix")).toBe("/etc");
		expect(joinHostPath("/home/u", "a b", "posix")).toBe("/home/u/a b");
		expect(joinHostPath(WINDOWS_ROOT, "C:", "windows")).toBe("C:\\");
		expect(joinHostPath("C:\\", "Users", "windows")).toBe("C:\\Users");
		expect(joinHostPath("C:\\Users", "me", "windows")).toBe("C:\\Users\\me");
		// A drive joined as a client would, onto the root, normalises to the same.
		expect(windows(`${WINDOWS_ROOT}C:`)).toEqual({ ok: true, path: "C:\\" });
	});

	it("names the last segment, and a root by itself", () => {
		expect(baseNameOf("/home/u", "posix")).toBe("u");
		expect(baseNameOf("/", "posix")).toBe("/");
		expect(baseNameOf("C:\\Users", "windows")).toBe("Users");
		expect(baseNameOf("C:\\", "windows")).toBe("C:");
		expect(baseNameOf(WINDOWS_ROOT, "windows")).toBe(WINDOWS_ROOT);
	});

	it("goes up to the parent, from a drive to the drives, and no further than a root", () => {
		expect(parentOf("/home/u", "posix")).toBe("/home");
		expect(parentOf("/home", "posix")).toBe("/");
		expect(parentOf("/", "posix")).toBeNull();
		expect(parentOf("C:\\Users\\me", "windows")).toBe("C:\\Users");
		expect(parentOf("C:\\Users", "windows")).toBe("C:\\");
		expect(parentOf("C:\\", "windows")).toBe(WINDOWS_ROOT);
		expect(parentOf(WINDOWS_ROOT, "windows")).toBeNull();
		expect(parentOf("\\\\server\\share\\x", "windows")).toBe("\\\\server\\share");
		expect(parentOf("\\\\server\\share", "windows")).toBeNull();
	});

	it("spells Windows paths for a Windows host and POSIX ones for any other", () => {
		expect(pathStyleOf("windows")).toBe("windows");
		expect(pathStyleOf("linux")).toBe("posix");
		expect(pathStyleOf("darwin")).toBe("posix");
	});
});
