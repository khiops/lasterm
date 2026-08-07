// In-memory TypeScript entity types for lasterm
// These represent the domain model; DB types are defined in hub/storage

import type { BellSound } from "./config.js";

export type BackgroundMode = "image" | "solid" | "transparent";
export type WindowEffect =
	| "none"
	| "auto"
	| "mica"
	| "blur"
	| "acrylic"
	| "vibrancy-under-window"
	| "vibrancy-sidebar"
	| "vibrancy-hud";

export interface TerminalProfile {
	fontFamily?: string;
	fontSize?: number;
	theme?: string;
	themeOverrides?: Record<string, string>;
	cursorStyle?: "block" | "underline" | "bar";
	scrollback?: number;
	bellSound?: BellSound | boolean;
	bellCustomFile?: string;
	bellBadge?: boolean;
	/** Show search match markers in the scrollbar overview ruler (default: true). */
	scrollbarMarkers?: boolean;
	wallpaper?: string;
	wallpaperBlur?: number;
	wallpaperDim?: number;
	backgroundMode?: BackgroundMode;
	windowEffect?: WindowEffect;
	/** Controls how process.env is merged into PTY environment. Default: 'inherit'. */
	envMode?: "minimal" | "inherit";
	[key: string]: unknown;
}

export type SessionStatus = "starting" | "active" | "detached" | "disconnected" | "closed";
export type ChannelStatus = "born" | "live" | "orphan" | "dead";
export type HostType = "local" | "ssh";
export type SshAuthMethod = "agent" | "key" | "password";
export type IconType = "auto" | "emoji" | "image";
export type TrustPolicy = "apply" | "ask" | "ignore";
export type LaunchProfileMode = "shell" | "process";
export type SupportedOs = "linux" | "darwin" | "windows" | "any";
export type ElevationMethod = "sudo" | "doas" | "pkexec" | "gsudo" | "custom";
export type HostOs = "linux" | "darwin" | "windows";
export type HostArch = "x64" | "arm64";

export const ELEVATION_METHODS_LINUX: readonly ElevationMethod[] = [
	"sudo",
	"doas",
	"pkexec",
	"custom",
];
export const ELEVATION_METHODS_DARWIN: readonly ElevationMethod[] = ["sudo", "doas", "custom"];
export const ELEVATION_METHODS_WINDOWS: readonly ElevationMethod[] = ["gsudo", "custom"];
export const ELEVATION_METHODS_ALL: readonly ElevationMethod[] = [
	"sudo",
	"doas",
	"pkexec",
	"gsudo",
	"custom",
];

export interface Host {
	id: string; // ULID
	type: HostType;
	label: string;
	sshHost?: string;
	sshPort?: number;
	sshAuth?: SshAuthMethod;
	sshKeyPath?: string;
	iconType: IconType;
	iconValue?: string;
	color?: string; // hex #rrggbb
	profileJson?: string; // JSON string of TerminalProfile
	trustRemoteHints: TrustPolicy;
	defaultShell?: string;
	defaultCwd?: string;
	elevationMethod?: ElevationMethod | null;
	customCommand?: string | null;
	hostGroup?: string | null;
	hostGroupId?: string | null;
	sortOrder: number;
	sshConfigHost?: string | null;
	sshUser?: string | null;
	keepAliveSeconds: number;
	historyRetentionDays: number;
	discoveredShells?: string[];
	discoveredShellsAt?: string;
	/** Operating system of the remote host (null = auto-detect on first connect) */
	os: HostOs | null;
	/** CPU architecture (null = auto-detect on first connect) */
	arch: HostArch | null;
	/** SHA256:<base64> fingerprint of the trusted SSH host key (null = not yet seen) */
	sshFingerprint?: string | null;
	/** SHA256 of the pinned remote agent binary (null = not yet verified). */
	agentSha256?: string | null;
	createdAt: string; // ISO 8601
	updatedAt: string;
}

export interface HostGroup {
	id: string;
	name: string;
	sortOrder: number;
	color?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ChannelGroup {
	id: string;
	hostId: string;
	name: string;
	sortOrder: number;
	collapsed: boolean;
	createdAt: string;
}

export interface Session {
	id: string;
	hostId: string;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
}

export interface Channel {
	id: string;
	sessionId: string;
	groupId?: string;
	title?: string;
	shell: string;
	args?: string[];
	cwd?: string;
	envJson?: string; // JSON string
	cols: number;
	rows: number;
	status: ChannelStatus;
	exitCode?: number;
	profileJson?: string;
	isWelcome?: boolean;
	icon?: string;
	directProcess?: boolean;
	dynamicTitle?: string;
	processTitle?: string;
	displayTitle?: string;
	launchProfileId?: string;
	elevated?: boolean;
	elevationMethod?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Workspace {
	id: string;
	name: string;
	layoutJson: string; // JSON string of TabLayout
	createdAt: string;
	updatedAt: string;
}

export interface CacheIndex {
	channelId: string;
	lastSnapshotChunkId?: string;
	lastSeq: number;
	lastSeenAt: string;
}

export interface PairingCode {
	code: string;
	token: string;
	expiresAt: string;
	used: boolean;
}

export interface SshConfigEntry {
	name: string;
	hostname: string | null;
	port: number;
	user: string | null;
	identityFile: string | null;
	proxyJump: string | null;
	isGitHost: boolean;
}

export interface SshConfigImport {
	name: string;
	label: string;
	hostGroup?: string;
}

export interface LaunchProfile {
	id: string;
	name: string;
	shell: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	mode: LaunchProfileMode;
	elevated: boolean;
	supportedOs: SupportedOs;
	iconType: IconType;
	iconValue?: string;
	color?: string;
	profileOverrides?: Partial<TerminalProfile>;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface HostLaunchProfileOverride {
	hostId: string;
	profileId: string;
	overrideType: "pin" | "hide" | "default";
	sortOrder?: number;
}

export interface PaginatedResponse<T> {
	data: T[];
	total: number;
	limit: number;
	offset: number;
}

export interface TestConnectionResult {
	ok: boolean;
	latencyMs?: number;
	serverVersion?: string;
	error?: string;
}

export interface FontFile {
	style: string;
	weight: number;
	url: string;
}

export interface FontFamily {
	family: string;
	files: FontFile[];
}

export interface LogConfig {
	level: "trace" | "debug" | "info" | "warn" | "error";
	format: "text" | "jsonl";
	output: "stderr" | "file" | "both";
	maxAgeDays: number;
	maxSizeMb: number;
}

export interface SshKeyEntry {
	name: string;
	type: "directory" | "key";
	items?: number;
	algorithm?: string;
	bits?: number;
	fingerprint?: string;
	encrypted?: boolean;
	mtime?: string;
}
