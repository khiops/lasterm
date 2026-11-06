import { type FontFamily, planProfileWrite } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlwaysChoice } from "../utils/exit-action.js";

const mocks = vi.hoisted(() => ({
	domPublicAssetUrl: vi.fn<(path: string) => Promise<string>>(),
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../utils/hub-url.js", () => ({
	domPublicAssetUrl: mocks.domPublicAssetUrl,
	hubBaseUrl: () => "",
}));

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { injectFontFaces, useConfigStore } from "./config.js";

const oldFace: FontFamily[] = [
	{
		family: "Old Working Font",
		files: [{ url: "/public/fonts/old.woff2", weight: 400, style: "normal" }],
	},
];

const partiallyResolvableFaces: FontFamily[] = [
	{
		family: "Replacement Font",
		files: [
			{ url: "/public/fonts/working.woff2", weight: 400, style: "normal" },
			{ url: "/public/fonts/broken.woff2", weight: 700, style: "normal" },
		],
	},
];

describe("injectFontFaces", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		mocks.domPublicAssetUrl.mockReset();
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a working face applied when another face cannot be resolved", async () => {
		mocks.domPublicAssetUrl.mockResolvedValueOnce("blob:old-working-font");
		await injectFontFaces(oldFace);
		const previousStyle = document.getElementById("lasterm-fonts");
		if (!previousStyle) throw new Error("expected the existing font style");
		const removePreviousStyle = vi.spyOn(previousStyle, "remove");

		mocks.domPublicAssetUrl.mockImplementation(async (path) => {
			if (path.endsWith("working.woff2")) return "blob:replacement-working-font";
			throw new Error("font file is unavailable");
		});
		await injectFontFaces(partiallyResolvableFaces);

		const style = document.getElementById("lasterm-fonts");
		expect(style).not.toBeNull();
		expect(style).not.toBe(previousStyle);
		expect(style?.textContent).toContain('url("blob:replacement-working-font")');
		expect(style?.textContent).not.toContain("broken.woff2");
		expect(document.head.contains(previousStyle)).toBe(false);
		expect(removePreviousStyle).not.toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old-working-font");
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("failed to resolve custom font Replacement Font"),
			expect.any(Error),
		);
	});
});

// The old "don't ask again" about deleting an ended terminal is carried
// over to the UI config (#574).
describe("saveUiSettings", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mocks.hubFetch.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes the values to the UI config, and takes them at once", async () => {
		mocks.hubFetch.mockResolvedValue(new Response("{}", { status: 200 }));
		const store = useConfigStore();
		store.uiConfig = {
			onChannelDead: "readonly",
			layout: {
				hostRailColumns: 2,
				hostRailBadgeSize: "medium",
				sidebarWidth: 200,
				transferPanelWidth: 300,
			},
		};

		const saving = store.saveUiSettings("layout", { hostRailBadgeSize: "large" });
		// Acted on before the hub answers.
		expect(store.uiConfig.layout).toEqual({
			hostRailColumns: 2,
			hostRailBadgeSize: "large",
			sidebarWidth: 200,
			transferPanelWidth: 300,
		});
		await expect(saving).resolves.toBe(true);

		expect(mocks.hubFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mocks.hubFetch.mock.calls[0] ?? [];
		expect(url).toBe("/api/config/ui");
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual({
			layout: { hostRailBadgeSize: "large" },
		});
	});

	it("reads back what the hub holds when it refuses the write", async () => {
		mocks.hubFetch.mockResolvedValueOnce(new Response("{}", { status: 400 })).mockResolvedValueOnce(
			new Response(JSON.stringify({ onChannelDead: "readonly", keyboard: { keyHints: false } }), {
				status: 200,
			}),
		);
		const store = useConfigStore();

		await expect(store.saveUiSettings("keyboard", { keyHints: true })).resolves.toBe(false);
		expect(store.uiConfig.keyboard?.keyHints).toBe(false);
	});
});

