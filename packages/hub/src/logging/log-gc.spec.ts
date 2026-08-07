import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLogGc } from "./log-gc.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-log-gc-"));
}

function makeChannelsDir(logsDir: string): string {
	const dir = path.join(logsDir, "channels");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeFile(filePath: string, content = "x"): void {
	fs.writeFileSync(filePath, content);
}

/**
 * Backdate a file's mtime by the given number of days.
 */
function backdate(filePath: string, days: number): void {
	const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	fs.utimesSync(filePath, past, past);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runLogGc", () => {
	let tmpDir: string;
	let channelsDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		channelsDir = makeChannelsDir(tmpDir);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("deletes files older than maxAgeDays", async () => {
		const oldFile = path.join(channelsDir, "old-channel.jsonl");
		const newFile = path.join(channelsDir, "new-channel.jsonl");
		writeFile(oldFile);
		writeFile(newFile);
		backdate(oldFile, 35); // older than 30 days
		// newFile stays at current mtime

		const deleted = await runLogGc(tmpDir, 30, new Set());

		expect(deleted).toBe(1);
		expect(fs.existsSync(oldFile)).toBe(false);
		expect(fs.existsSync(newFile)).toBe(true);
	});

	it("skips files whose channelId is in activeChannelIds", async () => {
		const activeFile = path.join(channelsDir, "active-ch.jsonl");
		writeFile(activeFile);
		backdate(activeFile, 60); // very old

		const deleted = await runLogGc(tmpDir, 30, new Set(["active-ch"]));

		expect(deleted).toBe(0);
		expect(fs.existsSync(activeFile)).toBe(true);
	});

	it("keeps everything when maxAgeDays === 0", async () => {
		const oldFile = path.join(channelsDir, "very-old.jsonl");
		writeFile(oldFile);
		backdate(oldFile, 365);

		const deleted = await runLogGc(tmpDir, 0, new Set());

		expect(deleted).toBe(0);
		expect(fs.existsSync(oldFile)).toBe(true);
	});

	it("returns 0 gracefully when channels/ directory does not exist", async () => {
		const missingDir = path.join(tmpDir, "no-such-dir");
		const deleted = await runLogGc(missingDir, 30, new Set());
		expect(deleted).toBe(0);
	});

	it("ignores non-.jsonl files in the channels directory", async () => {
		const txtFile = path.join(channelsDir, "something.txt");
		writeFile(txtFile);
		backdate(txtFile, 60);

		const deleted = await runLogGc(tmpDir, 30, new Set());

		expect(deleted).toBe(0);
		expect(fs.existsSync(txtFile)).toBe(true);
	});

	it("deletes multiple old files and returns correct count", async () => {
		for (let i = 0; i < 5; i++) {
			const f = path.join(channelsDir, `ch-${i}.jsonl`);
			writeFile(f);
			backdate(f, 40);
		}
		// One active channel should survive even though it's old
		const activeFile = path.join(channelsDir, "ch-active.jsonl");
		writeFile(activeFile);
		backdate(activeFile, 40);

		const deleted = await runLogGc(tmpDir, 30, new Set(["ch-active"]));

		expect(deleted).toBe(5);
		expect(fs.existsSync(activeFile)).toBe(true);
	});
});
