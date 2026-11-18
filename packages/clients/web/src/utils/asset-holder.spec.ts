import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("./hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { useAuthStore } from "../stores/auth.js";
import {
	acquireAsset,
	assetPath,
	assetVersion,
	invalidateAsset,
	parseAssetPath,
	resetAssetHolderForTests,
} from "./asset-holder.js";
import { setAssetTokenForTests, setHubPortForTests } from "./hub-url.js";

/** A response whose body arrives later, so a test decides when a fetch settles. */
function deferredFetch(): { resolve: (body?: string) => void; reject: (error: Error) => void } {
	let resolve!: (body?: string) => void;
	let reject!: (error: Error) => void;
	mocks.hubFetch.mockImplementationOnce(
		() =>
			new Promise<Response>((res, rej) => {
				resolve = (body = "bytes") => res(new Response(body, { status: 200 }));
				reject = rej;
			}),
	);
	return {
		resolve: (body) => resolve(body),
		reject: (error) => reject(error),
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

let created: string[];
let revoked: string[];

function enterDesktop(): void {
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: { invoke: () => undefined },
		configurable: true,
	});
	setHubPortForTests(4100);
}

beforeEach(() => {
	setActivePinia(createPinia());
	useAuthStore().setToken("bearer-1");
	created = [];
	revoked = [];
	let next = 0;
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
		const url = `blob:test/${++next}`;
		created.push(url);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
		revoked.push(url);
	});
	mocks.hubFetch.mockReset();
	mocks.hubFetch.mockImplementation(async () => new Response("bytes", { status: 200 }));
});

afterEach(() => {
	resetAssetHolderForTests();
	setHubPortForTests(null);
	setAssetTokenForTests(null);
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
});

describe("the desktop's asset holder (#194)", () => {
	beforeEach(enterDesktop);

	it("relays the path encoded once, with the bearer and no asset token", async () => {
		setAssetTokenForTests("asset-token");

		await acquireAsset("wallpapers", "a b%#.png");

		expect(mocks.hubFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mocks.hubFetch.mock.calls[0] ?? [];
		expect(url).toBe("https://127.0.0.1:4100/public/wallpapers/a%20b%25%23.png");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bearer-1");
		expect(url).not.toContain("asset_token");
	});

	it("shares one fetch and one URL, revoked once when the last handle is released", async () => {
		const [first, second] = await Promise.all([
			acquireAsset("wallpapers", "a.png"),
			acquireAsset("wallpapers", "a.png"),
		]);

		expect(mocks.hubFetch).toHaveBeenCalledTimes(1);
		expect(created).toHaveLength(1);
		expect(first.url).toBe(second.url);
		first.release();
		expect(revoked).toEqual([]);
		second.release();
		expect(revoked).toEqual([first.url]);
		second.release();
		first.release();
		expect(revoked).toEqual([first.url]);
	});

	it("after an invalidation, fetches anew and keeps the old URL until its last holder lets go", async () => {
		const old = await acquireAsset("wallpapers", "a.png");

		invalidateAsset("wallpapers", "a.png");
		const fresh = await acquireAsset("wallpapers", "a.png");

		expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
		expect(fresh.url).not.toBe(old.url);
		expect(revoked).toEqual([]);
		old.release();
		expect(revoked).toEqual([old.url]);
		fresh.release();
		expect(revoked).toEqual([old.url, fresh.url]);
	});

	it("an invalidation during a fetch leaves its waiting acquire on the old file and the new entry usable", async () => {
		const first = deferredFetch();
		const waiting = acquireAsset("wallpapers", "a.png");
		await settle();

		invalidateAsset("wallpapers", "a.png");
		const fresh = await acquireAsset("wallpapers", "a.png");
		first.resolve();
		const old = await waiting;

		expect(old.url).not.toBe(fresh.url);
		expect(revoked).toEqual([]);
		old.release();
		expect(revoked).toEqual([old.url]);
		const again = await acquireAsset("wallpapers", "a.png");
		expect(again.url).toBe(fresh.url);
		expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		[
			"an HTTP error",
			() => mocks.hubFetch.mockResolvedValueOnce(new Response("no", { status: 404 })),
		],
		["a relay failure", () => mocks.hubFetch.mockRejectedValueOnce(new Error("relay closed"))],
		[
			"a body that fails midway",
			() =>
				mocks.hubFetch.mockResolvedValueOnce(
					new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new Error("stream broke"));
							},
						}),
						{ status: 200 },
					),
				),
		],
	])(
		"after %s, rejects, creates nothing, and the next acquire fetches again",
		async (_case, fail) => {
			fail();

			await expect(acquireAsset("sounds", "bell.mp3")).rejects.toThrow();
			expect(created).toEqual([]);
			const handle = await acquireAsset("sounds", "bell.mp3");

			expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
			expect(handle.url).toBe(created[0]);
		},
	);

	it("rejects every acquire waiting on a failed fetch", async () => {
		const fetch = deferredFetch();
		const one = acquireAsset("sounds", "bell.mp3");
		const two = acquireAsset("sounds", "bell.mp3");
		fetch.reject(new Error("relay closed"));

		await expect(one).rejects.toThrow();
		await expect(two).rejects.toThrow();
		await expect(acquireAsset("sounds", "bell.mp3")).resolves.toBeDefined();
	});

	it("a detached entry that fails after its replacement succeeded leaves the replacement current", async () => {
		const old = deferredFetch();
		const waiting = acquireAsset("wallpapers", "a.png");
		await settle();
		invalidateAsset("wallpapers", "a.png");
		const fresh = await acquireAsset("wallpapers", "a.png");

		old.reject(new Error("relay closed"));
		await expect(waiting).rejects.toThrow();
		const again = await acquireAsset("wallpapers", "a.png");

		expect(again.url).toBe(fresh.url);
		expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
	});

	it.each([
		["wallpapers", ".."],
		["wallpapers", "a/b"],
		["wallpapers", ""],
		["other", "x"],
	])("refuses %s/%s without fetching", async (kind, name) => {
		await expect(acquireAsset(kind as never, name)).rejects.toThrow();
		expect(mocks.hubFetch).not.toHaveBeenCalled();
	});
});

describe("the browser's asset URLs (#194)", () => {
	it("signs the path with the asset token and fetches nothing", async () => {
		setAssetTokenForTests("t");

		const handle = await acquireAsset("wallpapers", "a.png");

		expect(handle.url).toBe("/public/wallpapers/a.png?asset_token=t");
		expect(mocks.hubFetch).not.toHaveBeenCalled();
	});

	it("names the version after an invalidation, so the browser loads the new file", async () => {
		setAssetTokenForTests("t");

		invalidateAsset("wallpapers", "a.png");

		expect(assetVersion("wallpapers", "a.png")).toBe(1);
		expect((await acquireAsset("wallpapers", "a.png")).url).toBe(
			"/public/wallpapers/a.png?asset_token=t&v=1",
		);
	});
});

describe("asset paths (#194)", () => {
	it("decodes a listed path once, and builds it back", () => {
		const parsed = parseAssetPath("/public/fonts/a%20b%25.woff2");

		expect(parsed).toEqual({ kind: "fonts", name: "a b%.woff2" });
		expect(assetPath(parsed.kind, parsed.name)).toBe("/public/fonts/a%20b%25.woff2");
	});

	it("refuses a path that is not a served asset", () => {
		expect(() => parseAssetPath("/api/auth/tokens")).toThrow();
	});
});
