import { describe, expect, it } from "vitest";
import { sanitizeTitle, truncateTitle } from "./sanitize.js";

/** True when no UTF-16 surrogate is unpaired. */
const isWellFormed = (text: string): boolean =>
	!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

describe("sanitizeTitle", () => {
	it("strips HTML tags but preserves tag content (safe: rendered via .textContent)", () => {
		// Tag content like "alert(1)" is kept — Vue renders via .textContent so it's
		// not executable. Stripping content would be overly aggressive for legitimate titles.
		expect(sanitizeTitle("<script>alert(1)</script>vim")).toBe("alert(1)vim");
	});

	it("strips control characters", () => {
		expect(sanitizeTitle("vim\x07\x1b[31m file.ts")).toBe("vim[31m file.ts");
	});

	it("truncates to maxRawLength (default 256)", () => {
		const long = "a".repeat(500);
		expect(sanitizeTitle(long)).toHaveLength(256);
	});

	it("truncates to custom maxRawLength", () => {
		expect(sanitizeTitle("abcdefghij", 5)).toBe("abcde");
	});

	it("passes through clean title unchanged", () => {
		expect(sanitizeTitle("bash — ~/projects")).toBe("bash — ~/projects");
	});

	it("returns empty string for empty input", () => {
		expect(sanitizeTitle("")).toBe("");
	});

	it("preserves Unicode characters (CJK, emoji)", () => {
		expect(sanitizeTitle("vim 文件.ts")).toBe("vim 文件.ts");
		expect(sanitizeTitle("htop 🖥️")).toBe("htop 🖥️");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeTitle("  hello world  ")).toBe("hello world");
	});

	it("handles combined HTML + control chars + whitespace", () => {
		expect(sanitizeTitle("  <b>title\x00</b>  ")).toBe("title");
	});
});

describe("sanitizeTitle surrogate pairs", () => {
	it("does not keep half a surrogate pair at the raw-length cut", () => {
		const result = sanitizeTitle("abc\u{1F600}def", 4);
		expect(result).toBe("abc");
		expect(isWellFormed(result)).toBe(true);
	});

	it("keeps a pair that fits the raw length", () => {
		expect(sanitizeTitle("abc\u{1F600}def", 5)).toBe("abc\u{1F600}");
	});
});

