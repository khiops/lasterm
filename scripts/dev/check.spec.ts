/**
 * check.sh's cargo steps build, test and lint the checkout they run in, whatever
 * another checkout last built into the target directory they share (#862).
 *
 * Two copies of one small cargo workspace, `a` and `b`, play two worktrees: the
 * same crate at the same path, so cargo keeps one record of its build for both.
 * `b` tests and lints it after `a`'s files last changed. Then check.sh runs in
 * `a`, with `pnpm` a stub, so that its cargo steps are the only ones doing
 * anything. `a`'s crate names another test than `b`'s and breaks a lint that
 * `b`'s keeps: a step that reused `b`'s build would run `b`'s test, or pass
 * clippy.
 *
 * The target is made in this repository's cargo target directory, not in the
 * system temp folder: the tests built there run, and the maintainer's antivirus
 * flags each new executable outside their development folder (CLAUDE.md,
 * "Desktop UI tests"). The crate has no dependency and no build script, so
 * nothing else is compiled there.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cargoTargetDir } from "../../packages/hub/src/cargo-target-dir.js";
import { makeTempDir, removeTempDir } from "../../packages/hub/src/temp-dir.fixture.js";

const ROOT = resolve(import.meta.dirname, "../..");
const onWindows = process.platform === "win32";
const LIB = join("crates", "probe", "src", "lib.rs");

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

/** The bash check.sh is written for. On Windows that is Git Bash; `bash` there may be WSL's. */
function bash(): string {
	if (!onWindows) return "bash";
	// <Git>/<mingw64, ucrt64 or clangarm64>/libexec/git-core
	const gitCore = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
	return join(gitCore, "..", "..", "..", "bin", "bash.exe");
}

/** Writes checkout `name` in `dir`; with `lint`, its crate breaks clippy's needless_return. */
function writeCheckout(dir: string, name: string, lint: boolean): void {
	mkdirSync(join(dir, "crates", "probe", "src"), { recursive: true });
	writeFileSync(join(dir, "Cargo.toml"), '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n');
	writeFileSync(
		join(dir, "crates", "probe", "Cargo.toml"),
		'[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n',
	);
	const body = lint ? `return "${name}";` : `"${name}"`;
	writeFileSync(
		join(dir, LIB),
		`pub fn checkout() -> &'static str {
    ${body}
}

#[cfg(test)]
mod tests {
    #[test]
    fn built_from_checkout_${name}() {
        assert_eq!(super::checkout(), "${name}");
    }
}
`,
	);
	// The toolchain this repository pins, with clippy and rustfmt.
	copyFileSync(join(ROOT, "rust-toolchain.toml"), join(dir, "rust-toolchain.toml"));
}

/**
 * This environment with the target directory under test, and a `pnpm` stub
 * first on PATH. Windows names are matched without regard to case.
 */
function environment(stubs: string, target: string): NodeJS.ProcessEnv {
	const drop = new Set([
		"cargo_target_dir",
		"lasterm_cargo_target_dir",
		"lasterm_check_log_dir",
		"rustup_toolchain",
	]);
	const env: NodeJS.ProcessEnv = {};
	let path = "";
	for (const [name, value] of Object.entries(process.env)) {
		if (name.toLowerCase() === "path") path = value ?? "";
		else if (!drop.has(name.toLowerCase())) env[name] = value;
	}
	return {
		...env,
		PATH: `${stubs}${delimiter}${path}`,
		CARGO_TARGET_DIR: target,
		LASTERM_CARGO_TARGET_DIR: target,
	};
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
	expect(result.error).toBeUndefined();
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("check.sh in a checkout that shares its cargo target", () => {
	it("tests and lints this checkout's crates after another checkout built them", () => {
		const base = cargoTargetDir(process.env, ROOT);
		mkdirSync(base, { recursive: true });
		const work = mkdtempSync(join(base, "lasterm-check-spec-"));
		tempDirs.push(work);
		const [a, b, target, logs] = [
			join(work, "a"),
			join(work, "b"),
			join(work, "target"),
			join(work, "logs"),
		];
		const stubs = makeTempDir("lasterm-check-stubs-");
		tempDirs.push(stubs);
		writeFileSync(join(stubs, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const env = environment(stubs, target);

		writeCheckout(a, "a", true);
		writeCheckout(b, "b", false);
		// a's crate last changed an hour before b built it.
		const hourAgo = new Date(Date.now() - 3_600_000);
		utimesSync(join(a, LIB), hourAgo, hourAgo);
		expect(run("git", ["init", "--quiet"], a, env).status).toBe(0);
		mkdirSync(join(a, "node_modules"));

		// b tests and lints with check.sh's arguments.
		const clippyTarget = onWindows ? ["--target", "x86_64-pc-windows-msvc"] : [];
		for (const args of [
			["test", "--workspace", "--no-fail-fast"],
			["clippy", ...clippyTarget, "--all-targets", "--all-features", "--", "-D", "warnings"],
		]) {
			const built = run("cargo", args, b, env);
			expect(built.status, built.output).toBe(0);
		}
		// What a plain cargo does in a, and what check.sh must not: compile
		// nothing and run b's test.
		expect(run("cargo", ["test", "--workspace"], a, env).output).toContain(
			"built_from_checkout_b ... ok",
		);

		const check = run(
			bash(),
			[join(ROOT, "scripts", "dev", "check.sh"), "--log-dir", logs, "spec"],
			a,
			env,
		);
		const log = (step: string) => readFileSync(join(logs, `${step}.log`), "utf8");
		const exit = (step: string) =>
			check.output.match(new RegExp(`^${step}: exit=(\\d+)`, "m"))?.[1];

		// Mutation caught: a cargo-test step that runs cargo test alone ran b's test.
		expect(exit("cargo-test"), log("cargo-test")).toBe("0");
		expect(log("cargo-test")).toContain("built_from_checkout_a ... ok");
		expect(log("cargo-test")).not.toContain("checkout_b");
		// Mutation caught: a clippy step that cleans the host's directory and not
		// the --target's (Windows) found b's build current, and passed.
		expect(exit("clippy"), log("clippy")).not.toBe("0");
		expect(log("clippy")).toContain("needless_return");
	}, 300_000);
});
