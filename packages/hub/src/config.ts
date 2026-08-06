/**
 * ConfigResolver — implements the 4-layer terminal profile config cascade.
 *
 * Layer 1: DEFAULT_PROFILE (built-in defaults)
 * Layer 2: config.toml [terminal] section (loaded from XDG config dir)
 * Layer 3: host.profile_json (per-host overrides from meta.db)
 * Layer 3.5: agent visual hints (from HELLO message, ephemeral, keyed by sessionId)
 * Layer 4: channel.profile_json (per-channel overrides from meta.db)
 *
 * Also parses the [gc] section for spool garbage collector configuration.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";
import type {
	AgentConfig,
	AppearanceConfig,
	CascadeResponse,
	ChannelsConfig,
	ElevationConfig,
	ElevationMethod,
	LayoutConfig,
	LogConfig,
	PanesConfig,
	SearchConfig,
	StartupConfig,
	TabsConfig,
	TerminalProfile,
	TitleConfig,
	UiConfig,
} from "@lasterm/shared";
import {
	DEFAULT_AGENT_CONFIG,
	DEFAULT_APPEARANCE,
	DEFAULT_ELEVATION_CONFIG,
	DEFAULT_LAYOUT_CONFIG,
	DEFAULT_PROFILE,
	deepMerge,
	ELEVATION_METHODS_DARWIN,
	ELEVATION_METHODS_LINUX,
	ELEVATION_METHODS_WINDOWS,
	parseAgentConfig,
	TERMINAL_PROFILE_KEYS,
	UI_CONFIG_SECTIONS,
	validateCustomCommand,
} from "@lasterm/shared";
import { edit, initSync } from "@rainbowatcher/toml-edit-js";
import type { MetaDAL } from "./storage/meta.js";

// Initialize toml-edit-js WASM (sync — called once at module load)
// In SEA mode the WASM file is not on disk — load it from the embedded asset.
// In normal (dev) mode, fall through to the no-arg initSync() which resolves
// the file from node_modules via the URL embedded in index.js.
function _loadTomlWasm(): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const sea = require("node:sea") as {
			isSea?: () => boolean;
			getRawAsset?: (name: string) => ArrayBuffer;
		};
		if (typeof sea.isSea === "function" && sea.isSea() && typeof sea.getRawAsset === "function") {
			const wasmBuffer = sea.getRawAsset("toml_edit.wasm");
			initSync(new WebAssembly.Module(wasmBuffer));
			return;
		}
	} catch {
		// node:sea not available (older Node build) — fall through
	}
	// Dev / non-SEA path: initSync() with no args loads the WASM file from
	// node_modules relative to index.js using a preloaded URL stub.
	// The esbuild tomlEditShimPlugin stubs out the .wasm import so the bundle
	// remains loadable; the actual WASM bytes come from the SEA asset above.
	initSync();
}
_loadTomlWasm();

// ─── GC configuration ──────────────────────────────────────────────────────────

/** Spool garbage collector configuration (from [gc] in config.toml). */
export interface GcConfig {
	/** Hours before dead channel spool data is purged (0 = immediate). Default: 24. */
	deadRetentionHours: number;
	/** Max spool size per channel in MB. Default: 10. */
	maxSizePerChannelMb: number;
}

export const DEFAULT_GC_CONFIG: GcConfig = {
	deadRetentionHours: 24,
	maxSizePerChannelMb: 10,
};

/**
 * Extract GcConfig from a parsed TOML map's [gc] section.
 * Returns a new GcConfig with defaults overridden by any valid values found.
 */
function extractGcConfig(parsed: TOML.JsonMap): GcConfig {
	const config: GcConfig = { ...DEFAULT_GC_CONFIG };
	const gcSection = parsed.gc;
	if (gcSection != null && typeof gcSection === "object") {
		const gcRaw = gcSection as Record<string, unknown>;
		if (typeof gcRaw.dead_retention_hours === "number") {
			config.deadRetentionHours = Math.max(0, gcRaw.dead_retention_hours);
		}
		if (typeof gcRaw.max_size_per_channel_mb === "number") {
			config.maxSizePerChannelMb = Math.max(0, gcRaw.max_size_per_channel_mb);
		}
	}
	return config;
}

/**
 * Standalone loader: parse the [gc] section from config.toml and return a GcConfig.
 * Returns defaults if the file is missing, malformed, or has no [gc] section.
 * Used by server.ts to provide GC config before SessionManager is created.
 */
export function loadGcConfig(configDir: string): GcConfig {
	const configPath = join(configDir, "config.toml");
	if (!existsSync(configPath)) return { ...DEFAULT_GC_CONFIG };

	try {
		const content = readFileSync(configPath, "utf8");
		return extractGcConfig(TOML.parse(content));
	} catch {
		return { ...DEFAULT_GC_CONFIG };
	}
}

