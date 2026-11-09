/**
 * check.sh's cargo steps build, test and lint the checkout they run in, whatever
 * another checkout last built into the target directories they share (#862).
 *
 * Two copies of one small repository, `a` and `b`, play two worktrees: the same
 * crates at the same paths, so cargo keeps one record of their builds for both.
 * Each has a workspace crate, `probe`, and a desktop crate built from its own
 * directory into a target of its own, whose build script checks a file of the
 * checkout as tauri-build checks tauri.conf.json. `b` tests and lints both
 * after `a`'s files last changed. Then check.sh runs in `a`, with `pnpm` a
 * stub, so that its cargo steps are the only ones doing anything. `a`'s probe
 * names another test than `b`'s and breaks a lint `b`'s keeps, and `a`'s file
 * fails the desktop build script: a step that reused `b`'s build would run
 * `b`'s test, or pass.
 *
 * Everything is made in this repository's cargo target directory, not in the
 * system temp folder: what is built there runs, and the maintainer's antivirus
 * flags each new executable outside their development folder (CLAUDE.md,
 * "Desktop UI tests"). The crates have no dependency, so nothing else is
 * compiled there.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cargoTargetDir } from "../../packages/hub/src/cargo-target-dir.js";
import { removeTempDir } from "../../packages/hub/src/temp-dir.fixture.js";

const ROOT = resolve(import.meta.dirname, "../..");
const onWindows = process.platform === "win32";
const PROBE = join("crates", "probe", "src", "lib.rs");
const DESK = join("packages", "clients", "desktop", "src-tauri");
/** check.sh's clippy arguments for the workspace. */
const CLIPPY = [
	"clippy",
	...(onWindows ? ["--target", "x86_64-pc-windows-msvc"] : []),
	"--all-targets",
	"--all-features",
	"--",
	"-D",
	"warnings",
];
/** check.sh's arguments for the desktop crate. */
const DESK_CLIPPY = ["clippy", "--all-targets", "--", "-D", "warnings"];

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

/** The bash check.sh is written for. On Windows that is Git Bash; `bash` there may be WSL's. */
function bash(): string {
	if (!onWindows) return "bash";
	// <Git>/<mingw64, ucrt64 or clangarm64>/libexec/git-core
	const gitCore = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
	const bash = join(gitCore, "..", "..", "..", "bin", "bash.exe");
	if (!existsSync(bash)) {
		throw new Error(
			`check.sh needs Git for Windows' bash, which is not at ${bash}: install Git for Windows`,
		);
	}
	return bash;
}

/**
 * Writes checkout `name` in `dir`. With `broken`, its probe breaks clippy's
 * needless_return, and its desktop crate's conf.txt fails the build script.
 */
