import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_LOG_ENV, openDaemonLog } from "../daemon-launch.js";
import {
	boundDaemonLog,
	checkBeforeEachLine,
	DaemonLogBound,
	type OutputStream,
	previousDaemonLogPath,
	takeDaemonLogPath,
} from "./daemon-log.js";

/** Small enough that a few dozen lines move the file aside several times. */
const LIMIT = 256;

let dirs: string[] = [];
let descriptors: number[] = [];
let bounds: DaemonLogBound[] = [];

afterEach(() => {
	for (const bound of bounds) bound.close();
	for (const fd of descriptors) closeSync(fd);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
	bounds = [];
	descriptors = [];
	dirs = [];
});

/** A bound on `file`, whose lines go through the launch's descriptor. */
function boundOn(
	file: { path: string; launchFd: number },
	report: (message: string) => void = () => {},
): DaemonLogBound {
	const bound = new DaemonLogBound(file.path, report, LIMIT, file.launchFd);
	bounds.push(bound);
	return bound;
}

/**
 * `hub-daemon.log` in a directory of its own, and the descriptor a daemon
 * launch opens on it: the child's standard output and error, which the child
 * keeps and writes through for as long as it runs.
 */
function daemonLogFile(): { path: string; previous: string; launchFd: number } {
	const dir = mkdtempSync(join(tmpdir(), "lasterm-daemon-log-"));
	dirs.push(dir);
	const path = join(dir, "hub-daemon.log");
	const launchFd = openDaemonLog(path);
	descriptors.push(launchFd);
	return { path, previous: previousDaemonLogPath(path), launchFd };
}

function line(n: number): string {
	return `line ${String(n).padStart(4, "0")} of the hub's output\n`;
}

function read(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function size(path: string): number {
	return existsSync(path) ? statSync(path).size : 0;
}

/** The numbers of the lines the two files hold, the previous file first. */
function kept(path: string): number[] {
	return (read(previousDaemonLogPath(path)) + read(path))
		.split("\n")
		.filter((text) => text.length > 0)
		.map((text) => {
			const n = Number(text.split(" ")[1]);
			if (!Number.isInteger(n)) throw new Error(`not a line this test wrote: ${text}`);
			return n;
		});
}

/** What was kept is the end of what was written, in order and without a gap. */
function expectKeptTail(path: string, written: number): void {
	const lines = kept(path);
	const first = written - lines.length;
	expect(lines).toEqual(Array.from({ length: lines.length }, (_, i) => first + i));
	// Enough lines went through for the file to move aside more than once.
	expect(first).toBeGreaterThan((2 * LIMIT) / line(0).length);
}

describe("DaemonLogBound", () => {
	// Mutation: never move the file aside, and it grows by every line for as long
	// as the daemon runs, which is the defect. Rename it instead, as the desktop
	// does, and the launch's descriptor goes on writing to the previous file:
	// that file passes the limit, and on Windows the next rename fails with EPERM
	// because that descriptor holds it open.
	it("moves what the file holds aside when a line would take it past the limit, again and again", () => {
		const file = daemonLogFile();
		const bound = boundOn(file);
		const written = 40;
		for (let n = 0; n < written; n++) {
			bound.beforeLine(line(n).length);
			writeSync(file.launchFd, line(n));
		}

		expect(size(file.path)).toBeLessThanOrEqual(LIMIT);
		expect(size(file.previous)).toBeGreaterThan(0);
		expect(size(file.previous)).toBeLessThanOrEqual(LIMIT);
		expectKeptTail(file.path, written);
	});

	// Mutation: count only the lines checked here, from zero, and a log inherited
	// from months without a bound stays as it is.
	it("moves a log already past the limit aside before its next line", () => {
		const file = daemonLogFile();
		const inherited = "x".repeat(4 * LIMIT);
		writeFileSync(file.path, inherited);

		boundOn(file).beforeLine(line(0).length);
		writeSync(file.launchFd, line(0));

		expect(read(file.path)).toBe(line(0));
		expect(read(file.previous)).toBe(inherited);
	});

	// Something holding the previous file, a viewer following it say, can refuse
	// the copy for a while. The hub goes on writing all the same.
	// Mutation: empty the file when the copy failed, and those lines are gone;
	// say so on every line, and the report buries the log it is about.
	it("keeps every line of a log that cannot be moved aside, until it can", () => {
		const file = daemonLogFile();
		// A directory where the previous file goes: no copy can replace it.
		mkdirSync(file.previous);
		const reports: string[] = [];
		const bound = boundOn(file, (message) => reports.push(message));
		const held = 20;
		for (let n = 0; n < held; n++) {
			bound.beforeLine(line(n).length);
			writeSync(file.launchFd, line(n));
		}
		const all = Array.from({ length: held }, (_, n) => line(n)).join("");
		expect(read(file.path)).toBe(all);
		expect(reports).toEqual([expect.stringContaining(`cannot copy ${file.path}`)]);

		rmdirSync(file.previous);
		bound.beforeLine(line(held).length);
		writeSync(file.launchFd, line(held));

		expect(read(file.previous)).toBe(all);
		expect(read(file.path)).toBe(line(held));
	});
});

/** A stream writing to the launch's descriptor, as the daemon's standard output does. */
function launchStream(fd: number): OutputStream & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		write: ((...args: unknown[]) => {
			calls.push(args);
			const chunk = args[0];
			if (typeof chunk === "string") writeSync(fd, chunk);
			else writeSync(fd, chunk as Uint8Array);
			return true;
		}) as OutputStream["write"],
	};
}

