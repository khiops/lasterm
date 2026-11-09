/**
 * Uploads that survive a hub restart (#860): kept in meta.db, brought back
 * interrupted, resumed from what each host acknowledged, discarded, expired,
 * and the sweep of temporaries nobody knows.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TransferStartItem } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LOCAL_BACKEND,
	sftpBackend,
	UPLOAD_BACKENDS,
	type UploadBackendKind,
	type UploadHarness,
} from "../files/upload-backends.fixture.js";
import { type DatabaseManager, openDatabases, openTestDatabases } from "../storage/db.js";
import { TransfersDAL } from "../storage/transfers-dal.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import {
	CHANNEL,
	HOST,
	itemOf,
	received,
	type Service,
	sendFile,
	serviceOn,
	startUpload,
	WRITER,
	waitFor,
	waitState,
} from "./transfer-service.fixture.js";
import { ACKED_PERSIST_BYTES, ACKED_PERSIST_MS, SWEEP_MIN_AGE_MS } from "./transfer-service.js";

const MTIME = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60_000;

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

/** Another window of the device that started the uploads, as after a reload or a restart. */
const AGAIN = { clientId: "01HZ0000000000000000000WR9", tokenId: WRITER.tokenId };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A host of `kind`, cleaned up after the test. */
async function hostOf(kind: UploadBackendKind): Promise<UploadHarness> {
	const h = await kind.start();
	cleanups.push(() => h.close());
	return h;
}

