import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as https from "node:https";
import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { build, defineConfig, type Plugin, type ProxyOptions } from "vite";
import { createHubTlsConnector, type HubTlsRuntime } from "../../hub/src/hub-transport.js";
import { lastermDir } from "../../shared/src/platform-dirs.js";

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

/** The release this build belongs to: release-please bumps this package's version. */
const APP_VERSION = (
	JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
		version: string;
	}
).version;

function hubStateDir(): string {
	return lastermDir("state");
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
// OS-assigned port. http-proxy reads target.port for each proxied request, and
// the connector reads it again immediately before opening the TLS socket.
const hubProxyAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
hubProxyAgent.createConnection = (options, callback) => {
	const runtime = readHubRuntime();
	const connector = createHubTlsConnector(runtime);
	return connector({ ...options, port: runtime.port }, callback);
};

const hubProxyTarget = {
	protocol: "https:",
	host: "127.0.0.1",
	get port(): number {
		return readHubRuntime().port;
	},
};

function hubProxyOptions(websocket = false): ProxyOptions {
	return {
		target: hubProxyTarget,
		agent: hubProxyAgent,
		secure: true,
		...(websocket ? { ws: true } : {}),
	};
}

/**
 * The PWA's service worker (#561), built after the app into `dist/sw.js`.
 *
 * A small hand-written worker, built by Vite itself, rather than a plugin such as
 * vite-plugin-pwa: what the worker must do is narrow (network-first navigations,
 * cache-first hashed assets, nothing else), and a precaching plugin's default is
 * the opposite of it, serving a cached `index.html`. It would also bring Workbox
 * and its build tooling in as dependencies for a hundred lines.
 *
 * It is a build of its own, not an input of the app's: a classic script with no
 * imports, since an entry of the app's build could share a chunk with the app and
 * would then need `import`, which a classic worker cannot do. Its build is baked
 * in, so every build's worker differs from the last, and the browser takes each
 * new one for an update.
 */
function serviceWorker(): Plugin {
	let root = "";
	let outDir = "dist";
	return {
		name: "lasterm-service-worker",
		apply: "build",
		configResolved(config) {
			root = config.root;
			outDir = config.build.outDir;
		},
		async closeBundle() {
			await build({
				configFile: false,
				root,
				logLevel: "warn",
				publicDir: false,
				define: { __LASTERM_BUILD__: JSON.stringify(BUILD_HASH) },
				build: {
					outDir,
					emptyOutDir: false,
					copyPublicDir: false,
					lib: {
						entry: "src/pwa/sw.ts",
						formats: ["iife"],
						name: "lastermServiceWorker",
						fileName: () => "sw.js",
					},
				},
			});
		},
	};
}

export default defineConfig({
	plugins: [vue(), serviceWorker()],
	define: {
		// Inject build hash as a compile-time constant accessible via import.meta.env.VITE_BUILD_HASH
		"import.meta.env.VITE_BUILD_HASH": JSON.stringify(BUILD_HASH),
		"import.meta.env.VITE_APP_VERSION": JSON.stringify(APP_VERSION),
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
