import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { TransferStartItem } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { FileAccessError } from "../files/host-files.js";
import {
	LOCAL_BACKEND,
	sftpBackend,
	UPLOAD_BACKENDS,
	type UploadBackendKind,
	type UploadHarness,
} from "../files/upload-backends.fixture.js";
import {
	CHANNEL,
	itemOf,
	itemsOf,
	READER,
	received,
	refusedStart,
	type Service,
	sendFile,
	serviceOn,
	startUpload,
	tamperedSink,
	WRITER,
	waitFor,
	waitState,
} from "./transfer-service.fixture.js";

const MTIME = 1_700_000_000_000;

function content(name: string, length = 5_000): Buffer {
	const seed = createHash("sha256").update(name).digest();
	const data = Buffer.alloc(length);
	for (let i = 0; i < length; i++) data[i] = (seed[i % seed.length] ?? 0) ^ (i & 0xff);
	return data;
}

const file = (relPath: string, data: Buffer): TransferStartItem => ({
	relPath,
	kind: "file",
	size: data.length,
	mtime: MTIME,
});
const dir = (relPath: string): TransferStartItem => ({ relPath, kind: "dir" });

/** Run `test` on a fresh host of `kind`, with a transfer service on it. */
async function on(
	kind: UploadBackendKind,
	test: (h: UploadHarness, s: Service) => Promise<void>,
): Promise<void> {
	const h = await kind.start();
	const s = serviceOn(h, kind);
	try {
		await test(h, s);
	} finally {
		s.service.shutdown();
		await h.close();
	}
}

/** The temporaries left in a folder of the host. */
function temporaries(h: UploadHarness, path = h.dir): string[] {
	return readdirSync(h.local(path)).filter((name) => name.endsWith(".partial"));
}

const RUNNING = UPLOAD_BACKENDS.filter((kind) => kind.runs);

