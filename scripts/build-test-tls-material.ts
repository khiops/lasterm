/**
 * Builds what the hub specs load and run from the cargo target directory: the
 * two native addons and the TLS test material generator. `pnpm -F @lasterm/hub
 * test` runs it first. It is the one build the hub test setup accepts; see
 * packages/hub/src/native-build.fixture.ts for why a plain `cargo build` is not.
 *
 * The crates are cleaned first unless the build recorded in the target
 * directory is still there and matches this checkout: after another checkout
 * built, a plain build here can compile nothing and pass that checkout's
 * artifacts off as this one's (#544). Not on every run: a clean costs a
 * rebuild, and on Windows it fails while a hub test run elsewhere has an addon
 * loaded. Arguments are passed on to `cargo build` (CI adds `--locked`).
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "../packages/hub/src/cargo-target-dir.js";
import {
	forgetNativeBuild,
	NATIVE_BUILD_ARGS,
	NATIVE_CLEAN_ARGS,
	NATIVE_CRATES,
	nativeBuildProblems,
	recordedNativeBuild,
	recordNativeBuild,
	samePath,
} from "../packages/hub/src/native-build.fixture.js";

const ROOT = resolve(import.meta.dirname, "..");
const rustupUrl = "https://rustup.rs/";

/**
 * Builds the artifacts in `release` from `checkout`, and records it. `cargo`
 * runs cargo with the arguments given and returns its exit status, which this
 * returns; `extra` goes to `cargo build`.
 */
export function buildTestNatives(
	checkout: string,
	release: string,
	cargo: (args: readonly string[]) => number,
	extra: readonly string[] = [],
): number {
	const recorded = recordedNativeBuild(release);
	const ours = !("problem" in recorded) && samePath(recorded.checkout, checkout);
	const problem = ours ? undefined : nativeBuildProblems(release, checkout)[0];
	if (problem !== undefined) {
		console.log(
			`Cleaning ${NATIVE_CRATES.join(", ")} before the build, since what the target directory holds is not known to match this checkout:\n  ${problem}`,
		);
		forgetNativeBuild(release);
		const cleaned = cargo(NATIVE_CLEAN_ARGS);
		if (cleaned !== 0) {
			console.error(
				"cargo clean failed. On Windows it cannot remove an addon that a running process has loaded, such as a hub test run in another checkout: let it finish, then run this again.",
			);
			return cleaned;
		}
	}
	const built = cargo([...NATIVE_BUILD_ARGS, ...extra]);
	// Whatever cargo compiled just now came from this checkout, and the rest
	// was already this checkout's, the same as it, or cleaned away. So once the
	// build has changed anything, finished or not, the record names this one.
	if ("problem" in recordedNativeBuild(release)) recordNativeBuild(release, checkout);
	return built;
}

function main(): void {
	for (const tool of ["cargo", "rustc"]) {
		const result = spawnSync(tool, ["--version"], { stdio: "ignore" });
		const error = result.error as NodeJS.ErrnoException | undefined;
		if (error?.code === "ENOENT" || result.status !== 0) {
			throw new Error(
				`Hub tests require a usable Rust toolchain; ${tool} is missing or unavailable. Install Rust (which provides Cargo and rustc) from ${rustupUrl}, then rerun \`pnpm test:run\`.`,
			);
		}
	}
	const status = buildTestNatives(
		ROOT,
		join(cargoTargetDir(process.env, ROOT), "release"),
		(args) => {
			const result = spawnSync("cargo", args, { cwd: ROOT, stdio: "inherit" });
			if (result.error !== undefined) throw result.error;
			return result.status ?? 1;
		},
		process.argv.slice(2),
	);
	if (status !== 0) process.exit(status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
