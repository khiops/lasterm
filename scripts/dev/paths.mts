#!/usr/bin/env -S pnpm exec tsx
// Prints a path exactly as the hub resolves it, so the dev scripts start, wait
// for and stop what the hub will look for instead of recomputing it in shell,
// which drifted from the hub more than once (#161).
//
//   paths.mts agent-socket   the local agent endpoint (getSocketPath)
//   paths.mts state-dir      the hub state directory (runtime.json lives there)
import { lastermDir } from "../../packages/shared/src/platform-dirs.js";
import { getSocketPath } from "../../packages/shared/src/socket-path.js";

const which = process.argv[2];
if (which === "agent-socket") process.stdout.write(`${getSocketPath()}\n`);
else if (which === "state-dir") process.stdout.write(`${lastermDir("state")}\n`);
else {
	process.stderr.write("usage: paths.mts agent-socket|state-dir\n");
	process.exit(2);
}
