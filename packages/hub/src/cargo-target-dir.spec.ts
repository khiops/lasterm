import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cargoTargetDir, repositoryRoot } from "./cargo-target-dir.js";
import { acquireHubLock } from "./hub-lock.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";
import { resolveHubTlsIdentity } from "./tls-identity.js";

const checkout = resolve(import.meta.dirname, "../../..");
/** Relative, and absent from every checkout: loading from it can only fail. */
const RELATIVE_TARGET = join("no-such-dir", "lasterm-cargo-target-dir-spec");

const library = (name: string) =>
	process.platform === "win32"
		? `${name}.dll`
		: process.platform === "darwin"
			? `lib${name}.dylib`
			: `lib${name}.so`;

const tempDirs: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

function tempDir(): string {
	const dir = makeTempDir("lasterm-cargo-target-dir-");
	tempDirs.push(dir);
	return dir;
}

describe("cargoTargetDir", () => {
	const root = resolve("/checkout");

	it("is <repository>/target when CARGO_TARGET_DIR is unset", () => {
		expect(cargoTargetDir({}, root)).toBe(join(root, "target"));
	});

	it("takes an empty CARGO_TARGET_DIR as unset, not as a path", () => {
		// Mutation caught: `??` keeps the empty string, which then names the
		// working directory.
		expect(cargoTargetDir({ CARGO_TARGET_DIR: "" }, root)).toBe(join(root, "target"));
	});

	it("resolves a relative CARGO_TARGET_DIR against the repository, as cargo does run from there", () => {
		expect(cargoTargetDir({ CARGO_TARGET_DIR: join("..", "shared-target") }, root)).toBe(
			resolve(root, "..", "shared-target"),
		);
	});

	it("takes an absolute CARGO_TARGET_DIR as it is", () => {
		const elsewhere = resolve("/elsewhere/target");
		expect(cargoTargetDir({ CARGO_TARGET_DIR: elsewhere }, root)).toBe(elsewhere);
	});

	it("defaults to this process's environment and this checkout", () => {
		vi.stubEnv("CARGO_TARGET_DIR", RELATIVE_TARGET);
		expect(repositoryRoot()).toBe(checkout);
		expect(cargoTargetDir()).toBe(join(checkout, RELATIVE_TARGET));
	});
});

/**
 * What loads the native addons from the target directory finds it through
 * cargoTargetDir. Each is given a relative CARGO_TARGET_DIR while the process
 * works elsewhere, and must look under the checkout: the load then fails, and
 * the error names the file it looked for.
 */
describe("the native addons outside a single executable", () => {
	function workElsewhere(): string {
		vi.stubEnv("CARGO_TARGET_DIR", RELATIVE_TARGET);
		const elsewhere = tempDir();
		// Mutation caught: a relative value resolved by the process, as `??`
		// then path.resolve did, lands under the working directory instead.
		vi.spyOn(process, "cwd").mockReturnValue(elsewhere);
		return elsewhere;
	}

	it("the hub lock is looked for under the checkout's target directory", () => {
		vi.stubEnv("LASTERM_HUB_LOCK_ADDON", undefined);
		const elsewhere = workElsewhere();
		const stateDir = tempDir();

		let refusal: unknown;
		try {
			acquireHubLock(stateDir);
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(Error);
		const message = (refusal as Error).message;
		expect(message).toContain("LASTERM_HUB_LOCK_UNAVAILABLE");
		expect(message).toContain(
			join(checkout, RELATIVE_TARGET, "release", library("lasterm_hub_lock")),
		);
		expect(message).not.toContain(elsewhere);
	});

	it("the TLS identity addon is looked for under the checkout's target directory", () => {
		vi.stubEnv("LASTERM_TLS_IDENTITY_ADDON", undefined);
		const elsewhere = workElsewhere();
		const stateDir = tempDir();

		let refusal: unknown;
		try {
			resolveHubTlsIdentity(stateDir, {});
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(Error);
		const message = (refusal as Error).message;
		expect(message).toContain(
			join(checkout, RELATIVE_TARGET, "release", library("lasterm_tls_identity")),
		);
		expect(message).not.toContain(elsewhere);
	});
});