/** The host row the uploads' rows refer to. */
function addHost(dbs: DatabaseManager, kind: UploadBackendKind, id = HOST): void {
	const at = new Date().toISOString();
	dbs.meta
		.prepare("INSERT INTO hosts (id, type, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
		.run(id, kind.transport === "local" ? "local" : "ssh", `host-${id}`, at, at);
}

/** A transfer service keeping its uploads in `dbs`, stopped after the test. */
function keptOn(
	h: UploadHarness,
	kind: UploadBackendKind,
	dbs: DatabaseManager,
	world?: Service["world"],
): Service {
	const s = serviceOn(h, kind, { store: new TransfersDAL(dbs.meta), ...(world ? { world } : {}) });
	cleanups.push(() => s.service.shutdown());
	return s;
}

function rowOf(dbs: DatabaseManager, transferId: string, relPath: string) {
	return dbs.meta
		.prepare("SELECT * FROM transfer_items WHERE transfer_id = ? AND rel_path = ?")
		.get(transferId, relPath) as { acked_offset: number; state: string; temp_path: string | null };
}

function transferRow(dbs: DatabaseManager, transferId: string) {
	return dbs.meta.prepare("SELECT * FROM transfers WHERE id = ?").get(transferId) as
		| { state: string; reason: string | null; updated_at: string }
		| undefined;
}

/** The temporaries left in a folder of the host. */
function temporaries(h: UploadHarness, path = h.dir): string[] {
	return readdirSync(h.local(path)).filter((name) => name.endsWith(".partial"));
}

/** Do something to a file until whatever held it lets go, for 15 s at most. */
async function retrying(action: () => void): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			action();
			return;
		} catch (error) {
			if (attempt >= 150) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

/** Send `bytes` of a file the hub says is sending, from where its host's bytes end. */
async function sendPart(
	s: Service,
	transferId: string,
	relPath: string,
	data: Buffer,
	bytes: number,
): Promise<void> {
	const item = await waitState(s, transferId, relPath, "sending");
	const from = item.acked ?? 0;
	for (let at = from; at < from + bytes; at += 50_000) {
		const end = Math.min(at + 50_000, from + bytes);
		await s.service.receive(WRITER, transferId, item.item_id, at, data.subarray(at, end));
	}
}

const RUNNING = UPLOAD_BACKENDS.filter((kind) => kind.runs);

describe.each(RUNNING)("a hub restart, over $name", (kind) => {
	it("finds its uploads interrupted; a resume cuts each temporary to what the host acknowledged, starts again a file whose temporary is missing or short, and never touches a placed file", {
		timeout: 180_000,
	}, async () => {
		const h = await hostOf(kind);
		const stateDir = makeTempDir("lasterm-transfer-restart-");
		cleanups.push(() => removeTempDir(stateDir));
		const first = openDatabases(stateDir);
		cleanups.push(async () => {
			if (first.meta.open) await first.close();
		});
		addHost(first, kind);
		const s1 = serviceOn(h, kind, { store: new TransfersDAL(first.meta) });
		cleanups.push(() => s1.service.shutdown());
		s1.world.maxConcurrent = 4;
		const data = {
			placed: content("placed"),
			partial: content("partial", 300_000),
			missing: content("missing", 200_000),
			short: content("short", 200_000),
			later: content("later"),
		};
		const { transferId } = await startUpload(s1, h.dir, [
			dir("tree"),
			dir("tree/empty"),
			file("tree/placed.txt", data.placed),
			file("tree/partial.bin", data.partial),
			file("tree/missing.bin", data.missing),
			file("tree/short.bin", data.short),
			file("later.txt", data.later),
		]);
		await sendFile(s1, transferId, "tree/placed.txt", data.placed);
		await waitState(s1, transferId, "tree/placed.txt", "placed");
		const placedPath = h.local(h.at("tree", "placed.txt"));
		const placedBefore = { mtime: statSync(placedPath).mtimeMs, bytes: readFileSync(placedPath) };
		for (const name of ["partial", "missing", "short"] as const) {
			await sendPart(s1, transferId, `tree/${name}.bin`, data[name], 100_000);
		}
		// The timed write: what each host acknowledged reaches meta.db.
		await waitFor(() => {
			for (const name of ["partial", "missing", "short"]) {
				expect(rowOf(first, transferId, `tree/${name}.bin`).acked_offset).toBe(100_000);
			}
		}, ACKED_PERSIST_MS * 3);
		// More of one, which meta.db does not hold yet when the hub dies.
		await sendPart(s1, transferId, "tree/partial.bin", data.partial, 100_000);
		expect(rowOf(first, transferId, "tree/partial.bin").acked_offset).toBe(100_000);
		const partialTemp = rowOf(first, transferId, "tree/partial.bin").temp_path as string;
		// Over SSH commands a chunk is answered once the connection took it: the host catches up.
		await waitFor(() => expect(statSync(h.local(partialTemp)).size).toBe(200_000));
		const temps = {
			missing: rowOf(first, transferId, "tree/missing.bin").temp_path as string,
			short: rowOf(first, transferId, "tree/short.bin").temp_path as string,
		};
		// Killed: nothing more reaches meta.db, and its writes on the host stop. meta.db
		// closes in this turn, before shutdown(), as a kill would leave it: close() waits
		// for the spool's checkpoint worker before closing either database, and a timer
		// could persist the acknowledgements meanwhile.
		first.meta.close();
		const closed = first.close();
		s1.service.shutdown();
		await closed;

		// Meanwhile, on the host: one temporary went, another was cut short. A
		// command of the hub that died may hold them a moment longer.
		await retrying(() => rmSync(h.local(temps.missing)));
		await retrying(() => truncateSync(h.local(temps.short), 50_000));
		const second = openDatabases(stateDir);
		cleanups.push(() => second.close());

		const s2 = keptOn(h, kind, second);
		s2.world.maxConcurrent = 4;
		s2.service.restore();
		expect(s2.service.listFor()).toEqual([
			expect.objectContaining({
				transfer_id: transferId,
				channel_id: CHANNEL,
				state: "interrupted",
			}),
		]);
		expect(s2.service.interruptedUploads()).toEqual([
			expect.objectContaining({ transferId, state: "interrupted", dir: h.dir }),
		]);
		expect(transferRow(second, transferId)?.state).toBe("interrupted");
		expect(itemOf(s2, transferId, "tree/partial.bin")).toMatchObject({
			state: "interrupted",
			acked: 100_000,
		});
		expect(itemOf(s2, transferId, "tree/placed.txt").state).toBe("placed");
		// Nothing reaches the host by itself after a restart.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(statSync(h.local(partialTemp)).size).toBe(200_000);
		expect(s2.world.opened.size).toBe(0);

		await s2.service.resume(AGAIN, { type: "TRANSFER_RESUME", transferIds: [transferId] });
		// Cut to the prefix the host acknowledged, before any byte moves.
		expect(statSync(h.local(partialTemp)).size).toBe(100_000);
		const partial = await waitState(s2, transferId, "tree/partial.bin", "sending");
		expect(partial.acked).toBe(100_000);
		expect(itemOf(s2, transferId, "tree/missing.bin").acked).toBe(0);
		expect(itemOf(s2, transferId, "tree/short.bin").acked).toBe(0);
		await waitFor(() =>
			expect(received(s2.world, AGAIN.clientId, "TRANSFER_STATE")).toContainEqual(
				expect.objectContaining({ transferId, state: "running" }),
			),
		);

		for (const name of ["partial", "missing", "short"] as const) {
			await sendFile(s2, transferId, `tree/${name}.bin`, data[name], 64 * 1024, AGAIN);
		}
		await sendFile(s2, transferId, "later.txt", data.later, 64 * 1024, AGAIN);
		await waitFor(() =>
			expect(received(s2.world, AGAIN.clientId, "TRANSFER_DONE")).toHaveLength(1),
		);
		for (const name of ["partial", "missing", "short"] as const) {
			expect(readFileSync(h.local(h.at("tree", `${name}.bin`)))).toEqual(data[name]);
			expect(itemOf(s2, transferId, `tree/${name}.bin`).state).toBe("placed");
		}
		expect(readFileSync(h.local(h.at("later.txt")))).toEqual(data.later);
		expect(statSync(h.local(h.at("tree", "empty"))).isDirectory()).toBe(true);
		// The placed file was never opened again, nor changed.
		expect(s2.world.opened.get(h.at("tree", "placed.txt"))).toBeUndefined();
		expect(statSync(placedPath).mtimeMs).toBe(placedBefore.mtime);
		expect(readFileSync(placedPath)).toEqual(placedBefore.bytes);
		expect(temporaries(h)).toEqual([]);
		expect(temporaries(h, h.at("tree"))).toEqual([]);
		if (kind.transport === "exec") {
			// Its first bytes went through the hub that died, which took their hash with it.
			expect(itemOf(s2, transferId, "tree/partial.bin").verification).toBe("size_resumed");
			expect(itemOf(s2, transferId, "tree/missing.bin").verification).toBe("sha256");
		}
		await waitFor(() => expect(transferRow(second, transferId)?.state).toBe("done"));
	});
});

describe("what reaches meta.db, and when", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Let what the hub queued run, the host's own I/O included. */
	async function idle(rounds = 20): Promise<void> {
		for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
	}

	it("writes a state change at once, a file's acknowledged bytes every 8 MiB or 2 s, and everything when the hub stops", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const h = await hostOf(LOCAL_BACKEND);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, LOCAL_BACKEND);
		const s = serviceOn(h, LOCAL_BACKEND, { store: new TransfersDAL(dbs.meta) });
		cleanups.push(() => s.service.shutdown());
		const MiB = 1024 * 1024;
		const data = content("big", 10 * MiB);
		const { transferId } = await startUpload(s, h.dir, [file("big.bin", data)]);
		const acked = () => rowOf(dbs, transferId, "big.bin").acked_offset;
		const state = () => rowOf(dbs, transferId, "big.bin").state;
		const send = async (from: number, to: number) => {
			await s.service.receive(WRITER, transferId, 0, from, data.subarray(from, to));
			await idle();
		};
		const opened = () =>
			state() === "sending" && rowOf(dbs, transferId, "big.bin").temp_path !== null;
		for (let i = 0; i < 500 && !opened(); i++) await idle(1);
		// Known before a byte is written: what it is, and its temporary.
		expect(opened()).toBe(true);

		for (let at = 0; at < 7 * MiB; at += MiB) await send(at, at + MiB);
		expect(acked()).toBe(0);
		// 8 MiB more than meta.db holds: written at once.
		await send(7 * MiB, 8 * MiB);
		expect(acked()).toBe(ACKED_PERSIST_BYTES);
		await send(8 * MiB, 9 * MiB);
		expect(acked()).toBe(8 * MiB);
		// The rest within 2 s.
		vi.advanceTimersByTime(ACKED_PERSIST_MS - 1);
		await idle();
		expect(acked()).toBe(8 * MiB);
		vi.advanceTimersByTime(1);
		await idle();
		expect(acked()).toBe(9 * MiB);
		// And what is left when the hub stops.
		await send(9 * MiB, 9 * MiB + 512 * 1024);
		expect(acked()).toBe(9 * MiB);
		s.service.shutdown();
		expect(acked()).toBe(9 * MiB + 512 * 1024);
	});
});

