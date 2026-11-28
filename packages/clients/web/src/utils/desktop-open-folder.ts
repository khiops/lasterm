/**
 * Folders File Explorer asked to open (#1236, EXPLORER-OPEN-IN in docs/decisions.md).
 *
 * The desktop queues each folder its Explorer command hands over and tells the page with
 * `open-folder-requested`, again every 2 s while folders wait. The page takes the queue with a
 * token: the desktop removes what it returns, except that the token of its previous call returns
 * that call's batch again. The page keeps its token, in memory and in `sessionStorage`, until it
 * has processed the batch, so a call repeated after a lost reply or a failed call gets the same
 * folders. After a reload, the next page replays the stored token and gets a batch taken but not
 * processed, while `sessionStorage` kept the token and no other token reached the desktop first
 * (it keeps only its last token's batch). A token whose removal the storage refused replays a
 * processed batch at each reload while the desktop keeps that batch: each reload can open its
 * folders again (accepted in #1236).
 *
 * The page takes nothing during its startup: a request meanwhile (an event, the 2 s interval, a
 * host list published) is only remembered, and `start` consumes it once the startup has tried the
 * host list. From then on the page takes only while `ready` holds: a usable host list, and the UI
 * preferences, which say which host a folder's tab brings into view. While it does not, a folder
 * known to wait keeps a notice up and has what is missing asked for again every 5 s.
 */

import { isTauriRuntime } from "./tauri-runtime.js";

/** The page's token for the batch it is taking, across a reload of the page. */
export const OPEN_FOLDER_TOKEN_KEY = "lasterm_open_folder_token";

/** How long after a failed take the page takes again, with the same token. */
export const TAKE_RETRY_MS = 2000;

/**
 * How long after asking for what it lacks (the host list, the preferences) the page asks again
 * while a folder waits.
 */
export const REREAD_MS = 5000;

/** Whether this page runs in the desktop app, where folders from File Explorer arrive. */
export function folderRequestsAvailable(): boolean {
	return isTauriRuntime();
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(command, args);
}

/** Whether folders wait, without taking them. */
export function hasOpenFolderRequests(): Promise<boolean> {
	return invoke<boolean>("has_open_folder_requests");
}

/** The folders waiting, removed; the previous call's batch again for its token. */
export function takeOpenFolderRequests(token: string): Promise<string[]> {
	return invoke<string[]>("take_open_folder_requests", { token });
}

/** Calls `onRequest` each time the desktop says folders wait; resolves to the unsubscribe. */
export async function listenOpenFolderRequested(onRequest: () => void): Promise<() => void> {
	const { listen } = await import("@tauri-apps/api/event");
	return listen("open-folder-requested", () => onRequest());
}

/** 16 random bytes, hex. */
export function newToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readStoredToken(): string | null {
	try {
		return sessionStorage.getItem(OPEN_FOLDER_TOKEN_KEY);
	} catch {
		return null;
	}
}

function storeToken(token: string | null): void {
	try {
		if (token === null) sessionStorage.removeItem(OPEN_FOLDER_TOKEN_KEY);
		else sessionStorage.setItem(OPEN_FOLDER_TOKEN_KEY, token);
	} catch {
		// A storage that refuses: the token lives in memory for this page's life.
	}
}

export interface FolderOpenerDeps {
	/**
	 * Whether a folder can open now: a host list received whose last load did not fail, and the UI
	 * preferences received, which say which host the folder's tab brings into view.
	 */
	ready: () => boolean;
	/** Whether folders wait in the desktop's queue. */
	waiting: () => Promise<boolean>;
	take: (token: string) => Promise<string[]>;
	/** Opens one terminal per folder, or says why not. Synchronous: no reload can come between. */
	process: (folders: string[]) => void;
	/** Called once, after the first batch is processed, saying whether it held folders. */
	firstBatch: (nonEmpty: boolean) => void;
	/** Asks again for what `ready` lacks: the hosts store's protected re-read, the preferences. */
	reload: () => void;
	/** Shows that a folder waits for the hub; `onUserDismiss` runs if the user closes the notice. */
	showWaitNotice: (onUserDismiss: () => void) => void;
	hideWaitNotice: () => void;
}