describe.each(RUNNING)("uploads over $name", (kind) => {
	it("recreate a tree, empty and hidden folders and files included, and keep times", () =>
		on(kind, async (h, s) => {
			const files = {
				"top.txt": content("top", 200_000),
				"tree/.hidden": content("hidden"),
				"tree/deep/a b.txt": content("ab"),
				"tree/deep/empty.bin": Buffer.alloc(0),
			};
			const { transferId, accepted } = await startUpload(s, h.dir, [
				dir("tree"),
				dir("tree/deep"),
				dir("tree/empty"),
				dir("tree/.config"),
				...Object.entries(files).map(([path, data]) => file(path, data)),
			]);
			expect((accepted.items as unknown[]).length).toBe(8);
			await Promise.all(
				Object.entries(files)
					.filter(([, data]) => data.length > 0)
					.map(([path, data]) => sendFile(s, transferId, path, data)),
			);
			await waitFor(() =>
				expect(received(s.world, READER.clientId, "TRANSFER_DONE")).toHaveLength(1),
			);
			for (const [path, data] of Object.entries(files)) {
				const local = h.local(h.at(...path.split("/")));
				expect(readFileSync(local)).toEqual(data);
				expect(Math.round(statSync(local).mtimeMs / 1000)).toBe(MTIME / 1000);
				expect(itemOf(s, transferId, path)).toMatchObject({ state: "placed", outcome: "placed" });
			}
			expect(statSync(h.local(h.at("tree", "empty"))).isDirectory()).toBe(true);
			expect(statSync(h.local(h.at("tree", ".config"))).isDirectory()).toBe(true);
			expect(itemOf(s, transferId, "tree")).toMatchObject({ state: "placed", outcome: "created" });
			expect(temporaries(h)).toEqual([]);
			expect(temporaries(h, h.at("tree", "deep"))).toEqual([]);
			// Readers hear it too: the progress, and the end.
			const done = received(s.world, READER.clientId, "TRANSFER_DONE")[0];
			expect(done?.totals).toMatchObject({ files: 4, states: { placed: 4 } });
			if (kind.transport === "exec") {
				expect(itemOf(s, transferId, "top.txt").verification).toBe("sha256");
			} else {
				expect(itemOf(s, transferId, "top.txt").verification).toBe("size");
			}
		}));

	it("never overwrite: a file there asks, one that appears meanwhile becomes a late conflict", () =>
		on(kind, async (h, s) => {
			writeFileSync(h.local(h.at("there.txt")), "theirs");
			const ours = content("ours");
			const { transferId, accepted } = await startUpload(s, h.dir, [
				file("there.txt", ours),
				file("appears.txt", ours),
				file("free.txt", ours),
			]);
			expect(accepted.items).toEqual([
				{
					itemId: 0,
					state: "conflict",
					existing: expect.objectContaining({ kind: "file", size: 6 }),
				},
				{ itemId: 1, state: "queued" },
				{ itemId: 2, state: "queued" },
			]);
			// The others go on while the conflict waits.
			await sendFile(s, transferId, "free.txt", ours);
			await waitState(s, transferId, "free.txt", "placed");
			// Created after the start looked, before the file is placed.
			const appears = await waitState(s, transferId, "appears.txt", "sending");
			writeFileSync(h.local(h.at("appears.txt")), "theirs too");
			await s.service.receive(WRITER, transferId, appears.item_id, 0, ours);
			const late = await waitState(s, transferId, "appears.txt", "conflict");
			expect(late.late).toBe(true);
			expect(readFileSync(h.local(h.at("appears.txt")), "utf8")).toBe("theirs too");
			expect(readFileSync(h.local(h.at("there.txt")), "utf8")).toBe("theirs");
			await waitFor(() =>
				expect(received(s.world, READER.clientId, "TRANSFER_CONFLICT")).toContainEqual(
					expect.objectContaining({ items: [expect.objectContaining({ itemId: 1, late: true })] }),
				),
			);

			// Replace, for that one only: its bytes are on the host already, and are placed.
			s.service.resolve(WRITER, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: 1,
				action: "replace",
			});
			await waitState(s, transferId, "appears.txt", "placed");
			expect(readFileSync(h.local(h.at("appears.txt")))).toEqual(ours);
			expect(itemOf(s, transferId, "appears.txt").outcome).toBe("replaced");
			expect(readFileSync(h.local(h.at("there.txt")), "utf8")).toBe("theirs");

			// Keep both, for the rest.
			s.service.resolve(WRITER, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: "upload",
				action: "keep_both",
			});
			await sendFile(s, transferId, "there.txt", ours);
			const kept = await waitState(s, transferId, "there.txt", "placed");
			expect(kept).toMatchObject({ outcome: "kept_both", final_name: "there (1).txt" });
			expect(readFileSync(h.local(h.at("there (1).txt")))).toEqual(ours);
			expect(readFileSync(h.local(h.at("there.txt")), "utf8")).toBe("theirs");
			expect(temporaries(h)).toEqual([]);
		}));
});