describe("resuming through the interactive Connect", () => {
	/** An upload left interrupted to an SSH host, partly sent. */
	async function interruptedUpload(h: UploadHarness, s: Service): Promise<string> {
		const data = content("x", 200_000);
		const { transferId } = await startUpload(s, h.dir, [file("x.bin", data)]);
		await sendPart(s, transferId, "x.bin", data, 100_000);
		s.service.clientGone(WRITER.clientId);
		await waitState(s, transferId, "x.bin", "interrupted");
		return transferId;
	}

	it("keeps an upload resumable, saying why, when the passphrase prompt is cancelled; the next resume asks again", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s = keptOn(h, kind, dbs);
		const transferId = await interruptedUpload(h, s);
		s.world.away.add(HOST);
		s.world.connect = async () => ({ connected: false, reason: "needs_passphrase" });

		await s.service.resume(AGAIN, { type: "TRANSFER_RESUME", transferIds: [transferId] });
		expect(s.world.connects).toEqual([HOST]);
		expect(received(s.world, AGAIN.clientId, "TRANSFER_STATE").at(-1)).toEqual({
			type: "TRANSFER_STATE",
			transferId,
			channelId: CHANNEL,
			hostId: HOST,
			state: "interrupted",
			reason: "needs_passphrase",
		});
		expect(itemOf(s, transferId, "x.bin")).toMatchObject({ state: "interrupted", acked: 100_000 });
		expect(s.service.listFor(CHANNEL)).toEqual([
			expect.objectContaining({ state: "interrupted", reason: "needs_passphrase" }),
		]);
		expect(s.service.interruptedUploads()).toEqual([
			expect.objectContaining({ transferId, reason: "needs_passphrase" }),
		]);
		await waitFor(() => expect(transferRow(dbs, transferId)?.reason).toBe("needs_passphrase"));
		expect(temporaries(h)).toHaveLength(1);

		// Asked again, and answered this time.
		s.world.connect = null;
		await s.service.resume(AGAIN, { type: "TRANSFER_RESUME", transferIds: [transferId] });
		expect(s.world.connects).toEqual([HOST, HOST]);
		const resumed = await waitState(s, transferId, "x.bin", "sending");
		expect(resumed.acked).toBe(100_000);
		await waitFor(() => expect(transferRow(dbs, transferId)?.reason).toBeNull());
		expect(s.service.listFor(CHANNEL)[0]).not.toHaveProperty("reason");
	});

	it("goes host by host for Resume all, one question at a time: the second host cancelled, the first and third resume", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const s = serviceOn(h, kind);
		cleanups.push(() => s.service.shutdown());
		const hosts = [
			"01HZ0000000000000000000HA1",
			"01HZ0000000000000000000HA2",
			"01HZ0000000000000000000HA3",
		];
		const channels = [
			"01HZ0000000000000000000CA1",
			"01HZ0000000000000000000CA2",
			"01HZ0000000000000000000CA3",
		];
		const ids: string[] = [];
		const data = content("y", 120_000);
		s.world.maxConcurrent = 3;
		for (const [i, host] of hosts.entries()) {
			const channel = channels[i] as string;
			s.world.hostOf.set(channel, host);
			mkdirSync(h.local(h.at(`d${i}`)));
			const { transferId } = await startUpload(
				s,
				h.at(`d${i}`),
				[file("y.bin", data)],
				"ask",
				WRITER,
				channel,
			);
			await sendPart(s, transferId, "y.bin", data, 50_000);
			ids.push(transferId);
		}
		s.service.clientGone(WRITER.clientId);
		for (const id of ids) await waitState(s, id, "y.bin", "interrupted");
		for (const host of hosts) s.world.away.add(host);
		let asking = 0;
		let most = 0;
		s.world.connect = async (hostId) => {
			asking++;
			most = Math.max(most, asking);
			await new Promise((resolve) => setTimeout(resolve, 30));
			asking--;
			if (hostId === hosts[1]) return { connected: false, reason: "needs_passphrase" };
			s.world.away.delete(hostId);
			return { connected: true };
		};

		await s.service.resume(AGAIN, { type: "TRANSFER_RESUME", transferIds: ids });
		expect(s.world.connects).toEqual(hosts);
		expect(most).toBe(1);
		const [one, two, three] = ids as [string, string, string];
		expect((await waitState(s, one, "y.bin", "sending")).acked).toBe(50_000);
		expect((await waitState(s, three, "y.bin", "sending")).acked).toBe(50_000);
		expect(itemOf(s, two, "y.bin")).toMatchObject({ state: "interrupted", acked: 50_000 });
		expect(s.service.interruptedUploads()).toEqual([
			expect.objectContaining({ transferId: two, reason: "needs_passphrase" }),
		]);
	});

	it("refuses a resume from another device: only the one that started it holds its files", async () => {
		const kind = LOCAL_BACKEND;
		const h = await hostOf(kind);
		const s = serviceOn(h, kind);
		cleanups.push(() => s.service.shutdown());
		const transferId = await interruptedUpload(h, s);
		const other = { clientId: "01HZ0000000000000000000OT1", tokenId: "tok-other" };
		await s.service.resume(other, { type: "TRANSFER_RESUME", transferIds: [transferId] });
		expect(received(s.world, other.clientId, "TRANSFER_ERROR").at(-1)).toMatchObject({
			transferId,
			code: "NOT_THE_SENDER",
		});
		expect(itemOf(s, transferId, "x.bin").state).toBe("interrupted");
	});
});

