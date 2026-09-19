import { describe, expect, it } from "vitest";
import {
	lastermDir,
	type PlatformDirContext,
	PlatformDirError,
	platformBaseDir,
} from "./platform-dirs.js";

function windows(env: Record<string, string | undefined>): PlatformDirContext {
	return { platform: "win32", env, homedir: () => "C:\\Users\\jane" };
}

function linux(env: Record<string, string | undefined>, home = "/home/jane"): PlatformDirContext {
	return { platform: "linux", env, homedir: () => home };
}

describe("platformBaseDir on Windows", () => {
	it("uses LOCALAPPDATA for state and cache and APPDATA for configuration", () => {
		const context = windows({
			LOCALAPPDATA: "C:\\Users\\jane\\AppData\\Local",
			APPDATA: "C:\\Users\\jane\\AppData\\Roaming",
		});
		expect(platformBaseDir("state", context)).toBe("C:\\Users\\jane\\AppData\\Local");
		expect(platformBaseDir("cache", context)).toBe("C:\\Users\\jane\\AppData\\Local");
		expect(platformBaseDir("config", context)).toBe("C:\\Users\\jane\\AppData\\Roaming");
	});

	it.each([
		["absent", undefined, /LOCALAPPDATA is absent or empty/],
		["empty", "", /LOCALAPPDATA is absent or empty/],
		["relative", "AppData\\Local", /LOCALAPPDATA is not an absolute path \(AppData\\Local\)/],
	])(
		"refuses a %s LOCALAPPDATA, naming it, rather than inventing a directory",
		(_case, value, message) => {
			const context = windows({ LOCALAPPDATA: value, APPDATA: "C:\\Roaming" });
			expect(() => platformBaseDir("state", context)).toThrow(PlatformDirError);
			expect(() => platformBaseDir("state", context)).toThrow(message);
		},
	);

	it("refuses a missing APPDATA for configuration instead of falling back to LOCALAPPDATA", () => {
		const context = windows({ LOCALAPPDATA: "C:\\Local" });
		expect(() => platformBaseDir("config", context)).toThrow(/APPDATA is absent or empty/);
	});

	it("never reads the XDG variables", () => {
		const context = windows({ XDG_STATE_HOME: "C:\\xdg", LOCALAPPDATA: "C:\\Local" });
		expect(platformBaseDir("state", context)).toBe("C:\\Local");
	});
});

describe("platformBaseDir elsewhere", () => {
	it("uses an absolute XDG variable", () => {
		const context = linux({
			XDG_STATE_HOME: "/xdg/state",
			XDG_CONFIG_HOME: "/xdg/config",
			XDG_CACHE_HOME: "/xdg/cache",
		});
		expect(platformBaseDir("state", context)).toBe("/xdg/state");
		expect(platformBaseDir("config", context)).toBe("/xdg/config");
		expect(platformBaseDir("cache", context)).toBe("/xdg/cache");
	});

	it.each([
		["absent", undefined],
		["empty", ""],
		["relative", "relative/state"],
	])("ignores a %s XDG variable and uses the home-directory default", (_case, value) => {
		const context = linux({ XDG_STATE_HOME: value, XDG_CONFIG_HOME: value, XDG_CACHE_HOME: value });
		expect(platformBaseDir("state", context)).toBe("/home/jane/.local/state");
		expect(platformBaseDir("config", context)).toBe("/home/jane/.config");
		expect(platformBaseDir("cache", context)).toBe("/home/jane/.cache");
	});

	it.each([
		["relative", "jane"],
		["empty", ""],
	])("refuses when the XDG variable is unusable and the home directory is %s", (_case, home) => {
		const context = linux({ XDG_STATE_HOME: "relative" }, home);
		expect(() => platformBaseDir("state", context)).toThrow(PlatformDirError);
		expect(() => platformBaseDir("state", context)).toThrow(
			/XDG_STATE_HOME is not an absolute path/,
		);
	});
});

describe("lastermDir", () => {
	it("appends the product name, keeping the Windows cache inside the state tree", () => {
		const win = windows({ LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming" });
		expect(lastermDir("state", win)).toBe("C:\\Local\\lasterm");
		expect(lastermDir("config", win)).toBe("C:\\Roaming\\lasterm");
		expect(lastermDir("cache", win)).toBe("C:\\Local\\lasterm\\cache");

		const posix = linux({});
		expect(lastermDir("state", posix)).toBe("/home/jane/.local/state/lasterm");
		expect(lastermDir("config", posix)).toBe("/home/jane/.config/lasterm");
		expect(lastermDir("cache", posix)).toBe("/home/jane/.cache/lasterm");
	});
});
