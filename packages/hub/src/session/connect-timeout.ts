import { type Host, isConnectTimeoutSeconds } from "@lasterm/shared";
import { sshConfigConnectTimeout } from "../ssh/ssh-config-parser.js";

/**
 * How long each wait of a connection to `host` may last, in milliseconds, or
 * undefined to keep the hub's own limits (#1034).
 *
 * The host's own value first; without one, `ConnectTimeout` from
 * `~/.ssh/config` for the host's alias, then for `hostname`, as ssh(1) matches
 * the name it is given, read at each call so that an edit of the file applies
 * to the next connection. A value from the file under 20 s is none: the
 * setting only gives a slow host more time.
 */
export function connectTimeoutMsFor(
	host: Pick<Host, "connectTimeoutSeconds" | "sshConfigHost">,
	hostname: string,
	home?: string,
): number | undefined {
	if (isConnectTimeoutSeconds(host.connectTimeoutSeconds)) return host.connectTimeoutSeconds * 1000;
	const names = [host.sshConfigHost, hostname].filter(
		(name): name is string => typeof name === "string" && name.length > 0,
	);
	const seconds = sshConfigConnectTimeout(names, home);
	return seconds === null ? undefined : seconds * 1000;
}
