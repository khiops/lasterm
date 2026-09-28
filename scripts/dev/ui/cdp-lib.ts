/**
 * What scripts/dev/ui/cdp.mjs decides before it touches a page or a hub — its
 * command line, the text it reads from files, and how an `api` call becomes a
 * request — and the request itself, over the hub's own pinned transport.
 *
 * cdp.mjs runs under plain `node`, which loads this file by stripping its types.
 * So it keeps to erasable syntax, and it imports TypeScript files by their `.ts`
 * name: outside vitest and tsx, nothing maps a `.js` specifier to a `.ts` file.
 * The two repository modules it imports need nothing but Node's builtins, and
 * the spec loads cdp.mjs under plain Node so that a change there shows.
 */
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { createHubTlsAgent } from "../../../packages/hub/src/hub-transport.ts";
import { lastermDir, type PlatformDirContext } from "../../../packages/shared/src/platform-dirs.ts";

/** The port scripts/dev/desktop-ui.ps1 gives the app; 9222 belongs to another WebView2 app. */
export const DEFAULT_CDP_PORT = 9333;

export const USAGE = `usage: node scripts/dev/ui/cdp.mjs [--port N] <command>

  eval "<expression>"              print its JSON value
  eval-file <file.js>              the same for a script read from a file
  type [--no-enter] "<text>"       type into the focused terminal, then Enter
  type-file [--no-enter] <file>    the same for text read from a file, one line per Enter
  shot <file.png>                  screenshot the page
  watch <seconds> "<expression>"   print each change of its value
  api <METHOD> <path> [body.json]  call the app's hub REST API (path: api/health); JSON answer on stdout

--port is the app's CDP port (default ${DEFAULT_CDP_PORT}).`;

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type CdpCommand =
	| { readonly name: "help" }
	| { readonly name: "eval"; readonly expression: string }
	| { readonly name: "eval-file"; readonly file: string }
	| { readonly name: "type"; readonly text: string; readonly enter: boolean }
	| { readonly name: "type-file"; readonly file: string; readonly enter: boolean }
	| { readonly name: "shot"; readonly file: string }
	| { readonly name: "watch"; readonly seconds: number; readonly expression: string }
	| {
			readonly name: "api";
			readonly method: HttpMethod;
			readonly path: string;
			readonly bodyFile: string | null;
	  };

export interface CdpInvocation {
	readonly port: number;
	readonly command: CdpCommand;
}

/** A command line cdp.mjs cannot run; it prints the message and the usage, and exits 2. */
export class CdpUsageError extends Error {
	readonly code = "CDP_USAGE";

	constructor(message: string) {
		super(message);
		this.name = "CdpUsageError";
	}
}

/**
 * Said when a command that takes its text inline gets the wrong number of
 * arguments: on Windows that is usually cmd.exe, which Volta's `node` shim hands
 * the arguments to, splitting one at a `|` or `&` and cutting it at a newline.
 */
const INLINE_TEXT_HINT =
	"; text with quotes, pipes or several lines is safer in a file: eval-file, type-file";

function operands(
	command: string,
	rest: readonly string[],
	names: readonly string[],
	hint = "",
): string[] {
	if (rest.length !== names.length) {
		const wanted = names.length === 0 ? "no argument" : names.join(" ");
		throw new CdpUsageError(`${command} takes ${wanted}, got ${rest.length} argument(s)${hint}`);
	}
	return [...rest];
}

function withoutEnterFlag(rest: readonly string[]): { enter: boolean; rest: string[] } {
	return rest[0] === "--no-enter"
		? { enter: false, rest: rest.slice(1) }
		: { enter: true, rest: [...rest] };
}

/**
 * The path an `api` call asks for, with its leading `/` optional: Git Bash
 * rewrites an argument that starts with `/` into a Windows path, so `api/health`
 * is the spelling that survives every shell. A path that could leave the hub's
 * origin is refused here, and again when the URL is built.
 */
export function apiPathArgument(raw: string): string {
	if (/^[A-Za-z]:[\\/]/.test(raw)) {
		throw new CdpUsageError(
			`${raw} is a Windows path: Git Bash rewrites an argument that starts with /. Write it without the slash (api/health), or set MSYS_NO_PATHCONV=1`,
		);
	}
	const apiPath = raw.startsWith("/") ? raw : `/${raw}`;
	if (apiPath.startsWith("//") || apiPath.includes("\\")) {
		throw new CdpUsageError(`api takes a path on the hub, such as api/health, not ${raw}`);
	}
	return apiPath;
}

