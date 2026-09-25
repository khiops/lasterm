/**
 * The questions this app asks before doing something it cannot undo, and
 * whether it still asks them.
 *
 * Each one can be answered once with "don't ask again", which is the right
 * offer for a gesture someone repeats — and the wrong one to make
 * irreversible. A person who silenced a question months ago has no way back to
 * it unless the questions are listed somewhere, which is what this is for.
 *
 * The answers live in this browser, not in the hub's configuration: they are
 * about how one person works at one machine, and a terminal opened from a
 * phone should not inherit what was silenced on a desktop.
 */

/** The key a confirmation is remembered under, without its prefix. */
export type ConfirmationKey = "ConfirmKill" | "ConfirmCloseAll" | "ConfirmCloseOthers";

export interface ConfirmationDescriptor {
	key: ConfirmationKey;
	/** What the question is about, as a person would name it. */
	label: string;
	/** What happens when it is not asked. */
	description: string;
}

export const CONFIRMATIONS: ConfirmationDescriptor[] = [
	{
		key: "ConfirmKill",
		label: "Killing a terminal",
		description: "Its shell and everything started in it are terminated, which nothing undoes.",
	},
	{
		key: "ConfirmCloseAll",
		label: "Closing every tab",
		description: "Every tab in the window is closed at once.",
	},
	{
		key: "ConfirmCloseOthers",
		label: "Closing the other tabs",
		description: "Every tab but the one in hand is closed at once.",
	},
];

function storageKey(key: ConfirmationKey): string {
	return `lasterm:skip${key}`;
}

/**
 * Whether this question is still asked.
 *
 * A browser that refuses storage asks it: the careful answer is the one that
 * puts the decision back in front of the person.
 */
export function confirmationIsAsked(key: ConfirmationKey): boolean {
	try {
		return localStorage.getItem(storageKey(key)) !== "true";
	} catch {
		return true;
	}
}

/** Ask this question again, or stop asking it. */
export function setConfirmationAsked(key: ConfirmationKey, asked: boolean): void {
	try {
		if (asked) {
			localStorage.removeItem(storageKey(key));
		} else {
			localStorage.setItem(storageKey(key), "true");
		}
	} catch {
		// A browser that refuses storage keeps asking, which is the safe end.
	}
}
