import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowFocus } from "./useWindowFocus.js";

// An end a pane found follows "When a terminal ends" only in the window with
// the focus, and acts when the focus comes back (#592).
describe("useWindowFocus", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("says whether the window has the focus, and follows it as it comes and goes", () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		const focused = useWindowFocus();
		expect(focused.value).toBe(false);

		hasFocus.mockReturnValue(true);
		window.dispatchEvent(new Event("focus"));
		expect(focused.value).toBe(true);

		hasFocus.mockReturnValue(false);
		window.dispatchEvent(new Event("blur"));
		expect(focused.value).toBe(false);

		// Shown again from another desktop, or the taskbar.
		hasFocus.mockReturnValue(true);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(focused.value).toBe(true);
	});

	it("is one state for the whole window, however many panes ask", () => {
		expect(useWindowFocus().value).toBe(useWindowFocus().value);
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		const first = useWindowFocus();
		const second = useWindowFocus();
		window.dispatchEvent(new Event("blur"));
		expect(first.value).toBe(false);
		expect(second.value).toBe(false);
		hasFocus.mockReturnValue(true);
		window.dispatchEvent(new Event("focus"));
		expect(first.value).toBe(true);
		expect(second.value).toBe(true);
	});
});
