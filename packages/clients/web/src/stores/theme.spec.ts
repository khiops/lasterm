import type { LastermTheme } from "@lasterm/shared";
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToRgb, readableForeground, useThemeStore } from "./theme.js";

const catppuccinMocha = BUNDLED_THEMES["catppuccin-mocha"] as LastermTheme;
const nordTheme = BUNDLED_THEMES.nord as LastermTheme;

// Mock document.documentElement.style.setProperty
const setPropertyMock = vi.fn();
const originalSetProperty = document.documentElement.style.setProperty;

beforeEach(() => {
	setActivePinia(createPinia());
	document.documentElement.style.setProperty = setPropertyMock;
	setPropertyMock.mockClear();
});

afterEach(() => {
	document.documentElement.style.setProperty = originalSetProperty;
});

describe("hexToRgb", () => {
	it("converts 6-digit hex to comma-separated RGB", () => {
		expect(hexToRgb("#89b4fa")).toBe("137, 180, 250");
	});

	it("converts black", () => {
		expect(hexToRgb("#000000")).toBe("0, 0, 0");
	});

	it("converts white", () => {
		expect(hexToRgb("#ffffff")).toBe("255, 255, 255");
	});

	it("converts a mid-range color", () => {
		expect(hexToRgb("#f38ba8")).toBe("243, 139, 168");
	});

	it("handles 8-digit hex (ignores alpha)", () => {
		expect(hexToRgb("#f38ba8ff")).toBe("243, 139, 168");
		expect(hexToRgb("#00000080")).toBe("0, 0, 0");
	});
});

