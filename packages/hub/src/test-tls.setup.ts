/**
 * Runs once before the hub specs (vitest `globalSetup`). It refuses a native
 * build that does not match this checkout's crates, then mints the run's TLS
 * test material with the Rust generator.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "./cargo-target-dir.js";
import {
	NATIVE_BUILD_ARGS,
	NATIVE_CLEAN_ARGS,
	type NativeArtifact,
	nativeArtifacts,
	nativeBuildProblem,
} from "./native-build.fixture.js";

const TEST_TLS_DIRECTORY_ENV = "LASTERM_TEST_TLS_DIRECTORY";
const NATIVE_BUILD_COMMAND = `cargo ${NATIVE_BUILD_ARGS.join(" ")}`;
const NATIVE_CLEAN_COMMAND = `cargo ${NATIVE_CLEAN_ARGS.join(" ")}`;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(sourceDirectory, "../../..");

export default function setupTestTlsMaterial(): () => void {
	const generator = testMaterialGeneratorPath();
	if (!existsSync(generator)) {
		throw new Error(
			`hub TLS test material generator is missing at ${generator}; build it with \`cargo build --release -p lasterm-tls-identity --features test-tls-material\` before running hub tests`,
		);
	}
	refuseStaleNativeBuild(dirname(generator));
	const directory = mkdtempSync(join(tmpdir(), "lasterm-hub-test-tls-"));
	try {
		execFileSync(generator, ["--output", directory], { stdio: "pipe" });
	} catch (error) {
		removeTestTlsDirectory(directory);
		throw new Error(`hub TLS test material generator failed: ${String(error)}`);
	}
	process.env[TEST_TLS_DIRECTORY_ENV] = directory;
	return () => {
		delete process.env[TEST_TLS_DIRECTORY_ENV];
		removeTestTlsDirectory(directory);
	};
}

/**
 * The specs would otherwise test whatever the target directory holds: after a
 * crate edit, the previous build (#129). A stale lock addon then failed as
 * "did not return a live HubLock", which reads as a defect in the code under
 * test. Nothing is built here, so a run where nothing changed costs a few file
 * reads.
 */
function refuseStaleNativeBuild(release: string): void {
	const problems: string[] = [];
	for (const { artifact, crate } of loadedArtifacts(release)) {
		const problem = nativeBuildProblem(artifact, crate, checkout);
		if (problem !== undefined) problems.push(`  ${artifact}: ${problem}`);
	}
	if (problems.length === 0) return;
	throw new Error(
		[
			"stale native build: the hub specs would run against Rust code that was not built from this checkout's crates.",
			...problems,
			"Rebuild it from this checkout, with the same CARGO_TARGET_DIR, and run the tests again.",
			"Clean first: once another checkout has built, a build alone can compile nothing and only relabel that checkout's artifacts as this one's.",
			`  ${NATIVE_CLEAN_COMMAND}`,
			`  ${NATIVE_BUILD_COMMAND}`,
		].join("\n"),
	);
}

/**
 * What the specs load from the target directory. An addon named by its
 * override variable is loaded from wherever that names instead, and is left to
 * whoever set it.
 */
function loadedArtifacts(release: string): NativeArtifact[] {
	return nativeArtifacts(release).filter(
		({ override }) => override === undefined || !process.env[override],
	);
}

function removeTestTlsDirectory(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		console.error(`Could not remove hub TLS test material directory ${directory}:`, error);
	}
}

function testMaterialGeneratorPath(): string {
	const extension = platform() === "win32" ? ".exe" : "";
	const generator = join(
		cargoTargetDir(process.env, checkout),
		"release",
		`lasterm-tls-test-material${extension}`,
	);
	if (!existsSync(generator)) {
		try {
			execFileSync("cargo", NATIVE_BUILD_ARGS, { stdio: "pipe" });
		} catch (error) {
			throw new Error(`could not build hub TLS test material generator: ${String(error)}`);
		}
	}
	return generator;
}
