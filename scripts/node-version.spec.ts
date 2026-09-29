import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One exact Node version everywhere. CI reads `.nvmrc` (setup-node), a local
 * checkout runs Volta, which reads `package.json`'s `volta.node`, and the hub's
 * single executable embeds the Node that built it. A major version alone let CI
 * take 24.21 while a workstation ran 24.14, and a crypto change between the two
 * failed a spec on CI only (#649).
 */
const root = join(import.meta.dirname, "..");

describe("the Node version", () => {
	const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		volta?: { node?: string };
		engines?: { node?: string };
	};

	it("is pinned to an exact version in .nvmrc", () => {
		expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("is the same for Volta as for CI", () => {
		expect(pkg.volta?.node).toBe(nvmrc);
	});

	it("satisfies the engines range", () => {
		const major = Number(nvmrc.split(".")[0]);
		const minimum = Number(/>=\s*(\d+)/.exec(pkg.engines?.node ?? "")?.[1]);
		expect(major).toBeGreaterThanOrEqual(minimum);
	});
});
