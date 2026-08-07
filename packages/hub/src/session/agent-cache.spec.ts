import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_TARGET_TRIPLES,
	FetchError,
	pruneAgentBinaryCache,
	validateAgentVersion,
	verifyAndPlace,
} from "./agent-cache.js";

const VERSION = "0.4.1";
const LINUX_ARM64_TRIPLE = AGENT_TARGET_TRIPLES.linux.arm64.triple;

let tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("validateAgentVersion", () => {
	it.each(["0.4.0", "1.2.3", "10.20.30"])("accepts strict semver %s", (version) => {
		expect(() => validateAgentVersion(version)).not.toThrow();
	});

	it.each([
		"0.0.0",
		"0.4",
		"v0.4.1",
		"0.4.1-beta.1",
		"../0.4.1",
	])("rejects bad version %s", (version) => {
		expectFetchError(() => validateAgentVersion(version), "BAD_VERSION");
	});
});

describe("verifyAndPlace", () => {
	it("places a matching binary with mode 755 via rename", () => {
		const cacheDir = makeTempDir();
		const body = "agent-binary";
		const tempPath = path.join(cacheDir, "upload.tmp");
		const expectedBasename = `lasterm-agent-${LINUX_ARM64_TRIPLE}-${VERSION}`;
		const finalPath = path.join(cacheDir, `lasterm-agent-linux-arm64-${VERSION}`);
		writeFileSync(tempPath, body);

		const result = verifyAndPlace(
			tempPath,
			expectedBasename,
			sums(expectedBasename, body),
			cacheDir,
		);

		expect(result).toBe(finalPath);
		expect(existsSync(tempPath)).toBe(false);
		expect(readFileSync(finalPath, "utf8")).toBe(body);
		expect(statSync(finalPath).mode & 0o777).toBe(0o755);
	});

	it("rejects a mismatched binary without placing it", () => {
		const cacheDir = makeTempDir();
		const tempPath = path.join(cacheDir, "upload.tmp");
		const expectedBasename = `lasterm-agent-${LINUX_ARM64_TRIPLE}-${VERSION}`;
		const finalPath = path.join(cacheDir, `lasterm-agent-linux-arm64-${VERSION}`);
		writeFileSync(tempPath, "corrupt");

		expectFetchError(
			() =>
				verifyAndPlace(tempPath, expectedBasename, sums(expectedBasename, "expected"), cacheDir),
			"CHECKSUM_MISMATCH",
		);

		expect(existsSync(finalPath)).toBe(false);
		expect(readdirSync(cacheDir)).not.toContain(path.basename(finalPath));
	});

	it("rejects a missing manifest entry", () => {
		const cacheDir = makeTempDir();
		const tempPath = path.join(cacheDir, "upload.tmp");
		const expectedBasename = `lasterm-agent-${LINUX_ARM64_TRIPLE}-${VERSION}`;
		const finalPath = path.join(cacheDir, `lasterm-agent-linux-arm64-${VERSION}`);
		writeFileSync(tempPath, "agent-binary");

		expectFetchError(
			() =>
				verifyAndPlace(tempPath, expectedBasename, sums("other-file", "agent-binary"), cacheDir),
			"CHECKSUM_MISSING",
		);

		expect(existsSync(finalPath)).toBe(false);
	});
});

describe("pruneAgentBinaryCache", () => {
	it("keeps the requested version and removes other agent cache binaries", () => {
		const cacheDir = makeTempDir();
		const current = path.join(cacheDir, `lasterm-agent-linux-arm64-${VERSION}`);
		const staleLinux = path.join(cacheDir, "lasterm-agent-linux-arm64-0.3.4");
		const staleWindows = path.join(cacheDir, "lasterm-agent-windows-x64-0.3.4.exe");
		const unrelated = path.join(cacheDir, "SHA256SUMS-0.3.4.txt");
		writeFileSync(current, "current");
		writeFileSync(staleLinux, "stale");
		writeFileSync(staleWindows, "stale");
		writeFileSync(unrelated, "checksum");

		expect(pruneAgentBinaryCache(cacheDir, VERSION)).toBe(2);

		expect(existsSync(current)).toBe(true);
		expect(existsSync(staleLinux)).toBe(false);
		expect(existsSync(staleWindows)).toBe(false);
		expect(existsSync(unrelated)).toBe(true);
	});
});

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lasterm-agent-cache-"));
	tempDirs.push(dir);
	return dir;
}

function sums(fileName: string, body: string): string {
	return `${createHash("sha256").update(body).digest("hex")}  ${fileName}\n`;
}

function expectFetchError(fn: () => void, code: string): void {
	try {
		fn();
		throw new Error(`Expected FetchError ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(FetchError);
		expect(error).toMatchObject({ code });
	}
}
