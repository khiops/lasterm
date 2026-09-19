import { startHub } from "./hub-startup.js";
import { PreviousInstallationError } from "./previous-installation.js";
import { resolveStartPort } from "./start-port.js";

async function main() {
	const port = resolveStartPort(undefined, process.env.LASTERM_PORT);
	await startHub({
		...(port !== undefined ? { port } : {}),
		openBrowser: process.env.LASTERM_OPEN === "1",
		logging: true,
	});
}

main().catch((err) => {
	// A refusal is a diagnosis and its text is the whole point; a stack buries it.
	if (err instanceof PreviousInstallationError) {
		process.stderr.write(`${err.message}\n`);
		process.exit(1);
	}
	process.stderr.write(`Failed to start hub: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(
		err instanceof Error && "code" in err && err.code === "LASTERM_HUB_ALREADY_RUNNING" ? 73 : 1,
	);
});
