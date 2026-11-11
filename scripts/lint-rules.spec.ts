import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The lint rules that hold what tests reading the sources as text used to hold
 * (#936): a secret compared with `===` in the hub (#514), a CSS variable nothing
 * declares (#830), a click handler the keyboard cannot reach in Settings, a
 * colour of its own in the empty pane. Each is run here by Biome, with the
 * repository's own biome.json and plugins, over files planted at the paths its
 * overrides name, so a rule that stops matching, or an override that stops
 * reaching its files, fails here rather than letting everything through.
 *
 * The probe lives outside the repository: biome.json leaves `target` out, and a
 * nested configuration would be read as part of the repository's. The rule on
 * CSS variables knows base.css's declarations only in what imports it, as
 * main.ts does in the app: the probe's main.ts imports what it plants.
 */
const root = join(import.meta.dirname, "..");
const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");

/** What every planted hub file declares, so that each holds one comparison. */
const DECLARED = [
	"declare const deps: { authToken: string } | undefined;",
	"declare const previous: { tokenHash: string };",
	"declare function hashToken(token: string): string;",
	"declare const token: string;",
	"declare const secret: string;",
	"declare const password: string;",
	"declare const passphrase: string;",
	"declare const AUTH_TOKEN: string;",
	"declare const other: string;",
	"declare const count: number;",
].join("\n");

/** Comparisons the secret rule refuses, by case: each file of the hub holds one. */
const SECRET_REFUSED: Record<string, string> = {
	// The comparison #514 removed.
	identity: "token === deps.authToken",
	loose: "secret == other",
	passphrase: "passphrase === other",
	"optional-chain": "deps?.authToken === other",
	"upper-case": "AUTH_TOKEN === other",
	// A secret on the right only, in each of those forms.
	"right-token": "other !== token",
	"right-secret": "other === secret",
	"right-loose": "other != password",
	"right-passphrase": "other === passphrase",
	"right-optional-chain": "other === deps?.authToken",
	"right-upper-case": "other === AUTH_TOKEN",
};

/** Comparisons it lets through: a call, a type, a constant, a name that is no secret. */
const SECRET_ALLOWED: Record<string, string> = {
	"hash-of-it": "previous.tokenHash !== hashToken(token)",
	"call-right": "token === hashToken(other)",
	"call-left": "hashToken(other) !== token",
	typeof: 'typeof token === "string"',
	null: "token !== null",
	"null-left": "null === token",
	undefined: "token === undefined",
	"undefined-left": "undefined !== token",
	true: "token === true",
	"true-left": "true === token",
	false: "token === false",
	"false-left": "false !== token",
	number: "token !== 0",
	"number-left": "0 !== token",
	"no-secret": "count === other",
};

/** The empty pane's colour rules, one a line from line 3 of its style block. */
const COLOURS = [
	".hex { color: #ff0000; }",
	".rgb { color: rgb(1, 2, 3); }",
	".rgba { color: rgba(1, 2, 3, 0.5); }",
	".hsl { color: hsl(10 20% 30%); }",
	".hsla { color: hsla(10, 20%, 30%, 0.5); }",
	".hwb { color: hwb(10 20% 30%); }",
	".lab { color: lab(50% 40 59.5); }",
	".lch { color: lch(52% 72 50); }",
	".oklab { color: oklab(0.4 0.1 0.1); }",
	".oklch { color: oklch(0.6 0.1 50); }",
	".color { color: color(srgb 1 0 0); }",
	// The theme's colours, which it may name in any of these forms.
	".theme { color: var(--nt-text); }",
	".theme-rgb { background: rgb(var(--nt-bg-rgb)); }",
	".theme-mix { background: color-mix(in srgb, var(--nt-text) 50%, transparent); }",
];
/** The lines of COLOURS a colour of its own is on: all but the theme's three. */
const OWN_COLOUR_LINES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/** The planted files, by path from the probe's root. */
const PLANTED: Record<string, string> = {
	"packages/clients/web/src/main.ts": [
		'import "./styles/base.css";',
		'import "./styles/probe.css";',
		'import "./components/Probe.vue";',
		'import "./components/VacantPane.vue";',
		"",
	].join("\n"),
	...Object.fromEntries(
		Object.entries({ ...SECRET_REFUSED, ...SECRET_ALLOWED }).map(([name, comparison]) => [
			`packages/hub/src/${name in SECRET_REFUSED ? "secret" : "fine"}-${name}.ts`,
			`${DECLARED}\nexport const compared = ${comparison};\n`,
		]),
	),
	// The rule is the hub's sources': not its specs, fixtures or setup, nor the web client.
	...Object.fromEntries(
		[
			"packages/hub/src/secret.spec.ts",
			"packages/hub/src/secret.fixture.ts",
			"packages/hub/src/secret.setup.ts",
			"packages/clients/web/src/secret.ts",
		].map((path) => [path, `${DECLARED}\nexport const compared = token === other;\n`]),
	),
	// A variable nothing declares, in a stylesheet and in a component; one base.css declares.
	"packages/clients/web/src/styles/probe.css":
		".a { color: var(--nt-nope); }\n.b { color: var(--nt-text); }\n",
	"packages/clients/web/src/components/Probe.vue":
		'<template><div class="a">x</div></template>\n<style scoped>\n.a { color: var(--nt-nope); }\n</style>\n',
	// A click on what the keyboard cannot reach, in Settings; on a button, which it can.
	"packages/clients/web/src/components/settings/Probe.vue":
		'<template><div @click="go">x</div></template>\n<script setup lang="ts">\nfunction go(): void {}\n</script>\n',
	"packages/clients/web/src/components/settings/Fine.vue":
		'<template><button type="button" @click="go">x</button></template>\n<script setup lang="ts">\nfunction go(): void {}\n</script>\n',
	// Colours of its own in the empty pane, and the theme's; another component is not held to it.
	"packages/clients/web/src/components/VacantPane.vue": `<template><div class="hex">x</div></template>\n<style scoped>\n${COLOURS.join("\n")}\n</style>\n`,
	"packages/clients/web/src/components/Other.vue":
		'<template><div class="a">x</div></template>\n<style scoped>\n.a { color: #ff0000; }\n</style>\n',
};

interface Diagnostic {
	category: string;
	severity?: string;
	location?: { path?: string; start?: { line: number } };
	message?: string;
}

interface Found {
	path: string;
	rule: string;
	severity: string;
	line: number;
	message: string;
}

let probe: string;
let found: Found[];

beforeAll(() => {
	probe = mkdtempSync(join(tmpdir(), "lasterm-lint-rules-"));
	for (const file of [
		"biome.json",
		"lint",
		"packages/clients/web/lint",
		"packages/clients/web/src/styles/base.css",
	]) {
		cpSync(join(root, file), join(probe, file), { recursive: true });
	}
	for (const [path, text] of Object.entries(PLANTED)) {
		mkdirSync(dirname(join(probe, path)), { recursive: true });
		writeFileSync(join(probe, path), text);
	}
	let report = "";
	let said = "";
	try {
		report = execFileSync(
			process.execPath,
			[biome, "lint", "--vcs-enabled=false", "--reporter=json", "--max-diagnostics=none", "."],
			{ cwd: probe, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		// Biome exits 1 when it reports an error, which every planted violation is.
		report = (error as { stdout?: string }).stdout ?? "";
		said = (error as { stderr?: string }).stderr ?? "";
	}
	// A configuration or a plugin it cannot load leaves no report, only why.
	if (!report.trimStart().startsWith("{")) {
		throw new Error(`Biome gave no report: ${report}${said}`);
	}
	const diagnostics = (JSON.parse(report) as { diagnostics: Diagnostic[] }).diagnostics;
	found = diagnostics
		.map((d) => ({
			path: (d.location?.path ?? "").replaceAll("\\", "/"),
			rule: d.category,
			severity: d.severity ?? "",
			line: d.location?.start?.line ?? 0,
			message: d.message ?? "",
		}))
		// `==` and `!=` are also the recommended noDoubleEquals', not these rules' to answer.
		.filter((d) => d.rule !== "lint/suspicious/noDoubleEquals")
		.sort((a, b) => `${a.path} ${a.rule} ${a.line}`.localeCompare(`${b.path} ${b.rule} ${b.line}`));
}, 60_000);

afterAll(() => {
	rmSync(probe, { recursive: true, force: true });
});

/** The rules that answered a file, in order. */
const at = (file: string) => found.filter((d) => d.path === file).map((d) => d.rule);

describe("the lint rules that replaced scans of the sources (#936)", () => {
	it("refuses each form of a secret compared with a plain equality in the hub", () => {
		for (const name of Object.keys(SECRET_REFUSED)) {
			expect(at(`packages/hub/src/secret-${name}.ts`), name).toEqual(["plugin"]);
		}
		expect(
			found.filter((d) => d.message.includes("use tokensEqual from auth.ts")).map((d) => d.path),
		).toEqual(
			Object.keys(SECRET_REFUSED)
				.map((name) => `packages/hub/src/secret-${name}.ts`)
				.sort(),
		);
	});

	it("lets through a call, a type, a constant, and a name that is no secret", () => {
		for (const name of Object.keys(SECRET_ALLOWED)) {
			expect(at(`packages/hub/src/fine-${name}.ts`), name).toEqual([]);
		}
	});

	it("leaves the hub's specs, fixtures and setup, and the web client, to themselves", () => {
		for (const path of [
			"packages/hub/src/secret.spec.ts",
			"packages/hub/src/secret.fixture.ts",
			"packages/hub/src/secret.setup.ts",
			"packages/clients/web/src/secret.ts",
		]) {
			expect(at(path), path).toEqual([]);
		}
	});

	it("refuses a CSS variable nothing declares, in a stylesheet and in a component", () => {
		expect(at("packages/clients/web/src/styles/probe.css")).toEqual([
			"lint/nursery/noUndeclaredCustomProperties",
		]);
		expect(at("packages/clients/web/src/components/Probe.vue")).toEqual([
			"lint/nursery/noUndeclaredCustomProperties",
		]);
		expect(found.map((d) => d.message)).toContain("The custom property --nt-nope is not defined.");
	});

	it("refuses in Settings a click the keyboard cannot reach", () => {
		expect(at("packages/clients/web/src/components/settings/Probe.vue")).toEqual([
			"lint/a11y/noNoninteractiveElementInteractions",
			"lint/a11y/noStaticElementInteractions",
			"lint/a11y/useKeyWithClickEvents",
		]);
		expect(at("packages/clients/web/src/components/settings/Fine.vue")).toEqual([]);
	});

	it("refuses each form of a colour of its own in the empty pane, and only there", () => {
		const vacant = found.filter(
			(d) => d.path === "packages/clients/web/src/components/VacantPane.vue",
		);
		expect(vacant.map((d) => d.rule)).toEqual(OWN_COLOUR_LINES.map(() => "plugin"));
		expect(vacant.map((d) => d.line).sort((a, b) => a - b)).toEqual(OWN_COLOUR_LINES);
		expect(at("packages/clients/web/src/components/Other.vue")).toEqual([]);
	});

	// A rule turned to a warning would let `pnpm lint` pass.
	it("reports each of these as an error, and nothing else", () => {
		expect(found.map((d) => d.severity)).toEqual(found.map(() => "error"));
		expect(found).toHaveLength(
			Object.keys(SECRET_REFUSED).length + 2 + 3 + OWN_COLOUR_LINES.length,
		);
	});
});
