/**
 * A browser asks before leaving a page that sends uploads (#837, part of #721).
 *
 * While this window sends the bytes of an upload, a `beforeunload` handler is installed, so the
 * browser asks its own question: leave or stay. Leaving is "quit and resume later" (the uploads
 * stop; their handles, where kept, offer them at the next start; otherwise they wait for a
 * re-drop); staying is Cancel. A browser offers no "when finished": a page cannot close its own
 * tab later. Only the uploads this window sends count: a reader closes without a question.
 *
 * The desktop asks its own question instead, natively, before its window closes or the app
 * quits; the handler is for a browser only.
 *
 * The handler goes before the guarded reload of `tauri-ipc-fallback.ts` (#823), which must never
 * wait on a question: that reload registers what to undo first (`onGuardedReload`), and the
 * guard is released for the rest of the page's life.
 */
import { onGuardedReload } from "./tauri-ipc-fallback.js";

export interface UnloadGuard {
	/** Whether this window sends uploads now: installs the handler, or removes it. */
	set(sending: boolean): void;
	/** Remove the handler for good: the page is about to reload by itself. */
	release(): void;
	/** Whether the handler is installed: for tests. */
	readonly installed: boolean;
}

/** The guard on `target`, released before a guarded reload. */
export function createUnloadGuard(target: Window = window): UnloadGuard {
	let installed = false;
	let released = false;
	const onBeforeUnload = (event: BeforeUnloadEvent) => {
		event.preventDefault();
		// Chromium before 119 and WebView2 ask only for a value set here; its text is never shown.
		event.returnValue = "";
	};
	const remove = () => {
		if (!installed) return;
		installed = false;
		target.removeEventListener("beforeunload", onBeforeUnload);
	};
	const stopListening = onGuardedReload(() => guard.release());
	const guard: UnloadGuard = {
		set(sending) {
			if (released) return;
			if (sending && !installed) {
				installed = true;
				target.addEventListener("beforeunload", onBeforeUnload);
			} else if (!sending) {
				remove();
			}
		},
		release() {
			released = true;
			remove();
			stopListening();
		},
		get installed() {
			return installed;
		},
	};
	return guard;
}