describe.each([LOCAL_BACKEND, sftpBackend("posix", ["hardlink@openssh.com"])])(
	"a tree of 2,000 files over $name",
	(kind) => {
		it("arrives whole, every file placed once, three at a time", { timeout: 180_000 }, () =>
			on(kind, async (h, s) => {
				s.world.maxConcurrent = 3;
				const folders = Array.from({ length: 20 }, (_, i) => `d${i}`);
				const files = Array.from({ length: 2_000 }, (_, i) => ({
					path: `${folders[i % 20]}/f${i}.txt`,
					data: content(`f${i}`, 100 + (i % 7)),
				}));
				const { transferId } = await startUpload(s, h.dir, [
					...folders.map(dir),
					dir("empty"),
					...files.map(({ path, data }) => file(path, data)),
				]);
				// A window sends what the hub says is sending, as it says it.
				const sent = new Set<number>();
				const byId = new Map(files.map((entry, i) => [folders.length + 1 + i, entry]));
				while (sent.size < files.length) {
					const sending = itemsOf(s, transferId).filter(
						(item) => item.state === "sending" && !sent.has(item.item_id),
					);
					if (sending.length === 0) {
						await new Promise((resolve) => setTimeout(resolve, 5));
						continue;
					}
					expect(sending.length).toBeLessThanOrEqual(3);
					await Promise.all(
						sending.map(async (item) => {
							sent.add(item.item_id);
							const entry = byId.get(item.item_id);
							if (entry === undefined) throw new Error("no such file");
							await s.service.receive(WRITER, transferId, item.item_id, 0, entry.data);
						}),
					);
				}
				await waitFor(
					() => expect(received(s.world, WRITER.clientId, "TRANSFER_DONE")).toHaveLength(1),
					60_000,
				);
				for (const { path, data } of files.filter((_, i) => i % 97 === 0)) {
					expect(readFileSync(h.local(h.at(...path.split("/"))))).toEqual(data);
				}
				expect(readdirSync(h.local(h.at("d3")))).toHaveLength(100);
				expect(statSync(h.local(h.at("empty"))).isDirectory()).toBe(true);
				expect(Math.max(...s.world.opened.values())).toBe(1);
			}),
		);
	},
);

describe("conflicts and their answers", () => {
	const kind = LOCAL_BACKEND;

	it("merge into a folder that is there, count its conflicts, and apply an answer to everything under it", () =>
		on(kind, async (h, s) => {
			mkdirSync(h.local(h.at("photos")));
			writeFileSync(h.local(h.at("photos", "a.jpg")), "old a");
			writeFileSync(h.local(h.at("photos", "b.jpg")), "old b");
			const data = content("new");
			const { transferId, accepted } = await startUpload(s, h.dir, [
				dir("photos"),
				file("photos/a.jpg", data),
				file("photos/b.jpg", data),
				file("photos/c.jpg", data),
			]);
			expect(accepted.folderConflicts).toEqual([{ itemId: 0, conflicting: 2, total: 3 }]);
			await sendFile(s, transferId, "photos/c.jpg", data);
			const merged = await waitState(s, transferId, "photos", "placed");
			expect(merged.outcome).toBe("merged");
			s.service.resolve(WRITER, { type: "TRANSFER_RESOLVE", transferId, scope: 0, action: "skip" });
			await waitState(s, transferId, "photos/a.jpg", "skipped");
			await waitState(s, transferId, "photos/b.jpg", "skipped");
			expect(readFileSync(h.local(h.at("photos", "a.jpg")), "utf8")).toBe("old a");
			expect(itemOf(s, transferId, "photos/a.jpg").outcome).toBe("skipped");
			await waitFor(() =>
				expect(received(s.world, WRITER.clientId, "TRANSFER_DONE")).toHaveLength(1),
			);
		}));

	it("answer a type clash only with keep both or skip", () =>
		on(kind, async (h, s) => {
			writeFileSync(h.local(h.at("docs")), "a file named docs");
			mkdirSync(h.local(h.at("notes.txt")));
			const data = content("doc");
			const { transferId, accepted } = await startUpload(
				s,
				h.dir,
				[dir("docs"), file("docs/x.txt", data), file("notes.txt", data)],
				"replace",
			);
			// Replace is the policy, but replaces no folder and no file with a folder.
			expect(accepted.items).toEqual([
				expect.objectContaining({ itemId: 0, state: "conflict", typeClash: true }),
				{ itemId: 1, state: "queued" },
				expect.objectContaining({ itemId: 2, state: "conflict", typeClash: true }),
			]);
			s.service.resolve(WRITER, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: 2,
				action: "replace",
			});
			expect(received(s.world, WRITER.clientId, "TRANSFER_ERROR").at(-1)).toMatchObject({
				code: "INVALID_ACTION",
			});
			s.service.resolve(WRITER, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: 0,
				action: "keep_both",
			});
			const folder = await waitState(s, transferId, "docs", "placed");
			expect(folder).toMatchObject({ outcome: "kept_both", final_name: "docs (1)" });
			await sendFile(s, transferId, "docs/x.txt", data);
			await waitState(s, transferId, "docs/x.txt", "placed");
			expect(readFileSync(h.local(h.at("docs (1)", "x.txt")))).toEqual(data);
			expect(readFileSync(h.local(h.at("docs")), "utf8")).toBe("a file named docs");
			s.service.resolve(WRITER, { type: "TRANSFER_RESOLVE", transferId, scope: 2, action: "skip" });
			await waitState(s, transferId, "notes.txt", "skipped");
			expect(statSync(h.local(h.at("notes.txt"))).isDirectory()).toBe(true);
		}));

	it("apply skip and keep both as policies, saying each outcome", () =>
		on(kind, async (h, s) => {
			writeFileSync(h.local(h.at("a.txt")), "old");
			const data = content("a");
			const skipped = await startUpload(s, h.dir, [file("a.txt", data)], "skip");
			expect(itemOf(s, skipped.transferId, "a.txt")).toMatchObject({
				state: "skipped",
				outcome: "skipped",
			});
			const kept = await startUpload(s, h.dir, [file("a.txt", data)], "keep_both");
			await sendFile(s, kept.transferId, "a.txt", data);
			expect(await waitState(s, kept.transferId, "a.txt", "placed")).toMatchObject({
				outcome: "kept_both",
				final_name: "a (1).txt",
			});
			expect(readFileSync(h.local(h.at("a.txt")), "utf8")).toBe("old");
		}));
});

