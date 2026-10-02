import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	applyListings,
	languageOf,
	main,
	newsAdded,
	parseListing,
	previousRelease,
	readListings,
	whatsNew,
} from "./store-listing.ts";

const LISTING = `# Store listing — English (en-US)

Notes for whoever submits.

## Short description (shown in search results)

Lighting control.

## Description

First paragraph.

Second paragraph.

## Features (shown on the Store page)

- One feature.
- Another feature.

## Search terms (7 at most, 30 characters each)

hid, rgb, keyboard lighting
`;

const LANGUAGES = ["en", "fr"];

test("a listing gives its locale and four texts", () => {
	const listing = parseListing(LISTING);
	assert.equal(listing.locale, "en-us");
	assert.equal(languageOf(listing), "en");
	assert.deepEqual(listing.fields, {
		shortDescription: "Lighting control.",
		description: "First paragraph.\n\nSecond paragraph.",
		features: ["One feature.", "Another feature."],
		keywords: ["hid", "rgb", "keyboard lighting"],
	});
});

test("a section missing is refused rather than read out of place", () => {
	const withoutTerms = LISTING.slice(0, LISTING.indexOf("## Search terms"));
	assert.throws(() => parseListing(withoutTerms), /4 sections expected/);
});

test("a wrapped feature continuation is refused naming the line", () => {
	assert.throws(
		() => parseListing(LISTING.replace("- One feature.", "- One feature.\n  continued")),
		/feature line " {2}continued"/,
	);
});

test("a whitespace-only description is refused naming description", () => {
	assert.throws(
		() => parseListing(LISTING.replace("First paragraph.\n\nSecond paragraph.", " \t\n  ")),
		/description/,
	);
});

test("the Store limits are checked before submitting", () => {
	assert.throws(
		() => parseListing(LISTING.replace("hid, rgb, keyboard lighting", "a, b, c, d, e, f, g, h")),
		/8 keywords/,
	);
	assert.throws(
		() => parseListing(LISTING.replace("- Another feature.", `- ${"x".repeat(201)}`)),
		/over 200 characters/,
	);
	assert.throws(
		() => whatsNew({ "news/long.md": `en: ${"x".repeat(1500)}\nfr: court` }, LANGUAGES),
		/the en What's new holds 1502 characters, the Store takes 1500/,
	);
});

test("the what’s new is a bullet per fragment, in the order of their names", () => {
	const news = whatsNew(
		{
			"news/signal-bindings.md":
				"en: A setting follows a signal.\nfr: Un paramètre suit un signal.\n",
			"news/1-status-row.md": "\nfr: Status row, un nouvel effet.\nen: Status row, a new effect.\n",
		},
		LANGUAGES,
	);
	assert.deepEqual(news, {
		en: "• Status row, a new effect.\n• A setting follows a signal.",
		fr: "• Status row, un nouvel effet.\n• Un paramètre suit un signal.",
	});
});

test("a release’s what’s new starts with its version and ends with a link to its notes", () => {
	const news = whatsNew({ "news/a.md": "en: One.\nfr: Un." }, LANGUAGES, "1.2.0");
	assert.equal(
		news.en,
		"Version 1.2.0\n\n• One.\n\nAll changes: https://github.com/khiops/lasterm/releases/tag/v1.2.0",
	);
	assert.equal(
		news.fr,
		"Version 1.2.0\n\n• Un.\n\nTous les changements : https://github.com/khiops/lasterm/releases/tag/v1.2.0",
	);
	assert.throws(
		() => whatsNew({ "news/a.md": "de: Eins." }, ["de"], "1.2.0"),
		/no What's new frame for de/,
	);
});

