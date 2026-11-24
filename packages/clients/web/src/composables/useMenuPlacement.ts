import { computed, nextTick, type Ref, ref, watch } from "vue";

/** What a menu keeps free between itself and the window's edge, in pixels. */
export const MENU_MARGIN = 4;

/**
 * Where a context menu opened at (`x`, `y`) is drawn so that it stays inside the window (#1190).
 *
 * It is first drawn at the click, then measured and moved: left and up by as much as it overflows
 * the right and bottom edges, never past the top or left ones. A window shorter than the menu
 * gets the menu's height limited to what is visible, and the menu scrolls. Only then: a scrolling
 * menu would cut off a submenu drawn outside it.
 */
export function useMenuPlacement(options: {
	/** Whether the menu is open. */
	open: () => boolean;
	/** The menu's element. */
	menu: Ref<HTMLElement | null>;
	/** The click's coordinates, in the window's pixels. */
	x: () => number;
	y: () => number;
}): { style: Readonly<Ref<Record<string, string>>> } {
	const placed = ref<{ left: number; top: number; maxHeight: number; scrolls: boolean } | null>(
		null,
	);

	async function place(): Promise<void> {
		placed.value = null;
		if (!options.open()) return;
		await nextTick();
		const el = options.menu.value;
		if (el === null) return;
		const { width, height } = el.getBoundingClientRect();
		const room = { w: window.innerWidth, h: window.innerHeight };
		const maxHeight = Math.max(room.h - 2 * MENU_MARGIN, 0);
		const shown = Math.min(height, maxHeight);
		placed.value = {
			left: Math.max(MENU_MARGIN, Math.min(options.x(), room.w - width - MENU_MARGIN)),
			top: Math.max(MENU_MARGIN, Math.min(options.y(), room.h - shown - MENU_MARGIN)),
			maxHeight,
			scrolls: height > maxHeight,
		};
	}

	watch([options.open, options.x, options.y], place, { immediate: true });

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

	return { style };
}
