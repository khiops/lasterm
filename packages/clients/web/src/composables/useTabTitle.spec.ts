import type { Channel } from "@lasterm/shared";
import { DEFAULT_CHANNEL_NAME } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { useTabTitle } from "./useTabTitle.js";

/** Helper to build a minimal Channel for testing. */
function makeChannel(overrides: Partial<Channel> & { id: string }): Channel {
	return {
		sessionId: "sess-1",
		shell: "/bin/bash",
		cols: 80,
		rows: 24,
		status: "live",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("useTabTitle", () => {
	// The hub pre-computes channel.displayTitle from the configured source.
	// The client uses it directly. The only client-side override is
	// liveDynamicTitle (xterm.js OSC 0/2) for source=dynamic — optimistic UI.

	// ── Base: hub-provided displayTitle ───────────────────────────────

	it("returns DEFAULT_CHANNEL_NAME when channelId is null", () => {
		const channelId = ref<string | null>(null);
		const channels = ref<Channel[]>([]);
		const { tabTitle, isCustom, isDynamic } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe(DEFAULT_CHANNEL_NAME);
		expect(isCustom.value).toBe(false);
		expect(isDynamic.value).toBe(false);
	});

	it("returns DEFAULT_CHANNEL_NAME when channel has no displayTitle", () => {
		const ch = makeChannel({ id: "ch-1" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe(DEFAULT_CHANNEL_NAME);
	});

	it("returns displayTitle when set by hub", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "vim file.ts" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe("vim file.ts");
	});

	it("isCustom reflects channel.title (F2 rename flag)", () => {
		const ch = makeChannel({ id: "ch-1", title: "My Server", displayTitle: "My Server" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { isCustom, isDynamic } = useTabTitle(channelId, channels);

		expect(isCustom.value).toBe(true);
		expect(isDynamic.value).toBe(false);
	});

	it("isDynamic reflects channel.dynamicTitle presence", () => {
		const ch = makeChannel({
			id: "ch-1",
			dynamicTitle: "vim file.ts",
			displayTitle: "vim file.ts",
		});
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { isCustom, isDynamic } = useTabTitle(channelId, channels);

		expect(isCustom.value).toBe(false);
		expect(isDynamic.value).toBe(true);
	});

	// ── liveDynamicTitle: optimistic override for source=dynamic ──────

	it("liveDynamicTitle overrides displayTitle when source=dynamic (default)", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "old title", dynamicTitle: "old title" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const live = ref<string | null>("nano README.md");

		const { tabTitle, isDynamic } = useTabTitle(channelId, channels, live);

		expect(tabTitle.value).toBe("nano README.md");
		expect(isDynamic.value).toBe(true);
	});

	it("falls back to displayTitle when liveDynamicTitle is null", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "hub title", dynamicTitle: "hub title" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const live = ref<string | null>(null);

		const { tabTitle } = useTabTitle(channelId, channels, live);

		expect(tabTitle.value).toBe("hub title");
	});

	it("liveDynamicTitle does NOT override when source=process", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "vim", processTitle: "vim" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const live = ref<string | null>("live OSC title");

		const { tabTitle } = useTabTitle(channelId, channels, live, {
			titleConfig: { source: "process" },
		});

		// source=process: liveDynamicTitle ignored, use displayTitle from hub
		expect(tabTitle.value).toBe("vim");
	});

	it("liveDynamicTitle does NOT override when source=static", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "My Terminal" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const live = ref<string | null>("live OSC title");

		const { tabTitle } = useTabTitle(channelId, channels, live, {
			titleConfig: { source: "static", staticTitle: "My Terminal" },
		});

		// source=static: liveDynamicTitle ignored, use displayTitle from hub
		expect(tabTitle.value).toBe("My Terminal");
	});

	// ── Reactivity ─────────────────────────────────────────────────────

	it("updates when channel.displayTitle changes (TITLE_CHANGE broadcast)", () => {
		const ch = makeChannel({ id: "ch-1" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe(DEFAULT_CHANNEL_NAME);

		// Simulate hub broadcasting displayTitle after TITLE_CHANGE
		channels.value = [makeChannel({ id: "ch-1", displayTitle: "bash — ~/projects" })];
		expect(tabTitle.value).toBe("bash — ~/projects");
	});

	it("updates when channelId changes", () => {
		const ch1 = makeChannel({ id: "ch-1", displayTitle: "title-1" });
		const ch2 = makeChannel({ id: "ch-2", displayTitle: "title-2" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch1, ch2]);
		const { tabTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe("title-1");

		channelId.value = "ch-2";
		expect(tabTitle.value).toBe("title-2");
	});

	// ── ATTACH_OK restore ──────────────────────────────────────────────

	it("title from ATTACH_OK restores on reconnect (displayTitle in store)", () => {
		// Simulates: ATTACH_OK sets channel.displayTitle → useTabTitle picks it up
		const ch = makeChannel({ id: "ch-1" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe(DEFAULT_CHANNEL_NAME);

		// Simulate ATTACH_OK setting displayTitle
		channels.value = [makeChannel({ id: "ch-1", displayTitle: "restored title" })];
		expect(tabTitle.value).toBe("restored title");
	});

	// ── Edge cases ─────────────────────────────────────────────────────

	it("returns DEFAULT_CHANNEL_NAME when channel not found in list", () => {
		const channelId = ref<string | null>("missing");
		const channels = ref<Channel[]>([]);
		const { tabTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe(DEFAULT_CHANNEL_NAME);
	});

	// ── Truncation ────────────────────────────────────────────────────

	it("truncates displayTitle exceeding maxLength", () => {
		const longTitle = "a".repeat(60);
		const ch = makeChannel({ id: "ch-1", displayTitle: longTitle });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels, undefined, {
			maxLength: 20,
		});

		expect(tabTitle.value).toHaveLength(20);
		expect(tabTitle.value).toBe(`${"a".repeat(19)}\u2026`);
	});

	it("does not truncate short displayTitle", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "short" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels, undefined, {
			maxLength: 20,
		});

		expect(tabTitle.value).toBe("short");
	});

	it("truncates using configured position", () => {
		const longTitle = "abcdefghijklmnopqrstuvwxyz";
		const ch = makeChannel({ id: "ch-1", displayTitle: longTitle });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle } = useTabTitle(channelId, channels, undefined, {
			maxLength: 10,
			truncationPosition: "start",
		});

		expect(tabTitle.value).toHaveLength(10);
		expect(tabTitle.value).toBe("\u2026rstuvwxyz");
	});

	// ── Prefix ────────────────────────────────────────────────────────

	it("prepends prefix to tab title", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "htop" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const prefix = ref("PROD ");
		const { tabTitle } = useTabTitle(channelId, channels, undefined, { prefix });

		expect(tabTitle.value).toBe("PROD htop");
	});

	it("prefix counts toward truncation limit", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "abcdefghij" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const prefix = ref("PROD ");
		const { tabTitle } = useTabTitle(channelId, channels, undefined, {
			prefix,
			maxLength: 10,
		});

		// "PROD abcdefghij" = 15 chars → truncated to 10
		expect(tabTitle.value).toHaveLength(10);
		expect(tabTitle.value).toBe("PROD abcd\u2026");
	});

	it("resolvedTitle does NOT include prefix", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "vim" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const prefix = ref("DEV ");
		const { tabTitle, resolvedTitle } = useTabTitle(channelId, channels, undefined, { prefix });

		expect(resolvedTitle.value).toBe("vim");
		expect(tabTitle.value).toBe("DEV vim");
	});

	it("no prefix option → tabTitle equals displayTitle", () => {
		const ch = makeChannel({ id: "ch-1", displayTitle: "bash" });
		const channelId = ref<string | null>("ch-1");
		const channels = ref<Channel[]>([ch]);
		const { tabTitle, resolvedTitle } = useTabTitle(channelId, channels);

		expect(tabTitle.value).toBe("bash");
		expect(resolvedTitle.value).toBe("bash");
	});

	// ── TitleConfig: truncation settings ─────────────────────────────

	describe("titleConfig truncation", () => {
		it("titleConfig.maxLength overrides options.maxLength", () => {
			const longTitle = "a".repeat(40);
			const ch = makeChannel({ id: "ch-1", displayTitle: longTitle });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const { tabTitle } = useTabTitle(channelId, channels, undefined, {
				maxLength: 50, // would allow full title
				titleConfig: { maxLength: 15 }, // overrides to shorter
			});

			expect(tabTitle.value).toHaveLength(15);
			expect(tabTitle.value).toBe(`${"a".repeat(14)}\u2026`);
		});

		it("titleConfig.truncation overrides options.truncationPosition", () => {
			const longTitle = "abcdefghijklmnopqrstuvwxyz";
			const ch = makeChannel({ id: "ch-1", displayTitle: longTitle });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const { tabTitle } = useTabTitle(channelId, channels, undefined, {
				maxLength: 10,
				truncationPosition: "end", // would be overridden
				titleConfig: { truncation: "start" },
			});

			expect(tabTitle.value).toHaveLength(10);
			expect(tabTitle.value).toBe("\u2026rstuvwxyz");
		});
	});

	// ── TitleConfig: source controls liveDynamicTitle gating ────────

	describe("titleConfig source (liveDynamicTitle gating)", () => {
		it("source = 'dynamic' (default): liveDynamicTitle overrides displayTitle", () => {
			const ch = makeChannel({ id: "ch-1", displayTitle: "hub-title", dynamicTitle: "hub-title" });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const live = ref<string | null>("live-title");
			const { tabTitle } = useTabTitle(channelId, channels, live, {
				titleConfig: { source: "dynamic" },
			});

			expect(tabTitle.value).toBe("live-title");
		});

		it("source = 'dynamic' (default): displayTitle used when no liveDynamicTitle", () => {
			const ch = makeChannel({ id: "ch-1", displayTitle: "hub-title", dynamicTitle: "hub-title" });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const { tabTitle } = useTabTitle(channelId, channels, undefined, {
				titleConfig: { source: "dynamic" },
			});

			expect(tabTitle.value).toBe("hub-title");
		});

		it("source = 'process': liveDynamicTitle ignored, displayTitle used", () => {
			const ch = makeChannel({ id: "ch-1", displayTitle: "vim", processTitle: "vim" });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const live = ref<string | null>("live-osc");
			const { tabTitle } = useTabTitle(channelId, channels, live, {
				titleConfig: { source: "process" },
			});

			expect(tabTitle.value).toBe("vim");
		});

		it("source = 'static': liveDynamicTitle ignored, displayTitle used", () => {
			const ch = makeChannel({ id: "ch-1", displayTitle: "My Terminal" });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const live = ref<string | null>("live-osc");
			const { tabTitle } = useTabTitle(channelId, channels, live, {
				titleConfig: { source: "static" },
			});

			expect(tabTitle.value).toBe("My Terminal");
		});

		it("isCustom reflects channel.title (hub still provides displayTitle)", () => {
			const ch = makeChannel({ id: "ch-1", title: "Custom", displayTitle: "Custom" });
			const channelId = ref<string | null>("ch-1");
			const channels = ref<Channel[]>([ch]);
			const { tabTitle, isCustom } = useTabTitle(channelId, channels, undefined, {
				titleConfig: { source: "dynamic" },
			});

			expect(tabTitle.value).toBe("Custom");
			expect(isCustom.value).toBe(true);
		});
	});
});
