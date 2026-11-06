import { chmodSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SftpServerOptions } from "../session/sftp-server.fixture.js";
import { WINDOWS_REPLY_MARKER } from "../session/ssh-file-transport.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import {
	ExecFileBackend,
	parseDfOutput,
	parsePosixGroups,
	parseWindowsEntries,
} from "./exec-files.js";
import { failsWith, roundTripNames } from "./file-names.fixture.js";
import { normaliseHostPath, WINDOWS_ROOT } from "./host-paths.js";
import { type MockSshHost, startMockSshHost } from "./ssh-host.fixture.js";

const windowsMachine = process.platform === "win32";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("what the POSIX scripts print, read back", () => {
	it("pairs each stat line with its name, follows links, and drops an entry gone meanwhile", () => {
		const names = `${["a dir", "new\nline", "gone", "link"].join("/")}/`;
		const encoded = b64(names);
		const lines = [
			"S",
			"41ed 4096 1700000000",
			"81a4 12 1700000001",
			"- - -",
			"a1ff 6 1700000002",
			"N",
			// base64 wraps its output at 76 columns.
			encoded.slice(0, 8),
			encoded.slice(8),
			"L",
			`4 41ed ${b64("a dir\n")}`,
			"E",
		];
		expect(parsePosixGroups(lines)).toEqual([
			{ name: "a dir", kind: "directory", size: null, mtime: "2023-11-14T22:13:20.000Z" },
			{ name: "new\nline", kind: "file", size: 12, mtime: "2023-11-14T22:13:21.000Z" },
			{
				name: "link",
				kind: "symlink",
				size: 6,
				mtime: "2023-11-14T22:13:22.000Z",
				linkTarget: "a dir",
				linkKind: "directory",
			},
		]);
	});

	it("says a link leads nowhere, and refuses names that do not match the stats", () => {
		const lines = ["S", "a1ff 3 0", "N", b64("x/"), "L", `1 - ${b64("nope\n")}`, "E"];
		expect(parsePosixGroups(lines)[0]).toMatchObject({ linkKind: "missing", linkTarget: "nope" });
		expect(() => parsePosixGroups(["S", "81a4 1 0", "N", b64("a/b/"), "L", "E"])).toThrow(
			"named 2 entries for 1",
		);
	});

	it("reads df -Pk in bytes", () => {
		expect(
			parseDfOutput([
				"Filesystem     1024-blocks    Used Available Capacity Mounted on",
				"/dev/sda1         1000000  400000    550000      43% /",
			]),
		).toEqual({ total: 1_000_000 * 1024, available: 550_000 * 1024 });
		expect(parseDfOutput(["nothing"])).toBeNull();
	});
});

describe("what the Windows scripts print, read back", () => {
	it("reads folders, files and folder links, their names from Base64", () => {
		expect(
			parseWindowsEntries([
				`d - 1700000000 ${b64("Program Files")}`,
				`f 42 1700000001 ${b64("it's 100%.txt")}`,
				`l - 1700000002 ${b64("Application Data")}`,
				`d - - ${b64("C:")}`,
				"garbage",
			]),
		).toEqual([
			{ name: "Program Files", kind: "directory", size: null, mtime: "2023-11-14T22:13:20.000Z" },
			{ name: "it's 100%.txt", kind: "file", size: 42, mtime: "2023-11-14T22:13:21.000Z" },
			{
				name: "Application Data",
				kind: "symlink",
				size: null,
				mtime: "2023-11-14T22:13:22.000Z",
				linkKind: "directory",
			},
			{ name: "C:", kind: "directory", size: null, mtime: null },
		]);
	});
});

/** The mock host with its exec on this machine, and the backend on its connection. */
function useExecHost(style: "posix" | "windows", options: SftpServerOptions = {}) {
	const state = {} as { root: string; host: MockSshHost; files: ExecFileBackend; lost: boolean };
	beforeEach(async () => {
		state.root = makeTempDir("lasterm-exec-files-");
		state.host = await startMockSshHost({ sftp: false, ...options });
		state.lost = false;
		state.files = new ExecFileBackend(state.host.client, style, () => state.lost);
	});
	afterEach(async () => {
		await state.host.close();
		chmodSync(state.root, 0o700);
		await removeTempDir(state.root);
	});
	return state;
}

