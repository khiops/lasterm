/**
 * What takes the keyboard, for the helpers that move it: the first control of a detail, the
 * places F6 goes, the edges of a Tab trap (#637).
 *
 * A control counts whatever its size or its opacity. A switch's checkbox is drawn by its track
 * and a segment's radio by its label: invisible themselves, they are the real controls. Only what
 * the browser itself skips is left out: an element that is `display: none` (or inside one),
 * `visibility: hidden`, disabled, inert, or out of the Tab order (`tabindex="-1"`).
 */

const CANDIDATES =
	'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

/** Whether the browser draws `el` at all: neither it nor an ancestor is `display: none`, and it is not `visibility: hidden`. */
export function isRendered(el: Element): boolean {
	if (el.closest("[hidden]") !== null) return false;
	const view = el.ownerDocument.defaultView;
	if (view === null) return true;
	if (view.getComputedStyle(el).visibility === "hidden") return false;
	for (let node: Element | null = el; node !== null; node = node.parentElement) {
		if (view.getComputedStyle(node).display === "none") return false;
	}
	return true;
}

function isDisabled(el: HTMLElement): boolean {
	if ((el as HTMLButtonElement).disabled === true) return true;
	// A control inside a disabled fieldset is disabled without saying so itself, but for one in
	// its legend.
	return el.closest("fieldset[disabled]") !== null && el.closest("legend") === null;
}

/** Whether Tab can reach `el`. */
export function isTabbable(el: HTMLElement): boolean {
	if (el.tabIndex < 0) return false;
	if (el instanceof HTMLInputElement && el.type === "hidden") return false;
	if (isDisabled(el)) return false;
	if (el.closest("[inert]") !== null) return false;
	return isRendered(el);
}

/** What Tab reaches inside `root`, in the order it reaches it. */
export function tabbables(root: ParentNode | null): HTMLElement[] {
	if (root === null) return [];
	return [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter(isTabbable);
}

/** The first thing Tab reaches inside `root`, or null. */
export function firstTabbable(root: ParentNode | null): HTMLElement | null {
	return tabbables(root)[0] ?? null;
}

/**
 * Keep Tab inside a modal `root`: from its last control Tab goes back to the first, and from its
 * first Shift+Tab goes to the last. Returns whether it moved the keyboard.
 */
export function trapTab(event: KeyboardEvent, root: HTMLElement | null): boolean {
	if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return false;
	const inside = tabbables(root);
	const first = inside[0];
	const last = inside[inside.length - 1];
	if (first === undefined || last === undefined) return false;
	const target = event.target;
	if (!event.shiftKey && target === last) {
		event.preventDefault();
		first.focus();
		return true;
	}
	if (event.shiftKey && target === first) {
		event.preventDefault();
		last.focus();
		return true;
	}
	return false;
}
