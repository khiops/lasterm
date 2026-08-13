import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

const desktopRoot = resolve(process.cwd());
const application = process.env.LASTERM_E2E_APPLICATION
	? resolve(process.env.LASTERM_E2E_APPLICATION)
	: process.env.LASTERM_DESKTOP_BINARY
		? resolve(process.env.LASTERM_DESKTOP_BINARY)
		: resolve(desktopRoot, "src-tauri/target/debug/lasterm-desktop");

function resolveTauriDriver(): string {
	const override = process.env.LASTERM_TAURI_DRIVER;
	let candidate: string | undefined;
	if (override) {
		candidate = override;
	} else {
		const command = process.platform === "win32" ? "where.exe" : "which";
		const result = spawnSync(command, ["tauri-driver"], { encoding: "utf8" });
		if (!result.error && result.status === 0) {
			candidate = result.stdout.trim().split(/\r?\n/, 1)[0];
		}
	}
	if (!candidate) {
		throw new Error(
			"Desktop boundary E2E prerequisite missing: tauri-driver was not found on PATH; install it with `cargo install tauri-driver --locked` or set LASTERM_TAURI_DRIVER to its absolute path",
		);
	}

	const driver = resolve(candidate);
	try {
		accessSync(driver, constants.X_OK);
	} catch (error) {
		throw new Error(
			`Desktop boundary E2E prerequisite missing: tauri-driver is not executable at ${driver}: ${String(error)}`,
		);
	}
	return driver;
}

try {
	accessSync(application, constants.X_OK);
} catch (error) {
	throw new Error(
		`Desktop boundary E2E prerequisite missing: built application is not executable at ${application}: ${String(error)}`,
	);
}

export const config = {
	host: "127.0.0.1",
	port: 4444,
	specs: ["./specs/**/*.e2e.ts"],
	maxInstances: 1,
	capabilities: [
		{
			browserName: "tauri",
			"tauri:options": { application },
		},
	],
	services: [
		[
			"tauri",
			{
				driverProvider: "external",
				// The service treats this field as a path, not a command name. Resolve
				// PATH ourselves so a normal cargo installation works without an env var.
				tauriDriverPath: resolveTauriDriver(),
			},
		],
	],
	reporters: ["spec"],
	framework: "mocha",
	mochaOpts: {
		ui: "bdd",
		timeout: 30_000,
	},
};
