import { describe, expect, it } from "vitest";
import { churnBetterSqlite3 } from "../../../../scripts/better-sqlite3-gc-churn.js";

describe("better-sqlite3's addon", () => {
	// #883: better-sqlite3 wraps its Database and Statement in node::ObjectWrap. Compiled
	// against Node 24.19 headers or later, an ObjectWrap removes an environment cleanup hook in
	// its destructor, and when the garbage collector runs that destructor with no context
	// entered, any Node 24 before 24.22.0 aborts with `Assertion failed: (env) != nullptr`
	// (nodejs/node#65446), as ssh2's cipher binding did (#868). Node 24.22.0 keeps those hooks
	// in a registry of its own and survives it. The 12.11.1 prebuilt addon predates those
	// headers. One compiled here, by a missing prebuild, a rebuild from source or a bump to
	// prebuilds made with newer headers, aborts this churn under an older Node. Run it before
	// anything else when bumping better-sqlite3 or Node (docs/STORAGE.md § 2).
	//
	// It loads the addon better-sqlite3 finds itself, build/Release/better_sqlite3.node, under
	// the Node running the tests, as the hub run from source does. The executable embeds that
	// file from the install that builds it, with the Node that builds it, which CI takes from
	// .nvmrc as it does for this spec. That install is not this one, so
	// scripts/package-sea-hub.ts runs the same churn on the file it embeds before embedding it.
	// Mutation: point the churn at better-sqlite3 rebuilt with `node-gyp rebuild` and run it on
	// Node 24.21, and it aborts. The same addon survives it on 24.22.0.
	it("survives the garbage collector reclaiming statements and databases", async () => {
		const { stderr, ...result } = await churnBetterSqlite3();
		expect(result, stderr).toEqual({
			code: 0,
			signal: null,
			stdout: expect.stringMatching(
				/^addon .*[\\/]build[\\/]Release[\\/]better_sqlite3\.node\nsurvived\n$/,
			),
		});
	});
});