describe("sanitizeTitle tag stripping", () => {
	// Expected values are what the former /<[^>]*>/g produced, written out.
	it.each([
		["a<b>c", "ac"],
		["a<b>c<d>e", "ace"],
		["<<a>b", "b"],
		["a<b", "a<b"],
		["a<b<c", "a<b<c"],
		["a<b>c<d", "ac<d"],
		["<>x", "x"],
		["x<>", "x"],
		["a>b", "a>b"],
		["a<b\nc>d", "ad"],
	])("sanitizeTitle(%j) is %j", (raw, expected) => {
		expect(sanitizeTitle(raw)).toBe(expected);
	});

	// Wrong implementation: /<[^>]*>/g over the raw title, which rescans every suffix of a run
	// of "<" with no ">" after it: about 8 s at this size, against a few milliseconds linear.
	it("stays linear on a title of only '<' (a host controls its length)", () => {
		const hostile = "<".repeat(131072);
		const start = performance.now();
		const result = sanitizeTitle(hostile);
		const elapsed = performance.now() - start;
		expect(result).toBe("<".repeat(256));
		expect(elapsed).toBeLessThan(1000);
	});

	it("stays linear on many '<' closed only at the very end", () => {
		const hostile = `${"<".repeat(131072)}>`;
		const start = performance.now();
		const result = sanitizeTitle(hostile);
		const elapsed = performance.now() - start;
		expect(result).toBe("");
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("truncateTitle", () => {
	it("passes through title shorter than maxLength", () => {
		expect(truncateTitle("short", 20)).toBe("short");
	});

	it("passes through title exactly at maxLength", () => {
		expect(truncateTitle("exact", 5)).toBe("exact");
	});

	it("truncates at 'end' with correct ellipsis placement", () => {
		const result = truncateTitle("vim: src/components/very-long-name.vue", 25, "end");
		expect(result).toHaveLength(25);
		expect(result).toBe("vim: src/components/very\u2026");
	});

	it("truncates at 'middle' with correct split", () => {
		const result = truncateTitle("vim: src/components/very-long-component-name.vue", 25, "middle");
		expect(result).toHaveLength(25);
		// left = ceil(24/2) = 12, right = floor(24/2) = 12
		expect(result).toBe("vim: src/com\u2026ent-name.vue");
	});

	it("truncates at 'start' with correct ellipsis placement", () => {
		const result = truncateTitle("vim: src/components/very-long-name.vue", 25, "start");
		expect(result).toHaveLength(25);
		expect(result).toBe("\u2026nents/very-long-name.vue");
	});

	it("returns empty string for empty title", () => {
		expect(truncateTitle("", 10)).toBe("");
	});

	it("returns just ellipsis for maxLength of 1", () => {
		expect(truncateTitle("something", 1)).toBe("\u2026");
	});

	it("preserves Unicode characters during truncation", () => {
		const title = "\u6587\u5b57\u5316\u3051\u3057\u305f\u30bf\u30a4\u30c8\u30eb";
		const result = truncateTitle(title, 5, "end");
		expect(result).toHaveLength(5);
		expect(result).toBe("\u6587\u5b57\u5316\u3051\u2026");
	});

	it("defaults position to 'end'", () => {
		const explicit = truncateTitle("a long title here", 10, "end");
		const implicit = truncateTitle("a long title here", 10);
		expect(implicit).toBe(explicit);
	});

	it("returns empty string for maxLength of 0", () => {
		expect(truncateTitle("something", 0)).toBe("");
	});

	it("handles middle truncation with odd maxLength", () => {
		// maxLength=6 → left=ceil(5/2)=3, right=floor(5/2)=2
		const result = truncateTitle("abcdefghij", 6, "middle");
		expect(result).toHaveLength(6);
		expect(result).toBe("abc\u2026ij");
	});
	// Surrogate pairs: the bound stays in UTF-16 units, a cut inside a pair moves inward.
	it("does not keep half a surrogate pair when cutting at 'end'", () => {
		const result = truncateTitle("abcdefghij\u{1F600}X", 12, "end");
		expect(result).toBe("abcdefghij…");
		expect(isWellFormed(result)).toBe(true);
	});

	it("does not keep half a surrogate pair when cutting at 'start'", () => {
		const result = truncateTitle("a\u{1F600}abcdefghij", 12, "start");
		expect(result).toBe("…abcdefghij");
		expect(isWellFormed(result)).toBe(true);
	});

	it("does not keep half a surrogate pair when cutting at 'middle'", () => {
		const result = truncateTitle("abcde\u{1F600}fghijkl", 12, "middle");
		expect(result).toBe("abcde…hijkl");
		expect(isWellFormed(result)).toBe(true);
	});

	it("keeps a whole pair that fits", () => {
		expect(truncateTitle("abcdefghi\u{1F600}XY", 12, "end")).toBe("abcdefghi\u{1F600}…");
		expect(truncateTitle("XYabcdefghi\u{1F600}", 12, "start")).toBe("…abcdefghi\u{1F600}");
		expect(truncateTitle("abcd\u{1F600}efghijkl", 12, "middle")).toBe("abcd\u{1F600}…hijkl");
	});

	it("never exceeds maxLength nor leaves a lone surrogate, at every length and position", () => {
		const title = "\u{1F600}a\u{1F600}\u{1F600}bc\u{1F600}d\u{1F600}\u{1F600}\u{1F600}e";
		for (const position of ["end", "middle", "start"] as const) {
			for (let max = 2; max < title.length; max++) {
				const result = truncateTitle(title, max, position);
				expect(result.length).toBeLessThanOrEqual(max);
				expect(isWellFormed(result)).toBe(true);
			}
		}
	});
});

describe("truncateTitle fractional maxLength", () => {
	// Wrong implementation: no floor on entry, so slice(0, 5.5 - 1) and the tail's 5.5 - 1
	// count each round up and the result is 6 units, over 5.5.
	it.each([
		["start", "…ghij"],
		["end", "abcd…"],
		["middle", "ab…ij"],
	] as const)("%s keeps to floor(5.5) = 5 units", (position, expected) => {
		const out = truncateTitle("abcdefghij", 5.5, position);
		expect(out).toBe(expected);
		expect(out.length).toBeLessThanOrEqual(5);
	});

	it("returns the title when it fits the fractional bound", () => {
		expect(truncateTitle("abcde", 5.5)).toBe("abcde");
	});

	it("a bound between 1 and 2 is the ellipsis alone", () => {
		expect(truncateTitle("abc", 1.5)).toBe("…");
	});
});
