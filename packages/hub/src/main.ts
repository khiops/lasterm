import { startHub } from "./hub-startup.js";
import { PreviousInstallationError } from "./previous-installation.js";

async function main() {
	const envPort = process.env.LASTERM_PORT;
	if (envPort !== undefined) {
		const parsedEnvPort = Number(envPort);
		if (!Number.isInteger(parsedEnvPort) || parsedEnvPort < 1 || parsedEnvPort > 65535) {
			throw new Error(`Invalid LASTERM_PORT: ${envPort} — must be an integer between 1 and 65535`);
		}
	}
	await startHub({
		...(envPort !== undefined ? { port: Number(envPort) } : {}),
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
