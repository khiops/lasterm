import { describe, expect, it } from "vitest";
import {
	compareEntries,
	entryFromMode,
	FileAccessError,
	type FileEntry,
	finishListing,
	isDefinitive,
	kindOfMode,
	LISTING_CAP,
	mapLimited,
} from "./host-files.js";

function file(name: string): FileEntry {
	return { name, kind: "file", size: 1, mtime: null };
}

function folder(name: string): FileEntry {
	return { name, kind: "directory", size: null, mtime: null };
}

describe("finishListing", () => {
	it("puts folders and links to folders first, then names as a person reads them", () => {
		const link: FileEntry = { ...file("Zlink"), kind: "symlink", linkKind: "directory" };
		const fileLink: FileEntry = { ...file("alink"), kind: "symlink", linkKind: "file" };
		const listing = finishListing(
			"/x",
			[file("b10"), file("B2"), folder("zeta"), link, fileLink, folder("Alpha"), file("a")],
			true,
		);
		expect(listing.entries.map((entry) => entry.name)).toEqual([
			"Alpha",
			"zeta",
			"Zlink",
			"a",
			"alink",
			"B2",
			"b10",
		]);
		expect(listing).toMatchObject({ path: "/x", truncated: 0 });
	});

	it("leaves out names starting with a dot unless asked for them", () => {
		const entries = [file(".hidden"), folder(".config"), file("shown")];
		expect(finishListing("/", entries, false).entries.map((entry) => entry.name)).toEqual([
			"shown",
		]);
		expect(finishListing("/", entries, true).entries).toHaveLength(3);
	});

	it(`answers at most ${LISTING_CAP} entries, folders first, and counts the rest`, () => {
		const entries = [
			...Array.from({ length: LISTING_CAP + 7 }, (_, i) => file(`f${i}`)),
			folder("last folder"),
		];
		const listing = finishListing("/big", entries, false);
		expect(listing.entries).toHaveLength(LISTING_CAP);
		expect(listing.entries[0]?.name).toBe("last folder");
		expect(listing.truncated).toBe(8);
	});

	it("orders names that differ only by case the same way every time", () => {
		expect(compareEntries(file("a"), file("A"))).toBe(1);
		expect(compareEntries(file("A"), file("a"))).toBe(-1);
	});
});

describe("entries from a POSIX mode", () => {
	it("reads the kind from the type bits, and gives a folder no size", () => {
		expect(kindOfMode(0o040755)).toBe("directory");
		expect(kindOfMode(0o100644)).toBe("file");
		expect(kindOfMode(0o120777)).toBe("symlink");
		expect(kindOfMode(0o020666)).toBe("other");
		expect(entryFromMode("d", 0o040755, 4096, 0)).toEqual({
			name: "d",
			kind: "directory",
			size: null,
			mtime: "1970-01-01T00:00:00.000Z",
		});
		expect(entryFromMode("f", 0o100644, 12, null)).toMatchObject({ size: 12, mtime: null });
	});
});

describe("isDefinitive", () => {
	it("settles a request on every code but FILE_ACCESS_FAILED", () => {
		expect(isDefinitive(new FileAccessError("NOT_FOUND", "x"))).toBe(true);
		expect(isDefinitive(new FileAccessError("HOST_NOT_CONNECTED", "x"))).toBe(true);
		expect(isDefinitive(new FileAccessError("FILE_ACCESS_FAILED", "x"))).toBe(false);
		expect(isDefinitive(new Error("x"))).toBe(false);
	});
});

describe("mapLimited", () => {
	it("keeps the order and never runs more than the limit at once", async () => {
		let running = 0;
		let most = 0;
		const result = await mapLimited([5, 1, 4, 2, 3], 2, async (n) => {
			running++;
			most = Math.max(most, running);
			await new Promise((resolve) => setTimeout(resolve, n));
			running--;
			return n * 10;
		});
		expect(result).toEqual([50, 10, 40, 20, 30]);
		expect(most).toBe(2);
	});
});