test("a fragment missing a language, or holding anything else, is refused by name", () => {
	assert.throws(
		() => whatsNew({ "news/a.md": "en: Only English." }, LANGUAGES),
		/news\/a\.md: no fr line/,
	);
	assert.throws(
		() => whatsNew({ "news/b.md": "en: One.\nfr: Un.\nde: Eins." }, LANGUAGES),
		/news\/b\.md: "de: Eins\." is not a line in "en: …" or "fr: …"/,
	);
	assert.throws(
		() => whatsNew({ "news/c.md": "en: One.\nen: Two.\nfr: Un." }, LANGUAGES),
		/two en lines/,
	);
});

test("the texts land in the fields the submission has, whatever their case", () => {
	const submission = {
		Listings: {
			"en-us": {
				BaseListing: {
					ShortDescription: "old",
					Description: "old",
					Features: ["old"],
					ReleaseNotes: "old",
					Keywords: [],
					Title: "Candeo",
				},
			},
			"de-de": { BaseListing: { Description: "alt" } },
		},
		ApplicationPackages: [{ FileName: "Candeo_1.2.0_x64.msix" }],
	};
	const listing = parseListing(LISTING);
	listing.fields.releaseNotes = "• One thing.";
	const { submission: updated } = applyListings(submission, [listing]);
	const base = updated.Listings["en-us"].BaseListing;
	assert.equal(base.Description, "First paragraph.\n\nSecond paragraph.");
	assert.equal(base.ReleaseNotes, "• One thing.");
	assert.deepEqual(base.Keywords, ["hid", "rgb", "keyboard lighting"]);
	assert.deepEqual(base.Features, ["One feature.", "Another feature."]);
	assert.equal(base.Title, "Candeo", "a field no listing file carries is kept");
	assert.equal(
		updated.Listings["de-de"].BaseListing.Description,
		"alt",
		"another language is kept",
	);
	assert.deepEqual(
		updated.ApplicationPackages,
		submission.ApplicationPackages,
		"the package is kept",
	);
	assert.equal(
		submission.Listings["en-us"].BaseListing.Description,
		"old",
		"the input is not modified",
	);
});

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() {
	const root = mkdtempSync(join(tmpdir(), "lasterm-store-"));
	roots.push(root);
	return root;
}

