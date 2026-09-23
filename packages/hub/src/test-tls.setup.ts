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
import { nativeBuildProblem } from "./native-build.fixture.js";

const TEST_TLS_DIRECTORY_ENV = "LASTERM_TEST_TLS_DIRECTORY";
const NATIVE_BUILD_COMMAND =
	"cargo build --release -p lasterm-hub-lock -p lasterm-tls-identity --features lasterm-tls-identity/test-tls-material";
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
	for (const { artifact, crate } of nativeArtifacts(release)) {
		const problem = nativeBuildProblem(artifact, crate, checkout);
		if (problem !== undefined) problems.push(`  ${artifact}: ${problem}`);
	}
	if (problems.length === 0) return;
	throw new Error(
		[
			"stale native build: the hub specs would run against Rust code that was not built from this checkout's crates.",
			...problems,
			"Rebuild it, with the same CARGO_TARGET_DIR, and run the tests again:",
			`  ${NATIVE_BUILD_COMMAND}`,
		].join("\n"),
	);
}

/**
 * What the specs load from the target directory. An addon named by its
 * override variable is loaded from wherever that names instead, and is left to
 * whoever set it.
 */
function nativeArtifacts(release: string): { artifact: string; crate: string }[] {
	const library = (name: string) =>
		platform() === "win32"
			? `${name}.dll`
			: platform() === "darwin"
				? `lib${name}.dylib`
				: `lib${name}.so`;
	const executable = platform() === "win32" ? ".exe" : "";
	const artifacts: { artifact: string; crate: string }[] = [];
	if (!process.env.LASTERM_HUB_LOCK_ADDON) {
		artifacts.push({
			artifact: join(release, library("lasterm_hub_lock")),
			crate: "lasterm-hub-lock",
		});
	}
	if (!process.env.LASTERM_TLS_IDENTITY_ADDON) {
		artifacts.push({
			artifact: join(release, library("lasterm_tls_identity")),
			crate: "lasterm-tls-identity",
		});
	}
	artifacts.push({
		artifact: join(release, `lasterm-tls-test-material${executable}`),
		crate: "lasterm-tls-identity",
	});
	return artifacts;
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
	const targetDirectory = process.env.CARGO_TARGET_DIR ?? resolve(checkout, "target");
	const generator = resolve(targetDirectory, "release", `lasterm-tls-test-material${extension}`);
	if (!existsSync(generator)) {
		try {
			execFileSync(
				"cargo",
				[
					"build",
					"--release",
					"-p",
					"lasterm-hub-lock",
					"-p",
					"lasterm-tls-identity",
					"--features",
					"lasterm-tls-identity/test-tls-material",
				],
				{ stdio: "pipe" },
			);
		} catch (error) {
			throw new Error(`could not build hub TLS test material generator: ${String(error)}`);
		}
	}
	return generator;
}
