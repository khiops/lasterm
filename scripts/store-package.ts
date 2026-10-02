import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The archive is from this run's build; tar refuses parent traversal members. */
export function storePackage(directory: string, version: string): string {
	const expected = `Lasterm_${version}.0_x64.msix`;
	const entries = readdirSync(directory);
	if (entries.length !== 1 || entries[0] !== expected)
		throw new Error(`expected exactly ${expected}, found ${JSON.stringify(entries)}`);
	const path = join(directory, expected);
	if (!lstatSync(path).isFile())
		throw new Error(`${expected}: not a regular file (directory or link)`);
	return path;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const [directory, version] = process.argv.slice(2);
		if (!directory || !version || process.argv.length !== 4)
			throw new Error("usage: node scripts/store-package.ts <extracted dir> <version>");
		console.log(storePackage(directory, version));
	} catch (error) {
		console.error(
			`::error::store-package: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
