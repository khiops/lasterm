import { describe, expect, it } from "vitest";
import {
	chunkIntoRows,
	HOST_RAIL_BADGE_GEOMETRY,
	HOST_RAIL_BADGE_SIZES,
	HOST_RAIL_MAX_COLUMNS,
	hostRailColumnsForWidth,
	hostRailColumnsFromLegacyWidth,
	hostRailWidth,
	isHostRailBadgeSize,
	isHostRailColumns,
	moveBefore,
	nearestHostRailColumns,
} from "./host-rail.js";

describe("host rail badge sizes", () => {
	it("keeps today's badge as Medium", () => {
		expect(HOST_RAIL_BADGE_GEOMETRY.medium).toEqual({
			badge: 36,
			initials: 14,
			dot: 10,
			squircle: 12,
			pill: 20,
		});
	});

	it("grows every part with the badge", () => {
		const [small, medium, large] = HOST_RAIL_BADGE_SIZES.map((s) => HOST_RAIL_BADGE_GEOMETRY[s]);
		for (const key of ["badge", "initials", "dot", "squircle", "pill"] as const) {
			expect(small?.[key]).toBeLessThan(medium?.[key] ?? 0);
			expect(medium?.[key]).toBeLessThan(large?.[key] ?? 0);
		}
	});

	it("names only the three sizes", () => {
		expect(isHostRailBadgeSize("small")).toBe(true);
		expect(isHostRailBadgeSize("large")).toBe(true);
		expect(isHostRailBadgeSize("huge")).toBe(false);
		expect(isHostRailBadgeSize(36)).toBe(false);
	});
});

describe("hostRailWidth — the width of n columns", () => {
	it("is 12 + n·badge + (n−1)·6", () => {
		expect(hostRailWidth(1, "medium")).toBe(48);
		expect(hostRailWidth(2, "medium")).toBe(90);
		expect(hostRailWidth(3, "medium")).toBe(132);
		expect(hostRailWidth(5, "medium")).toBe(216);
		expect(hostRailWidth(3, "small")).toBe(108);
		expect(hostRailWidth(1, "large")).toBe(56);
		expect(hostRailWidth(3, "large")).toBe(156);
	});

	it("is never narrower than one Medium column", () => {
		expect(hostRailWidth(1, "small")).toBe(48);
		expect(hostRailWidth(2, "small")).toBe(74);
	});

	it("keeps to 1 to 5 columns", () => {
		expect(hostRailWidth(0, "medium")).toBe(hostRailWidth(1, "medium"));
		expect(hostRailWidth(9, "medium")).toBe(hostRailWidth(HOST_RAIL_MAX_COLUMNS, "medium"));
	});
});

describe("hostRailColumnsForWidth — the columns a width holds", () => {
	it("gives back the columns of each column width", () => {
		for (const size of HOST_RAIL_BADGE_SIZES) {
			for (let n = 1; n <= HOST_RAIL_MAX_COLUMNS; n++) {
				expect(hostRailColumnsForWidth(hostRailWidth(n, size), size)).toBe(n);
			}
		}
	});

	it("counts only whole columns", () => {
		expect(hostRailColumnsForWidth(89, "medium")).toBe(1);
		expect(hostRailColumnsForWidth(90, "medium")).toBe(2);
		expect(hostRailColumnsForWidth(131, "medium")).toBe(2);
	});

	it("holds at least one column and at most five", () => {
		expect(hostRailColumnsForWidth(0, "large")).toBe(1);
		expect(hostRailColumnsForWidth(2000, "small")).toBe(5);
		expect(hostRailColumnsForWidth(Number.NaN, "medium")).toBe(1);
	});
});

describe("nearestHostRailColumns — where a released edge snaps", () => {
	it("rounds to the nearest column width", () => {
		// Medium: 48, 90, 132 … the halfway points are 69 and 111.
		expect(nearestHostRailColumns(68, "medium")).toBe(1);
		expect(nearestHostRailColumns(70, "medium")).toBe(2);
		expect(nearestHostRailColumns(110, "medium")).toBe(2);
		expect(nearestHostRailColumns(112, "medium")).toBe(3);
	});

	it("takes the wider halfway", () => {
		expect(nearestHostRailColumns(69, "medium")).toBe(2);
	});

	it("measures against the widths, one Small column included", () => {
		// 48 and 74: 60 is nearer one column, though (60 − 6) / 34 rounds to 2.
		expect(nearestHostRailColumns(60, "small")).toBe(1);
		expect(nearestHostRailColumns(62, "small")).toBe(2);
	});

	it("keeps to 1 to 5 columns", () => {
		expect(nearestHostRailColumns(10, "medium")).toBe(1);
		expect(nearestHostRailColumns(900, "medium")).toBe(5);
	});
});

describe("hostRailColumnsFromLegacyWidth — a width kept by an earlier rail", () => {
	it("becomes the Medium columns it holds", () => {
		expect(hostRailColumnsFromLegacyWidth(48)).toBe(1);
		expect(hostRailColumnsFromLegacyWidth(89)).toBe(1);
		expect(hostRailColumnsFromLegacyWidth(90)).toBe(2);
		// The old cap.
		expect(hostRailColumnsFromLegacyWidth(120)).toBe(2);
	});

	it("gives one column for a width too small to hold one", () => {
		expect(hostRailColumnsFromLegacyWidth(0)).toBe(1);
	});
});

describe("isHostRailColumns", () => {
	it("accepts a whole number from 1 to 5", () => {
		expect(isHostRailColumns(1)).toBe(true);
		expect(isHostRailColumns(5)).toBe(true);
		expect(isHostRailColumns(0)).toBe(false);
		expect(isHostRailColumns(6)).toBe(false);
		expect(isHostRailColumns(2.5)).toBe(false);
		expect(isHostRailColumns("3")).toBe(false);
	});
});

describe("chunkIntoRows — a section's rows", () => {
	const hosts = ["a", "b", "c", "d", "e"];

	it("fills each row left to right, then the next", () => {
		expect(chunkIntoRows(hosts, 3)).toEqual([
			["a", "b", "c"],
			["d", "e"],
		]);
		expect(chunkIntoRows(hosts, 1)).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
		expect(chunkIntoRows(hosts, 5)).toEqual([hosts]);
	});

	it("reads back in the order it was given", () => {
		for (let columns = 1; columns <= 5; columns++) {
			expect(chunkIntoRows(hosts, columns).flat()).toEqual(hosts);
		}
	});

	it("has no row for no items", () => {
		expect(chunkIntoRows([], 3)).toEqual([]);
	});
});

describe("moveBefore — a drop, in reading order", () => {
	// In three columns: a b c / d e
	const ids = ["a", "b", "c", "d", "e"];

	it("puts the moved badge just before the one it is dropped on", () => {
		// e, on the second row, dropped on b: it lands between a and b.
		expect(moveBefore(ids, "e", "b")).toEqual(["a", "e", "b", "c", "d"]);
		// a, dropped on d: the first of the second row, so last of the first.
		expect(moveBefore(ids, "a", "d")).toEqual(["b", "c", "a", "d", "e"]);
	});

	it("adds a badge from another section before the target", () => {
		expect(moveBefore(ids, "x", "c")).toEqual(["a", "b", "x", "c", "d", "e"]);
	});

	it("changes nothing when dropped on itself or on no badge of the section", () => {
		expect(moveBefore(ids, "c", "c")).toEqual(ids);
		expect(moveBefore(ids, "c", "z")).toEqual(ids);
	});
});
