/**
 * The interrupted uploads in the Transfers part (#837): listed at the start with Resume all, Not
 * now and Discard all, each with its host, its destination and what was placed; Not now folds
 * them into one line; another device's says where it can be resumed from, with Discard only; one
 * whose files were not kept says to drop them again; one not resumed says why; a reader sees the
 * rows without actions; and Resume asks for the files' access inside the click.
 */
import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import type { IWsClient } from "../../services/ws-client.js";
import { useAuthStore } from "../../stores/auth.js";
import { useConfigStore } from "../../stores/config.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useTransfersStore } from "../../stores/transfers.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import type { HandleStore, KeptItem, KeptUpload } from "../../utils/upload-handles.js";
import TransfersPart from "./TransfersPart.vue";

const AD = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const ON_AD = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const OURS = "01ARZ3NDEKTSV4RRFFQ69G5FT1";
const THEIRS = "01ARZ3NDEKTSV4RRFFQ69G5FT2";
const UNKEPT = "01ARZ3NDEKTSV4RRFFQ69G5FT3";
const ME = "01ARZ3NDEKTSV4RRFFQ69G5FME";

function host(id: string, label: string): Host {
	return {
		id,
		type: "ssh",
		label,
		iconType: "auto",
		color: "#fab387",
		sortOrder: 0,
		os: "linux",
		arch: null,
	} as unknown as Host;
}

let app: App | null = null;
let root: HTMLElement;
let hear: (msg: Record<string, unknown>) => void;
let sent: Record<string, unknown>[];
let requestPermission: ReturnType<typeof vi.fn>;

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

/** An upload of photos/ as the hub describes it after a restart: 118 of 120 placed. */
function described(transferId: string, extra: Record<string, unknown> = {}) {
	return {
		transfer_id: transferId,
		channel_id: ON_AD,
		host_id: AD,
		dir: "/srv/assets",
		state: "interrupted",
		updated_at: "2026-11-05T09:00:00.000Z",
		from_this_device: true,
		totals: { files: 120, bytes: 1200, acked: 1180, states: { placed: 118, interrupted: 2 } },
		items: [{ item_id: 0, rel_path: "photos", kind: "dir", size: null, state: "placed" }],
		...extra,
	};
}

function memoryHandles(kept: readonly string[]): HandleStore {
	return {
		save: async () => undefined,
		load: async (id) =>
			kept.includes(id)
				? {
						upload: {
							transferId: id,
							hostId: AD,
							channelId: ON_AD,
							dir: "/srv/assets",
							savedAt: 0,
							roots: [
								{
									name: "photos",
									kind: "directory",
									handle: { kind: "directory", requestPermission },
								},
							],
						} satisfies KeptUpload,
						items: [] as KeptItem[],
					}
				: null,
		list: async () => [],
		remove: async () => undefined,
	};
}

const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>("[data-interrupted-row]")];
const text = (el: Element | null | undefined): string =>
	el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const buttons = (el: Element): string[] =>
	[...el.querySelectorAll<HTMLButtonElement>("button")].map((b) => text(b));

beforeEach(async () => {
	localStorage.clear();
	setActivePinia(createPinia());
	mocks.hubFetch.mockReset();
	sent = [];
	requestPermission = vi.fn(() => new Promise<string>(() => undefined));
	useHostsStore().hosts = [host(AD, "AD")];
	useAuthStore().clientId = ME;
	useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
	const handlers = new Map<string, ((msg: unknown) => void)[]>();
	const client = {
		isConnected: true,
		send: (msg: Record<string, unknown>) => sent.push(msg),
		on: (type: string, cb: (msg: unknown) => void) => {
			handlers.set(type, [...(handlers.get(type) ?? []), cb]);
			return () => undefined;
		},
		onDisconnect: () => () => undefined,
		onReconnect: () => () => undefined,
	} as unknown as IWsClient;
	hear = (msg) => {
		for (const handler of handlers.get(String(msg.type)) ?? []) handler(msg);
	};
	const transfers = useTransfersStore();
	transfers.registerHandlers(client);
	transfers.setSeamsForTests({ handles: memoryHandles([OURS]) });
	const bodies = [
		described(OURS),
		described(THEIRS, { from_this_device: false, device_label: "Paired from 10.0.0.2" }),
		described(UNKEPT, { reason: "needs_passphrase" }),
	];
	mocks.hubFetch.mockImplementation(async (url: unknown) => {
		const id = /\/api\/transfers\/([0-9A-Z]+)$/.exec(String(url))?.[1];
		const body = bodies.find((b) => b.transfer_id === id);
		return new Response(JSON.stringify(body ?? { transfers: bodies }));
	});
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(TransfersPart, { focusedChannelId: ON_AD }) });
	app.mount(root);
	hear({
		type: "STATE_SYNC",
		sessions: [],
		channels: [],
		transfers: bodies.map((body) => ({
			transferId: body.transfer_id,
			channelId: ON_AD,
			hostId: AD,
			dir: body.dir,
			state: "interrupted",
			totals: body.totals,
			updatedAt: body.updated_at,
			fromThisDevice: body.from_this_device,
		})),
	});
	await settle();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root.remove();
	vi.restoreAllMocks();
});

