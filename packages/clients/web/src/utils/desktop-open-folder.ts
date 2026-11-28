/**
 * Folders File Explorer asked to open (#1236, EXPLORER-OPEN-IN in docs/decisions.md).
 *
 * The desktop queues each folder its Explorer command hands over and tells the page with
 * `open-folder-requested`, again every 2 s while folders wait. The page takes the queue with a
 * token: the desktop removes what it returns, except that the token of its previous call returns
 * that call's batch again. The page keeps its token, in memory and in `sessionStorage`, until it
 * has processed the batch, so a call repeated after a lost reply, a failed call, or a reload gets
 * the same folders and opens them once.
 */

import { isTauriRuntime } from "./tauri-runtime.js";

/** The page's token for the batch it is taking, across a reload of the page. */
export const OPEN_FOLDER_TOKEN_KEY = "lasterm_open_folder_token";

/** How long after a failed take the page takes again, with the same token. */
export const TAKE_RETRY_MS = 2000;

/** How long after asking for the host list the page asks again while a folder waits. */
export const HOSTS_REREAD_MS = 5000;

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
	/** A host list has been received and the last load did not fail. */
	hostsUsable: () => boolean;
	/** Whether folders wait in the desktop's queue. */
	waiting: () => Promise<boolean>;
	take: (token: string) => Promise<string[]>;
	/** Opens one terminal per folder, or says why not. Synchronous: no reload can come between. */
	process: (folders: string[]) => void;
	/** Called once, after the first batch is processed, saying whether it held folders. */
	firstBatch: (nonEmpty: boolean) => void;
	/** The hosts store's protected re-read. */
	rereadHosts: () => void;
	showWaitNotice: () => void;
	hideWaitNotice: () => void;
}

export interface FolderOpener {
	/** Takes and opens what waits; serialised, a call during a pass makes another pass. */
	drain: () => Promise<void>;
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
	// Once stopped (the page is going), nothing is taken or opened; a batch taken meanwhile is
	// replayed by the next page from the stored token.
	let stopped = false;

	const showNotice = (): void => {
		if (noticeShown) return;
		noticeShown = true;
		deps.showWaitNotice();
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
			deps.rereadHosts();
			// Still waiting after this read: the next pass asks again 5 s later.
			void drain();
		}, HOSTS_REREAD_MS);
	};

	async function pass(): Promise<void> {
		if (stopped) return;
		if (!deps.hostsUsable()) {
			let waits = token !== null;
			if (!waits) {
				try {
					waits = await deps.waiting();
				} catch {
					waits = false;
				}
			}
			if (waits) {
				scheduleReread();
				showNotice();
			}
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
		// The list became unusable during the call: keep the batch and its token.
		if (!deps.hostsUsable()) {
			scheduleReread();
			showNotice();
			return;
		}
		token = null;
		storeToken(null);
		hideNotice();
		deps.process(folders);
		if (!firstSeen) {
			firstSeen = true;
			deps.firstBatch(folders.length > 0);
		}
	}

	async function drain(): Promise<void> {
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
		holdingBatch: () => token !== null,
		stop: () => {
			stopped = true;
			if (retryTimer !== null) clearTimeout(retryTimer);
			if (rereadTimer !== null) clearTimeout(rereadTimer);
			retryTimer = null;
			rereadTimer = null;
		},
	};
}