describe("retry and cancel", () => {
	const kind = LOCAL_BACKEND;

	it("cancel stops what is not placed under a scope and removes its temporaries; placed files stay", () =>
		on(kind, async (h, s) => {
			s.world.maxConcurrent = 1;
			const big = content("big", 300_000);
			const small = content("small");
			const { transferId } = await startUpload(s, h.dir, [
				file("first.txt", small),
				dir("sub"),
				file("sub/big.bin", big),
				file("sub/next.bin", small),
			]);
			await sendFile(s, transferId, "first.txt", small);
			await waitState(s, transferId, "first.txt", "placed");
			const sending = await waitState(s, transferId, "sub/big.bin", "sending");
			await s.service.receive(WRITER, transferId, sending.item_id, 0, big.subarray(0, 100_000));
			expect(temporaries(h, h.at("sub"))).toHaveLength(1);
			s.service.cancel(WRITER, { type: "TRANSFER_CANCEL", transferId, scope: 1 });
			await waitState(s, transferId, "sub/big.bin", "cancelled");
			await waitState(s, transferId, "sub/next.bin", "cancelled");
			await waitFor(() => expect(temporaries(h, h.at("sub"))).toEqual([]));
			expect(readFileSync(h.local(h.at("first.txt")))).toEqual(small);
			// A chunk after the cancel is refused, and writes nothing.
			await expect(
				s.service.receive(WRITER, transferId, sending.item_id, 100_000, big.subarray(100_000)),
			).rejects.toMatchObject({ code: "ITEM_NOT_SENDING" });
		}));

	it("retry sends again only what failed, was cancelled or interrupted: a placed file never twice", () =>
		on(kind, async (h, s) => {
			let fail = true;
			s.world.wrap = (backend) => ({
				open: async (path, options) => {
					const sink = await backend.open(path, options);
					return tamperedSink(sink, (data) =>
						fail && path.includes("flaky")
							? new FileAccessError(
									"NO_SPACE",
									"The file could not be written: the host's disk is full",
								)
							: data,
					);
				},
			});
			const data = content("d");
			const { transferId } = await startUpload(s, h.dir, [
				dir("f"),
				file("f/ok.txt", data),
				file("f/flaky.txt", data),
				file("other.txt", data),
			]);
			await sendFile(s, transferId, "f/ok.txt", data);
			await waitState(s, transferId, "f/ok.txt", "placed");
			await expect(sendFile(s, transferId, "f/flaky.txt", data)).rejects.toMatchObject({
				code: "NO_SPACE",
			});
			const failed = await waitState(s, transferId, "f/flaky.txt", "failed");
			expect(failed).toMatchObject({ code: "NO_SPACE", reason: expect.stringContaining("full") });
			await waitFor(() => expect(temporaries(h, h.at("f"))).toEqual([]));
			s.service.cancel(WRITER, { type: "TRANSFER_CANCEL", transferId, scope: 3 });
			await waitState(s, transferId, "other.txt", "cancelled");

			fail = false;
			const opensBefore = new Map(s.world.opened);
			// The folder's retry: its failed file only, never its placed one.
			await s.service.retry(WRITER, { type: "TRANSFER_RETRY", transferId, scope: 0 });
			await sendFile(s, transferId, "f/flaky.txt", data);
			await waitState(s, transferId, "f/flaky.txt", "placed");
			expect(itemOf(s, transferId, "other.txt").state).toBe("cancelled");
			// The upload's retry: the cancelled one.
			await s.service.retry(WRITER, { type: "TRANSFER_RETRY", transferId, scope: "upload" });
			await sendFile(s, transferId, "other.txt", data);
			await waitState(s, transferId, "other.txt", "placed");
			const openedAgain = [...s.world.opened].filter(
				([path, count]) => count > (opensBefore.get(path) ?? 0),
			);
			expect(openedAgain.some(([path]) => path.includes("ok.txt"))).toBe(false);
			expect(itemsOf(s, transferId).every((item) => item.state === "placed")).toBe(true);
		}));

	it("a window that leaves interrupts what it sends; the same drop again joins, skips what is placed and resumes", () =>
		on(kind, async (h, s) => {
			const placed = content("placed");
			const big = content("big", 400_000);
			const items = [file("placed.txt", placed), file("big.bin", big)];
			const { transferId } = await startUpload(s, h.dir, items);
			await sendFile(s, transferId, "placed.txt", placed);
			await waitState(s, transferId, "placed.txt", "placed");
			const sending = await waitState(s, transferId, "big.bin", "sending");
			await s.service.receive(WRITER, transferId, sending.item_id, 0, big.subarray(0, 200_000));
			s.service.clientGone(WRITER.clientId);
			const interrupted = await waitState(s, transferId, "big.bin", "interrupted");
			expect(interrupted.acked).toBe(200_000);
			expect(temporaries(h)).toHaveLength(1);

			const again = { clientId: "01HZ0000000000000000000WR2", tokenId: WRITER.tokenId };
			const joined = await startUpload(s, h.dir, [...items].reverse(), "ask", again);
			expect(joined.transferId).toBe(transferId);
			expect(joined.accepted).toMatchObject({
				joined: true,
				items: [
					{ itemId: 1, state: "queued" },
					{ itemId: 0, state: "placed" },
				],
			});
			const resumed = await waitState(s, transferId, "big.bin", "sending");
			expect(resumed.acked).toBe(200_000);
			await sendFile(s, transferId, "big.bin", big, 64 * 1024, again);
			await waitState(s, transferId, "big.bin", "placed");
			expect(readFileSync(h.local(h.at("big.bin")))).toEqual(big);
			expect(s.world.opened.get(h.at("placed.txt"))).toBeUndefined();
			expect(temporaries(h)).toEqual([]);
		}));
});

