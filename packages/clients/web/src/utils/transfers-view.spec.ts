/**
 * The Transfers part's rows (#837): grouped by host › terminal, the focused terminal's group
 * first and expanded, the others summed up in words; rows that never move under the pointer or
 * the keyboard; groups expanded by hand that stay so; the filter; each upload's state in words,
 * its tree, its chip; what the desktop shell is told; and the conflict step's words and scopes.
 */
import type { TransferItemState } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import {
	afterFocusMove,
	buildTree,
	chipFor,
	conflictActions,
	conflictScopePlan,
	countItems,
	deviceText,
	fileConflicts,
	filterGroups,
	foldedText,
	folderConflicts,
	folderConflictText,
	folderText,
	groupSummary,
	groupUploads,
	inOrder,
	isExpanded,
	isOver,
	keptUntil,
	leftOutText,
	notResumedText,
	placedText,
	quitPendingText,
	resumeText,
	stableOrder,
	stateText,
	transfersCount,
	type UploadItemView,
	type UploadView,
	uploadsReportOf,
} from "./transfers-view.js";

let seq = 0;

function file(
	itemId: number,
	relPath: string,
	state: TransferItemState,
	size = 100,
	acked = 0,
): UploadItemView {
	return { itemId, relPath, kind: "file", size, state, acked };
}

function dir(itemId: number, relPath: string, state: TransferItemState = "placed"): UploadItemView {
	return { itemId, relPath, kind: "dir", size: 0, state, acked: 0 };
}

function upload(
	id: string,
	hostId: string,
	channelId: string,
	items: UploadItemView[],
	extra: Partial<UploadView> = {},
): UploadView {
	return {
		id,
		hostId,
		channelId,
		dir: "/home/pi/assets",
		label: id,
		items,
		sender: true,
		notResumable: false,
		seq: ++seq,
		folderConflicts: [],
		rate: 0,
		totals: countItems(items),
		...extra,
	};
}

const running = (id: string, host: string, channel: string) =>
	upload(id, host, channel, [file(0, "a", "sending", 100, 64)]);
const failed = (id: string, host: string, channel: string) =>
	upload(id, host, channel, [file(0, "a", "failed")]);
const done = (id: string, host: string, channel: string) =>
	upload(id, host, channel, [file(0, "a", "placed")]);

