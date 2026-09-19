import type { SystemFontFamily } from "@lasterm/shared";

/** A CSS string literal, safe for any family or face name. */
export function cssString(value: string): string {
	return `"${value.replace(/[\\"]/g, "\\$&").replace(/[\n\r\f]/g, " ")}"`;
}

function fontFormat(url: string): string {
	return new URL(url, "http://localhost").pathname.endsWith(".otf") ? "opentype" : "truetype";
}

/**
 * @font-face rules for the fonts installed where the hub runs, so a client on
 * another machine can render them (#100). `local()` comes first: a client with
 * the same font installed never downloads it, and a browser fetches a `url()`
 * only once some text uses that face.
 *
 * Families the hub also serves as imported fonts are skipped: those rules exist
 * already, and two sets for one family would compete.
 */
export function systemFontFaceRules(
	families: readonly SystemFontFamily[],
	resolveUrl: (url: string) => string,
	skip: ReadonlySet<string> = new Set(),
): string {
	const rules: string[] = [];
	for (const family of families) {
		if (skip.has(family.family)) continue;
		for (const file of family.files) {
			const sources = [
				...file.localNames.map((name) => `local(${cssString(name)})`),
				`url(${cssString(resolveUrl(file.url))}) format("${fontFormat(file.url)}")`,
			];
			rules.push(
				`@font-face {
	font-family: ${cssString(family.family)};
	src: ${sources.join(", ")};
	font-weight: ${file.weight};
	font-style: ${file.style === "italic" ? "italic" : "normal"};
	font-display: swap;
}`,
			);
		}
	}
	return rules.join("\n");
}

/** The families a picker shows for a search, monospace ones only unless asked. */
export function filterSystemFonts(
	families: readonly SystemFontFamily[],
	query: string,
	monospaceOnly: boolean,
): SystemFontFamily[] {
	const needle = query.trim().toLowerCase();
	return families.filter(
		(family) =>
			(!monospaceOnly || family.monospace) &&
			(needle === "" || family.family.toLowerCase().includes(needle)),
	);
}
