import { spawnSync } from "node:child_process";

const rustupUrl = "https://rustup.rs/";

for (const tool of ["cargo", "rustc"]) {
	const result = spawnSync(tool, ["--version"], { stdio: "ignore" });
	const error = result.error as NodeJS.ErrnoException | undefined;
	if (error?.code === "ENOENT" || result.status !== 0) {
		throw new Error(
			`Hub tests require a usable Rust toolchain; ${tool} is missing or unavailable. Install Rust (which provides Cargo and rustc) from ${rustupUrl}, then rerun \`pnpm test:run\`.`,
		);
	}
}

const result = spawnSync(
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
	{ stdio: "inherit" },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
