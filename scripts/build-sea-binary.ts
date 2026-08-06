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
 *   5. npx postject <output> NODE_SEA_BLOB <blob> --sentinel-fuse ...
 *   6. chmod +x on Linux/macOS
 *   7. Print final binary size.
 */

import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
	/**
	 * Target platform for cross-build.
	 * When set to a platform different from the host (e.g. "win32" on Linux),
	 * the builder downloads the target Node.js binary instead of copying the
	 * local one. Supported: "linux", "win32", "darwin".
	 */
	targetPlatform?: string;
	/** Target arch for cross-build (default: same as host). */
	targetArch?: string;
	/** Node.js version for cross-build target (default: current process.version). */
	targetNodeVersion?: string;
}

/** The sentinel fuse string required by postject. */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/**
 * Run a child process synchronously.
 * Throws a descriptive Error if the process exits with a non-zero code.
 */
function run(cmd: string, args: string[], label: string): void {
	console.log(`[build-sea] ${label}: ${cmd} ${args.join(" ")}`);
	const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
	if (result.error) {
		throw new Error(`[build-sea] ${label} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`[build-sea] ${label} exited with code ${result.status ?? "null"}`);
	}
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
 * Download a Node.js binary for a target platform (cross-build).
 * Returns the path to the downloaded binary.
 */
function downloadNodeBinary(
	targetPlatform: string,
	targetArch: string,
	destDir: string,
	nodeVersion?: string,
): string {
	const version = nodeVersion ?? process.env.LASTERM_NODE_VERSION ?? process.version; // e.g. "v22.14.0"
	const platformMap: Record<string, string> = { win32: "win", linux: "linux", darwin: "darwin" };
	const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
	const plat = platformMap[targetPlatform] ?? targetPlatform;
	const arch = archMap[targetArch] ?? targetArch;

	const isWindows = targetPlatform === "win32";
	const ext = isWindows ? "zip" : "tar.gz";
	const dirName = `node-${version}-${plat}-${arch}`;
	const fileName = `${dirName}.${ext}`;
	const url = `https://nodejs.org/dist/${version}/${fileName}`;

	const archivePath = join(destDir, fileName);
	const nodeBinName = isWindows ? "node.exe" : "node";
	const extractedBin = join(destDir, dirName, nodeBinName);

	if (existsSync(extractedBin)) {
		console.log(`[build-sea] cross-build: reusing cached ${extractedBin}`);
		return extractedBin;
	}

	console.log(`[build-sea] cross-build: downloading ${url}`);
	execSync(`curl -sSL "${url}" -o "${archivePath}"`, { stdio: "inherit" });

	console.log(`[build-sea] cross-build: extracting ${fileName}`);
	if (isWindows) {
		// unzip on Linux to extract node.exe
		execSync(`unzip -qo "${archivePath}" "${dirName}/${nodeBinName}" -d "${destDir}"`, {
			stdio: "inherit",
		});
	} else {
		execSync(`tar -xzf "${archivePath}" -C "${destDir}" "${dirName}/bin/${nodeBinName}"`, {
			stdio: "inherit",
		});
	}

	const finalPath = isWindows ? extractedBin : join(destDir, dirName, "bin", nodeBinName);
	console.log(`[build-sea] cross-build: node binary at ${finalPath}`);
	return finalPath;
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
		// 3. Copy the Node binary to the output location
		//    (or download target platform binary for cross-build)
		// ------------------------------------------------------------------
		const targetPlat = cfg.targetPlatform ?? process.platform;
		const targetArch = cfg.targetArch ?? process.arch;
		const isCrossBuild = targetPlat !== process.platform || targetArch !== process.arch;

		let sourceBin: string;
		if (isCrossBuild) {
			sourceBin = downloadNodeBinary(targetPlat, targetArch, tmpBase, cfg.targetNodeVersion);
		} else {
			sourceBin = nodeBin;
		}
		console.log(`[build-sea] copying ${sourceBin} → ${cfg.outputBinary}`);
		copyFileSync(sourceBin, cfg.outputBinary);

		// ------------------------------------------------------------------
		// 4. macOS: strip codesign so postject can inject the blob
		// ------------------------------------------------------------------
		if (targetPlat === "darwin" && process.platform === "darwin") {
			run("codesign", ["--remove-signature", cfg.outputBinary], "codesign strip");
		}

		// ------------------------------------------------------------------
		// 5. Inject the SEA blob via postject
		// ------------------------------------------------------------------
		// postject is invoked via npx so it works even without a global install.
		const postjectArgs = [
			cfg.outputBinary,
			"NODE_SEA_BLOB",
			blobPath,
			"--sentinel-fuse",
			SENTINEL_FUSE,
		];
		if (targetPlat === "darwin") {
			postjectArgs.push("--macho-segment-name", "NODE_SEA");
		}
		run("npx", ["postject", ...postjectArgs], "postject inject");

		// ------------------------------------------------------------------
		// 6. chmod +x on Linux/macOS
		// ------------------------------------------------------------------
		if (targetPlat !== "win32") {
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