/** How many bytes the file behind `fd` holds, whether or not a name still leads to it. */
function sizeBehind(fd: number): number {
	return fstatSync(fd).size;
}

describe("checkBeforeEachLine", () => {
	// Mutation: stop checking, and whatever console.log and pino write grows the
	// file without bound.
	it("checks the limit before each line the stream writes, and writes every line where it went", () => {
		const file = daemonLogFile();
		const stream = launchStream(file.launchFd);
		checkBeforeEachLine(boundOn(file), [stream]);
		const done = () => {};
		const written = 40;
		for (let n = 0; n < written; n++) {
			if (n % 2 === 0) stream.write(line(n), done);
			else stream.write(Buffer.from(line(n)));
		}

		expect(size(file.path)).toBeLessThanOrEqual(LIMIT);
		expect(size(file.previous)).toBeLessThanOrEqual(LIMIT);
		expectKeptTail(file.path, written);
		// The stream's own write still carries each line, with its callback.
		expect(stream.calls).toHaveLength(written);
		expect(stream.calls[0]).toEqual([line(0), done, undefined]);
	});
});

describe("a daemon log that loses its name while the hub runs (#540)", () => {
	// Mutation: leave a missing path alone, as before, and every line goes on to
	// the deleted file: a file nobody can open, grown without bound.
	it("writes to the path again once the file was deleted, within the limit", async () => {
		const file = daemonLogFile();
		const stream = launchStream(file.launchFd);
		checkBeforeEachLine(boundOn(file), [stream]);
		const before = 3;
		for (let n = 0; n < before; n++) stream.write(line(n));

		unlinkSync(file.path);
		const deleted = sizeBehind(file.launchFd);
		expect(deleted).toBe(before * line(0).length);
		const done = vi.fn();
		const written = before + 40;
		for (let n = before; n < written; n++) {
			if (n % 2 === 0) stream.write(line(n), done);
			else stream.write(Buffer.from(line(n)));
		}

		// The deleted file took nothing more; the lines are at the path again.
		expect(sizeBehind(file.launchFd)).toBe(deleted);
		expect(size(file.path)).toBeGreaterThan(0);
		expect(size(file.path)).toBeLessThanOrEqual(LIMIT);
		expect(size(file.previous)).toBeLessThanOrEqual(LIMIT);
		expectKeptTail(file.path, written);
		// Each callback is still called, once the line is written.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(done).toHaveBeenCalledTimes(20);
		expect(done).toHaveBeenCalledWith(null);
	});

	// Mutation: notice only a path with nothing at it, and after a move the lines
	// go on to the moved file, however large it grows, while the file now at the
	// path goes unchecked.
	it("appends to the file that took the name when the one it wrote was moved away", () => {
		const file = daemonLogFile();
		const stream = launchStream(file.launchFd);
		checkBeforeEachLine(boundOn(file), [stream]);
		stream.write(line(0));

		const moved = `${file.path}.moved`;
		renameSync(file.path, moved);
		writeFileSync(file.path, "a start that lost the lock\n");
		stream.write(line(1));
		stream.write(line(2));

		expect(read(moved)).toBe(line(0));
		expect(read(file.path)).toBe(`a start that lost the lock\n${line(1)}${line(2)}`);
	});

	// Mutation: say it through the stream's own descriptor, as before, and after
	// a deletion the report lands in the deleted file, where nobody reads it.
	it("says what went wrong in the file the lines now go to", () => {
		const file = daemonLogFile();
		const stdout = launchStream(file.launchFd);
		const stderr = launchStream(file.launchFd);
		const bound = boundDaemonLog(
			{ [DAEMON_LOG_ENV]: file.path },
			{ stdout, stderr, maxBytes: LIMIT, descriptor: file.launchFd },
		);
		if (bound) bounds.push(bound);
		stdout.write(line(0));
		unlinkSync(file.path);
		const deleted = sizeBehind(file.launchFd);
		// Nothing can replace the previous file, so the new one cannot move aside.
		mkdirSync(file.previous);

		const written = 20;
		for (let n = 1; n <= written; n++) stdout.write(line(n));

		expect(sizeBehind(file.launchFd)).toBe(deleted);
		const lines = read(file.path).split("\n");
		expect(lines.filter((text) => text.startsWith("[lasterm] cannot copy"))).toHaveLength(1);
		expect(lines.filter((text) => text.startsWith("line "))).toHaveLength(written);
	});
});

