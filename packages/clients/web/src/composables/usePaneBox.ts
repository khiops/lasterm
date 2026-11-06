import { nextTick, onScopeDispose, type Ref, ref, watch } from "vue";

/**
 * Where something floating over one pane sits, below the pane's header: px from each edge of the
 * area that holds the panes, and the pane's width.
 */
export interface PaneBox {
	readonly top: number;
	readonly left: number;
	readonly right: number;
	readonly bottom: number;
	readonly width: number;
}

/**
 * The box of the pane `paneId` names in `area`, below its header, as laid out now, and kept so as
 * the pane or the area resizes and as the layout changes. Null with no pane named, or one that is
 * not drawn (a tab not shown, a zone folded away). The writer's files panel a reader follows
 * floats there, over that terminal's pane and no other (#838).
 */
export function usePaneBox(
	area: Ref<HTMLElement | null>,
	paneId: () => string | null,
	/** Anything whose change may move the pane: the tab shown, its layout. */
	layoutKey: () => unknown,
): Ref<PaneBox | null> {
	const box = ref<PaneBox | null>(null);
	let observer: ResizeObserver | null = null;
	let generation = 0;

	function measure(pane: HTMLElement, outer: HTMLElement): void {
		const around = outer.getBoundingClientRect();
		const rect = pane.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			box.value = null;
			return;
		}
		const header = pane.querySelector(".pane-header")?.getBoundingClientRect().height ?? 0;
		box.value = {
			top: rect.top - around.top + header,
			left: rect.left - around.left,
			right: around.right - rect.right,
			bottom: around.bottom - rect.bottom,
			width: rect.width,
		};
	}

	watch(
		[area, paneId, layoutKey],
		async ([outer, id]) => {
			const mine = ++generation;
			observer?.disconnect();
			observer = null;
			if (outer === null || id === null) {
				box.value = null;
				return;
			}
			// The pane a layout change draws is in the DOM once Vue has patched it.
			await nextTick();
			if (mine !== generation) return;
			const pane = outer.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(id)}"]`);
			if (pane === null) {
				box.value = null;
				return;
			}
			measure(pane, outer);
			if (typeof ResizeObserver === "undefined") return;
			observer = new ResizeObserver(() => measure(pane, outer));
			observer.observe(pane);
			observer.observe(outer);
		},
		{ immediate: true },
	);

	onScopeDispose(() => {
		generation++;
		observer?.disconnect();
	});

	return box;
}
