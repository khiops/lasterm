import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One exact Node version everywhere. CI reads `.nvmrc` (setup-node), a local
 * checkout runs mise, which reads `mise.toml`, and the hub's single executable
 * embeds the Node that built it. A major version alone let CI take 24.21 while a
 * workstation ran 24.14, and a crypto change between the two failed a spec on CI
 * only (#649). mise pins pnpm too, which must be the `packageManager` one.
 */
const root = join(import.meta.dirname, "..");

/** `name = "x.y.z"` under `[tools]` in mise.toml. */
function miseTool(toml: string, name: string): string | undefined {
	let inTools = false;
	for (const line of toml.split(/\r?\n/)) {
		const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (section) {
			inTools = section[1] === "tools";
			continue;
		}
		const pin = /^\s*([\w-]+)\s*=\s*"([^"]+)"/.exec(line);
		if (inTools && pin?.[1] === name) return pin[2];
	}
	return undefined;
}

describe("the Node version", () => {
	const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
	const mise = readFileSync(join(root, "mise.toml"), "utf8");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		engines?: { node?: string };
		packageManager?: string;
		volta?: unknown;
	};

	it("is pinned to an exact version in .nvmrc", () => {
		expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("is the same for mise as for CI", () => {
		expect(miseTool(mise, "node")).toBe(nvmrc);
	});

	it("gives mise the pnpm of packageManager", () => {
		expect(`pnpm@${miseTool(mise, "pnpm")}`).toBe(pkg.packageManager);
	});

	it("has no second pin left behind for Volta", () => {
		expect(pkg.volta).toBeUndefined();
	});

	it("satisfies the engines range", () => {
		const major = Number(nvmrc.split(".")[0]);
		const minimum = Number(/>=\s*(\d+)/.exec(pkg.engines?.node ?? "")?.[1]);
		expect(major).toBeGreaterThanOrEqual(minimum);
	});
});
