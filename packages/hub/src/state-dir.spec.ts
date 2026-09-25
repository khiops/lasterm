import { chmodSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateStateDirectory } from "./state-dir.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";

// Windows reports neither an owner nor a DACL to Node, and the state directory
// relies on the profile's ACL there (SECURITY.md § 2.2), so these are skipped
// there, and say so.
describe.skipIf(process.platform === "win32")("ensurePrivateStateDirectory (POSIX)", () => {
	let root: string;
	let stateDir: string;

	const modeOf = (dir: string) => (statSync(dir).mode & 0o7777).toString(8);

	beforeEach(() => {
		root = makeTempDir("lasterm-state-dir-");
		stateDir = join(root, "lasterm");
		mkdirSync(stateDir);
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	// What an earlier version left under a umask of 022 or 002, or a hand-made directory.
	it.each(["755", "775", "750", "705"])(
		"tightens a directory this account owns from %s to 700",
		(mode) => {
			chmodSync(stateDir, Number.parseInt(mode, 8));

			ensurePrivateStateDirectory(stateDir);

			expect(modeOf(stateDir)).toBe("700");
		},
	);

	it("removes only what group and others had, and leaves the owner's bits alone", () => {
		chmodSync(stateDir, 0o2750);

		ensurePrivateStateDirectory(stateDir);

		expect(modeOf(stateDir)).toBe("2700");
	});

	it("refuses a directory another account owns, and does not change it", () => {
		chmodSync(stateDir, 0o755);
		const uid = process.geteuid?.() ?? 0;

		expect(() => ensurePrivateStateDirectory(stateDir, { uid: uid + 1 })).toThrow(
			`is owned by uid ${uid}, not by this account (uid ${uid + 1})`,
		);
		expect(modeOf(stateDir)).toBe("755");
	});

	it("refuses a symbolic link, even to a private directory", () => {
		chmodSync(stateDir, 0o700);
		const link = join(root, "linked");
		symlinkSync(stateDir, link);

		expect(() => ensurePrivateStateDirectory(link)).toThrow(/is not a directory/);
	});
});
