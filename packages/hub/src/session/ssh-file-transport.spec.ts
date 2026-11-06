import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockSshHost, startMockSshHost } from "../files/ssh-host.fixture.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { mkdirLevels, openSftp, type SftpSession, sftpMkdir } from "./ssh-file-transport.js";

describe("mkdirLevels", () => {
	it("walks a POSIX path below its root, as the agent deployment always has", () => {
		expect(mkdirLevels("/home/u/.local/bin")).toEqual([
			"/home",
			"/home/u",
			"/home/u/.local",
			"/home/u/.local/bin",
		]);
		expect(mkdirLevels("/")).toEqual([]);
		expect(mkdirLevels("relative/dir")).toEqual(["relative", "relative/dir"]);
	});

	it("walks a drive-absolute path below the drive's root (#832)", () => {
		expect(mkdirLevels("C:\\Users\\me\\AppData")).toEqual([
			"C:\\Users",
			"C:\\Users\\me",
			"C:\\Users\\me\\AppData",
		]);
		expect(mkdirLevels("C:\\")).toEqual([]);
	});

	it("walks a UNC path below its share, which cannot be created", () => {
		expect(mkdirLevels("\\\\server\\share\\a\\b")).toEqual([
			"\\\\server\\share\\a",
			"\\\\server\\share\\a\\b",
		]);
		expect(mkdirLevels("\\\\server\\share")).toEqual([]);
	});
});

describe("sftpMkdir on a Windows host, as Win32-OpenSSH serves it", () => {
	let root: string;
	let host: MockSshHost;
	let session: SftpSession;

	beforeEach(async () => {
		root = makeTempDir("lasterm-sftp-walk-");
		mkdirSync(join(root, "C", "Users"), { recursive: true });
		host = await startMockSshHost({ view: { style: "windows", root } });
		session = await openSftp(host.client);
	});

	afterEach(async () => {
		session.channel.end();
		await host.close();
		await removeTempDir(root);
	});

	it("creates every missing level of a drive-absolute path", async () => {
		expect(await sftpMkdir(session, "C:\\Users\\me\\AppData\\Local\\lasterm")).toBeUndefined();
		expect(
			statSync(join(root, "C", "Users", "me", "AppData", "Local", "lasterm")).isDirectory(),
		).toBe(true);
	});

	it("names the level it could not create", async () => {
		writeFileSync(join(root, "C", "Users", "me"), "a file");
		const error = await sftpMkdir(session, "C:\\Users\\me\\AppData");
		expect(error?.message).toContain("Could not create the directory C:\\Users\\me\\AppData");
	});
});