describe("interrupted uploads", () => {
	it("are listed with Resume all, Not now and Discard all, each with its host, destination and what was placed", () => {
		const block = root.querySelector("[data-interrupted-uploads]") as HTMLElement;
		expect(text(block.querySelector(".interrupted__title"))).toBe("Interrupted uploads");
		expect(text(block.querySelector(".interrupted__until"))).toBe("kept until 12 Nov");
		expect(buttons(block.querySelector(".interrupted__all") as HTMLElement)).toEqual([
			"Resume all",
			"Not now",
			"Discard all",
		]);
		const [ours, theirs, unkept] = rows() as [HTMLElement, HTMLElement, HTMLElement];
		expect(text(ours.querySelector(".interrupted__name"))).toBe("photos/");
		expect(text(ours.querySelector(".interrupted__dest"))).toBe("→ AD › /srv/assets");
		expect(text(ours.querySelector(".interrupted__placed"))).toBe("118 of 120 placed");
		expect(ours.querySelector(".host-badge, [class*='badge']")).not.toBeNull();
		expect(buttons(ours)).toEqual(["Resume", "Discard"]);
		// Another device's: where it can be resumed from, Discard only.
		expect(text(theirs.querySelector("[data-interrupted-note]"))).toBe(
			"Interrupted · resumable from the device paired from 10.0.0.2",
		);
		expect(buttons(theirs)).toEqual(["Discard"]);
		// This device's, its files not kept, and its last resume stopped at the passphrase.
		expect(text(unkept.querySelector("[data-interrupted-note]"))).toBe(
			"Not resumed: AD needs its passphrase",
		);
		expect(buttons(unkept)).toEqual(["Discard"]);
		// Not among the groups: the header counts them.
		expect(root.querySelectorAll("[data-upload-row]")).toHaveLength(0);
		expect(text(root.querySelector(".transfers__count"))).toBe("· 3 interrupted");
	});

	it("says to drop the files again for one whose files were not kept", async () => {
		const transfers = useTransfersStore();
		hear({
			type: "TRANSFER_STATE",
			transferId: UNKEPT,
			channelId: ON_AD,
			hostId: AD,
			state: "interrupted",
		});
		await settle();
		expect(transfers.interrupted.find((u) => u.id === UNKEPT)?.reason).toBeUndefined();
		expect(text(rows()[2]?.querySelector("[data-interrupted-note]"))).toBe(
			"Can't be resumed after a restart: drop it again",
		);
	});

	it("folds into one line on Not now, removing nothing, and its Resume resumes", async () => {
		(root.querySelector("[data-interrupted-not-now]") as HTMLButtonElement).click();
		await settle();
		expect(rows()).toHaveLength(0);
		const line = root.querySelector(".interrupted__folded") as HTMLElement;
		expect(text(line.querySelector("[data-interrupted-show]"))).toBe(
			"3 interrupted uploads · kept until 12 Nov",
		);
		expect(buttons(line)).toEqual(["3 interrupted uploads · kept until 12 Nov", "Resume"]);
		expect(useTransfersStore().interrupted).toHaveLength(3);
		(line.querySelector("[data-interrupted-resume-all]") as HTMLButtonElement).click();
		// Only this device's kept one, its access asked within the click.
		expect(requestPermission).toHaveBeenCalledTimes(1);
		(root.querySelector("[data-interrupted-show]") as HTMLButtonElement).click();
		await settle();
		expect(rows()).toHaveLength(3);
		expect(text(rows()[0]?.querySelector("[data-interrupted-note]"))).toBe(
			"Asking for access to its files…",
		);
	});

	it("asks the files' access inside the click of Resume", () => {
		const resume = rows()[0]?.querySelector<HTMLButtonElement>("[data-interrupted-resume]");
		resume?.click();
		expect(requestPermission).toHaveBeenCalledWith({ mode: "read" });
	});

	it("discards them all on Discard all", async () => {
		(root.querySelector("[data-interrupted-discard-all]") as HTMLButtonElement).click();
		expect(sent.filter((msg) => msg.type === "TRANSFER_DISCARD")).toEqual([
			{ type: "TRANSFER_DISCARD", transferIds: [OURS, THEIRS, UNKEPT] },
		]);
		await settle();
		expect(text(rows()[0]?.querySelector("[data-interrupted-note]"))).toBe("Discarding…");
	});

	it("leaves another device's upload to it once its terminal ended", async () => {
		useTransfersStore().setTerminalSettings(ON_AD, {
			drop: "upload",
			confirmDrop: true,
			onConflict: "ask",
			ended: true,
		});
		await settle();
		const [ours, theirs] = rows() as [HTMLElement, HTMLElement];
		expect(buttons(ours)).toEqual(["Resume", "Discard"]);
		expect(buttons(theirs)).toEqual([]);
	});

	it("shows a reader the rows without actions", async () => {
		useWriteLockStore().locks.set(ON_AD, { holder: "01ARZ3NDEKTSV4RRFFQ69G5FOT" } as never);
		await settle();
		expect(rows()).toHaveLength(3);
		expect(root.querySelector(".interrupted__all")).toBeNull();
		expect(rows().flatMap((row) => buttons(row))).toEqual([]);
	});
});
