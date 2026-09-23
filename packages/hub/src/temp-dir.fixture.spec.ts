import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";

const onWindows = process.platform === "win32";

/**
 * Opens the file with no sharing at all, as a scanner can, and keeps it open
 * until its standard input closes.
 */
const HOLD_SCRIPT = [
	"$held = [System.IO.File]::Open($env:LASTERM_HELD_FILE, 'Open', 'Read', 'None')",
	"[Console]::Out.WriteLine('held'); [Console]::Out.Flush()",
	"[void][Console]::In.ReadLine()",
	"$held.Close()",
].join("\n");

/**
 * Hold `file` open from another process, the way an antivirus scanner or the
 * search indexer does on Windows, until the returned function is called.
 */
async function holdOpen(file: string): Promise<() => Promise<void>> {
	const holder = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", HOLD_SCRIPT],
		{ env: { ...process.env, LASTERM_HELD_FILE: file }, stdio: ["pipe", "pipe", "inherit"] },
	);
	const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		let output = "";
		holder.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("held")) resolve();
		});
		holder.once("error", reject);
		holder.once("exit", (code) =>
			reject(new Error(`the holder exited (${code}) before it held ${file}`)),
		);
	});
	return async () => {
		holder.stdin.end();
		await exited;
	};
}

/** A temp directory holding one file, `levels` directories down, and the path of that file. */
function dirWithFile(levels = 0): { dir: string; file: string } {
	const dir = makeTempDir("lasterm-temp-dir-fixture-");
	const parent = join(dir, ...Array.from({ length: levels }, (_, level) => `level-${level}`));
	mkdirSync(parent, { recursive: true });
	const file = join(parent, "written.txt");
	writeFileSync(file, "just written");
	return { dir, file };
}

describe("makeTempDir", () => {
	it("makes a new, empty directory under the system temp folder", async () => {
		const first = makeTempDir("lasterm-temp-dir-fixture-");
		const second = makeTempDir("lasterm-temp-dir-fixture-");
		try {
			expect(dirname(first)).toBe(tmpdir());
			expect(basename(first).startsWith("lasterm-temp-dir-fixture-")).toBe(true);
			expect(readdirSync(first)).toEqual([]);
			expect(second).not.toBe(first);
		} finally {
			await removeTempDir(first);
			await removeTempDir(second);
		}
	});
});

describe("removeTempDir", () => {
	it("removes the directory and everything in it", async () => {
		const { dir } = dirWithFile(2);
		writeFileSync(join(dir, "beside.txt"), "x");
		const reports: string[] = [];

		await removeTempDir(dir, { report: (message) => reports.push(message) });

		expect(existsSync(dir)).toBe(false);
		expect(reports).toEqual([]);
	});

	it("accepts a directory that is already gone", async () => {
		const { dir } = dirWithFile();
		await removeTempDir(dir);
		const reports: string[] = [];

		await removeTempDir(dir, { report: (message) => reports.push(message) });

		expect(reports).toEqual([]);
	});

	it("reports a removal that fails, and resolves instead of failing the test", async () => {
		// Any failure will do here; a held file, the one that happens, needs Windows.
		const reports: string[] = [];

		await expect(
			removeTempDir("not\0a path", { report: (message) => reports.push(message) }),
		).resolves.toBeUndefined();

		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("could not be removed");
	});

	// #524: a spec failed on Windows, now and then, removing a file it had just
	// written. Mutation caught: without retries the first attempt meets the
	// handle and gives up, and so does rmSync with maxRetries (EPERM at once).
	it.runIf(onWindows)("waits out a file another process holds for a moment", async () => {
		const { dir, file } = dirWithFile();
		const release = await holdOpen(file);
		const reports: string[] = [];

		const removal = removeTempDir(dir, { report: (message) => reports.push(message) });
		// The first attempt meets the handle; it goes while removal still waits.
		await sleep(100);
		await release();
		await removal;

		expect(reports).toEqual([]);
		expect(existsSync(dir)).toBe(false);
	});

	it.runIf(onWindows)(
		"reports a directory still held after its retries, soon, and leaves it in place",
		async () => {
			// Two levels down: fs.promises.rm's own maxRetries would retry each
			// level inside the other and hold this test for minutes.
			const { dir, file } = dirWithFile(2);
			const release = await holdOpen(file);
			const reports: string[] = [];
			try {
				const started = performance.now();
				// Mutation caught: without the catch this rejects, and fails the test.
				await removeTempDir(dir, { report: (message) => reports.push(message) });

				expect(performance.now() - started).toBeLessThan(10_000);
				expect(reports).toHaveLength(1);
				expect(reports[0]).toContain(dir);
				expect(reports[0]).toContain("EBUSY");
				expect(existsSync(file)).toBe(true);
			} finally {
				await release();
				await removeTempDir(dir);
			}
		},
	);
});