describe("what the resuming window found of its files (#837)", () => {
	/** An upload the window left, one file of it partly sent. */
	async function leftUpload(s: Service, h: UploadHarness): Promise<string> {
		const data = content("x", 200_000);
		const { transferId } = await startUpload(s, h.dir, [file("x.bin", data)]);
		await sendPart(s, transferId, "x.bin", data, 100_000);
		s.service.clientGone(WRITER.clientId);
		await waitState(s, transferId, "x.bin", "interrupted");
		return transferId;
	}

	it("leaves out a file gone from the device, sends one that changed again from its first byte as it is now, and the rest from where the host's bytes end", async () => {
		const kind = LOCAL_BACKEND;
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s = keptOn(h, kind, dbs);
		s.world.maxConcurrent = 3;
		const data = {
			kept: content("kept", 200_000),
			gone: content("gone", 100_000),
			changed: content("changed", 150_000),
		};
		const { transferId } = await startUpload(s, h.dir, [
			dir("d"),
			file("d/kept.bin", data.kept),
			file("d/gone.bin", data.gone),
			file("d/changed.bin", data.changed),
		]);
		for (const name of ["kept", "gone", "changed"] as const) {
			await sendPart(s, transferId, `d/${name}.bin`, data[name], 50_000);
		}
		s.service.clientGone(WRITER.clientId);
		for (const name of ["kept", "gone", "changed"]) {
			await waitState(s, transferId, `d/${name}.bin`, "interrupted");
		}
		expect(temporaries(h, h.at("d"))).toHaveLength(3);
		const now = content("changed, as it is now", 80_000);
		const gone = itemOf(s, transferId, "d/gone.bin").item_id;
		const changed = itemOf(s, transferId, "d/changed.bin").item_id;

		await s.service.resume(AGAIN, {
			type: "TRANSFER_RESUME",
			transferIds: [transferId],
			files: [
				{ transferId, itemId: gone, action: "skip", why: "gone" },
				{ transferId, itemId: changed, action: "restart", size: now.length, mtime: MTIME + 60_000 },
			],
		});
		expect(itemOf(s, transferId, "d/gone.bin")).toMatchObject({
			state: "skipped",
			outcome: "skipped",
			reason: "no longer on the device that sent it",
		});
		// The one that changed starts again with its size now; the other goes on from its bytes.
		expect((await waitState(s, transferId, "d/changed.bin", "sending")).acked).toBe(0);
		expect((await waitState(s, transferId, "d/kept.bin", "sending")).acked).toBe(50_000);
		expect(s.service.describe(transferId)?.totals).toMatchObject({
			files: 3,
			bytes: data.kept.length + data.gone.length + now.length,
		});
		await expect(
			s.service.receive(AGAIN, transferId, changed, 0, data.changed.subarray(0, now.length + 1)),
		).rejects.toMatchObject({ code: "PAST_END" });
		await sendFile(s, transferId, "d/kept.bin", data.kept, 64 * 1024, AGAIN);
		await sendFile(s, transferId, "d/changed.bin", now, 64 * 1024, AGAIN);
		await waitState(s, transferId, "d/kept.bin", "placed");
		await waitState(s, transferId, "d/changed.bin", "placed");
		expect(readFileSync(h.local(h.at("d", "kept.bin")))).toEqual(data.kept);
		expect(readFileSync(h.local(h.at("d", "changed.bin")))).toEqual(now);
		expect(statSync(h.local(h.at("d", "changed.bin"))).mtimeMs).toBe(MTIME + 60_000);
		expect(existsSync(h.local(h.at("d", "gone.bin")))).toBe(false);
		await waitFor(() => expect(temporaries(h, h.at("d"))).toEqual([]));
		// meta.db holds the file as it was sent: a restart meanwhile resumes that one.
		const row = dbs.meta
			.prepare("SELECT size, mtime, reason FROM transfer_items WHERE transfer_id = ? AND id = ?")
			.get(transferId, changed) as { size: number; mtime: number };
		expect(row).toMatchObject({ size: now.length, mtime: MTIME + 60_000 });
		const skipped = dbs.meta
			.prepare("SELECT state, reason FROM transfer_items WHERE transfer_id = ? AND id = ?")
			.get(transferId, gone);
		expect(skipped).toEqual({ state: "skipped", reason: "no longer on the device that sent it" });
	});

	it("refuses files that are not as the protocol says, and resumes nothing", async () => {
		const kind = LOCAL_BACKEND;
		const h = await hostOf(kind);
		const s = serviceOn(h, kind);
		cleanups.push(() => s.service.shutdown());
		const transferId = await leftUpload(s, h);
		for (const files of [
			"x",
			[{ transferId, itemId: 0, action: "restart", size: -1 }],
			[{ transferId, itemId: 0, action: "restart" }],
			[{ transferId, itemId: 0, action: "restart", size: 10, mtime: "today" }],
			[{ transferId, itemId: 0, action: "skip", why: "bored" }],
			[{ transferId, itemId: -1, action: "skip", why: "gone" }],
			[{ transferId, itemId: 0, action: "replace" }],
		]) {
			await s.service.resume(AGAIN, {
				type: "TRANSFER_RESUME",
				transferIds: [transferId],
				files,
			} as never);
			expect(received(s.world, AGAIN.clientId, "TRANSFER_ERROR").at(-1)).toMatchObject({
				code: "INVALID_INPUT",
			});
		}
		expect(received(s.world, AGAIN.clientId, "TRANSFER_ERROR")).toHaveLength(7);
		expect(received(s.world, AGAIN.clientId, "TRANSFER_STATE")).toEqual([]);
		expect(itemOf(s, transferId, "x.bin")).toMatchObject({ state: "interrupted", acked: 100_000 });
	});

	it("says to each window whether an upload is from its device, and names the device otherwise", async () => {
		const kind = LOCAL_BACKEND;
		const h = await hostOf(kind);
		const s = serviceOn(h, kind);
		cleanups.push(() => s.service.shutdown());
		const device = WRITER.tokenId as string;
		s.world.deviceLabels.set(device, "Paired from 192.168.1.20");
		const transferId = await leftUpload(s, h);

		const own = s.service.interruptedUploads(device);
		expect(own).toEqual([expect.objectContaining({ transferId, fromThisDevice: true })]);
		expect(own[0]).not.toHaveProperty("deviceLabel");
		expect(s.service.interruptedUploads("tok-other")).toEqual([
			expect.objectContaining({
				transferId,
				fromThisDevice: false,
				deviceLabel: "Paired from 192.168.1.20",
			}),
		]);
		expect(s.service.listFor(CHANNEL, "tok-other")[0]).toMatchObject({
			from_this_device: false,
			device_label: "Paired from 192.168.1.20",
		});
		expect(s.service.listFor(undefined, device)[0]).toMatchObject({ from_this_device: true });
		expect(s.service.describe(transferId, device)).toMatchObject({ from_this_device: true });
		expect(s.service.describe(transferId, "tok-other")).toMatchObject({
			from_this_device: false,
			device_label: "Paired from 192.168.1.20",
		});
		// A device without a name is named by none.
		s.world.deviceLabels.set(device, "");
		expect(s.service.interruptedUploads("tok-other")[0]).not.toHaveProperty("deviceLabel");
	});
});

