// Config types and deep merge utility for lasterm config cascade
import type { AppearanceConfig } from "./appearance.js";
import type { ElevationMethod, TerminalProfile } from "./entities.js";
import { isPlainObject } from "./utils.js";

export type { TerminalProfile };

export interface PaneLayout {
	direction: "horizontal" | "vertical";
	ratio: number;
	first: PaneLayout | { channelId: string };
	second: PaneLayout | { channelId: string };
}

export interface TabEntry {
	channelId: string;
	label?: string;
	panes?: PaneLayout;
}

export interface TabLayout {
	type: "tabs";
	tabs: TabEntry[];
}

/**
 * Deep merge utility for the config cascade (4 layers, last wins).
 *
 * Rules:
 * - Objects merge recursively
 * - Scalars overwrite
 * - null removes the key
 * - Arrays replace (not merged)
 * - undefined sources are skipped
 */
export function deepMerge<T extends object>(...sources: (Partial<T> | undefined | null)[]): T {
	const result: Record<string, unknown> = {};

	for (const source of sources) {
		if (source == null) continue;

		for (const key of Object.keys(source)) {
			const sourceVal = source[key as keyof typeof source];

			if (sourceVal === null) {
				// null removes the key
				delete result[key];
			} else if (
				sourceVal !== undefined &&
				isPlainObject(sourceVal) &&
				isPlainObject(result[key])
			) {
				// Both sides are plain objects — recurse
				result[key] = deepMerge(
					result[key] as Record<string, unknown>,
					sourceVal as Record<string, unknown>,
				);
			} else if (sourceVal !== undefined) {
				// Scalar, array, or new object key — overwrite
				result[key] = sourceVal;
			}
		}
	}

	return result as T;
}

// ─── UI behavioral config interfaces ─────────────────────────────────────────

export interface TabsConfig {
	/** Whether to show close button on tabs. Default: true */
	closeButton?: boolean;
	/** Where new tabs open: "end" | "afterActive". Default: "end" */
	newTabPosition?: "end" | "afterActive";
	/** Confirm before Close All. Default: true */
	confirmCloseAll?: boolean;
	/** Confirm before Close Others. Default: true */
	confirmCloseOthers?: boolean;
}

export interface PanesConfig {
	/** Max panes per tab. Default: 4 */
	maxPanes?: number;
	/** Default split direction. Default: "horizontal" */
	defaultSplitDirection?: "horizontal" | "vertical";
}

export interface ChannelsConfig {
	/** Default shell for new channels. Default: system shell */
	defaultShell?: string;
	/** Name for the ungrouped channels bucket. Default: "General" */
	defaultGroupName?: string;
	/** Auto-assign new channels to a group. Default: "none" */
	autoGroup?: "none" | "first";
}

export interface StartupConfig {
	/** Auto-open welcome tab on host connect. Default: true */
	autoOpenWelcome?: boolean;
}

export interface TitleConfig {
	/** Title source: 'dynamic' uses OSC 0/2, 'static' uses a fixed user-configured title, 'process' polls the foreground process name. Default: 'dynamic'. */
	source?: "dynamic" | "static" | "process";
	/** Fixed title shown when source = "static". */
	staticTitle?: string;
	/** Maximum display length for tab titles. Default: 50. */
	maxLength?: number;
	/** Where to place the ellipsis when truncating. Default: 'end'. */
	truncation?: "end" | "middle" | "start";
	/** Per-host title prefix (global default; per-host overrides via host profile). */
	prefix?: string;
	/** Whether to update the browser window/tab title. Default: true. */
	windowTitle?: boolean;
	/** Format string for the browser window title. Default: 'lasterm - {prefix}{host} - {title}'. */
	windowFormat?: string;
}

export interface SearchConfig {
	position?: "top-right" | "bottom-right" | "bottom-bar";
	highlightOnClose?: "clear" | "fade" | "persist";
	scrollbarMarkers?: boolean;
	historySize?: number;
}

export interface HostRailConfig {
	width?: number;
	showLabels?: boolean;
	showStatusDot?: boolean;
}

export interface HostsDefaultsConfig {
	defaultShell?: string;
	keepAliveSeconds?: number;
	historyRetentionDays?: number;
}

