import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { failsWith, LOCAL_ROUND_TRIP_NAMES } from "./file-names.fixture.js";
import { normaliseHostPath, WINDOWS_ROOT } from "./host-paths.js";
import { LocalFileBackend, localHostOs } from "./local-files.js";

const windows = process.platform === "win32";
const style = windows ? "windows" : "posix";

describe("the local host's files, through the hub's own file system", () => {
	let root: string;
	const files = new LocalFileBackend();

	beforeEach(() => {
		root = makeTempDir("lasterm-local-files-");
	});

	afterEach(async () => {
		await removeTempDir(root);
	});

	it("is the OS the hub runs on", () => {
		expect(localHostOs("win32")).toBe("windows");
		expect(localHostOs("linux")).toBe("linux");
		expect(localHostOs("darwin")).toBe("darwin");
	});

	it("starts at the home folder of the hub's user", async () => {
		const home = normaliseHostPath(homedir(), style);
		expect(await files.home()).toBe(home.ok ? home.path : "");
	});

	// The local agent starts its terminals from the hub's user's environment (#836).
	it("reads the hub's own variables, by name as the system reads names", async () => {
		process.env.LASTERM_SPEC_LOCAL_ENV = "/srv/drop";
		try {
			const asked = ["LASTERM_SPEC_LOCAL_ENV", "LASTERM_SPEC_LOCAL_UNSET"];
			expect([...(await files.env(asked))]).toEqual([["LASTERM_SPEC_LOCAL_ENV", "/srv/drop"]]);
			const folded = await files.env(["lasterm_spec_local_env"]);
			expect(folded.get("lasterm_spec_local_env")).toBe(windows ? "/srv/drop" : undefined);
		} finally {
			delete process.env.LASTERM_SPEC_LOCAL_ENV;
		}
	});

	it("lists a folder's entries with their kind, size and time", async () => {
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "file.txt"), "12345");
		writeFileSync(join(root, ".hidden"), "");
		utimesSync(join(root, "file.txt"), 1_700_000_000, 1_700_000_000);

		const shown = await files.list(root, false);
		expect(shown.map((entry) => entry.name).sort()).toEqual(["file.txt", "sub"]);
		expect(shown.find((entry) => entry.name === "file.txt")).toEqual({
			name: "file.txt",
			kind: "file",
			size: 5,
			mtime: "2023-11-14T22:13:20.000Z",
		});
		expect(shown.find((entry) => entry.name === "sub")).toMatchObject({
			kind: "directory",
			size: null,
		});
		expect((await files.list(root, true)).map((entry) => entry.name)).toContain(".hidden");
	});

	it.skipIf(windows)(
		"says what a link holds and where it leads, without following it",
		async () => {
			mkdirSync(join(root, "target"));
			symlinkSync("target", join(root, "to-dir"));
			symlinkSync("nowhere", join(root, "broken"));

			const entries = await files.list(root, false);
			expect(entries.find((entry) => entry.name === "to-dir")).toMatchObject({
				kind: "symlink",
				linkTarget: "target",
				linkKind: "directory",
			});
			expect(entries.find((entry) => entry.name === "broken")).toMatchObject({
				kind: "symlink",
				linkTarget: "nowhere",
				linkKind: "missing",
			});
		},
	);

	it("names what went wrong: a missing folder, a file, a folder that exists", async () => {
		writeFileSync(join(root, "file"), "");
		await failsWith(files.list(join(root, "missing"), false), "NOT_FOUND");
		await failsWith(files.list(join(root, "file"), false), "NOT_A_DIRECTORY");
		await failsWith(files.stat(join(root, "missing")), "NOT_FOUND");
		await failsWith(files.mkdir(join(root, "file")), "ALREADY_EXISTS");
		await failsWith(files.mkdir(join(root, "missing", "new")), "NOT_FOUND");
	});

	it.skipIf(windows)("refuses a parent that is a file as not a folder", async () => {
		writeFileSync(join(root, "file"), "");
		await failsWith(files.mkdir(join(root, "file", "new")), "NOT_A_DIRECTORY");
	});

	it("says what a path is", async () => {
		writeFileSync(join(root, "f"), "abc");
		expect(await files.stat(join(root, "f"))).toMatchObject({ name: "f", kind: "file", size: 3 });
		expect(await files.stat(root)).toMatchObject({ kind: "directory", size: null });
	});

	it("reads the free space of a folder's file system", async () => {
		const space = await files.freeSpace(root);
		expect(space.total).toBeGreaterThan(0);
		expect(space.available).toBeGreaterThanOrEqual(0);
		expect(space.available).toBeLessThanOrEqual(space.total ?? 0);
	});

	it("creates a folder, and only that one", async () => {
		await files.mkdir(join(root, "new"));
		expect(await files.stat(join(root, "new"))).toMatchObject({ kind: "directory" });
	});

	it.each(LOCAL_ROUND_TRIP_NAMES)("round-trips the name %j", async (name) => {
		await files.mkdir(join(root, name));
		writeFileSync(join(root, name, name), "x");
		expect((await files.list(root, false)).map((entry) => entry.name)).toEqual([name]);
		expect((await files.list(join(root, name), false)).map((entry) => entry.name)).toEqual([name]);
	});

	it.runIf(windows)("lists the drives at the root of a Windows hub", async () => {
		const drives = await files.list(WINDOWS_ROOT, false);
		const system = (process.env.SystemDrive ?? "C:").toUpperCase();
		expect(drives).toContainEqual({ name: system, kind: "directory", size: null, mtime: null });
		expect(await files.stat(WINDOWS_ROOT)).toMatchObject({ kind: "directory" });
	});
});
