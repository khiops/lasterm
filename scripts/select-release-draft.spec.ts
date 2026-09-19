import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// create-release runs this filter with the jq preinstalled on the runner; the
// spec runs it the same way, so what is tested is the file the workflow reads.
const FILTER = fileURLToPath(new URL("./select-release-draft.jq", import.meta.url));
const TAG = "v1.2.3";
const FROZEN = "a".repeat(40);
const OTHER = "b".repeat(40);

type Selection =
	| { keep: number | null; delete: number[] }
	| { error: string; drafts: { id: number; target_commitish: string }[] };

function select(releases: unknown[], tagged = false): Selection {
	const result = spawnSync(
		"jq",
		[
			"-c",
			"--arg",
			"tag",
			TAG,
			"--arg",
			"sha",
			FROZEN,
			"--arg",
			"tagged",
			String(tagged),
			"-f",
			FILTER,
		],
		{ input: JSON.stringify(releases), encoding: "utf8" },
	);
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as Selection;
}

function draft(id: number, target: string, tag = TAG) {
	return { id, tag_name: tag, draft: true, target_commitish: target };
}

describe("select-release-draft.jq", () => {
	it("asks for a new draft when the tag has none", () => {
		expect(select([draft(1, FROZEN, "v1.2.2"), { id: 2, tag_name: TAG, draft: false }])).toEqual({
			keep: null,
			delete: [],
		});
	});

	it("keeps the draft that targets the frozen commit, even when another is listed first", () => {
		// #270: the old loop kept id 7 because the API listed it first, deleted
		// the correctly aimed id 9, then failed its own target check.
		expect(select([draft(7, OTHER), draft(9, FROZEN)])).toEqual({ keep: 9, delete: [7] });
	});

	it("keeps the oldest of several drafts aimed at the frozen commit, whatever the order", () => {
		expect(select([draft(12, FROZEN), draft(5, OTHER), draft(4, FROZEN)])).toEqual({
			keep: 4,
			delete: [12, 5],
		});
	});

	it("refuses, deleting nothing, when no draft targets the frozen commit", () => {
		const selection = select([draft(7, OTHER), draft(8, "main")]);
		expect(selection).toMatchObject({
			drafts: [
				{ id: 7, target_commitish: OTHER },
				{ id: 8, target_commitish: "main" },
			],
		});
		expect("error" in selection && selection.error).toMatch(/refusing to pick one by position/);
		expect("delete" in selection).toBe(false);
	});

	it("keeps a lone draft for a tag that already exists, whatever it targets", () => {
		// A published release turned back into a draft to rebuild it: the tag,
		// already checked against the frozen commit, is what binds it.
		expect(select([draft(3, OTHER)], true)).toEqual({ keep: 3, delete: [] });
	});

	it("refuses several drafts for an existing tag when none targets the frozen commit", () => {
		expect(select([draft(3, OTHER), draft(4, "main")], true)).toHaveProperty("error");
	});
});
