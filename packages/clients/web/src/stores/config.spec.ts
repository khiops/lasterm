import { type FontFamily, planProfileWrite } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlwaysChoice } from "../utils/exit-action.js";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { resetAssetHolderForTests } from "../utils/asset-holder.js";
import { setHubPortForTests } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { injectFontFaces, useConfigStore } from "./config.js";

/** Relayed font fetches by path, each answered when the test says so, or at once. */
function relayFonts(answers: Record<string, "ok" | "fail" | "hold"> = {}): {
	release: (path: string) => void;
} {
	const held = new Map<string, () => void>();
	mocks.hubFetch.mockImplementation((url) => {
		const path = new URL(url).pathname;
		const answer = answers[path] ?? "ok";
		if (answer === "fail") return Promise.reject(new Error("font file is unavailable"));
		const response = () => new Response("font-bytes", { status: 200 });
		if (answer === "ok") return Promise.resolve(response());
		return new Promise((resolve) => held.set(path, () => resolve(response())));
	});
	return { release: (path) => held.get(path)?.() };
}

const face = (family: string, ...files: string[]): FontFamily => ({
	family,
	files: files.map((file, index) => ({
		url: `/public/fonts/${encodeURIComponent(file)}`,
		weight: 400 + 300 * index,
		style: "normal",
	})),
});

describe("injectFontFaces, on the desktop (#194)", () => {
	let created: string[];
	let revoked: string[];

	beforeEach(async () => {
		document.head.innerHTML = "";
		setActivePinia(createPinia());
		useAuthStore().setToken("bearer-1");
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: () => undefined },
			configurable: true,
		});
		setHubPortForTests(4100);
		mocks.hubFetch.mockReset();
		created = [];
		revoked = [];
		let next = 0;
		vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
			const url = `blob:font/${++next}`;
			created.push(url);
			return url;
		});
		vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
			revoked.push(url);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// Leave nothing held by an earlier test's stylesheet.
		relayFonts();
		await injectFontFaces([]);
		created.length = 0;
		revoked.length = 0;
	});

	afterEach(() => {
		resetAssetHolderForTests();
		setHubPortForTests(null);
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		vi.restoreAllMocks();
	});

	it("relays each font path with the bearer and no asset token", async () => {
		relayFonts();

		await injectFontFaces([face("Hack", "a b%.woff2")]);

		const [url, init] = mocks.hubFetch.mock.calls[0] ?? [];
		expect(url).toBe("https://127.0.0.1:4100/public/fonts/a%20b%25.woff2");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bearer-1");
		expect(document.getElementById("lasterm-fonts")?.textContent).toContain('url("blob:font/1")');
	});

	it("gives back a dropped file once the new stylesheet is in, and keeps a file both sets use", async () => {
		relayFonts();
		await injectFontFaces([face("Hack", "kept.woff2", "dropped.woff2")]);
		const [kept, dropped] = created;
		// Whether the stylesheet still named a URL at the moment it was revoked.
		const stillUsed: boolean[] = [];
		vi.mocked(URL.revokeObjectURL).mockImplementation((url) => {
			revoked.push(url);
			stillUsed.push(document.getElementById("lasterm-fonts")?.textContent?.includes(url) ?? false);
		});

		await injectFontFaces([face("Hack", "kept.woff2")]);

		expect(stillUsed).toEqual([false]);
		expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
		expect(document.getElementById("lasterm-fonts")?.textContent).toContain(`url("${kept}")`);
		expect(revoked).toEqual([dropped]);
	});

	it("quotes a family name as a CSS string, so its own quotes cannot end the rule", async () => {
		relayFonts();

		await injectFontFaces([face('x";}body{display:none}x{font-family:"y', "evil.woff2")]);

		const sheet = document.getElementById("lasterm-fonts") as HTMLStyleElement;
		expect(sheet.textContent).toContain(
			'font-family: "x\\";}body{display:none}x{font-family:\\"y";',
		);
		expect(sheet.textContent?.match(/@font-face/g)).toHaveLength(1);
	});

	it("keeps the working set when every file of a refresh fails", async () => {
		relayFonts();
		await injectFontFaces([face("Hack", "old.woff2")]);
		const previous = document.getElementById("lasterm-fonts");

		relayFonts({ "/public/fonts/new.woff2": "fail" });
		await injectFontFaces([face("Other", "new.woff2")]);

		expect(document.getElementById("lasterm-fonts")).toBe(previous);
		expect(revoked).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("failed to resolve custom font Other"),
			expect.any(Error),
		);
	});

	it("applies only the later of two overlapping calls, and every URL is revoked exactly once in the end", async () => {
		const relay = relayFonts({ "/public/fonts/slow.woff2": "hold" });

		const earlier = injectFontFaces([face("Earlier", "shared.woff2", "slow.woff2")]);
		await injectFontFaces([face("Later", "shared.woff2", "later.woff2")]);
		relay.release("/public/fonts/slow.woff2");
		await earlier;

		const rules = document.getElementById("lasterm-fonts")?.textContent ?? "";
		expect(rules).toContain('"Later"');
		expect(rules).not.toContain('"Earlier"');
		await injectFontFaces([]);

		expect(document.getElementById("lasterm-fonts")?.textContent).toBe("");
		expect([...revoked].sort()).toEqual([...created].sort());
		expect(new Set(revoked).size).toBe(revoked.length);
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
