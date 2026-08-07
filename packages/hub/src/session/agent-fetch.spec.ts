import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_FETCH_IDLE_TIMEOUT_MS,
	AGENT_FETCH_MAX_BYTES,
	AGENT_FETCH_TOTAL_TIMEOUT_MS,
	AGENT_TARGET_TRIPLES,
	type AgentFetchImpl,
	FetchError,
	fetchAgentBinary,
	parseChecksumManifest,
} from "./agent-fetch.js";

const BASE_URL = "https://example.test/lasterm";
const VERSION = "0.4.1";
const LINUX_X64_TRIPLE = AGENT_TARGET_TRIPLES.linux.x64.triple;

let tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("agent target mapping", () => {
	it("contains built triples and unsupported targets in one exported table", () => {
		expect(AGENT_TARGET_TRIPLES.linux.x64).toMatchObject({
			triple: "x86_64-unknown-linux-gnu",
			built: true,
			ext: "",
		});
		expect(AGENT_TARGET_TRIPLES.linux.arm64).toMatchObject({
			triple: "aarch64-unknown-linux-gnu",
			built: true,
			ext: "",
		});
		expect(AGENT_TARGET_TRIPLES.windows.x64).toMatchObject({
			triple: "x86_64-pc-windows-msvc",
			built: true,
			ext: ".exe",
		});
		expect(AGENT_TARGET_TRIPLES.windows.arm64).toMatchObject({
			triple: null,
			built: false,
			ext: ".exe",
		});
		expect(AGENT_TARGET_TRIPLES.darwin.arm64).toMatchObject({ triple: null, built: false });
	});
});

describe("parseChecksumManifest", () => {
	const basename = `lasterm-agent-${LINUX_X64_TRIPLE}-${VERSION}`;
	const lower = "a".repeat(64);
	const upper = "ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";

	it.each([
		{
			name: "missing line",
			manifest: `${lower}  other-file\n`,
			expected: null,
		},
		{
			name: "CRLF",
			manifest: `${lower}  ${basename}\r\n`,
			expected: lower,
		},
		{
			name: "hex case",
			manifest: `${upper}  ${basename}\n`,
			expected: upper.toLowerCase(),
		},
	])("$name", ({ manifest, expected }) => {
		expect(parseChecksumManifest(manifest, basename)).toBe(expected);
	});

	it.each([
		{
			name: "duplicates",
			manifest: `${lower}  ${basename}\n${"b".repeat(64)}  ${basename}\n`,
		},
		{
			name: "path prefixes",
			manifest: `${lower}  ./${basename}\n`,
		},
	])("rejects $name", ({ manifest }) => {
		expect(() => parseChecksumManifest(manifest, basename)).toThrow(FetchError);
	});
});

