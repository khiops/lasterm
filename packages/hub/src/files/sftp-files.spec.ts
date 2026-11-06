import { EventEmitter } from "node:events";
import { mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SftpServerOptions } from "../session/sftp-server.fixture.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { failsWith, LOCAL_ROUND_TRIP_NAMES } from "./file-names.fixture.js";
import { WINDOWS_ROOT } from "./host-paths.js";
import { SFTP_IDLE_MS, SftpFileBackend, SharedSftp } from "./sftp-files.js";
import { type MockSshHost, startMockSshHost } from "./ssh-host.fixture.js";

const windowsMachine = process.platform === "win32";

/** A mock host whose SFTP serves `root` as a POSIX or a Windows host would show it. */
function useHost(style: "posix" | "windows", options: SftpServerOptions = {}, idleMs?: number) {
	const state = {} as {
		root: string;
		host: MockSshHost;
		shared: SharedSftp;
		files: SftpFileBackend;
	};
	beforeEach(async () => {
		state.root = makeTempDir("lasterm-sftp-files-");
		state.host = await startMockSshHost({ ...options, view: { style, root: state.root } });
		state.shared = new SharedSftp(state.host.client, idleMs);
		state.files = new SftpFileBackend(state.shared, style);
	});
	afterEach(async () => {
		state.shared.close();
		await state.host.close();
		await removeTempDir(state.root);
	});
	return state;
}

describe("a POSIX host's files over SFTP", () => {
	const state = useHost("posix");
	const home = () => join(state.root, "home", "test");
	beforeEach(() => {
		mkdirSync(home(), { recursive: true });
	});

	it("starts at the home folder the server gives", async () => {
		expect(await state.files.home()).toBe("/home/test");
	});

	it("lists a folder's entries with their kind, size and time, and no . or ..", async () => {
		mkdirSync(join(home(), "sub"));
		writeFileSync(join(home(), "file.txt"), "12345");
		writeFileSync(join(home(), ".hidden"), "");
		utimesSync(join(home(), "file.txt"), 1_700_000_000, 1_700_000_000);

		const shown = await state.files.list("/home/test", false);
		expect(shown.map((entry) => entry.name).sort()).toEqual(["file.txt", "sub"]);
		expect(shown.find((entry) => entry.name === "file.txt")).toEqual({
			name: "file.txt",
			kind: "file",
			size: 5,
			mtime: "2023-11-14T22:13:20.000Z",
		});
		expect(shown.find((entry) => entry.name === "sub")).toMatchObject({ kind: "directory" });
		const all = (await state.files.list("/home/test", true)).map((entry) => entry.name);
		expect(all.sort()).toEqual([".hidden", "file.txt", "sub"]);
	});

	it("reads a folder the server answers in several batches", async () => {
		for (let i = 0; i < 150; i++) writeFileSync(join(home(), `f${i}`), "");
		expect(await state.files.list("/home/test", false)).toHaveLength(150);
	});

	it.skipIf(windowsMachine)(
		"says what a link holds and where it leads (readdir is lstat)",
		async () => {
			mkdirSync(join(home(), "target"));
			symlinkSync("target", join(home(), "to-dir"));
			symlinkSync("nowhere", join(home(), "broken"));

			const entries = await state.files.list("/home/test", false);
			expect(entries.find((entry) => entry.name === "to-dir")).toMatchObject({
				kind: "symlink",
				linkTarget: "target",
				linkKind: "directory",
			});
			expect(entries.find((entry) => entry.name === "broken")).toMatchObject({
				kind: "symlink",
				linkKind: "missing",
			});
			expect(await state.files.stat("/home/test/to-dir")).toMatchObject({
				name: "to-dir",
				kind: "symlink",
				linkKind: "directory",
			});
		},
	);

	it("tells a missing folder from a file, which SFTP v3 calls both 'No such file'", async () => {
		writeFileSync(join(home(), "file"), "");
		await failsWith(state.files.list("/home/test/missing", false), "NOT_FOUND");
		await failsWith(state.files.list("/home/test/file", false), "NOT_A_DIRECTORY");
		await failsWith(state.files.stat("/home/test/missing"), "NOT_FOUND");
	});

	it("says what a path is", async () => {
		writeFileSync(join(home(), "f"), "abc");
		expect(await state.files.stat("/home/test/f")).toMatchObject({
			name: "f",
			kind: "file",
			size: 3,
		});
		expect(await state.files.stat("/home/test")).toMatchObject({ name: "test", kind: "directory" });
	});

	it("creates a folder; one that exists, or a missing parent, is said as such", async () => {
		await state.files.mkdir("/home/test/new");
		expect(statSync(join(home(), "new")).isDirectory()).toBe(true);
		await failsWith(state.files.mkdir("/home/test/new"), "ALREADY_EXISTS");
		await failsWith(state.files.mkdir("/home/test/missing/new"), "NOT_FOUND");
	});

	it.skipIf(windowsMachine)("refuses a parent that is a file as not a folder", async () => {
		writeFileSync(join(home(), "file"), "");
		await failsWith(state.files.mkdir("/home/test/file/new"), "NOT_A_DIRECTORY");
	});

	it.each(LOCAL_ROUND_TRIP_NAMES)("round-trips the name %j", async (name) => {
		await state.files.mkdir(`/home/test/${name}`);
		writeFileSync(join(home(), name, name), "x");
		expect((await state.files.list("/home/test", false)).map((entry) => entry.name)).toEqual([
			name,
		]);
		expect(
			(await state.files.list(`/home/test/${name}`, false)).map((entry) => entry.name),
		).toEqual([name]);
	});

	it("leaves free space to another way when the server has no statvfs@openssh.com", async () => {
		const message = await failsWith(state.files.freeSpace("/home/test"), "FILE_ACCESS_FAILED");
		expect(message).toContain("does not report free space");
	});
});

