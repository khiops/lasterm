import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as https from "node:https";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type ProxyOptions } from "vite";
import { createHubTlsConnector, type HubTlsRuntime } from "../../hub/src/hub-transport.js";

function resolveBuildHash(): string {
	const env = process.env.LASTERM_BUILD_HASH;
	if (env && env.length > 0) return env.slice(0, 7);
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "dev";
	}
}

const BUILD_HASH = resolveBuildHash();

function hubStateDir(): string {
	return platform() === "win32"
		? join(process.env.LOCALAPPDATA ?? "", "lasterm")
		: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "lasterm");
}

function readHubRuntime(): HubTlsRuntime {
	const runtime = JSON.parse(readFileSync(join(hubStateDir(), "runtime.json"), "utf8")) as {
		port?: unknown;
		spki?: unknown;
	};
	if (
		typeof runtime.port !== "number" ||
		!Number.isInteger(runtime.port) ||
		runtime.port < 1 ||
		runtime.port > 65535 ||
		typeof runtime.spki !== "string" ||
		runtime.spki.length === 0
	) {
		throw new Error("Hub runtime record has no usable TLS endpoint");
	}
	return { port: runtime.port, spki: runtime.spki };
}

// Vite evaluates config before its concurrently started hub chooses an
// OS-assigned port. Resolve runtime.json when each proxy connection is made.
const hubProxyAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
hubProxyAgent.createConnection = (options, callback) => {
	const runtime = readHubRuntime();
	if (Number(options.port) !== runtime.port) {
		throw new Error("Hub runtime changed before the Vite proxy connected");
	}
	const connector = createHubTlsConnector(runtime);
	// @types/node requires a socket on every callback path, though Node invokes
	// TLS connector errors before a socket exists. hub-transport keeps that
	// absence explicit; this is only the Node Agent boundary.
	return connector(options, callback as Parameters<typeof connector>[1]);
};

function hubProxyTarget(): string {
	return `https://127.0.0.1:${readHubRuntime().port}`;
}

function hubProxyOptions(websocket = false): ProxyOptions {
	// Vite delegates these options to http-proxy, whose runtime accepts router
	// and Agent even though Vite's exported ProxyOptions omits them.
	return {
		target: "https://127.0.0.1:1",
		router: hubProxyTarget,
		agent: hubProxyAgent,
		secure: true,
		...(websocket ? { ws: true } : {}),
	} as unknown as ProxyOptions;
}

export default defineConfig({
	plugins: [vue()],
	define: {
		// Inject build hash as a compile-time constant accessible via import.meta.env.VITE_BUILD_HASH
		"import.meta.env.VITE_BUILD_HASH": JSON.stringify(BUILD_HASH),
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/ws": hubProxyOptions(true),
			"/api": hubProxyOptions(),
			"/public": hubProxyOptions(),
		},
	},
});