describe("bounding the daemon log", () => {
	// Mutation: leave the variable in the environment, and the agent, then every
	// shell it starts, inherits it: a hub started from one of those terminals
	// would take the daemon's log for its own.
	it("takes the log's path out of the environment", () => {
		const env: NodeJS.ProcessEnv = { [DAEMON_LOG_ENV]: "/state/hub-daemon.log", OTHER: "kept" };

		expect(takeDaemonLogPath(env)).toBe("/state/hub-daemon.log");
		expect(env).toEqual({ OTHER: "kept" });
		expect(takeDaemonLogPath(env)).toBeUndefined();
	});

	it("checks both streams against the log the launch named, and neither when there is none", () => {
		const file = daemonLogFile();
		const plain = { write: () => true } as unknown as OutputStream;
		const untouched = plain.write;
		expect(boundDaemonLog({}, { stdout: plain, stderr: plain })).toBeUndefined();
		expect(plain.write).toBe(untouched);

		const stdout = { write: (chunk: string) => writeSync(file.launchFd, chunk) > 0 };
		const stderr = { write: (chunk: string) => writeSync(file.launchFd, chunk) > 0 };
		const env: NodeJS.ProcessEnv = { [DAEMON_LOG_ENV]: file.path };
		const bound = boundDaemonLog(env, {
			stdout: stdout as unknown as OutputStream,
			stderr: stderr as unknown as OutputStream,
			maxBytes: LIMIT,
			descriptor: file.launchFd,
		});
		if (bound) bounds.push(bound);

		expect(bound?.path).toBe(file.path);
		expect(env).toEqual({});
		for (let n = 0; n < 40; n++) (n % 2 === 0 ? stdout : stderr).write(line(n));
		expect(size(file.path)).toBeLessThanOrEqual(LIMIT);
		expectKeptTail(file.path, 40);
	});
});
