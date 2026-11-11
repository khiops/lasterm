import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IPC_CONTRACT from "../../../desktop/src-tauri/ipc-contract.json";
import {
	IPC_FALLBACK_RELOAD_KEY,
	isRawIpcRefusal,
	RAW_IPC_REFUSAL,
	rawIpcWorked,
	reloadAfterIpcFallback,
	resetIpcFallbackForTests,
} from "./tauri-ipc-fallback.js";

describe("Tauri's postMessage fallback (#822)", () => {
	const reload = vi.fn();

	beforeEach(() => {
		window.sessionStorage.clear();
		reload.mockClear();
		resetIpcFallbackForTests(reload);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetIpcFallbackForTests();
		window.sessionStorage.clear();
		vi.restoreAllMocks();
	});

	// Native builds both refusals from the words of ipc-contract.json, which its
	// own test holds equal to what it sends.
	it("knows every refusal native gives a raw-bytes command whose body came as JSON", () => {
		expect(RAW_IPC_REFUSAL).toBe(IPC_CONTRACT.rawIpcRefusal);
		expect(isRawIpcRefusal(`WebSocket input ${IPC_CONTRACT.rawIpcRefusal}`)).toBe(true);
		expect(isRawIpcRefusal(`multipart relay chunk ${IPC_CONTRACT.rawIpcRefusal}`)).toBe(true);
		expect(isRawIpcRefusal(new Error(`hub relay failed: ${RAW_IPC_REFUSAL}`))).toBe(true);
		expect(isRawIpcRefusal("WebSocket relay input queue is full")).toBe(false);
	});

	it("reloads once, and records why", () => {
		expect(reloadAfterIpcFallback("WebSocket input must use Tauri raw IPC bytes")).toBe(true);
		expect(reloadAfterIpcFallback("WebSocket input must use Tauri raw IPC bytes")).toBe(true);

		expect(reload).toHaveBeenCalledTimes(1);
		expect(window.sessionStorage.getItem(IPC_FALLBACK_RELOAD_KEY)).toContain(
			"WebSocket input must use Tauri raw IPC bytes",
		);
	});

	it("does not reload a page that came back from such a reload without raw IPC", () => {
		window.sessionStorage.setItem(IPC_FALLBACK_RELOAD_KEY, "2026-10-31T15:00:00.000Z earlier");

		expect(reloadAfterIpcFallback("again")).toBe(false);
		expect(reload).not.toHaveBeenCalled();
	});

	it("reloads again once raw IPC has worked since the last reload", () => {
		window.sessionStorage.setItem(IPC_FALLBACK_RELOAD_KEY, "2026-10-31T15:00:00.000Z earlier");

		rawIpcWorked();
		expect(window.sessionStorage.getItem(IPC_FALLBACK_RELOAD_KEY)).toBeNull();
		expect(reloadAfterIpcFallback("later")).toBe(true);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does not reload when nothing can record it, since a loop could not be told apart", () => {
		vi.stubGlobal("sessionStorage", {
			getItem: () => null,
			setItem: () => {
				throw new Error("storage disabled");
			},
			removeItem: () => {},
		});

		expect(reloadAfterIpcFallback("refused")).toBe(false);
		expect(reload).not.toHaveBeenCalled();
	});
});
