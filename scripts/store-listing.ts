// Run with Node type stripping: node scripts/store-listing.ts <version> [submission.json].
// Limits: Microsoft Learn (updated 2026-08-24):
// https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info
// https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-additional-information
// Partner Center JSON retains arbitrary fields and their original casing.
// biome-ignore lint/suspicious/noExplicitAny: external submission schema is preserved, only mapped keys are changed.
type JsonObject = Record<string, any>;
export interface Listing {
	locale: string;
	fields: {
		shortDescription: string;
		description: string;
		features: string[];
		keywords: string[];
		releaseNotes?: string;
	};
}

// Carries the Store listings kept in this folder into a Partner Center
// submission, so what the Store shows is what was reviewed here. The
// *What's new* is not in the listings: each change users will see adds its line
// to `news/`, and a release gathers the lines added since the previous one.
//
//   node scripts/store-listing.ts <version>                   what would be sent
//   node scripts/store-listing.ts <version> <submission.json> the submission, updated
//
// The submission is what `msstore submission get` prints. The updated one goes to
// standard output, for `msstore submission update`. Exit code 3 means no line was
// added since the previous release: Store users would be told nothing, and the
// submission must stay a draft until someone writes its What's new.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NO_NEWS = 3;

const HERE = join(dirname(fileURLToPath(import.meta.url)), "../packaging/store");
const ROOT = join(HERE, "../..");
const NEWS = "packaging/store/news";
// Where a release's full notes are: the Store's *What's new* ends with a link to them.
const RELEASES = "https://github.com/khiops/lasterm/releases/tag/";

/**
 * What frames the lines, by language: the version first, then a link to every
 * change. The version comes from the tag, never from a news file.
 */
const FRAME: Record<string, { version: string; all: string }> = {
	en: { version: "Version {version}", all: "All changes: {url}" },
	fr: { version: "Version {version}", all: "Tous les changements : {url}" },
};

// Partner Center's limits, checked here rather than discovered at certification.
const RELEASE_NOTES_MAX = 1500;
const FEATURES_MAX = 20;
const FEATURE_LENGTH_MAX = 200;
const KEYWORDS_MAX = 7;
const KEYWORD_LENGTH_MAX = 40;

/**
 * One listing file: its locale and the four texts the submission carries. The
 * sections are read by position, not by title: the French file titles them in
 * French.
 */
export function parseListing(markdown: string): Listing {
	const title = /^# .*\(([a-z]{2}-[A-Z]{2})\)\s*$/m.exec(markdown);
	if (!title) throw new Error('the title names no locale, as in "(en-US)"');

	const sections = markdown.split(/^## /m).slice(1);
	if (sections.length !== 4) {
		throw new Error(
			`4 sections expected (short description, description, features, search terms), found ${sections.length}`,
		);
	}
	const bodies = sections.map((section, index) => {
		const body = section.slice(section.indexOf("\n") + 1);
		return index === 2 ? body : body.trim();
	});

	const [shortDescription, description, features, keywords] = bodies as [
		string,
		string,
		string,
		string,
	];
	if (shortDescription.length > 1000) throw new Error("shortDescription exceeds 1000 characters");
	if (!description) throw new Error("description is empty");
	if (description.length > 10000) throw new Error("description exceeds 10000 characters");

	// One feature per list item, as Partner Center shows them.
	const items: string[] = [];
	for (const line of features.split("\n")) {
		if (!line.trim()) continue;
		if (!/^[-•] /.test(line)) {
			throw new Error(`feature line "${line}" must start with "- " or "• "`);
		}
		const item = line.slice(2).trim();
		if (item) items.push(item);
	}
	if (items.length === 0) throw new Error("the features section lists nothing");
	if (items.length > FEATURES_MAX)
		throw new Error(`${items.length} features, the Store takes ${FEATURES_MAX}`);
	const longFeature = items.find((item) => item.length > FEATURE_LENGTH_MAX);
	if (longFeature)
		throw new Error(`feature "${longFeature}" is over ${FEATURE_LENGTH_MAX} characters`);

	const terms = keywords
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean);
	if (terms.length > KEYWORDS_MAX)
		throw new Error(`${terms.length} keywords, the Store takes ${KEYWORDS_MAX}`);
	const long = terms.find((term) => term.length > KEYWORD_LENGTH_MAX);
	if (long) throw new Error(`keyword "${long}" is over ${KEYWORD_LENGTH_MAX} characters`);

	const words = terms.reduce((sum, term) => sum + (term.match(/\S+/g)?.length ?? 0), 0);
	if (words > 21) throw new Error("keywords exceed 21 words");
	return {
		locale: (title[1] ?? "").toLowerCase(),
		fields: { shortDescription, description, features: items, keywords: terms },
	};
}

