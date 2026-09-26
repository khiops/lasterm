import { describe, expect, it } from "vitest";
import {
	envNamesIgnoreCase,
	resolveEnvironmentChanges,
	spawnEnvironmentFields,
	spawnEnvMode,
	wantsLoginShell,
} from "./spawn-environment.js";

describe("resolveEnvironmentChanges", () => {
	it("passes on what the scopes set", () => {
		expect(resolveEnvironmentChanges([{ EDITOR: "hx" }, { LANG: "fr_FR.UTF-8" }], false)).toEqual({
			env: { EDITOR: "hx", LANG: "fr_FR.UTF-8" },
			unset: [],
		});
	});

	// null used to be dropped in the merge, so it could only undo an outer
	// scope's value. It now reaches the agent, which removes the variable it
	// would have passed on (#576).
	it("turns a null into a removal the agent applies", () => {
		expect(resolveEnvironmentChanges([{ NO_COLOR: null, EDITOR: "hx" }], false)).toEqual({
			env: { EDITOR: "hx" },
			unset: ["NO_COLOR"],
		});
	});

	it("lets the closer scope speak last, whichever way", () => {
		const global = { PAGER: "less", SSH_AUTH_SOCK: null };
		const host = { PAGER: null, EDITOR: "vi" };
		const channel = { SSH_AUTH_SOCK: "/tmp/agent.sock", EDITOR: null };

		expect(resolveEnvironmentChanges([global, host, channel], false)).toEqual({
			env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
			unset: ["PAGER", "EDITOR"],
		});
	});

	it("puts the launch profile's and the request's values over the scopes' removals", () => {
		const scope = { EDITOR: null, PAGER: null };
		const launchAndRequest = { EDITOR: "hx" };

		expect(resolveEnvironmentChanges([scope, launchAndRequest], false)).toEqual({
			env: { EDITOR: "hx" },
			unset: ["PAGER"],
		});
	});

	// profile_json and config.toml are data: a number there was never a
	// variable, and an empty name reaches the platform as a malformed entry.
	it("drops what a shell could not be given", () => {
		expect(
			resolveEnvironmentChanges([{ PORT: 4100, NAME: "keep", "": "unnamed", FLAG: false }], false),
		).toEqual({ env: { NAME: "keep" }, unset: [] });
	});

	it("survives a layer that is not an object at all", () => {
		expect(
			resolveEnvironmentChanges(["PATH=/usr/bin", null, undefined, ["A"], { OK: "yes" }], false),
		).toEqual({ env: { OK: "yes" }, unset: [] });
	});

	// A Unix shell reads Path and PATH as two variables.
	it("keeps names that differ by case apart on a host that tells them apart", () => {
		expect(resolveEnvironmentChanges([{ Path: "a" }, { PATH: "b", path: null }], false)).toEqual({
			env: { Path: "a", PATH: "b" },
			unset: ["path"],
		});
	});

	// On Windows they are one variable: a host's removal of PATH must not be
	// undone by the global scope's Path, which the agent would set after it.
	it("reads names without case on a host that does", () => {
		expect(resolveEnvironmentChanges([{ Path: "C:\\Tools" }, { PATH: null }], true)).toEqual({
			env: {},
			unset: ["PATH"],
		});
		expect(resolveEnvironmentChanges([{ temp: null }, { TEMP: "D:\\tmp" }], true)).toEqual({
			env: { TEMP: "D:\\tmp" },
			unset: [],
		});
	});
});

describe("envNamesIgnoreCase", () => {
	it("follows the host's OS when it is known", () => {
		expect(envNamesIgnoreCase({ type: "ssh", os: "windows" })).toBe(true);
		expect(envNamesIgnoreCase({ type: "ssh", os: "linux" })).toBe(false);
		expect(envNamesIgnoreCase({ type: "local", os: "linux" })).toBe(false);
	});

	it("takes the local host with no OS recorded for this machine", () => {
		expect(envNamesIgnoreCase({ type: "local", os: null })).toBe(process.platform === "win32");
		expect(envNamesIgnoreCase({ type: "ssh", os: null })).toBe(false);
	});
});

describe("wantsLoginShell", () => {
	const pi = { type: "ssh" as const, defaultShell: "/bin/bash" };

	it("asks for one on an SSH host running its default shell, as a shell, with no arguments", () => {
		expect(wantsLoginShell(pi, "/bin/bash", [], false)).toBe(true);
		expect(wantsLoginShell(pi, "/bin/bash", undefined, undefined)).toBe(true);
	});

	// No shell named: the agent starts its own default, the one it reported.
	it("counts no shell named as the default one", () => {
		expect(wantsLoginShell(pi, undefined, [], false)).toBe(true);
		expect(wantsLoginShell({ type: "ssh" }, undefined, [], false)).toBe(true);
	});

	it("leaves every other terminal as it was", () => {
		expect(wantsLoginShell(pi, "/usr/bin/zsh", [], false), "another shell").toBe(false);
		expect(wantsLoginShell(pi, "/bin/bash", ["-c", "htop"], false), "arguments").toBe(false);
		expect(wantsLoginShell(pi, "/bin/bash", [], true), "a direct process").toBe(false);
		expect(wantsLoginShell({ type: "ssh" }, "/bin/bash", [], false), "no default known").toBe(
			false,
		);
		expect(
			wantsLoginShell({ type: "local", defaultShell: "/bin/bash" }, "/bin/bash", [], false),
			"a local terminal",
		).toBe(false);
	});
});

describe("spawnEnvironmentFields", () => {
	it("says only what it has to", () => {
		expect(spawnEnvironmentFields({ env: { A: "1" }, unset: [] }, "inherit", false)).toEqual({
			env: { A: "1" },
			envMode: "inherit",
		});
		expect(spawnEnvironmentFields({ env: {}, unset: ["B"] }, "minimal", true)).toEqual({
			env: {},
			envUnset: ["B"],
			envMode: "minimal",
			loginShell: true,
		});
	});

	it("reads a mode as the agent does", () => {
		expect(spawnEnvMode("minimal")).toBe("minimal");
		expect(spawnEnvMode("inherit")).toBe("inherit");
		expect(spawnEnvMode("clean")).toBe("inherit");
		expect(spawnEnvMode(undefined)).toBe("inherit");
	});
});
