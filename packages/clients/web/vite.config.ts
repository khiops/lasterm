import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as https from "node:https";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { type HubTlsRuntime, hubTlsOptions } from "../../hub/src/hub-transport.js";

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
const hubProxyAgent = new https.Agent({ keepAlive: false });
hubProxyAgent.createConnection = (options) => {
	const runtime = readHubRuntime();
	if (Number(options.port) !== runtime.port) {
		throw new Error("Hub runtime changed before the Vite proxy connected");
	}
	return tls.connect({ ...options, ...hubTlsOptions(runtime, hubStateDir()) });
};

function hubProxyTarget(): string {
	return `https://127.0.0.1:${readHubRuntime().port}`;
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
			"/ws": {
				target: "https://127.0.0.1:1",
				router: hubProxyTarget,
				agent: hubProxyAgent,
				secure: true,
				ws: true,
			},
			"/api": {
				target: "https://127.0.0.1:1",
				router: hubProxyTarget,
				agent: hubProxyAgent,
				secure: true,
			},
			"/public": {
				target: "https://127.0.0.1:1",
				router: hubProxyTarget,
				agent: hubProxyAgent,
				secure: true,
			},
		},
	},
});
