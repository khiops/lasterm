import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retireAddonCache, retiredAddonRoots } from "./retired-addon-cache.js";

const windows = process.platform === "win32";
const platform = `${process.platform}-${process.arch}`;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lasterm-retired-addons-"));
	tempDirs.push(dir);
	return dir;
}

/** Write `files` (paths relative to `root`), creating their directories. */
function lay(root: string, files: readonly string[]): void {
	for (const file of files) {
		const full = path.join(root, ...file.split("/"));
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, "x");
	}
}

function present(root: string, file: string): boolean {
	return existsSync(path.join(root, ...file.split("/")));
}

describe("retireAddonCache", () => {
	it("removes every addon an earlier version extracted, with its directories", () => {
		const root = makeRoot();
		lay(root, [
			`addons/0.14.2/${platform}/better_sqlite3.node`,
			`addons/0.14.2/${platform}/lasterm_hub_lock.node`,
			`addons/0.14.2/${platform}/lasterm_tls_identity.node`,
			`addons/0.14.2/${platform}/lasterm_hub_lock.node.4242.0123456789abcdef.tmp`,
			"addons/0.15.0-rc.1/linux-arm64/better_sqlite3.node",
		]);
		retireAddonCache({ roots: [root] });
		expect(present(root, "addons")).toBe(false);
		// The root is not lasterm's alone to remove: the runtime one holds the agent's socket.
		expect(existsSync(root)).toBe(true);
	});

	it("removes the running version's own leftovers too: no version extracts anything now", () => {
		const root = makeRoot();
		lay(root, [
			`addons/0.16.0/${platform}/better_sqlite3.node`,
			`addons/0.16.0/${platform}/better_sqlite3.node.4242.0123456789abcdef.tmp`,
			`addons/0.16.0/${platform}/lasterm_tls_identity.node.7.fedcba9876543210.tmp`,
		]);
		retireAddonCache({ roots: [root] });
		expect(present(root, "addons")).toBe(false);
	});

	it("leaves anything it does not know, and the directories that hold it", () => {
		const root = makeRoot();
		lay(root, [
			`addons/0.14.2/${platform}/notes.txt`,
			`addons/0.14.2/${platform}/lasterm_hub_lock.node`,
			`addons/0.14.2/${platform}/better_sqlite3.node.bak`,
			`addons/0.14.2/${platform}/other.node`,
			"addons/0.14.2/Some Dir/lasterm_hub_lock.node",
			"addons/not-a-version/linux-x64/lasterm_hub_lock.node",
			"addons/README",
			"other/lasterm_hub_lock.node",
		]);
		retireAddonCache({ roots: [root] });
		expect(present(root, `addons/0.14.2/${platform}/lasterm_hub_lock.node`)).toBe(false);
		for (const kept of [
			`addons/0.14.2/${platform}/notes.txt`,
			`addons/0.14.2/${platform}/better_sqlite3.node.bak`,
			`addons/0.14.2/${platform}/other.node`,
			"addons/0.14.2/Some Dir/lasterm_hub_lock.node",
			"addons/not-a-version/linux-x64/lasterm_hub_lock.node",
			"addons/README",
			"other/lasterm_hub_lock.node",
		]) {
			expect([kept, present(root, kept)]).toEqual([kept, true]);
		}
	});

	it("leaves a directory at an addon's name", () => {
		const root = makeRoot();
		lay(root, [`addons/0.14.2/${platform}/lasterm_hub_lock.node/inside`]);
		retireAddonCache({ roots: [root] });
		expect(present(root, `addons/0.14.2/${platform}/lasterm_hub_lock.node/inside`)).toBe(true);
	});

	it.skipIf(windows)("follows no link, to a directory or to a file", () => {
		const root = makeRoot();
		const elsewhere = makeRoot();
		lay(elsewhere, [`${platform}/lasterm_hub_lock.node`, "target.node"]);
		mkdirSync(path.join(root, "addons", "0.14.2", platform), { recursive: true });
		symlinkSync(elsewhere, path.join(root, "addons", "0.13.0"));
		symlinkSync(
			path.join(elsewhere, "target.node"),
			path.join(root, "addons", "0.14.2", platform, "lasterm_tls_identity.node"),
		);
		retireAddonCache({ roots: [root] });
		expect(present(elsewhere, `${platform}/lasterm_hub_lock.node`)).toBe(true);
		expect(present(elsewhere, "target.node")).toBe(true);
		expect(present(root, "addons/0.13.0")).toBe(true);
	});

	it.skipIf(windows)("enters no directory another account owns", () => {
		const root = makeRoot();
		lay(root, [`addons/0.14.2/${platform}/lasterm_hub_lock.node`]);
		const someoneElse = (process.geteuid?.() ?? 0) + 1;
		retireAddonCache({ roots: [root], uid: someoneElse });
		expect(present(root, `addons/0.14.2/${platform}/lasterm_hub_lock.node`)).toBe(true);
	});

	it("does nothing, and does not throw, where there is no cache", () => {
		const root = makeRoot();
		expect(() => retireAddonCache({ roots: [path.join(root, "absent"), root] })).not.toThrow();
		expect(existsSync(root)).toBe(true);
	});
});

describe("retiredAddonRoots", () => {
	it("is lasterm's cache directory, and the runtime fallback on POSIX", () => {
		const runtime = path.resolve(makeRoot(), "runtime");
		const roots = retiredAddonRoots({ XDG_RUNTIME_DIR: runtime });
		expect(roots[0]).toMatch(/lasterm[\\/]?(cache)?$/);
		expect(roots.slice(1)).toEqual(windows ? [] : [path.join(runtime, "lasterm")]);
		expect(retiredAddonRoots({ XDG_RUNTIME_DIR: "relative" })).toHaveLength(1);
	});
});