describe("the groups' order", () => {
	it("puts the focused terminal's host first, that terminal first in it, each in the order uploads started", () => {
		const list = [
			failed("1", "AD", "a1"),
			running("2", "RPI", "r1"),
			running("3", "RPI", "r2"),
			done("4", "AD", "a1"),
		];
		const groups = groupUploads(list, "r2");
		expect(groups.map((g) => g.hostId)).toEqual(["RPI", "AD"]);
		expect(groups[0]?.focused).toBe(true);
		expect(groups[0]?.terminals.map((t) => t.channelId)).toEqual(["r2", "r1"]);
		// A focus move re-orders; it removes nothing.
		const after = groupUploads(list, "a1");
		expect(after.map((g) => g.hostId)).toEqual(["AD", "RPI"]);
		expect(after.flatMap((g) => g.terminals.flatMap((t) => t.uploads)).length).toBe(4);
	});

	it("puts conflicts, then failures, first within a terminal", () => {
		const deciding = upload("c", "AD", "a1", [file(0, "x", "conflict")]);
		const groups = groupUploads([done("d", "AD", "a1"), failed("f", "AD", "a1"), deciding], "a1");
		expect(groups[0]?.terminals[0]?.uploads.map((u) => u.id)).toEqual(["c", "f", "d"]);
	});

	it("keeps rows where they are while the pointer or keyboard is in the list, new ones after", () => {
		expect(stableOrder(["b", "a", "c"], ["a", "b"])).toEqual(["a", "b", "c"]);
		// Gone ones leave no hole; nothing frozen shows the order as it is.
		expect(stableOrder(["c", "a"], ["a", "b"])).toEqual(["a", "c"]);
		expect(stableOrder(["b", "a"], null)).toEqual(["b", "a"]);
		const groups = groupUploads([running("1", "AD", "a1"), running("2", "RPI", "r1")], "r1");
		expect(inOrder(groups, ["AD", "RPI"], (g) => g.hostId).map((g) => g.hostId)).toEqual([
			"AD",
			"RPI",
		]);
	});

	it("expands the focused group, keeps one expanded by hand, and collapses the one the focus expanded", () => {
		const [rpi, ad] = groupUploads([running("1", "AD", "a1"), running("2", "RPI", "r1")], "r1");
		expect(isExpanded(rpi!, new Map())).toBe(true);
		expect(isExpanded(ad!, new Map())).toBe(false);
		let byHand = new Map([["AD", true]]);
		expect(isExpanded(ad!, byHand)).toBe(true);
		// The focus moves to AD's terminal, then away: AD, opened by hand, stays open.
		byHand = afterFocusMove(byHand);
		const moved = groupUploads([running("1", "AD", "a1"), running("2", "RPI", "r1")], "zz");
		expect(moved.every((g) => !g.focused)).toBe(true);
		expect(isExpanded(moved.find((g) => g.hostId === "AD")!, byHand)).toBe(true);
		expect(isExpanded(moved.find((g) => g.hostId === "RPI")!, byHand)).toBe(false);
		// One collapsed by hand is the focus's to expand again.
		expect(afterFocusMove(new Map([["RPI", false]])).size).toBe(0);
	});

	it("filters to this terminal, hiding the other groups; All is everything", () => {
		const groups = groupUploads(
			[failed("1", "AD", "a1"), running("2", "RPI", "r1"), running("3", "RPI", "r2")],
			"r1",
		);
		expect(filterGroups(groups, "all", "r1")).toHaveLength(2);
		const mine = filterGroups(groups, "terminal", "r1");
		expect(mine.map((g) => g.hostId)).toEqual(["RPI"]);
		expect(mine[0]?.terminals.map((t) => t.channelId)).toEqual(["r1"]);
	});

	it("sums a collapsed group up in words, a failure in the warning style", () => {
		expect(groupSummary("AD", [failed("1", "AD", "a")])).toEqual({
			text: "AD · 1 failed",
			warn: true,
		});
		expect(groupSummary("raspberrypi", [running("1", "R", "r"), running("2", "R", "r")])).toEqual({
			text: "raspberrypi · 2 running, 64 %",
			warn: false,
		});
		expect(
			groupSummary("local", [done("1", "L", "l"), done("2", "L", "l"), done("3", "L", "l")]),
		).toEqual({
			text: "local · 3 done",
			warn: false,
		});
	});
});

