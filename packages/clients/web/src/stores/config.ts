import {
	type ChannelsConfig,
	DEFAULT_PROFILE,
	type FontFamily,
	type NotificationConfig,
	type PanesConfig,
	type SearchConfig,
	type StartupConfig,
	type TabsConfig,
	type TerminalProfile,
	type TitleConfig,
} from "@lasterm/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl, publicAssetUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";

// ─── Profile change event bus ─────────────────────────────────────────────────

export type ProfileChangeEvent = {
	scope: "global" | "host" | "channel";
	hostId?: string;
	channelId?: string;
};

type ProfileChangeListener = (event: ProfileChangeEvent) => void;

/**
 * Inject @font-face rules into the document head so the browser
 * can resolve custom font families referenced in the terminal profile.
 */
function injectFontFaces(families: FontFamily[]): void {
	// Remove any previously injected style element
	const existing = document.getElementById("lasterm-fonts");
	if (existing) existing.remove();

	if (families.length === 0) return;

	const rules: string[] = [];
	for (const family of families) {
		for (const file of family.files) {
			const pathname = new URL(file.url, "http://localhost").pathname;
			const format = pathname.endsWith(".woff2")
				? "woff2"
				: pathname.endsWith(".woff")
					? "woff"
					: pathname.endsWith(".ttf")
						? "truetype"
						: "opentype";
			const src = file.url.startsWith("/public/")
				? publicAssetUrl(file.url)
				: file.url.startsWith("/")
					? `${hubBaseUrl()}${file.url}`
					: file.url;
			rules.push(
				`@font-face {
	font-family: "${family.family}";
	src: url("${src}") format("${format}");
	font-weight: ${file.weight};
	font-style: ${file.style};
	font-display: swap;
}`,
			);
		}
	}

	const style = document.createElement("style");
	style.id = "lasterm-fonts";
	style.textContent = rules.join("\n");
	document.head.appendChild(style);
}

/**
 * Config store — holds the resolved terminal profile and available fonts.
 * Fetches both from the hub on load.
 */
interface LayoutConfig {
	hostRailWidth: number;
	sidebarWidth: number;
}

interface UiConfig {
	onChannelDead: "close" | "readonly";
	tabs?: TabsConfig;
	panes?: PanesConfig;
	channels?: ChannelsConfig;
	startup?: StartupConfig;
	title?: TitleConfig;
	search?: SearchConfig;
	notifications?: NotificationConfig;
	layout?: LayoutConfig;
}

export const useConfigStore = defineStore("config", () => {
	const profile = ref<TerminalProfile>({ ...DEFAULT_PROFILE });
	const fonts = ref<FontFamily[]>([]);
	const loaded = ref(false);
	const uiConfig = ref<UiConfig>({ onChannelDead: "readonly" });

	// ─── Profile change event bus ─────────────────────────────────────────
	const profileChangeListeners = new Set<ProfileChangeListener>();

	function onProfileChange(listener: ProfileChangeListener): () => void {
		profileChangeListeners.add(listener);
		return () => profileChangeListeners.delete(listener);
	}

	function emitProfileChange(event: ProfileChangeEvent): void {
		for (const listener of profileChangeListeners) {
			listener(event);
		}
	}

	/**
	 * Load fonts from the hub (no auth needed).
	 * Call early — before terminals are created — so @font-face rules
	 * are injected and fonts are downloaded for canvas rendering.
	 */
	async function loadFonts(): Promise<void> {
		try {
			const authStore = useAuthStore();
			const response = await hubFetch(`${hubBaseUrl()}/api/fonts`, {
				...(authStore.token ? { headers: { Authorization: `Bearer ${authStore.token}` } } : {}),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const fontList: FontFamily[] = await response.json();
			fonts.value = fontList;
			injectFontFaces(fontList);

			// Force-load fonts so canvas-based xterm.js can use them.
			// document.fonts.load() triggers actual download; without this,
			// @font-face with font-display:swap stays "unloaded" until DOM text uses it.
			const loadPromises: Promise<FontFace[]>[] = [];
			for (const family of fontList) {
				for (const file of family.files) {
					loadPromises.push(
						document.fonts.load(
							`${file.weight} ${file.style === "italic" ? "italic " : ""}14px "${family.family}"`,
						),
					);
				}
			}
			await Promise.allSettled(loadPromises);
		} catch (err) {
			console.warn("[config] failed to load fonts:", err);
		}
	}

	/**
	 * Load the global resolved terminal profile from the hub (requires auth).
	 * Fetches /api/config/cascade and extracts terminal.resolved.
	 * Call after authentication is established.
	 * Per-terminal resolution is handled by useResolvedProfile composable.
	 */
	async function loadProfile(): Promise<void> {
		try {
			const authStore = useAuthStore();
			const resp = await hubFetch(`${hubBaseUrl()}/api/config/cascade`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (resp.ok) {
				const cascade = (await resp.json()) as { terminal: { resolved: TerminalProfile } };
				profile.value = cascade.terminal.resolved;
			}
		} catch (err) {
			console.warn("[config] failed to load resolved config:", err);
		}
		loaded.value = true;
	}

	/**
	 * Load UI behaviour config from the hub (requires auth).
	 * Controls how the client reacts to dead channels, etc.
	 */
	async function loadUiConfig(): Promise<void> {
		try {
			const authStore = useAuthStore();
			const resp = await hubFetch(`${hubBaseUrl()}/api/config/ui`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (resp.ok) {
				uiConfig.value = await resp.json();
			}
		} catch (err) {
			console.warn("[config] failed to load UI config:", err);
		}
	}

	return {
		profile,
		fonts,
		loaded,
		uiConfig,
		loadFonts,
		loadProfile,
		loadUiConfig,
		onProfileChange,
		emitProfileChange,
	};
});
