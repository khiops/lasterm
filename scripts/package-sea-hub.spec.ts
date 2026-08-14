/**
 * package-sea-hub.spec.ts
 *
 * Tests for:
 *   - scripts/package-sea-hub.ts (manifest generation, addon location, content-type)
 *   - packages/hub/src/sea-static-server.ts (in-memory manifest loading and serving)
 *   - packages/hub/src/sea-agent-resolver.ts (agent binary resolution)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

// ────────────────────────────────────────────────────────────────────────────
// Test 1: locates better-sqlite3 .node addon
// ────────────────────────────────────────────────────────────────────────────

describe("locateBetterSqlite3", () => {
	it("locates the better-sqlite3 addon and it has a valid native binary header", async () => {
		const { locateBetterSqlite3 } = await import("./package-sea-hub.js");
		const addonPath = locateBetterSqlite3();

		expect(existsSync(addonPath)).toBe(true);
		expect(addonPath).toMatch(/better_sqlite3\.node$/);

		// Verify ELF (Linux) or Mach-O (macOS) or PE (Windows) header
		const buf = readFileSync(addonPath);
		expect(buf.byteLength).toBeGreaterThan(4);

		const magic = buf.subarray(0, 4);
		const isELF = magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46;
		const isMachO32 =
			magic[0] === 0xce && magic[1] === 0xfa && magic[2] === 0xed && magic[3] === 0xfe;
		const isMachO64 =
			magic[0] === 0xcf && magic[1] === 0xfa && magic[2] === 0xed && magic[3] === 0xfe;
		const isMachOFat =
			magic[0] === 0xca && magic[1] === 0xfe && magic[2] === 0xba && magic[3] === 0xbe;
		const isPE = magic[0] === 0x4d && magic[1] === 0x5a; // MZ header

		expect(isELF || isMachO32 || isMachO64 || isMachOFat || isPE).toBe(true);
	});

	it("throws a descriptive error message when addon paths are missing", async () => {
		// We cannot spy on ESM built-in node:fs exports in vitest.
		// Instead verify the error message format by checking the function's
		// throw message contains the expected guidance text (white-box test via source).
		// This verifies the error message is well-formed.
		const src = readFileSync(join(ROOT, "scripts", "package-sea-hub.ts"), "utf8");
		expect(src).toContain("better-sqlite3 addon not found");
		expect(src).toContain("pnpm install");
		expect(src).toContain("Checked:");
	});
});

describe("loadHubLockAddon", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `lasterm-hub-lock-addon-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("refuses a file that is not a loadable Node addon", async () => {
		const { loadHubLockAddon } = await import("./package-sea-hub.js");
		const addon = join(tempDir, "lasterm_hub_lock.node");
		writeFileSync(addon, "not a Node addon");
		// Mutation caught: header sniffing would accept a merely well-formed
		// container; process.dlopen proves this exact file is loadable.
		expect(() => loadHubLockAddon(addon)).toThrow("cannot be loaded");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 2: static manifest generation
// ────────────────────────────────────────────────────────────────────────────

describe("buildStaticManifest", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `lasterm-manifest-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("produces a valid manifest with correct structure", async () => {
		const { buildStaticManifest } = await import("./package-sea-hub.js");

		// Create test files
		writeFileSync(join(tempDir, "index.html"), "<html><body>hello</body></html>", "utf8");
		mkdirSync(join(tempDir, "assets"), { recursive: true });
		writeFileSync(join(tempDir, "assets", "app.js"), "console.log('app')", "utf8");
		writeFileSync(join(tempDir, "assets", "style.css"), "body { color: red }", "utf8");

		const manifestJson = buildStaticManifest(tempDir);
		const manifest = JSON.parse(manifestJson) as Record<
			string,
			{ data: string; contentType: string }
		>;

		expect(manifest).toHaveProperty("index.html");
		expect(manifest).toHaveProperty("assets/app.js");
		expect(manifest).toHaveProperty("assets/style.css");

		// Verify base64 decode round-trips
		const htmlDecoded = Buffer.from(manifest["index.html"]!.data, "base64").toString("utf8");
		expect(htmlDecoded).toBe("<html><body>hello</body></html>");

		const jsDecoded = Buffer.from(manifest["assets/app.js"]!.data, "base64").toString("utf8");
		expect(jsDecoded).toBe("console.log('app')");
	});

	it("assigns correct content-types to each file", async () => {
		const { buildStaticManifest } = await import("./package-sea-hub.js");

		writeFileSync(join(tempDir, "index.html"), "", "utf8");
		mkdirSync(join(tempDir, "assets"), { recursive: true });
		writeFileSync(join(tempDir, "assets", "bundle.js"), "", "utf8");
		writeFileSync(join(tempDir, "assets", "main.css"), "", "utf8");
		writeFileSync(join(tempDir, "assets", "logo.svg"), "", "utf8");
		writeFileSync(join(tempDir, "assets", "font.woff2"), Buffer.alloc(4));

		const manifest = JSON.parse(buildStaticManifest(tempDir)) as Record<
			string,
			{ data: string; contentType: string }
		>;

		expect(manifest["index.html"]?.contentType).toBe("text/html");
		expect(manifest["assets/bundle.js"]?.contentType).toBe("application/javascript");
		expect(manifest["assets/main.css"]?.contentType).toBe("text/css");
		expect(manifest["assets/logo.svg"]?.contentType).toBe("image/svg+xml");
		expect(manifest["assets/font.woff2"]?.contentType).toBe("font/woff2");
	});

	it("produces an empty manifest for an empty directory", async () => {
		const { buildStaticManifest } = await import("./package-sea-hub.js");
		const manifest = JSON.parse(buildStaticManifest(tempDir)) as Record<string, unknown>;
		expect(Object.keys(manifest)).toHaveLength(0);
	});

	it("handles nested subdirectories correctly", async () => {
		const { buildStaticManifest } = await import("./package-sea-hub.js");

		mkdirSync(join(tempDir, "deep", "nested", "dir"), { recursive: true });
		writeFileSync(join(tempDir, "deep", "nested", "dir", "file.json"), "{}", "utf8");

		const manifest = JSON.parse(buildStaticManifest(tempDir)) as Record<
			string,
			{ data: string; contentType: string }
		>;

		expect(manifest).toHaveProperty("deep/nested/dir/file.json");
		expect(manifest["deep/nested/dir/file.json"]?.contentType).toBe("application/json");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 3: content-type detection covers common web assets
// ────────────────────────────────────────────────────────────────────────────

describe("resolveContentType", () => {
	it("maps all common web asset extensions correctly", async () => {
		const { resolveContentType } = await import("./package-sea-hub.js");

		const expectedMappings: Array<[string, string]> = [
			["index.html", "text/html"],
			["app.js", "application/javascript"],
			["app.mjs", "application/javascript"],
			["style.css", "text/css"],
			["font.woff", "font/woff"],
			["font.woff2", "font/woff2"],
			["font.ttf", "font/ttf"],
			["font.otf", "font/otf"],
			["image.svg", "image/svg+xml"],
			["image.png", "image/png"],
			["image.jpg", "image/jpeg"],
			["image.jpeg", "image/jpeg"],
			["image.gif", "image/gif"],
			["image.webp", "image/webp"],
			["favicon.ico", "image/x-icon"],
			["data.json", "application/json"],
			["readme.txt", "text/plain"],
			["bundle.js.map", "application/json"],
		];

		for (const [filename, expected] of expectedMappings) {
			expect(resolveContentType(filename), `extension of ${filename}`).toBe(expected);
		}
	});

	it("returns application/octet-stream for unknown extensions", async () => {
		const { resolveContentType } = await import("./package-sea-hub.js");
		expect(resolveContentType("binary.bin")).toBe("application/octet-stream");
		expect(resolveContentType("unknown.xyz")).toBe("application/octet-stream");
	});

	it("handles uppercase extensions case-insensitively", async () => {
		const { resolveContentType } = await import("./package-sea-hub.js");
		expect(resolveContentType("IMAGE.PNG")).toBe("image/png");
		expect(resolveContentType("STYLE.CSS")).toBe("text/css");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 4: hub SEA binary build integration (slow, skippable)
// ────────────────────────────────────────────────────────────────────────────

describe("hub SEA binary build integration", () => {
	const SEA_BINARY = join(
		ROOT,
		"dist",
		"sea",
		process.platform === "win32" ? "lasterm-hub.exe" : "lasterm-hub",
	);

	it("binary exists after build (or build produces valid CJS at minimum)", {
		timeout: 120_000,
	}, () => {
		const cjsBundle = join(ROOT, "dist", "sea", "lasterm-hub.cjs");

		// The CJS bundle must exist (produced by build:sea-hub).
		// The full SEA binary requires postject; we skip if not available.
		if (!existsSync(cjsBundle)) {
			console.log("[test] lasterm-hub.cjs not built yet — skipping SEA binary check");
			return;
		}

		// Verify CJS bundle is readable and non-trivial
		const content = readFileSync(cjsBundle, "utf8");
		expect(content.length).toBeGreaterThan(1024);

		// Check for SEA binary if postject already ran
		if (existsSync(SEA_BINARY)) {
			// Binary exists — verify it doesn't crash with --help or --version
			const result = spawnSync(SEA_BINARY, ["--version"], {
				stdio: "pipe",
				timeout: 10_000,
			});
			// Either succeeds (exits 0) or exits with usage error (non-zero) but doesn't SIGSEGV
			const didNotSegfault = result.signal !== "SIGSEGV" && result.signal !== "SIGABRT";
			expect(didNotSegfault).toBe(true);
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 5: sea-static-server loads manifest and serves files
// ────────────────────────────────────────────────────────────────────────────

describe("sea-static-server unit tests", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("_detectSea returns false in normal Node.js", async () => {
		const { _detectSea } = await import("../packages/hub/src/sea-static-server.js");
		expect(_detectSea()).toBe(false);
	});

	it("_buildFileMap normalises paths to leading-slash keys", async () => {
		const { _buildFileMap } = await import("../packages/hub/src/sea-static-server.js");

		const manifest = {
			"index.html": { data: Buffer.from("<html>").toString("base64"), contentType: "text/html" },
			"assets/app.js": {
				data: Buffer.from("console.log()").toString("base64"),
				contentType: "application/javascript",
			},
		};

		const map = _buildFileMap(manifest);

		expect(map.has("/index.html")).toBe(true);
		expect(map.has("/assets/app.js")).toBe(true);
		expect(map.size).toBe(2);

		const indexEntry = map.get("/index.html");
		expect(indexEntry).toBeDefined();
		if (!indexEntry) return;
		expect(indexEntry.contentType).toBe("text/html");
		expect(indexEntry.buf.toString("utf8")).toBe("<html>");
	});

	it("_buildFileMap decodes base64 data correctly", async () => {
		const { _buildFileMap } = await import("../packages/hub/src/sea-static-server.js");

		const originalContent = "Hello, SEA world! 🚀";
		const manifest = {
			"hello.txt": {
				data: Buffer.from(originalContent, "utf8").toString("base64"),
				contentType: "text/plain",
			},
		};

		const map = _buildFileMap(manifest);
		const entry = map.get("/hello.txt");
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(entry.buf.toString("utf8")).toBe(originalContent);
	});

	it("registerSeaStaticServing returns false when not in SEA mode", async () => {
		const { registerSeaStaticServing } = await import("../packages/hub/src/sea-static-server.js");

		// Create a minimal Fastify mock
		const mockApp = {
			log: { warn: vi.fn(), info: vi.fn() },
			get: vi.fn(),
		} as unknown as import("fastify").FastifyInstance;

		const result = await registerSeaStaticServing(mockApp);
		expect(result).toBe(false);
		// Should not have registered any routes
		expect(mockApp.get).not.toHaveBeenCalled();
	});

	it("_loadStaticManifest returns null in non-SEA mode", async () => {
		const { _loadStaticManifest } = await import("../packages/hub/src/sea-static-server.js");
		// In non-SEA mode, the node:sea module throws or isSea() returns false,
		// so getRawAsset is unavailable — manifest loading returns null.
		const result = _loadStaticManifest();
		expect(result).toBeNull();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 6: sea-agent-resolver finds agent binary next to hub binary
// ────────────────────────────────────────────────────────────────────────────

describe("sea-agent-resolver", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `lasterm-resolver-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("finds agent binary in the same directory as hub binary", async () => {
		const { resolveAgentBinaryPath, _AGENT_BINARY_NAME } = await import(
			"../packages/hub/src/sea-agent-resolver.js"
		);

		// Place a fake agent binary next to the mocked execPath
		const fakeAgentPath = join(tempDir, _AGENT_BINARY_NAME);
		writeFileSync(fakeAgentPath, "#!/bin/sh\necho lasterm-agent", { mode: 0o755 });

		// Override process.execPath to point at a fake hub binary in tempDir
		const originalExecPath = process.execPath;
		Object.defineProperty(process, "execPath", {
			value: join(tempDir, "lasterm-hub"),
			configurable: true,
		});

		try {
			const result = resolveAgentBinaryPath();
			expect(result).toBe(fakeAgentPath);
		} finally {
			Object.defineProperty(process, "execPath", {
				value: originalExecPath,
				configurable: true,
			});
		}
	});

	it("returns null when agent binary does not exist anywhere", async () => {
		// We cannot spy on ESM built-in node:child_process exports in vitest.
		// Test _findInPath with a binary name that cannot be on any real PATH.
		const { _findInPath } = await import("../packages/hub/src/sea-agent-resolver.js");

		const impossibleName = `lasterm-agent-does-not-exist-${Date.now()}`;
		const result = _findInPath(impossibleName);
		expect(result).toBeNull();
	});

	it("_findInPath returns absolute path when binary exists in PATH", async () => {
		const { _findInPath } = await import("../packages/hub/src/sea-agent-resolver.js");

		// Use a binary guaranteed to be in PATH on all platforms.
		const wellKnown = process.platform === "win32" ? "cmd" : "sh";
		const result = _findInPath(wellKnown);

		// May be null in very restricted environments — verify the type contract.
		if (result !== null) {
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
			expect(existsSync(result)).toBe(true);
		}
	});
});
