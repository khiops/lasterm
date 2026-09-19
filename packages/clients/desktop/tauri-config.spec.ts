import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DESKTOP_DIR = fileURLToPath(new URL(".", import.meta.url));
const SRC_TAURI = resolve(DESKTOP_DIR, "src-tauri");

function readJson(relPath: string): unknown {
	const abs = resolve(DESKTOP_DIR, relPath);
	return JSON.parse(readFileSync(abs, "utf-8"));
}

function readText(relPath: string): string {
	const abs = resolve(DESKTOP_DIR, relPath);
	return readFileSync(abs, "utf-8");
}

describe("tauri.conf.json", () => {
	const conf = readJson("src-tauri/tauri.conf.json") as Record<string, unknown>;

	it("is valid JSON with required top-level fields", () => {
		expect(conf).toHaveProperty("productName", "Lasterm");
		expect(conf).toHaveProperty("identifier", "app.lasterm.desktop");
		expect(conf).toHaveProperty("version");
		expect(conf.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("leaves drag and drop to the web page", () => {
		// Tauri's native drop handler consumes the OS drag events, so the page
		// never sees the HTML5 drag-and-drop it uses for uploads and to move
		// hosts and panes (#67). Nothing here uses the native drop API.
		const app = conf.app as { windows: Array<Record<string, unknown>> };
		const main = app.windows.find((w) => w.label === "main");
		expect(main?.dragDropEnabled).toBe(false);
	});

	it("externalBin includes lasterm-hub", () => {
		const bundle = conf.bundle as Record<string, unknown>;
		expect(bundle).toBeDefined();
		const externalBin = bundle.externalBin as string[];
		expect(Array.isArray(externalBin)).toBe(true);
		expect(externalBin).toContain("lasterm-hub");
	});

	it("frontendDist points to web dist", () => {
		const build = conf.build as Record<string, unknown>;
		expect(build).toBeDefined();
		// Path relative to src-tauri/ pointing to web client build output
		expect(build.frontendDist).toBe("../../web/dist");
	});

	it("resolved frontendDist path points toward web package", () => {
		const build = conf.build as Record<string, unknown>;
		const frontendDist = build.frontendDist as string;
		// Resolve relative to src-tauri/
		const resolved = resolve(SRC_TAURI, frontendDist);
		// Should resolve to packages/clients/web/dist
		expect(resolved).toMatch(/packages[/\\]clients[/\\]web[/\\]dist$/);
	});

	// Enabling this requires the signing key at build time, which would break
	// every unsigned build path. A signed-release workflow must opt into it.
	it("bundle.createUpdaterArtifacts is disabled", () => {
		const bundle = conf.bundle as Record<string, unknown>;
		expect(bundle.createUpdaterArtifacts).toBe(false);
	});

	it("devUrl is configured for vite dev server", () => {
		const build = conf.build as Record<string, unknown>;
		expect(build.devUrl).toBe("http://localhost:5173");
	});

	it("does not point at a desktop-local TypeScript frontend", () => {
		const build = conf.build as Record<string, unknown>;
		expect(build.devUrl).toBe("http://localhost:5173");
		expect(build.frontendDist).toBe("../../web/dist");
		expect(existsSync(resolve(DESKTOP_DIR, "src"))).toBe(false);
	});

	it("creates the main window as transparent and enables macOS private API at app level", () => {
		const app = conf.app as Record<string, unknown>;
		const windows = app.windows as Array<Record<string, unknown>>;
		expect(windows[0]?.transparent).toBe(true);
		expect(windows[0]?.create).toBe(false);
		expect(app.macOSPrivateApi).toBe(true);
	});

	it("limits packaged webview resources to the app, local blobs, and Tauri IPC", () => {
		const app = conf.app as Record<string, unknown>;
		const security = app.security as Record<string, unknown>;
		const csp = security.csp as Record<string, string[]>;

		// Every fetch directive falls back to denial unless named below.
		expect(csp["default-src"]).toEqual(["'none'"]);
		// The bundled JavaScript is served from the packaged application origin.
		expect(csp["script-src"]).toEqual(["'self'"]);
		// index.html and injectFontFaces() both require inline styles.
		expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
		// Tauri IPC is the webview's sole connection transport.
		expect(csp["connect-src"]).toEqual(["ipc:", "http://ipc.localhost"]);
		// Browser-compatible data icons and relay-created blob wallpapers both load.
		expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
		// Browser-compatible direct fonts and relay-created blob @font-face sources both load.
		expect(csp["font-src"]).toEqual(["'self'", "data:", "blob:"]);
		// Custom bell sounds are loaded from relay-created blob URLs.
		expect(csp["media-src"]).toEqual(["blob:"]);
		// The frontend creates no worker, so it must not inherit a permissive fallback.
		expect(csp["worker-src"]).toEqual(["'none'"]);
		// These directives do not inherit from default-src and must fail closed themselves.
		expect(csp["base-uri"]).toEqual(["'none'"]);
		expect(csp["form-action"]).toEqual(["'none'"]);
		expect(csp["frame-ancestors"]).toEqual(["'none'"]);

		// Tauri adds a nonce to style-src when it serves the assets, and a nonce
		// makes the browser ignore 'unsafe-inline': the <style> elements xterm's
		// DOM renderer and injectFontFaces() create at run time were refused, so
		// the terminal lost its font and fell back to the page's proportional one.
		expect(security.dangerousDisableAssetCspModification).toEqual(["style-src"]);

		expect(Object.keys(csp).sort()).toEqual(
			[
				"default-src",
				"script-src",
				"style-src",
				"connect-src",
				"img-src",
				"font-src",
				"media-src",
				"worker-src",
				"base-uri",
				"form-action",
				"frame-ancestors",
			].sort(),
		);
	});

	it("updater plugin is configured with endpoint", () => {
		const plugins = conf.plugins as Record<string, unknown>;
		expect(plugins).toBeDefined();
		const updater = plugins.updater as Record<string, unknown>;
		expect(updater).toBeDefined();
		const endpoints = updater.endpoints as string[];
		expect(Array.isArray(endpoints)).toBe(true);
		expect(endpoints.length).toBeGreaterThan(0);
		expect(endpoints[0]).toContain("github.com");
		// Pinned deliberately: this key must stay in step with the
		// TAURI_SIGNING_PRIVATE_KEY CI secret. Signatures produced with a
		// different key are rejected by installed clients, so rotating it is a
		// conscious act that updates this expectation too.
		expect(updater.pubkey).toBe(
			"dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIwRTI3QUYwRDI1MjgxNUUKUldSZWdWTFM4SHJpc0ZjcVR5UXdGSDUwK3RpZmRiZlRFZzJRUTd4SFNTekkwVnpLQ2hEYWJTdkQK",
		);
	});
});

describe("capabilities/default.json", () => {
	const caps = readJson("src-tauri/capabilities/default.json") as Record<string, unknown>;

	// The Rust side launches the sidecars through the plugin's own API, which no
	// capability gates. An execute or spawn grant here would only let page script
	// run them, with any arguments: nothing in the web client does, so none is
	// granted. Opening a link is the one shell permission the page needs: the
	// plugin intercepts every target="_blank" click to open it itself, and
	// without the grant such links did nothing.
	it("grants the webview no shell permission but opening https links", () => {
		const permissions = caps.permissions as unknown[];
		expect(Array.isArray(permissions)).toBe(true);
		const identifiers = permissions.map((p) =>
			typeof p === "string" ? p : String((p as Record<string, unknown>).identifier),
		);
		expect(identifiers.filter((id) => id.startsWith("shell:"))).toEqual(["shell:allow-open"]);
	});

	// The plugin anchors the configured pattern itself, as `^pattern$`: a pattern
	// written with its own `^` then accepts only the bare prefix, and every link
	// fails the scope check without a word.
	it("opens every external link of the web client, and only https", () => {
		const conf = readJson("src-tauri/tauri.conf.json") as Record<string, unknown>;
		const open = (conf.plugins as Record<string, Record<string, unknown>>).shell?.open;
		expect(typeof open).toBe("string");
		const scope = new RegExp(`^${open}$`);

		const webSrc = resolve(DESKTOP_DIR, "../web/src");
		const links = readdirSync(webSrc, { recursive: true, encoding: "utf-8" })
			.filter((file) => file.endsWith(".vue"))
			.flatMap((file) => [
				...readFileSync(resolve(webSrc, file), "utf-8").matchAll(/\shref="([a-z]+:[^"]*)"/g),
			])
			.map((match) => match[1]);
		expect(links.length, "the About links at least").toBeGreaterThan(0);
		for (const link of links) expect(link, "a link the page offers").toMatch(scope);

		for (const refused of [
			"https://",
			"http://example.com",
			"file:///C:/",
			"javascript:alert(1)",
		]) {
			expect(refused).not.toMatch(scope);
		}
	});

	it("grants the set-effects window capability and narrow OS info reads", () => {
		const permissions = caps.permissions as unknown[];
		expect(permissions).toContain("core:window:allow-set-effects");
		expect(permissions).toContain("os:allow-platform");
		expect(permissions).toContain("os:allow-version");
		expect(permissions).not.toContain("os:default");
	});

	it("targets the main window", () => {
		const windows = caps.windows as string[];
		expect(Array.isArray(windows)).toBe(true);
		expect(windows).toContain("main");
	});

	it("has an identifier", () => {
		expect(caps.identifier).toBe("default");
	});
});

describe("Cargo.toml", () => {
	const cargo = readText("src-tauri/Cargo.toml");

	it("contains tauri dependency", () => {
		expect(cargo).toMatch(/^tauri\s*=/m);
	});

	it("contains tauri-plugin-shell dependency", () => {
		expect(cargo).toMatch(/^tauri-plugin-shell\s*=/m);
	});

	it("contains tauri-plugin-updater dependency", () => {
		expect(cargo).toMatch(/^tauri-plugin-updater\s*=/m);
	});

	it("contains tauri-plugin-os dependency", () => {
		expect(cargo).toMatch(/^tauri-plugin-os\s*=/m);
	});

	it("tray-icon feature is enabled", () => {
		expect(cargo).toMatch(/tray-icon/);
	});

	it("macos-private-api feature is enabled", () => {
		expect(cargo).toMatch(/macos-private-api/);
	});

	it("has correct package name", () => {
		expect(cargo).toMatch(/name\s*=\s*"lasterm-desktop"/);
	});
});

describe("package.json", () => {
	const pkg = readJson("package.json") as Record<string, unknown>;

	it("has correct name", () => {
		expect(pkg.name).toBe("@lasterm/desktop");
	});

	it("depends on @tauri-apps/api", () => {
		const deps = pkg.dependencies as Record<string, string>;
		expect(deps).toHaveProperty("@tauri-apps/api");
	});

	it("depends on @tauri-apps/plugin-shell", () => {
		const deps = pkg.dependencies as Record<string, string>;
		expect(deps).toHaveProperty("@tauri-apps/plugin-shell");
	});

	it("depends on @tauri-apps/plugin-updater", () => {
		const deps = pkg.dependencies as Record<string, string>;
		expect(deps).toHaveProperty("@tauri-apps/plugin-updater");
	});

	it("has tauri CLI as devDependency", () => {
		const devDeps = pkg.devDependencies as Record<string, string>;
		expect(devDeps).toHaveProperty("@tauri-apps/cli");
	});
});
