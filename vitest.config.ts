import vue from "@vitejs/plugin-vue";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The stylesheets a web spec gets: a component's own style block, and any
 * stylesheet a module imports, so that a mounted component is drawn with its
 * rules and `getComputedStyle` answers from them (#936).
 */
const WEB_STYLES = [/\.css$/, /\.vue\?vue&type=style/];

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
				// Compiles the single-file components a spec mounts.
				plugins: [vue()],
				test: {
					name: "web",
					include: ["packages/clients/web/**/*.spec.ts"],
					exclude: [...configDefaults.exclude, "packages/clients/web/**/*.browser.spec.ts"],
					environment: "happy-dom",
					// A guard against a hang, as in the hub's specs, not a measure of
					// speed: a spec that mounts a component over a module it mocks
					// for that one test loads the component's whole graph again, which
					// takes over Vitest's default 5 s while the other projects run.
					testTimeout: 30_000,
					hookTimeout: 30_000,
					// Vitest hands a spec an empty module for every stylesheet it does
					// not include. happy-dom applies the rest: cascade, `var()`,
					// `:focus-visible`, but no `:hover`, `:focus-within` or layout.
					css: { include: WEB_STYLES },
				},
			},
			{
				// What happy-dom does not draw: hover, focus-within, layout, a click
				// that reaches what is under an element. The browser is the
				// machine's own (Edge on Windows, Chrome elsewhere): nothing is
				// downloaded, and a machine without it fails naming it (#936).
				plugins: [vue()],
				test: {
					name: "web-browser",
					include: ["packages/clients/web/**/*.browser.spec.ts"],
					css: { include: WEB_STYLES },
					// A failing spec's screenshot, kept out of the sources.
					attachmentsDir: "target/vitest/attachments",
					browser: {
						enabled: true,
						headless: true,
						screenshotDirectory: "target/vitest/screenshots",
						provider: playwright({
							launchOptions: {
								channel: process.platform === "win32" ? "msedge" : "chrome",
								// Playwright hides scrollbars in a headless browser; the specs
								// measure the room base.css's scrollbars take (#845, #853).
								ignoreDefaultArgs: ["--hide-scrollbars"],
							},
						}),
						instances: [{ browser: "chromium" }],
					},
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
