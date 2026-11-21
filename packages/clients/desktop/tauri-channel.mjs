// The Tauri CLI as this package runs it (`pnpm tauri`, `pnpm build`): with the
// build channel's identity on what it bundles (#1084). build.rs gives the
// executable its identity, but the CLI's bundler reads only the configuration
// the CLI itself loaded, so a development build's installers would otherwise
// carry the release name and identifier. The channel is exactly
// LASTERM_CHANNEL=release for release, anything else dev, as everywhere.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "tauri.dev.conf.json");

/** The CLI arguments to run: `args`, plus the dev identity when a dev build bundles. */
export function channelArgs(args, env) {
	const bundles = args[0] === "build" || args[0] === "bundle";
	return bundles && env.LASTERM_CHANNEL !== "release" ? [...args, "--config", DEV_CONFIG] : args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const cli = createRequire(import.meta.url)("@tauri-apps/cli/main");
	cli.run(channelArgs(process.argv.slice(2), process.env), "pnpm tauri").catch((error) => {
		cli.logError(error.message);
		process.exit(1);
	});
}
