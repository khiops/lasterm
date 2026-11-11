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

/** The planted files, by path from the probe's root. */
const PLANTED: Record<string, string> = {
	"packages/clients/web/src/main.ts": [
		'import "./styles/base.css";',
		'import "./styles/probe.css";',
		'import "./components/Probe.vue";',
		'import "./components/VacantPane.vue";',
		"",
	].join("\n"),
	// The comparison #514 removed, on either side, with each operator.
	"packages/hub/src/secret.ts": [
		"declare const deps: { authToken: string };",
		"declare const other: string;",
		"export const a = (token: string) => token === deps.authToken;",
		"export const b = (token: string) => deps.authToken !== token;",
		"export const c = (secret: string) => secret == other;",
		"export const d = (password: string) => other != password;",
		"",
	].join("\n"),
	// What may be compared plainly: a constant, a call, a type, a name that is no secret.
	"packages/hub/src/fine.ts": [
		"declare const previous: { tokenHash: string };",
		"declare function hashToken(token: string): string;",
		"export const a = (token: string) => previous.tokenHash !== hashToken(token);",
		'export const b = (token: unknown) => typeof token === "string";',
		"export const c = (token: string | null) => token !== null;",
		"export const d = (token?: string) => token === undefined;",
		"export const e = (count: number, other: number) => count === other;",
		"",
	].join("\n"),
	// The rule is the hub's sources': not its specs, not the web client.
	"packages/hub/src/secret.spec.ts":
		"export const a = (token: string, b: string) => token === b;\n",
	"packages/clients/web/src/secret.ts":
		"export const a = (token: string, b: string) => token === b;\n",
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
	"packages/clients/web/src/components/VacantPane.vue":
		'<template><div class="a">x</div></template>\n<style scoped>\n.a { color: #ff0000; }\n.b { background: rgb(1, 2, 3); }\n.c { color: var(--nt-text); }\n</style>\n',
	"packages/clients/web/src/components/Other.vue":
		'<template><div class="a">x</div></template>\n<style scoped>\n.a { color: #ff0000; }\n</style>\n',
};

interface Diagnostic {
	category: string;
	location?: { path?: string; span?: [number, number] };
	message?: string;
}

let probe: string;
let found: Array<[string, string]>;
let descriptions: string[];

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
		.map((d): [string, string] => [(d.location?.path ?? "").replaceAll("\\", "/"), d.category])
		.sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));
	descriptions = diagnostics.map((d) => d.message ?? "");
}, 60_000);

afterAll(() => {
	rmSync(probe, { recursive: true, force: true });
});

const at = (file: string) => found.filter(([path]) => path === file).map(([, rule]) => rule);

describe("the lint rules that replaced scans of the sources (#936)", () => {
	it("refuses a secret compared with a plain equality in the hub, and only there", () => {
		// `==` and `!=` are also the recommended noDoubleEquals', not this rule's to answer.
		const own = (file: string) =>
			at(file).filter((rule) => rule !== "lint/suspicious/noDoubleEquals");
		expect(own("packages/hub/src/secret.ts")).toEqual(["plugin", "plugin", "plugin", "plugin"]);
		expect(descriptions.filter((d) => d.includes("use tokensEqual from auth.ts"))).toHaveLength(4);
		expect(own("packages/hub/src/fine.ts")).toEqual([]);
		expect(own("packages/hub/src/secret.spec.ts")).toEqual([]);
		expect(own("packages/clients/web/src/secret.ts")).toEqual([]);
	});

	it("refuses a CSS variable nothing declares, in a stylesheet and in a component", () => {
		expect(at("packages/clients/web/src/styles/probe.css")).toEqual([
			"lint/nursery/noUndeclaredCustomProperties",
		]);
		expect(at("packages/clients/web/src/components/Probe.vue")).toEqual([
			"lint/nursery/noUndeclaredCustomProperties",
		]);
		expect(descriptions).toContain("The custom property --nt-nope is not defined.");
	});

	it("refuses in Settings a click the keyboard cannot reach", () => {
		expect(at("packages/clients/web/src/components/settings/Probe.vue")).toEqual([
			"lint/a11y/noNoninteractiveElementInteractions",
			"lint/a11y/noStaticElementInteractions",
			"lint/a11y/useKeyWithClickEvents",
		]);
		expect(at("packages/clients/web/src/components/settings/Fine.vue")).toEqual([]);
	});

	it("refuses a colour of its own in the empty pane, and only there", () => {
		expect(at("packages/clients/web/src/components/VacantPane.vue")).toEqual(["plugin", "plugin"]);
		expect(at("packages/clients/web/src/components/Other.vue")).toEqual([]);
	});

	it("reports nothing else", () => {
		expect(found.filter(([, rule]) => rule !== "lint/suspicious/noDoubleEquals")).toHaveLength(11);
	});
});
