import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

// Partner Center accepts a package only when its display name is one of the
// product's reserved names (Store ID 9P82QRJ6VDWL reserves "Lasterm" only).
// 0.14.0 shipped "Lasterm Terminal" and could not be uploaded.
const RESERVED_NAME = "Lasterm";

const manifest = readFileSync(
	join(import.meta.dirname, "../packages/clients/desktop/msix/Package.appxmanifest"),
	"utf8",
);

test("the package display name is the Store's reserved name", () => {
	assert.deepEqual(
		[...manifest.matchAll(/<DisplayName>([^<]*)<\/DisplayName>/g)].map((match) => match[1]),
		[RESERVED_NAME],
	);
});

test("the Start menu shows the same reserved name", () => {
	assert.deepEqual(
		[...manifest.matchAll(/<uap:VisualElements\s[^>]*?DisplayName="([^"]*)"/g)].map(
			(match) => match[1],
		),
		[RESERVED_NAME],
	);
});