describe("the write lock", () => {
	const kind = LOCAL_BACKEND;

	it("refuses a reader's start, answer, retry and cancel", () =>
		on(kind, async (h, s) => {
			s.world.holder = WRITER.clientId;
			const refused = await refusedStart(s, h.dir, [file("x", content("x"))], READER);
			expect(refused.code).toBe("WRITE_LOCK_DENIED");
			expect(readdirSync(h.local(h.dir))).toEqual([]);
			writeFileSync(h.local(h.at("x")), "old");
			const { transferId } = await startUpload(s, h.dir, [file("x", content("x"))]);
			const before = received(s.world, READER.clientId, "TRANSFER_ERROR").length;
			s.service.resolve(READER, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: "upload",
				action: "replace",
			});
			s.service.cancel(READER, { type: "TRANSFER_CANCEL", transferId, scope: "upload" });
			await s.service.retry(READER, { type: "TRANSFER_RETRY", transferId, scope: "upload" });
			const errors = received(s.world, READER.clientId, "TRANSFER_ERROR").slice(before);
			expect(errors.map((error) => error.code)).toEqual([
				"WRITE_LOCK_DENIED",
				"WRITE_LOCK_DENIED",
				"WRITE_LOCK_DENIED",
			]);
			expect(itemOf(s, transferId, "x").state).toBe("conflict");
		}));

	it("lets what is sending finish when the lock moves, and holds the rest until it comes back", () =>
		on(kind, async (h, s) => {
			s.world.holder = WRITER.clientId;
			s.world.maxConcurrent = 1;
			const one = content("one", 150_000);
			const two = content("two");
			const { transferId } = await startUpload(s, h.dir, [file("one", one), file("two", two)]);
			const sending = await waitState(s, transferId, "one", "sending");
			await s.service.receive(WRITER, transferId, sending.item_id, 0, one.subarray(0, 50_000));
			s.world.holder = READER.clientId;
			s.service.lockChanged(CHANNEL);
			await s.service.receive(WRITER, transferId, sending.item_id, 50_000, one.subarray(50_000));
			await waitState(s, transferId, "one", "placed");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(itemOf(s, transferId, "two").state).toBe("queued");
			s.world.holder = WRITER.clientId;
			s.service.lockChanged(CHANNEL);
			await sendFile(s, transferId, "two", two);
			await waitState(s, transferId, "two", "placed");
		}));

	it("leaves an ended terminal's upload to the device that started it", () =>
		on(kind, async (h, s) => {
			writeFileSync(h.local(h.at("x")), "old");
			const { transferId } = await startUpload(s, h.dir, [file("x", content("x"))]);
			s.world.ended = true;
			s.service.resolve(READER, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: "upload",
				action: "skip",
			});
			expect(received(s.world, READER.clientId, "TRANSFER_ERROR").at(-1)?.code).toBe(
				"WRITE_LOCK_DENIED",
			);
			const sameDevice = { clientId: "01HZ0000000000000000000WR3", tokenId: WRITER.tokenId };
			s.service.resolve(sameDevice, {
				type: "TRANSFER_RESOLVE",
				transferId,
				scope: "upload",
				action: "skip",
			});
			await waitState(s, transferId, "x", "skipped");
		}));
});