function writeCheckout(dir: string, name: string, broken: boolean): void {
	const files: Record<string, string> = {
		"Cargo.toml": '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n',
		"crates/probe/Cargo.toml":
			'[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n',
		[PROBE]: `pub fn checkout() -> &'static str {
    ${broken ? `return "${name}";` : `"${name}"`}
}

#[cfg(test)]
mod tests {
    #[test]
    fn built_from_checkout_${name}() {
        assert_eq!(super::checkout(), "${name}");
    }
}
`,
		// A workspace of its own, as the real desktop crate is outside the main
		// one: without the table, cargo would look for a workspace above this
		// directory, up to the repository's own.
		[join(DESK, "Cargo.toml")]: `[package]
name = "desk"
version = "0.0.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
probe = { path = "../../../../crates/probe" }
`,
		[join(DESK, "build.rs")]: `fn main() {
    println!("cargo:rerun-if-changed=conf.txt");
    let conf = std::fs::read_to_string("conf.txt").unwrap();
    assert_ne!(conf.trim(), "invalid", "this checkout's conf.txt is invalid");
}
`,
		[join(DESK, "conf.txt")]: broken ? "invalid\n" : "valid\n",
		[join(DESK, "src", "lib.rs")]: `pub fn probe_checkout() -> &'static str {
    probe::checkout()
}
`,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	// The toolchain this repository pins, with clippy and rustfmt; rustup finds
	// it from the desktop crate's directory too.
	copyFileSync(join(ROOT, "rust-toolchain.toml"), join(dir, "rust-toolchain.toml"));
}

/**
 * This environment with the target directories under test, and a `pnpm` stub
 * first on PATH. Windows names are matched without regard to case.
 */
function environment(stubs: string, target: string, desktopTarget: string): NodeJS.ProcessEnv {
	const drop = new Set([
		"cargo_target_dir",
		"lasterm_cargo_target_dir",
		"lasterm_desktop_cargo_target_dir",
		"lasterm_check_log_dir",
		"rustup_toolchain",
	]);
	const env: NodeJS.ProcessEnv = {};
	let path = "";
	for (const [name, value] of Object.entries(process.env)) {
		const lower = name.toLowerCase();
		if (lower === "path") path = value ?? "";
		// A git hook's GIT_DIR, GIT_INDEX_FILE and the like would point git in
		// `a` at the repository the hook ran in.
		else if (!drop.has(lower) && !lower.startsWith("git_")) env[name] = value;
	}
	return {
		...env,
		PATH: `${stubs}${delimiter}${path}`,
		CARGO_TARGET_DIR: target,
		LASTERM_CARGO_TARGET_DIR: target,
		LASTERM_DESKTOP_CARGO_TARGET_DIR: desktopTarget,
	};
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
	// Bounded, since a synchronous wait is beyond the test's own timeout.
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 240_000 });
	expect(result.error).toBeUndefined();
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("check.sh in a checkout that shares its cargo targets", () => {
	it("builds, tests and lints this checkout after another checkout built it", () => {
		const base = cargoTargetDir(process.env, ROOT);
		mkdirSync(base, { recursive: true });
		const work = mkdtempSync(join(base, "lasterm-check-spec-"));
		tempDirs.push(work);
		const a = join(work, "a");
		const b = join(work, "b");
		const logs = join(work, "logs");
		const stubs = join(work, "stubs");
		mkdirSync(stubs);
		writeFileSync(join(stubs, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const env = environment(stubs, join(work, "target"), join(work, "desktop-target"));
		const deskEnv = { ...env, CARGO_TARGET_DIR: join(work, "desktop-target") };

		writeCheckout(a, "a", true);
		writeCheckout(b, "b", false);
		// a's files last changed an hour before b built.
		const hourAgo = new Date(Date.now() - 3_600_000);
		for (const file of [PROBE, join(DESK, "conf.txt")]) utimesSync(join(a, file), hourAgo, hourAgo);
		expect(run("git", ["init", "--quiet"], a, env).status).toBe(0);
		mkdirSync(join(a, "node_modules"));

		// b builds with check.sh's arguments; then plain cargo in a, which is what
		// check.sh must not do: it reuses b's builds and passes.
		for (const dir of [b, a]) {
			for (const [args, cwd, withEnv] of [
				[["test", "--workspace", "--no-fail-fast"], dir, env],
				[CLIPPY, dir, env],
				[["test"], join(dir, DESK), deskEnv],
				[DESK_CLIPPY, join(dir, DESK), deskEnv],
			] as const) {
				const built = run("cargo", args, cwd, withEnv);
				expect(built.status, `${dir}: cargo ${args.join(" ")}\n${built.output}`).toBe(0);
				if (dir === a && args[0] === "test" && cwd === a) {
					expect(built.output).toContain("built_from_checkout_b ... ok");
				}
			}
		}

		const check = run(
			bash(),
			[join(ROOT, "scripts", "dev", "check.sh"), "--desktop", "--log-dir", logs, "spec"],
			a,
			env,
		);
		// 1: a's clippy and desktop steps fail; 2 would be check.sh refusing to run.
		expect(check.status, check.output).toBe(1);
		const log = (step: string) => readFileSync(join(logs, `${step}.log`), "utf8");
		const exit = (step: string) =>
			check.output.match(new RegExp(`^${step}: exit=(\\d+)`, "m"))?.[1];
		// A step after another's clean can pass for that clean: each must clean.
		for (const step of ["cargo-test", "clippy", "desktop-clippy", "desktop-test"]) {
			expect(log(step)).toContain("own_build: ");
		}

		// Mutation caught: a cargo-test step that runs cargo test alone ran b's test.
		expect(exit("cargo-test"), log("cargo-test")).toBe("0");
		expect(log("cargo-test")).toContain("built_from_checkout_a ... ok");
		expect(log("cargo-test")).not.toContain("checkout_b");
		// Mutation caught: a clippy step that cleans the host's directory and not
		// the --target's (Windows) found b's build current, and passed.
		expect(exit("clippy"), log("clippy")).not.toBe("0");
		expect(log("clippy")).toContain("needless_return");
		// Mutation caught: desktop steps without the clean kept b's run of the
		// build script, which never read a's conf.txt, and passed.
		for (const step of ["desktop-clippy", "desktop-test"]) {
			expect(exit(step), log(step)).not.toBe("0");
			expect(log(step)).toContain("this checkout's conf.txt is invalid");
		}
	}, 600_000);
});