/**
 * Standalone loader: parse the [server] cors_origins from config.toml.
 * Returns DEFAULT_CORS_ORIGINS if the file is missing, malformed, or has no entry.
 * Used by server.ts to compile CORS regexps before any route registration.
 */
export function loadCorsOrigins(configDir: string): string[] {
	const configPath = join(configDir, "config.toml");
	if (!existsSync(configPath)) return [...DEFAULT_CORS_ORIGINS];

	try {
		const content = readFileSync(configPath, "utf8");
		return extractCorsConfig(TOML.parse(content)) ?? [...DEFAULT_CORS_ORIGINS];
	} catch {
		return [...DEFAULT_CORS_ORIGINS];
	}
}

// ─── UI configuration ───────────────────────────────────────────────────────

// UiConfig interface is now in @lasterm/shared — re-exported here for backward compat
export type { UiConfig } from "@lasterm/shared";

export const DEFAULT_TABS_CONFIG: TabsConfig = {
	closeButton: true,
	newTabPosition: "end",
	confirmCloseAll: true,
	confirmCloseOthers: true,
};

export const DEFAULT_PANES_CONFIG: PanesConfig = {
	maxPanes: 4,
	defaultSplitDirection: "horizontal",
};

export const DEFAULT_CHANNELS_CONFIG: ChannelsConfig = {
	defaultGroupName: "General",
	autoGroup: "none",
};

export const DEFAULT_STARTUP_CONFIG: StartupConfig = {
	autoOpenWelcome: true,
};

export const DEFAULT_TITLE_CONFIG: TitleConfig = {
	source: "dynamic",
	maxLength: 50,
	truncation: "end",
	windowTitle: true,
	windowFormat: "lasterm - {prefix}{host} - {title}",
};

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
	position: "top-right",
	highlightOnClose: "clear",
	scrollbarMarkers: true,
	historySize: 20,
};

export type { LayoutConfig };
export { DEFAULT_LAYOUT_CONFIG };

export const DEFAULT_UI_CONFIG: UiConfig = {
	onChannelDead: "readonly",
	tabs: { ...DEFAULT_TABS_CONFIG },
	panes: { ...DEFAULT_PANES_CONFIG },
	channels: { ...DEFAULT_CHANNELS_CONFIG },
	startup: { ...DEFAULT_STARTUP_CONFIG },
	title: { ...DEFAULT_TITLE_CONFIG },
	search: { ...DEFAULT_SEARCH_CONFIG },
	layout: { ...DEFAULT_LAYOUT_CONFIG },
};

/**
 * Extract UiConfig from a parsed TOML map's [ui] section.
 * Returns a new UiConfig with defaults overridden by any valid values found.
 */
