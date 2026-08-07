/**
 * open-browser.spec.ts
 *
 * Tests for buildOpenArgs (platform-specific browser open command builder)
 * and openBrowser (fire-and-forget execFile wrapper).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so we never spawn a real process
vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { buildOpenArgs, openBrowser } from "./open-browser.js";

describe("buildOpenArgs", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		// Restore platform after each test
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	});

	function setPlatform(platform: NodeJS.Platform): void {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
	}

	it("uses `open` on macOS", () => {
		setPlatform("darwin");
		const { bin, args } = buildOpenArgs("http://127.0.0.1:4100");
		expect(bin).toBe("open");
		expect(args).toEqual(["http://127.0.0.1:4100"]);
	});

	it("uses `xdg-open` on Linux", () => {
		setPlatform("linux");
		const { bin, args } = buildOpenArgs("http://127.0.0.1:4100");
		expect(bin).toBe("xdg-open");
		expect(args).toEqual(["http://127.0.0.1:4100"]);
	});

	it("uses cmd.exe on Windows", () => {
		setPlatform("win32");
		const { bin, args } = buildOpenArgs("http://127.0.0.1:4100");
		expect(bin).toBe("cmd.exe");
		expect(args).toContain("http://127.0.0.1:4100");
		expect(args[0]).toBe("/c");
	});

	it("throws for non-http URL schemes", () => {
		expect(() => buildOpenArgs("ftp://evil.com")).toThrow(/unsafe URL scheme/);
		expect(() => buildOpenArgs("javascript:alert(1)")).toThrow(/unsafe URL scheme/);
		expect(() => buildOpenArgs("file:///etc/passwd")).toThrow(/unsafe URL scheme/);
	});

	it("accepts https URLs", () => {
		setPlatform("linux");
		expect(() => buildOpenArgs("https://lasterm.io")).not.toThrow();
	});
});

describe("openBrowser", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		vi.clearAllMocks();
	});

	it("calls execFile with the URL as a separate argument (no shell injection)", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		openBrowser("http://127.0.0.1:4100");
		expect(execFile).toHaveBeenCalledOnce();
		const calls = vi.mocked(execFile).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const bin = calls[0][0] as string;
		const args = calls[0][1] as string[];
		expect(bin).toBe("xdg-open");
		expect(args).toEqual(["http://127.0.0.1:4100"]);
	});

	it("does not throw on execFile error (fire-and-forget)", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		// biome-ignore lint/suspicious/noExplicitAny: execFile overloads make precise typing impractical
		(vi.mocked(execFile) as any).mockImplementation(
			(_bin: string, _args: string[], cb: (err: Error | null) => void) => {
				cb(new Error("xdg-open not found"));
			},
		);
		// openBrowser itself must not throw
		expect(() => openBrowser("http://127.0.0.1:4100")).not.toThrow();
	});
});
