/**
 * cdp-lib.spec.ts
 *
 * The parts of scripts/dev/ui/cdp.mjs that decide something without a page or
 * a hub: its command line, the text it reads from files, where it finds the
 * hub, and what it sends there. Nothing here reaches a page or a hub.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import type { PlatformDirContext } from "../../../packages/shared/src/platform-dirs.js";
import {
	answerJson,
	apiPathArgument,
	CdpUsageError,
	DEFAULT_CDP_PORT,
	hubApiBody,
	hubApiUrl,
	hubRuntimePath,
	parseCdpArgs,
	parseHubRuntime,
	scriptExpression,
	typedLines,
} from "./cdp-lib.js";

const CDP = join(import.meta.dirname, "cdp.mjs");

function context(
	platform: NodeJS.Platform,
	env: Record<string, string>,
	home = "/home/u",
): PlatformDirContext {
	return { platform, env, homedir: () => home };
}

describe("parseCdpArgs", () => {
	it("drives the app's port unless --port names another", () => {
		expect(parseCdpArgs(["eval", "1"]).port).toBe(DEFAULT_CDP_PORT);
		expect(parseCdpArgs(["--port", "9444", "eval", "1"]).port).toBe(9444);
	});

	it.each([["0"], ["65536"], ["x"], [undefined]])("refuses --port %s", (value) => {
		const argv = value === undefined ? ["--port"] : ["--port", value, "eval", "1"];
		expect(() => parseCdpArgs(argv)).toThrow(CdpUsageError);
	});

	it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("reads %j as a request for help", (argv) => {
		expect(parseCdpArgs(argv).command).toEqual({ name: "help" });
	});

	it("points at the file variants when inline text arrives split", () => {
		// What cmd.exe makes of `eval "a|b"` through the Volta shim: two arguments.
		expect(() => parseCdpArgs(["eval", "a", "b"])).toThrow(/eval-file, type-file/);
	});

	it("types with a final Enter unless told --no-enter", () => {
		expect(parseCdpArgs(["type", "ls | wc -l"]).command).toEqual({
			name: "type",
			text: "ls | wc -l",
			enter: true,
		});
		expect(parseCdpArgs(["type-file", "--no-enter", "cmd.txt"]).command).toEqual({
			name: "type-file",
			file: "cmd.txt",
			enter: false,
		});
	});

	it("reads an evaluation from a file", () => {
		expect(parseCdpArgs(["eval-file", "probe.js"]).command).toEqual({
			name: "eval-file",
			file: "probe.js",
		});
	});

	it("watches for a positive number of seconds", () => {
		expect(parseCdpArgs(["watch", "2.5", "document.title"]).command).toEqual({
			name: "watch",
			seconds: 2.5,
			expression: "document.title",
		});
		expect(() => parseCdpArgs(["watch", "0", "x"])).toThrow(/seconds/);
		expect(() => parseCdpArgs(["watch", "soon", "x"])).toThrow(/seconds/);
	});

	it("takes an API method in any case, a path, and an optional body file", () => {
		expect(parseCdpArgs(["api", "get", "api/health"]).command).toEqual({
			name: "api",
			method: "GET",
			path: "/api/health",
			bodyFile: null,
		});
		expect(parseCdpArgs(["api", "PATCH", "/api/channels/01J", "title.json"]).command).toEqual({
			name: "api",
			method: "PATCH",
			path: "/api/channels/01J",
			bodyFile: "title.json",
		});
	});

	it("refuses an unknown method, a body on GET or HEAD, and a missing path", () => {
		expect(() => parseCdpArgs(["api", "TRACE", "api/health"])).toThrow(/GET, HEAD/);
		expect(() => parseCdpArgs(["api", "GET", "api/health", "body.json"])).toThrow(/no body/);
		expect(() => parseCdpArgs(["api", "HEAD", "api/health", "body.json"])).toThrow(/no body/);
		expect(() => parseCdpArgs(["api", "GET"])).toThrow(CdpUsageError);
	});

	it("refuses an unknown command", () => {
		expect(() => parseCdpArgs(["click", "#x"])).toThrow(/unknown command click/);
	});
});

describe("apiPathArgument", () => {
	it("adds the leading slash that Git Bash would have rewritten", () => {
		expect(apiPathArgument("api/health")).toBe("/api/health");
		expect(apiPathArgument("/api/logs?limit=5")).toBe("/api/logs?limit=5");
	});

	it("names Git Bash when it has already turned the path into a Windows one", () => {
		expect(() => apiPathArgument("C:/Program Files/Git/api/health")).toThrow(
			/Git Bash.*MSYS_NO_PATHCONV/,
		);
	});

	it.each([["//evil.example/api"], ["/\\evil.example/api"], ["\\\\evil.example\\api"]])(
		"refuses %s, which a URL parser reads as another host",
		(raw) => {
			expect(() => apiPathArgument(raw)).toThrow(CdpUsageError);
		},
	);
});

describe("hubApiUrl", () => {
	it("builds a URL on 127.0.0.1 at the hub's port", () => {
		expect(hubApiUrl(4100, "/api/health").href).toBe("https://127.0.0.1:4100/api/health");
		expect(hubApiUrl(443, "/api/health").href).toBe("https://127.0.0.1/api/health");
	});

	it.each([
		["//evil.example/api"],
		["/\\evil.example/api"],
		["https://evil.example/api"],
		["api/health"],
	])("refuses %s", (apiPath) => {
		expect(() => hubApiUrl(4100, apiPath)).toThrow(/does not stay on the hub/);
	});
});

describe("hubRuntimePath", () => {
	it("is runtime.json in %LOCALAPPDATA%\\lasterm on Windows", () => {
		expect(hubRuntimePath(context("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }))).toBe(
			"C:\\Users\\u\\AppData\\Local\\lasterm\\runtime.json",
		);
	});

	it("is runtime.json in ~/.local/state/lasterm elsewhere, or under XDG_STATE_HOME", () => {
		expect(hubRuntimePath(context("linux", {}))).toBe("/home/u/.local/state/lasterm/runtime.json");
		expect(hubRuntimePath(context("linux", { XDG_STATE_HOME: "/srv/state" }))).toBe(
			"/srv/state/lasterm/runtime.json",
		);
	});

	it("invents no directory when Windows does not say where the state is", () => {
		expect(() => hubRuntimePath(context("win32", {}))).toThrow(/LOCALAPPDATA/);
	});
});

describe("parseHubRuntime", () => {
	const record = { pid: 1, port: 4100, started_at: "x", ownerToken: "secret", spki: "AAAA" };

	it("keeps the port and the key to pin, and never the owner token", () => {
		expect(parseHubRuntime(JSON.stringify(record), "runtime.json")).toEqual({
			port: 4100,
			spki: "AAAA",
		});
		expect(parseHubRuntime(`\uFEFF${JSON.stringify(record)}`, "runtime.json").port).toBe(4100);
	});

	it.each([
		["not JSON", "{", /is not JSON/],
		["no port", JSON.stringify({ ...record, port: undefined }), /no usable port/],
		["a port out of range", JSON.stringify({ ...record, port: 70000 }), /no usable port/],
		["no key", JSON.stringify({ ...record, spki: undefined }), /no TLS key/],
		["null", "null", /no usable port/],
	])("refuses a record with %s", (_label, text, message) => {
		expect(() => parseHubRuntime(text, "runtime.json")).toThrow(message);
	});
});

describe("hubApiBody", () => {
	it("sends {} on POST, PUT and PATCH without a body file", () => {
		for (const method of ["POST", "PUT", "PATCH"] as const) {
			expect(hubApiBody(method, null)).toEqual({ text: "{}", contentType: "application/json" });
		}
	});

	it("sends nothing on GET, HEAD and DELETE without a body file", () => {
		for (const method of ["GET", "HEAD", "DELETE"] as const) {
			expect(hubApiBody(method, null)).toBeNull();
		}
	});

	it("sends a body file's JSON, whatever its layout or byte order mark", () => {
		expect(hubApiBody("PATCH", '\uFEFF{\r\n  "title": null\r\n}\r\n')).toEqual({
			text: '{"title":null}',
			contentType: "application/json",
		});
	});

	it("refuses a body file that is not JSON, naming it", () => {
		expect(() => hubApiBody("POST", "title=x", "title.json")).toThrow(/title\.json is not JSON/);
	});
});

describe("answerJson", () => {
	it("prints one JSON value whatever the hub answered", () => {
		expect(answerJson("")).toBe("null");
		expect(JSON.parse(answerJson('{"status":"ok"}'))).toEqual({ status: "ok" });
		expect(JSON.parse(answerJson("<html>"))).toBe("<html>");
	});
});

describe("typedLines", () => {
	it("keeps quotes and pipes as they are", () => {
		expect(typedLines(`grep "a|b" f | wc -l`)).toEqual([`grep "a|b" f | wc -l`]);
	});

	it("drops the file's final line break and its byte order mark", () => {
		expect(typedLines("\uFEFFecho one\r\necho two\r\n")).toEqual(["echo one", "echo two"]);
	});

	it("keeps a blank line the text itself holds", () => {
		expect(typedLines("echo one\n\n")).toEqual(["echo one", ""]);
		expect(typedLines("")).toEqual([""]);
	});
});

describe("scriptExpression", () => {
	it("yields the script's last value and keeps its declarations to itself", () => {
		const page = createContext({});
		const script = "const answer = 6;\n// a comment on the last line\nanswer * 7";
		// A script declaring `const answer` at the top would fail the second time.
		for (let run = 0; run < 2; run++) {
			expect(new Script(scriptExpression(script)).runInContext(page)).toBe(42);
		}
		expect(new Script("typeof answer").runInContext(page)).toBe("undefined");
	});

	it("ignores a byte order mark", () => {
		expect(new Script(scriptExpression("\uFEFF1 + 1")).runInContext(createContext({}))).toBe(2);
	});
});

describe("cdp.mjs", () => {
	it("loads under plain Node, which strips the types of what it imports", () => {
		// Only help: any other command would reach for a real page.
		const help = spawnSync(process.execPath, [CDP, "--help"], { encoding: "utf8" });
		expect(help.status).toBe(0);
		expect(help.stdout).toMatch(/^usage: /);
	});

	it("exits 2 on a command line it cannot run, before connecting", () => {
		const refused = spawnSync(process.execPath, [CDP, "api", "GET", "//evil.example/"], {
			encoding: "utf8",
		});
		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(/api takes a path on the hub/);
	});
});
