/**
 * A file's bytes (#837): 1 MiB chunks, each PUT at the offset the host holds, resumed from where
 * the hub says, sent again from the same offset when it did not get through, and stopped without
 * a word when the hub no longer takes them.
 */
import { TRANSFER_CHUNK_BYTES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("./hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { useAuthStore } from "../stores/auth.js";
import { type ChunkAnswer, putChunk, sendFileBytes } from "./upload-send.js";

const MiB = 1024 * 1024;

function blob(size: number): Blob {
	return new Blob([new Uint8Array(size)]);
}

const noWait = async () => undefined;

beforeEach(() => {
	setActivePinia(createPinia());
	mocks.hubFetch.mockReset();
});

describe("sending a file chunk by chunk", () => {
	it("sends 1 MiB chunks at the offsets the host acknowledged, the last shorter", async () => {
		const seen: [number, number][] = [];
		const outcome = await sendFileBytes({
			file: blob(2 * MiB + 10),
			from: 0,
			put: async (offset, chunk) => {
				seen.push([offset, chunk.size]);
				return { ok: true, acked: offset + chunk.size };
			},
		});
		expect(TRANSFER_CHUNK_BYTES).toBe(MiB);
		expect(seen).toEqual([
			[0, MiB],
			[MiB, MiB],
			[2 * MiB, 10],
		]);
		expect(outcome).toEqual({ kind: "sent", acked: 2 * MiB + 10 });
	});

	it("resumes from where the host's bytes end", async () => {
		const offsets: number[] = [];
		await sendFileBytes({
			file: blob(3 * MiB),
			from: 2 * MiB,
			put: async (offset, chunk) => {
				offsets.push(offset);
				return { ok: true, acked: offset + chunk.size };
			},
		});
		expect(offsets).toEqual([2 * MiB]);
	});

	it("moves to the offset the hub says the host holds, after OFFSET_MISMATCH", async () => {
		const offsets: number[] = [];
		const acked: number[] = [];
		const outcome = await sendFileBytes({
			file: blob(3 * MiB),
			from: 0,
			put: async (offset, chunk): Promise<ChunkAnswer> => {
				offsets.push(offset);
				if (offsets.length === 1) {
					return { ok: false, status: 409, code: "OFFSET_MISMATCH", message: "", acked: 2 * MiB };
				}
				return { ok: true, acked: offset + chunk.size };
			},
			onAcked: (n) => acked.push(n),
		});
		expect(offsets).toEqual([0, 2 * MiB]);
		expect(acked).toEqual([2 * MiB, 3 * MiB]);
		expect(outcome.kind).toBe("sent");
	});

	it("sends the same chunk again when it did not get through, or the file was busy, then gives up", async () => {
		const offsets: number[] = [];
		let calls = 0;
		const backoff = vi.fn(noWait);
		const outcome = await sendFileBytes({
			file: blob(2 * MiB),
			from: 0,
			backoff,
			put: async (offset, chunk): Promise<ChunkAnswer> => {
				offsets.push(offset);
				calls++;
				if (calls === 1) return { ok: false, status: 0, code: "HUB_UNREACHABLE", message: "" };
				if (calls === 2) return { ok: false, status: 409, code: "ITEM_BUSY", message: "" };
				return { ok: true, acked: offset + chunk.size };
			},
		});
		expect(offsets).toEqual([0, 0, 0, MiB]);
		expect(backoff.mock.calls).toEqual([[1], [2]]);
		expect(outcome.kind).toBe("sent");

		const failing = await sendFileBytes({
			file: blob(10),
			from: 0,
			backoff: noWait,
			put: async () => ({ ok: false, status: 0, code: "HUB_UNREACHABLE", message: "gone" }),
		});
		expect(failing).toEqual({
			kind: "failed",
			code: "HUB_UNREACHABLE",
			message: "gone",
			local: false,
		});
	});

	it("stops without a word when the hub no longer takes the file, or the window stopped it", async () => {
		const notSending = await sendFileBytes({
			file: blob(10),
			from: 0,
			put: async () => ({
				ok: false,
				status: 409,
				code: "ITEM_NOT_SENDING",
				message: "",
				state: "cancelled",
			}),
		});
		expect(notSending).toEqual({ kind: "stopped", state: "cancelled" });
		// The host failed it: the hub says why in TRANSFER_PROGRESS.
		const hostFailed = await sendFileBytes({
			file: blob(10),
			from: 0,
			put: async () => ({ ok: false, status: 502, code: "NO_SPACE", message: "" }),
		});
		expect(hostFailed).toEqual({ kind: "stopped" });
		const put = vi.fn();
		expect(await sendFileBytes({ file: blob(10), from: 0, put, stopped: () => true })).toEqual({
			kind: "stopped",
		});
		expect(put).not.toHaveBeenCalled();
	});

	it("says a file that changed since it was dropped cannot be read here", async () => {
		const outcome = await sendFileBytes({
			file: blob(10),
			from: 0,
			put: async () => {
				throw new DOMException("changed", "NotReadableError");
			},
		});
		expect(outcome).toMatchObject({ kind: "failed", code: "NotReadableError", local: true });
	});

	it("sends nothing for an empty file: the hub places it on its own", async () => {
		const put = vi.fn();
		expect(await sendFileBytes({ file: blob(0), from: 0, put })).toEqual({
			kind: "sent",
			acked: 0,
		});
		expect(put).not.toHaveBeenCalled();
	});
});

describe("one chunk's request", () => {
	it("PUTs the bytes at the offset, from this window, and reads acked", async () => {
		const auth = useAuthStore();
		auth.setToken("t0k");
		auth.setClientId("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		mocks.hubFetch.mockResolvedValue(new Response(JSON.stringify({ acked: 30 }), { status: 200 }));
		const chunk = blob(10);
		expect(await putChunk("01ARZ3NDEKTSV4RRFFQ69G5FTR", 4, 20, chunk)).toEqual({
			ok: true,
			acked: 30,
		});
		const [url, init] = mocks.hubFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toMatch(/\/api\/transfers\/01ARZ3NDEKTSV4RRFFQ69G5FTR\/items\/4\?offset=20$/);
		expect(init.method).toBe("PUT");
		expect(init.body).toBe(chunk);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer t0k",
			"Content-Type": "application/octet-stream",
			"X-Lasterm-Client-Id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
	});

	it("reads a refusal's code, and the offset OFFSET_MISMATCH gives", async () => {
		mocks.hubFetch.mockResolvedValue(
			new Response(JSON.stringify({ error: { code: "OFFSET_MISMATCH", message: "m", acked: 7 } }), {
				status: 409,
			}),
		);
		expect(await putChunk("01ARZ3NDEKTSV4RRFFQ69G5FTR", 0, 0, blob(1))).toEqual({
			ok: false,
			status: 409,
			code: "OFFSET_MISMATCH",
			message: "m",
			acked: 7,
		});
		mocks.hubFetch.mockRejectedValue(new TypeError("Failed to fetch"));
		expect(await putChunk("01ARZ3NDEKTSV4RRFFQ69G5FTR", 0, 0, blob(1))).toMatchObject({
			ok: false,
			status: 0,
			code: "HUB_UNREACHABLE",
		});
	});
});
