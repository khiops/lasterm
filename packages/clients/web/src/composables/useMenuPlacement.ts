import { computed, nextTick, onBeforeUnmount, type Ref, ref, watch } from "vue";

/** What a menu keeps free between itself and the window's edge, in pixels. */
export const MENU_MARGIN = 4;

/**
 * Where a context menu opened at (`x`, `y`) is drawn so that it stays inside the window (#1190).
 *
 * It is first drawn at the click, then measured and moved: left and up by as much as it overflows
 * the right and bottom edges, never past the top or left ones. A window shorter than the menu
 * gets the menu's height limited to what is visible, and the menu scrolls. Only then: a scrolling
 * menu would cut off a submenu drawn outside it, so `scrolls` tells the menu to list it in its flow.
 * It is placed again when the window or the menu changes size while it is open. A window narrower
 * than the menu is not handled: the menu keeps its width.
 */
export function useMenuPlacement(options: {
	/** Whether the menu is open. */
	open: () => boolean;
	/** The menu's element. */
	menu: Ref<HTMLElement | null>;
	/** The click's coordinates, in the window's pixels. */
	x: () => number;
	y: () => number;
}): { style: Readonly<Ref<Record<string, string>>>; scrolls: Readonly<Ref<boolean>> } {
	const placed = ref<{ left: number; top: number; maxHeight: number; scrolls: boolean } | null>(
		null,
	);

	/** Measure the menu where it is and move it inside the window. */
	function measure(): void {
		const el = options.menu.value;
		if (el === null || !options.open()) return;
		const { width, height: drawn } = el.getBoundingClientRect();
		// A menu already limited in height shows less than it holds: its content is its natural height.
		const height = Math.max(drawn, el.scrollHeight);
		const room = { w: window.innerWidth, h: window.innerHeight };
		const maxHeight = Math.max(room.h - 2 * MENU_MARGIN, 0);
		const shown = Math.min(height, maxHeight);
		const next = {
			left: Math.max(MENU_MARGIN, Math.min(options.x(), room.w - width - MENU_MARGIN)),
			top: Math.max(MENU_MARGIN, Math.min(options.y(), room.h - shown - MENU_MARGIN)),
			maxHeight,
			scrolls: height > maxHeight,
		};
		const was = placed.value;
		if (was === null || JSON.stringify(was) !== JSON.stringify(next)) placed.value = next;
	}

	async function place(): Promise<void> {
		placed.value = null;
		if (!options.open()) return;
		await nextTick();
		measure();
	}

	watch([options.open, options.x, options.y], place, { immediate: true });

	// What changes the menu's place once it is open: the window's size, and its own (entries that
	// come or go with the host's state).
	window.addEventListener("resize", measure);
	let observer: ResizeObserver | null = null;
	watch(
		options.menu,
		(el) => {
			observer?.disconnect();
			observer = null;
			if (el !== null && typeof ResizeObserver !== "undefined") {
				observer = new ResizeObserver(measure);
				observer.observe(el);
			}
		},
		{ flush: "post" },
	);
	onBeforeUnmount(() => {
		window.removeEventListener("resize", measure);
		observer?.disconnect();
	});

	const style = computed(() => {
		const p = placed.value;
		return p === null
			? { left: `${options.x()}px`, top: `${options.y()}px` }
			: p.scrolls
				? {
						left: `${p.left}px`,
						top: `${p.top}px`,
						maxHeight: `${p.maxHeight}px`,
						overflowY: "auto",
					}
				: { left: `${p.left}px`, top: `${p.top}px` };
	});

	return { style, scrolls: computed(() => placed.value?.scrolls === true) };
}
