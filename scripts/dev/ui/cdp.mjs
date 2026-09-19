// Drive the desktop app's page over the Chrome DevTools Protocol, for UI tests.
// Start the app with scripts/dev/desktop-ui.ps1 first.
//
//   node scripts/dev/ui/cdp.mjs [--port 9333] eval  "<expression>"   print its JSON value
//   node scripts/dev/ui/cdp.mjs [--port 9333] type  "<text>"         type into the focused terminal, then Enter
//   node scripts/dev/ui/cdp.mjs [--port 9333] shot  <file.png>       screenshot the page
//   node scripts/dev/ui/cdp.mjs [--port 9333] watch <seconds> "<expression>"  print each change of its value
//
// Only a page served from tauri.localhost is driven, never another WebView2 app
// that happens to expose a debugging port.

const args = process.argv.slice(2);
let port = 9333;
if (args[0] === "--port") {
	port = Number(args[1]);
	args.splice(0, 2);
}
const [command, ...rest] = args;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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

switch (command) {
	case "eval":
		console.log(JSON.stringify(await evaluate(rest[0]), null, 2));
		break;
	case "type": {
		// Focus emulation: the window need not hold the OS focus for input to land.
		await send("Emulation.setFocusEmulationEnabled", { enabled: true });
		await evaluate("document.querySelector('.xterm-helper-textarea')?.focus(); true");
		await send("Input.insertText", { text: rest[0] });
		for (const type of ["keyDown", "keyUp"]) {
			await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		}
		break;
	}
	case "shot": {
		const { writeFileSync } = await import("node:fs");
		const reply = await send("Page.captureScreenshot", { format: "png" });
		writeFileSync(rest[0], Buffer.from(reply.result.data, "base64"));
		console.log(rest[0]);
		break;
	}
	case "watch": {
		const until = Date.now() + Number(rest[0]) * 1000;
		const started = Date.now();
		let last;
		while (Date.now() < until) {
			const value = JSON.stringify(await evaluate(rest[1]));
			if (value !== last) {
				console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${value}`);
				last = value;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		break;
	}
	default:
		console.error("usage: cdp.mjs [--port N] eval|type|shot|watch ...");
		process.exitCode = 2;
}
socket.close();
