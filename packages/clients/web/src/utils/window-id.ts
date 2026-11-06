import { generateId, isValidUlid } from "@lasterm/shared";

/**
 * This window's id: the same across its reloads, never the same in two
 * windows (#846).
 *
 * The hub gives every socket a new client id, so a window that reloads or
 * reconnects comes back as someone new. Its AUTH also names this id, and a
 * write lock's holder coming back under the same token and the same window
 * within the hub's grace gets the lock back, and with it the terminal's size.
 *
 * sessionStorage has the scope of a window: it survives a reload, the
 * desktop's own after Tauri's IPC fallback (#823) included, and a new window
 * starts without it. A browser duplicating a tab copies it, though, which would
 * give two windows one id. So the page takes the id out of storage when it
 * starts, and puts it back only as it goes (`pagehide`, which a reload fires):
 * a tab duplicated meanwhile finds none, and draws its own.
 */
export const WINDOW_ID_KEY = "lasterm:window-id";

let current: string | null = null;

/** This window's id, drawn on the first call when the page has none to resume. */
export function windowId(): string {
	if (current !== null) return current;
	const resumed = take();
	const id = isValidUlid(resumed) ? resumed : generateId();
	current = id;
	window.addEventListener("pagehide", keep);
	window.addEventListener("pageshow", resume);
	return id;
}

/** The page is going, perhaps to load again: leave the id for the next one. */
function keep(): void {
	if (current === null) return;
	try {
		window.sessionStorage.setItem(WINDOW_ID_KEY, current);
	} catch {
		// Storage refused: the next page draws an id of its own, and a lock this
		// window held is handed on after the grace, as any other.
	}
}

/** Back from the back-forward cache: the page lives again, and holds its id itself. */
function resume(event: PageTransitionEvent): void {
	if (event.persisted) take();
}

/** Read the id a page before this one left, and take it out of storage. */
function take(): string | null {
	try {
		const kept = window.sessionStorage.getItem(WINDOW_ID_KEY);
		window.sessionStorage.removeItem(WINDOW_ID_KEY);
		return kept;
	} catch {
		return null;
	}
}

/** For tests only: a page that has not drawn its id yet. */
export function resetWindowIdForTests(): void {
	window.removeEventListener("pagehide", keep);
	window.removeEventListener("pageshow", resume);
	current = null;
}
