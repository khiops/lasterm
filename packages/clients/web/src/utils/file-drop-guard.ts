/**
 * A file or a link dropped where nothing takes it must not be opened (#822).
 *
 * The browser's default for a dropped file or link is to open it: Chromium asks
 * for a new tab on its URL. Some of the app's drop zones accept every drag and
 * ignore what they do not use (a terminal pane takes panes moved onto it, not
 * files); elsewhere nothing accepts the drag at all. Either way that default
 * ran. The desktop refuses the new window, but on WebView2 the request alone
 * made the custom-protocol fetches in flight fail with ERR_CONNECTION_REFUSED,
 * and a single such failure turns Tauri's IPC to postMessage for the rest of the
 * page: the window then stayed on "Reconnecting" (see `tauri-ipc-fallback.ts`).
 * In a browser tab, the same drop opened the file beside the app.
 *
 * Installed once on the window, so it runs after every element's own handler:
 * a drag from outside that nobody accepted is refused (the cursor says so), and
 * a drop nobody prevented is prevented. The zones that take files (wallpapers,
 * fonts, keys) keep them: they prevent the default themselves, before this
 * runs. A link dropped into a text field is left to the field, which inserts it.
 */

function carriesFile(event: DragEvent): boolean {
	return event.dataTransfer?.types.includes("Files") ?? false;
}

function carriesLink(event: DragEvent): boolean {
	return event.dataTransfer?.types.includes("text/uri-list") ?? false;
}

function isTextField(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target.isContentEditable
	);
}

/** Whether the browser would open what this drag carries if it were dropped here. */
function wouldOpen(event: DragEvent): boolean {
	if (carriesFile(event)) return true;
	return carriesLink(event) && !isTextField(event.target);
}

/** Refuse what nothing takes, on `target`. Returns what removes the guard. */
export function installFileDropGuard(target: Window = window): () => void {
	const onDragOver = (event: DragEvent) => {
		if (event.defaultPrevented || !wouldOpen(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
	};
	const onDrop = (event: DragEvent) => {
		if (wouldOpen(event)) event.preventDefault();
	};
	target.addEventListener("dragover", onDragOver);
	target.addEventListener("drop", onDrop);
	return () => {
		target.removeEventListener("dragover", onDragOver);
		target.removeEventListener("drop", onDrop);
	};
}
