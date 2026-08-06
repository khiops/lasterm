import type { Host } from "@lasterm/shared";

export function formatConnectionString(host: Host): string {
	let conn = "";
	if (host.sshUser) conn += `${host.sshUser}@`;
	conn += host.sshHost || "";
	if (host.sshPort && host.sshPort !== 22) conn += `:${host.sshPort}`;
	return conn;
}

export function getHostSubtitle(host: Host): string {
	if (host.type === "local") return "Local";
	return formatConnectionString(host);
}
