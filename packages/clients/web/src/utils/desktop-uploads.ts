/**
 * What the desktop shell knows of this window's uploads (#837, part of #721): the seam between
 * the page and the shell's part (#863), in the shape of every other desktop exchange (`invoke`
 * for the page's word, a Tauri event for the shell's), and no global on `window`.
 *
 * - **The page reports**, on every change of the uploads this window sends, and once at start
 *   (a new document starts from zero), with the async command `set_uploads_in_progress`:
 *   `{ seq, inProgress, waiting, failed, percent }` (`UploadsReport`, counted by
 *   `uploadsReportOf`). `seq` counts 1, 2, 3 … in this document: the calls may arrive out of
 *   order, and the shell drops a report whose `seq` is not above the last. It answers
 *   `{ pending: "quit" | "restart" | null }`, the quit (or restart) that waits for these uploads
 *   to end, chosen in the shell's native question ("Quit when finished").
 * - **The shell tells** the page when that changes, with the event `uploads-quit-pending`
 *   (`{ pending }`). While one is pending, Transfers says "Lasterm will quit when these uploads
 *   end · Cancel"; its Cancel is the command `cancel_quit_when_finished`, which answers whether a
 *   quit was waiting.
 *
 * The shell's own part: the native question while `inProgress > 0` ("Quit and resume later",
 * "Quit when finished", "Cancel"), the quit that waits, and the tray's text. A shell without
 * these commands (before #863) refuses them: said once in the console, and nothing else happens.
 * In a browser none of this runs; `upload-unload.ts` asks there.
 */
import { watch } from "vue";
import { isTauriRuntime } from "./tauri-runtime.js";
import type { UploadsReport } from "./transfers-view.js";

/** The command the page reports its uploads with. */
export const SET_UPLOADS_COMMAND = "set_uploads_in_progress";
/** The page's Cancel of a quit that waits for its uploads. */
export const CANCEL_QUIT_COMMAND = "cancel_quit_when_finished";
/** The event the shell says a change of that quit with. */
export const QUIT_PENDING_EVENT = "uploads-quit-pending";

/** The quit, or the restart, that waits for this window's uploads to end; null when none does. */
export type QuitPending = "quit" | "restart" | null;

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, handler: (payload: unknown) => void) => Promise<() => void>;

export interface DesktopBridge {
	readonly invoke: Invoke;
	readonly listen: Listen;
}

async function tauriBridge(): Promise<DesktopBridge> {
	const [{ invoke }, { listen }] = await Promise.all([
		import("@tauri-apps/api/core"),
		import("@tauri-apps/api/event"),
	]);
	return {
		invoke: (command, args) => invoke(command, args),
		listen: (event, handler) => listen(event, (e) => handler(e.payload)),
	};
}

/** What the shell says is pending, from its answer or its event; null for anything else. */
export function readPending(value: unknown): QuitPending {
	const pending = (value as { pending?: unknown } | null | undefined)?.pending;
	return pending === "quit" || pending === "restart" ? pending : null;
}

function same(a: UploadsReport | null, b: UploadsReport): boolean {
	return (
		a !== null &&
		a.inProgress === b.inProgress &&
		a.waiting === b.waiting &&
		a.failed === b.failed &&
		a.percent === b.percent
	);
}

export interface DesktopUploads {
	/** "Cancel" on the line that says the app will quit: true when a quit was waiting. */
	cancelQuit(): Promise<boolean>;
	stop(): void;
}

/**
 * Report `read()` to the desktop shell now and on every change, and hear what it has pending.
 * Does nothing outside the desktop.
 */
export function reportUploadsToDesktop(
	read: () => UploadsReport,
	onPending: (pending: QuitPending) => void,
	bridge: Promise<DesktopBridge> | null = isTauriRuntime() ? tauriBridge() : null,
): DesktopUploads {
	if (bridge === null) return { cancelQuit: async () => false, stop: () => undefined };
	let seq = 0;
	let last: UploadsReport | null = null;
	let refusedSaid = false;
	let stopped = false;
	let unlisten: (() => void) | null = null;

	const refused = (error: unknown): void => {
		if (refusedSaid) return;
		refusedSaid = true;
		console.warn("[transfers] the desktop shell did not take the uploads' report:", error);
	};

	const send = (report: UploadsReport): void => {
		if (same(last, report)) return;
		last = { ...report };
		seq++;
		const mine = seq;
		void bridge
			.then((b) => b.invoke(SET_UPLOADS_COMMAND, { seq: mine, ...report }))
			.then((answer) => {
				// Only the newest report's answer: an older one may come back after it.
				if (!stopped && mine === seq) onPending(readPending(answer));
			})
			.catch(refused);
	};

	const stopWatch = watch(read, send, { immediate: true, deep: true });
	void bridge
		.then((b) => b.listen(QUIT_PENDING_EVENT, (payload) => onPending(readPending(payload))))
		.then((off) => {
			if (stopped) off();
			else unlisten = off;
		})
		.catch(refused);

	return {
		async cancelQuit() {
			try {
				const b = await bridge;
				const cancelled = (await b.invoke(CANCEL_QUIT_COMMAND)) === true;
				onPending(null);
				return cancelled;
			} catch (error) {
				refused(error);
				return false;
			}
		},
		stop() {
			stopped = true;
			stopWatch();
			unlisten?.();
		},
	};
}