describe("a dropped link", () => {
	it("resumes by itself when the hub reconnects the host, for an upload whose window is still there", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const s = serviceOn(h, kind);
		cleanups.push(() => s.service.shutdown());
		const data = content("dropped", 300_000);
		const { transferId } = await startUpload(s, h.dir, [file("dropped.bin", data)]);
		await sendPart(s, transferId, "dropped.bin", data, 100_000);
		s.world.linkDown = true;
		const item = itemOf(s, transferId, "dropped.bin");
		await expect(
			s.service.receive(WRITER, transferId, item.item_id, 100_000, data.subarray(100_000, 150_000)),
		).rejects.toMatchObject({ code: "HOST_NOT_CONNECTED" });
		expect(itemOf(s, transferId, "dropped.bin")).toMatchObject({
			state: "interrupted",
			acked: 100_000,
		});

		// The hub's own reconnect: nobody asked for anything.
		s.world.linkDown = false;
		s.service.hostConnected(HOST);
		const resumed = await waitState(s, transferId, "dropped.bin", "sending");
		expect(resumed.acked).toBe(100_000);
		expect(s.world.connects).toEqual([]);
		await sendFile(s, transferId, "dropped.bin", data);
		await waitState(s, transferId, "dropped.bin", "placed");
		expect(readFileSync(h.local(h.at("dropped.bin")))).toEqual(data);
	});

	it("leaves alone an upload a restart or a closed connection interrupted", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s1 = serviceOn(h, kind, { store: new TransfersDAL(dbs.meta) });
		const data = content("left", 300_000);
		const restarted = await startUpload(s1, h.dir, [file("left.bin", data)]);
		await sendPart(s1, restarted.transferId, "left.bin", data, 100_000);
		s1.service.shutdown();
		const s2 = keptOn(h, kind, dbs);
		s2.service.restore();
		// One the person disconnected on purpose, its window still there.
		mkdirSync(h.local(h.at("other")));
		const closed = await startUpload(s2, h.at("other"), [file("left.bin", data)], "ask", AGAIN);
		await waitState(s2, closed.transferId, "left.bin", "sending");
		s2.service.interruptOn(HOST);

		s2.service.hostConnected(HOST);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(itemOf(s2, restarted.transferId, "left.bin").state).toBe("interrupted");
		expect(itemOf(s2, closed.transferId, "left.bin").state).toBe("interrupted");
		expect(s2.world.opened.size).toBe(1);
	});
});