describe("a Windows host's files over SFTP, as Win32-OpenSSH serves them", () => {
	const state = useHost("windows");
	const home = () => join(state.root, "C", "Users", "test");
	beforeEach(() => {
		mkdirSync(home(), { recursive: true });
		mkdirSync(join(state.root, "D"));
	});

	it("starts at the home realpath gives as /C:/Users/test, in its Windows form", async () => {
		expect(await state.files.home()).toBe("C:\\Users\\test");
	});

	it("lists the drives at the root", async () => {
		expect(await state.files.list(WINDOWS_ROOT, false)).toEqual([
			{ name: "C:", kind: "directory", size: null, mtime: null },
			{ name: "D:", kind: "directory", size: null, mtime: null },
		]);
		expect(await state.files.stat(WINDOWS_ROOT)).toMatchObject({ kind: "directory" });
	});

	it("lists a drive-absolute folder, sent as it is", async () => {
		writeFileSync(join(home(), "notes.txt"), "1");
		expect((await state.files.list("C:\\Users\\test", false)).map((entry) => entry.name)).toEqual([
			"notes.txt",
		]);
		expect(await state.files.stat("C:\\Users\\test\\notes.txt")).toMatchObject({
			name: "notes.txt",
			kind: "file",
		});
		expect((await state.files.list("C:\\", false)).map((entry) => entry.name)).toEqual(["Users"]);
	});

	it("says a folder exists though the server answers mkdir with a generic failure", async () => {
		await state.files.mkdir("C:\\Users\\test\\new");
		expect(statSync(join(home(), "new")).isDirectory()).toBe(true);
		await failsWith(state.files.mkdir("C:\\Users\\test\\new"), "ALREADY_EXISTS");
		await failsWith(state.files.mkdir("C:\\Users\\test\\missing\\new"), "NOT_FOUND");
		await failsWith(state.files.list("C:\\Users\\test\\missing", false), "NOT_FOUND");
	});

	it.each(LOCAL_ROUND_TRIP_NAMES)("round-trips the name %j", async (name) => {
		await state.files.mkdir(`C:\\Users\\test\\${name}`);
		writeFileSync(join(home(), name, name), "x");
		expect((await state.files.list("C:\\Users\\test", false)).map((entry) => entry.name)).toEqual([
			name,
		]);
		expect(
			(await state.files.list(`C:\\Users\\test\\${name}`, false)).map((entry) => entry.name),
		).toEqual([name]);
	});
});

describe("one SFTP session per connection", () => {
	const state = useHost("posix", {}, 150);
	beforeEach(() => {
		mkdirSync(join(state.root, "home", "test"), { recursive: true });
	});

	it("is shared by every request, and closed once unused for its idle time", async () => {
		expect(SFTP_IDLE_MS).toBe(60_000);
		await Promise.all([
			state.files.list("/home/test", false),
			state.files.list("/home/test", false),
			state.files.stat("/home/test"),
		]);
		await state.files.home();
		expect(state.host.server.sftpRequests()).toBe(1);

		await vi.waitFor(() => expect(state.host.server.sftpClosures()).toBe(1), { timeout: 5_000 });
		await state.files.list("/home/test", false);
		expect(state.host.server.sftpRequests()).toBe(2);
	});
});

describe("a connection lost under an SFTP request", () => {
	const state = useHost("posix", { closeOnRequest: { type: "OPENDIR", connection: true } });

	it("fails it with HOST_NOT_CONNECTED, and every later one", async () => {
		mkdirSync(join(state.root, "home", "test"), { recursive: true });
		await failsWith(state.files.list("/home/test", false), "HOST_NOT_CONNECTED");
		expect(state.host.server.firedRequest()).toBe("OPENDIR");
		await failsWith(state.files.stat("/home/test"), "HOST_NOT_CONNECTED");
	});
});

describe("an SFTP channel closed under a request, the connection still up", () => {
	const state = useHost("posix", { closeOnRequest: { type: "OPENDIR" } });

	it("fails that request without a verdict, and the next one opens another session", async () => {
		mkdirSync(join(state.root, "home", "test"), { recursive: true });
		const message = await failsWith(state.files.list("/home/test", false), "FILE_ACCESS_FAILED");
		expect(message).toContain("SFTP channel closed");
		expect(await state.files.list("/home/test", false)).toEqual([]);
		expect(state.host.server.sftpRequests()).toBe(2);
	});
});

describe("free space over SFTP", () => {
	/** A session whose server offers statvfs@openssh.com, which the mock server cannot. */
	function statvfsSession(reply: (path: string) => object): SharedSftp {
		const channel = Object.assign(new EventEmitter(), {
			ext_openssh_statvfs: vi.fn(
				(path: string, cb: (err: Error | undefined, info: object) => void) =>
					setImmediate(() => cb(undefined, reply(path))),
			),
			end: vi.fn(),
		}) as unknown as SFTPWrapper;
		const client = Object.assign(new EventEmitter(), {
			sftp: (cb: (err: Error | undefined, sftp: SFTPWrapper) => void) => cb(undefined, channel),
		}) as unknown as Client;
		return new SharedSftp(client);
	}

	it("is what statvfs@openssh.com says the user may still write, in bytes", async () => {
		const shared = statvfsSession(() => ({
			f_bsize: 4096,
			f_frsize: 4096,
			f_blocks: 1000,
			f_bfree: 300,
			f_bavail: 250,
		}));
		const files = new SftpFileBackend(shared, "posix");
		expect(await files.freeSpace("/srv")).toEqual({ available: 250 * 4096, total: 1000 * 4096 });
		shared.close();
	});
});
