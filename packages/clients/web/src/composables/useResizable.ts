import { type Ref, ref } from "vue";

export interface ResizeOptions {
	initialWidth: number;
	minWidth: number;
	maxWidth: number;
	/** Width below which the panel collapses to 0 (optional) */
	collapseThreshold?: number;
	onResizeEnd?: (width: number) => void;
	/**
	 * Which way a drag widens it: 1 (the default) when its edge is on its right, -1 when on its
	 * left, as the files panel's on the right of the window (#836). Read at each drag.
	 */
	grows?: () => 1 | -1;
}

export function useResizable(options: ResizeOptions): {
	width: Ref<number>;
	collapsed: Ref<boolean>;
	onMouseDown: (e: MouseEvent) => void;
	reset: () => void;
} {
	const width = ref(options.initialWidth);
	const collapsed = ref(false);

	let startX = 0;
	let startWidth = 0;

	function onMouseMove(e: MouseEvent): void {
		const delta = (e.clientX - startX) * (options.grows?.() ?? 1);
		const newWidth = startWidth + delta;

		if (options.collapseThreshold !== undefined && newWidth < options.collapseThreshold) {
			collapsed.value = true;
			width.value = 0;
		} else {
			collapsed.value = false;
			width.value = Math.min(options.maxWidth, Math.max(options.minWidth, newWidth));
		}
	}

	function onMouseUp(): void {
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
		options.onResizeEnd?.(width.value);
	}

	function onMouseDown(e: MouseEvent): void {
		e.preventDefault();
		startX = e.clientX;
		startWidth = collapsed.value ? options.initialWidth : width.value;
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
	}

	function reset(): void {
		width.value = options.initialWidth;
		collapsed.value = false;
	}

	return { width, collapsed, onMouseDown, reset };
}
