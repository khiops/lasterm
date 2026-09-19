import { describe, expect, it } from "vitest";
import { displayedChannelIds, pickableChannels } from "./displayedChannels.js";
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
