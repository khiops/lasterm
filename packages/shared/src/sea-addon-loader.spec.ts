import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAddonToDir, getAddonCacheDir, readSeaVersion } from "./sea-addon-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extractAddonToDir", () => {
	it("never presents a partial addon while concurrent processes extract it", async () => {
		const cacheDir = makeTempDir();
		const assetName = "concurrent.node";
		const data = Buffer.alloc(1024 * 1024, 0xa5);
		const workers = Array.from({ length: 2 }, () =>
			extractInChild(cacheDir, assetName, data.length),
		);
		const destination = join(cacheDir, assetName);
		let observed = 0;
		let complete = false;
		const exits = Promise.all(workers.map(waitForExit)).finally(() => {
			complete = true;
		});

		while (!complete) {
			if (existsSync(destination)) {
				const extracted = readFileSync(destination);
				expect(extracted).toEqual(data);
				observed += 1;
			}
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await exits;
		expect(observed).toBeGreaterThan(0);
		expect(readFileSync(destination)).toEqual(data);
	}, 20_000);

	it("returns the published path", () => {
		const cacheDir = makeTempDir();
		expect(extractAddonToDir("addon.node", cacheDir, Buffer.from("complete"))).toBe(
			join(cacheDir, "addon.node"),
		);
	});

	it("replaces a cached file of the right size whose bytes differ", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		writeFileSync(join(cacheDir, "addon.node"), Buffer.alloc(asset.length, 0x41));
		// Mutation caught: the old size check reused this file and dlopen ran it.
		extractAddonToDir("addon.node", cacheDir, asset);
		expect(readFileSync(join(cacheDir, "addon.node"))).toEqual(asset);
	});

	it("reuses a cached file that holds exactly the embedded bytes", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		const cached = join(cacheDir, "addon.node");
		writeFileSync(cached, asset);
		const past = new Date("2020-01-01T00:00:00Z");
		utimesSync(cached, past, past);
		extractAddonToDir("addon.node", cacheDir, asset);
		expect(statSync(cached).mtime).toEqual(past);
	});

	it("removes a temporary left by a writer that is gone, and keeps a live writer's", () => {
		const cacheDir = makeTempDir();
		const orphan = join(cacheDir, "addon.node.2147483.0123456789abcdef.tmp");
		const live = join(cacheDir, `addon.node.${process.pid}.fedcba9876543210.tmp`);
		writeFileSync(orphan, "interrupted");
		writeFileSync(live, "in progress");
		extractAddonToDir("addon.node", cacheDir, Buffer.from("complete"));
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});
});

describe("getAddonCacheDir", () => {
	it("keys the cache by version, platform and architecture", () => {
		const dir = getAddonCacheDir("1.2.3");
		expect(dir).toContain("1.2.3");
		expect(dir.endsWith(`${process.platform}-${process.arch}`)).toBe(true);
	});
});

describe("readSeaVersion", () => {
	it("returns the embedded version, trimmed", () => {
		expect(readSeaVersion({ getAsset: () => "0.10.6\n" })).toBe("0.10.6");
	});

	it("refuses an executable without a VERSION asset instead of reading 0.0.0", () => {
		expect(() => readSeaVersion({})).toThrow("no VERSION asset");
		expect(() => readSeaVersion({ getAsset: () => "  " })).toThrow("no VERSION asset");
		expect(() =>
			readSeaVersion({
				getAsset: () => {
					throw new Error("No such asset");
				},
			}),
		).toThrow("no VERSION asset");
	});
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lasterm-sea-addon-"));
	tempDirs.push(dir);
	return dir;
}

function extractInChild(cacheDir: string, assetName: string, size: number): ChildProcess {
	const moduleUrl = new URL("./sea-addon-loader.ts", import.meta.url).href;
	const program = [
		`import { extractAddonToDir } from ${JSON.stringify(moduleUrl)};`,
		`extractAddonToDir(${JSON.stringify(assetName)}, ${JSON.stringify(cacheDir)}, Buffer.alloc(${size}, 0xa5));`,
	].join("\n");
	return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
		stdio: "ignore",
	});
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) {
			if (child.exitCode === 0) resolve();
			else reject(new Error(`extractor exited ${child.exitCode}`));
			return;
		}
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`extractor exited ${code}`));
		});
	});
}
