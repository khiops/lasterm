import { describe, expect, it, vi } from "vitest";
import { awaitTerminalFont } from "./terminal-font.js";

/** A font set that answers in the order a browser does: load, then ready. */
function fontSet(overrides: Partial<FontFaceSet> = {}): FontFaceSet {
	return {
		load: vi.fn().mockResolvedValue([]),
		ready: Promise.resolve(),
		...overrides,
	} as unknown as FontFaceSet;
}

describe("awaitTerminalFont", () => {
	it("asks for the font the terminal will use, at its size", async () => {
		const fonts = fontSet();

		await awaitTerminalFont(fonts, '"FiraCode Nerd Font Mono", monospace', 14);

		expect(fonts.load).toHaveBeenCalledWith('14px "FiraCode Nerd Font Mono", monospace');
	});

	// The terminal must open whatever the font set answers: a measurement with a
	// fallback is a wrapped prompt, but no terminal at all is worse.
	it("returns when the family cannot be parsed", async () => {
		const fonts = fontSet({ load: vi.fn().mockRejectedValue(new SyntaxError("bad family")) });

		await expect(awaitTerminalFont(fonts, "not a font(", 14)).resolves.toBeUndefined();
	});

	it("returns when the document has no font set", async () => {
		await expect(awaitTerminalFont(undefined, "monospace", 14)).resolves.toBeUndefined();
	});

	it("waits for the set to settle, not only for the one face", async () => {
		let settle = (): void => undefined;
		// The set resolves with itself, so the wait is on the whole set settling.
		const ready = new Promise<FontFaceSet>((resolve) => {
			settle = () => resolve({} as FontFaceSet);
		});
		let done = false;
		const waiting = awaitTerminalFont(fontSet({ ready }), "monospace", 14).then(() => {
			done = true;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(done).toBe(false);

		settle();
		await waiting;
		expect(done).toBe(true);
	});
});
