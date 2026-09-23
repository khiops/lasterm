/**
 * Where this repository's Rust artifacts are, outside a single executable: the
 * native addons a hub run from source loads, and what the hub specs load and run.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout this module belongs to. It sits in `packages/hub/src`, or in
 * `packages/hub/dist` once built: three levels down either way. Computed on
 * each call, never at load, so the single executable's bundle never runs it.
 */
export function repositoryRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * The directory cargo builds this repository into (#531).
 *
 * Cargo resolves a relative CARGO_TARGET_DIR against the directory it runs in,
 * and every build script here runs it from the repository root; so this
 * resolves it against that root, whatever this process's own working directory.
 * An empty one counts as unset, as the build scripts treat it
 * (`${CARGO_TARGET_DIR:-…}`): cargo itself refuses to build with one, so nothing
 * was built there. Unset, it is `<repository>/target`.
 */
export function cargoTargetDir(
	env: NodeJS.ProcessEnv = process.env,
	root: string = repositoryRoot(),
): string {
	const configured = env.CARGO_TARGET_DIR;
	return configured ? resolve(root, configured) : join(root, "target");
}
