import {
	HOST_RAIL_MAX_COLUMNS,
	type HostRailBadgeSize,
	hostRailColumnsForWidth,
	hostRailWidth,
	nearestHostRailColumns,
} from "@lasterm/shared";
import { type ComputedRef, computed, type Ref, ref, watch } from "vue";

export interface HostRailResizeOptions {
	/** The columns the rail keeps, as the config holds them. */
	columns: Readonly<Ref<number>>;
	badgeSize: Readonly<Ref<HostRailBadgeSize>>;
	/** A new column count, chosen by releasing the edge or by resetting it. */
	onColumnsChange: (columns: number) => void;
}

/**
 * The host rail's width, resized by its edge (#623).
 *
 * The rail keeps a column count, not a width: its width is that of its
 * columns at the badge size, so a new size keeps the columns and the width
 * follows. While the edge is dragged the rail follows the pointer and shows the
 * columns that fit; released, it snaps to the nearest whole column width.
 */
export function useHostRailResize(options: HostRailResizeOptions): {
	width: ComputedRef<number>;
	columns: ComputedRef<number>;
	onMouseDown: (e: MouseEvent) => void;
	reset: () => void;
} {
	/** The columns chosen, until the config says otherwise. */
	const chosen = ref(options.columns.value);
	watch(options.columns, (columns) => {
		chosen.value = columns;
	});

	/** The width under the pointer while the edge is dragged. */
	const dragWidth = ref<number | null>(null);

	const width = computed(
		() => dragWidth.value ?? hostRailWidth(chosen.value, options.badgeSize.value),
	);
	const columns = computed(() =>
		dragWidth.value === null
			? chosen.value
			: hostRailColumnsForWidth(dragWidth.value, options.badgeSize.value),
	);

	let startX = 0;
	let startWidth = 0;

	function choose(columns: number): void {
		if (columns === chosen.value) return;
		chosen.value = columns;
		options.onColumnsChange(columns);
	}

	function onMouseMove(e: MouseEvent): void {
		const size = options.badgeSize.value;
		const next = startWidth + e.clientX - startX;
		dragWidth.value = Math.min(
			hostRailWidth(HOST_RAIL_MAX_COLUMNS, size),
			Math.max(hostRailWidth(1, size), next),
		);
	}

	function onMouseUp(): void {
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
		const released = dragWidth.value;
		dragWidth.value = null;
		if (released !== null) choose(nearestHostRailColumns(released, options.badgeSize.value));
	}

	function onMouseDown(e: MouseEvent): void {
		e.preventDefault();
		startX = e.clientX;
		startWidth = width.value;
		dragWidth.value = startWidth;
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
	}

	/** Back to one column. */
	function reset(): void {
		choose(1);
	}

	return { width, columns, onMouseDown, reset };
}
