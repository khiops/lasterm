/** Prevents concurrent native close gestures while their preference read is pending. */
export function createCloseGestureGuard(): { tryEnter: () => boolean; leave: () => void } {
	let entered = false;

	return {
		tryEnter(): boolean {
			if (entered) return false;
			entered = true;
			return true;
		},
		leave(): void {
			entered = false;
		},
	};
}
