import { describe, expect, it } from "vitest";
import { channelsOnScreen, displayedChannelIds, pickableChannels } from "./displayedChannels.js";
import type { PaneNode } from "./usePaneTree.js";

const terminal = (channelId: string): PaneNode => ({ type: "terminal", channelId }) as PaneNode;
const vacant = (id: string): PaneNode => ({ type: "vacant", id }) as PaneNode;
const split = (first: PaneNode, second: PaneNode): PaneNode =>
	({ type: "split", direction: "vertical", ratio: 0.5, first, second }) as PaneNode;

describe("displayedChannelIds", () => {
	it("collects every channel a pane shows, across tabs", () => {
		const ids = displayedChannelIds({
			"tab-1": split(terminal("a"), vacant("v1")),
			"tab-2": terminal("b"),
			"tab-3": null,
		});
		expect([...ids].sort()).toEqual(["a", "b"]);
	});
});

// Where an overlay follows "Always do this" clicked on another one (#586).
describe("channelsOnScreen", () => {
	const layouts = {
		"tab-1": split(terminal("a"), split(vacant("v1"), terminal("b"))),
		"tab-2": terminal("c"),
		"tab-3": null,
	};

	it("is every pane of the tab shown, and none of the others", () => {
		expect([...channelsOnScreen(layouts, "tab-1")].sort()).toEqual(["a", "b"]);
		expect([...channelsOnScreen(layouts, "tab-2")]).toEqual(["c"]);
	});

	it("is nothing without a tab shown, or with an empty one", () => {
		expect(channelsOnScreen(layouts, null).size).toBe(0);
		expect(channelsOnScreen(layouts, "tab-3").size).toBe(0);
		expect(channelsOnScreen(layouts, "closed").size).toBe(0);
	});
});

describe("pickableChannels (UX-01 EFF-03)", () => {
	const channels = [
		{ id: "shown", status: "live" },
		{ id: "detached", status: "live" },
		{ id: "dead", status: "dead" },
		{ id: "other-host", status: "live" },
	];
	const host = new Map([
		["shown", "h1"],
		["detached", "h1"],
		["dead", "h1"],
		["other-host", "h2"],
	]);

	it("offers only the live, detached channels of the pane's host", () => {
		expect(pickableChannels(channels, host, "h1", new Set(["shown"])).map((c) => c.id)).toEqual([
			"detached",
		]);
	});

	it("offers nothing without a host", () => {
		expect(pickableChannels(channels, host, null, new Set())).toEqual([]);
	});
});
