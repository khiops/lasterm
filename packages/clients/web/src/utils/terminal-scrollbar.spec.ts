import { DEFAULT_APPEARANCE } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { terminalScrollbarWidth } from "./terminal-scrollbar.js";

const scrollbar = { ...DEFAULT_APPEARANCE.scrollbar, widthThin: 6, widthWide: 14 };

describe("terminalScrollbarWidth", () => {
	it("uses the configured width for thin and wide scrollbars", () => {
		expect(terminalScrollbarWidth({ ...scrollbar, style: "thin" }, false)).toBe(6);
		expect(terminalScrollbarWidth({ ...scrollbar, style: "wide" }, true)).toBe(14);
	});

	it("keeps a thin gutter for search markers when the scrollbar is hidden", () => {
		expect(terminalScrollbarWidth({ ...scrollbar, style: "hidden" }, true)).toBe(6);
	});

	it("never returns 0, which xterm would replace with its 14px default", () => {
		expect(terminalScrollbarWidth({ ...scrollbar, style: "hidden" }, false)).toBe(1);
		expect(terminalScrollbarWidth({ ...scrollbar, style: "thin", widthThin: 0 }, false)).toBe(1);
	});
});
