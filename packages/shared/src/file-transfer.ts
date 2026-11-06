// File transfer's settings (#835, part of #721): the terminal-profile keys
// about files dropped on a terminal, cascaded like the font; the window's
// `[transfer]` section; the files panel's width in `[layout]`; and the
// experimental switch the whole feature waits behind, off until upload (#837)
// lands so that no release shows half of it.
//
// Shared because the hub validates what it stores with these rules, and the
// client reads the same defaults and asks the same switch.

// ─── Terminal-profile keys ([terminal], a host's profile, a terminal's) ──────

/** What dropping files on a terminal does: send them to its host, or nothing. */
export const TRANSFER_DROP_VALUES = ["upload", "off"] as const;
export type TransferDrop = (typeof TRANSFER_DROP_VALUES)[number];

/** What an upload does with a file of the same name where it lands. */
export const TRANSFER_ON_CONFLICT_VALUES = ["ask", "replace", "keep_both", "skip"] as const;
export type TransferOnConflict = (typeof TRANSFER_ON_CONFLICT_VALUES)[number];

/** The longest `transferFallbackDir`, as for a launch profile's `cwd`. */
export const TRANSFER_FALLBACK_DIR_MAX_LENGTH = 1024;

/** File transfer's keys in the terminal profile, camelCased as a profile holds them. */
export const TRANSFER_PROFILE_KEYS = [
	"transferDrop",
	"transferConfirmDrop",
	"transferOnConflict",
	"transferFollowCwd",
	"transferFallbackDir",
	"transferVerify",
] as const;

export type TransferProfileKey = (typeof TRANSFER_PROFILE_KEYS)[number];

/**
 * Terminal-profile keys set globally or for a host, never for one terminal:
 * where an upload lands when the shell's directory is unknown, and whether it
 * is checked on a host without SFTP, are about the host, not about a shell on
 * it. A terminal's profile refuses them.
 */
export const HOST_ONLY_PROFILE_KEYS: readonly string[] = ["transferFallbackDir", "transferVerify"];

const isBoolean = (value: unknown): boolean => typeof value === "boolean";

function isOneOf(values: readonly string[]): (value: unknown) => boolean {
	return (value) => typeof value === "string" && values.includes(value);
}

/**
 * A directory to upload to when the terminal's own is unknown: "" for the
 * home. The agent expands `${VAR}` in it, as in a launch profile's `cwd`, so
 * the hub keeps it as written. A NUL ends a path wherever it reaches the
 * system, so none is accepted.
 */
export function isTransferFallbackDir(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= TRANSFER_FALLBACK_DIR_MAX_LENGTH &&
		!value.includes("\0")
	);
}

/**
 * The values each file-transfer key of the terminal profile accepts, at every
 * scope that holds it. `null`, which removes an override, is not a value and
 * is never asked about here. Each rule is unit-tested beside this table.
 */
export const TRANSFER_PROFILE_VALIDATORS: Readonly<
	Record<TransferProfileKey, (value: unknown) => boolean>
> = {
	transferDrop: isOneOf(TRANSFER_DROP_VALUES),
	transferConfirmDrop: isBoolean,
	transferOnConflict: isOneOf(TRANSFER_ON_CONFLICT_VALUES),
	transferFollowCwd: isBoolean,
	transferFallbackDir: isTransferFallbackDir,
	transferVerify: isBoolean,
};

// ─── [transfer]: the window's files panel, global only ───────────────────────

export const TRANSFER_PANEL_SIDES = ["right", "left"] as const;
export type TransferPanelSide = (typeof TRANSFER_PANEL_SIDES)[number];

/** The most transfers run at once; the rest wait their turn. */
export const TRANSFER_MAX_CONCURRENT_LIMIT = 3;

/** `[transfer]` in config.toml. */
export interface TransferConfig {
	/** Which side of the window the files panel opens on. Default: "right" */
	panelSide?: TransferPanelSide;
	/** Dragging files over the window opens the panel. Default: true */
	openOnDrag?: boolean;
	/** Transfers run at once, 1 to 3. Default: 2 */
	maxConcurrent?: number;
	/** The panel lists dot files. Default: false */
	showHidden?: boolean;
}

export const DEFAULT_TRANSFER_CONFIG: Required<TransferConfig> = {
	panelSide: "right",
	openOnDrag: true,
	maxConcurrent: 2,
	showHidden: false,
};

export const TRANSFER_CONFIG_KEYS = [
	"panelSide",
	"openOnDrag",
	"maxConcurrent",
	"showHidden",
] as const;

export type TransferConfigKey = (typeof TRANSFER_CONFIG_KEYS)[number];

/** How many transfers may run at once: a whole number from 1 to the limit. */
export function isTransferMaxConcurrent(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= TRANSFER_MAX_CONCURRENT_LIMIT
	);
}

/** The values each `[transfer]` key accepts. Each rule is unit-tested beside this table. */
export const TRANSFER_CONFIG_VALIDATORS: Readonly<
	Record<TransferConfigKey, (value: unknown) => boolean>
> = {
	panelSide: isOneOf(TRANSFER_PANEL_SIDES),
	openOnDrag: isBoolean,
	maxConcurrent: isTransferMaxConcurrent,
	showHidden: isBoolean,
};

// ─── [layout] transfer_panel_width ───────────────────────────────────────────

export const TRANSFER_PANEL_WIDTH_MIN = 240;
export const TRANSFER_PANEL_WIDTH_MAX = 520;
export const DEFAULT_TRANSFER_PANEL_WIDTH = 300;

/** A width the files panel can have, in whole pixels. */
export function isTransferPanelWidth(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= TRANSFER_PANEL_WIDTH_MIN &&
		value <= TRANSFER_PANEL_WIDTH_MAX
	);
}

// ─── [experimental]: features not finished yet, off by default ───────────────

/**
 * `[experimental]` in config.toml: a switch per feature that ships unfinished,
 * off by default. A switch goes when its feature is done, and the feature with
 * it is then simply on: nothing reads a key left behind.
 */
export interface ExperimentalConfig {
	/**
	 * File transfer (#721): dropping files on a terminal to send them to its
	 * host, the files panel, and their settings. Off until upload (#837)
	 * lands. Default: false
	 */
	fileTransfer?: boolean;
}

export const DEFAULT_EXPERIMENTAL_CONFIG: Required<ExperimentalConfig> = {
	fileTransfer: false,
};

export const EXPERIMENTAL_CONFIG_KEYS = ["fileTransfer"] as const;

/**
 * Whether file transfer is on: the one check every part of it makes — the
 * drop on a terminal, the files panel, their routes — before doing anything.
 * Given the UI config as the hub serves it (`GET /api/config/ui`), or as the
 * client holds it; anything short of an explicit `true` is off.
 */
export function isFileTransferEnabled(
	ui: { experimental?: ExperimentalConfig | undefined } | null | undefined,
): boolean {
	return ui?.experimental?.fileTransfer === true;
}
