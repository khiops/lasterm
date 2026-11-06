/**
 * The Transfers part (#837): the focused terminal's group first and expanded, the others summed
 * up; nothing moves while the pointer is in the list, and moves once it leaves; a group expanded
 * by hand stays so; the filter; and the line that says the desktop waits for these uploads before
 * it quits, with its Cancel (#863).
 */
import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, reactive } from "vue";

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import type { IWsClient } from "../../services/ws-client.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useTransfersStore } from "../../stores/transfers.js";
import TransfersPart from "./TransfersPart.vue";

const AD = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const RPI = "01ARZ3NDEKTSV4RRFFQ69G5FR1";
const ON_AD = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const ON_RPI = "01ARZ3NDEKTSV4RRFFQ69G5FC2";

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
const props = reactive<{ focusedChannelId: string | null }>({ focusedChannelId: ON_AD });
let hear: (msg: Record<string, unknown>) => void;

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

/** An upload another window sends, heard of and read whole, as a reader follows it. */
async function upload(
	transferId: string,
	hostId: string,
	channelId: string,
	state: string,
): Promise<void> {
	mocks.hubFetch.mockResolvedValueOnce(
		new Response(
			JSON.stringify({
				transfer_id: transferId,
				channel_id: channelId,
				host_id: hostId,
				dir: "/srv",
				state: "running",
				totals: { files: 1, bytes: 100, acked: 50, states: { [state]: 1 } },
				items: [
					{ item_id: 0, rel_path: `${transferId}.bin`, kind: "file", size: 100, state, acked: 50 },
				],
			}),
		),
	);
	hear({
		type: "TRANSFER_PROGRESS",
		transferId,
		channelId,
		items: [],
		folders: [],
		totals: { files: 1, bytes: 100, acked: 50, states: { [state]: 1 } },
	});
	await settle();
}

/** Each group's line: its host or its summary, and whether it is this terminal's. */
const hostLines = (): string[] =>
	[...root.querySelectorAll<HTMLElement>(".transfers__host")].map((el) =>
		[el.querySelector(".transfers__host-name"), el.querySelector(".transfers__this")]
			.map((part) => part?.textContent?.trim() ?? "")
			.filter((text) => text !== "")
			.join(" "),
	);
const body = (): HTMLElement => root.querySelector("[data-transfers-list]") as HTMLElement;

beforeEach(async () => {
	localStorage.clear();
	setActivePinia(createPinia());
	mocks.hubFetch.mockReset();
	props.focusedChannelId = ON_AD;
	useHostsStore().hosts = [host(AD, "AD"), host(RPI, "raspberrypi")];
	const handlers = new Map<string, ((msg: unknown) => void)[]>();
	const client = {
		isConnected: true,
		send: vi.fn(),
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
	useTransfersStore().registerHandlers(client);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(TransfersPart, { focusedChannelId: props.focusedChannelId }) });
	app.mount(root);
	await upload("01ARZ3NDEKTSV4RRFFQ69G5FT1", RPI, ON_RPI, "sending");
	await upload("01ARZ3NDEKTSV4RRFFQ69G5FT2", AD, ON_AD, "failed");
});

afterEach(() => {
	app?.unmount();
	app = null;
	root.remove();
});

describe("the groups", () => {
	it("puts the focused terminal's group first, expanded, and sums the others up", () => {
		expect(hostLines()).toEqual(["AD this terminal", "raspberrypi · 1 running, 50 %"]);
	});

	it("moves nothing while the pointer is in the list, and re-orders once it leaves", async () => {
		body().dispatchEvent(new Event("pointerenter"));
		props.focusedChannelId = ON_RPI;
		await settle();
		expect(hostLines()[0]).toBe("AD this terminal");
		body().dispatchEvent(new Event("pointerleave"));
		await settle();
		expect(hostLines()).toEqual(["raspberrypi this terminal", "AD · 1 failed"]);
		// The summary holding a failure takes the warning style.
		expect(root.querySelectorAll(".transfers__host--warn")).toHaveLength(1);
	});

	it("keeps a group expanded by hand when the focus moves on", async () => {
		const rpi = [
			...root.querySelectorAll<HTMLButtonElement>(".transfers__host"),
		][1] as HTMLButtonElement;
		rpi.click();
		await settle();
		expect(rpi.getAttribute("aria-expanded")).toBe("true");
		props.focusedChannelId = ON_RPI;
		await settle();
		props.focusedChannelId = null;
		await settle();
		const lines = hostLines();
		// raspberrypi stays open; AD, which the focus had opened, is summed up again.
		expect(lines).toContain("raspberrypi");
		expect(lines).toContain("AD · 1 failed");
	});

	it("shows this terminal's uploads only when asked, All by default", async () => {
		expect(useTransfersStore().filter).toBe("all");
		const option = [...root.querySelectorAll<HTMLButtonElement>(".transfers__filter-option")].find(
			(b) => b.textContent?.trim() === "This terminal",
		) as HTMLButtonElement;
		option.click();
		await settle();
		expect(hostLines()).toEqual(["AD this terminal"]);
		expect(localStorage.getItem("lasterm:files:transfers-filter")).toBe("terminal");
	});
});

describe("a quit that waits for these uploads", () => {
	it("is said, quit or restart, with its Cancel", async () => {
		const transfers = useTransfersStore();
		expect(root.querySelector(".transfers__quit")).toBeNull();
		transfers.quitPending = "quit";
		await settle();
		const line = root.querySelector(".transfers__quit") as HTMLElement;
		expect(line.textContent).toContain("Lasterm will quit when these uploads end");
		const cancel = vi.spyOn(transfers, "cancelQuitWhenFinished").mockResolvedValue(true);
		(line.querySelector("button") as HTMLButtonElement).click();
		expect(cancel).toHaveBeenCalledTimes(1);
		transfers.quitPending = "restart";
		await settle();
		expect(root.querySelector(".transfers__quit")?.textContent).toContain(
			"Lasterm will restart when these uploads end",
		);
	});
});
