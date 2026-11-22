// AC-PLAYER-PARSE (#80). New file: the parser is new and no existing spec reads casts.
import { describe, expect, it } from "vitest";
import { parseCast, parseCastChunks } from "./cast-parse.js";

const NOT_A_CAST = "Not an asciicast v2 or v3 file";

const V3 = [
	'{"version":3,"term":{"cols":80,"rows":24},"title":"t"}',
	'[0.000, "o", "hello"]',
	'[0.500, "r", "100x30"]',
	'[0.250, "m", "mark"]',
	'[1.000, "o", "\\r\\nbye"]',
].join("\n");

const V2 = [
	'{"version":2,"width":80,"height":24}',
	'[0.0, "o", "hello"]',
	'[0.5, "r", "100x30"]',
	'[0.75, "m", "mark"]',
	'[1.75, "o", "\\r\\nbye"]',
].join("\n");

const LITERAL = [
	{ d: 0, c: "o", t: "hello" },
	{ d: 0.5, c: "r", t: "100x30" },
	{ d: 0.25, c: "m", t: "mark" },
	{ d: 1, c: "o", t: "\r\nbye" },
];

describe("parseCast", () => {
	// Mutation caught: v2 times taken as delays.
	it("reads v3 and the same recording in v2 as the same events", () => {
		const v3 = parseCast(V3);
		const v2 = parseCast(V2);
		expect(v3).toMatchObject({ cols: 80, rows: 24, title: "t", events: LITERAL });
		expect(v2).toMatchObject({ cols: 80, rows: 24, events: LITERAL });
	});

	// Mutations caught: `i` played as output; a file refused for an `i`; a skipped delay lost.
	it("skips input and unknown codes, carrying their delays", () => {
		const v3 = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0,"o","A"]',
			'[1,"i","x"]',
			'[1,"q","?"]',
			'[1,"o","B"]',
		];
		const v2 = [
			'{"version":2,"width":80,"height":24}',
			'[0,"o","A"]',
			'[1,"i","x"]',
			'[2,"q","?"]',
			'[3,"o","B"]',
		];
		const expected = [
			{ d: 0, c: "o", t: "A" },
			{ d: 3, c: "o", t: "B" },
		];
		expect(parseCast(v3.join("\n"))).toMatchObject({ events: expected });
		expect(parseCast(v2.join("\n"))).toMatchObject({ events: expected });
	});

	it("skips comments and blank lines, and reads an exit", () => {
		const text = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			"# a comment",
			"",
			'[0.75, "x", "3"]',
		].join("\n");
		expect(parseCast(text)).toMatchObject({ events: [{ d: 0.75, c: "x", t: "3" }] });
	});

	// Mutation caught: the next delay counted from the highest time instead of the previous one.
	it("takes a decreasing v2 time as a delay of 0, and counts the next from it", () => {
		const text = [
			'{"version":2,"width":80,"height":24}',
			'[2,"o","a"]',
			'[1,"o","b"]',
			'[1.5,"o","c"]',
		].join("\n");
		expect(parseCast(text)).toMatchObject({
			events: [
				{ d: 2, c: "o", t: "a" },
				{ d: 0, c: "o", t: "b" },
				{ d: 0.5, c: "o", t: "c" },
			],
		});
	});

	// The file read in chunks gives the same events, a line split between chunks included.
	// Mutation caught: the source read to its end after the cast is already unreadable.
	it("stops reading once the cast is unreadable", async () => {
		let pulled = 0;
		async function* chunks(): AsyncGenerator<string> {
			for (const text of ["not a header\n", '[0, "o", "a"]\n', '[0, "o", "b"]\n']) {
				pulled++;
				yield text;
			}
		}
		expect(await parseCastChunks(chunks())).toEqual({ error: "Not an asciicast v2 or v3 file" });
		expect(pulled).toBe(1);
	});

	it("reads a cast in chunks cut anywhere", async () => {
		async function* chunks(): AsyncGenerator<string> {
			for (let i = 0; i < V3.length; i += 7) yield V3.slice(i, i + 7);
		}
		expect(await parseCastChunks(chunks())).toMatchObject({ events: LITERAL });
	});

	it.each([
		["a malformed line", '{"version":3,"term":{"cols":80,"rows":24}}\n[0, "o"'],
		["a bad r value", '{"version":3,"term":{"cols":80,"rows":24}}\n[0, "r", "wide"]'],
		["an r over 500 rows", '{"version":3,"term":{"cols":80,"rows":24}}\n[0, "r", "80x501"]'],
		["a header over 500 columns", '{"version":3,"term":{"cols":501,"rows":24}}'],
		["no header", '[0, "o", "x"]'],
		["another version", '{"version":1,"width":80,"height":24}'],
		["a fourth element", '{"version":3,"term":{"cols":80,"rows":24}}\n[0, "o", "x", "extra"]'],
		["a negative v3 delay", '{"version":3,"term":{"cols":80,"rows":24}}\n[-1, "o", "x"]'],
		["data that is not a string", '{"version":3,"term":{"cols":80,"rows":24}}\n[0, "o", 123]'],
	])("refuses %s", (_label, text) => {
		expect(parseCast(text)).toEqual({ error: NOT_A_CAST });
	});
});
