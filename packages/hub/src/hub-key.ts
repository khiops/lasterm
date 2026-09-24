import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/** The file in the state directory that holds this hub's key. */
export const HUB_KEY_FILE = "hub-key";

/** What the generator writes: 32 random bytes, as lowercase hex. */
const HUB_KEY_FORMAT = /^[0-9a-f]{64}$/;

/**
 * This hub's key, which names it to every agent daemon it connects to (#127).
 *
 * A daemon serves several hubs at once and gives each its own channels. It
 * tells them apart by the key each sends in its AUTH, and keeps only its
 * SHA-256. The key must therefore outlive the hub process: a hub that came back
 * with another one would find its own terminals belonging to a stranger.
 *
 * Created once, in the state directory the hub has just locked, and read on
 * every start after that. A file that holds anything but a key is refused,
 * naming the file, rather than replaced: a new key would orphan this hub's
 * channels on every daemon it has used, and nothing would say why.
 *
 * The file is created 0600 and written whole before it takes its name, so a
 * crash leaves either no key or a complete one. On Windows the mode does
 * nothing and the file relies on the profile's default ACL, as `auth.json`
 * does (#200). The key is never logged, and no error here quotes it.
 */
export function loadHubKey(stateDir: string): string {
	const keyPath = join(stateDir, HUB_KEY_FILE);
	if (existsSync(keyPath)) return readHubKey(keyPath);

	const key = randomBytes(32).toString("hex");
	const tempPath = join(stateDir, `${HUB_KEY_FILE}.${process.pid}.tmp`);
	// Created with its final mode, so the key is never readable by others, even
	// for the moment before a chmod.
	const fd = openSync(tempPath, "wx", 0o600);
	try {
		writeSync(fd, key);
		fchmodSync(fd, 0o600); // a umask cannot widen what is set explicitly
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		rmSync(tempPath, { force: true });
		throw error;
	}
	closeSync(fd);
	try {
		renameSync(tempPath, keyPath);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
	return key;
}

function readHubKey(keyPath: string): string {
	const content = readFileSync(keyPath, "utf8");
	// One line ending is forgiven, for a key someone wrote back by hand.
	const key = content.replace(/\r?\n$/, "");
	if (!HUB_KEY_FORMAT.test(key)) {
		throw new Error(
			`Invalid hub key in ${keyPath}: expected 64 lowercase hex characters. ` +
				"It names this hub to its agent daemons, so it is not replaced: a new key would leave " +
				"this hub's terminals on those daemons out of its reach. Restore the file, or delete it " +
				"to start this hub under a new identity.",
		);
	}
	return key;
}
