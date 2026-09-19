import type { TestConnectPlatform } from "@lasterm/shared";

/**
 * The line the connection test adds under "Connected": the remote system, and
 * what its first session will need from the hub. A system with no agent build
 * is a warning: the host connects, but no session can start on it.
 */
export function describeTestPlatform(platform: TestConnectPlatform): {
	text: string;
	warning: boolean;
} {
	switch (platform.agent) {
		case "ready":
			return { text: `${platform.system} · agent ready`, warning: false };
		case "download":
			return {
				text: `${platform.system} · agent v${platform.agentVersion} will be downloaded on first connect`,
				warning: false,
			};
		case "unsupported":
			return {
				text: `${platform.system} · no Lasterm agent is built for this system, so sessions cannot start on it`,
				warning: true,
			};
		default:
			return { text: `${platform.system} · agent status unknown`, warning: false };
	}
}