describe("a host whose connection is gone, or that runs no command", () => {
	describe("gone", () => {
		const state = useExecHost("posix");
		it("fails every request with HOST_NOT_CONNECTED", async () => {
			await state.host.drop();
			state.lost = true;
			await failsWith(state.files.list("/", false), "HOST_NOT_CONNECTED");
			await failsWith(state.files.mkdir("/x"), "HOST_NOT_CONNECTED");
		});
	});
	describe("no command", () => {
		const state = useExecHost("posix", { exec: false });
		it("fails without a verdict, so another way may be tried", async () => {
			await failsWith(state.files.list("/", false), "FILE_ACCESS_FAILED");
		});
	});
});

// The mock server runs exec requests through /bin/sh, as an OpenSSH server
// does through the account's shell.
describe.skipIf(windowsMachine)("a POSIX host's files over SSH commands", () => {
	const state = useExecHost("posix");

	it("starts at $HOME", async () => {
		const home = normaliseHostPath(homedir(), "posix");
		expect(await state.files.home()).toBe(home.ok ? home.path : "");
		expect(state.host.server.execCommands).toEqual(["sh -s"]);
	});

	it("lists a folder's entries with their kind, size and time, hidden ones only when asked", async () => {
		mkdirSync(join(state.root, "sub"));
		mkdirSync(join(state.root, ".config"));
		writeFileSync(join(state.root, "file.txt"), "12345");
		writeFileSync(join(state.root, "..dots"), "");
		utimesSync(join(state.root, "file.txt"), 1_700_000_000, 1_700_000_000);

		const shown = await state.files.list(state.root, false);
		expect(shown.map((entry) => entry.name).sort()).toEqual(["file.txt", "sub"]);
		expect(shown.find((entry) => entry.name === "file.txt")).toEqual({
			name: "file.txt",
			kind: "file",
			size: 5,
			mtime: "2023-11-14T22:13:20.000Z",
		});
		const all = (await state.files.list(state.root, true)).map((entry) => entry.name);
		expect(all.sort()).toEqual(["..dots", ".config", "file.txt", "sub"]);
		expect(await state.files.list(join(state.root, "sub"), true)).toEqual([]);
	});

	it("says what a link holds and where it leads", async () => {
		mkdirSync(join(state.root, "target"));
		symlinkSync("target", join(state.root, "to-dir"));
		symlinkSync("no where\n", join(state.root, "broken"));
		const entries = await state.files.list(state.root, false);
		expect(entries.find((entry) => entry.name === "to-dir")).toMatchObject({
			kind: "symlink",
			linkTarget: "target",
			linkKind: "directory",
		});
		expect(entries.find((entry) => entry.name === "broken")).toMatchObject({
			kind: "symlink",
			linkTarget: "no where\n",
			linkKind: "missing",
		});
		expect(await state.files.stat(join(state.root, "to-dir"))).toMatchObject({
			name: "to-dir",
			kind: "symlink",
			linkKind: "directory",
		});
	});

	it("names what went wrong", async () => {
		writeFileSync(join(state.root, "file"), "");
		await failsWith(state.files.list(join(state.root, "missing"), false), "NOT_FOUND");
		await failsWith(state.files.list(join(state.root, "file"), false), "NOT_A_DIRECTORY");
		await failsWith(state.files.stat(join(state.root, "missing")), "NOT_FOUND");
		await failsWith(state.files.mkdir(join(state.root, "file")), "ALREADY_EXISTS");
		await failsWith(state.files.mkdir(join(state.root, "missing", "new")), "NOT_FOUND");
		await failsWith(state.files.mkdir(join(state.root, "file", "new")), "NOT_A_DIRECTORY");
		await failsWith(state.files.freeSpace(join(state.root, "missing")), "NOT_FOUND");
	});

	// Root ignores modes.
	it.skipIf(process.getuid?.() === 0)("says permission denied", async () => {
		mkdirSync(join(state.root, "locked"));
		chmodSync(join(state.root, "locked"), 0o000);
		await failsWith(state.files.list(join(state.root, "locked"), false), "PERMISSION_DENIED");
		chmodSync(join(state.root, "locked"), 0o500);
		await failsWith(state.files.mkdir(join(state.root, "locked", "new")), "PERMISSION_DENIED");
		chmodSync(join(state.root, "locked"), 0o700);
	});

	it("says what a path is, and reads the free space with df", async () => {
		writeFileSync(join(state.root, "f"), "abc");
		expect(await state.files.stat(join(state.root, "f"))).toMatchObject({
			name: "f",
			kind: "file",
			size: 3,
		});
		expect(await state.files.stat("/")).toMatchObject({ name: "/", kind: "directory" });
		const space = await state.files.freeSpace(state.root);
		expect(space.total).toBeGreaterThan(0);
		expect(space.available).toBeGreaterThanOrEqual(0);
	});

	it("creates a folder", async () => {
		await state.files.mkdir(join(state.root, "new"));
		expect(statSync(join(state.root, "new")).isDirectory()).toBe(true);
	});

	it.each(roundTripNames("posix"))("round-trips the name %j", async (name) => {
		await state.files.mkdir(join(state.root, name));
		writeFileSync(join(state.root, name, name), "x");
		expect((await state.files.list(state.root, false)).map((entry) => entry.name)).toEqual([name]);
		expect(
			(await state.files.list(join(state.root, name), false)).map((entry) => entry.name),
		).toEqual([name]);
		expect(await state.files.stat(join(state.root, name, name))).toMatchObject({ name });
	});
});