describe("an upload's row", () => {
	it("says its state in words, a cancel's too", () => {
		const items = [
			...Array.from({ length: 117 }, (_, i) => file(i, `f${i}`, "placed")),
			file(117, "x", "failed"),
			file(118, "y", "sending"),
			file(119, "z", "queued"),
		];
		expect(stateText(countItems(items))).toBe("117 of 120 placed, 1 failed, 1 sending, 1 waiting");
		const cancelled = [
			...Array.from({ length: 64 }, (_, i) => file(i, `f${i}`, "placed")),
			...Array.from({ length: 56 }, (_, i) => file(64 + i, `g${i}`, "cancelled")),
		];
		expect(stateText(countItems(cancelled))).toBe("64 of 120 placed, 56 cancelled");
	});

	it("builds its tree, a folder summing what it holds, failures first", () => {
		const tree = buildTree([
			dir(0, "photos", "placed"),
			file(1, "photos/a.jpg", "placed"),
			dir(2, "photos/2026", "placed"),
			file(3, "photos/2026/b.jpg", "placed"),
			file(4, "photos/2026/c.jpg", "failed"),
		]);
		expect(tree).toHaveLength(1);
		expect(folderText(tree[0]!.counts)).toBe("2 of 3, 1 failed");
		expect(tree[0]!.children.map((child) => child.name)).toEqual(["2026", "a.jpg"]);
	});

	it("chips each pane with its own terminal's uploads only", () => {
		const list = [running("1", "R", "r1"), failed("2", "A", "a1")];
		expect(chipFor(list, "r1")?.text).toBe("↑ 1 · 64 %");
		expect(chipFor(list, "a1")).toMatchObject({ text: "⚠ 1 failed", warn: true });
		expect(chipFor(list, "other")).toBeNull();
	});

	it("tells the desktop shell only what this window sends, as its set_uploads_in_progress counts", () => {
		const list = [
			running("1", "R", "r1"),
			running("2", "R", "r1"),
			// Ended failed, still listed: it holds no quit.
			failed("3", "A", "a1"),
			// Stopped on a question, nothing else of it moving: in progress, and waiting.
			upload("4", "A", "a1", [file(0, "q", "conflict")]),
			// A question, and files still moving: in progress, not waiting.
			upload("5", "A", "a1", [file(0, "q", "conflict"), file(1, "r", "sending", 100, 64)]),
			// A failure while others move: in progress, not failed yet.
			upload("6", "A", "a1", [file(0, "q", "failed"), file(1, "r", "queued")]),
			// A reader's: not this window's to report.
			upload("7", "A", "a1", [file(0, "q", "sending")], { sender: false }),
		];
		// 700 bytes of the five in progress, 192 of them on the hosts.
		expect(uploadsReportOf(list)).toEqual({ inProgress: 5, waiting: 1, failed: 1, percent: 27 });
		expect(uploadsReportOf([failed("1", "A", "a")])).toEqual({
			inProgress: 0,
			waiting: 0,
			failed: 1,
			percent: null,
		});
		expect(uploadsReportOf([])).toEqual({ inProgress: 0, waiting: 0, failed: 0, percent: null });
	});

	it("says the quit or the restart the desktop holds for these uploads", () => {
		expect(quitPendingText("quit")).toBe("Lasterm will quit when these uploads end");
		expect(quitPendingText("restart")).toBe("Lasterm will restart when these uploads end");
		expect(quitPendingText(null)).toBeNull();
	});
});

describe("the conflict step", () => {
	const items = [
		dir(0, "photos", "placed"),
		...Array.from({ length: 7 }, (_, i) => file(1 + i, `photos/c${i}.jpg`, "conflict")),
		...Array.from({ length: 113 }, (_, i) => file(8 + i, `photos/n${i}.jpg`, "queued")),
		file(121, "notes.md", "conflict"),
	];
	const withFolder = upload("u", "RPI", "r1", items, {
		folderConflicts: [{ itemId: 0, conflicting: 7, total: 120 }],
	});

	it("sums an existing folder up first: never replaced as a whole", () => {
		const [folder] = folderConflicts(withFolder);
		expect(folder?.waiting).toHaveLength(7);
		expect(folderConflictText(folder!, "/home/pi/assets")).toBe(
			"photos/ already exists in assets: 7 of 120 files would conflict. The 113 others merge in.",
		);
		// A file outside it is asked on its own.
		expect(fileConflicts(withFolder).map((item) => item.relPath)).toEqual(["notes.md"]);
	});

	it("offers Keep both or Skip only for a folder against a file", () => {
		expect(conflictActions([{ ...file(1, "a", "conflict"), typeClash: true }])).toEqual([
			"keep_both",
			"skip",
		]);
		expect(conflictActions([file(1, "a", "conflict")])).toEqual(["skip", "keep_both", "replace"]);
	});

	it("saves Always do this for the upload's own host or everywhere, Replace included, nothing this time only", () => {
		expect(conflictScopePlan("replace", "once", withFolder)).toBeNull();
		const host = conflictScopePlan("replace", "host", withFolder);
		expect(host?.requests).toEqual([
			{
				method: "PATCH",
				path: "/api/hosts/RPI/profile",
				body: { profile: { transferOnConflict: "replace" } },
			},
			{
				method: "PATCH",
				path: "/api/channels/r1/profile",
				body: { profile: { transferOnConflict: null } },
			},
		]);
		const everywhere = conflictScopePlan("keep_both", "global", withFolder, {
			host: { transferOnConflict: "skip" },
		});
		expect(everywhere?.requests[0]).toEqual({
			method: "PUT",
			path: "/api/config/global",
			body: { terminal: { transferOnConflict: "keep_both" } },
		});
		expect(everywhere?.dropped).toEqual([{ scope: "host", value: "skip" }]);
	});
});

