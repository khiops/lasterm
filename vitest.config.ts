import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		passWithNoTests: true,
		projects: [
			{
				test: {
					name: "shared",
					include: ["packages/shared/**/*.spec.ts"],
					environment: "node",
				},
			},
			{
				test: {
					name: "hub",
					include: ["packages/hub/**/*.spec.ts"],
					environment: "node",
					globalSetup: ["packages/hub/src/test-tls.setup.ts"],
					setupFiles: ["packages/hub/src/platform-dirs.setup.ts"],
					// These specs build a TLS server and two SQLite databases per
					// test, and some spawn a hub process. Vitest's defaults — 5s for
					// a test, 10s for a hook — are not assertions about how fast that
					// is; nothing here measures duration. They are guards against a
					// hang, and at those values a machine doing anything else fails
					// tests that are perfectly correct, in files unrelated to what is
					// being changed. A hook that dies mid-setup then takes its
					// teardown with it, turning one timeout into a page of errors.
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
			{
				test: {
					name: "web",
					include: ["packages/clients/web/**/*.spec.ts"],
					environment: "happy-dom",
				},
			},
			{
				test: {
					name: "scripts",
					include: ["scripts/**/*.spec.ts"],
					environment: "node",
					// These specs run hub code and the built SEA, which extracts its
					// addons into the platform cache directory.
					setupFiles: ["packages/hub/src/platform-dirs.setup.ts"],
					testTimeout: 60_000,
				},
			},
			{
				test: {
					name: "desktop",
					include: ["packages/clients/desktop/**/*.spec.ts"],
					environment: "node",
				},
			},
		],
	},
});
