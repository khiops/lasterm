import { describe, expect, it } from "vitest";
import {
	changeCounts,
	describeCounts,
	environmentRows,
	modeLabel,
	readChanges,
	removeVariable,
	renameVariable,
	restoreVariable,
	setVariable,
	toStored,
} from "./environmentSettings.js";

const pi = { HOME: "/home/pi", PATH: "/usr/bin:/bin", TERM: "xterm-256color" };

describe("readChanges", () => {
	it("keeps values and removals", () => {
		expect(readChanges({ EDITOR: "hx", NO_COLOR: null })).toEqual({ EDITOR: "hx", NO_COLOR: null });
	});

	// profile_json is data: an editor that throws on it is one nobody can use
	// to fix it.
	it("reads nothing out of what is not a map of variables", () => {
		expect(readChanges(undefined)).toEqual({});
		expect(readChanges("PATH=/usr/bin")).toEqual({});
		expect(readChanges(["A"])).toEqual({});
		expect(readChanges({ PORT: 4100, "": "unnamed", " ": "blank", OK: "yes" })).toEqual({
			OK: "yes",
		});
	});
});

describe("environmentRows", () => {
	it("shows the agent's variables, as a terminal gets them, in the order they are read", () => {
		expect(environmentRows(pi, [], {}, false)).toEqual([
			{ name: "HOME", value: "/home/pi", state: "inherited", from: "agent" },
			{ name: "PATH", value: "/usr/bin:/bin", state: "inherited", from: "agent" },
			{ name: "TERM", value: "xterm-256color", state: "inherited", from: "agent" },
		]);
	});

	it("marks what this scope removes, changes and adds", () => {
		const own = { HOME: null, PATH: "/opt/bin:/usr/bin:/bin", EDITOR: "hx" };

		expect(environmentRows(pi, [], own, false)).toEqual([
			{ name: "EDITOR", value: "hx", state: "added", from: null },
			{ name: "HOME", value: "/home/pi", state: "removed", from: "agent" },
			{
				name: "PATH",
				value: "/opt/bin:/usr/bin:/bin",
				state: "changed",
				from: "agent",
				before: "/usr/bin:/bin",
			},
			{ name: "TERM", value: "xterm-256color", state: "inherited", from: "agent" },
		]);
	});

	it("shows what the outer scopes change, and lets this one say otherwise", () => {
		const outer = [
			{ scope: "global" as const, changes: { PAGER: "less", TERM: null } },
			{ scope: "host" as const, changes: { PAGER: null, LANG: "C.UTF-8" } },
		];

		expect(environmentRows(pi, outer, { TERM: "screen-256color" }, false)).toEqual([
			{ name: "HOME", value: "/home/pi", state: "inherited", from: "agent" },
			{ name: "LANG", value: "C.UTF-8", state: "inherited", from: "host" },
			{ name: "PAGER", value: "less", state: "removed-above", from: "host" },
			{ name: "PATH", value: "/usr/bin:/bin", state: "inherited", from: "agent" },
			// Removed at Global, set again here: to this scope, an addition.
			{ name: "TERM", value: "screen-256color", state: "added", from: null },
		]);
	});

	// A removal of what the host does not have yet is still a change this
	// scope holds, and has to be seen to be undone.
	it("lists a removal of a variable the host does not have", () => {
		expect(environmentRows(pi, [], { SSH_AUTH_SOCK: null }, false)).toContainEqual({
			name: "SSH_AUTH_SOCK",
			value: "",
			state: "removed",
			from: null,
		});
	});

	// At global scope there is no agent to ask: the rows are the changes.
	it("shows the changes alone when there is no agent to ask", () => {
		expect(environmentRows(null, [], { NO_COLOR: null, EDITOR: "hx" }, false)).toEqual([
			{ name: "EDITOR", value: "hx", state: "added", from: null },
			{ name: "NO_COLOR", value: "", state: "removed", from: null },
		]);
	});

	it("reads Path and PATH as one variable on a Windows host, keeping the host's name", () => {
		const windows = { Path: "C:\\Windows", TEMP: "C:\\Temp" };

		expect(environmentRows(windows, [], { PATH: "C:\\Tools", temp: null }, true)).toEqual([
			{
				name: "Path",
				value: "C:\\Tools",
				state: "changed",
				from: "agent",
				before: "C:\\Windows",
			},
			{ name: "TEMP", value: "C:\\Temp", state: "removed", from: "agent" },
		]);
		// Elsewhere they are two.
		expect(
			environmentRows({ Path: "a" }, [], { PATH: "b" }, false).map((row) => [row.name, row.state]),
		).toEqual([
			["Path", "inherited"],
			["PATH", "added"],
		]);
	});
});

describe("counting what a scope changes", () => {
	it("counts removals, changes and additions, and says them", () => {
		const rows = environmentRows(pi, [], { HOME: null, PATH: "/x", A: "1", B: "2" }, false);

		expect(changeCounts(rows)).toEqual({ removed: 1, changed: 1, added: 2 });
		expect(describeCounts(changeCounts(rows))).toBe("1 removed · 1 changed · 2 added");
		expect(describeCounts({ removed: 0, changed: 0, added: 0 })).toBe("");
	});

	it("names the mode, customized when the scope changes it", () => {
		expect(modeLabel("inherit", false)).toBe("Inherited");
		expect(modeLabel("inherit", true)).toBe("Inherited (customized)");
		expect(modeLabel("minimal", true)).toBe("Minimal (customized)");
	});
});

describe("editing a scope's changes", () => {
	it("stores a removal as null, a value as itself", () => {
		expect(removeVariable({}, "HOME", false)).toEqual({ HOME: null });
		expect(setVariable({ HOME: null }, "HOME", "/srv", false)).toEqual({ HOME: "/srv" });
	});

	it("restores by taking this scope's change back, and stores nothing when none is left", () => {
		const own = restoreVariable({ HOME: null, EDITOR: "hx" }, "HOME", false);

		expect(own).toEqual({ EDITOR: "hx" });
		expect(toStored(restoreVariable(own, "EDITOR", false))).toBeNull();
	});

	it("renames an added variable, keeping its value", () => {
		expect(renameVariable({ EDTIOR: "hx" }, "EDTIOR", "EDITOR", "hx", false)).toEqual({
			EDITOR: "hx",
		});
	});

	it("ignores a name that is only blanks", () => {
		expect(setVariable({}, "  ", "x", false)).toEqual({});
		expect(removeVariable({}, "", false)).toEqual({});
	});

	// On Windows the variable is one, whatever case each scope wrote it in: a
	// scope holds one change for it, not two that would fight.
	it("keeps one change per variable where case does not count", () => {
		expect(removeVariable({ Path: "C:\\Tools" }, "PATH", true)).toEqual({ PATH: null });
		expect(restoreVariable({ temp: null }, "TEMP", true)).toEqual({});
		expect(setVariable({ Path: "a" }, "PATH", "b", false)).toEqual({ Path: "a", PATH: "b" });
	});
});
