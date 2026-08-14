import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_TLS_DIRECTORY_ENV = "LASTERM_TEST_TLS_DIRECTORY";

export default function setupTestTlsMaterial(): () => void {
	const directory = mkdtempSync(join(tmpdir(), "lasterm-hub-test-tls-"));
	const generator = testMaterialGeneratorPath();
	if (!existsSync(generator)) {
		removeTestTlsDirectory(directory);
		throw new Error(
			`hub TLS test material generator is missing at ${generator}; build it with \`cargo build --release -p lasterm-tls-identity --features test-tls-material\` before running hub tests`,
		);
	}
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

function removeTestTlsDirectory(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		console.error(`Could not remove hub TLS test material directory ${directory}:`, error);
	}
}

function testMaterialGeneratorPath(): string {
	const extension = platform() === "win32" ? ".exe" : "";
	const sourceDirectory = dirname(fileURLToPath(import.meta.url));
	const targetDirectory =
		process.env.CARGO_TARGET_DIR ?? resolve(sourceDirectory, "../../../target");
	return resolve(targetDirectory, "release", `lasterm-tls-test-material${extension}`);
}