describe("the interrupted uploads (#837)", () => {
	const interrupted = (id: string, updatedAt: string | null, extra: Partial<UploadView> = {}) =>
		upload(id, "h1", "c1", [file(0, "a", "placed"), file(1, "b", "interrupted", 100, 40)], {
			sender: false,
			state: "interrupted",
			updatedAt,
			...extra,
		});

	it("folds into one line that says how many, and until when the first of them is kept", () => {
		const until = keptUntil([
			"2026-11-06T10:00:00.000Z",
			"2026-11-05T09:00:00.000Z",
			null,
			"not a date",
		]);
		expect(until?.toISOString()).toBe("2026-11-12T09:00:00.000Z");
		expect(foldedText(4, until)).toBe("4 interrupted uploads · kept until 12 Nov");
		expect(foldedText(1, null)).toBe("1 interrupted upload");
		expect(keptUntil([null, undefined])).toBeNull();
	});

	it("says what was placed, and why the last resume did not reach the host", () => {
		expect(placedText(interrupted("t", null).totals)).toBe("1 of 2 placed");
		expect(notResumedText("needs_passphrase", "AD")).toBe("Not resumed: AD needs its passphrase");
		expect(notResumedText("needs_password", "AD")).toBe("Not resumed: AD needs its password");
		expect(notResumedText("host_key_not_accepted", "AD")).toBe(
			"Not resumed: AD's host key was not accepted",
		);
		expect(notResumedText("host_unreachable", "AD")).toBe("Not resumed: AD could not be reached");
	});

	it("names the device another device's upload can be resumed from", () => {
		expect(deviceText("Paired from 192.168.1.20")).toBe("the device paired from 192.168.1.20");
		expect(deviceText("Primary")).toBe("the desktop app");
		expect(deviceText("Laptop")).toBe("Laptop");
		expect(deviceText(undefined)).toBe("another device");
		expect(deviceText(" ")).toBe("another device");
	});

	it("says where a resume is, and what it left out", () => {
		expect(resumeText({ phase: "asking" })).toBe("Asking for access to its files…");
		expect(resumeText({ phase: "redrop", why: "timeout" })).toBe("Drop the files again to finish");
		expect(resumeText({ phase: "resuming", gone: 0, unreadable: 0 })).toBe("Resuming…");
		expect(resumeText(null)).toBeNull();
		expect(leftOutText(1, 0)).toBe("1 file no longer there: left out");
		expect(leftOutText(2, 1)).toBe("2 files no longer there, 1 file could not be read: left out");
		expect(leftOutText(0, 0)).toBeNull();
	});

	it("is never over, so that Clear finished keeps it, and the header counts it", () => {
		const stopped = interrupted("t1", "2026-11-06T10:00:00.000Z");
		expect(isOver(stopped)).toBe(false);
		// Its files interrupted while the hub still says it runs: not over either.
		expect(isOver({ ...stopped, state: "running" })).toBe(false);
		expect(isOver(done("t2", "h1", "c1"))).toBe(true);
		expect(transfersCount([stopped, running("t3", "h1", "c1")]).text).toBe(
			"1 running, 1 interrupted",
		);
	});
});
