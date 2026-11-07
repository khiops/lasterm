import { describe, expect, it } from "vitest";
import {
	betterSqlite3Prebuild,
	churnBetterSqlite3,
} from "../../../../scripts/better-sqlite3-gc-churn.js";

describe("better-sqlite3's addon", () => {
	// #883: an addon that wraps its objects in node::ObjectWrap, compiled against Node 24.19
	// headers or later, removes an environment cleanup hook in its destructor, and when the
	// garbage collector runs that destructor with no context entered, the process aborts with
	// `Assertion failed: (env) != nullptr` (nodejs/node#65446), as ssh2's cipher binding did
	// (#868). better-sqlite3 12 was such an addon, safe only while its prebuild predated those
	// headers. Since 13.0 it wraps its Database and Statement in Napi::ObjectWrap, over Node-API:
	// its prebuilds import napi_* functions only, no V8 or node:: symbol, so the abort no longer
	// applies, whatever headers built them. This churn stays as a cheap tripwire against a
	// regression back to an ObjectWrap build. Run it before anything else when bumping
	// better-sqlite3 or Node (docs/STORAGE.md § 2).
	//
	// It loads the addon better-sqlite3 finds itself, the prebuild its package ships for this
	// platform, under the Node running the tests, as the hub run from source does. The
	// executable embeds that file from the install that builds it, with the Node that builds it,
	// which CI takes from .nvmrc as it does for this spec. That install is not this one, so
	// scripts/package-sea-hub.ts runs the same churn on the file it embeds before embedding it.
	// Mutation: point the churn at better-sqlite3 12.11.1 rebuilt with `node-gyp rebuild` on
	// Node 24.21, and it aborts (#887).
	it("survives the garbage collector reclaiming statements and databases", async () => {
		const { stderr, ...result } = await churnBetterSqlite3();
		expect(result, stderr).toEqual({
			code: 0,
			signal: null,
			stdout: `addon ${betterSqlite3Prebuild()}\nsurvived\n`,
		});
	});
});
