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
