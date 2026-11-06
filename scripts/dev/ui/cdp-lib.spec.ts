/**
 * cdp-lib.spec.ts
 *
 * The parts of scripts/dev/ui/cdp.mjs that decide something without a page or
 * a hub: its command line, the text it reads from files, where it finds the
 * hub, and what it sends there. Nothing here reaches a page or a hub.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformDirContext } from "../../../packages/shared/src/platform-dirs.js";
import {
	answerJson,
	apiPathArgument,
	type CdpReply,
	CdpUsageError,
	DEFAULT_CDP_PORT,
	DEFAULT_HOLD_SECONDS,
	DRAG_OPERATION_COPY,
	DRAG_PROBE_INSTALL,
	DRAG_PROBE_READ,
	DRAG_PROBE_REMOVE,
	dispatchFileDrag,
	dragAnswer,
	type FileDrag,
	hubApiBody,
	hubApiUrl,
	hubRuntimePath,
	OUTSIDE_PAGE,
	parseCdpArgs,
	parseHubRuntime,
	resolveDropPaths,
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

	it("drops one or more paths at a point in CSS pixels", () => {
		expect(parseCdpArgs(["drop", "10.5", "0", "a.txt", "C:\\data\\folder"]).command).toEqual({
			name: "drop",
			x: 10.5,
			y: 0,
			paths: ["a.txt", "C:\\data\\folder"],
		});
	});

	it.each([
		[["drop", "10", "20"], /<x> <y> <path>/],
		[["drop", "-1", "20", "a"], /point's x/],
		[["drop", "10", "down", "a"], /point's y/],
		[["drop", "", "20", "a"], /point's x/],
	])("refuses drop %j", (argv, message) => {
		expect(() => parseCdpArgs(argv)).toThrow(message);
	});

	it("holds a dragover for a second unless told --hold, and takes an optional script", () => {
		expect(parseCdpArgs(["dragover", "1", "2", "a"]).command).toEqual({
			name: "dragover",
			x: 1,
			y: 2,
			paths: ["a"],
			holdSeconds: DEFAULT_HOLD_SECONDS,
			evalFile: null,
		});
		expect(
			parseCdpArgs(["dragover", "--eval-file", "o.js", "--hold", "2.5", "1", "2", "a", "b"])
				.command,
		).toEqual({
			name: "dragover",
			x: 1,
			y: 2,
			paths: ["a", "b"],
			holdSeconds: 2.5,
			evalFile: "o.js",
		});
	});

	it.each([
		[["dragover", "--hold", "-1", "1", "2", "a"], /--hold takes a number of seconds/],
		[["dragover", "--hold", "soon", "1", "2", "a"], /--hold takes a number of seconds/],
		[["dragover", "--hold"], /--hold takes a value/],
		[["dragover", "--eval-file"], /--eval-file takes a value/],
		[["dragover", "1", "2"], /<x> <y> <path>/],
	])("refuses dragover %j", (argv, message) => {
		expect(() => parseCdpArgs(argv)).toThrow(message);
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

describe("resolveDropPaths", () => {
	const base = resolve("/work");
	const kinds: Record<string, "file" | "directory"> = {
		[resolve(base, "a.txt")]: "file",
		[resolve(base, "folder")]: "directory",
	};

	it("gives each path absolute, file or folder", () => {
		expect(resolveDropPaths(["a.txt", "folder"], (p) => kinds[p] ?? null, base)).toEqual([
			resolve(base, "a.txt"),
			resolve(base, "folder"),
		]);
	});

	it("refuses a path that names nothing, saying which", () => {
		expect(() => resolveDropPaths(["a.txt", "gone"], (p) => kinds[p] ?? null, base)).toThrow(
			`no file or folder at ${resolve(base, "gone")}`,
		);
	});
});

describe("dragAnswer", () => {
	it.each([
		[{ type: "dragover", prevented: true, dropEffect: "copy" }, "taken"],
		[{ type: "dragenter", prevented: true, dropEffect: "copy" }, "taken"],
		[{ type: "dragover", prevented: false, dropEffect: "copy" }, "refused"],
		[{ type: "dragover", prevented: true, dropEffect: "none" }, "refused"],
		[{ type: "dragover", prevented: true, dropEffect: "move" }, "refused"],
		[null, "unseen"],
		[undefined, "unseen"],
	])("reads %j as %s", (probed, answer) => {
		expect(dragAnswer(probed)).toBe(answer);
	});
});

describe("the drag probe", () => {
	/** A page with a window that is only an event target, and a drag event as Chromium makes one. */
	function page(): { window: EventTarget; run: (expression: string) => unknown } {
		const window = new EventTarget();
		const context = createContext({ window });
		return { window, run: (expression) => new Script(expression).runInContext(context) };
	}
	function dragEvent(type: string, dropEffect: string): Event {
		const event = new Event(type, { cancelable: true });
		Object.defineProperty(event, "dataTransfer", { value: { dropEffect } });
		return event;
	}

	it("reads the page's answer to the last dragenter or dragover once the event is over", () => {
		const { window, run } = page();
		expect(run(DRAG_PROBE_INSTALL)).toBe(true);
		expect(run(DRAG_PROBE_READ)).toBeNull();
		window.addEventListener("dragover", (event) => event.preventDefault());
		window.dispatchEvent(dragEvent("dragenter", "copy"));
		window.dispatchEvent(dragEvent("dragover", "copy"));
		expect(run(DRAG_PROBE_READ)).toEqual({ type: "dragover", prevented: true, dropEffect: "copy" });
	});

	it("leaves nothing behind once removed, and replaces a probe left by a killed run", () => {
		const { window, run } = page();
		run(DRAG_PROBE_INSTALL);
		run(DRAG_PROBE_INSTALL);
		window.dispatchEvent(dragEvent("dragover", "copy"));
		expect(run(DRAG_PROBE_READ)).toEqual({
			type: "dragover",
			prevented: false,
			dropEffect: "copy",
		});
		expect(run(DRAG_PROBE_REMOVE)).toBe(true);
		expect(run("Object.keys(window).length")).toBe(0);
		expect(run(DRAG_PROBE_READ)).toBeNull();
		expect(run(DRAG_PROBE_REMOVE)).toBe(true);
	});
});