// ---------------------------------------------------------------------------
// Notification configuration
// ---------------------------------------------------------------------------

export type ScrollMode = "auto" | "alwaysBottom" | "alwaysResume";
export type BellSound = "system" | "custom" | "mute";

export interface NotificationConfig {
	desktopNotifications?: boolean;
	groupingWindowMs?: number;
	activity?: {
		enabled?: boolean;
		minLines?: number;
		debounceMs?: number;
	};
	bell?: {
		enabled?: boolean;
		sound?: BellSound;
		customSoundFile?: string;
		desktopNotification?: boolean;
	};
	osc9?: {
		enabled?: boolean;
		desktopNotification?: boolean;
	};
	scroll?: {
		mode?: ScrollMode;
		autoThreshold?: number;
	};
}

export const DEFAULT_NOTIFICATION_CONFIG: Required<
	Pick<NotificationConfig, "desktopNotifications" | "groupingWindowMs">
> & {
	activity: Required<NonNullable<NotificationConfig["activity"]>>;
	bell: Required<NonNullable<NotificationConfig["bell"]>>;
	osc9: Required<NonNullable<NotificationConfig["osc9"]>>;
	scroll: Required<NonNullable<NotificationConfig["scroll"]>>;
} = {
	desktopNotifications: true,
	groupingWindowMs: 5000,
	activity: {
		enabled: true,
		minLines: 1,
		debounceMs: 500,
	},
	bell: {
		enabled: true,
		sound: "system",
		customSoundFile: "",
		desktopNotification: true,
	},
	osc9: {
		enabled: true,
		desktopNotification: true,
	},
	scroll: {
		mode: "auto",
		autoThreshold: 100,
	},
};

// ---------------------------------------------------------------------------
// Visual profile types (UX-07)
// ---------------------------------------------------------------------------

export type VisualPreset = "none" | "caution" | "danger" | "custom";
export type BorderStyle = "none" | "subtle" | "strong";

export interface VisualProfile {
	preset: VisualPreset;
	banner: {
		enabled: boolean;
		text: string;
		bgColor: string;
		textColor: string;
	};
	border: {
		style: BorderStyle;
		color: string;
	};
	tint: {
		enabled: boolean;
		color: string;
		opacity: number;
	};
}

/** Layer 1 built-in defaults for the terminal profile cascade. */
export const DEFAULT_PROFILE: TerminalProfile = {
	fontFamily: '"Consolas", "Liberation Mono", "Courier New", monospace',
	fontSize: 14,
	theme: "catppuccin-mocha",
	cursorStyle: "block",
	scrollback: 5000,
	bellSound: "mute" as BellSound,
	bellBadge: true,
	scrollbarMarkers: true,
	wallpaper: "",
	wallpaperBlur: 0,
	wallpaperDim: 0,
	backgroundMode: "image",
	windowEffect: "none",
	envMode: "inherit",
};

// ─── UI behavioral config (combined) ─────────────────────────────────────────

/** Persisted layout dimensions for resizable panels. */
export interface LayoutConfig {
	/** Host rail width in pixels. Default: 48. */
	hostRailWidth: number;
	/** Channel sidebar width in pixels. 0 means collapsed. Default: 200. */
	sidebarWidth: number;
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
	hostRailWidth: 48,
	sidebarWidth: 200,
};

/** UI behavioral configuration (from [ui], [tabs], [panes], [channels], [startup], [title], [search], [layout] in config.toml). */
export interface UiConfig {
	/** What to do when a channel dies: "close" the tab or keep it "readonly". Default: "readonly". */
	onChannelDead: "close" | "readonly";
	/** Tab behavior configuration. */
	tabs: TabsConfig;
	/** Pane behavior configuration. */
	panes: PanesConfig;
	/** Channel defaults configuration. */
	channels: ChannelsConfig;
	/** Startup behavior configuration. */
	startup: StartupConfig;
	/** Terminal title configuration. */
	title: TitleConfig;
	/** Search behavior configuration. */
	search: SearchConfig;
	/** Persisted panel layout dimensions. */
	layout: LayoutConfig;
}

// ─── Cascade endpoint response ────────────────────────────────────────────────

