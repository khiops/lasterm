/**
 * What a drop target decides before any byte moves (#837): it takes files only when it will
 * upload them, refuses a reader, an ended terminal and a drop on a terminal whose
 * `transfer_drop` is off, and leaves everything else to the page; and what the overlay and the
 * confirmation say, the host first.
 */
import { describe, expect, it } from "vitest";
import {
	countItems,
	type DropFacts,
	dropDecision,
	dropRole,
	overlayText,
	refusalText,
	startItems,
	walkSummary,
	windowsNameProblems,
	withoutPaths,
} from "./upload-drop.js";
import type { WalkedItem } from "./upload-walk.js";

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

function facts(overrides: Partial<DropFacts> = {}): DropFacts {
	return {
		target: "terminal",
		carriesFiles: true,
		enabled: true,
		channelId: A,
		role: "writer",
		transferDrop: "upload",
		ended: false,
		...overrides,
	};
}

describe("taking or refusing a drop", () => {
	it("takes files for the writer, and when nobody writes, on every target", () => {
		for (const target of ["terminal", "panel", "folder"] as const) {
			for (const role of ["writer", "free"] as const) {
				expect(dropDecision(facts({ target, role })), `${target} ${role}`).toEqual({
					kind: "take",
				});
			}
		}
	});

	it("refuses a reader on every target, so that the cursor says no and Request write is offered", () => {
		for (const target of ["terminal", "panel", "folder"] as const) {
			expect(dropDecision(facts({ target, role: "reader" }))).toEqual({
				kind: "refuse",
				reason: "reader",
			});
		}
	});

	it("refuses a terminal that ended, before a reader's reason", () => {
		expect(dropDecision(facts({ ended: true, role: "reader" }))).toEqual({
			kind: "refuse",
			reason: "ended",
		});
		expect(dropDecision(facts({ target: "panel", ended: true }))).toEqual({
			kind: "refuse",
			reason: "ended",
		});
	});

	it("refuses a drop on the terminal when transfer_drop is off, never one on the panel", () => {
		expect(dropDecision(facts({ transferDrop: "off" }))).toEqual({ kind: "refuse", reason: "off" });
		expect(dropDecision(facts({ target: "panel", transferDrop: "off" }))).toEqual({ kind: "take" });
		expect(dropDecision(facts({ target: "folder", transferDrop: "off" }))).toEqual({
			kind: "take",
		});
	});

	it("leaves to the page what is not files, file transfer off, and a pane still spawning", () => {
		// The guard of utils/file-drop-guard.ts refuses those, or a pane move takes its own.
		expect(dropDecision(facts({ carriesFiles: false }))).toEqual({ kind: "ignore" });
		expect(dropDecision(facts({ enabled: false }))).toEqual({ kind: "ignore" });
		expect(dropDecision(facts({ channelId: null }))).toEqual({ kind: "ignore" });
		expect(dropDecision(facts({ enabled: false, role: "reader" }))).toEqual({ kind: "ignore" });
	});

	it("tells the role from the write lock: held here, by nobody, or by another window", () => {
		expect(dropRole("me", "me")).toBe("writer");
		expect(dropRole(null, "me")).toBe("free");
		expect(dropRole(undefined, "me")).toBe("free");
		expect(dropRole("other", "me")).toBe("reader");
		expect(dropRole("other", null)).toBe("reader");
	});

	it("says why it refuses", () => {
		expect(refusalText("reader", "AD")).toMatch(/request write/i);
		expect(refusalText("ended", "AD")).toMatch(/ended/);
		expect(refusalText("off", "AD")).toContain("AD");
	});
});

describe("what the overlay says", () => {
	it("names the host first, then the folder, then what that folder is", () => {
		expect(
			overlayText({ count: 3, hostLabel: "raspberrypi", dir: "/home/pi", origin: "terminal" }),
		).toBe("Drop 3 items to upload to raspberrypi › /home/pi — this terminal's directory");
		expect(overlayText({ count: 1, hostLabel: "AD", dir: "C:\\Temp", origin: "folder" })).toBe(
			"Drop 1 item to upload to AD › C:\\Temp — this folder",
		);
		// Before the folder is read: the host alone.
		expect(overlayText({ count: null, hostLabel: "AD", dir: null, origin: "terminal" })).toBe(
			"Drop to upload to AD",
		);
	});
});

const tree: WalkedItem[] = [
	{ relPath: "photos", kind: "dir" },
	{ relPath: "photos/a.jpg", kind: "file", size: 1000, mtime: 1 },
	{ relPath: "photos/.hidden", kind: "file", size: 24, mtime: 2 },
	{ relPath: "photos/empty", kind: "dir" },
	{ relPath: "photos/CON", kind: "dir" },
	{ relPath: "photos/CON/b.jpg", kind: "file", size: 5, mtime: 3 },
	{ relPath: "photos/A.JPG", kind: "file", size: 7, mtime: 4 },
];

describe("what the confirmation says", () => {
	it("states counts, hidden files, empty folders, size and what was skipped", () => {
		expect(
			walkSummary(
				[{ name: "photos", kind: "directory" }],
				{ files: 120, folders: 4, emptyFolders: 1, hidden: 4, bytes: 412 * 1024 * 1024 },
				[{ relPath: "photos/l", reason: "link" }],
			),
		).toBe("photos/: 120 files (4 hidden), 4 folders (1 empty), 412 MB; 1 link skipped");
		expect(
			walkSummary(
				[
					{ name: "a", kind: "file" },
					{ name: "b", kind: "file" },
				],
				{ files: 2, folders: 0, emptyFolders: 0, hidden: 0, bytes: 2048 },
				[],
			),
		).toBe("2 items: 2 files, 2 KB");
	});

	it("lists every name a Windows host refuses, case clashes and long paths, before any byte moves", () => {
		const problems = windowsNameProblems("C:\\Users\\pi", tree);
		expect(problems.map((p) => p.relPath)).toEqual(["photos/CON", "photos/A.JPG"]);
		const long = windowsNameProblems(`C:\\${"d".repeat(250)}`, [
			{ relPath: "photos/a.jpg", kind: "file", size: 1 },
		]);
		expect(long).toHaveLength(1);
		expect(long[0]?.reason).toMatch(/259/);
	});

	it("skips those with everything under them, and counts again", () => {
		const left = withoutPaths(tree, ["photos/CON", "photos/A.JPG"]);
		expect(left.map((item) => item.relPath)).toEqual([
			"photos",
			"photos/a.jpg",
			"photos/.hidden",
			"photos/empty",
		]);
		expect(countItems(left)).toEqual({
			files: 2,
			folders: 2,
			emptyFolders: 1,
			hidden: 1,
			bytes: 1024,
		});
	});

	it("names the tree as TRANSFER_START does: folders with no size, files with their size and time", () => {
		expect(startItems(tree.slice(0, 2))).toEqual([
			{ relPath: "photos", kind: "dir" },
			{ relPath: "photos/a.jpg", kind: "file", size: 1000, mtime: 1 },
		]);
	});
});