export function extractUiConfig(parsed: TOML.JsonMap): UiConfig {
	const config: UiConfig = {
		...DEFAULT_UI_CONFIG,
		tabs: { ...DEFAULT_TABS_CONFIG },
		panes: { ...DEFAULT_PANES_CONFIG },
		channels: { ...DEFAULT_CHANNELS_CONFIG },
		startup: { ...DEFAULT_STARTUP_CONFIG },
		title: { ...DEFAULT_TITLE_CONFIG },
		search: { ...DEFAULT_SEARCH_CONFIG },
		layout: { ...DEFAULT_LAYOUT_CONFIG },
	};

	// ── [ui] section ────────────────────────────────────────────────────
	const uiSection = parsed.ui;
	if (uiSection != null && typeof uiSection === "object") {
		const uiRaw = uiSection as Record<string, unknown>;
		if (
			typeof uiRaw.on_channel_dead === "string" &&
			(uiRaw.on_channel_dead === "close" || uiRaw.on_channel_dead === "readonly")
		) {
			config.onChannelDead = uiRaw.on_channel_dead;
		}
	}

	// ── [tabs] section ──────────────────────────────────────────────────
	const tabsSection = parsed.tabs;
	if (tabsSection != null && typeof tabsSection === "object") {
		const raw = tabsSection as Record<string, unknown>;
		if (typeof raw.close_button === "boolean") {
			config.tabs.closeButton = raw.close_button;
		}
		if (
			typeof raw.new_tab_position === "string" &&
			(raw.new_tab_position === "end" || raw.new_tab_position === "afterActive")
		) {
			config.tabs.newTabPosition = raw.new_tab_position;
		}
		if (typeof raw.confirm_close_all === "boolean") {
			config.tabs.confirmCloseAll = raw.confirm_close_all;
		}
		if (typeof raw.confirm_close_others === "boolean") {
			config.tabs.confirmCloseOthers = raw.confirm_close_others;
		}
	}

	// ── [panes] section ─────────────────────────────────────────────────
	const panesSection = parsed.panes;
	if (panesSection != null && typeof panesSection === "object") {
		const raw = panesSection as Record<string, unknown>;
		if (typeof raw.max_panes === "number" && raw.max_panes >= 1) {
			config.panes.maxPanes = raw.max_panes;
		}
		if (
			typeof raw.default_split_direction === "string" &&
			(raw.default_split_direction === "horizontal" || raw.default_split_direction === "vertical")
		) {
			config.panes.defaultSplitDirection = raw.default_split_direction;
		}
	}

	// ── [channels] section ──────────────────────────────────────────────
	const channelsSection = parsed.channels;
	if (channelsSection != null && typeof channelsSection === "object") {
		const raw = channelsSection as Record<string, unknown>;
		if (typeof raw.default_shell === "string") {
			config.channels.defaultShell = raw.default_shell;
		}
		if (typeof raw.default_group_name === "string" && raw.default_group_name.length > 0) {
			config.channels.defaultGroupName = raw.default_group_name;
		}
		if (
			typeof raw.auto_group === "string" &&
			(raw.auto_group === "none" || raw.auto_group === "first")
		) {
			config.channels.autoGroup = raw.auto_group;
		}
	}

	// ── [startup] section ───────────────────────────────────────────────
	const startupSection = parsed.startup;
	if (startupSection != null && typeof startupSection === "object") {
		const raw = startupSection as Record<string, unknown>;
		if (typeof raw.auto_open_welcome === "boolean") {
			config.startup.autoOpenWelcome = raw.auto_open_welcome;
		}
	}

	// ── [title] section ─────────────────────────────────────────────────
	const titleSection = parsed.title;
	if (titleSection != null && typeof titleSection === "object") {
		const raw = titleSection as Record<string, unknown>;
		if (
			typeof raw.source === "string" &&
			(raw.source === "dynamic" || raw.source === "static" || raw.source === "process")
		) {
			config.title.source = raw.source;
		}
		if (typeof raw.static_title === "string") {
			config.title.staticTitle = raw.static_title;
		}
		if (typeof raw.max_length === "number" && raw.max_length >= 1) {
			config.title.maxLength = raw.max_length;
		}
		if (
			typeof raw.truncation === "string" &&
			(raw.truncation === "end" || raw.truncation === "middle" || raw.truncation === "start")
		) {
			config.title.truncation = raw.truncation;
		}
		if (typeof raw.prefix === "string") {
			config.title.prefix = raw.prefix;
		}
		if (typeof raw.window_title === "boolean") {
			config.title.windowTitle = raw.window_title;
		}
		if (typeof raw.window_format === "string") {
			config.title.windowFormat = raw.window_format;
		}
	}

	// ── [search] section ────────────────────────────────────────────────
	const searchSection = parsed.search;
	if (searchSection != null && typeof searchSection === "object") {
		const raw = searchSection as Record<string, unknown>;
		if (
			typeof raw.position === "string" &&
			(raw.position === "top-right" ||
				raw.position === "bottom-right" ||
				raw.position === "bottom-bar")
		) {
			config.search.position = raw.position;
		}
		if (
			typeof raw.highlight_on_close === "string" &&
			(raw.highlight_on_close === "clear" ||
				raw.highlight_on_close === "fade" ||
				raw.highlight_on_close === "persist")
		) {
			config.search.highlightOnClose = raw.highlight_on_close;
		}
		if (typeof raw.scrollbar_markers === "boolean") {
			config.search.scrollbarMarkers = raw.scrollbar_markers;
		}
		if (typeof raw.history_size === "number" && raw.history_size >= 1) {
			config.search.historySize = raw.history_size;
		}
	}

	// ── [layout] section ────────────────────────────────────────────────
	const layoutSection = parsed.layout;
	if (layoutSection != null && typeof layoutSection === "object") {
		const raw = layoutSection as Record<string, unknown>;
		if (typeof raw.host_rail_width === "number" && raw.host_rail_width >= 0) {
			config.layout.hostRailWidth = raw.host_rail_width;
		}
		if (typeof raw.sidebar_width === "number" && raw.sidebar_width >= 0) {
			config.layout.sidebarWidth = raw.sidebar_width;
		}
	}

	return config;
}

/**
 * Standalone loader: parse the [ui] section from config.toml and return a UiConfig.
 * Returns defaults if the file is missing, malformed, or has no [ui] section.
 */
export function loadUiConfig(configDir: string): UiConfig {
	const configPath = join(configDir, "config.toml");
	if (!existsSync(configPath)) return { ...DEFAULT_UI_CONFIG };

	try {
		const content = readFileSync(configPath, "utf8");
		return extractUiConfig(TOML.parse(content));
	} catch {
		return { ...DEFAULT_UI_CONFIG };
	}
}