describe("Discard", () => {
	it("removes an upload's temporaries and its record; placed files stay", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s = keptOn(h, kind, dbs);
		const kept = content("kept");
		const big = content("big", 200_000);
		const { transferId } = await startUpload(s, h.dir, [
			file("kept.txt", kept),
			file("big.bin", big),
		]);
		await sendFile(s, transferId, "kept.txt", kept);
		await waitState(s, transferId, "kept.txt", "placed");
		await sendPart(s, transferId, "big.bin", big, 100_000);
		s.service.clientGone(WRITER.clientId);
		await waitState(s, transferId, "big.bin", "interrupted");
		expect(temporaries(h)).toHaveLength(1);

		await s.service.discard(AGAIN, { type: "TRANSFER_DISCARD", transferIds: [transferId] });
		expect(temporaries(h)).toEqual([]);
		expect(readFileSync(h.local(h.at("kept.txt")))).toEqual(kept);
		expect(transferRow(dbs, transferId)).toBeUndefined();
		expect(s.service.listFor()).toEqual([]);
		expect(s.service.describe(transferId)).toBeNull();
		expect(received(s.world, AGAIN.clientId, "TRANSFER_STATE").at(-1)).toMatchObject({
			transferId,
			state: "discarded",
		});
	});

	it("marks an upload to a host it cannot reach for removal at the next connection, a restart between", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s1 = serviceOn(h, kind, { store: new TransfersDAL(dbs.meta) });
		const big = content("big", 200_000);
		const { transferId } = await startUpload(s1, h.dir, [file("big.bin", big)]);
		await sendPart(s1, transferId, "big.bin", big, 100_000);
		s1.service.clientGone(WRITER.clientId);
		await waitState(s1, transferId, "big.bin", "interrupted");
		s1.world.away.add(HOST);
		s1.world.connect = async () => ({ connected: false, reason: "host_unreachable" });

		await s1.service.discard(AGAIN, { type: "TRANSFER_DISCARD", transferIds: [transferId] });
		expect(s1.world.connects).toEqual([HOST]);
		expect(temporaries(h)).toHaveLength(1);
		expect(transferRow(dbs, transferId)?.state).toBe("discarded");
		expect(s1.service.listFor()).toEqual([]);
		s1.service.shutdown();

		// The next hub knows what is to be removed there, and removes it once the host is back.
		const s2 = keptOn(h, kind, dbs);
		s2.world.away.add(HOST);
		s2.service.restore();
		expect(s2.service.listFor()).toEqual([]);
		s2.service.hostConnected(HOST);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(temporaries(h)).toHaveLength(1);
		s2.world.away.delete(HOST);
		s2.service.hostConnected(HOST);
		await waitFor(() => expect(temporaries(h)).toEqual([]));
		await waitFor(() => expect(transferRow(dbs, transferId)).toBeUndefined());
	});
});

