import { execFileSync } from "node:child_process";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

function resolveBuildHash(): string {
	const env = process.env.LASTERM_BUILD_HASH;
	if (env && env.length > 0) return env.slice(0, 7);
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "dev";
	}
}

const BUILD_HASH = resolveBuildHash();

export default defineConfig({
	plugins: [vue()],
	define: {
		// Inject build hash as a compile-time constant accessible via import.meta.env.VITE_BUILD_HASH
		"import.meta.env.VITE_BUILD_HASH": JSON.stringify(BUILD_HASH),
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/ws": {
				target: "ws://127.0.0.1:4100",
				ws: true,
			},
			"/api": {
				target: "http://127.0.0.1:4100",
			},
			"/public": {
				target: "http://127.0.0.1:4100",
			},
		},
	},
});