/** The language a fragment names a listing by: `en` for `en-us`. */
export function languageOf(listing: Listing) {
	return listing.locale.slice(0, 2);
}

/** One fragment of `news/`: a line per language, `en: …`, nothing else. */
export function parseFragment(text: string, languages: string[]) {
	const lines: Record<string, string> = {};
	for (const line of text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)) {
		const match = /^([a-z]{2}):\s*(.+)$/.exec(line);
		if (!match || !languages.includes(match[1] ?? "")) {
			throw new Error(
				`"${line}" is not a line in ${languages.map((language) => `"${language}: …"`).join(" or ")}`,
			);
		}
		if (lines[match[1] ?? ""]) throw new Error(`two ${match[1] ?? ""} lines`);
		lines[match[1] ?? ""] = match[2] ?? "";
	}
	const missing = languages.filter((language) => !lines[language]);
	if (missing.length > 0) throw new Error(`no ${missing.join(", ")} line`);
	return lines;
}

/**
 * Each language's *What's new*: a bullet per fragment, in the order of their
 * file names, which is how an author puts one change first. With `version`,
 * framed by that version and a link to its release.
 */
export function whatsNew(fragments: Record<string, string>, languages: string[], version?: string) {
	const parsed = Object.keys(fragments)
		.sort()
		.map((name) => {
			try {
				return parseFragment(fragments[name] ?? "", languages);
			} catch (error) {
				throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	return Object.fromEntries(
		languages.map((language) => {
			const bullets = parsed.map((lines) => `• ${lines[language]}`).join("\n");
			const notes = version ? framed(bullets, language, version) : bullets;
			if (notes.length > RELEASE_NOTES_MAX) {
				throw new Error(
					`the ${language} What's new holds ${notes.length} characters, the Store takes ${RELEASE_NOTES_MAX}`,
				);
			}
			return [language, notes];
		}),
	);
}

function framed(bullets: string, language: string, version: string) {
	const frame = FRAME[language];
	if (!frame) throw new Error(`no What's new frame for ${language}`);
	const url = `${RELEASES}v${version}`;
	return [
		frame.version.replace("{version}", version),
		bullets,
		frame.all.replace("{url}", url),
	].join("\n\n");
}

/** The key of `object` equal to `name` ignoring case: the API answers in camelCase, the CLI may not. */
function keyOf(object: JsonObject, name: string) {
	return Object.keys(object ?? {}).find((key) => key.toLowerCase() === name.toLowerCase());
}

/**
 * The submission with each listing's texts in place. Every mapped field must already exist: an incomplete submission is refused.
 */
export function applyListings(submission: JsonObject, listings: Listing[]) {
	const updated = structuredClone(submission);
	const listingsKey = keyOf(updated, "listings");
	if (!listingsKey) throw new Error("the submission has no listings");
	const byLocale = updated[listingsKey];

	for (const listing of listings) {
		const localeKey = keyOf(byLocale, listing.locale);
		if (!localeKey) {
			throw new Error(`${listing.locale}: not a language of this Store listing`);
		}
		const baseKey = keyOf(byLocale[localeKey], "baseListing");
		if (!baseKey) {
			throw new Error(`${listing.locale}: no baseListing`);
		}
		const base = byLocale[localeKey][baseKey];
		for (const [field, value] of Object.entries(listing.fields)) {
			const key = keyOf(base, field);
			if (key) base[key] = value;
			else throw new Error(`${listing.locale}: no ${field} field`);
		}
	}
	return { submission: updated };
}

/** Every `listing-*.md` of this folder, parsed. */
export function readListings(folder = HERE) {
	const listings = readdirSync(folder)
		.filter((name) => /^listing-.+\.md$/.test(name))
		.sort()
		.map((name) => {
			try {
				return parseListing(readFileSync(join(folder, name), "utf8"));
			} catch (error) {
				throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	if (listings.length === 0) throw new Error("no listing files");
	const locales = new Set<string>();
	for (const listing of listings) {
		if (locales.has(listing.locale)) throw new Error(`duplicate locale ${listing.locale}`);
		locales.add(listing.locale);
	}
	return listings;
}

function isFragment(path: string) {
	return /\.md$/.test(path) && !/(^|\/)README\.md$/.test(path);
}

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * The release the *What's new* counts from: the last tag before `ref`, leaving
 * out `version`'s own tag, which the commit being released already carries.
 */
export function previousRelease(version: string, ref = "HEAD", cwd = ROOT) {
	const exclude = version ? ["--exclude", `v${version}`] : [];
	return git(cwd, "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ...exclude, ref).trim();
}

/**
 * The fragments added between `since` and `ref`, by path from `cwd`. Added only:
 * a fragment released and edited later stays with its release. Deleting or
 * renaming a released fragment is refused before gathering additions.
 */
export function newsAdded(since: string, ref = "HEAD", cwd = ROOT) {
	const deleted = git(
		cwd,
		"diff",
		"-z",
		"--name-only",
		"--no-renames",
		"--diff-filter=D",
		since,
		ref,
		"--",
		NEWS,
	)
		.split("\0")
		.filter(Boolean)
		.filter(isFragment);
	if (deleted.length > 0) {
		throw new Error(`released news fragments deleted or renamed: ${deleted.join(", ")}`);
	}
	return git(
		cwd,
		"diff",
		"-z",
		"--name-only",
		"--no-renames",
		"--diff-filter=A",
		since,
		ref,
		"--",
		NEWS,
	)
		.split("\0")
		.filter(Boolean)
		.filter(isFragment);
}

export function main(argv: string[], cwd = ROOT): number {
	const [version, submissionPath] = argv;
	if (argv.length < 1 || argv.length > 2 || !/^\d+\.\d+\.\d+$/.test(version ?? ""))
		throw new Error("usage: node scripts/store-listing.ts <version> [submission.json]");
	const listings = readListings(join(cwd, "packaging/store"));
	const languages = [...new Set(listings.map(languageOf))];
	const since = previousRelease(version ?? "", "HEAD", cwd);
	const added = newsAdded(since, "HEAD", cwd);
	if (added.length === 0) {
		console.error(`No line added to packaging/store/news/ since ${since}.`);
		return NO_NEWS;
	}
	const fragments = Object.fromEntries(
		added.map((path) => [path, readFileSync(join(cwd, path), "utf8")]),
	);
	const news = whatsNew(fragments, languages, version);
	const complete = listings.map((listing) => ({
		...listing,
		fields: { ...listing.fields, releaseNotes: news[languageOf(listing)] ?? "" },
	}));
	const result = submissionPath
		? applyListings(
				JSON.parse(readFileSync(submissionPath, "utf8").replace(/^\uFEFF/, "")),
				complete,
			).submission
		: complete;
	console.log(JSON.stringify(result, null, 2));
	return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(
			`::error::store-listing: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}