describe("what a start checks before any byte moves", () => {
	it("refuses Windows names and path lengths across the whole tree, listing every one, creating nothing", async () => {
		const kind = sftpBackend("windows", ["hardlink@openssh.com"]);
		await on(kind, async (h, s) => {
			const refused = await refusedStart(s, h.dir, [
				dir("ok"),
				file("ok/fine.txt", content("f")),
				file("ok/CON.txt", content("c")),
				file("trailing.", content("t")),
				file("what?.txt", content("w")),
				dir("ok/deep"),
				file(`ok/deep/${"x".repeat(250)}.txt`, content("l")),
			]);
			expect(refused.code).toBe("INVALID_NAMES");
			expect((refused.names as { relPath: string }[]).map((name) => name.relPath).sort()).toEqual(
				["ok/CON.txt", `ok/deep/${"x".repeat(250)}.txt`, "trailing.", "what?.txt"].sort(),
			);
			expect(readdirSync(h.local(h.dir))).toEqual([]);
		});
	});

	it("refuses a tree that names no folder for an item, or a name twice", () =>
		on(LOCAL_BACKEND, async (h, s) => {
			const orphan = await refusedStart(s, h.dir, [file("nowhere/x", content("x"))]);
			expect(orphan).toMatchObject({ code: "INVALID_ITEMS", names: [{ relPath: "nowhere/x" }] });
			const twice = await refusedStart(s, h.dir, [
				file("x", content("x")),
				file("x", content("x")),
			]);
			expect(twice.code).toBe("INVALID_ITEMS");
			const dots = await refusedStart(s, h.dir, [file("../x", content("x"))]);
			expect(dots.code).toBe("INVALID_ITEMS");
		}));

	it("refuses an upload the host has no room for", () =>
		on(LOCAL_BACKEND, async (h, s) => {
			s.world.wrap = () => ({ freeSpace: async () => ({ available: 10, total: 100 }) });
			const refused = await refusedStart(s, h.dir, [file("x", content("x"))]);
			expect(refused.code).toBe("INSUFFICIENT_SPACE");
			expect(readdirSync(h.local(h.dir))).toEqual([]);
		}));
});