// "Always do this" on an ended terminal's overlay writes "When a terminal
// ends" for the host, or globally, and takes it off the layers nearer to that
// terminal so that it holds there (#574).
describe("saveWhenEnded", () => {
	const ok = (): Promise<Response> => Promise.resolve(new Response("{}", { status: 200 }));
	const where = { hostId: "h1", channelId: "c1" };

	function calls(): Array<{ method: string | undefined; url: string; body: unknown }> {
		return mocks.hubFetch.mock.calls.map(([url, init]) => ({
			method: init?.method,
			url,
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		}));
	}

	beforeEach(() => {
		setActivePinia(createPinia());
		mocks.hubFetch.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("for this host: sets the host, drops the terminal's own", async () => {
		mocks.hubFetch.mockImplementation(ok);
		const store = useConfigStore();
		const changes: unknown[] = [];
		store.onProfileChange((event) => changes.push(event));

		await expect(store.saveWhenEnded("restart", "host", where)).resolves.toBe(true);
		expect(calls()).toEqual([
			{
				method: "PATCH",
				url: "/api/hosts/h1/profile",
				body: { profile: { whenEnded: "restart" } },
			},
			{ method: "PATCH", url: "/api/channels/c1/profile", body: { profile: { whenEnded: null } } },
		]);
		expect(changes).toEqual([{ scope: "host", hostId: "h1", channelId: "c1" }]);
	});

	it("globally: sets it in config.toml, drops the host's and the terminal's", async () => {
		mocks.hubFetch.mockImplementation(ok);
		const store = useConfigStore();

		await expect(store.saveWhenEnded("close", "global", where)).resolves.toBe(true);
		expect(calls().slice(0, 3)).toEqual([
			{ method: "PUT", url: "/api/config/global", body: { terminal: { whenEnded: "close" } } },
			{ method: "PATCH", url: "/api/hosts/h1/profile", body: { profile: { whenEnded: null } } },
			{ method: "PATCH", url: "/api/channels/c1/profile", body: { profile: { whenEnded: null } } },
		]);
	});

	it("stops at a write the hub refuses, and says so", async () => {
		mocks.hubFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 400 })));
		const store = useConfigStore();

		await expect(store.saveWhenEnded("restart", "host", where)).resolves.toBe(false);
		expect(calls()).toHaveLength(1);
	});

	it("cannot set it for a host it does not know", async () => {
		const store = useConfigStore();
		await expect(
			store.saveWhenEnded("restart", "host", { hostId: null, channelId: "c1" }),
		).resolves.toBe(false);
		expect(mocks.hubFetch).not.toHaveBeenCalled();
	});
});

// The scoped write (#835), shared by "Always do this", the files panel's
// options (#836) and an upload's conflict step (#837): the plan comes from
// @lasterm/shared, whose hub spec makes it against the real routes; here, the
// client makes its requests and says what it dropped.
describe("saveProfileWrite and readProfileLayers", () => {
	const where = { hostId: "h1", channelId: "c1" };

	beforeEach(() => {
		setActivePinia(createPinia());
		mocks.hubFetch.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function json(body: unknown): Promise<Response> {
		return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
	}

	it("reads the terminal's layers, plans, and makes the plan's requests in order", async () => {
		mocks.hubFetch.mockImplementation((url) =>
			url.startsWith("/api/config/cascade")
				? json({
						terminal: {
							host: { transferOnConflict: "replace" },
							channel: { transferOnConflict: "keep_both" },
						},
					})
				: json({ ok: true }),
		);
		const store = useConfigStore();
		const changes: unknown[] = [];
		store.onProfileChange((event) => changes.push(event));

		const layers = await store.readProfileLayers(where);
		expect(mocks.hubFetch.mock.calls[0]?.[0]).toBe("/api/config/cascade?host_id=h1&channel_id=c1");
		const plan = planProfileWrite("transferOnConflict", "skip", "host", where, layers ?? {});
		// What a caller says before writing.
		expect(plan?.dropped).toEqual([{ scope: "channel", value: "keep_both" }]);

		mocks.hubFetch.mockClear();
		await expect(store.saveProfileWrite(plan as NonNullable<typeof plan>)).resolves.toBe(true);
		expect(
			mocks.hubFetch.mock.calls.map(([url, init]) => [
				init?.method,
				url,
				JSON.parse(String(init?.body)),
			]),
		).toEqual([
			["PATCH", "/api/hosts/h1/profile", { profile: { transferOnConflict: "skip" } }],
			["PATCH", "/api/channels/c1/profile", { profile: { transferOnConflict: null } }],
		]);
		expect(changes).toEqual([{ scope: "host", hostId: "h1", channelId: "c1" }]);
	});

	it("stops at the first request the hub refuses, and says so", async () => {
		mocks.hubFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 400 })));
		const store = useConfigStore();
		const plan = planProfileWrite("transferDrop", "bogus", "global", where);

		await expect(store.saveProfileWrite(plan as NonNullable<typeof plan>)).resolves.toBe(false);
		// The PUT, then the profile read again after a global write; no drop.
		expect(mocks.hubFetch.mock.calls.map(([url, init]) => [init?.method ?? "GET", url])).toEqual([
			["PUT", "/api/config/global"],
			["GET", "/api/config/cascade"],
		]);
	});

	it("reads no layers from a hub that cannot answer", async () => {
		mocks.hubFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 500 })));
		await expect(useConfigStore().readProfileLayers(where)).resolves.toBeNull();
	});
});

