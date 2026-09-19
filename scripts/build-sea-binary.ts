/**
 * build-sea-binary.ts
 *
 * Generic Node.js Single Executable Application (SEA) binary builder.
 *
 * Reusable by both agent and hub.
 *
 * Workflow:
 *   1. Write a temp sea-config.json next to the entry script.
 *   2. node --experimental-sea-config <config>  →  sea-prep.blob
 *   3. cp $(which node) <output>
 *   4. macOS only: codesign --remove-signature <output>
 *   5. node <postject cli> <output> NODE_SEA_BLOB <blob> --sentinel-fuse ...
 *   6. chmod +x on Linux/macOS
 *   7. Print final binary size.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SeaBuildConfig {
	/** Path to the bundled .cjs entry point */
	entryScript: string;
	/** Output binary path (e.g. dist/sea/lasterm-agent) */
	outputBinary: string;
	/** Name for the binary (used in logs) */
	name: string;
	/** Native addon assets: { assetName: filePath } */
	nativeAddons: Record<string, string>;
	/** Extra assets to embed (e.g. VERSION file) */
	extraAssets?: Record<string, string>;
	/** Enable V8 code cache for faster startup (default: true) */
	useCodeCache?: boolean;
	/** Disable the experimental SEA warning (default: true) */
	disableExperimentalSEAWarning?: boolean;
}

/** The sentinel fuse string required by postject. */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/**
 * Run a child process synchronously, without a shell, so every argument
 * reaches the child as one argument whatever it contains. `cmd` must be a real
 * executable: a `.cmd` shim such as `npx` cannot start on Windows this way.
 * Throws a descriptive Error if the process exits with a non-zero code.
 */
export function run(cmd: string, args: string[], label: string): void {
	console.log(`[build-sea] ${label}: ${cmd} ${args.join(" ")}`);
	const result = spawnSync(cmd, args, { stdio: "inherit" });
	if (result.error) {
		throw new Error(`[build-sea] ${label} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`[build-sea] ${label} exited with code ${result.status ?? "null"}`);
	}
}

/**
 * The postject invocation: the repository's own postject CLI (a pinned root
 * devDependency) run by this Node. `npx postject` resolved the same file, but
 * npx is a `.cmd` shim on Windows, which needed `shell: true` there; cmd.exe
 * then joined the arguments unquoted, so a path with a space split in two.
 */
export function postjectCommand(args: string[]): { cmd: string; args: string[] } {
	const cli = createRequire(import.meta.url).resolve("postject/dist/cli.js");
	return { cmd: resolveNodeBinary(), args: [cli, ...args] };
}

/**
 * Find the `node` binary that is currently running this script.
 * Returns the absolute real path.
 */
function resolveNodeBinary(): string {
	// process.execPath is always the absolute path to the running node binary.
	return resolve(process.execPath);
}

/**
 * Build a SEA config object for the given SeaBuildConfig.
 * The `output` field points to the blob file (not the binary).
 */
export function buildSeaConfigJson(cfg: SeaBuildConfig, blobPath: string): Record<string, unknown> {
	const assets: Record<string, string> = {};
	for (const [name, filePath] of Object.entries(cfg.nativeAddons)) {
		assets[name] = filePath;
	}
	if (cfg.extraAssets) {
		for (const [name, filePath] of Object.entries(cfg.extraAssets)) {
			assets[name] = filePath;
		}
	}

	return {
		main: cfg.entryScript,
		output: blobPath,
		disableExperimentalSEAWarning: cfg.disableExperimentalSEAWarning ?? true,
		useCodeCache: cfg.useCodeCache ?? true,
		assets,
	};
}

/**
 * Full SEA binary build pipeline.
 *
 * @param cfg  Build configuration
 */
export async function buildSeaBinary(cfg: SeaBuildConfig): Promise<void> {
	const outDir = dirname(cfg.outputBinary);
	mkdirSync(outDir, { recursive: true });

	// ------------------------------------------------------------------
	// 1. Write sea-config.json to a temp location
	// ------------------------------------------------------------------
	const tmpBase = join(tmpdir(), `lasterm-sea-${randomBytes(8).toString("hex")}`);
	mkdirSync(tmpBase, { recursive: true });

	const configPath = join(tmpBase, "sea-config.json");
	const blobPath = join(tmpBase, "sea-prep.blob");

	const seaConfig = buildSeaConfigJson(cfg, blobPath);
	writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
	console.log(`[build-sea] config written to ${configPath}`);

	try {
		// ------------------------------------------------------------------
		// 2. Generate the SEA blob
		// ------------------------------------------------------------------
		const nodeBin = resolveNodeBinary();
		run(nodeBin, ["--experimental-sea-config", configPath], "generate blob");

		// ------------------------------------------------------------------
		// 3. Copy the Node binary running this build to the output location.
		//    The executable embeds it, so it is built on the platform it targets.
		// ------------------------------------------------------------------
		console.log(`[build-sea] copying ${nodeBin} → ${cfg.outputBinary}`);
		copyFileSync(nodeBin, cfg.outputBinary);

		// ------------------------------------------------------------------
		// 4. macOS: strip codesign so postject can inject the blob
		// ------------------------------------------------------------------
		if (process.platform === "darwin") {
			run("codesign", ["--remove-signature", cfg.outputBinary], "codesign strip");
		}

		// ------------------------------------------------------------------
		// 5. Inject the SEA blob via postject
		// ------------------------------------------------------------------
		const postjectArgs = [
			cfg.outputBinary,
			"NODE_SEA_BLOB",
			blobPath,
			"--sentinel-fuse",
			SENTINEL_FUSE,
		];
		if (process.platform === "darwin") {
			postjectArgs.push("--macho-segment-name", "NODE_SEA");
		}
		const postject = postjectCommand(postjectArgs);
		run(postject.cmd, postject.args, "postject inject");

		// ------------------------------------------------------------------
		// 6. chmod +x on Linux/macOS
		// ------------------------------------------------------------------
		if (process.platform !== "win32") {
			chmodSync(cfg.outputBinary, 0o755);
		}

		// ------------------------------------------------------------------
		// 7. Report final binary size
		// ------------------------------------------------------------------
		const stat = statSync(cfg.outputBinary);
		const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
		console.log(`[build-sea] ${cfg.name} binary ready: ${cfg.outputBinary} (${sizeMB} MB)`);
	} finally {
		// Clean up temp files
		try {
			rmSync(tmpBase, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup — don't fail the build over this.
		}
	}
}
