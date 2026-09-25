import { chmodSync, lstatSync } from "node:fs";
import { shellQuote } from "./auth.js";

export interface PrivateStateDirectoryOptions {
	/** The account the directory must belong to. Defaults to the effective uid; tests substitute it. */
	readonly uid?: number;
}

/**
 * Hold the state directory to 0700 at every start (SECURITY.md § 2.2, item 3,
 * #536). It holds `meta.db`, `spool.db`, the TLS private key and the hub key.
 *
 * The hub creates it 0700, but one an earlier version created under a loose
 * umask, or one made by hand, is whatever it was made. So:
 *
 * - Owned by this account and open to group or others in any way: tightened,
 *   the group's and others' permissions removed and the owner's left alone, as
 *   #510 does for the addon cache. If the mode does not change — a filesystem
 *   that ignores chmod — the hub stops, naming the directory and the fix.
 * - Owned by another account, root included: the hub stops. Whoever owns the
 *   directory can replace anything in it, the TLS key and the databases
 *   included, and lasterm does not change another account's directory. The TLS
 *   key writer already refused such a directory; this refuses it first, before
 *   a log, the TLS key or a database is opened there, and says why.
 * - Not a directory, a symbolic link included: the hub stops. The TLS key
 *   writer opens every component without following links, so a linked state
 *   directory never worked.
 *
 * One lstat, and not path integrity: an ancestor able to rename the directory
 * defeats it, as it does the configuration directory's check in auth.ts.
 *
 * Windows is not examined. Node reports neither the owner nor the DACL there,
 * and the directory relies on the profile's default ACL, as auth.json does
 * (#200).
 */
export function ensurePrivateStateDirectory(
	stateDir: string,
	options: PrivateStateDirectoryOptions = {},
): void {
	if (process.platform === "win32") return;

	const stat = lstatSync(stateDir);
	if (!stat.isDirectory()) {
		throw new Error(`SECURITY: state directory at ${stateDir} is not a directory`);
	}
	const uid = options.uid ?? process.geteuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(
			`SECURITY: state directory at ${stateDir} is owned by uid ${stat.uid}, not by this account (uid ${uid}). Lasterm does not change a directory another account owns: have its owner hand it over, or set XDG_STATE_HOME to a directory this account owns`,
		);
	}
	if ((stat.mode & 0o077) === 0) return;

	chmodSync(stateDir, stat.mode & 0o7700);
	const tightened = lstatSync(stateDir);
	if (tightened.isDirectory() && (tightened.mode & 0o077) === 0) return;
	throw new Error(
		`SECURITY: state directory at ${stateDir} is open to group or others (mode ${(tightened.mode & 0o777).toString(8)}) and could not be tightened. Fix with: chmod 700 -- ${shellQuote(stateDir)}`,
	);
}
