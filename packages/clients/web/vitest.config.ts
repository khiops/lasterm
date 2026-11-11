import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	// As the root config's "web" project: specs mount single-file components.
	// The *.browser.spec.ts run in a browser, as its "web-browser" project.
	plugins: [vue()],
	test: {
		exclude: [...configDefaults.exclude, "**/*.browser.spec.ts"],
		environment: "happy-dom",
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Components drawn with their own rules: see the root config (#936).
		css: { include: [/\.css$/, /\.vue\?vue&type=style/] },
	},
});