describe("fetchAgentBinary", () => {
	it.each([
		"0.0.0",
		"0.4",
		"v0.4.1",
		"0.4.1-beta.1",
		"../0.4.1",
	])("rejects bad version %s before building a URL", async (version) => {
		const cacheDir = makeTempDir();
		const fetchImpl = vi.fn<AgentFetchImpl>();

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "BAD_VERSION" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects unsupported targets without network calls", async () => {
		const cacheDir = makeTempDir();
		const fetchImpl = vi.fn<AgentFetchImpl>();

		await expect(
			fetchAgentBinary({
				os: "windows",
				arch: "arm64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_TARGET" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects non-HTTPS release base URLs without network calls", async () => {
		const cacheDir = makeTempDir();
		const fetchImpl = vi.fn<AgentFetchImpl>();

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: "http://example.test/lasterm",
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "NETWORK" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("maps private or forbidden releases to an actionable manual gesture", async () => {
		const cacheDir = makeTempDir();
		const expectedUrl = versionedAssetUrl(VERSION);
		const finalPath = path.join(cacheDir, `lasterm-agent-linux-x64-${VERSION}`);
		const { fetchImpl } = routeFetch(() => response("", { status: 403 }));

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(FetchError);
			expect(error).toMatchObject({ code: "PRIVATE_OR_FORBIDDEN" });
			expect(String((error as Error).message)).toContain(expectedUrl);
			expect(String((error as Error).message)).toContain(finalPath);
			expect(String((error as Error).message)).toContain("rename");
			return true;
		});
		expect(listCache(cacheDir)).toEqual([]);
	});

	it("removes temp files after checksum mismatch", async () => {
		const cacheDir = makeTempDir();
		const assetName = versionedAssetName(VERSION);
		const finalPath = path.join(cacheDir, `lasterm-agent-linux-x64-${VERSION}`);
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("corrupt");
			if (url === checksumUrl(VERSION)) return response(sums(assetName, "expected"));
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });

		expect(existsSync(finalPath)).toBe(false);
		expect(listCache(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("falls back to the legacy unversioned asset for versions before 0.4.0", async () => {
		const cacheDir = makeTempDir();
		const version = "0.3.4";
		const body = "legacy-agent";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { fetchImpl, calls } = routeFetch((url) => {
			if (url === versionedAssetUrl(version)) return response("", { status: 404 });
			if (url === legacyAssetUrl(version)) return response(body);
			if (url === checksumUrl(version)) return response("", { status: 404 });
			throw new Error(`unexpected URL ${url}`);
		});

		const finalPath = await fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});

		expect(calls.map((call) => call.url)).toEqual([
			versionedAssetUrl(version),
			legacyAssetUrl(version),
			checksumUrl(version),
		]);
		expect(readFileSync(finalPath, "utf8")).toBe(body);
		expect(path.basename(finalPath)).toBe("lasterm-agent-linux-x64-0.3.4");
		expect(statSync(finalPath).mode & 0o777).toBe(0o755);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("predates"));
	});

	it("falls back to the versioned former basename for a release published before the rename", async () => {
		const cacheDir = makeTempDir();
		const body = "pre-rename-agent";
		const legacyName = `termora-agent-${LINUX_X64_TRIPLE}-${VERSION}`;
		const { fetchImpl, calls } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === legacyAssetUrl(VERSION)) return response(body);
			if (url === checksumUrl(VERSION)) return response(sums(legacyName, body));
			throw new Error(`unexpected URL ${url}`);
		});

		const finalPath = await fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});

		expect(calls.map((call) => call.url)).toEqual([
			versionedAssetUrl(VERSION),
			legacyAssetUrl(VERSION),
			checksumUrl(VERSION),
		]);
		expect(readFileSync(finalPath, "utf8")).toBe(body);
		expect(path.basename(finalPath)).toBe(`lasterm-agent-linux-x64-${VERSION}`);
	});

	it("still requires a checksum when it falls back for a version at or after 0.4.0", async () => {
		const cacheDir = makeTempDir();
		// The trap this guards: the naming fallback and the "a missing checksum is only
		// a warning" relaxation used to share one predicate. Widening that predicate to
		// reach these versions would have relaxed verification for every one of them.
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === legacyAssetUrl(VERSION)) return response("pre-rename-agent");
			if (url === checksumUrl(VERSION)) return response("", { status: 404 });
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "CHECKSUM_MISSING" });
		expect(listCache(cacheDir)).toEqual([]);
	});

	it("names the asset this build asks for when neither basename is present", async () => {
		const cacheDir = makeTempDir();
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === legacyAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === tagUrl(VERSION)) return response("release page");
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toSatisfy((error: unknown) => {
			// The retry is internal. Reporting its URL would send the operator looking
			// for a file no build of this project has ever asked for.
			expect(String((error as Error).message)).toContain(versionedAssetName(VERSION));
			expect(String((error as Error).message)).not.toContain("termora-agent-");
			return true;
		});
	});

	it("rejects missing checksums for modern versions", async () => {
		const cacheDir = makeTempDir();
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("agent");
			if (url === checksumUrl(VERSION)) return response("", { status: 404 });
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "CHECKSUM_MISSING" });
		expect(listCache(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("maps 404 assets to release incomplete when the tag exists", async () => {
		const cacheDir = makeTempDir();
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === legacyAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === tagUrl(VERSION)) return response("release page");
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "RELEASE_INCOMPLETE" });
	});

	it("maps absent release tags to not found", async () => {
		const cacheDir = makeTempDir();
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === legacyAssetUrl(VERSION)) return response("", { status: 404 });
			if (url === tagUrl(VERSION)) return response("", { status: 404 });
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("maps GitHub rate limits", async () => {
		const cacheDir = makeTempDir();
		const { fetchImpl } = routeFetch(() =>
			response("", {
				status: 403,
				headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
			}),
		);

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "RATE_LIMITED" });
	});

	it("caps bytes written at 64 MiB and removes the partial temp file", async () => {
		const cacheDir = makeTempDir();
		const chunk = new Uint8Array(1024 * 1024);
		const oversizedChunks = AGENT_FETCH_MAX_BYTES / chunk.byteLength + 1;
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) {
				let sent = 0;
				return response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							if (sent >= oversizedChunks) {
								controller.close();
								return;
							}
							sent += 1;
							controller.enqueue(chunk);
						},
					}),
				);
			}
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "TOO_LARGE" });
		expect(listCache(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("accepts a download of exactly 64 MiB (cap boundary)", async () => {
		const cacheDir = makeTempDir();
		const oneMiB = new Uint8Array(1024 * 1024);
		const totalChunks = AGENT_FETCH_MAX_BYTES / oneMiB.byteLength;
		// Hash 64 MiB of zeros incrementally — no single 64 MiB allocation.
		const hash = createHash("sha256");
		for (let index = 0; index < totalChunks; index += 1) hash.update(oneMiB);
		const digest = hash.digest("hex");
		const assetName = versionedAssetName(VERSION);
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) {
				let sent = 0;
				return response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							if (sent >= totalChunks) {
								controller.close();
								return;
							}
							sent += 1;
							controller.enqueue(oneMiB);
						},
					}),
				);
			}
			if (url === checksumUrl(VERSION)) return response(`${digest}  ${assetName}\n`);
			throw new Error(`unexpected URL ${url}`);
		});

		const result = await fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});
		// fetchAgentBinary returns the os-arch cache path; the triple asset name is
		// only the download/checksum-manifest key.
		expect(path.basename(result)).toBe(`lasterm-agent-linux-x64-${VERSION}`);
		expect(statSync(result).size).toBe(AGENT_FETCH_MAX_BYTES);
	});

	it("times out if the HTTP request never completes", async () => {
		vi.useFakeTimers();
		const cacheDir = makeTempDir();
		const fetchImpl: AgentFetchImpl = () => new Promise(() => undefined);

		const result = fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});
		const expectedRejection = expect(result).rejects.toMatchObject({ code: "NETWORK" });

		await vi.advanceTimersByTimeAsync(AGENT_FETCH_TOTAL_TIMEOUT_MS + 1);
		await expectedRejection;
	});

	it("times out if the response body stalls between chunks", async () => {
		vi.useFakeTimers();
		const cacheDir = makeTempDir();
		let resolveWaitingForSecondRead: (() => void) | null = null;
		const waitingForSecondRead = new Promise<void>((resolve) => {
			resolveWaitingForSecondRead = resolve;
		});
		const { fetchImpl } = routeFetch((url) => {
			if (url !== versionedAssetUrl(VERSION)) throw new Error(`unexpected URL ${url}`);
			return response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("partial"));
					},
					pull() {
						resolveWaitingForSecondRead?.();
						return new Promise(() => undefined);
					},
				}),
			);
		});

		const result = fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});
		const expectedRejection = expect(result).rejects.toMatchObject({ code: "NETWORK" });

		await waitingForSecondRead;
		await vi.advanceTimersByTimeAsync(AGENT_FETCH_IDLE_TIMEOUT_MS + 1);
		await expectedRejection;
		expect(listCache(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("handles concurrent double-fetch without corrupting the final file", async () => {
		const cacheDir = makeTempDir();
		const body = "concurrent-agent";
		const assetName = versionedAssetName(VERSION);
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response(body);
			if (url === checksumUrl(VERSION)) return response(sums(assetName, body));
			throw new Error(`unexpected URL ${url}`);
		});

		const [first, second] = await Promise.all([
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		]);

		expect(first).toBe(second);
		expect(path.basename(first)).toBe(`lasterm-agent-linux-x64-${VERSION}`);
		expect(readFileSync(first, "utf8")).toBe(body);
		// The cached binary must be executable (modern path chmod 755, not only legacy).
		expect(statSync(first).mode & 0o777).toBe(0o755);
		expect(listCache(cacheDir).filter((name) => name === path.basename(first))).toHaveLength(1);
		expect(listCache(cacheDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("SC-09 keeps placement byte-identical when onProgress observes download and verify", async () => {
		const cacheDir = makeTempDir();
		const body = "progress-agent";
		const assetName = versionedAssetName(VERSION);
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) {
				return response(body, { headers: { "content-length": String(body.length) } });
			}
			if (url === checksumUrl(VERSION)) return response(sums(assetName, body));
			throw new Error(`unexpected URL ${url}`);
		});

		const withoutProgressPath = await fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});
		const withoutProgress = readFileSync(withoutProgressPath);
		rmSync(withoutProgressPath);

		const progress: Array<{
			downloaded: number;
			total?: number;
			phase: "download" | "verify";
		}> = [];
		const withProgressPath = await fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
			onProgress: (event) => {
				progress.push(event);
			},
		});

		expect(withProgressPath).toBe(withoutProgressPath);
		expect(readFileSync(withProgressPath)).toEqual(withoutProgress);
		expect(progress.some((event) => event.phase === "download")).toBe(true);
		expect(progress.at(-1)).toMatchObject({
			downloaded: body.length,
			total: body.length,
			phase: "verify",
		});
		expect(statSync(withProgressPath).mode & 0o777).toBe(0o755);
	});

	it.skipIf(process.platform === "win32")(
		"tightens a pre-existing group/world-writable cache directory to 0700",
		async () => {
			const cacheDir = makeTempDir();
			chmodSync(cacheDir, 0o777);
			const body = "agent-binary";
			const assetName = versionedAssetName(VERSION);
			const { fetchImpl } = routeFetch((url) => {
				if (url === versionedAssetUrl(VERSION)) return response(body);
				if (url === checksumUrl(VERSION)) return response(sums(assetName, body));
				throw new Error(`unexpected URL ${url}`);
			});

			const result = await fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			});
			expect(readFileSync(result, "utf8")).toBe(body);
			expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
		},
	);

	it.skipIf(process.platform === "win32")("rejects a symlinked cache directory", async () => {
		const parent = makeTempDir();
		const realDir = path.join(parent, "real");
		mkdirSync(realDir, { mode: 0o700 });
		const linkDir = path.join(parent, "link");
		symlinkSync(realDir, linkDir);
		const { fetchImpl } = routeFetch((url) => response(`unexpected ${url}`));

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir: linkDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "DISK" });
	});

	it("rejects a redirect that downgrades to non-HTTPS", async () => {
		const cacheDir = makeTempDir();
		const insecure = new Response("agent-binary");
		// Simulate `redirect: "follow"` landing on an http:// URL.
		Object.defineProperty(insecure, "url", {
			value: "http://insecure.test/asset",
			configurable: true,
		});
		const fetchImpl: AgentFetchImpl = async () => insecure;

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "NETWORK" });
		expect(listCache(cacheDir)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"ignores a symlinked cached checksum manifest and re-fetches from origin",
		async () => {
			const cacheDir = makeTempDir();
			const body = "agent-binary";
			const assetName = versionedAssetName(VERSION);
			// Plant a symlink at the manifest cache path pointing to a hostile file
			// whose checksum line would NOT match the real body.
			const outsider = path.join(makeTempDir(), "evil-sums.txt");
			writeFileSync(outsider, `${"0".repeat(64)}  ${assetName}\n`);
			const manifestPath = path.join(cacheDir, `SHA256SUMS-${VERSION}.txt`);
			symlinkSync(outsider, manifestPath);
			const { fetchImpl } = routeFetch((url) => {
				if (url === versionedAssetUrl(VERSION)) return response(body);
				if (url === checksumUrl(VERSION)) return response(sums(assetName, body));
				throw new Error(`unexpected URL ${url}`);
			});

			const result = await fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			});
			// The planted symlink was ignored (else the bogus checksum → mismatch);
			// the manifest cache is now a real file.
			expect(readFileSync(result, "utf8")).toBe(body);
			expect(lstatSync(manifestPath).isSymbolicLink()).toBe(false);
		},
	);

	it("re-fetches a corrected release because a bad manifest is not cached until the binary verifies", async () => {
		const cacheDir = makeTempDir();
		const body = "agent-binary";
		const assetName = versionedAssetName(VERSION);
		let manifestFixed = false;
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) return response(body);
			if (url === checksumUrl(VERSION)) {
				// First attempt: manifest exists but omits this asset (release
				// incomplete). After the upstream fix: the correct line is present.
				return response(manifestFixed ? sums(assetName, body) : `${"0".repeat(64)}  other-asset\n`);
			}
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "CHECKSUM_MISSING" });
		// The incomplete manifest must NOT have been cached.
		expect(existsSync(path.join(cacheDir, `SHA256SUMS-${VERSION}.txt`))).toBe(false);

		// Upstream fixes the release; the retry re-fetches and succeeds.
		manifestFixed = true;
		const result = await fetchAgentBinary({
			os: "linux",
			arch: "x64",
			version: VERSION,
			cacheDir,
			baseUrl: BASE_URL,
			fetchImpl,
		});
		expect(readFileSync(result, "utf8")).toBe(body);
	});

	it("rejects a partial (206 / Content-Range) asset response", async () => {
		const cacheDir = makeTempDir();
		const { fetchImpl } = routeFetch((url) => {
			if (url === versionedAssetUrl(VERSION)) {
				return response("trunc", {
					status: 206,
					headers: { "content-range": "bytes 0-4/100" },
				});
			}
			throw new Error(`unexpected URL ${url}`);
		});

		await expect(
			fetchAgentBinary({
				os: "linux",
				arch: "x64",
				version: VERSION,
				cacheDir,
				baseUrl: BASE_URL,
				fetchImpl,
			}),
		).rejects.toMatchObject({ code: "NETWORK" });
		// No truncated executable was written to the cache.
		expect(listCache(cacheDir)).toEqual([]);
	});
});

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lasterm-agent-fetch-"));
	tempDirs.push(dir);
	return dir;
}

function routeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
	fetchImpl: AgentFetchImpl;
	calls: Array<{ url: string; init: RequestInit }>;
} {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImpl: AgentFetchImpl = async (url, init) => {
		calls.push({ url, init });
		return handler(url, init);
	};
	return { fetchImpl, calls };
}

function response(
	body: BodyInit | null,
	init: { readonly status?: number; readonly headers?: HeadersInit } = {},
): Response {
	return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

function versionedAssetName(version: string): string {
	return `lasterm-agent-${LINUX_X64_TRIPLE}-${version}`;
}

function versionedAssetUrl(version: string): string {
	return `${BASE_URL}/releases/download/v${version}/${versionedAssetName(version)}`;
}

function legacyAssetUrl(version: string): string {
	// Releases up to the rename were published under the project's former name; those
	// basenames are historical facts about GitHub, not something the rename may update.
	// Two shapes, because the versioned naming arrived at 0.4.0.
	const unversioned =
		version.startsWith("0.0.") ||
		version.startsWith("0.1.") ||
		version.startsWith("0.2.") ||
		version.startsWith("0.3.");
	const basename = unversioned
		? `termora-agent-${LINUX_X64_TRIPLE}`
		: `termora-agent-${LINUX_X64_TRIPLE}-${version}`;
	return `${BASE_URL}/releases/download/v${version}/${basename}`;
}

function checksumUrl(version: string): string {
	return `${BASE_URL}/releases/download/v${version}/SHA256SUMS-${version}.txt`;
}

function tagUrl(version: string): string {
	return `${BASE_URL}/releases/tags/v${version}`;
}

function sums(assetName: string, body: string): string {
	return `${sha256(body)}  ${assetName}\n`;
}

function sha256(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

function listCache(cacheDir: string): string[] {
	return readdirSync(cacheDir).sort();
}
