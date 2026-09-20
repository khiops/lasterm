/**
 * Wait for the font a terminal will measure itself with.
 *
 * xterm sizes a cell from the font in use at the moment it fits. Measured
 * against a fallback, a wide window reported 231 columns where the loaded font
 * gives 206 — and since the PTY is spawned with what that fit reported, every
 * prompt wrapped. Waiting costs nothing once the font is cached.
 *
 * Resolves rather than throws: a family the browser cannot parse, or a
 * document with no font set at all, still has to end in a terminal.
 */
export async function awaitTerminalFont(
	fonts: FontFaceSet | undefined,
	fontFamily: string,
	fontSize: number,
): Promise<void> {
	if (!fonts) return;
	try {
		await fonts.load(`${fontSize}px ${fontFamily}`);
		await fonts.ready;
	} catch {
		// Nothing to wait for: the terminal measures with what the browser has.
	}
}
