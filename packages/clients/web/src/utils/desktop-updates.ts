/**
 * The desktop's update state and commands (STORE-UPDATE-NOTICE in docs/decisions.md, #1214).
 *
 * The desktop process owns everything: it asks the Microsoft Store, keeps the setting in
 * `desktop-updates.json`, and publishes its state as `update-state`. The page only shows it and
 * sends the user's choices back. Nothing here runs outside the desktop app.
 */

export type UpdateMode = "ask" | "auto" | "off";

export interface UpdateOffer {
	key: string;
	/** Present only when higher than the running version. */
	version?: string;
	mandatory: boolean;
	signal: "true" | "false" | "error";
}

export interface UpdateNotice {
	id: number;
	kind: "updated" | "mandatory" | "waiting";
	text: string;
}

export interface UpdateState {
	seq: number;
	eligible: boolean;
	mode: UpdateMode;
	runningVersion: string;
	storeError?: string;
	checking: "idle" | "running" | "waiting";
	lastCheckedAt?: string;
	lastAttemptAt?: string;
	checkError?: string;
	offer?: UpdateOffer;
	wantsDialog: boolean;
	loadError?: string;
	saveError?: string;
	notices: UpdateNotice[];
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(command, args);
}

/** The desktop commands, one function each (D10). Each rejects with the desktop's message. */
export const updateCommands = {
	getState: () => invoke<UpdateState>("get_update_state"),
	setMode: (mode: UpdateMode) => invoke<void>("set_update_mode", { mode }),
	chooseAlwaysUpdate: (key: string) => invoke<void>("choose_always_update", { key }),
	check: () => invoke<void>("check_for_updates"),
	/** `false` when the choice holds until Lasterm restarts only. */
	snooze: (key: string) => invoke<boolean>("snooze_update", { key }),
	openStorePage: () => invoke<void>("open_store_page"),
	openStoreUpdates: () => invoke<void>("open_store_updates"),
	acknowledge: (noticeId: number) => invoke<void>("acknowledge_notice", { noticeId }),
};

/**
 * Subscribe to `update-state` first, then read the snapshot, and hand on a state only when its
 * `seq` is higher than the last one handed on: a change between the two is never lost, and an
 * older snapshot never replaces a newer event.
 */
export async function connectUpdateState(apply: (state: UpdateState) => void): Promise<() => void> {
	let last = -1;
	const take = (state: UpdateState) => {
		if (state.seq <= last) return;
		last = state.seq;
		apply(state);
	};
	const { listen } = await import("@tauri-apps/api/event");
	const unlisten = await listen<UpdateState>("update-state", (event) => take(event.payload));
	take(await updateCommands.getState());
	return unlisten;
}

/** What an error from a command says. */
export function commandError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