test("real English listing passes every limit", () => {
	assert.deepEqual(
		readListings().map((listing) => listing.locale),
		["en-us"],
	);
});
test.each([
	["shortDescription", "1000", () => LISTING.replace("Lighting control.", "x".repeat(1001))],
	["description", "10000", () => LISTING.replace("First paragraph.", "x".repeat(10001))],
	[
		"features",
		"20",
		() =>
			LISTING.replace(
				"- One feature.\n- Another feature.",
				Array(21).fill("- Feature.").join("\n"),
			),
	],
	["feature", "200", () => LISTING.replace("- One feature.", `- ${"x".repeat(201)}`)],
	["keyword", "40", () => LISTING.replace("hid, rgb, keyboard lighting", "x".repeat(41))],
	["keywords", "7", () => LISTING.replace("hid, rgb, keyboard lighting", "a,b,c,d,e,f,g,h")],
	[
		"keywords",
		"21",
		() =>
			LISTING.replace("hid, rgb, keyboard lighting", Array(6).fill("one two three four").join(",")),
	],
])("refuses %s limit %s", (field, limit, markdown) => {
	assert.throws(
		() => parseListing(markdown()),
		(error) =>
			error instanceof Error && error.message.includes(field) && error.message.includes(limit),
	);
});
test("zero listing files and duplicate locale are refused", () => {
	const folder = temp();
	assert.throws(() => readListings(folder), /no listing files/);
	writeFileSync(join(folder, "listing-a.md"), LISTING);
	writeFileSync(join(folder, "listing-b.md"), LISTING);
	assert.throws(() => readListings(folder), /duplicate locale en-us/);
});
test("absent locale, baseListing and every mapped field are refused", () => {
	const listing = parseListing(LISTING);
	listing.fields.releaseNotes = "new";
	assert.throws(() => applyListings({ listings: {} }, [listing]), /en-us/);
	assert.throws(
		() => applyListings({ listings: { "en-us": {} } }, [listing]),
		/en-us: no baseListing/,
	);
	for (const field of Object.keys(listing.fields)) {
		const base: Record<string, unknown> = { ...listing.fields };
		delete base[field];
		assert.throws(
			() => applyListings({ listings: { "en-us": { baseListing: base } } }, [listing]),
			new RegExp(`en-us: no ${field} field`),
		);
	}
	assert.throws(() => applyListings({}, [listing]), /no listings/);
});
function repo(news: boolean, change?: (root: string) => void) {
	const root = temp();
	mkdirSync(join(root, "packaging/store/news"), { recursive: true });
	writeFileSync(join(root, "packaging/store/listing-en.md"), LISTING);
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	// Writes are confined to this disposable fixture, never the working repository.
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
	git("init", "--quiet");
	writeFileSync(join(root, "packaging/store/news/old.md"), "en: Old.");
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-qm", "old");
	git("tag", "v0.1.0");
	writeFileSync(join(root, "packaging/store/news/old.md"), "en: Edited old.");
	writeFileSync(join(root, "packaging/store/news/README.md"), "not news");
	if (news) {
		writeFileSync(join(root, "packaging/store/news/b.md"), "en: Second.");
		writeFileSync(join(root, "packaging/store/news/a.md"), "en: First.");
	}
	change?.(root);
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-qm", "new");
	git("tag", "v0.2.0");
	const sha = git("rev-parse", "HEAD");
	git("checkout", "--quiet", "--detach", sha);
	return root;
}
test("detached release SHA excludes its own tag and gathers added fragments only", () => {
	const root = repo(true);
	assert.equal(previousRelease("0.2.0", "HEAD", root), "v0.1.0");
	assert.deepEqual(newsAdded("v0.1.0", "HEAD", root), [
		"packaging/store/news/a.md",
		"packaging/store/news/b.md",
	]);
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	assert.equal(main(["0.2.0"], root), 0);
	const listing = JSON.parse(String(output.mock.calls[0]?.[0]));
	assert.equal(
		listing[0].fields.releaseNotes,
		"Version 0.2.0\n\n• First.\n• Second.\n\nAll changes: https://github.com/khiops/lasterm/releases/tag/v0.2.0",
	);
});
test("an accented fragment added between tags appears in What's new", () => {
	const root = repo(false, (root) => {
		writeFileSync(join(root, "packaging/store/news/éclairage.md"), "en: Lighting improved.");
	});
	const output = vi.spyOn(console, "log").mockImplementation(() => {});
	assert.equal(main(["0.2.0"], root), 0);
	const listing = JSON.parse(String(output.mock.calls[0]?.[0]));
	assert.match(listing[0].fields.releaseNotes, /• Lighting improved\./);
});

test("a released fragment renamed between tags is refused naming it", () => {
	const root = repo(false, (root) => {
		renameSync(
			join(root, "packaging/store/news/old.md"),
			join(root, "packaging/store/news/renamed.md"),
		);
	});
	assert.throws(() => main(["0.2.0"], root), /packaging\/store\/news\/old\.md/);
});

test("a released fragment deleted between tags is refused naming it", () => {
	const root = repo(false, (root) => {
		rmSync(join(root, "packaging/store/news/old.md"));
	});
	assert.throws(() => main(["0.2.0"], root), /packaging\/store\/news\/old\.md/);
});

test("no news exits 3 and prints nothing on stdout", () => {
	const root = repo(false);
	// Run the actual CLI with a copied layout so its default root is the fixture.
	mkdirSync(join(root, "scripts"));
	writeFileSync(
		join(root, "scripts/store-listing.ts"),
		readFileSync(resolve("scripts/store-listing.ts")),
	);
	const result = spawnSync(process.execPath, ["scripts/store-listing.ts", "0.2.0"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 3);
	assert.equal(result.stdout, "");
});