/** Parse cdp.mjs's arguments, everything after the script's own path. */
export function parseCdpArgs(argv: readonly string[]): CdpInvocation {
	let args = [...argv];
	let port = DEFAULT_CDP_PORT;
	if (args[0] === "--port") {
		const value = args[1];
		port = Number(value);
		if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
			throw new CdpUsageError(`--port takes a TCP port, got ${value ?? "nothing"}`);
		}
		args = args.slice(2);
	}
	const [name, ...rest] = args;
	switch (name) {
		case undefined:
		case "help":
		case "--help":
		case "-h":
			return { port, command: { name: "help" } };
		case "eval": {
			const [expression] = operands(name, rest, ["<expression>"], INLINE_TEXT_HINT);
			return { port, command: { name, expression: expression as string } };
		}
		case "eval-file": {
			const [file] = operands(name, rest, ["<file>"]);
			return { port, command: { name, file: file as string } };
		}
		case "type": {
			const flagged = withoutEnterFlag(rest);
			const [text] = operands(name, flagged.rest, ["<text>"], INLINE_TEXT_HINT);
			return { port, command: { name, text: text as string, enter: flagged.enter } };
		}
		case "type-file": {
			const flagged = withoutEnterFlag(rest);
			const [file] = operands(name, flagged.rest, ["<file>"]);
			return { port, command: { name, file: file as string, enter: flagged.enter } };
		}
		case "shot": {
			const [file] = operands(name, rest, ["<file.png>"]);
			return { port, command: { name, file: file as string } };
		}
		case "watch": {
			const [seconds, expression] = operands(
				name,
				rest,
				["<seconds>", "<expression>"],
				INLINE_TEXT_HINT,
			);
			const duration = Number(seconds);
			if (!Number.isFinite(duration) || duration <= 0) {
				throw new CdpUsageError(`watch takes a number of seconds, got ${seconds}`);
			}
			return { port, command: { name, seconds: duration, expression: expression as string } };
		}
		case "api": {
			if (rest.length !== 2 && rest.length !== 3) {
				throw new CdpUsageError(
					`api takes <METHOD> <path> [body.json], got ${rest.length} argument(s)`,
				);
			}
			const [rawMethod, apiPath, bodyFile] = rest as [string, string, string | undefined];
			const method = HTTP_METHODS.find((known) => known === rawMethod.toUpperCase());
			if (method === undefined) {
				throw new CdpUsageError(`api takes one of ${HTTP_METHODS.join(", ")}, not ${rawMethod}`);
			}
			if (bodyFile !== undefined && (method === "GET" || method === "HEAD")) {
				throw new CdpUsageError(`${method} sends no body, so it takes no body file`);
			}
			return {
				port,
				command: { name, method, path: apiPathArgument(apiPath), bodyFile: bodyFile ?? null },
			};
		}
		default:
			throw new CdpUsageError(`unknown command ${name}`);
	}
}

/** A file's text without the byte order mark an editor or PowerShell may write first. */
export function withoutBom(content: string): string {
	return content.startsWith("﻿") ? content.slice(1) : content;
}

/**
 * The expression that runs a script read from a file and yields its last
 * value, as the console would. The block keeps its `let` and `const` out of the
 * page's global scope, so the same file can run twice. The text reaches the
 * page inside the CDP message itself: no shell, and so no escaping or base64.
 * For `await`, end the script with an async function called in place; the
 * promise it returns is awaited.
 */
export function scriptExpression(source: string): string {
	return `{\n${withoutBom(source)}\n}`;
}

/**
 * The lines `type` sends, each followed by Enter but the last, whose Enter the
 * command decides. A final line break is the file's ending, not an empty line.
 */
export function typedLines(text: string): string[] {
	return withoutBom(text)
		.replace(/\r?\n$/, "")
		.split(/\r?\n/);
}

/** Where the hub publishes its port: `runtime.json` in lasterm's state directory. */
export function hubRuntimePath(context?: PlatformDirContext): string {
	const platform = context?.platform ?? process.platform;
	const paths = platform === "win32" ? path.win32 : path.posix;
	return paths.join(lastermDir("state", context), "runtime.json");
}