describe.each(RUNNING.filter((kind) => kind.transport === "exec"))(
	"verification over $name",
	(kind) => {
		it("fails a file whose bytes on the host are not what was sent, before it is placed; off, checks its size", () =>
			on(kind, async (h, s) => {
				const changeOne = (data: Buffer) => {
					const changed = Buffer.from(data);
					changed[10] = (changed[10] ?? 0) ^ 0xff;
					return changed;
				};
				s.world.wrap = (backend) => ({
					open: async (path, options) => tamperedSink(await backend.open(path, options), changeOne),
				});
				const data = content("v");
				const { transferId } = await startUpload(s, h.dir, [file("v.bin", data)]);
				await sendFile(s, transferId, "v.bin", data);
				const failed = await waitState(s, transferId, "v.bin", "failed");
				expect(failed.code).toBe("HASH_MISMATCH");
				expect(existsSync(h.local(h.at("v.bin")))).toBe(false);
				await waitFor(() => expect(temporaries(h)).toEqual([]));

				s.world.verify = false;
				const unchecked = await startUpload(s, h.dir, [file("v.bin", data)]);
				await sendFile(s, unchecked.transferId, "v.bin", data);
				expect(await waitState(s, unchecked.transferId, "v.bin", "placed")).toMatchObject({
					verification: "size",
				});
			}));
	},
);

describe("holding the host's connection", () => {
	it("counts an upload as running from its start to its end, then says the host is idle", () =>
		on(sftpBackend("posix", ["hardlink@openssh.com"]), async (h, s) => {
			const data = content("x");
			const { transferId } = await startUpload(s, h.dir, [file("x", data)]);
			expect(s.service.activeOn("01HZ0000000000000000000HO1")).toBe(1);
			expect(s.world.idle).toEqual([]);
			await sendFile(s, transferId, "x", data);
			await waitState(s, transferId, "x", "placed");
			await waitFor(() => expect(s.world.idle).toEqual(["01HZ0000000000000000000HO1"]));
			expect(s.service.activeOn("01HZ0000000000000000000HO1")).toBe(0);
		}));

	it("interrupts what runs when the connection is closed on purpose, and resumes it on a retry", () =>
		on(sftpBackend("posix", ["hardlink@openssh.com"]), async (h, s) => {
			const big = content("big", 300_000);
			const { transferId } = await startUpload(s, h.dir, [file("big", big)]);
			const sending = await waitState(s, transferId, "big", "sending");
			await s.service.receive(WRITER, transferId, sending.item_id, 0, big.subarray(0, 100_000));
			s.service.interruptOn("01HZ0000000000000000000HO1");
			expect(itemOf(s, transferId, "big")).toMatchObject({ state: "interrupted", acked: 100_000 });
			expect(s.service.activeOn("01HZ0000000000000000000HO1")).toBe(0);
			await s.service.retry(WRITER, { type: "TRANSFER_RETRY", transferId, scope: "upload" });
			const resumed = await waitState(s, transferId, "big", "sending");
			expect(resumed.acked).toBe(100_000);
			await sendFile(s, transferId, "big", big);
			await waitState(s, transferId, "big", "placed");
			expect(readFileSync(h.local(h.at("big")))).toEqual(big);
		}));
});
