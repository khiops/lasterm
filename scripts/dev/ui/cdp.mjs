// Drive the desktop app's page over the Chrome DevTools Protocol, for UI tests.
// Start the app with scripts/dev/desktop-ui.ps1 first.
//
//   node scripts/dev/ui/cdp.mjs [--port 9333] eval  "<expression>"   print its JSON value
//   node scripts/dev/ui/cdp.mjs [--port 9333] eval-file <file.js>    the same for a script in a file
//   node scripts/dev/ui/cdp.mjs [--port 9333] type [--no-enter] "<text>"      type into the focused terminal, then Enter
//   node scripts/dev/ui/cdp.mjs [--port 9333] type-file [--no-enter] <file>   the same for text in a file
//   node scripts/dev/ui/cdp.mjs [--port 9333] shot  <file.png>       screenshot the page
//   node scripts/dev/ui/cdp.mjs [--port 9333] watch <seconds> "<expression>"  print each change of its value
//   node scripts/dev/ui/cdp.mjs [--port 9333] api <METHOD> <path> [body.json]  call the hub's REST API
//
// Only a page served from tauri.localhost is driven, never another WebView2 app
// that happens to expose a debugging port.
//
// Text with quotes, pipes or several lines belongs in a file (eval-file,
// type-file). On Windows, Volta's `node` shim hands its arguments to cmd.exe,
// which cuts an argument at its first newline, drops `^`, expands `%NAME%`, and
// splits the command at a `|` or `&` it does not see as quoted: in an argument
// without a space, or after an embedded `"` (`type 'grep "a|b" f | wc -l'`
// fails that way). The file variants never put the text on a command line. So
// does running the real node, which `node -p process.execPath` names.
//
// `type` ends with Enter unless given --no-enter. Each line break of the text
// is an Enter too, and a file's final line break is its ending, not a line.
//
// `api` calls the hub of the running app, found by the port in runtime.json in
// the state directory as the hub resolves it (%LOCALAPPDATA%\lasterm on Windows,
// $XDG_STATE_HOME/lasterm or ~/.local/state/lasterm elsewhere), as the page's
// client: with the token the page keeps in localStorage. It connects to
// 127.0.0.1 only and pins the TLS key runtime.json records, as the hub CLI does.
// The answer goes to stdout as JSON, the status to stderr; a status outside 2xx
// exits 1. Without a body file, POST, PUT and PATCH send `{}`. The path may drop
// its leading slash (`api GET api/health`), which Git Bash would rewrite into a
// Windows path. Read before you write: this is the user's real profile.
import { readFileSync, writeFileSync } from "node:fs";
import {
	answerJson,
	CdpUsageError,
	callHubApi,
	hubApiBody,
	hubRuntimePath,
	PAGE_TOKEN_EXPRESSION,
	parseCdpArgs,
	parseHubRuntime,
	scriptExpression,
	typedLines,
	USAGE,
} from "./cdp-lib.ts";

let invocation;
try {
	invocation = parseCdpArgs(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof CdpUsageError)) throw error;
	console.error(error.message);
	console.error(USAGE);
	process.exit(2);
}
const { port, command } = invocation;
if (command.name === "help") {
	console.log(USAGE);
	process.exit(0);
}

// Everything an `api` call needs from files is read before the page is touched,
// so a missing hub or a bad body fails without connecting.
let api;
if (command.name === "api") {
	const runtimeFile = hubRuntimePath();
	try {
		const bodyText = command.bodyFile === null ? null : readFileSync(command.bodyFile, "utf8");
		api = { body: hubApiBody(command.method, bodyText, command.bodyFile ?? undefined) };
		api.endpoint = parseHubRuntime(readFileSync(runtimeFile, "utf8"), runtimeFile);
	} catch (error) {
		const hint = error.code === "ENOENT" && error.path === runtimeFile ? "; is the app running?" : "";
		console.error(`${error.message}${hint}`);
		process.exit(2);
	}
}

let targets;
try {
	targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
} catch {
	console.error(`nothing answers CDP on port ${port}; start the app with scripts/dev/desktop-ui.ps1`);
	process.exit(2);
}
const page = targets.find((t) => t.type === "page" && new URL(t.url).hostname === "tauri.localhost");
if (!page) {
	console.error(`no Lasterm page on port ${port}; start it with scripts/dev/desktop-ui.ps1`);
	process.exit(2);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	pending.get(message.id)?.(message);
	pending.delete(message.id);
});
function send(method, params = {}) {
	const id = ++nextId;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate(expression) {
	const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? "evaluation failed");
	return reply.result?.result?.value;
}
async function pressEnter() {
	for (const type of ["keyDown", "keyUp"]) {
		await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	}
}
async function typeText(text, enter) {
	// Focus emulation: the window need not hold the OS focus for input to land.
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
	await evaluate("document.querySelector('.xterm-helper-textarea')?.focus(); true");
	const lines = typedLines(text);
	for (const [index, line] of lines.entries()) {
		if (line !== "") await send("Input.insertText", { text: line });
		if (index < lines.length - 1 || enter) await pressEnter();
	}
}

try {
	switch (command.name) {
		case "eval":
			console.log(JSON.stringify(await evaluate(command.expression), null, 2));
			break;
		case "eval-file":
			console.log(JSON.stringify(await evaluate(scriptExpression(readFileSync(command.file, "utf8"))), null, 2));
			break;
		case "type":
			await typeText(command.text, command.enter);
			break;
		case "type-file":
			await typeText(readFileSync(command.file, "utf8"), command.enter);
			break;
		case "shot": {
			const reply = await send("Page.captureScreenshot", { format: "png" });
			writeFileSync(command.file, Buffer.from(reply.result.data, "base64"));
			console.log(command.file);
			break;
		}
		case "watch": {
			const until = Date.now() + command.seconds * 1000;
			const started = Date.now();
			let last;
			while (Date.now() < until) {
				const value = JSON.stringify(await evaluate(command.expression));
				if (value !== last) {
					console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${value}`);
					last = value;
				}
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			break;
		}
		case "api": {
			const token = await evaluate(PAGE_TOKEN_EXPRESSION);
			if (typeof token !== "string" || token === "") {
				console.error("the page holds no client token (lasterm_token); is it paired with its hub?");
				process.exitCode = 2;
				break;
			}
			const answer = await callHubApi(api.endpoint, command.method, command.path, token, api.body);
			console.error(`HTTP ${answer.status}`);
			console.log(answerJson(answer.body));
			if (answer.status < 200 || answer.status > 299) process.exitCode = 1;
			break;
		}
	}
} finally {
	socket.close();
}
