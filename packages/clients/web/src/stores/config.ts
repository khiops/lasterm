import {
	type CascadeResponse,
	type ChannelsConfig,
	DEFAULT_PROFILE,
	type ExperimentalConfig,
	type FontFamily,
	isFileTransferEnabled,
	type KeyboardConfig,
	type LayoutConfig,
	type NotificationConfig,
	type PanesConfig,
	type ProfileWriteLayers,
	type ProfileWritePlan,
	type ProfileWriteTarget,
	planProfileWrite,
	type SearchConfig,
	type StartupConfig,
	type SystemFontFamily,
	type TabsConfig,
	type TerminalProfile,
	type TitleConfig,
	type TransferConfig,
} from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { AlwaysChoice } from "../utils/exit-action.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { domPublicAssetUrl, hubBaseUrl, publicAssetUrl } from "../utils/hub-url.js";
import { systemFontFaceRules } from "../utils/system-fonts.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";
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
let injectedFontObjectUrls = new Set<string>();

export async function injectFontFaces(families: FontFamily[]): Promise<void> {
	const rules: string[] = [];
	const nextObjectUrls = new Set<string>();
	for (const family of families) {
		for (const file of family.files) {
			let objectUrl: string | null = null;
			try {
				const pathname = new URL(file.url, "http://localhost").pathname;
				const format = pathname.endsWith(".woff2")
					? "woff2"
					: pathname.endsWith(".woff")
						? "woff"
						: pathname.endsWith(".ttf")
							? "truetype"
							: "opentype";
				const src = file.url.startsWith("/") ? await domPublicAssetUrl(file.url) : file.url;
				if (file.url.startsWith("/") && src.startsWith("blob:")) objectUrl = src;
				rules.push(
					`@font-face {
	font-family: "${family.family}";
	src: url("${src}") format("${format}");
	font-weight: ${file.weight};
	font-style: ${file.style};
	font-display: swap;
}`,
				);
				if (objectUrl) nextObjectUrls.add(objectUrl);
			} catch (err) {
				if (objectUrl) URL.revokeObjectURL(objectUrl);
				console.error(
					`[config] failed to resolve custom font ${family.family} (${file.url}):`,
					err,
				);
			}
		}
	}

	// A failed refresh must not make a working font set disappear. An empty
	// configured list is intentional and therefore replaces the rules with none.
	if (families.length > 0 && rules.length === 0) return;

	const style = document.createElement("style");
	style.id = "lasterm-fonts";
	style.textContent = rules.join("\n");
	const existing = document.getElementById("lasterm-fonts");
	if (existing) {
		existing.replaceWith(style);
	} else {
		document.head.appendChild(style);
	}

	for (const objectUrl of injectedFontObjectUrls) {
		if (!nextObjectUrls.has(objectUrl)) URL.revokeObjectURL(objectUrl);
	}
	injectedFontObjectUrls = nextObjectUrls;
}

/**
 * Config store — holds the resolved terminal profile and available fonts.
 * Fetches both from the hub on load.
 */
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
	keyboard?: KeyboardConfig;
	transfer?: TransferConfig;
	experimental?: ExperimentalConfig;
}

/** The UI sections `saveUiSettings` writes. */
interface SavedUiSections {
	layout: LayoutConfig;
	keyboard: KeyboardConfig;
	/** The files panel's own, which its Options change at once (#836). */
	transfer: TransferConfig;
}

