import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWindowTone, resetWindowTone } from "./window-tone.js";

const invoke = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function inDesktop(): void {
	(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
	delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
	invoke.mockClear();
	resetWindowTone();
});

describe("applyWindowTone", () => {
	it("tells the desktop which tint its material should take", async () => {
		inDesktop();

		applyWindowTone(true);
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("apply_window_tone", { dark: true }),
		);
	});

	// A theme lands again on every preview frame, and the attribute is a
	// window-wide repaint.
	it("says it once for as long as it stays true", async () => {
		inDesktop();

		applyWindowTone(true);
		applyWindowTone(true);
		applyWindowTone(true);
		await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

		applyWindowTone(false);
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenLastCalledWith("apply_window_tone", { dark: false }),
		);
	});

	it("is nobody's business in a browser", () => {
		applyWindowTone(true);

		expect(invoke).not.toHaveBeenCalled();
	});
});