// The one check file transfer's parts make (#835): off until the UI config
// says `[experimental] file_transfer = true`.
describe("fileTransferEnabled", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it("is off until the UI config turns it on, and follows it", () => {
		const store = useConfigStore();
		expect(store.fileTransferEnabled).toBe(false);
		store.uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
		expect(store.fileTransferEnabled).toBe(true);
		store.uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: false } };
		expect(store.fileTransferEnabled).toBe(false);
	});
});

// The overlays already waiting in this window follow "Always do this" clicked
// on another one (#586). They hear it from here, once it is written: nothing
// is kept, and nothing goes to the hub, so no other window hears it.
describe("saveWhenEnded tells this window's panes", () => {
	const ok = (): Promise<Response> => Promise.resolve(new Response("{}", { status: 200 }));

	beforeEach(() => {
		setActivePinia(createPinia());
		mocks.hubFetch.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("the choice, once written: what, where, on which terminal, and when it was clicked", async () => {
		mocks.hubFetch.mockImplementation(ok);
		vi.spyOn(performance, "now").mockReturnValue(1234);
		const store = useConfigStore();
		const heard: AlwaysChoice[] = [];
		store.onAlwaysChoice((choice) => heard.push(choice));

		const saving = store.saveWhenEnded("restart", "host", { hostId: "h1", channelId: "c1" });
		// Not before the hub has it.
		expect(heard).toEqual([]);
		await saving;
		expect(heard).toEqual([
			{ action: "restart", scope: "host", hostId: "h1", channelId: "c1", at: 1234 },
		]);

		await store.saveWhenEnded("close", "global", { hostId: "h2", channelId: "c2" });
		expect(heard[1]).toMatchObject({ action: "close", scope: "global", hostId: "h2" });
	});

	it("nothing when the hub refuses the write", async () => {
		mocks.hubFetch.mockImplementation(() => Promise.resolve(new Response("{}", { status: 400 })));
		const store = useConfigStore();
		const heard = vi.fn();
		store.onAlwaysChoice(heard);

		await store.saveWhenEnded("restart", "host", { hostId: "h1", channelId: "c1" });
		await store.saveWhenEnded("restart", "host", { hostId: null, channelId: "c1" });
		expect(heard).not.toHaveBeenCalled();
	});

	it("a pane that stopped listening hears nothing more", async () => {
		mocks.hubFetch.mockImplementation(ok);
		const store = useConfigStore();
		const heard = vi.fn();
		const stop = store.onAlwaysChoice(heard);
		stop();

		await store.saveWhenEnded("restart", "host", { hostId: "h1", channelId: "c1" });
		expect(heard).not.toHaveBeenCalled();
	});
});
