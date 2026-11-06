/**
 * A drop target for uploads (#837), as the pane wrapper and the files panel use it: `dragover`
 * and `drop` prevented only for files it takes, a refused drag's cursor set to "none" with the
 * reason shown, anything else left to the page's guard; the drop read inside its event.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useConfigStore } from "../stores/config.js";
import { useTransfersStore } from "../stores/transfers.js";
import { useWriteLockStore } from "../stores/writelock.js";
import { type UploadDropSpec, useUploadDrop } from "./useUploadDrop.js";

const C = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const H = "01ARZ3NDEKTSV4RRFFQ69G5FH1";
const ME = "01ARZ3NDEKTSV4RRFFQ69G5FME";

function dragEvent(types: string[], items: unknown[] = []) {
	const dataTransfer = { types, dropEffect: "copy", items };
	return {
		event: {
			dataTransfer,
			preventDefault: vi.fn(),
			currentTarget: null,
			relatedTarget: null,
			clientX: 0,
			clientY: 0,
		} as unknown as DragEvent,
		dataTransfer,
	};
}

const terminal: UploadDropSpec = {
	kind: "terminal",
	channelId: C,
	paneId: "p1",
	dir: null,
	folder: null,
};

beforeEach(() => {
	setActivePinia(createPinia());
	useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
	useChannelsStore().registerChannelHost(C, H);
	useAuthStore().setClientId(ME);
	useWriteLockStore().handleWriteLock(C, ME);
	// The terminal's directory is known: the drop goes there.
	vi.spyOn(useTransfersStore(), "terminalDestination").mockResolvedValue({
		dir: "/home/pi",
		origin: "terminal",
	});
});

describe("a terminal pane as a drop target", () => {
	it("takes files for the writer: prevented, a copy, the overlay naming where they go", async () => {
		const drop = useUploadDrop(() => terminal);
		const { event, dataTransfer } = dragEvent(["Files"], [{ kind: "file" }, { kind: "file" }]);
		expect(drop.onDragOver(event)).toBe(true);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(dataTransfer.dropEffect).toBe("copy");
		await vi.waitFor(() =>
			expect(useTransfersStore().dropHover).toMatchObject({
				paneId: "p1",
				place: "pane",
				count: 2,
				decision: { kind: "take" },
				dir: "/home/pi",
			}),
		);
	});

	it("refuses a reader with the cursor saying so, without taking the event, and offers Request write", () => {
		useWriteLockStore().handleWriteLock(C, "01ARZ3NDEKTSV4RRFFQ69G5FOT");
		const drop = useUploadDrop(() => terminal);
		const { event, dataTransfer } = dragEvent(["Files"]);
		expect(drop.onDragOver(event)).toBe(true);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(dataTransfer.dropEffect).toBe("none");
		expect(useTransfersStore().dropHover?.decision).toEqual({ kind: "refuse", reason: "reader" });
		// Let go here: the refusal stays a moment, with its way out.
		const { event: dropped } = dragEvent(["Files"]);
		expect(drop.onDrop(dropped)).toBe(true);
		expect(useTransfersStore().refusal).toMatchObject({ paneId: "p1", reason: "reader" });
	});

	it("refuses an ended terminal and one whose transfer_drop is off", () => {
		const transfers = useTransfersStore();
		transfers.setTerminalSettings(C, {
			drop: "off",
			confirmDrop: true,
			onConflict: "ask",
			ended: false,
		});
		expect(useUploadDrop(() => terminal).decide(dragEvent(["Files"]).event)).toEqual({
			kind: "refuse",
			reason: "off",
		});
		transfers.setTerminalSettings(C, {
			drop: "upload",
			confirmDrop: true,
			onConflict: "ask",
			ended: true,
		});
		expect(useUploadDrop(() => terminal).decide(dragEvent(["Files"]).event)).toEqual({
			kind: "refuse",
			reason: "ended",
		});
	});

	it("leaves a pane move, a link and file transfer off to the page", () => {
		const drop = useUploadDrop(() => terminal);
		for (const types of [["text/x-lasterm-pane"], ["text/uri-list"]]) {
			const { event } = dragEvent(types);
			expect(drop.onDragOver(event)).toBe(false);
			expect(event.preventDefault).not.toHaveBeenCalled();
		}
		useConfigStore().uiConfig = { onChannelDead: "readonly" };
		const { event } = dragEvent(["Files"]);
		expect(drop.onDragOver(event)).toBe(false);
		expect(drop.onDrop(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("reads the drop inside its event, then counts it for its terminal's folder", async () => {
		const begin = vi.spyOn(useTransfersStore(), "begin").mockResolvedValue();
		const asked: string[] = [];
		const item = {
			kind: "file",
			getAsFile: () => null,
			webkitGetAsEntry: () => {
				asked.push("entry");
				return {
					name: "a.txt",
					isFile: true,
					isDirectory: false,
					file: (ok: (f: File) => void) => ok(new File(["x"], "a.txt")),
				};
			},
			getAsFileSystemHandle: () => {
				asked.push("handle");
				return Promise.resolve(null);
			},
		};
		const drop = useUploadDrop(() => terminal);
		const { event } = dragEvent(["Files"], [item]);
		expect(drop.onDrop(event)).toBe(true);
		expect(asked).toEqual(["handle", "entry"]);
		expect(event.preventDefault).toHaveBeenCalled();
		await vi.waitFor(() => expect(begin).toHaveBeenCalled());
		expect(begin.mock.calls[0]?.[0]).toMatchObject({
			channelId: C,
			hostId: H,
			dir: "/home/pi",
			origin: "terminal",
			paneId: "p1",
		});
	});
});

describe("the files panel's list and its folder rows", () => {
	it("takes files for the folder shown, or the folder row under them, even with transfer_drop off", () => {
		useTransfersStore().setTerminalSettings(C, {
			drop: "off",
			confirmDrop: true,
			onConflict: "ask",
			ended: false,
		});
		const row = useUploadDrop(() => ({
			kind: "folder",
			channelId: C,
			paneId: null,
			dir: "/home/pi/src",
			folder: "src",
		}));
		const { event } = dragEvent(["Files"]);
		expect(row.onDragOver(event)).toBe(true);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(useTransfersStore().dropHover).toMatchObject({
			place: "panel",
			folder: "src",
			dir: "/home/pi/src",
			origin: "folder",
		});
	});

	it("refuses a reader there too", () => {
		useWriteLockStore().handleWriteLock(C, "01ARZ3NDEKTSV4RRFFQ69G5FOT");
		const list = useUploadDrop(() => ({
			kind: "panel",
			channelId: C,
			paneId: null,
			dir: "/home/pi",
			folder: null,
		}));
		const { event, dataTransfer } = dragEvent(["Files"]);
		list.onDragOver(event);
		expect(dataTransfer.dropEffect).toBe("none");
		expect(event.preventDefault).not.toHaveBeenCalled();
	});
});
