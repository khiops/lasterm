/**
 * Shared input/row types for MetaDAL and domain-specific sub-DALs.
 * Kept in a separate module to avoid circular imports.
 */

import type {
	ChannelStatus,
	ElevationMethod,
	HostArch,
	HostOs,
	SessionStatus,
} from "@lasterm/shared";

export interface CreateHostInput {
	type: "local" | "ssh";
	label: string;
	sshHost?: string;
	sshPort?: number;
	sshAuth?: "agent" | "key" | "password";
	sshKeyPath?: string;
	iconType?: "auto" | "emoji" | "image";
	iconValue?: string;
	color?: string;
	profileJson?: string;
	trustRemoteHints?: "apply" | "ask" | "ignore";
	defaultShell?: string;
	defaultCwd?: string;
	hostGroup?: string | null;
	hostGroupId?: string | null;
	sortOrder?: number;
	sshConfigHost?: string | null;
	sshUser?: string | null;
	keepAliveSeconds?: number;
	historyRetentionDays?: number;
	elevationMethod?: ElevationMethod | null;
	customCommand?: string | null;
	os?: HostOs | null;
	arch?: HostArch | null;
}

export interface CreateSessionInput {
	id: string;
	hostId: string;
	status: SessionStatus;
}

export interface CreateChannelInput {
	id: string;
	sessionId: string;
	status: ChannelStatus;
	shell?: string;
	args?: string[];
	cwd?: string;
	title?: string;
	cols?: number;
	rows?: number;
	icon?: string;
	directProcess?: boolean;
	launchProfileId?: string;
	elevated?: boolean;
	elevationMethod?: string | null;
}

export interface PairingCodeRow {
	id: string;
	code: string;
	created_at: string;
	expires_at: string;
	used: number;
	used_at: string | null;
	used_by_ip: string | null;
}
