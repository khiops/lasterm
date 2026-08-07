import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── The installation this one replaced ────────────────────────────────────────
//
// The rename moved every namespace at once: config, state, the agent socket, the
// single-hub lock, the browser's stored token, and the name of the agent binary
// deployed on remote hosts. So a Termora install and this one cannot see each
// other's lock: both hubs would serve terminals, and quitting this one would
// leave the other serving its paired tokens and live terminals.
//
// What this can and cannot do, stated exactly, because the difference matters:
//
//   It refuses to CONSTRUCT a serving hub while a previous installation is
//   visible from this process. That is why the check belongs to `startHub` and
//   not to a command handler — a caller that could reach the operation without
//   it is a caller that gets two hubs.
//
//   It cannot make the old generation participate. The old executable knows
//   nothing about this namespace, so it can still be launched afterwards, and a
//   previous installation living under an environment this process was not given
//   is not visible to it. Those are properties of the old binary, not gaps here;
//   #168 and #169 track them.
//
// Nothing is read, copied or deleted beyond the runtime record: the old
// directories are named and left alone, because they hold hosts, profile data
// and an auth token that are the operator's to move.

const PREVIOUS_NAME = "termora";

/** Thrown by `startHub` instead of constructing a hub beside an older one. */
export class PreviousInstallationError extends Error {
	constructor(description: string) {
		super(description);
		this.name = "PreviousInstallationError";
	}
}

function previousStateDir(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? "", PREVIOUS_NAME);
	}
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), PREVIOUS_NAME);
}

function previousConfigDir(): string {
	if (process.platform === "win32") {
		// `APPDATA` first, then `LOCALAPPDATA`, matching how the previous generation's
		// agent resolved its own config directory. Reading only `APPDATA` would yield a
		// relative path when it is unset, and miss a real `%LOCALAPPDATA%\termora`.
		return join(process.env.APPDATA ?? process.env.LOCALAPPDATA ?? "", PREVIOUS_NAME);
	}
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), PREVIOUS_NAME);
}

type Presence = "present" | "absent" | { readonly undecidable: string };

/**
 * Whether a directory is there. A probe that cannot conclude says so rather than
 * reporting "absent": `existsSync` answers false for a path that exists but
 * cannot be stat'd, which would turn a permission error into permission to run.
 */
function presenceOf(dir: string): Presence {
	try {
		return statSync(dir).isDirectory() ? "present" : "absent";
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		return { undecidable: (err as NodeJS.ErrnoException).code ?? String(err) };
	}
}

/**
 * The pid in a previous-generation runtime record, when that pid is a plausible
 * one and some process currently holds it.
 *
 * Liveness is all this proves. The record is an ordinary file in a directory the
 * old hub owned, so a stale or edited one can name any live pid; the caller must
 * not describe the result as "the old hub", and must never act on it.
 */
function previousRecordedPid(stateDir: string): number | undefined {
	let pid: number;
	try {
		const record = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf-8")) as {
			pid?: unknown;
		};
		if (typeof record.pid !== "number") return undefined;
		// A pid is a positive integer. Zero and negatives address process groups,
		// and `process.kill` accepts them, so an unvalidated record turns this
		// probe into a signal aimed at every process in a group.
		if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
		pid = record.pid;
	} catch {
		return undefined;
	}
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		// Gone, or owned by another user. Either way, nothing to report.
		return undefined;
	}
}

/**
 * Describe a previous-generation installation, or undefined when none is visible
 * from this process. Exported for tests; `startHub` refuses on any description.
 */
export function describePreviousInstallation(): string | undefined {
	const config = previousConfigDir();
	const state = previousStateDir();
	const found: string[] = [];

	for (const [dir, holds] of [
		[config, "hosts, profiles, auth token"],
		[state, "session and output databases"],
	] as const) {
		const presence = presenceOf(dir);
		if (presence === "present") found.push(`  ${dir}  (${holds})`);
		else if (presence !== "absent") {
			found.push(`  ${dir}  (cannot be examined: ${presence.undecidable})`);
		}
	}
	if (found.length === 0) return undefined;

	const pid = previousRecordedPid(state);
	if (pid !== undefined) {
		found.push(`  its runtime record names pid ${pid}, and that pid is in use`);
	}

	return [
		"Found a Termora installation. Lasterm will not run beside it:",
		...found,
		"",
		"The two share no lock, socket or state, so both hubs could serve terminals at",
		"once and quitting one would not stop the other.",
		"",
		"Move or remove those directories, keeping anything you want to keep. Stop any",
		"Termora hub first — verify which process it is before signalling anything, as",
		"the pid above comes from a file and proves only that some process holds it.",
		"A browser paired with Termora also keeps its token under the old key at the",
		"same address; clear that site's storage if you want the old access gone.",
		"Refusing to start.",
	].join("\n");
}