// ─── TOML snake_case → camelCase ─────────────────────────────────────────────

/**
 * Convert a snake_case TOML key to camelCase.
 * Only shallow keys in the [terminal] section need conversion.
 */
function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Convert a flat object with snake_case keys (from TOML) to camelCase.
 * Nested objects (e.g. theme_overrides) are handled by remapping the key
 * and preserving the object value as-is.
 */
function _tomlSectionToProfile(section: Record<string, unknown>): Partial<TerminalProfile> {
	const result: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(section)) {
		result[snakeToCamel(key)] = val;
	}
	return result as Partial<TerminalProfile>;
}

// ─── camelCase ↔ snake_case helpers ───────────────────────────────────────────

/** Convert a camelCase key to snake_case for config.toml. */
function camelToSnake(s: string): string {
	return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

// ─── Appearance config extraction ────────────────────────────────────────────

/** Extract AppearanceConfig from a parsed TOML map's [appearance] section. */
export function extractAppearanceConfig(parsed: TOML.JsonMap): AppearanceConfig {
	const config: AppearanceConfig = {
		theme: DEFAULT_APPEARANCE.theme,
		autoSwitch: { ...DEFAULT_APPEARANCE.autoSwitch },
		opacity: { ...DEFAULT_APPEARANCE.opacity },
		scrollbar: { ...DEFAULT_APPEARANCE.scrollbar },
	};

	const section = parsed.appearance;
	if (section == null || typeof section !== "object") return config;
	const raw = section as Record<string, unknown>;

	if (typeof raw.theme === "string") {
		config.theme = raw.theme;
	}

	// [appearance.auto_switch]
	const autoSwitch = raw.auto_switch;
	if (autoSwitch != null && typeof autoSwitch === "object") {
		const as = autoSwitch as Record<string, unknown>;
		if (typeof as.enabled === "boolean") config.autoSwitch.enabled = as.enabled;
		if (typeof as.dark_theme === "string") config.autoSwitch.darkTheme = as.dark_theme;
		if (typeof as.light_theme === "string") config.autoSwitch.lightTheme = as.light_theme;
	}

	// [appearance.opacity]
	const opacity = raw.opacity;
	if (opacity != null && typeof opacity === "object") {
		const op = opacity as Record<string, unknown>;
		if (typeof op.terminal === "number") config.opacity.terminal = op.terminal;
		if (typeof op.sidebar === "number") config.opacity.sidebar = op.sidebar;
		if (typeof op.host_rail === "number") config.opacity.hostRail = op.host_rail;
		if (typeof op.tab_bar === "number") config.opacity.tabBar = op.tab_bar;
	}

	// [appearance.scrollbar]
	const scrollbar = raw.scrollbar;
	if (scrollbar != null && typeof scrollbar === "object") {
		const sb = scrollbar as Record<string, unknown>;
		if (
			typeof sb.style === "string" &&
			(sb.style === "thin" || sb.style === "wide" || sb.style === "hidden")
		) {
			config.scrollbar.style = sb.style;
		}
		if (typeof sb.thumb_color === "string") config.scrollbar.thumbColor = sb.thumb_color;
		if (typeof sb.track_color === "string") config.scrollbar.trackColor = sb.track_color;
		if (typeof sb.width_thin === "number") config.scrollbar.widthThin = sb.width_thin;
		if (typeof sb.width_wide === "number") config.scrollbar.widthWide = sb.width_wide;
	}

	return config;
}

/** Extract ElevationConfig from a parsed TOML map's [elevation] section. */
export function extractElevationConfig(parsed: TOML.JsonMap): Partial<ElevationConfig> {
	const result: Partial<ElevationConfig> = {};

	const section = parsed.elevation;
	if (section == null || typeof section !== "object") return result;
	const raw = section as Record<string, unknown>;

	if (
		typeof raw.method_linux === "string" &&
		(ELEVATION_METHODS_LINUX as readonly string[]).includes(raw.method_linux)
	) {
		result.methodLinux = raw.method_linux as ElevationMethod;
	}
	if (
		typeof raw.method_darwin === "string" &&
		(ELEVATION_METHODS_DARWIN as readonly string[]).includes(raw.method_darwin)
	) {
		result.methodDarwin = raw.method_darwin as ElevationMethod;
	}
	if (
		typeof raw.method_windows === "string" &&
		(ELEVATION_METHODS_WINDOWS as readonly string[]).includes(raw.method_windows)
	) {
		result.methodWindows = raw.method_windows as ElevationMethod;
	}
	if (typeof raw.custom_command_linux === "string" && raw.custom_command_linux.length > 0) {
		try {
			validateCustomCommand(raw.custom_command_linux);
			result.customCommandLinux = raw.custom_command_linux;
		} catch {
			process.stderr.write(
				`[config] elevation.custom_command_linux is invalid — ignoring: "${raw.custom_command_linux}"\n`,
			);
		}
	}
	if (typeof raw.custom_command_darwin === "string" && raw.custom_command_darwin.length > 0) {
		try {
			validateCustomCommand(raw.custom_command_darwin);
			result.customCommandDarwin = raw.custom_command_darwin;
		} catch {
			process.stderr.write(
				`[config] elevation.custom_command_darwin is invalid — ignoring: "${raw.custom_command_darwin}"\n`,
			);
		}
	}
	if (typeof raw.custom_command_windows === "string" && raw.custom_command_windows.length > 0) {
		try {
			validateCustomCommand(raw.custom_command_windows);
			result.customCommandWindows = raw.custom_command_windows;
		} catch {
			process.stderr.write(
				`[config] elevation.custom_command_windows is invalid — ignoring: "${raw.custom_command_windows}"\n`,
			);
		}
	}

	return result;
}

// ─── CORS configuration ──────────────────────────────────────────────────────

/**
 * Default allowed CORS origins.
 * Patterns may contain `*` to match port numbers (e.g. `http://localhost:*`).
 */
/**
 * Default allowed CORS origins (exact strings, no wildcards).
 * Only Tauri desktop origins are included by default.
 * Exact localhost origins are injected at runtime once the actual port is known.
 * User-defined origins from config.toml [server] cors_origins are added on top.
 */
export const DEFAULT_CORS_ORIGINS: string[] = ["tauri://localhost", "http://tauri.localhost"];

/**
 * Convert an array of origin patterns into compiled RegExp objects.
 *
 * Rules:
 * - All regex-special characters are escaped, EXCEPT `*`
 * - `*` is replaced with `\\d+` (matches a sequence of digits — port numbers)
 * - Anchored with `^...$` for strict matching
 *
 * Security: `localhost:*` must NOT match `localhost.evil.com:8080`.
 * This is guaranteed because we only replace bare `*` (i.e. digit sequences),
 * and the surrounding characters (`:` before `*`, end-of-string or nothing after)
 * are preserved literally in the escaped pattern.
 */
export function corsOriginsToRegexps(patterns: string[]): RegExp[] {
	return patterns.map((pattern) => {
		// Escape all regex special chars except '*' (includes '-' for char-class safety)
		const escaped = pattern.replace(/[$()+.?[\\\]^{|}-]/g, "\\$&");
		// Replace '*' with '\d+' — only matches numeric port sequences
		const withPort = escaped.replace(/\*/g, "\\d+");
		return new RegExp(`^${withPort}$`);
	});
}

/**
 * Test whether an origin string matches any of the compiled regexp patterns.
 */
export function matchCorsOrigin(origin: string, regexps: RegExp[]): boolean {
	return regexps.some((re) => re.test(origin));
}

/**
 * Extract the CORS origins list from a parsed TOML map's [server] section.
 * Returns undefined if the section or key is absent (caller uses the default).
 */
export function extractCorsConfig(parsed: TOML.JsonMap): string[] | undefined {
	const section = parsed.server;
	if (section == null || typeof section !== "object") return undefined;
	const raw = section as Record<string, unknown>;

	if (Array.isArray(raw.cors_origins) && raw.cors_origins.every((v) => typeof v === "string")) {
		return raw.cors_origins as string[];
	}
	return undefined;
}

// ─── Auth config ─────────────────────────────────────────────────────────────

export interface AuthConfig {
	/** Days until a pairing-created token expires (sliding window). 0 = never. */
	tokenTtlDays: number;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
	tokenTtlDays: 90,
};

/**
 * Extract AuthConfig from a parsed TOML map's [auth] section.
 * Returns defaults if the section is absent or malformed.
 */
export function extractAuthConfig(parsed: TOML.JsonMap): AuthConfig {
	const config: AuthConfig = { ...DEFAULT_AUTH_CONFIG };
	const section = parsed.auth;
	if (section != null && typeof section === "object") {
		const raw = section as Record<string, unknown>;
		if (typeof raw.token_ttl_days === "number") {
			config.tokenTtlDays = Math.max(0, raw.token_ttl_days);
		}
	}
	return config;
}

// ─── Logging config ───────────────────────────────────────────────────────────

export const DEFAULT_LOG_CONFIG: LogConfig = {
	level: "info",
	format: "jsonl",
	output: "file",
	maxAgeDays: 30,
	maxSizeMb: 50,
};

/**
 * Extract LogConfig from a parsed TOML map's [logging] section.
 * Returns defaults for any missing or invalid values.
 */
export function extractLogConfig(parsed: TOML.JsonMap): LogConfig {
	const config: LogConfig = { ...DEFAULT_LOG_CONFIG };
	const section = parsed.logging;
	if (section != null && typeof section === "object") {
		const raw = section as Record<string, unknown>;
		if (
			raw.level === "trace" ||
			raw.level === "debug" ||
			raw.level === "info" ||
			raw.level === "warn" ||
			raw.level === "error"
		) {
			config.level = raw.level;
		}
		if (raw.format === "text" || raw.format === "jsonl") {
			config.format = raw.format;
		}
		if (raw.output === "stderr" || raw.output === "file" || raw.output === "both") {
			config.output = raw.output;
		}
		if (typeof raw.max_age_days === "number") {
			config.maxAgeDays = Math.max(0, raw.max_age_days);
		}
		if (typeof raw.max_size_mb === "number") {
			config.maxSizeMb = Math.max(0, raw.max_size_mb);
		}
	}
	return config;
}

/**
 * Extract AgentConfig from parsed TOML. Daemon-specific knobs still live under
 * [agent], but log level/format come from the shared [logging] contract.
 */
export function extractAgentConfig(parsed: TOML.JsonMap): AgentConfig {
	const section = parsed.agent;
	const agentSection =
		section != null && typeof section === "object"
			? (section as Record<string, unknown>)
			: undefined;
	const logging = extractLogConfig(parsed);

	return {
		...parseAgentConfig(agentSection),
		logLevel: logging.level,
		logFormat: logging.format,
	};
}

/**
 * Standalone loader: parse the [auth] section from config.toml and return an AuthConfig.
 * Returns defaults if the file is missing, malformed, or has no [auth] section.
 */
export function loadAuthConfig(configDir: string): AuthConfig {
	const configPath = join(configDir, "config.toml");
	if (!existsSync(configPath)) return { ...DEFAULT_AUTH_CONFIG };

	try {
		const content = readFileSync(configPath, "utf8");
		return extractAuthConfig(TOML.parse(content));
	} catch {
		return { ...DEFAULT_AUTH_CONFIG };
	}
}

// ─── ConfigResolver ──────────────────────────────────────────────────────────

export class ConfigResolver {
	private fileConfig: Partial<TerminalProfile> | null = null;
	private agentHints = new Map<string, Partial<TerminalProfile>>();
	private _gcConfig: GcConfig = { ...DEFAULT_GC_CONFIG };
	private _uiConfig: UiConfig = { ...DEFAULT_UI_CONFIG };
	private _appearance: AppearanceConfig = { ...DEFAULT_APPEARANCE };
	private _elevation: ElevationConfig = { ...DEFAULT_ELEVATION_CONFIG };
	private _corsOrigins: string[] = [...DEFAULT_CORS_ORIGINS];
	private _logConfig: LogConfig = { ...DEFAULT_LOG_CONFIG };
	private _agentConfig: AgentConfig = { ...DEFAULT_AGENT_CONFIG };
	private _configDir: string | null = null;

	constructor(private metaDal: MetaDAL) {}

	/** Returns the resolved GC configuration (defaults merged with [gc] from config.toml). */
	get gcConfig(): GcConfig {
		return this._gcConfig;
	}

	/** Returns the resolved UI configuration (defaults merged with [ui] from config.toml). */
	get uiConfig(): UiConfig {
		return this._uiConfig;
	}

	/** Returns the resolved appearance configuration (defaults merged with [appearance] from config.toml). */
	get appearance(): AppearanceConfig {
		return this._appearance;
	}

	/** Returns the resolved elevation configuration (defaults merged with [elevation] from config.toml). */
	get elevationConfig(): ElevationConfig {
		return this._elevation;
	}

	/** Returns the resolved CORS origin patterns (defaults or [server] cors_origins from config.toml). */
	get corsOrigins(): string[] {
		return this._corsOrigins;
	}

	/** Returns the resolved logging configuration (defaults merged with [logging] from config.toml). */
	get logConfig(): LogConfig {
		return this._logConfig;
	}

	/** Returns the resolved local agent daemon configuration. */
	get agentConfig(): AgentConfig {
		return this._agentConfig;
	}

	/**
	 * Load [terminal], [gc], [ui], [tabs], [panes], [channels], [startup], [title], [search],
	 * and [appearance] sections from config.toml at the given config directory.
	 * Silently no-ops if the file does not exist or is malformed.
	 */
	loadFromFile(configDir: string): void {
		this._configDir = configDir;
		const configPath = join(configDir, "config.toml");
		if (!existsSync(configPath)) return;

		let parsed: TOML.JsonMap;
		try {
			const content = readFileSync(configPath, "utf8");
			parsed = TOML.parse(content);
		} catch {
			// Malformed TOML — skip silently (do not crash the hub)
			return;
		}

		// ── [terminal] section ──────────────────────────────────────────────
		const terminalSection = parsed.terminal;
		if (terminalSection != null && typeof terminalSection === "object") {
			// Separate nested theme_overrides from flat keys
			const flat: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(terminalSection as Record<string, unknown>)) {
				if (key === "theme_overrides" && val !== null && typeof val === "object") {
					flat.themeOverrides = val as Record<string, string>;
				} else {
					flat[snakeToCamel(key)] = val;
				}
			}

			this.fileConfig = flat as Partial<TerminalProfile>;
		}

		// ── [gc] section ────────────────────────────────────────────────────
		this._gcConfig = extractGcConfig(parsed);

		// ── [ui] section ────────────────────────────────────────────────────
		this._uiConfig = extractUiConfig(parsed);

		// ── [appearance] section ────────────────────────────────────────────
		this._appearance = extractAppearanceConfig(parsed);

		// ── [elevation] section ────────────────────────────────────────────
		const elevationOverrides = extractElevationConfig(parsed);
		this._elevation = { ...DEFAULT_ELEVATION_CONFIG, ...elevationOverrides };

		// ── [server] cors_origins ───────────────────────────────────────────
		const corsOverride = extractCorsConfig(parsed);
		if (corsOverride !== undefined) {
			this._corsOrigins = corsOverride;
		} else {
			this._corsOrigins = [...DEFAULT_CORS_ORIGINS];
		}

		// ── [logging] section ───────────────────────────────────────────────
		this._logConfig = extractLogConfig(parsed);

		// ── [agent] section + shared [logging] section ─────────────────────
		this._agentConfig = extractAgentConfig(parsed);
	}

	/** Returns the Layer 2 terminal overrides from config.toml. */
	getGlobalTerminalOverrides(): Partial<TerminalProfile> {
		return this.fileConfig ?? {};
	}

	/** Returns only the UI config keys that differ from defaults (i.e. what was explicitly set). */
	getGlobalUiOverrides(): Partial<UiConfig> {
		const overrides: Record<string, unknown> = {};
		const current = this._uiConfig;
		const defaults = DEFAULT_UI_CONFIG;

		if (current.onChannelDead !== defaults.onChannelDead) {
			overrides.onChannelDead = current.onChannelDead;
		}

		for (const section of UI_CONFIG_SECTIONS) {
			const currentSection = current[section];
			const defaultSection = defaults[section];
			if (currentSection == null || defaultSection == null) continue;
			const diff: Record<string, unknown> = {};
			let hasDiff = false;
			for (const [key, val] of Object.entries(currentSection)) {
				if (val !== (defaultSection as Record<string, unknown>)[key]) {
					diff[key] = val;
					hasDiff = true;
				}
			}
			if (hasDiff) {
				overrides[section] = diff;
			}
		}

		return overrides as Partial<UiConfig>;
	}

	/** Returns the full cascade response for the settings panel. */
	getCascade(hostId?: string, channelId?: string): CascadeResponse {
		// Terminal layers
		const terminalDefaults = DEFAULT_PROFILE;
		const terminalGlobal = this.getGlobalTerminalOverrides();

		let hostLayer: Partial<TerminalProfile> | undefined;
		if (hostId) {
			const hostProfileRaw = this.metaDal.getHostProfile(hostId);
			if (hostProfileRaw) {
				try {
					hostLayer = JSON.parse(hostProfileRaw) as Partial<TerminalProfile>;
				} catch {
					// Invalid JSON — skip
				}
			}
		}

		let channelLayer: Partial<TerminalProfile> | undefined;
		if (channelId) {
			const channelProfileRaw = this.metaDal.getChannelProfile(channelId);
			if (channelProfileRaw) {
				try {
					channelLayer = JSON.parse(channelProfileRaw) as Partial<TerminalProfile>;
				} catch {
					// Invalid JSON — skip
				}
			}
		}

		// Resolved terminal = all layers merged (excluding L3.5 agent hints)
		const resolved = this.resolve(hostId, channelId);

		const response: CascadeResponse = {
			terminal: {
				defaults: terminalDefaults,
				global: terminalGlobal,
				resolved,
				...(hostLayer !== undefined && { host: hostLayer }),
				...(channelLayer !== undefined && { channel: channelLayer }),
			},
			ui: {
				defaults: DEFAULT_UI_CONFIG,
				global: this.getGlobalUiOverrides(),
				resolved: this._uiConfig,
			},
			appearance: this._appearance,
			elevation: { ...this._elevation },
		};

		return response;
	}

	/**
	 * Write a single key to a section in config.toml using comment-preserving editing.
	 * Creates the file if missing. A null value removes the key.
	 */
	async saveGlobalKey(section: string, key: string, value: unknown): Promise<void> {
		if (!this._configDir) {
			throw new Error("ConfigResolver: configDir not set — call loadFromFile() first");
		}

		const configPath = join(this._configDir, "config.toml");
		let tomlString = "";
		if (existsSync(configPath)) {
			tomlString = readFileSync(configPath, "utf8");
		}

		const snakeSection = section.split(".").map(camelToSnake).join(".");
		const snakeKey = camelToSnake(key);
		const path = `${snakeSection}.${snakeKey}`;

		// null = remove key (pass undefined to toml-edit)
		const editValue = value === null ? undefined : value;
		tomlString = edit(tomlString, path, editValue);

		// Ensure the config directory exists (may not exist on first run or in CI)
		mkdirSync(this._configDir, { recursive: true });

		// Atomic write: write to temp, then rename
		const tmpPath = `${configPath}.tmp`;
		writeFileSync(tmpPath, tomlString, "utf8");
		renameSync(tmpPath, configPath);

		// Reload to update in-memory state
		this.loadFromFile(this._configDir);
	}

	/** Write a terminal profile key to config.toml (validates against whitelist). */
	async saveGlobalTerminal(key: string, value: unknown): Promise<void> {
		if (!(TERMINAL_PROFILE_KEYS as readonly string[]).includes(key)) {
			throw new Error(`Unknown terminal key: ${key}`);
		}
		await this.saveGlobalKey("terminal", key, value);
	}

	/** Write a UI config key to config.toml (validates section against whitelist). */
	async saveGlobalUi(section: string, key: string, value: unknown): Promise<void> {
		if (!(UI_CONFIG_SECTIONS as readonly string[]).includes(section)) {
			throw new Error(`Unknown UI section: ${section}`);
		}
		await this.saveGlobalKey(section, key, value);
	}

	/**
	 * Resolve the elevation method to use for a spawn.
	 * Host-level setting wins; falls back to platform-appropriate global default.
	 */
	resolveElevationMethod(hostElevationMethod?: ElevationMethod | null): ElevationMethod {
		if (hostElevationMethod != null) return hostElevationMethod;
		if (process.platform === "win32") return this._elevation.methodWindows;
		if (process.platform === "darwin") return this._elevation.methodDarwin;
		return this._elevation.methodLinux;
	}

	/**
	 * Resolve the custom elevation command to use.
	 * Host-level command wins; falls back to global config.
	 */
	resolveCustomCommand(hostCustomCommand?: string | null): string | undefined {
		if (hostCustomCommand != null && hostCustomCommand.length > 0) return hostCustomCommand;
		const platform = process.platform;
		if (platform === "win32") return this._elevation.customCommandWindows;
		if (platform === "darwin") return this._elevation.customCommandDarwin;
		return this._elevation.customCommandLinux;
	}

	/**
	 * Store ephemeral visual hints sent by an agent in its HELLO message.
	 * Keyed by sessionId — replaced entirely on each HELLO.
	 */
	setAgentHints(sessionId: string, hints: Partial<TerminalProfile>): void {
		this.agentHints.set(sessionId, hints);
	}

	/**
	 * Remove agent hints for a session (call on session close).
	 */
	clearAgentHints(sessionId: string): void {
		this.agentHints.delete(sessionId);
	}

	/**
	 * Resolve the fully-merged terminal profile for a given host/channel context.
	 *
	 * Layer order (last wins):
	 *   1. DEFAULT_PROFILE
	 *   2. fileConfig (config.toml)
	 *   3. host profile_json
	 *   3.5. agent hints (session for the host, if known)
	 *   4. channel profile_json
	 */
	resolve(hostId?: string, channelId?: string, sessionId?: string): TerminalProfile {
		// Layer 1 — defaults
		let profile: TerminalProfile = deepMerge(DEFAULT_PROFILE);

		// Layer 2 — config.toml
		if (this.fileConfig) {
			profile = deepMerge(profile, this.fileConfig);
		}

		// Layer 3 — host profile_json
		if (hostId) {
			const hostProfileRaw = this.metaDal.getHostProfile(hostId);
			if (hostProfileRaw) {
				try {
					const hostProfile = JSON.parse(hostProfileRaw) as Partial<TerminalProfile>;
					profile = deepMerge(profile, hostProfile);
				} catch {
					// Invalid JSON — skip
				}
			}
		}

		// Layer 3.5 — agent hints
		if (sessionId) {
			const hints = this.agentHints.get(sessionId);
			if (hints) {
				profile = deepMerge(profile, hints);
			}
		}

		// Layer 4 — channel profile_json
		if (channelId) {
			const channelProfileRaw = this.metaDal.getChannelProfile(channelId);
			if (channelProfileRaw) {
				try {
					const channelProfile = JSON.parse(channelProfileRaw) as Partial<TerminalProfile>;
					profile = deepMerge(profile, channelProfile);
				} catch {
					// Invalid JSON — skip
				}
			}
		}

		return profile;
	}
}