export interface FolderOpener {
	/**
	 * Takes and opens what waits; serialised, a call during a pass makes another pass. Before
	 * `start`, it only remembers that it was called.
	 */
	drain: () => Promise<void>;
	/**
	 * The startup has tried the host list, or failed before it could; `waiting` is what the desktop
	 * answered at mount, null when it could not tell. Opens the gate, once. A folder known to wait
	 * (`waiting` true, or a held batch) is taken now if `ready`, else the notice shows and what is
	 * missing is asked for every 5 s until it is, with no event needed and whatever `waiting`
	 * answers later. An unknown answer, or a call of `drain` during the startup, makes one pass.
	 */
	start: (waiting: boolean | null) => void;
	/** Whether a batch was taken and not processed yet (its token is held). */
	holdingBatch: () => boolean;
	stop: () => void;
}

export function createFolderOpener(deps: FolderOpenerDeps): FolderOpener {
	let token: string | null = readStoredToken();
	let running = false;
	let again = false;
	let firstSeen = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let rereadTimer: ReturnType<typeof setTimeout> | null = null;
	let noticeShown = false;
	// The startup gate: closed until `start`; a `drain` meanwhile is remembered in `asked`.
	let started = false;
	let asked = false;
	// Folders known to wait since startup (`start`), until a batch is processed.
	let expected = false;
	// Once stopped (the page is going), nothing is taken or opened; a batch taken meanwhile is
	// replayed by the next page from the stored token.
	let stopped = false;

	const showNotice = (): void => {
		if (noticeShown) return;
		noticeShown = true;
		// Closed by the user: the next folder that waits shows it again.
		deps.showWaitNotice(() => {
			noticeShown = false;
		});
	};
	const hideNotice = (): void => {
		if (!noticeShown) return;
		noticeShown = false;
		deps.hideWaitNotice();
	};
	const scheduleReread = (): void => {
		if (rereadTimer !== null) return;
		rereadTimer = setTimeout(() => {
			rereadTimer = null;
			if (!deps.ready()) deps.reload();
			// Still waiting after this read: the next pass asks again 5 s later.
			void drain();
		}, REREAD_MS);
	};

	async function pass(): Promise<void> {
		if (stopped) return;
		if (!deps.ready()) {
			// Known to wait: a held batch, or a folder the startup was told of. Otherwise asked;
			// null when the desktop cannot tell.
			let waits: boolean | null = token !== null || expected ? true : null;
			if (waits === null) {
				try {
					waits = await deps.waiting();
				} catch {
					waits = null;
				}
			}
			if (stopped) return;
			// Unknown: asked again after the next re-read, without saying that a folder waits.
			if (waits !== false) scheduleReread();
			if (waits === true) showNotice();
			return;
		}
		if (token === null) {
			token = newToken();
			storeToken(token);
		}
		let folders: string[];
		try {
			folders = await deps.take(token);
		} catch (error) {
			console.warn("[desktop] could not take the folders from File Explorer:", error);
			if (retryTimer === null) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					void drain();
				}, TAKE_RETRY_MS);
			}
			return;
		}
		if (stopped) return;
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		// The page stopped being ready during the call: keep the batch and its token.
		if (!deps.ready()) {
			scheduleReread();
			showNotice();
			return;
		}
		if (rereadTimer !== null) {
			clearTimeout(rereadTimer);
			rereadTimer = null;
		}
		hideNotice();
		deps.process(folders);
		// Processed: the token goes only now, so a batch whose processing failed stays available
		// to the next call, with its token.
		token = null;
		storeToken(null);
		expected = false;
		if (!firstSeen) {
			firstSeen = true;
			deps.firstBatch(folders.length > 0);
		}
	}

	async function drain(): Promise<void> {
		if (!started) {
			asked = true;
			return;
		}
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			do {
				again = false;
				await pass();
			} while (again);
		} finally {
			running = false;
		}
	}

	return {
		drain,
		start: (waiting) => {
			if (started || stopped) return;
			started = true;
			if (waiting === true || token !== null) expected = true;
			if (expected || waiting === null || asked) void drain();
			asked = false;
		},
		holdingBatch: () => token !== null,
		stop: () => {
			stopped = true;
			if (retryTimer !== null) clearTimeout(retryTimer);
			if (rereadTimer !== null) clearTimeout(rereadTimer);
			retryTimer = null;
			rereadTimer = null;
			hideNotice();
		},
	};
}