describe("useThemeStore", () => {
	describe("applyTheme", () => {
		it("sets all CSS variables on :root", () => {
			const store = useThemeStore();
			store.applyTheme(catppuccinMocha);

			// Tier 1: terminal colors
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-fg", catppuccinMocha.colors.foreground);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-bg", catppuccinMocha.colors.background);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-cursor", catppuccinMocha.colors.cursor);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-red", catppuccinMocha.colors.red);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-green", catppuccinMocha.colors.green);

			// Tier 2: UI chrome
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-tab-bar", catppuccinMocha.ui.tabBar);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-accent", catppuccinMocha.ui.accent);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-border", catppuccinMocha.ui.border);
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-badge", catppuccinMocha.ui.badge);

			// Tier 3: computed
			// --nt-text-secondary / --nt-text-muted are NOT set by applyTheme — they derive
			// from --nt-fg/--nt-bg via color-mix in base.css so they stay legible in light AND
			// dark themes (setting muted = brightWhite made muted text invisible on a light bg).
			expect(setPropertyMock).not.toHaveBeenCalledWith("--nt-text-muted", expect.anything());
			expect(setPropertyMock).not.toHaveBeenCalledWith("--nt-text-secondary", expect.anything());
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-accent-fg", "#000000");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-danger-fg", "#000000");

			// RGB components
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-accent-rgb", "137, 180, 250");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-badge-rgb", "243, 139, 168");

			// Dark theme overlays
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-overlay", "rgba(0, 0, 0, 0.5)");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-overlay-heavy", "rgba(0, 0, 0, 0.7)");
		});

		it("sets at least 42 CSS properties", () => {
			const store = useThemeStore();
			store.applyTheme(catppuccinMocha);
			// 22 tier1 + 15 tier2 + 2 text + 6 rgb + 3 overlays = 48 calls
			expect(setPropertyMock.mock.calls.length).toBeGreaterThanOrEqual(42);
		});
	});

	describe("previewHover / clearPreview", () => {
		it("sets previewTheme on hover", () => {
			const store = useThemeStore();
			store.currentTheme = catppuccinMocha;

			// previewHover uses rAF — directly set for unit test
			store.previewTheme = nordTheme;
			expect(store.previewTheme?.name).toBe("nord");
			expect(store.activeTheme?.name).toBe("nord");
		});

		it("clearPreview restores current theme", () => {
			const store = useThemeStore();
			store.currentTheme = catppuccinMocha;
			store.previewTheme = nordTheme;

			// Simulate clearPreview effect
			store.previewTheme = null;
			expect(store.previewTheme).toBeNull();
			expect(store.activeTheme?.name).toBe("catppuccin-mocha");
		});
	});

	describe("initialize", () => {
		it("applies the default bundled theme", () => {
			const store = useThemeStore();
			store.initialize();
			expect(store.currentTheme).not.toBeNull();
			expect(store.currentTheme?.name).toBe("catppuccin-mocha");
			expect(setPropertyMock).toHaveBeenCalled();
		});
	});

	describe("toXtermTheme", () => {
		it("maps all required color fields", () => {
			const store = useThemeStore();
			const result = store.toXtermTheme(catppuccinMocha.colors);

			expect(result.foreground).toBe(catppuccinMocha.colors.foreground);
			expect(result.background).toBe(catppuccinMocha.colors.background);
			expect(result.cursor).toBe(catppuccinMocha.colors.cursor);
			expect(result.black).toBe(catppuccinMocha.colors.black);
			expect(result.red).toBe(catppuccinMocha.colors.red);
			expect(result.green).toBe(catppuccinMocha.colors.green);
			expect(result.yellow).toBe(catppuccinMocha.colors.yellow);
			expect(result.blue).toBe(catppuccinMocha.colors.blue);
			expect(result.magenta).toBe(catppuccinMocha.colors.magenta);
			expect(result.cyan).toBe(catppuccinMocha.colors.cyan);
			expect(result.white).toBe(catppuccinMocha.colors.white);
			expect(result.brightBlack).toBe(catppuccinMocha.colors.brightBlack);
			expect(result.brightWhite).toBe(catppuccinMocha.colors.brightWhite);
			expect(result.selectionBackground).toBe(catppuccinMocha.colors.selectionBackground);
		});

		it("omits undefined optional fields", () => {
			const store = useThemeStore();
			const { cursorAccent: _ca, selectionForeground: _sf, ...rest } = catppuccinMocha.colors;
			const colorsWithoutOptional = { ...rest };

			const result = store.toXtermTheme(colorsWithoutOptional);

			expect(result).not.toHaveProperty("cursorAccent");
			expect(result).not.toHaveProperty("selectionForeground");
		});

		it("includes optional fields when defined", () => {
			const store = useThemeStore();
			const colorsWithOptional = {
				...catppuccinMocha.colors,
				cursorAccent: "#ff0000",
				selectionForeground: "#00ff00",
			};

			const result = store.toXtermTheme(colorsWithOptional);

			expect(result.cursorAccent).toBe("#ff0000");
			expect(result.selectionForeground).toBe("#00ff00");
		});
	});

	describe("onTerminalThemeChange", () => {
		it("callback is invoked when applyTheme is called", () => {
			const store = useThemeStore();
			const cb = vi.fn();
			store.onTerminalThemeChange(cb);

			store.applyTheme(catppuccinMocha);

			expect(cb).toHaveBeenCalledOnce();
			const received = cb.mock.calls[0]?.[0] as Record<string, string>;
			expect(received.foreground).toBe(catppuccinMocha.colors.foreground);
			expect(received.background).toBe(catppuccinMocha.colors.background);
			expect(received.cursor).toBe(catppuccinMocha.colors.cursor);
		});

		it("unsubscribe stops future callbacks", () => {
			const store = useThemeStore();
			const cb = vi.fn();
			const unsub = store.onTerminalThemeChange(cb);

			store.applyTheme(catppuccinMocha);
			expect(cb).toHaveBeenCalledOnce();

			unsub();
			store.applyTheme(nordTheme);
			expect(cb).toHaveBeenCalledOnce(); // still 1, not 2
		});

		it("multiple callbacks are all invoked", () => {
			const store = useThemeStore();
			const cb1 = vi.fn();
			const cb2 = vi.fn();
			store.onTerminalThemeChange(cb1);
			store.onTerminalThemeChange(cb2);

			store.applyTheme(nordTheme);

			expect(cb1).toHaveBeenCalledOnce();
			expect(cb2).toHaveBeenCalledOnce();
		});

		it("callback receives correct xterm.js theme format (Record<string, string>)", () => {
			const store = useThemeStore();
			const cb = vi.fn();
			store.onTerminalThemeChange(cb);

			store.applyTheme(catppuccinMocha);

			const received = cb.mock.calls[0]?.[0] as Record<string, string>;
			// Must have all required ANSI colors
			for (const key of [
				"foreground",
				"background",
				"cursor",
				"black",
				"red",
				"green",
				"yellow",
				"blue",
				"magenta",
				"cyan",
				"white",
				"brightBlack",
				"brightRed",
				"brightGreen",
				"brightYellow",
				"brightBlue",
				"brightMagenta",
				"brightCyan",
				"brightWhite",
				"selectionBackground",
			]) {
				expect(typeof received[key]).toBe("string");
			}
		});
	});

	describe("activeTheme computed", () => {
		it("returns previewTheme when set", () => {
			const store = useThemeStore();
			store.currentTheme = catppuccinMocha;
			store.previewTheme = nordTheme;
			expect(store.activeTheme?.name).toBe("nord");
		});

		it("returns currentTheme when no preview", () => {
			const store = useThemeStore();
			store.currentTheme = catppuccinMocha;
			store.previewTheme = null;
			expect(store.activeTheme?.name).toBe("catppuccin-mocha");
		});

		it("returns null when nothing set", () => {
			const store = useThemeStore();
			expect(store.activeTheme).toBeNull();
		});
	});

	describe("setTheme", () => {
		it("disables auto-switch when enabled (SC-14)", async () => {
			const store = useThemeStore();
			// Enable auto-switch in appearance config
			store.appearance.autoSwitch = {
				enabled: true,
				darkTheme: "catppuccin-mocha",
				lightTheme: "one-half-light",
			};

			// Mock fetch to capture the PATCH payload
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);

			await store.setTheme(nordTheme);

			// Auto-switch should be disabled in local state
			expect(store.appearance.autoSwitch.enabled).toBe(false);

			// PATCH payload should include autoSwitch.enabled = false
			expect(fetchMock).toHaveBeenCalledOnce();
			const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as Record<
				string,
				unknown
			>;
			expect(body.theme).toBe("nord");
			expect(body.autoSwitch).toEqual(expect.objectContaining({ enabled: false }));

			vi.unstubAllGlobals();
		});
	});

	describe("applyOpacity", () => {
		it("sets alpha CSS variables for all surfaces", () => {
			const store = useThemeStore();
			store.applyOpacity({
				terminal: 80,
				sidebar: 60,
				hostRail: 40,
				tabBar: 100,
			});

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-terminal-alpha", "0.8");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-sidebar-alpha", "0.6");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-host-rail-alpha", "0.4");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-tab-bar-alpha", "1");
		});

		it("handles minimum opacity (20%)", () => {
			const store = useThemeStore();
			store.applyOpacity({
				terminal: 20,
				sidebar: 20,
				hostRail: 20,
				tabBar: 20,
			});

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-terminal-alpha", "0.2");
		});
	});

	describe("applyScrollbar", () => {
		it("sets thin width from config", () => {
			const store = useThemeStore();
			store.applyScrollbar({
				style: "thin",
				thumbColor: "",
				trackColor: "",
				widthThin: 6,
				widthWide: 14,
			});

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-scrollbar-width", "6px");
		});

		it("sets wide width from config", () => {
			const store = useThemeStore();
			store.applyScrollbar({
				style: "wide",
				thumbColor: "",
				trackColor: "",
				widthThin: 6,
				widthWide: 14,
			});

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-scrollbar-width", "14px");
		});

		it("sets width 0 when hidden", () => {
			const store = useThemeStore();
			store.applyScrollbar({
				style: "hidden",
				thumbColor: "",
				trackColor: "",
				widthThin: 6,
				widthWide: 14,
			});

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-scrollbar-width", "0");
		});

		it("overrides theme thumb/track colors when specified", () => {
			const store = useThemeStore();
			store.applyScrollbar({
				style: "thin",
				thumbColor: "#ff0000",
				trackColor: "#00ff00",
				widthThin: 6,
				widthWide: 14,
			});

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-scrollbar-thumb", "#ff0000");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-scrollbar-track", "#00ff00");
		});

		it("does not override theme colors when custom colors are empty", () => {
			const store = useThemeStore();
			setPropertyMock.mockClear();
			store.applyScrollbar({
				style: "thin",
				thumbColor: "",
				trackColor: "",
				widthThin: 6,
				widthWide: 14,
			});

			const calls = setPropertyMock.mock.calls.map((c: unknown[]) => c[0] as string);
			expect(calls).toContain("--nt-scrollbar-width");
			expect(calls).not.toContain("--nt-scrollbar-thumb");
			expect(calls).not.toContain("--nt-scrollbar-track");
		});
	});

	describe("applyTheme sets RGB variants for opacity surfaces", () => {
		it("sets sidebar-rgb, host-rail-rgb, tab-bar-rgb", () => {
			const store = useThemeStore();
			store.applyTheme(catppuccinMocha);

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-sidebar-rgb", expect.any(String));
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-host-rail-rgb", expect.any(String));
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-tab-bar-rgb", expect.any(String));
		});
	});

	describe("new --nt-* alias tokens track theme switches", () => {
		// --nt-text, --nt-fg-muted, --nt-danger, --nt-input-bg, --nt-bg-surface are pure CSS
		// var() aliases defined in base.css; they track the source token automatically via
		// CSS variable resolution (no JS needed). --nt-bg-raised uses color-mix().
		// The following tokens require applyTheme() to set them explicitly:

		it("applyTheme sets --nt-hover for dark theme", () => {
			const store = useThemeStore();
			store.applyTheme(catppuccinMocha); // catppuccin-mocha is a dark theme

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-hover", "rgba(255, 255, 255, 0.06)");
		});

		it("applyTheme sets --nt-hover for light theme", () => {
			const store = useThemeStore();
			const lightTheme = BUNDLED_THEMES["one-half-light"] as LastermTheme;
			store.applyTheme(lightTheme);

			expect(setPropertyMock).toHaveBeenCalledWith("--nt-hover", "rgba(0, 0, 0, 0.06)");
		});

		it("applyTheme sets --nt-danger-rgb from badgeDanger", () => {
			const store = useThemeStore();
			store.applyTheme(catppuccinMocha);

			// --nt-danger-rgb must be the RGB triple of the active theme's badgeDanger
			const expectedRgb = hexToRgb(catppuccinMocha.ui.badgeDanger ?? "#f38ba8");
			expect(setPropertyMock).toHaveBeenCalledWith("--nt-danger-rgb", expectedRgb);
		});

		it("applyTheme sets --nt-danger-rgb on every theme switch", () => {
			const store = useThemeStore();

			store.applyTheme(catppuccinMocha);
			const afterMocha = setPropertyMock.mock.calls.filter(
				(c: unknown[]) => c[0] === "--nt-danger-rgb",
			);
			expect(afterMocha.length).toBe(1);

			setPropertyMock.mockClear();
			store.applyTheme(nordTheme);
			const afterNord = setPropertyMock.mock.calls.filter(
				(c: unknown[]) => c[0] === "--nt-danger-rgb",
			);
			// Must be set again on the second theme switch
			expect(afterNord.length).toBe(1);
			// Value must be the RGB triple of that theme's effective badgeDanger
			expect(afterNord[0]?.[1]).toBe(hexToRgb(nordTheme.ui.badgeDanger ?? "#f38ba8"));
		});
	});
});

describe("readableForeground", () => {
	it("uses black text on light colors", () => {
		expect(readableForeground("#89b4fa")).toBe("#000000");
	});

	it("uses white text on dark colors", () => {
		expect(readableForeground("#0366d6")).toBe("#ffffff");
	});
});