export const useConfigStore = defineStore("config", () => {
	const profile = ref<TerminalProfile>({ ...DEFAULT_PROFILE });
	const fonts = ref<FontFamily[]>([]);
	/** Fonts installed where the hub runs (#100); `null` until first asked for. */
	const systemFonts = ref<SystemFontFamily[] | null>(null);
	const loaded = ref(false);
	const uiConfig = ref<UiConfig>({ onChannelDead: "readonly" });

	/**
	 * File transfer is on (`[experimental] file_transfer`, #835): what the drop
	 * on a terminal and the files panel check before anything (#836, #837).
	 * Off until the UI config is read, and until someone turns it on.
	 */
	const fileTransferEnabled = computed(() => isFileTransferEnabled(uiConfig.value));

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

	// ─── "Always do this", told to this window's panes (#586) ─────────────
	const alwaysChoiceListeners = new Set<(choice: AlwaysChoice) => void>();

	/** Hear each "Always do this" clicked in this window, once it is written. */
	function onAlwaysChoice(listener: (choice: AlwaysChoice) => void): () => void {
		alwaysChoiceListeners.add(listener);
		return () => alwaysChoiceListeners.delete(listener);
	}

	/**
	 * Tell this window's panes about an "Always do this". Only them: nothing is
	 * kept, and nothing goes to the hub, so no other window hears it.
	 */
	function announceAlwaysChoice(choice: AlwaysChoice): void {
		for (const listener of alwaysChoiceListeners) {
			listener(choice);
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
			await injectFontFaces(fontList);

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
		// A browser may render a system font of the hub's machine as soon as a
		// profile names it. Not awaited: the first scan must not delay startup.
		if (!isTauriRuntime()) {
			loadSystemFonts().catch((err) => console.warn("[config] failed to load system fonts:", err));
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

	/**
	 * Write settings of one UI section to the hub, and take them here at once.
	 *
	 * For a choice made outside Settings' schema — the panels' sizes; the host
	 * rail's columns and badge size (#623); the key hints (#639). The
	 * hub announces the change, so every other window reads it again; this one
	 * does not wait for that to act on it. A write the hub refused is undone by
	 * reading back what it holds.
	 */
	async function saveUiSettings<S extends keyof SavedUiSections>(
		section: S,
		values: Partial<SavedUiSections[S]>,
	): Promise<boolean> {
		uiConfig.value = {
			...uiConfig.value,
			[section]: { ...uiConfig.value[section], ...values },
		};
		try {
			const authStore = useAuthStore();
			const resp = await hubFetch(`${hubBaseUrl()}/api/config/ui`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				},
				body: JSON.stringify({ [section]: values }),
			});
			if (resp.ok) return true;
		} catch (err) {
			console.warn("[config] failed to save UI settings:", err);
		}
		await loadUiConfig();
		return false;
	}

	/**
	 * The host's and the terminal's own profiles, as the hub holds them now
	 * (#835): what `planProfileWrite` reads to say which overrides a write
	 * drops, so that a caller can say so before writing. Null when the hub
	 * could not be asked.
	 */
	async function readProfileLayers(target: ProfileWriteTarget): Promise<ProfileWriteLayers | null> {
		const cascade = await readCascade(target);
		return cascade === null
			? null
			: { host: cascade.terminal.host, channel: cascade.terminal.channel };
	}

	/**
	 * Every layer of a terminal's settings as the hub resolves them now, from the defaults to
	 * its own: what the files panel's Options show, each value with where it comes from (#836).
	 * Null when the hub could not be asked.
	 */
	async function readCascade(target: ProfileWriteTarget): Promise<CascadeResponse | null> {
		try {
			const authStore = useAuthStore();
			const params = new URLSearchParams();
			if (target.hostId !== null) params.set("host_id", target.hostId);
			if (target.channelId !== null) params.set("channel_id", target.channelId);
			const qs = params.toString();
			const resp = await hubFetch(`${hubBaseUrl()}/api/config/cascade${qs ? `?${qs}` : ""}`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!resp.ok) return null;
			return (await resp.json()) as CascadeResponse;
		} catch (err) {
			console.warn("[config] failed to read a terminal's profiles:", err);
			return null;
		}
	}

	/**
	 * Make the write `planProfileWrite` planned (#835): one terminal-profile
	 * key set for a host or globally, then the overrides nearer to the
	 * terminal it has to hold on dropped, in that order, stopping at the
	 * first request the hub refuses. "Always do this" (#574), the files
	 * panel's options (#836) and an upload's conflict step (#837) all write
	 * through here.
	 *
	 * The hub announces each write, so every window reads its terminals'
	 * settings again; this one is told at once, refused or not, since part of
	 * it may have been written.
	 */
	async function saveProfileWrite(plan: ProfileWritePlan): Promise<boolean> {
		const authStore = useAuthStore();
		let ok = true;
		try {
			for (const request of plan.requests) {
				const resp = await hubFetch(`${hubBaseUrl()}${request.path}`, {
					method: request.method,
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${authStore.token}`,
					},
					body: JSON.stringify(request.body),
				});
				if (!resp.ok) {
					ok = false;
					break;
				}
			}
		} catch (err) {
			console.warn(`[config] failed to save the terminal setting ${plan.key}:`, err);
			ok = false;
		}

		const { hostId, channelId } = plan.target;
		emitProfileChange({
			scope: plan.scope,
			...(hostId !== null && { hostId }),
			...(channelId !== null && { channelId }),
		});
		if (plan.scope === "global") await loadProfile();
		return ok;
	}

	/**
	 * Write "When a terminal ends" where "Always do this" said (#574): for the
	 * terminal's host, or globally.
	 *
	 * The choice then holds over the terminal it was made on: the overrides
	 * nearer to it — the terminal's own, and with "globally" its host's — are
	 * dropped, or it would not apply where it was just made. Other hosts keep
	 * theirs, as Settings shows (`saveProfileWrite`).
	 *
	 * Once written, the choice is also told to the other panes of this window,
	 * so that the overlays already waiting in its scope can follow it (#586).
	 * A write the hub refused tells them nothing.
	 */
	async function saveWhenEnded(
		whenEnded: "restart" | "close",
		scope: "host" | "global",
		where: { hostId: string | null; channelId: string | null },
	): Promise<boolean> {
		// The click, which orders it among the choices made in this window.
		const at = performance.now();
		const plan = planProfileWrite("whenEnded", whenEnded, scope, where);
		if (plan === null) return false;
		const ok = await saveProfileWrite(plan);
		if (ok) {
			announceAlwaysChoice({
				action: whenEnded,
				scope,
				hostId: where.hostId,
				channelId: where.channelId,
				at,
			});
		}
		return ok;
	}

	/**
	 * List the fonts installed where the hub runs (#100). A browser also gets
	 * their @font-face rules, since it may be on another machine. The desktop
	 * shell only ever drives its own local hub, so those fonts are installed
	 * right here and need no rules — nor a download through the relay.
	 */
	async function loadSystemFonts(): Promise<void> {
		const authStore = useAuthStore();
		const response = await hubFetch(`${hubBaseUrl()}/api/fonts/system`, {
			...(authStore.token ? { headers: { Authorization: `Bearer ${authStore.token}` } } : {}),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const families: SystemFontFamily[] = await response.json();
		systemFonts.value = families;
		if (isTauriRuntime()) return;
		const style = document.createElement("style");
		style.id = "lasterm-system-fonts";
		style.textContent = systemFontFaceRules(
			families,
			(url) => publicAssetUrl(url),
			new Set(fonts.value.map((font) => font.family)),
		);
		const existing = document.getElementById("lasterm-system-fonts");
		if (existing) existing.replaceWith(style);
		else document.head.appendChild(style);
	}

	return {
		profile,
		fonts,
		systemFonts,
		loaded,
		uiConfig,
		fileTransferEnabled,
		loadFonts,
		loadSystemFonts,
		loadProfile,
		loadUiConfig,
		saveUiSettings,
		readProfileLayers,
		readCascade,
		saveProfileWrite,
		saveWhenEnded,
		onProfileChange,
		emitProfileChange,
		onAlwaysChoice,
		announceAlwaysChoice,
	};
});
