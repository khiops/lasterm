import { describe, expect, it } from "vitest";
import { buildUploadTree } from "./upload-tree.js";

describe("buildUploadTree", () => {
	it("builds the tree, folders before what is in them, and counts the files and bytes", () => {
		const tree = buildUploadTree(
			[
				{ relPath: "a/b/f.txt", kind: "file", size: 3 },
				{ relPath: "a/b", kind: "dir" },
				{ relPath: "a", kind: "dir" },
				{ relPath: "g", kind: "file", size: 4, mtime: 1_700_000_000_000 },
			],
			"posix",
			"/up",
		);
		if (!tree.ok) throw new Error(tree.message);
		expect(tree.files).toBe(2);
		expect(tree.bytes).toBe(7);
		expect(tree.order.map((id) => tree.items[id]?.relPath)).toEqual(["a", "g", "a/b", "a/b/f.txt"]);
		expect(tree.items[0]).toMatchObject({ name: "f.txt", parent: 1 });
		expect(tree.items[2]?.children).toEqual([1]);
		expect(tree.items[3]).toMatchObject({ parent: null, mtime: 1_700_000_000_000 });
	});

	it("gives the same signature to the same tree in any order", () => {
		const items = [
			{ relPath: "a", kind: "dir" as const },
			{ relPath: "a/x", kind: "file" as const, size: 1 },
		];
		const one = buildUploadTree(items, "posix", "/up");
		const two = buildUploadTree([...items].reverse(), "posix", "/up");
		const other = buildUploadTree([items[0], { ...items[1], size: 2 }], "posix", "/up");
		if (!one.ok || !two.ok || !other.ok) throw new Error("refused");
		expect(one.signature).toBe(two.signature);
		expect(other.signature).not.toBe(one.signature);
	});

	it("lists every item that cannot be sent as given", () => {
		const tree = buildUploadTree(
			[
				{ relPath: "orphan/x", kind: "file", size: 1 },
				{ relPath: "f", kind: "file", size: 1 },
				{ relPath: "f/in-a-file", kind: "file", size: 1 },
				{ relPath: "dup", kind: "file", size: 1 },
				{ relPath: "dup", kind: "file", size: 1 },
				{ relPath: "nosize", kind: "file" },
				{ relPath: "../up", kind: "file", size: 1 },
			],
			"posix",
			"/up",
		);
		expect(tree).toMatchObject({ ok: false, code: "INVALID_ITEMS" });
		if (tree.ok) return;
		expect(tree.names?.map((name) => name.relPath).sort()).toEqual(
			["../up", "dup", "f/in-a-file", "nosize", "orphan/x"].sort(),
		);
	});

	it("refuses on a Windows host its names, names that differ by case only, and paths over MAX_PATH", () => {
		const tree = buildUploadTree(
			[
				{ relPath: "ok", kind: "dir" },
				{ relPath: "ok/aux.c", kind: "file", size: 1 },
				{ relPath: "Readme", kind: "file", size: 1 },
				{ relPath: "README", kind: "file", size: 1 },
				{ relPath: `${"n".repeat(250)}`, kind: "file", size: 1 },
			],
			"windows",
			"C:\\Users\\me",
		);
		expect(tree).toMatchObject({ ok: false, code: "INVALID_NAMES" });
		if (tree.ok) return;
		expect(tree.names?.map((name) => name.relPath).sort()).toEqual(
			["README", "n".repeat(250), "ok/aux.c"].sort(),
		);
		// The same names are fine on a POSIX host.
		expect(
			buildUploadTree(
				[
					{ relPath: "aux.c", kind: "file", size: 1 },
					{ relPath: "Readme", kind: "file", size: 1 },
					{ relPath: "README", kind: "file", size: 1 },
				],
				"posix",
				"/home/me",
			).ok,
		).toBe(true);
	});

	it("refuses more than an upload holds", () => {
		const files = Array.from({ length: 100_001 }, (_, i) => ({
			relPath: `f${i}`,
			kind: "file" as const,
			size: 0,
		}));
		expect(buildUploadTree(files, "posix", "/up")).toMatchObject({
			ok: false,
			code: "TOO_MANY_FILES",
		});
		expect(buildUploadTree([], "posix", "/up")).toMatchObject({ ok: false, code: "INVALID_ITEMS" });
	});
});
