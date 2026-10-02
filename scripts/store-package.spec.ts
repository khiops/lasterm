import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { storePackage } from "./store-package.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function folder() {
	const root = mkdtempSync(join(tmpdir(), "store-package-"));
	roots.push(root);
	return root;
}
const name = "Lasterm_0.2.0.0_x64.msix";
test("one correctly named regular package passes", () => {
	const root = folder();
	writeFileSync(join(root, name), "package");
	assert.equal(storePackage(root, "0.2.0"), join(root, name));
});
test("two files are refused", () => {
	const root = folder();
	writeFileSync(join(root, name), "");
	writeFileSync(join(root, "extra"), "");
	assert.throws(() => storePackage(root, "0.2.0"), /found.*extra/);
});
test("wrong name is refused", () => {
	const root = folder();
	writeFileSync(join(root, "wrong.msix"), "");
	assert.throws(() => storePackage(root, "0.2.0"), /found.*wrong.msix/);
});
test("directory in place of package is refused", () => {
	const root = folder();
	mkdirSync(join(root, name));
	assert.throws(() => storePackage(root, "0.2.0"), /not a regular file/);
});
test("symlink is refused", () => {
	const root = folder();
	const target = join(folder(), "target");
	writeFileSync(target, "");
	symlinkSync(target, join(root, name));
	assert.throws(() => storePackage(root, "0.2.0"), /not a regular file/);
});
