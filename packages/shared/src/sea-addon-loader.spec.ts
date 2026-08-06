import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractAddonToDir } from "./sea-addon-loader.js";

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
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lasterm-sea-addon-"));
	tempDirs.push(dir);
	return dir;
}

function extractInChild(cacheDir: string, assetName: string, size: number): ChildProcess {
	const moduleUrl = pathToFileURL(new URL("./sea-addon-loader.ts", import.meta.url).pathname).href;
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
