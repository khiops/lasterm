/**
 * A browser asks before leaving while this window sends uploads (#837), and never before the
 * guarded reload of `tauri-ipc-fallback.ts` (#823), which must not wait on a question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadAfterIpcFallback, resetIpcFallbackForTests } from "./tauri-ipc-fallback.js";
import { createUnloadGuard } from "./upload-unload.js";

function leave(): Event {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event;
}

describe("asking before leaving", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		resetIpcFallbackForTests();
		window.sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("asks only while this window sends uploads", () => {
		const guard = createUnloadGuard(window);
		expect(leave().defaultPrevented).toBe(false);
		guard.set(true);
		expect(guard.installed).toBe(true);
		expect(leave().defaultPrevented).toBe(true);
		guard.set(true);
		guard.set(false);
		expect(leave().defaultPrevented).toBe(false);
		guard.release();
	});

	it("goes before the guarded reload, and never comes back in that page", () => {
		const guard = createUnloadGuard(window);
		guard.set(true);
		let askedAtReload: boolean | null = null;
		resetIpcFallbackForTests(() => {
			askedAtReload = leave().defaultPrevented;
		});
		expect(reloadAfterIpcFallback("test")).toBe(true);
		expect(askedAtReload).toBe(false);
		expect(guard.installed).toBe(false);
		guard.set(true);
		expect(leave().defaultPrevented).toBe(false);
	});
});