/** What a fake CDP connection was sent, one line per call, for the sequence to read at a glance. */
type Call = { method: string; params: Record<string, unknown> };
function lineOf({ method, params }: Call): string {
	if (method === "Input.dispatchDragEvent") return `${params.type} ${params.x},${params.y}`;
	if (method !== "Runtime.evaluate") return method;
	const expression = params.expression;
	if (expression === DRAG_PROBE_INSTALL) return "probe install";
	if (expression === DRAG_PROBE_READ) return "probe read";
	if (expression === DRAG_PROBE_REMOVE) return "probe remove";
	return `evaluate ${String(expression)}`;
}

/** The page's side of a drag: what it answers to each call, by default a page that takes it. */
function fakePage(
	probed: unknown = { type: "dragover", prevented: true, dropEffect: "copy" },
	fail: (call: Call) => CdpReply | Promise<CdpReply> | undefined = () => undefined,
) {
	const calls: Call[] = [];
	const send = async (method: string, params: Record<string, unknown> = {}): Promise<CdpReply> => {
		const call = { method, params };
		calls.push(call);
		const failed = fail(call);
		if (failed !== undefined) return failed;
		if (params.expression === DRAG_PROBE_READ) return { result: { result: { value: probed } } };
		if (method === "Runtime.evaluate") return { result: { result: { value: true } } };
		return { result: {} };
	};
	return { calls, send, lines: () => calls.map(lineOf) };
}

