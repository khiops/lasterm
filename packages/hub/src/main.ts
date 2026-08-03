import { startHub } from "./hub-startup.js";

async function main() {
	const envPort = process.env.TERMORA_PORT;
	if (envPort !== undefined) {
		const parsedEnvPort = Number(envPort);
		if (!Number.isInteger(parsedEnvPort) || parsedEnvPort < 1 || parsedEnvPort > 65535) {
			throw new Error(`Invalid TERMORA_PORT: ${envPort} — must be an integer between 1 and 65535`);
		}
	}
	await startHub({
		port: envPort !== undefined ? Number(envPort) : 4100,
		openBrowser: process.env.TERMORA_OPEN === "1",
		logging: true,
	});
}

main().catch((err) => {
	process.stderr.write(`Failed to start hub: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(
		err instanceof Error && "code" in err && err.code === "TERMORA_HUB_ALREADY_RUNNING" ? 73 : 1,
	);
});
