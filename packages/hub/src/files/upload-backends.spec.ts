import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { ExecFileBackend } from "./exec-files.js";
import { ExecUploadBackend } from "./exec-upload.js";
import { failsWith } from "./file-names.fixture.js";
import { startMockSshHost } from "./ssh-host.fixture.js";
import {
	keepBothName,
	type OpenOptions,
	TargetExists,
	tempPathFor,
	VerifyFailed,
} from "./upload-backend.js";
import {
	execBackend,
	sftpBackend,
	UPLOAD_BACKENDS,
	type UploadHarness,
	windowsMachine,
} from "./upload-backends.fixture.js";

// #868, temporary: what the Linux runner's worker was doing when it died.
const trace868 = (line: string): void => {
	try {
		writeSync(2, `[868] ${new Date().toISOString()} pid ${process.pid} ${line}\n`);
	} catch {
		// Nowhere to say it.
	}
};
if (process.platform === "linux") {
	try {
		trace868(
			`ps ${execFileSync("ps", ["-o", "pid=,ppid=,pgid=,sid=,rss=", "-p", String(process.pid)])
				.toString()
				.trim()}`,
		);
	} catch (error) {
		trace868(`ps failed: ${String(error)}`);
	}
	for (const signal of [
		"SIGTERM",
		"SIGINT",
		"SIGHUP",
		"SIGQUIT",
		"SIGUSR2",
		"SIGALRM",
		"SIGXCPU",
		"SIGXFSZ",
	] as const) {
		process.once(signal, () => {
			trace868(`got ${signal}`);
			process.kill(process.pid, signal);
		});
	}
	process.on("exit", (code) => trace868(`exit ${code}`));
	beforeEach((context) =>
		trace868(
			`start ${context.task.suite?.name} > ${context.task.name} rss=${process.memoryUsage().rss}`,
		),
	);
	afterEach((context) => trace868(`end ${context.task.name} ${context.task.result?.state}`));
}

const MTIME = 1_700_000_000_000;

