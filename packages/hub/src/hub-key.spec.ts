import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectPosixMode } from "./file-mode.fixture.js";
import { HUB_KEY_FILE, loadHubKey } from "./hub-key.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";

describe("the hub key (#127)", () => {
	let stateDir: string;

	beforeEach(() => {
		stateDir = makeTempDir("lasterm-hub-key-");
	});

	afterEach(async () => {
		await removeTempDir(stateDir);
	});

	it("is created on first start: 32 random bytes as hex, readable by its owner alone", () => {
		const key = loadHubKey(stateDir);

		expect(key).toMatch(/^[0-9a-f]{64}$/);
		const keyPath = join(stateDir, HUB_KEY_FILE);
		expect(readFileSync(keyPath, "utf8")).toBe(key);
		expectPosixMode(keyPath, 0o600);
		// Written aside and renamed into place: nothing is left over.
		expect(readdirSync(stateDir)).toEqual([HUB_KEY_FILE]);
	});

	it("is the same key on every start after that", () => {
		const first = loadHubKey(stateDir);

		expect(loadHubKey(stateDir)).toBe(first);
		expect(loadHubKey(stateDir)).toBe(first);
	});

	it("is never the same for two hubs", () => {
		const other = makeTempDir("lasterm-hub-key-other-");
		try {
			expect(loadHubKey(stateDir)).not.toBe(loadHubKey(other));
		} finally {
			void removeTempDir(other);
		}
	});

	it("forgives the line ending of a key written back by hand", () => {
		const key = "a1".repeat(32);
		writeFileSync(join(stateDir, HUB_KEY_FILE), `${key}\n`);

		expect(loadHubKey(stateDir)).toBe(key);
	});

	it("refuses a malformed key, naming the file, without quoting it or replacing it", () => {
		const keyPath = join(stateDir, HUB_KEY_FILE);
		const malformed = "not-a-key-but-possibly-secret";
		writeFileSync(keyPath, malformed);

		let error: unknown;
		try {
			loadHubKey(stateDir);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(keyPath);
		expect((error as Error).message).not.toContain(malformed);
		// A new key would orphan this hub's channels on every daemon it has used.
		expect(readFileSync(keyPath, "utf8")).toBe(malformed);
	});

	it("refuses an empty file too, rather than take it for a missing one", () => {
		writeFileSync(join(stateDir, HUB_KEY_FILE), "");

		expect(() => loadHubKey(stateDir)).toThrow(join(stateDir, HUB_KEY_FILE));
	});
});
