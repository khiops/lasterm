/**
 * Stop the hub once the process that launched it is gone (#188).
 *
 * The desktop starts its hub with a stdin pipe it never writes to. However the
 * desktop ends — a crash, a kill, a closed session — the operating system then
 * closes its end of that pipe, and the hub reads end-of-file. Stopping there is
 * what keeps an orphaned hub from holding `hub.lock` against the next launch.
 *
 * Opt-in through `start --exit-with-stdin`, which only the desktop passes: a hub
 * run from a terminal, or as a daemon with stdin ignored, must not stop because
 * its stdin ends.
 */
export function shutdownWhenStdinCloses(stdin: NodeJS.ReadableStream, shutdown: () => void): void {
	let fired = false;
	const fire = () => {
		if (fired) return;
		fired = true;
		shutdown();
	};
	stdin.on("end", fire);
	stdin.on("close", fire);
	// A read error on this pipe means its other end is gone too.
	stdin.on("error", fire);
	// Only reading makes end-of-file observable; the bytes, if any, mean nothing.
	stdin.on("data", () => {});
}