describe("dispatchFileDrag", () => {
	const paths = ["C:\\data\\a.txt", "C:\\data\\folder"];
	const at = { x: 120, y: 80.5, paths };
	const noSleep: FileDrag["sleep"] = async () => undefined;

	it("drops what the page takes, every event carrying the same files, as a copy", async () => {
		const page = fakePage();
		expect(await dispatchFileDrag(page.send, at)).toEqual({ answer: "taken", dropped: true });
		expect(page.lines()).toEqual([
			"probe install",
			"dragEnter 120,80.5",
			"dragOver 120,80.5",
			"probe read",
			"drop 120,80.5",
			"probe remove",
		]);
		for (const call of page.calls.filter((c) => c.method === "Input.dispatchDragEvent")) {
			expect(call.params.data).toEqual({
				items: [],
				files: paths,
				dragOperationsMask: DRAG_OPERATION_COPY,
			});
		}
	});

	it("takes the drag out of the page instead of dropping what it refuses", async () => {
		const page = fakePage({ type: "dragover", prevented: false, dropEffect: "copy" });
		expect(await dispatchFileDrag(page.send, at)).toEqual({ answer: "refused", dropped: false });
		expect(page.lines()).toEqual([
			"probe install",
			"dragEnter 120,80.5",
			"dragOver 120,80.5",
			"probe read",
			`dragOver ${OUTSIDE_PAGE.x},${OUTSIDE_PAGE.y}`,
			`dragCancel ${OUTSIDE_PAGE.x},${OUTSIDE_PAGE.y}`,
			"probe remove",
		]);
	});

	it("still drops when the page's answer was not seen", async () => {
		const page = fakePage(null);
		expect(await dispatchFileDrag(page.send, at)).toEqual({ answer: "unseen", dropped: true });
		expect(page.lines()).toContain("drop 120,80.5");
	});

	it("holds the drag over the point, repeating its dragover, looks, then leaves the page", async () => {
		const page = fakePage();
		const slept: number[] = [];
		const answers: string[] = [];
		const outcome = await dispatchFileDrag(page.send, {
			...at,
			sleep: async (ms) => {
				slept.push(ms);
			},
			hold: {
				ms: 600,
				onHolding: (answer) => answers.push(answer),
				inspect: async () => {
					page.calls.push({ method: "inspect", params: {} });
				},
			},
		});
		expect(outcome).toEqual({ answer: "taken", dropped: false });
		expect(answers).toEqual(["taken"]);
		expect(slept).toEqual([250, 250, 100]);
		expect(page.lines()).toEqual([
			"probe install",
			"dragEnter 120,80.5",
			"dragOver 120,80.5",
			"probe read",
			"dragOver 120,80.5",
			"dragOver 120,80.5",
			"dragOver 120,80.5",
			"inspect",
			"dragOver -1,-1",
			"dragCancel -1,-1",
			"probe remove",
		]);
	});

	it("ends a hold early when interrupted, without looking, and still leaves the page", async () => {
		const page = fakePage();
		const interrupt = new AbortController();
		let inspected = false;
		await dispatchFileDrag(page.send, {
			...at,
			signal: interrupt.signal,
			sleep: async () => interrupt.abort(),
			hold: {
				ms: 10_000,
				inspect: async () => {
					inspected = true;
				},
			},
		});
		expect(inspected).toBe(false);
		expect(page.lines().slice(-4)).toEqual([
			"probe read",
			"dragOver -1,-1",
			"dragCancel -1,-1",
			"probe remove",
		]);
	});

	it("leaves the page when an event fails once inside, and says which", async () => {
		const page = fakePage(undefined, (call) =>
			call.params.type === "drop" ? { error: { message: "drop refused by the test" } } : undefined,
		);
		await expect(dispatchFileDrag(page.send, at)).rejects.toThrow(
			"Input.dispatchDragEvent drop: drop refused by the test",
		);
		expect(page.lines().slice(-3)).toEqual(["dragOver -1,-1", "dragCancel -1,-1", "probe remove"]);
	});

	it("sends nothing more when the drag could not even enter", async () => {
		const page = fakePage(undefined, (call) =>
			call.params.type === "dragEnter"
				? { error: { message: "'Input.dispatchDragEvent' wasn't found" } }
				: undefined,
		);
		await expect(dispatchFileDrag(page.send, at)).rejects.toThrow(/wasn't found/);
		expect(page.lines()).toEqual(["probe install", "dragEnter 120,80.5", "probe remove"]);
	});

	it("gives up an event that is never answered, and leaves the page", async () => {
		const page = fakePage(undefined, (call) =>
			call.params.type === "drop" ? new Promise<CdpReply>(() => undefined) : undefined,
		);
		await expect(
			dispatchFileDrag(page.send, { ...at, sleep: noSleep, timeoutMs: 20 }),
		).rejects.toThrow("Input.dispatchDragEvent drop: no answer in 20 ms");
		expect(page.lines().slice(-3)).toEqual(["dragOver -1,-1", "dragCancel -1,-1", "probe remove"]);
	});
});

// ─── A fake DevTools endpoint, for cdp.mjs itself ────────────────────────────

/** One WebSocket frame from a buffer, unmasked; null until the buffer holds all of it. */
function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
	if (buffer.length < 2) return null;
	const opcode = (buffer[0] as number) & 0x0f;
	const masked = ((buffer[1] as number) & 0x80) !== 0;
	let length = (buffer[1] as number) & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		length = Number(buffer.readBigUInt64BE(2));
		offset = 10;
	}
	const mask = offset;
	if (masked) offset += 4;
	if (buffer.length < offset + length) return null;
	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (masked) {
		for (let i = 0; i < payload.length; i++) {
			payload[i] = (payload[i] as number) ^ (buffer[mask + (i % 4)] as number);
		}
	}
	return { opcode, payload, size: offset + length };
}