describe("the 7-day expiry", () => {
	it("discards an upload interrupted for 7 days when the hub starts, removing its temporaries", async () => {
		const kind = LOCAL_BACKEND;
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s1 = serviceOn(h, kind, { store: new TransfersDAL(dbs.meta) });
		const big = content("big", 200_000);
		const { transferId } = await startUpload(s1, h.dir, [file("big.bin", big)]);
		await sendPart(s1, transferId, "big.bin", big, 100_000);
		s1.service.clientGone(WRITER.clientId);
		await waitState(s1, transferId, "big.bin", "interrupted");
		s1.service.shutdown();
		expect(transferRow(dbs, transferId)?.state).toBe("interrupted");

		const s2 = keptOn(h, kind, dbs);
		s2.world.now = Date.parse(transferRow(dbs, transferId)?.updated_at ?? "") + 7 * DAY_MS - 60_000;
		s2.service.restore();
		// A minute short of 7 days: kept.
		expect(s2.service.listFor()).toHaveLength(1);
		s2.service.shutdown();

		const s3 = keptOn(h, kind, dbs);
		s3.world.now = Date.parse(transferRow(dbs, transferId)?.updated_at ?? "") + 7 * DAY_MS;
		s3.service.restore();
		expect(s3.service.listFor()).toEqual([]);
		await waitFor(() => expect(temporaries(h)).toEqual([]));
		await waitFor(() => expect(transferRow(dbs, transferId)).toBeUndefined());
	});

	it("discards one nobody resumed while the hub runs, its temporaries removed at the host's next connection", async () => {
		const kind = sftpBackend("posix", ["hardlink@openssh.com"]);
		const h = await hostOf(kind);
		const dbs = openTestDatabases();
		cleanups.push(() => dbs.close());
		addHost(dbs, kind);
		const s = keptOn(h, kind, dbs);
		const big = content("big", 200_000);
		const { transferId } = await startUpload(s, h.dir, [file("big.bin", big)]);
		await sendPart(s, transferId, "big.bin", big, 100_000);
		s.service.clientGone(WRITER.clientId);
		await waitState(s, transferId, "big.bin", "interrupted");
		await waitFor(() => expect(transferRow(dbs, transferId)?.state).toBe("interrupted"));
		const since = Date.parse(transferRow(dbs, transferId)?.updated_at ?? "");
		s.world.away.add(HOST);

		s.world.now = since + 7 * DAY_MS - 1;
		s.service.expire();
		expect(s.service.listFor()).toHaveLength(1);
		s.world.now = since + 7 * DAY_MS;
		s.service.expire();
		expect(s.service.listFor()).toEqual([]);
		expect(transferRow(dbs, transferId)?.state).toBe("discarded");
		expect(temporaries(h)).toHaveLength(1);
		s.world.away.delete(HOST);
		s.service.hostConnected(HOST);
		await waitFor(() => expect(temporaries(h)).toEqual([]));
		await waitFor(() => expect(transferRow(dbs, transferId)).toBeUndefined());
	});
});

