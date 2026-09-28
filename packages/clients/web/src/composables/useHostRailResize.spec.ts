import type { HostRailBadgeSize } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { useHostRailResize } from "./useHostRailResize.js";

function mouse(type: string, clientX: number): void {
	document.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true }));
}

function setup(columns = 1, badgeSize: HostRailBadgeSize = "medium") {
	const config = { columns: ref(columns), badgeSize: ref<HostRailBadgeSize>(badgeSize) };
	const onColumnsChange = vi.fn();
	const rail = useHostRailResize({ ...config, onColumnsChange });
	return { config, onColumnsChange, rail };
}

/** Drag the edge from its place by `dx` pixels, leaving it held. */
function drag(rail: ReturnType<typeof setup>["rail"], dx: number): void {
	const from = rail.width.value;
	rail.onMouseDown(new MouseEvent("mousedown", { clientX: from }));
	mouse("mousemove", from + dx);
}

describe("useHostRailResize", () => {
	afterEach(() => {
		mouse("mouseup", 0);
	});

	it("is as wide as its columns at the badge size", () => {
		const { rail } = setup(3);
		expect(rail.width.value).toBe(132);
		expect(rail.columns.value).toBe(3);
	});

	it("keeps its columns when the badge size changes, and the width follows", async () => {
		const { config, rail } = setup(3);
		config.badgeSize.value = "small";
		await nextTick();
		expect(rail.columns.value).toBe(3);
		expect(rail.width.value).toBe(108);
	});

	it("follows the pointer while dragged, showing the columns that fit", () => {
		const { rail, onColumnsChange } = setup(1);
		drag(rail, 60); // 48 → 108: two Medium columns fit, not three
		expect(rail.width.value).toBe(108);
		expect(rail.columns.value).toBe(2);
		expect(onColumnsChange).not.toHaveBeenCalled();
	});

	it("snaps to the nearest column width when released", () => {
		const { rail, onColumnsChange } = setup(1);
		drag(rail, 64); // 112: nearer three columns (132) than two (90)
		mouse("mouseup", 112);
		expect(rail.width.value).toBe(132);
		expect(rail.columns.value).toBe(3);
		expect(onColumnsChange).toHaveBeenCalledExactlyOnceWith(3);
	});

	it("stays between one and five columns", () => {
		const { rail } = setup(2);
		drag(rail, -500);
		expect(rail.width.value).toBe(48);
		mouse("mouseup", 0);

		drag(rail, 2000);
		expect(rail.width.value).toBe(216);
		mouse("mouseup", 0);
		expect(rail.columns.value).toBe(5);
	});

	it("says nothing when released on the columns it had", () => {
		const { rail, onColumnsChange } = setup(2);
		drag(rail, 15);
		mouse("mouseup", 0);
		expect(rail.width.value).toBe(90);
		expect(onColumnsChange).not.toHaveBeenCalled();
	});

	it("resets to one column", () => {
		const { rail, onColumnsChange } = setup(4);
		rail.reset();
		expect(rail.width.value).toBe(48);
		expect(onColumnsChange).toHaveBeenCalledExactlyOnceWith(1);
	});

	it("takes the columns the config comes to hold", async () => {
		const { config, rail } = setup(1);
		config.columns.value = 4;
		await nextTick();
		expect(rail.columns.value).toBe(4);
		expect(rail.width.value).toBe(174);
	});
});
