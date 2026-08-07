import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";
import { useThemeStore } from "../stores/theme.js";
import { useAutoSwitch } from "./useAutoSwitch.js";

// ── matchMedia mock ─────────────────────────────────────────────────────

let changeListeners: Array<(e: MediaQueryListEvent) => void> = [];
let matchesDark = true;

function createMockMediaQueryList(): MediaQueryList {
	return {
		matches: matchesDark,
		media: "(prefers-color-scheme: dark)",
		addEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
			changeListeners.push(cb);
		}),
		removeEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
			changeListeners = changeListeners.filter((l) => l !== cb);
		}),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
		onchange: null,
	} as unknown as MediaQueryList;
}

function fireMediaChange(dark: boolean): void {
	matchesDark = dark;
	for (const cb of changeListeners) {
		cb({ matches: dark } as MediaQueryListEvent);
	}
}

// ── Setup ───────────────────────────────────────────────────────────────

const setPropertyMock = vi.fn();
const originalSetProperty = document.documentElement.style.setProperty;

beforeEach(() => {
	setActivePinia(createPinia());
	changeListeners = [];
	matchesDark = true;
	vi.spyOn(window, "matchMedia").mockImplementation(() => createMockMediaQueryList());
	document.documentElement.style.setProperty = setPropertyMock;
	setPropertyMock.mockClear();

	// Stock the store with bundled themes
	const store = useThemeStore();
	store.availableThemes = Object.values(BUNDLED_THEMES);
});

afterEach(() => {
	document.documentElement.style.setProperty = originalSetProperty;
});

/**
 * Track applyTheme action calls via Pinia's $onAction.
 * useAutoSwitch bypasses setTheme (which has SC-14 autoSwitch-disabling logic)
 * and calls applyTheme directly, so we track that action instead.
 */
function trackSetTheme(store: ReturnType<typeof useThemeStore>): string[] {
	const calls: string[] = [];
	store.$onAction(({ name, args }) => {
		if (name === "applyTheme") {
			const theme = args[0] as { name: string };
			calls.push(theme.name);
		}
	});
	return calls;
}

describe("useAutoSwitch", () => {
	it("applies dark theme when OS is dark and enabled", () => {
		matchesDark = true;
		const scope = effectScope();
		scope.run(() => {
			const store = useThemeStore();
			const calls = trackSetTheme(store);
			const auto = useAutoSwitch();
			auto.darkThemeName.value = "catppuccin-mocha";
			auto.lightThemeName.value = "one-half-light";
			auto.enabled.value = true;

			expect(calls).toContain("catppuccin-mocha");
		});
		scope.stop();
	});

	it("applies light theme when OS is light and enabled", () => {
		matchesDark = false;
		const scope = effectScope();
		scope.run(() => {
			const store = useThemeStore();
			const calls = trackSetTheme(store);
			const auto = useAutoSwitch();
			auto.darkThemeName.value = "catppuccin-mocha";
			auto.lightThemeName.value = "one-half-light";
			auto.enabled.value = true;

			expect(calls).toContain("one-half-light");
		});
		scope.stop();
	});

	it("does not change theme on OS change when disabled", () => {
		const scope = effectScope();
		scope.run(() => {
			const store = useThemeStore();
			const calls = trackSetTheme(store);
			const _auto = useAutoSwitch();
			// enabled stays false

			fireMediaChange(false);
			fireMediaChange(true);

			expect(calls).toHaveLength(0);
		});
		scope.stop();
	});

	it("reacts to OS change when enabled", () => {
		matchesDark = true;
		const scope = effectScope();
		scope.run(() => {
			const store = useThemeStore();
			const calls = trackSetTheme(store);
			const auto = useAutoSwitch();
			auto.darkThemeName.value = "catppuccin-mocha";
			auto.lightThemeName.value = "one-half-light";
			auto.enabled.value = true;

			// Clear the initial apply call
			calls.length = 0;

			fireMediaChange(false);
			expect(calls).toContain("one-half-light");
		});
		scope.stop();
	});

	it("removes listener on scope stop (unmount)", () => {
		const scope = effectScope();
		scope.run(() => {
			const auto = useAutoSwitch();
			auto.enabled.value = true;
		});
		const listenerCountBefore = changeListeners.length;
		scope.stop();
		// After stop, listener should be removed via onScopeDispose
		expect(changeListeners.length).toBeLessThan(listenerCountBefore);
	});

	it("removes listener when disabled after being enabled", () => {
		const scope = effectScope();
		scope.run(() => {
			const auto = useAutoSwitch();
			auto.enabled.value = true;
			expect(changeListeners.length).toBe(1);
			auto.enabled.value = false;
			// stop() is called via watch, listener removed
			expect(changeListeners.length).toBe(0);
		});
		scope.stop();
	});
});