export interface CascadeResponse {
	terminal: {
		defaults: TerminalProfile;
		global: Partial<TerminalProfile>;
		host?: Partial<TerminalProfile>;
		channel?: Partial<TerminalProfile>;
		resolved: TerminalProfile;
	};
	ui: {
		defaults: UiConfig;
		global: Partial<UiConfig>;
		resolved: UiConfig;
	};
	appearance: AppearanceConfig;
	elevation: ElevationConfig;
}

// ─── Key whitelists for config write-back validation ──────────────────────────

export const TERMINAL_PROFILE_KEYS = [
	"fontFamily",
	"fontSize",
	"theme",
	"themeOverrides",
	"cursorStyle",
	"scrollback",
	"bellSound",
	"bellCustomFile",
	"bellBadge",
	"scrollbarMarkers",
	"wallpaper",
	"wallpaperBlur",
	"wallpaperDim",
	"backgroundMode",
	"windowEffect",
] as const;

export const MAX_WALLPAPER_BLUR = 20;
export const MAX_WALLPAPER_SIZE = 10 * 1024 * 1024; // 10 MB
export const WALLPAPER_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif"];

export const UI_CONFIG_SECTIONS = [
	"tabs",
	"panes",
	"channels",
	"startup",
	"title",
	"search",
	"layout",
] as const;

/** Per-section key whitelists — derived from the TypeScript interfaces above. */
export const TABS_CONFIG_KEYS = [
	"closeButton",
	"newTabPosition",
	"confirmCloseAll",
	"confirmCloseOthers",
] as const;

export const PANES_CONFIG_KEYS = ["maxPanes", "defaultSplitDirection"] as const;

export const CHANNELS_CONFIG_KEYS = ["defaultShell", "defaultGroupName", "autoGroup"] as const;

export const STARTUP_CONFIG_KEYS = ["autoOpenWelcome"] as const;

export const TITLE_CONFIG_KEYS = [
	"source",
	"staticTitle",
	"maxLength",
	"truncation",
	"prefix",
	"windowTitle",
	"windowFormat",
] as const;

export const SEARCH_CONFIG_KEYS = [
	"position",
	"highlightOnClose",
	"scrollbarMarkers",
	"historySize",
] as const;

export const LAYOUT_CONFIG_KEYS = ["hostRailWidth", "sidebarWidth"] as const;

/** Map from UI section name to its allowed keys. */
export const UI_SECTION_KEYS: Record<string, readonly string[]> = {
	tabs: TABS_CONFIG_KEYS,
	panes: PANES_CONFIG_KEYS,
	channels: CHANNELS_CONFIG_KEYS,
	startup: STARTUP_CONFIG_KEYS,
	title: TITLE_CONFIG_KEYS,
	search: SEARCH_CONFIG_KEYS,
	layout: LAYOUT_CONFIG_KEYS,
};

export interface ElevationConfig {
	methodLinux: ElevationMethod;
	methodDarwin: ElevationMethod;
	methodWindows: ElevationMethod;
	customCommandLinux?: string;
	customCommandDarwin?: string;
	customCommandWindows?: string;
}

export const DEFAULT_ELEVATION_CONFIG: ElevationConfig = {
	methodLinux: "sudo",
	methodDarwin: "sudo",
	methodWindows: "gsudo",
};

export const ELEVATION_CONFIG_KEYS = [
	"methodLinux",
	"methodDarwin",
	"methodWindows",
	"customCommandLinux",
	"customCommandDarwin",
	"customCommandWindows",
] as const;

// ─── Server configuration ────────────────────────────────────────────────────

/** TLS material supplied by an operator through [server] in config.toml. */
export type TlsConfig =
	| {
			certificatePath: string;
			keyPath: string;
	  }
	| {
			certificatePath?: never;
			keyPath?: never;
	  };

/** Server-level configuration (from [server] in config.toml). */
export interface ServerConfig {
	/**
	 * Allowed CORS origins (glob patterns, * matches port numbers).
	 * Defaults to localhost + 127.0.0.1 + Tauri origins.
	 */
	corsOrigins?: string[];
	/** A certificate/key pair. Omitting both selects the generated local identity. */
	tls?: TlsConfig;
}