/** What an rc file or a profile may print before every command (#749), lines that look like answers included. */
const PRELUDE = `Welcome\nOK\nS\n${WINDOWS_REPLY_MARKER.slice(0, 7)}\n`;

describe.skipIf(windowsMachine)("a POSIX host whose shell prints first", () => {
	const state = useExecHost("posix", { prelude: PRELUDE });

	it("reads the answer after the marker", async () => {
		writeFileSync(join(state.root, "f"), "");
		expect((await state.files.list(state.root, false)).map((entry) => entry.name)).toEqual(["f"]);
	});
});

describe.runIf(windowsMachine)("a Windows host whose shell prints first", () => {
	const state = useExecHost("windows", { shell: "cmd", prelude: PRELUDE });

	it("reads the answer after the marker", async () => {
		writeFileSync(join(state.root, "f"), "");
		expect((await state.files.list(state.root, false)).map((entry) => entry.name)).toEqual(["f"]);
	});
});

// The mock server runs exec requests as Win32-OpenSSH does under its default
// shell: `cmd.exe /c "<command>"`.
describe.runIf(windowsMachine)("a Windows host's files over SSH commands", () => {
	const state = useExecHost("windows", { shell: "cmd" });

	it("starts at the account's profile folder", async () => {
		const home = normaliseHostPath(homedir(), "windows");
		expect(await state.files.home()).toBe(home.ok ? home.path : "");
	});

	it("lists the drives at the root", async () => {
		const system = (process.env.SystemDrive ?? "C:").toUpperCase();
		expect(await state.files.list(WINDOWS_ROOT, false)).toContainEqual({
			name: system,
			kind: "directory",
			size: null,
			mtime: null,
		});
	});

	it("lists a folder's entries with their kind, size and time", async () => {
		mkdirSync(join(state.root, "sub"));
		writeFileSync(join(state.root, "file.txt"), "12345");
		utimesSync(join(state.root, "file.txt"), 1_700_000_000, 1_700_000_000);
		const entries = await state.files.list(state.root, false);
		expect(entries.map((entry) => entry.name).sort()).toEqual(["file.txt", "sub"]);
		expect(entries.find((entry) => entry.name === "file.txt")).toEqual({
			name: "file.txt",
			kind: "file",
			size: 5,
			mtime: "2023-11-14T22:13:20.000Z",
		});
	});

	it("names what went wrong, and says what a path is", async () => {
		writeFileSync(join(state.root, "file"), "abc");
		await failsWith(state.files.list(join(state.root, "missing"), false), "NOT_FOUND");
		await failsWith(state.files.list(join(state.root, "file"), false), "NOT_A_DIRECTORY");
		await failsWith(state.files.stat(join(state.root, "missing")), "NOT_FOUND");
		await failsWith(state.files.mkdir(join(state.root, "file")), "ALREADY_EXISTS");
		await failsWith(state.files.mkdir(join(state.root, "missing", "new")), "NOT_FOUND");
		expect(await state.files.stat(join(state.root, "file"))).toMatchObject({
			name: "file",
			kind: "file",
			size: 3,
		});
	});

	it("reads the free space of the folder's drive", async () => {
		const space = await state.files.freeSpace(state.root);
		expect(space.total).toBeGreaterThan(0);
		expect(space.available).toBeGreaterThanOrEqual(0);
	});

	it.each(roundTripNames("windows"))("round-trips the name %j", async (name) => {
		await state.files.mkdir(join(state.root, name));
		expect(statSync(join(state.root, name)).isDirectory()).toBe(true);
		writeFileSync(join(state.root, name, name), "x");
		expect((await state.files.list(state.root, false)).map((entry) => entry.name)).toEqual([name]);
		expect(
			(await state.files.list(join(state.root, name), false)).map((entry) => entry.name),
		).toEqual([name]);
	});
});
