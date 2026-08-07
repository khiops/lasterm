import type { AppearanceConfig, LastermTheme, LastermThemeColors } from "@lasterm/shared";
import { BUNDLED_THEMES, DEFAULT_APPEARANCE, DEFAULT_THEME_NAME } from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";

/**
 * Theme store — manages available themes, current/preview theme,
 * and applies CSS custom properties to :root.
 */
export const useThemeStore = defineStore("theme", () => {
	const availableThemes = ref<LastermTheme[]>([]);
	const currentTheme = ref<LastermTheme | null>(null);
	const previewTheme = ref<LastermTheme | null>(null);

	/**
	 * Scope-level theme override (host or channel).
	 * When set, clearPreview reverts to this instead of the global currentTheme.
	 */
	const scopeOverride = ref<LastermTheme | null>(null);

	/** The active theme (preview if hovering, otherwise current). */
	const activeTheme = computed(() => previewTheme.value ?? currentTheme.value);

	// ── Terminal theme callbacks ────────────────────────────────────────

	/** xterm.js instances register to receive theme color updates. */
	const terminalThemeCallbacks = new Set<(theme: Record<string, string>) => void>();

	/**
	 * Register a callback invoked whenever the active theme changes.
	 * Returns an unsubscribe function.
	 */
	function onTerminalThemeChange(cb: (theme: Record<string, string>) => void): () => void {
		terminalThemeCallbacks.add(cb);
		return () => terminalThemeCallbacks.delete(cb);
	}

	/**
	 * Convert LastermThemeColors to a plain object suitable for xterm.js ITheme.
	 * Strips undefined optional fields so xterm.js falls back to its own defaults.
	 */
	function toXtermTheme(colors: LastermThemeColors): Record<string, string> {
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(colors)) {
			if (value !== undefined) {
				result[key] = value;
			}
		}
		// Apply terminal opacity to background so xterm.js renders with alpha
		const alpha = appearance.value.opacity.terminal / 100;
		if (alpha < 1 && result.background) {
			result.background = hexToRgba(result.background, alpha);
		}
		return result;
	}

	// ── Load themes from hub API ────────────────────────────────────────

	async function loadThemes(): Promise<void> {
		const authStore = useAuthStore();
		try {
			const response = await fetch(`${hubBaseUrl()}/api/themes`, {
				headers: {
					Authorization: `Bearer ${authStore.token ?? ""}`,
				},
			});
			if (response.ok) {
				availableThemes.value = (await response.json()) as LastermTheme[];
			}
		} catch {
			// API may not exist yet — fall back to bundled themes
		}

		// Always include bundled themes
		if (availableThemes.value.length === 0) {
			availableThemes.value = Object.values(BUNDLED_THEMES);
		}
	}

	// ── Apply theme: set CSS variables on :root ─────────────────────────

	function applyTheme(theme: LastermTheme): void {
		const root = document.documentElement.style;

		// Tier 1: terminal colors
		root.setProperty("--nt-fg", theme.colors.foreground);
		root.setProperty("--nt-bg", theme.colors.background);
		root.setProperty("--nt-cursor", theme.colors.cursor);
		root.setProperty("--nt-cursor-accent", theme.colors.cursorAccent ?? "transparent");
		root.setProperty("--nt-selection-bg", theme.colors.selectionBackground);
		root.setProperty("--nt-selection-fg", theme.colors.selectionForeground ?? "transparent");

		// ANSI 16
		root.setProperty("--nt-black", theme.colors.black);
		root.setProperty("--nt-red", theme.colors.red);
		root.setProperty("--nt-green", theme.colors.green);
		root.setProperty("--nt-yellow", theme.colors.yellow);
		root.setProperty("--nt-blue", theme.colors.blue);
		root.setProperty("--nt-magenta", theme.colors.magenta);
		root.setProperty("--nt-cyan", theme.colors.cyan);
		root.setProperty("--nt-white", theme.colors.white);
		root.setProperty("--nt-bright-black", theme.colors.brightBlack);
		root.setProperty("--nt-bright-red", theme.colors.brightRed);
		root.setProperty("--nt-bright-green", theme.colors.brightGreen);
		root.setProperty("--nt-bright-yellow", theme.colors.brightYellow);
		root.setProperty("--nt-bright-blue", theme.colors.brightBlue);
		root.setProperty("--nt-bright-magenta", theme.colors.brightMagenta);
		root.setProperty("--nt-bright-cyan", theme.colors.brightCyan);
		root.setProperty("--nt-bright-white", theme.colors.brightWhite);

		// Tier 2: UI chrome
		root.setProperty("--nt-tab-bar", theme.ui.tabBar);
		root.setProperty("--nt-tab-active", theme.ui.tabActive);
		root.setProperty("--nt-tab-inactive", theme.ui.tabInactive);
		root.setProperty("--nt-tab-hover", theme.ui.tabHover);
		root.setProperty("--nt-sidebar", theme.ui.sidebar);
		root.setProperty("--nt-sidebar-text", theme.ui.sidebarText);
		root.setProperty("--nt-sidebar-active", theme.ui.sidebarActive);
		root.setProperty("--nt-host-rail", theme.ui.hostRail);
		root.setProperty("--nt-border", theme.ui.border);
		root.setProperty("--nt-accent", theme.ui.accent);
		root.setProperty("--nt-badge", theme.ui.badge);
		root.setProperty("--nt-scrollbar-thumb", theme.ui.scrollbarThumb);
		root.setProperty("--nt-scrollbar-track", theme.ui.scrollbarTrack);
		root.setProperty("--nt-search-highlight", theme.ui.searchHighlight);
		root.setProperty("--nt-search-highlight-active", theme.ui.searchHighlightActive);
		const badgeDanger = theme.ui.badgeDanger ?? "#f38ba8";
		root.setProperty("--nt-badge-info", theme.ui.badgeInfo ?? "#89b4fa");
		root.setProperty("--nt-badge-warning", theme.ui.badgeWarning ?? "#f9e2af");
		root.setProperty("--nt-badge-success", theme.ui.badgeSuccess ?? "#a6e3a1");
		root.setProperty("--nt-badge-danger", badgeDanger);
		root.setProperty("--nt-danger", badgeDanger);

		// Tier 3: computed
		// NOTE: --nt-text-secondary / --nt-text-muted are intentionally NOT set here.
		// They derive from --nt-fg/--nt-bg via color-mix in base.css so they stay legible
		// in BOTH light and dark themes. Setting them to brightBlack/brightWhite assumed a
		// dark background (brightWhite muted text is invisible on a light theme's light bg).
		root.setProperty("--nt-accent-fg", readableForeground(theme.ui.accent));
		root.setProperty("--nt-danger-fg", readableForeground(badgeDanger));

		// RGB components for rgba() usage
		root.setProperty("--nt-accent-rgb", hexToRgb(theme.ui.accent));
		root.setProperty("--nt-badge-rgb", hexToRgb(theme.ui.badge));
		root.setProperty("--nt-danger-rgb", hexToRgb(theme.ui.badgeDanger ?? "#f38ba8"));
		root.setProperty("--nt-green-rgb", hexToRgb(theme.colors.green));
		root.setProperty("--nt-yellow-rgb", hexToRgb(theme.colors.yellow));
		root.setProperty("--nt-fg-rgb", hexToRgb(theme.colors.foreground));
		root.setProperty("--nt-bg-rgb", hexToRgb(theme.colors.background));
		root.setProperty("--nt-sidebar-rgb", hexToRgb(theme.ui.sidebar));
		root.setProperty("--nt-host-rail-rgb", hexToRgb(theme.ui.hostRail));
		root.setProperty("--nt-tab-bar-rgb", hexToRgb(theme.ui.tabBar));

		// Overlays and hover (dark vs light)
		if (theme.type === "dark") {
			root.setProperty("--nt-overlay", "rgba(0, 0, 0, 0.5)");
			root.setProperty("--nt-overlay-heavy", "rgba(0, 0, 0, 0.7)");
			root.setProperty("--nt-shadow", "0 4px 24px rgba(0, 0, 0, 0.6)");
			root.setProperty("--nt-hover", "rgba(255, 255, 255, 0.06)");
		} else {
			root.setProperty("--nt-overlay", "rgba(0, 0, 0, 0.3)");
			root.setProperty("--nt-overlay-heavy", "rgba(0, 0, 0, 0.5)");
			root.setProperty("--nt-shadow", "0 4px 24px rgba(0, 0, 0, 0.15)");
			root.setProperty("--nt-hover", "rgba(0, 0, 0, 0.06)");
		}

		// Notify xterm.js terminals of the color change
		const xtermTheme = toXtermTheme(theme.colors);
		for (const cb of terminalThemeCallbacks) {
			cb(xtermTheme);
		}
	}

	// ── Set current theme and apply ─────────────────────────────────────

	async function setTheme(theme: LastermTheme): Promise<void> {
		currentTheme.value = theme;
		applyTheme(theme);

		// Disable auto-switch on manual selection (SC-14)
		const update: Partial<AppearanceConfig> = { theme: theme.name };
		if (appearance.value.autoSwitch.enabled) {
			update.autoSwitch = { ...appearance.value.autoSwitch, enabled: false };
			appearance.value = {
				...appearance.value,
				autoSwitch: { ...appearance.value.autoSwitch, enabled: false },
			};
		}

		const authStore = useAuthStore();
		try {
			await fetch(`${hubBaseUrl()}/api/config/appearance`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token ?? ""}`,
				},
				body: JSON.stringify(update),
			});
		} catch {
			// API may not exist yet — theme is still applied locally
		}
	}

	// ── Preview on hover (debounced via rAF) ────────────────────────────

	let rafId: number | null = null;

	function previewHover(theme: LastermTheme): void {
		if (rafId !== null) cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			previewTheme.value = theme;
			applyTheme(theme);
			rafId = null;
		});
	}

	function clearPreview(): void {
		if (rafId !== null) cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			previewTheme.value = null;
			const revertTo = scopeOverride.value ?? currentTheme.value;
			if (revertTo !== null) applyTheme(revertTo);
			rafId = null;
		});
	}

	function setScopeOverride(theme: LastermTheme | null): void {
		scopeOverride.value = theme;
	}

	// ── Appearance config (opacity, scrollbar, auto-switch) ─────────────

	const appearance = ref<AppearanceConfig>({ ...DEFAULT_APPEARANCE });

	async function loadAppearance(): Promise<void> {
		const authStore = useAuthStore();
		try {
			const response = await fetch(`${hubBaseUrl()}/api/config/cascade`, {
				headers: {
					Authorization: `Bearer ${authStore.token ?? ""}`,
				},
			});
			if (response.ok) {
				const cascade = (await response.json()) as { appearance: AppearanceConfig };
				appearance.value = cascade.appearance;
			}
		} catch {
			// API may not exist yet — use defaults
		}
	}

	/** Apply opacity settings to CSS custom properties. */
	/** Apply opacity settings to CSS custom properties. */
	function applyOpacity(opacity: AppearanceConfig["opacity"]): void {
		const root = document.documentElement.style;
		root.setProperty("--nt-terminal-alpha", String(opacity.terminal / 100));
		root.setProperty("--nt-sidebar-alpha", String(opacity.sidebar / 100));
		root.setProperty("--nt-host-rail-alpha", String(opacity.hostRail / 100));
		root.setProperty("--nt-tab-bar-alpha", String(opacity.tabBar / 100));

		// Re-broadcast xterm theme so terminals pick up the new background alpha
		if (currentTheme.value) {
			const xtermTheme = toXtermTheme(currentTheme.value.colors);
			for (const cb of terminalThemeCallbacks) {
				cb(xtermTheme);
			}
		}
	}

	/** Apply scrollbar settings to CSS custom properties. */
	function applyScrollbar(scrollbar: AppearanceConfig["scrollbar"]): void {
		const root = document.documentElement.style;
		const width =
			scrollbar.style === "hidden"
				? "0"
				: scrollbar.style === "thin"
					? `${scrollbar.widthThin}px`
					: `${scrollbar.widthWide}px`;
		root.setProperty("--nt-scrollbar-width", width);
		if (scrollbar.thumbColor) {
			root.setProperty("--nt-scrollbar-thumb", scrollbar.thumbColor);
		}
		if (scrollbar.trackColor) {
			root.setProperty("--nt-scrollbar-track", scrollbar.trackColor);
		}
		document.documentElement.classList.toggle("nt-scrollbar-hidden", scrollbar.style === "hidden");
		window.dispatchEvent(new CustomEvent("nt:scrollbar-changed"));
	}

	/** Update appearance setting and persist via API. */
	async function updateAppearance(partial: Partial<AppearanceConfig>): Promise<void> {
		// Apply optimistic update locally
		appearance.value = { ...appearance.value, ...partial };

		const authStore = useAuthStore();
		try {
			await fetch(`${hubBaseUrl()}/api/config/appearance`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token ?? ""}`,
				},
				body: JSON.stringify(partial),
			});
		} catch {
			// API may not exist yet
		}
		applyOpacity(appearance.value.opacity);
		applyScrollbar(appearance.value.scrollbar);
	}

	// ── Initialize: apply default theme ─────────────────────────────────

	function initialize(): void {
		const defaultTheme = BUNDLED_THEMES[DEFAULT_THEME_NAME];
		if (defaultTheme !== undefined) {
			currentTheme.value = defaultTheme;
			applyTheme(defaultTheme);
		}
		applyOpacity(appearance.value.opacity);
		applyScrollbar(appearance.value.scrollbar);
	}

	return {
		availableThemes,
		currentTheme,
		previewTheme,
		activeTheme,
		appearance,
		loadThemes,
		loadAppearance,
		applyTheme,
		applyOpacity,
		applyScrollbar,
		updateAppearance,
		setTheme,
		previewHover,
		clearPreview,
		setScopeOverride,
		initialize,
		onTerminalThemeChange,
		toXtermTheme,
	};
});

// ── Helper: "#89b4fa" -> "137, 180, 250" ──────────────────────────────

export function hexToRgb(hex: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `${r}, ${g}, ${b}`;
}

// ── Helper: choose readable text for a solid theme color ──────────────

export function readableForeground(hex: string): "#000000" | "#ffffff" {
	const normalized = hex.trim();
	if (!/^#[0-9a-fA-F]{6}/.test(normalized)) return "#ffffff";

	const r = Number.parseInt(normalized.slice(1, 3), 16) / 255;
	const g = Number.parseInt(normalized.slice(3, 5), 16) / 255;
	const b = Number.parseInt(normalized.slice(5, 7), 16) / 255;
	const linear = (value: number) =>
		value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

	return luminance > 0.179 ? "#000000" : "#ffffff";
}

// ── Helper: "#89b4fa" + alpha -> "rgba(137, 180, 250, 0.85)" ──────────────
export function hexToRgba(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
