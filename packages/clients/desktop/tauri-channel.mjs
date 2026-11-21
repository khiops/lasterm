// The Tauri CLI as this package runs it (`pnpm tauri`, `pnpm build`): with the
// build channel's identity on what it bundles (#1084). build.rs gives the
// executable its identity, but the CLI's bundler reads only the configuration
// the CLI itself loaded: tauri.conf.json, the platform's file and the
// `--config` arguments, with no environment variable for a further one. So a
// development build's installers would otherwise carry the release name and
// identifier. The channel is exactly LASTERM_CHANNEL=release for release,
// anything else dev, as everywhere.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "tauri.dev.conf.json");

/** The CLI arguments to run: `args`, plus the dev identity when a dev build bundles. */
export function channelArgs(args, env) {
	if (env.LASTERM_CHANNEL === "release") return args;
	// What follows `--` goes to the runner, Cargo, not to the CLI.
	const separator = args.indexOf("--");
	const end = separator === -1 ? args.length : separator;
	// The CLI's own options before the subcommand (-v/--verbose, -h, -V) take
	// no value, so the subcommand is its first argument that is no option.
	const subcommand = args.slice(0, end).find((arg) => !arg.startsWith("-"));
	if (subcommand !== "build" && subcommand !== "bundle") return args;
	// Last of the CLI's options: the identity wins over any other `--config`,
	// as build.rs makes it win for the executable.
	return [...args.slice(0, end), "--config", DEV_CONFIG, ...args.slice(end)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const cli = createRequire(import.meta.url)("@tauri-apps/cli/main");
	cli.run(channelArgs(process.argv.slice(2), process.env), "pnpm tauri").catch((error) => {
		cli.logError(error.message);
		process.exit(1);
	});
}