/**
 * What `runtime.json` says about reaching the hub: its port, and the key its TLS
 * certificate must carry. The owner token the record also holds is not kept:
 * the API takes the page's client token, and refuses the owner's.
 */
export interface HubEndpoint {
	readonly port: number;
	readonly spki: string;
}

export function parseHubRuntime(text: string, file: string): HubEndpoint {
	let record: unknown;
	try {
		record = JSON.parse(withoutBom(text));
	} catch {
		throw new Error(`${file} is not JSON`);
	}
	const { port, spki } = (record ?? {}) as { port?: unknown; spki?: unknown };
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${file} names no usable port`);
	}
	if (typeof spki !== "string" || spki === "") {
		throw new Error(`${file} names no TLS key (spki) to pin`);
	}
	return { port, spki };
}

/**
 * The URL of `apiPath` on the hub. Anything that would leave 127.0.0.1 and the
 * hub's port is refused: the request carries the client token.
 */
export function hubApiUrl(port: number, apiPath: string): URL {
	const origin = new URL(`https://127.0.0.1:${port}`).origin;
	const url = new URL(apiPath, origin);
	if (!apiPath.startsWith("/") || url.origin !== origin) {
		throw new Error(`${apiPath} does not stay on the hub at ${origin}`);
	}
	return url;
}

export interface HubApiBody {
	readonly text: string;
	readonly contentType: "application/json";
}

/**
 * The body a call sends, JSON only: a multipart upload is out of its reach. A
 * body file must hold JSON. Without one, POST, PUT and PATCH send `{}`: a route
 * that reads an object refuses a missing body, and one that reads nothing
 * ignores it. GET, HEAD and DELETE send none, since Fastify refuses an empty
 * body labelled as JSON.
 */
export function hubApiBody(
	method: HttpMethod,
	fileText: string | null,
	file = "the body file",
): HubApiBody | null {
	if (fileText === null) {
		return method === "POST" || method === "PUT" || method === "PATCH"
			? { text: "{}", contentType: "application/json" }
			: null;
	}
	let value: unknown;
	try {
		value = JSON.parse(withoutBom(fileText));
	} catch (error) {
		throw new Error(`${file} is not JSON: ${(error as Error).message}`);
	}
	return { text: JSON.stringify(value), contentType: "application/json" };
}

/** stdout for an answer, always one JSON value: the body, its raw text as a string, or null. */
export function answerJson(body: string): string {
	if (body === "") return "null";
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return JSON.stringify(body);
	}
}

/** The page's client token, the one the web client sends as a bearer. */
export const PAGE_TOKEN_EXPRESSION = 'localStorage.getItem("lasterm_token")';

export interface HubAnswer {
	readonly status: number;
	readonly body: string;
}

/**
 * Call the hub the way its own CLI does (`requestHub` in packages/hub/src/cli.ts):
 * to 127.0.0.1 only, through the agent that hands over the socket only once the
 * peer has proved the key `runtime.json` records, so the token never reaches
 * another server. No certificate check is switched off anywhere else.
 */
export function callHubApi(
	endpoint: HubEndpoint,
	method: HttpMethod,
	apiPath: string,
	token: string,
	body: HubApiBody | null,
	timeoutMs = 30_000,
): Promise<HubAnswer> {
	const url = hubApiUrl(endpoint.port, apiPath);
	const agent = createHubTlsAgent(endpoint);
	return new Promise<HubAnswer>((resolve, reject) => {
		const request = httpsRequest(
			url,
			{
				method,
				agent,
				signal: AbortSignal.timeout(timeoutMs),
				headers: {
					Authorization: `Bearer ${token}`,
					// The client closes the connection, never the hub: a hub that closes
					// first can lose the end of its answer to a loopback filter (see
					// requestHub). The agent keeps no socket, so it closes once the
					// answer is in.
					Connection: "keep-alive",
					...(body === null
						? {}
						: {
								"Content-Type": body.contentType,
								"Content-Length": Buffer.byteLength(body.text),
							}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("error", reject);
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		request.on("error", reject);
		request.end(body?.text);
	}).finally(() => agent.destroy());
}