function options(size: number, extra: Partial<OpenOptions> = {}): OpenOptions {
	return { resumeAt: 0, size, mtime: MTIME, hash: false, ...extra };
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Write `data` to a new temporary for `target`, in chunks, and finish it. */
async function sendWhole(
	h: UploadHarness,
	target: string,
	data: Buffer,
	chunk = 70_000,
): Promise<string> {
	const temp = tempPathFor(target, h.backend.style);
	const sink = await h.backend.open(temp, options(data.length));
	for (let at = 0; at < data.length; at += chunk) {
		await sink.write(data.subarray(at, at + chunk), at);
	}
	await sink.finish(null);
	return temp;
}

/** Bytes that are not all the same, so that a chunk out of place shows. */
function bytes(length: number): Buffer {
	const data = Buffer.alloc(length);
	for (let i = 0; i < length; i++) data[i] = (i * 7 + (i >> 8)) & 0xff;
	return data;
}

describe("the names an upload writes under", () => {
	it("hides a temporary beside its target, and keeps it within a name's bytes and Windows' MAX_PATH", () => {
		expect(tempPathFor("/srv/a.txt", "posix", "0123456789abcdef")).toBe(
			"/srv/.a.txt.0123456789abcdef.partial",
		);
		const long = `C:\\${"d".repeat(200)}\\${"n".repeat(50)}.txt`;
		const temp = tempPathFor(long, "windows");
		expect(temp.length).toBeLessThanOrEqual(259);
		expect(temp).toMatch(/\\\.n+\.[0-9a-f]{16}\.partial$/);
		const posix = tempPathFor(`/x/${"é".repeat(127)}`, "posix");
		expect(Buffer.byteLength(posix.slice(3))).toBeLessThanOrEqual(255);
	});

	it("numbers a copy before its extension, a folder or a dot file after its name", () => {
		expect(keepBothName("report.pdf", 1, "file")).toBe("report (1).pdf");
		expect(keepBothName("archive.tar.gz", 2, "file")).toBe("archive.tar (2).gz");
		expect(keepBothName(".bashrc", 1, "file")).toBe(".bashrc (1)");
		expect(keepBothName("v1.2", 1, "dir")).toBe("v1.2 (1)");
	});
});

describe.each(UPLOAD_BACKENDS.filter((kind) => kind.runs))("an upload over $name", (kind) => {
	const use = async (test: (h: UploadHarness) => Promise<void>) => {
		const h = await kind.start();
		try {
			await test(h);
		} finally {
			await h.close();
		}
	};

	it("writes a file in chunks to a temporary, keeps its time, and places it", () =>
		use(async (h) => {
			const data = bytes(300_000);
			const target = h.at("a file.bin");
			const temp = await sendWhole(h, target, data);
			expect(existsSync(h.local(target))).toBe(false);
			expect(readFileSync(h.local(temp))).toEqual(data);
			expect(await h.backend.place(temp, target, false)).toEqual({ kind: "placed" });
			expect(readFileSync(h.local(target))).toEqual(data);
			expect(Math.round(statSync(h.local(target)).mtimeMs / 1000)).toBe(MTIME / 1000);
			expect(existsSync(h.local(temp))).toBe(false);
		}));

	it("cuts a temporary to the bytes its host acknowledged, then appends from there (#860)", () =>
		use(async (h) => {
			const data = bytes(200_000);
			const target = h.at("resumed.bin");
			const temp = tempPathFor(target, h.backend.style);
			const first = await h.backend.open(temp, options(data.length));
			await first.write(data.subarray(0, 150_000), 0);
			await first.abort();
			await h.backend.truncate(temp, 100_000);
			expect(statSync(h.local(temp)).size).toBe(100_000);
			expect(readFileSync(h.local(temp))).toEqual(data.subarray(0, 100_000));
			const rest = await h.backend.open(temp, options(data.length, { resumeAt: 100_000 }));
			await rest.write(data.subarray(100_000), 100_000);
			expect(await rest.finish(null)).toBe("size");
			expect(readFileSync(h.local(temp))).toEqual(data);
			await expect(h.backend.truncate(h.at("not there.bin"), 0)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		}));

	it("never replaces a file that has the name, whether it was there first or appeared meanwhile", () =>
		use(async (h) => {
			const before = h.at("there before.txt");
			writeFileSync(h.local(before), "theirs");
			const temp = await sendWhole(h, before, Buffer.from("ours"));
			const refused = await h.backend.place(temp, before, false);
			expect(refused).toMatchObject({ kind: "exists" });
			expect(readFileSync(h.local(before), "utf8")).toBe("theirs");
			expect(readFileSync(h.local(temp), "utf8")).toBe("ours");

			// The bytes are sent, the name free; it is taken before the file is placed.
			const late = h.at("appeared.txt");
			const lateTemp = await sendWhole(h, late, Buffer.from("ours"));
			writeFileSync(h.local(late), "theirs");
			expect(await h.backend.place(lateTemp, late, false)).toMatchObject({ kind: "exists" });
			expect(readFileSync(h.local(late), "utf8")).toBe("theirs");

			// A folder of that name is not replaced either.
			const folder = h.at("a folder");
			mkdirSync(h.local(folder));
			const folderTemp = await sendWhole(h, folder, Buffer.from("ours"));
			expect(await h.backend.place(folderTemp, folder, false)).toMatchObject({ kind: "exists" });
			expect(statSync(h.local(folder)).isDirectory()).toBe(true);
			await expect(h.backend.place(folderTemp, folder, true)).rejects.toThrow();
			expect(statSync(h.local(folder)).isDirectory()).toBe(true);
		}));

	it("replaces only when asked", () =>
		use(async (h) => {
			const target = h.at("replaced.txt");
			writeFileSync(h.local(target), "theirs");
			const temp = await sendWhole(h, target, Buffer.from("ours"));
			expect(await h.backend.place(temp, target, true)).toEqual({ kind: "placed" });
			expect(readFileSync(h.local(target), "utf8")).toBe("ours");
			expect(existsSync(h.local(temp))).toBe(false);
		}));

	it("creates a temporary exclusively: a name taken is said, not written over", () =>
		use(async (h) => {
			const temp = h.at(".taken.partial");
			writeFileSync(h.local(temp), "theirs");
			const opened = h.backend.open(temp, options(4)).then(async (sink) => {
				await sink.write(Buffer.from("ours"), 0);
				return sink.finish(null);
			});
			await expect(opened).rejects.toBeInstanceOf(TargetExists);
			expect(readFileSync(h.local(temp), "utf8")).toBe("theirs");
		}));

	it("says a missing folder is missing, not a conflict", () =>
		use(async (h) => {
			const temp = tempPathFor(h.at("nowhere", "x.txt"), h.backend.style);
			const opened = h.backend.open(temp, options(1)).then(async (sink) => {
				await sink.write(Buffer.from("x"), 0);
				return sink.finish(null);
			});
			await failsWith(opened, "NOT_FOUND");
		}));

	it("resumes a temporary where its bytes end", () =>
		use(async (h) => {
			const data = bytes(200_000);
			const target = h.at("resumed.bin");
			const temp = tempPathFor(target, h.backend.style);
			const first = await h.backend.open(temp, options(data.length));
			await first.write(data.subarray(0, 120_000), 0);
			await first.abort();
			expect(statSync(h.local(temp)).size).toBe(120_000);
			const second = await h.backend.open(temp, options(data.length, { resumeAt: 120_000 }));
			await second.write(data.subarray(120_000), 120_000);
			await second.finish(null);
			expect(readFileSync(h.local(temp))).toEqual(data);
		}));

	it("creates folders, merges into one that is there, and says what is not a folder", () =>
		use(async (h) => {
			mkdirSync(h.local(h.at("there")));
			writeFileSync(h.local(h.at("a file")), "");
			const results = await h.backend.mkdirs([
				h.at("new"),
				h.at("new", "inner"),
				h.at("there"),
				h.at("a file"),
			]);
			expect(results.map((result) => result.kind)).toEqual([
				"created",
				"created",
				"merged",
				"clash",
			]);
			expect(statSync(h.local(h.at("new", "inner"))).isDirectory()).toBe(true);
		}));

	it.runIf(kind.transport === "exec")(
		"checks the SHA-256 the host computes against the hub's",
		() =>
			use(async (h) => {
				const data = bytes(50_000);
				const target = h.at("hashed.bin");
				const good = tempPathFor(target, h.backend.style);
				const sink = await h.backend.open(good, options(data.length, { hash: true }));
				await sink.write(data, 0);
				expect(await sink.finish(sha256(data))).toBe("sha256");

				// The hub sent other bytes than the host holds: the file is not to be placed.
				const bad = tempPathFor(target, h.backend.style);
				const other = await h.backend.open(bad, options(data.length, { hash: true }));
				await other.write(data, 0);
				const changed = Buffer.from(data);
				changed[1000] = (changed[1000] ?? 0) ^ 0xff;
				const failed = await other.finish(sha256(changed)).catch((error: unknown) => error);
				expect(failed).toBeInstanceOf(VerifyFailed);
				expect((failed as VerifyFailed).code).toBe("HASH_MISMATCH");
			}),
	);

	it("says the size the host holds when it is not the file's", () =>
		use(async (h) => {
			const temp = tempPathFor(h.at("short.bin"), h.backend.style);
			const sink = await h.backend.open(temp, options(10));
			await sink.write(Buffer.from("12345"), 0);
			const failed = await sink.finish(null).catch((error: unknown) => error);
			expect(failed).toBeInstanceOf(VerifyFailed);
			expect((failed as VerifyFailed).code).toBe("SIZE_MISMATCH");
		}));

	it("removes a file, and says nothing of one already gone", () =>
		use(async (h) => {
			writeFileSync(h.local(h.at("gone.txt")), "x");
			await h.backend.remove(h.at("gone.txt"));
			await h.backend.remove(h.at("gone.txt"));
			expect(existsSync(h.local(h.at("gone.txt")))).toBe(false);
		}));
});

// A POSIX host whose account finds no sha256sum, openssl or shasum on its PATH.
describe.skipIf(windowsMachine)("a POSIX host over SSH commands with no tool to hash with", () => {
	it("checks the size alone, and says the file was not hashed", async () => {
		const root = makeTempDir("lasterm-upload-nohash-");
		const bin = join(root, "bin");
		mkdirSync(bin);
		for (const tool of ["sh", "cat", "wc", "touch"]) {
			const found = ["/usr/bin", "/bin"]
				.map((dir) => join(dir, tool))
				.find((path) => existsSync(path));
			if (found === undefined) throw new Error(`no ${tool} on this machine`);
			symlinkSync(found, join(bin, tool));
		}
		mkdirSync(join(root, "up"));
		const host = await startMockSshHost({ sftp: false, execEnv: { PATH: bin } });
		try {
			const backend = new ExecUploadBackend(
				host.client,
				"posix",
				() => false,
				new ExecFileBackend(host.client, "posix", () => false),
			);
			const data = bytes(10_000);
			const temp = tempPathFor(join(root, "up", "x.bin"), "posix");
			const sink = await backend.open(temp, options(data.length, { hash: true }));
			await sink.write(data, 0);
			expect(await sink.finish(sha256(data))).toBe("no_hash_tool");
			expect(readFileSync(temp)).toEqual(data);
		} finally {
			await host.close();
			await removeTempDir(root);
		}
	});
});

// Starting a PowerShell costs a second or more; a script in the upload's loop, milliseconds (#865).
describe.runIf(windowsMachine)("a Windows host over SSH commands", () => {
	it("starts a PowerShell per file it writes, and one for everything else an upload asks", async () => {
		const h = await execBackend("windows").start();
		try {
			const [made] = await h.backend.mkdirs([h.at("in")]);
			expect(made?.kind).toBe("created");
			const target = h.at("in", "a.txt");
			const first = await sendWhole(h, target, Buffer.from("a"));
			expect(await h.backend.place(first, target, false)).toEqual({ kind: "placed" });
			const second = await sendWhole(h, target, Buffer.from("b"));
			expect(await h.backend.place(second, target, false)).toMatchObject({
				kind: "exists",
				existing: { kind: "file", size: 1 },
			});
			await h.backend.remove(second);
			expect((await h.backend.list(h.at("in"))).map((entry) => entry.name)).toEqual(["a.txt"]);
			expect(await h.backend.stat(target)).toMatchObject({ kind: "file", size: 1 });
			expect((await h.backend.freeSpace(h.dir)).total).toBeGreaterThan(0);
			expect(readFileSync(h.local(target), "utf8")).toBe("a");
			expect(h.host?.server.execCommands).toHaveLength(3);
		} finally {
			await h.close();
		}
	});
});

describe("SFTP placement on each kind of server (Win32-OpenSSH 9.5 was checked for these)", () => {
	it("links with hardlink@openssh.com, which refuses a name that exists, and replaces with posix-rename", async () => {
		const h = await sftpBackend("windows", [
			"hardlink@openssh.com",
			"posix-rename@openssh.com",
		]).start();
		try {
			expect(await h.backend.placement(h.dir)).toBe("temp");
			const target = h.at("x.txt");
			writeFileSync(h.local(target), "theirs");
			const temp = await sendWhole(h, target, Buffer.from("ours"));
			expect(await h.backend.place(temp, target, false)).toMatchObject({ kind: "exists" });
			expect(readFileSync(h.local(target), "utf8")).toBe("theirs");
			expect(await h.backend.place(temp, target, true)).toEqual({ kind: "placed" });
			expect(readFileSync(h.local(target), "utf8")).toBe("ours");
		} finally {
			await h.close();
		}
	});

	it("places with the plain rename where it refuses, and writes under the name directly where it replaces", async () => {
		const refusing = await sftpBackend("posix", []).start();
		try {
			expect(await refusing.backend.placement(refusing.dir)).toBe("temp");
		} finally {
			await refusing.close();
		}
		const replacing = await sftpBackend("posix", [], { renameReplaces: true }).start();
		try {
			expect(await replacing.backend.placement(replacing.dir)).toBe("direct");
			// The probe leaves nothing behind.
			expect(readdirSync(replacing.local(replacing.dir))).toEqual([]);
			const target = replacing.at("direct.txt");
			writeFileSync(replacing.local(target), "theirs");
			await expect(replacing.backend.open(target, options(4))).rejects.toBeInstanceOf(TargetExists);
			expect(readFileSync(replacing.local(target), "utf8")).toBe("theirs");
		} finally {
			await replacing.close();
		}
	});
});