function frame(opcode: number, payload: Buffer): Buffer {
	if (payload.length < 126)
		return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
	const header = Buffer.from([0x80 | opcode, 126, 0, 0]);
	header.writeUInt16BE(payload.length, 2);
	return Buffer.concat([header, payload]);
}

interface FakeDevTools {
	readonly port: number;
	/** Each call, with the page it was sent to. */
	readonly calls: (Call & { page: string })[];
	close(): Promise<void>;
}

/**
 * A DevTools endpoint listing two pages, another app's and the Lasterm one, that answers every
 * call as a page taking the drag would. Enough WebSocket for Node's client: text frames, close.
 */
async function fakeDevTools(): Promise<FakeDevTools> {
	const calls: (Call & { page: string })[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((request, response) => {
		if (request.url !== "/json") {
			response.statusCode = 404;
			response.end();
			return;
		}
		const { port } = server.address() as { port: number };
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify([
				{
					type: "page",
					url: "https://example.com/",
					webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/other`,
				},
				{
					type: "page",
					url: "http://tauri.localhost/",
					webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/lasterm`,
				},
			]),
		);
	});
	server.on("upgrade", (request, socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		const accept = createHash("sha1")
			.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			for (let next = readFrame(buffered); next !== null; next = readFrame(buffered)) {
				buffered = buffered.subarray(next.size);
				if (next.opcode === 8) {
					socket.end(frame(8, Buffer.alloc(0)));
					return;
				}
				if (next.opcode !== 1) continue;
				const message = JSON.parse(next.payload.toString("utf8"));
				calls.push({ method: message.method, params: message.params, page: request.url ?? "" });
				const value =
					message.params?.expression === DRAG_PROBE_READ
						? { type: "dragover", prevented: true, dropEffect: "copy" }
						: true;
				const result = message.method === "Runtime.evaluate" ? { result: { value } } : {};
				socket.write(frame(1, Buffer.from(JSON.stringify({ id: message.id, result }))));
			}
		});
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	return {
		port: (server.address() as { port: number }).port,
		calls,
		close: () =>
			new Promise<void>((closed) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => closed());
			}),
	};
}

/** Run cdp.mjs without blocking this process, which serves the fake endpoint it talks to. */
function runCdp(
	args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((done, failed) => {
		const child = spawn(process.execPath, [CDP, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", failed);
		child.on("close", (status) => done({ status, stdout, stderr }));
	});
}

describe("cdp.mjs", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("drops files and folders on the Lasterm page by absolute path, and says it did", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cdp-drop-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		writeFileSync(join(dir, "a.txt"), "a");
		mkdirSync(join(dir, "folder"));
		const devtools = await fakeDevTools();
		cleanups.push(() => devtools.close());

		const run = await runCdp([
			"--port",
			String(devtools.port),
			"drop",
			"12",
			"34.5",
			join(dir, "a.txt"),
			join(dir, "folder"),
		]);

		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		expect(run.stdout).toMatch(/^dropped 2 path\(s\) at \(12, 34\.5\): the page took the drag\n$/);
		expect(new Set(devtools.calls.map((call) => call.page))).toEqual(
			new Set(["/devtools/page/lasterm"]),
		);
		expect(devtools.calls.map(lineOf)).toEqual([
			"probe install",
			"dragEnter 12,34.5",
			"dragOver 12,34.5",
			"probe read",
			"drop 12,34.5",
			"probe remove",
		]);
		expect(devtools.calls[1]?.params.data).toEqual({
			items: [],
			files: [join(dir, "a.txt"), join(dir, "folder")],
			dragOperationsMask: DRAG_OPERATION_COPY,
		});
	});

	it("refuses a drop of a path that names nothing, before connecting", () => {
		const refused = spawnSync(
			process.execPath,
			[CDP, "--port", "1", "drop", "1", "2", join(tmpdir(), "cdp-drop-nothing-here")],
			{ encoding: "utf8" },
		);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toMatch(/no file or folder at .*cdp-drop-nothing-here/);
	});

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