describe.each([LOCAL_BACKEND, sftpBackend("posix", ["hardlink@openssh.com"])])(
	"the sweep, over $name",
	(kind) => {
		it("removes only the temporaries of its naming that no record knows and that are over an hour old", async () => {
			const h = await hostOf(kind);
			const s = serviceOn(h, kind);
			cleanups.push(() => s.service.shutdown());
			// One an upload knows: interrupted, its temporary kept.
			const big = content("big", 200_000);
			const known = await startUpload(s, h.dir, [file("big.bin", big)]);
			await sendPart(s, known.transferId, "big.bin", big, 100_000);
			s.service.clientGone(WRITER.clientId);
			await waitState(s, known.transferId, "big.bin", "interrupted");
			const [knownTemp] = temporaries(h);
			if (knownTemp === undefined) throw new Error("no temporary");

			const old = (Date.now() - SWEEP_MIN_AGE_MS - 60_000) / 1000;
			const recent = (Date.now() - SWEEP_MIN_AGE_MS + 5 * 60_000) / 1000;
			const put = (name: string, at: number, folder = false) => {
				const path = join(h.local(h.dir), name);
				if (folder) mkdirSync(path);
				else writeFileSync(path, "left");
				utimesSync(path, at, at);
			};
			utimesSync(join(h.local(h.dir), knownTemp), old, old);
			put(".stray.txt.0123456789abcdef.partial", old);
			put(".young.txt.0123456789abcdef.partial", recent);
			put("notes.partial", old);
			put(".other.0123456789abcdef.part", old);
			put(".short.0123456789abcde.partial", old);
			put(".folder.0123456789abcdef.partial", old, true);

			await startUpload(s, h.dir, [file("new.txt", content("new"))], "ask", AGAIN);
			const names = readdirSync(h.local(h.dir)).sort();
			expect(names).not.toContain(".stray.txt.0123456789abcdef.partial");
			expect(names).toEqual(
				expect.arrayContaining([
					knownTemp,
					".young.txt.0123456789abcdef.partial",
					"notes.partial",
					".other.0123456789abcdef.part",
					".short.0123456789abcde.partial",
					".folder.0123456789abcdef.partial",
				]),
			);
			expect(existsSync(join(h.local(h.dir), knownTemp))).toBe(true);
		});
	},
);
