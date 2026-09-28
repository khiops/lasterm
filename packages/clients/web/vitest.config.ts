import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// As the root config's "web" project: specs mount single-file components.
	plugins: [vue()],
	test: {
		environment: "happy-dom",
	},
});
