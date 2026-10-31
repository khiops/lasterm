/**
 * Recovery from Tauri's postMessage fallback (#822).
 *
 * Tauri's IPC script sends each command as a `fetch` to its `ipc.localhost`
 * custom protocol. When a single one of those fetches fails, the script sets a
 * flag for the life of the page and sends every later command through
 * `postMessage`, which carries its body as JSON. The desktop takes WebSocket
 * input and upload chunks as raw bytes only and refuses anything else
 * ("… must use Tauri raw IPC bytes"). From then on nothing typed in the page
 * reached the hub, and every reconnect was refused the same way: the window
 * stayed on "Reconnecting" for good while the hub was fine.
 *
 * The flag lives in a closure of Tauri's script, out of reach; only a new
 * document resets it. Terminals live in the hub and survive a reload. So that
 * refusal is taken as news of the fallback, and the page reloads, once.
 *
 * Never twice in a row: the reload is recorded in sessionStorage, and the record
 * is cleared only once a raw-bytes command has gone through again. A page that
 * meets the refusal while the record is there reloaded for nothing (its custom
 * protocol fails from the start), and reloading again would only loop, so it
 * does not. Without a record there is no telling a first reload from a loop, so
 * none happens either.
 */

/** What native answers a raw-bytes command whose body reached it as JSON. */
export const RAW_IPC_REFUSAL = "must use Tauri raw IPC bytes";

/** This tab's record of a reload made for the fallback: when, and what said so. */
export const IPC_FALLBACK_RELOAD_KEY = "lasterm:ipc-fallback:reloaded";

let rawIpcConfirmed = false;
let reloadRequested = false;
let reloadPage: () => void = () => window.location.reload();

/** Whether an IPC failure is native refusing a body that Tauri sent as JSON. */
export function isRawIpcRefusal(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(RAW_IPC_REFUSAL);
}

/**
 * A raw-bytes command went through: this page's custom protocol works. A reload
 * the fallback made has done its job, so a later fallback may reload again.
 */
export function rawIpcWorked(): void {
	if (rawIpcConfirmed) return;
	rawIpcConfirmed = true;
	const record = readRecord();
	if (record === null) return;
	clearRecord();
	console.info(
		`[ipc] raw IPC works again after the reload for Tauri's postMessage fallback (${record})`,
	);
}

/**
 * Reload the page to get Tauri's custom protocol back. True when the page is
 * reloading; false when it will not, because the reload before it brought no
 * raw-bytes command through, or because nothing can record it. The caller then
 * stops retrying: nothing in this page can carry raw bytes any more.
 */
export function reloadAfterIpcFallback(reason: string): boolean {
	if (reloadRequested) return true;
	const previous = readRecord();
	if (previous !== null) {
		console.error(
			`[ipc] Tauri's IPC fell back to postMessage again (${reason}), and the reload for the last time (${previous}) did not bring raw IPC back: not reloading again`,
		);
		return false;
	}
	if (!writeRecord(`${new Date().toISOString()} ${reason}`)) {
		console.error(
			`[ipc] Tauri's IPC fell back to postMessage (${reason}), and this page cannot record a reload to guard it: not reloading`,
		);
		return false;
	}
	reloadRequested = true;
	console.warn(`[ipc] Tauri's IPC fell back to postMessage (${reason}): reloading the page once`);
	reloadPage();
	return true;
}

function readRecord(): string | null {
	try {
		return window.sessionStorage.getItem(IPC_FALLBACK_RELOAD_KEY);
	} catch {
		return null;
	}
}

function writeRecord(value: string): boolean {
	try {
		window.sessionStorage.setItem(IPC_FALLBACK_RELOAD_KEY, value);
		return window.sessionStorage.getItem(IPC_FALLBACK_RELOAD_KEY) === value;
	} catch {
		return false;
	}
}

function clearRecord(): void {
	try {
		window.sessionStorage.removeItem(IPC_FALLBACK_RELOAD_KEY);
	} catch {
		// Nothing was recorded where nothing can be.
	}
}

/**
 * For tests only: the reload to call instead of `location.reload()` (null puts
 * it back), and a page that has neither seen raw IPC work nor asked to reload.
 */
export function resetIpcFallbackForTests(reload: (() => void) | null = null): void {
	rawIpcConfirmed = false;
	reloadRequested = false;
	reloadPage = reload ?? (() => window.location.reload());
}
