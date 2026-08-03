import { describe, expect, it } from "vitest";
import { createCloseGestureGuard } from "./close-gesture.js";

describe("createCloseGestureGuard", () => {
	it("allows only one quit when two close gestures arrive during an async preference read", async () => {
		const guard = createCloseGestureGuard();
		let releaseRead: (() => void) | undefined;
		const preferenceRead = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		let quits = 0;

		async function handleClose(): Promise<void> {
			if (!guard.tryEnter()) return;
			try {
				await preferenceRead;
				quits += 1;
			} finally {
				guard.leave();
			}
		}

		const first = handleClose();
		const second = handleClose();
		releaseRead?.();
		await Promise.all([first, second]);

		expect(quits).toBe(1);
	});
});
