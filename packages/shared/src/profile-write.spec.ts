import { describe, expect, it } from "vitest";
import { planProfileWrite } from "./profile-write.js";

// The scoped write (#835): a terminal-profile key set for a host or globally,
// and the overrides nearer to one terminal dropped so that it holds there.
// The hub's own spec (`api/file-transfer-config.spec.ts`) makes these plans
// against the real routes and reads the terminal's resolved value back.

const target = { hostId: "h1", channelId: "c1" };

describe("planProfileWrite", () => {
	it("for a host: sets the host's profile, then drops the terminal's own", () => {
		const plan = planProfileWrite("transferOnConflict", "skip", "host", target);
		expect(plan?.requests).toEqual([
			{
				method: "PATCH",
				path: "/api/hosts/h1/profile",
				body: { profile: { transferOnConflict: "skip" } },
			},
			{
				method: "PATCH",
				path: "/api/channels/c1/profile",
				body: { profile: { transferOnConflict: null } },
			},
		]);
	});

	it("globally: sets config.toml, then drops the host's and the terminal's", () => {
		const plan = planProfileWrite("transferOnConflict", "skip", "global", target);
		expect(plan?.requests).toEqual([
			{
				method: "PUT",
				path: "/api/config/global",
				body: { terminal: { transferOnConflict: "skip" } },
			},
			{
				method: "PATCH",
				path: "/api/hosts/h1/profile",
				body: { profile: { transferOnConflict: null } },
			},
			{
				method: "PATCH",
				path: "/api/channels/c1/profile",
				body: { profile: { transferOnConflict: null } },
			},
		]);
	});

	it("says which overrides it drops, from the layers given, nearest last", () => {
		const layers = {
			host: { transferOnConflict: "replace" as const, fontSize: 12 },
			channel: { transferOnConflict: "keep_both" as const },
		};
		expect(
			planProfileWrite("transferOnConflict", "ask", "global", target, layers)?.dropped,
		).toEqual([
			{ scope: "host", value: "replace" },
			{ scope: "channel", value: "keep_both" },
		]);
		expect(planProfileWrite("transferOnConflict", "ask", "host", target, layers)?.dropped).toEqual([
			{ scope: "channel", value: "keep_both" },
		]);
		// The host's own value is the one a host write replaces, not one it drops.
		expect(
			planProfileWrite("transferOnConflict", "ask", "host", target, { host: layers.host })?.dropped,
		).toEqual([]);
	});

	it("drops whatever the layers say, so that an override made since goes too", () => {
		const plan = planProfileWrite("transferDrop", "off", "global", target, {});
		expect(plan?.dropped).toEqual([]);
		expect(plan?.requests).toHaveLength(3);
	});

	it("asks nothing of the terminal for a key it never holds", () => {
		for (const key of ["transferFallbackDir", "transferVerify"] as const) {
			const plan = planProfileWrite(
				key,
				key === "transferVerify" ? false : "/srv",
				"global",
				target,
				{
					channel: { [key]: "stray" },
				},
			);
			expect(plan?.requests.map((r) => r.path)).toEqual([
				"/api/config/global",
				"/api/hosts/h1/profile",
			]);
			expect(plan?.dropped).toEqual([]);
		}
	});

	it("without a terminal, drops nothing of one; without a host, writes nothing for a host", () => {
		const noChannel = { hostId: "h1", channelId: null };
		expect(planProfileWrite("whenEnded", "close", "host", noChannel)?.requests).toHaveLength(1);
		expect(planProfileWrite("whenEnded", "close", "global", noChannel)?.requests).toHaveLength(2);
		const noHost = { hostId: null, channelId: "c1" };
		expect(planProfileWrite("whenEnded", "close", "host", noHost)).toBeNull();
		expect(
			planProfileWrite("whenEnded", "close", "global", noHost)?.requests.map((r) => r.path),
		).toEqual(["/api/config/global", "/api/channels/c1/profile"]);
	});

	it("escapes the ids in the paths", () => {
		const plan = planProfileWrite("whenEnded", "close", "host", {
			hostId: "a/b",
			channelId: "c d",
		});
		expect(plan?.requests.map((r) => r.path)).toEqual([
			"/api/hosts/a%2Fb/profile",
			"/api/channels/c%20d/profile",
		]);
	});
});
