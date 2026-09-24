/**
 * Builds what the hub specs load and run from the cargo target directory: the
 * two native addons and the TLS test material generator. `pnpm -F @lasterm/hub
 * test` runs it first.
 *
 * Checkouts that share a target directory share cargo's record of which crates
 * are fresh, and it goes by modification time. After another checkout has
 * built, a plain `cargo build` here can compile nothing, only rewrite the
 * dep-info files to name this checkout's sources, and so pass that checkout's
 * artifacts off as this one's (#544). When a dep-info file names another
 * checkout, the crates are therefore cleaned first. Not on every run: that
 * costs a rebuild, and on Windows it fails while a hub test run elsewhere has an
 * addon loaded.
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "../packages/hub/src/cargo-target-dir.js";
import {
	builtInAnotherCheckout,
	NATIVE_BUILD_ARGS,
	NATIVE_CLEAN_ARGS,
	NATIVE_CRATES,
	nativeArtifacts,
} from "../packages/hub/src/native-build.fixture.js";

const ROOT = resolve(import.meta.dirname, "..");
const rustupUrl = "https://rustup.rs/";

/**
 * Builds the artifacts in `release` from `checkout`, cleaning their crates
 * first when the last build came from another checkout. `cargo` runs cargo
 * with the arguments given and returns its exit status, which this returns
 * when it is not 0.
 */
export function buildTestNatives(
	checkout: string,
	release: string,
	cargo: (args: readonly string[]) => number,
): number {
	const other = nativeArtifacts(release)
		.map(({ artifact, crate }) => builtInAnotherCheckout(artifact, crate, checkout))
		.find((root) => root !== undefined);
	if (other !== undefined) {
		console.log(
			`The native test build in ${release} was last made from ${other}. Cleaning ${NATIVE_CRATES.join(", ")} first, so this build cannot pass it off as this checkout's.`,
		);
		const cleaned = cargo(NATIVE_CLEAN_ARGS);
		if (cleaned !== 0) {
			console.error(
				`cargo clean failed. On Windows it cannot remove an addon that a running process has loaded, such as a hub test run in ${other}: let it finish, then run this again.`,
			);
			return cleaned;
		}
	}
	return cargo(NATIVE_BUILD_ARGS);
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
	);
	if (status !== 0) process.exit(status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
