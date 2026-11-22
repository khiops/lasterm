/**
 * The recorder's decisions (#80, spec freeze 1): event lines, timing, UTF-8
 * holds, losses, the cap, export parts and deletion. Driven through the calls
 * the hub makes (`onOutput`, `onResize`, `endChannel`, the start methods) and
 * the export and deletion the routes call, over a real spool.db. The hub's
 * wiring of those calls is covered in session-manager.spec.ts and the routes
 * in api/recordings.spec.ts.
 */
import type { ProtocolMessage, RecordingStateMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDatabases } from "../storage/db.js";
import { RecordingsDAL } from "../storage/recordings.js";
import { SpoolDAL } from "../storage/spool.js";
import { type RecorderDeps, SessionRecorder } from "./recorder.js";
import { SpoolGarbageCollector } from "./spool-gc.js";

const MiB = 1024 * 1024;
const CHANNEL = "ch-1";

interface Harness {
	rec: SessionRecorder;
	dal: RecordingsDAL;
	dbs: ReturnType<typeof openTestDatabases>;
	broadcasts: RecordingStateMessage[];
	logs: string[];
	attaches: Array<{ hostId: string; channelId: string; requestId: string }>;
	pending: Map<string, (msg: ProtocolMessage) => void>;
	purged: string[];
	/** Monotonic ms since the harness started. */
	at(ms: number): void;
	setTitle(title: string): void;
	cast(id: string): string;
	body(id: string): string[];
	gc: SpoolGarbageCollector;
}

function harness(
	opts: {
		capBytes?: number;
		maxBytes?: number;
		agentMatches?: boolean;
		agentConnected?: boolean;
	} = {},
	dbsIn?: ReturnType<typeof openTestDatabases>,
): Harness {
	const dbs = dbsIn ?? openTestDatabases();
	const dal = new RecordingsDAL(dbs.spool);
	let mono = 0;
	let title = "build";
	const wallBase = Date.UTC(2026, 10, 22, 10, 0, 0, 0);
	const broadcasts: RecordingStateMessage[] = [];
	const logs: string[] = [];
	const attaches: Harness["attaches"] = [];
	const pending = new Map<string, (msg: ProtocolMessage) => void>();
	const purged: string[] = [];
	const gc = new SpoolGarbageCollector(
		new SpoolDAL(dbs.spool),
		{ listStaleDeadChannelIds: () => [], hasChannel: () => true } as never,
		undefined,
		{ sliceBudgetMs: 0, recordings: dal },
	);
	const deps: RecorderDeps = {
		dal,
		now: () => mono,
		wallNow: () => new Date(wallBase + mono),
		capBytes: opts.capBytes ?? 1024 * MiB,
		...(opts.maxBytes !== undefined && { recordingMaxBytes: opts.maxBytes }),
		broadcast: (msg) => broadcasts.push(msg),
		log: (_level, msg) => logs.push(msg),
		sendAttach: (hostId, channelId, requestId) => {
			attaches.push({ hostId, channelId, requestId });
			return opts.agentConnected ?? true;
		},
		agentMatchesHub: () => opts.agentMatches ?? true,
		pendingRequests: pending,
		titleOf: () => title,
		purge: (ids) => {
			purged.push(...ids);
		},
	};
	const rec = new SessionRecorder(deps);
	const cast = (id: string): string => {
		let part = rec.exportPart(id);
		if (part === undefined) throw new Error("no export");
		let out = part.body;
		while (part.nextSeq !== undefined) {
			const next = rec.exportPart(id, {
				fromSeq: part.nextSeq,
				lastSeq: part.lastSeq,
				lost: part.lost,
			});
			if (next === undefined) throw new Error("part missing");
			out += next.body;
			part = next;
		}
		return out;
	};
	return {
		rec,
		dal,
		dbs,
		broadcasts,
		logs,
		attaches,
		pending,
		purged,
		gc,
		at: (ms) => {
			mono = ms;
		},
		setTitle: (t) => {
			title = t;
		},
		cast,
		body: (id) => cast(id).split("\n").slice(1, -1),
	};
}

const enc = (s: string) => new TextEncoder().encode(s);

function startAuto(h: Harness, channelId = CHANNEL, cols = 80, rows = 24): string {
	h.rec.startAutomatic({ channelId, hostId: "host-1", hostLabel: "pi", cols, rows });
	const id = h.rec.recordingIdOf(channelId);
	if (id === null) throw new Error("not recording");
	return id;
}

/** A manual start whose ATTACH_OK has not come yet. */
function startManual(h: Harness, cols = 80, rows = 24): { id: string; requestId: string } {
	const result = h.rec.startManual({
		channelId: CHANNEL,
		hostId: "host-1",
		hostLabel: "pi",
		cols,
		rows,
	});
	if (!("id" in result)) throw new Error(`refused: ${result.refused}`);
	return { id: result.id, requestId: h.attaches.at(-1)?.requestId ?? "" };
}

function answerAttach(h: Harness, requestId: string, snapshot: Record<string, unknown>): void {
	const handler = h.pending.get(requestId);
	if (!handler) throw new Error("no pending ATTACH");
	handler({
		type: "ATTACH_OK",
		channelId: CHANNEL,
		requestId,
		snapshot,
		lastSeq: 0,
	} as unknown as ProtocolMessage);
}

describe("SessionRecorder", () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	afterEach(() => {
		vi.useRealTimers();
		h.dbs.close();
	});

	// ─── Manual start ───────────────────────────────────────────────────────

	// AC-REC-START-MANUAL: header from the snapshot, first event the screen.
	// Mutation caught: the header from the channel's size (80x24).
	it("starts a manual recording with the screen the agent captured", () => {
		h.at(0);
		const { id, requestId } = startManual(h);
		expect(h.attaches).toEqual([{ hostId: "host-1", channelId: CHANNEL, requestId }]);
		expect(h.broadcasts.at(-1)).toMatchObject({
			type: "RECORDING_STATE",
			channelId: CHANNEL,
			recordingId: id,
		});
		h.at(30);
		answerAttach(h, requestId, {
			serialized: "S",
			cols: 100,
			rows: 30,
			cursorX: 0,
			cursorY: 0,
			alternateScreen: true,
			inputModes: "M",
		});
		const lines = h.cast(id).split("\n");
		expect(JSON.parse(lines[0] as string).term).toEqual({
			cols: 100,
			rows: 30,
			type: "xterm-256color",
		});
		expect(lines[1]).toBe('[0.000, "o", "\\u001b[?1049hSM"]');
	});

	// AC-START-HELD-OUTPUT: held output dropped, held resize at delay 0, later output timed from the screen.
	// Mutation caught: held output written (drawn twice).
	it("drops the output the screen holds and keeps a resize sent after the request", () => {
		h.at(0);
		const { id, requestId } = startManual(h);
		h.at(5);
		h.rec.onOutput(CHANNEL, enc("x"));
		h.at(10);
		h.rec.onResize(CHANNEL, 90, 20);
		h.at(50);
		answerAttach(h, requestId, {
			serialized: "SCREEN",
			cols: 80,
			rows: 24,
			cursorX: 0,
			cursorY: 0,
		});
		h.at(70);
		h.rec.onOutput(CHANNEL, enc("y"));
		expect(h.body(id)).toEqual([
			'[0.000, "o", "SCREEN"]',
			'[0.000, "r", "90x20"]',
			'[0.020, "o", "y"]',
		]);
	});

	// AC-START-UNAVAILABLE: every way the screen does not come.
	describe("when the screen does not come", () => {
		const MARKER = '[0.000, "m", "lasterm: the screen before this point is not available"]';

		/** The ATTACH_OK the agent sends after the wait ended: it must change nothing. */
		function lateScreen(
			handler: ((msg: ProtocolMessage) => void) | undefined,
			requestId: string,
		): void {
			handler?.({
				type: "ATTACH_OK",
				channelId: CHANNEL,
				requestId,
				snapshot: { serialized: "LATE", cols: 1, rows: 1, cursorX: 0, cursorY: 0 },
				lastSeq: 0,
			} as unknown as ProtocolMessage);
		}

		/** The blocks written so far, read from the store without an export (which would end a wait itself). */
		function stored(id: string): string[] {
			const read = h.dal.readBlocks(id, 1, h.dal.lastSeq(id), Number.MAX_SAFE_INTEGER);
			return (read?.blocks ?? []).flatMap((b) =>
				b.lines.toString("utf8").split("\n").filter(Boolean),
			);
		}

		function heldThen(trigger: (requestId: string) => void): { id: string; lines: string[] } {
			h.at(0);
			const { id, requestId } = startManual(h);
			h.at(10);
			h.rec.onOutput(CHANNEL, enc("held"));
			h.at(20);
			trigger(requestId);
			return { id, lines: h.body(id) };
		}

		// Mutation caught: an ERROR that leaves the wait open (a later screen is then taken).
		it("(a) an ERROR answering the request", () => {
			const { lines } = heldThen((rid) => {
				const handler = h.pending.get(rid);
				handler?.({
					type: "ERROR",
					code: "CHANNEL_NOT_FOUND",
					message: "x",
					requestId: rid,
				} as unknown as ProtocolMessage);
				lateScreen(handler, rid);
			});
			expect(lines).toEqual([MARKER, '[0.010, "o", "held"]']);
		});

		it("(b) 5 s without an answer, and a late answer adds nothing", () => {
			vi.useFakeTimers();
			h.at(0);
			const { id, requestId } = startManual(h);
			h.at(10);
			h.rec.onOutput(CHANNEL, enc("held"));
			const late = h.pending.get(requestId);
			vi.advanceTimersByTime(5000);
			late?.({
				type: "ATTACH_OK",
				channelId: CHANNEL,
				requestId,
				snapshot: { serialized: "LATE", cols: 1, rows: 1, cursorX: 0, cursorY: 0 },
				lastSeq: 0,
			} as unknown as ProtocolMessage);
			expect(h.body(id)).toEqual([MARKER, '[0.010, "o", "held"]']);
		});

		it("(c) the agent connection closes", () => {
			const { lines } = heldThen(() => h.rec.onAgentLost("host-1"));
			expect(lines).toEqual([
				MARKER,
				'[0.010, "o", "held"]',
				'[0.010, "m", "lasterm: connection to the agent lost; output until it returns may be missing or late"]',
			]);
		});

		it("(d) the terminal exits while awaiting", () => {
			const { lines } = heldThen(() => h.rec.endChannel(CHANNEL, "exited", 2));
			expect(lines).toEqual([MARKER, '[0.010, "o", "held"]', '[0.010, "x", "2"]']);
		});

		// Mutation caught: an unbounded hold (a later screen is then taken and the output dropped).
		it("(e) 256 KiB of output held", () => {
			h.at(0);
			const { id, requestId } = startManual(h);
			const handler = h.pending.get(requestId);
			h.at(10);
			h.rec.onOutput(CHANNEL, enc("a".repeat(256 * 1024)));
			lateScreen(handler, requestId);
			expect(h.rec.exportPart(id)?.body.split("\n")[1]).toBe(MARKER);
		});

		// Mutation caught: an end that leaves the held output behind.
		it("(f) Stop while awaiting keeps the held output", () => {
			h.at(0);
			const { id } = startManual(h);
			h.at(10);
			h.rec.onOutput(CHANNEL, enc("held"));
			h.rec.stop(id);
			expect(stored(id)).toEqual([MARKER, '[0.010, "o", "held"]']);
		});

		it("(g) an export while awaiting keeps the held output", () => {
			const { lines } = heldThen(() => undefined);
			expect(lines).toEqual([MARKER, '[0.010, "o", "held"]']);
		});

		// Mutation caught: an ATTACH sent to an agent of another version.
		it("(h) an agent of another version gets no ATTACH", () => {
			h = harness({ agentMatches: false });
			h.at(0);
			const { id } = startManual(h);
			expect(h.attaches).toEqual([]);
			expect(h.body(id)).toEqual([MARKER]);
		});

		it("(i) DELETE while awaiting resolves the wait first", () => {
			h.at(0);
			const { id } = startManual(h);
			h.at(10);
			h.rec.onOutput(CHANNEL, enc("held"));
			expect(h.rec.delete(id)).toBe(true);
			expect(stored(id)).toEqual([MARKER, '[0.010, "o", "held"]']);
		});

		it("(j) hub shutdown while awaiting resolves the wait first", () => {
			h.at(0);
			const { id } = startManual(h);
			h.at(10);
			h.rec.onOutput(CHANNEL, enc("held"));
			h.rec.shutdown();
			expect(stored(id)).toEqual([MARKER, '[0.010, "o", "held"]']);
			expect(h.dal.get(id)?.endReason).toBe("interrupted");
		});
	});

	// AC-LOST-CONNECTION-MARKER (b): an exit replayed after a lost connection comes after its marker.
	it("marks a lost connection before an exit the reconnection replays", () => {
		const id = startAuto(h);
		h.at(10);
		h.rec.onAgentLost("host-1");
		h.at(40);
		h.rec.endChannel(CHANNEL, "exited", 1);
		expect(h.body(id)).toEqual([
			'[0.010, "m", "lasterm: connection to the agent lost; output until it returns may be missing or late"]',
			'[0.030, "x", "1"]',
		]);
	});

	// ─── Events and timing ──────────────────────────────────────────────────

	// AC-EVENTS. Mutations caught: absolute times, an unchanged resize, a numeric exit.
	it("records output, size changes and exit with delays", () => {
		h.at(0);
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("a"));
		h.at(120);
		h.rec.onOutput(CHANNEL, enc("b"));
		h.at(250);
		h.rec.onResize(CHANNEL, 100, 30);
		h.at(1000);
		h.rec.endChannel(CHANNEL, "exited", 3);
		expect(h.body(id)).toEqual([
			'[0.000, "o", "a"]',
			'[0.120, "o", "b"]',
			'[0.130, "r", "100x30"]',
			'[0.750, "x", "3"]',
		]);
		expect(h.dal.get(id)?.endReason).toBe("exited");
	});

	// AC-TIMING-ROUND. Mutation caught: flooring each delay.
	it("rounds positions, not delays", () => {
		h.at(0);
		const id = startAuto(h);
		for (const t of [16.6, 33.2, 49.8, 66.4, 83.0]) {
			h.at(t);
			h.rec.onOutput(CHANNEL, enc("."));
		}
		expect(h.body(id).map((l) => l.slice(1, 6))).toEqual([
			"0.016",
			"0.017",
			"0.016",
			"0.017",
			"0.017",
		]);
	});

	// AC-UTF8.
	describe("UTF-8", () => {
		it("(a) joins a character split across frames", () => {
			const id = startAuto(h);
			h.at(5);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xc3]));
			h.at(9);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xa9]));
			expect(h.body(id)).toEqual(['[0.009, "o", "é"]']);
		});

		it("(b) replaces an invalid byte", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xff]));
			expect(h.body(id)).toEqual(['[0.000, "o", "�"]']);
		});

		// Mutation caught: bytes joined across the hole ("é").
		it("(c) counts a held byte in a failed write and never joins across the hole", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("A"));
			h.rec.onOutput(CHANNEL, new Uint8Array([0xc3]));
			vi.spyOn(h.dal, "writeBlock").mockImplementationOnce(() => {
				throw Object.assign(new Error("full"), { code: "SQLITE_FULL" });
			});
			h.rec.exportPart(id); // flushes: the write fails
			h.at(40);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xa9]));
			expect(h.body(id)).toEqual([
				'[0.040, "m", "lasterm: 2 bytes not recorded (storage error)"]',
				'[0.000, "o", "�"]',
			]);
		});

		it("(d) writes a held byte at the end", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xc3]));
			h.rec.stop(id);
			expect(h.body(id)).toEqual(['[0.000, "o", "�"]']);
		});

		it("(e) writes a held byte before a size change", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xc3]));
			h.rec.onResize(CHANNEL, 81, 24);
			expect(h.body(id)).toEqual(['[0.000, "o", "�"]', '[0.000, "r", "81x24"]']);
		});

		it("(f) writes a held byte before the exit", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, new Uint8Array([0xc3]));
			h.rec.endChannel(CHANNEL, "exited", 0);
			expect(h.body(id)).toEqual(['[0.000, "o", "�"]', '[0.000, "x", "0"]']);
		});
	});

	// ─── Export ─────────────────────────────────────────────────────────────

	// AC-HEADER. Mutation caught: a title not slugged.
	it("writes the header and names the file", () => {
		h.setTitle("build");
		const id = startAuto(h);
		h.rec.stop(id);
		const part = h.rec.exportPart(id);
		expect(part?.body.split("\n")[0]).toBe(
			'{"version":3,"term":{"cols":80,"rows":24,"type":"xterm-256color"},"timestamp":1795341600,"title":"build — pi"}',
		);
		expect(part?.fileName).toBe("lasterm-build-20261122-100000.cast");
	});

	it("escapes a title with quotes and uses the title at the end", () => {
		const id = startAuto(h);
		h.setTitle('say "hi"');
		h.rec.stop(id);
		const header = JSON.parse(h.rec.exportPart(id)?.body.split("\n")[0] ?? "");
		expect(header.title).toBe('say "hi" — pi');
	});

	it.each([
		["Ünïcode / tab", "lasterm-n-code-tab-20261122-100000.cast"],
		["", "lasterm-terminal-20261122-100000.cast"],
	])("slugs %j", (title, name) => {
		h.setTitle(title);
		const id = startAuto(h);
		h.rec.stop(id);
		expect(h.rec.exportPart(id)?.fileName).toBe(name);
	});

	// AC-EMPTY-EXPORT.
	it("exports a recording without blocks as its header alone", () => {
		const id = startAuto(h);
		h.rec.stop(id);
		const part = h.rec.exportPart(id);
		expect(part?.lastSeq).toBe(0);
		expect(part?.nextSeq).toBeUndefined();
		expect(part?.body.split("\n").filter(Boolean)).toHaveLength(1);
	});

	// AC-PARTS. Mutations caught: header repeated; blocks after last_seq served; walking from seq 1.
	it("exports in parts that follow the cursor", () => {
		const id = startAuto(h);
		for (let i = 0; i < 3; i++) {
			h.at(i * 10);
			h.rec.onOutput(CHANNEL, enc(String(i).repeat(3 * MiB)));
			h.rec.exportPart(id); // one block each
		}
		const reads = vi.spyOn(h.dal, "readBlocks");
		const first = h.rec.exportPart(id);
		expect(first?.lastSeq).toBe(3);
		expect(first?.nextSeq).toBe(2);
		h.at(500);
		h.rec.onOutput(CHANNEL, enc("later"));
		h.rec.exportPart(id); // a 4th block, after the cursor's end
		const second = h.rec.exportPart(id, { fromSeq: 2, lastSeq: 3, lost: 0 });
		const third = h.rec.exportPart(id, { fromSeq: 3, lastSeq: 3, lost: 0 });
		expect(third?.nextSeq).toBeUndefined();
		const whole = `${first?.body}${second?.body}${third?.body}`;
		expect(whole.split("\n").filter(Boolean)).toHaveLength(4);
		expect(second?.body.startsWith("{")).toBe(false);
		expect(whole).not.toContain("later");
		expect(reads.mock.calls.slice(-2).map((c) => c[1])).toEqual([2, 3]);
	});

	// AC-PART-DELETED. Mutation caught: a missing block read as the end.
	it("answers nothing for a part whose blocks a deletion took", async () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("a".repeat(3 * MiB)));
		h.rec.exportPart(id);
		h.rec.onOutput(CHANNEL, enc("b".repeat(3 * MiB)));
		h.rec.stop(id);
		const first = h.rec.exportPart(id);
		expect(first?.nextSeq).toBe(2);
		// A block gone while its row is still listed: the part is refused, never cut short.
		h.dbs.spool.prepare("DELETE FROM recording_blocks WHERE recording_id = ? AND seq = 2").run(id);
		expect(h.rec.exportPart(id, { fromSeq: 2, lastSeq: 2, lost: 0 })).toBeUndefined();
		h.rec.delete(id);
		await h.gc.purgeRecordings([id]);
		expect(h.rec.exportPart(id, { fromSeq: 2, lastSeq: 2, lost: 0 })).toBeUndefined();
	});

	// AC-OPEN-EXPORT. Mutation caught: no flush.
	it("includes buffered events in an open recording's export", () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("buffered"));
		expect(h.body(id)).toEqual(['[0.000, "o", "buffered"]']);
	});

	// AC-RECORDING-SIZE.
	it("ends a recording at its own limit, counting escaped lines", () => {
		h = harness({ maxBytes: MiB });
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, new Uint8Array(4096).fill(0x1b));
		h.rec.exportPart(id);
		expect(h.dal.get(id)?.bytes).toBeGreaterThan(6 * 4096);
		h.rec.onOutput(CHANNEL, new Uint8Array(300 * 1024).fill(0x1b));
		expect(h.rec.isRecording(CHANNEL)).toBe(false);
		expect(h.dal.get(id)?.endReason).toBe("cap");
		expect(h.body(id).at(-1)).toBe(
			'[0.000, "m", "lasterm: recording stopped, it reached 512 MiB"]',
		);
	});

	// ─── Stop, refusals, cap ─────────────────────────────────────────────────

	// AC-STOP. Mutation caught: stop leaving the tap on.
	it("stops once, and records nothing after", () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("a"));
		const row = h.rec.stop(id);
		expect(row).toMatchObject({ end_reason: "stopped" });
		expect(h.broadcasts.at(-1)).toMatchObject({ recordingId: null, endReason: "stopped" });
		expect(h.rec.stop(id)).toEqual(row);
		h.rec.onOutput(CHANNEL, enc("after"));
		expect(h.body(id)).toEqual(['[0.000, "o", "a"]']);
	});

	it("refuses a second recording of the same terminal", () => {
		const id = startAuto(h);
		expect(
			h.rec.startManual({
				channelId: CHANNEL,
				hostId: "host-1",
				hostLabel: "pi",
				cols: 80,
				rows: 24,
			}),
		).toEqual({
			refused: "ALREADY_RECORDING",
			openId: id,
		});
	});

	describe("the cap", () => {
		it("(a) refuses a start when the cap is reached", () => {
			h = harness({ capBytes: 1000 });
			const id = startAuto(h, "other");
			h.rec.onOutput("other", enc("x".repeat(2000)));
			h.rec.exportPart(id);
			expect(
				h.rec.startManual({
					channelId: CHANNEL,
					hostId: "host-1",
					hostLabel: "pi",
					cols: 80,
					rows: 24,
				}),
			).toEqual({
				refused: "RECORDING_CAP",
			});
		});

		// Mutation caught: the crossing block dropped.
		it("(b) writes the crossing block whole, then ends the recording", () => {
			h = harness({ capBytes: MiB });
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("a".repeat(900_000)));
			h.rec.exportPart(id);
			h.rec.onOutput(CHANNEL, enc("b".repeat(200_000)));
			h.rec.exportPart(id);
			expect(h.dal.get(id)?.endReason).toBe("cap");
			const lines = h.body(id);
			expect(lines.at(-2)).toContain("bbbb");
			expect(lines.at(-1)).toBe('[0.000, "m", "lasterm: recording stopped, storage cap reached"]');
			expect(h.rec.list().used_bytes).toBeGreaterThanOrEqual(h.rec.list().cap_bytes);
		});

		// Mutation caught: a silent refusal.
		it("(c) refuses an automatic start, logs and says so", () => {
			h = harness({ capBytes: 10 });
			const id = startAuto(h, "other");
			h.rec.onOutput("other", enc("x".repeat(50)));
			h.rec.exportPart(id);
			h.rec.startAutomatic({
				channelId: CHANNEL,
				hostId: "host-1",
				hostLabel: "pi",
				cols: 80,
				rows: 24,
			});
			expect(h.rec.isRecording(CHANNEL)).toBe(false);
			expect(h.logs.at(-1)).toContain(`not started for channel ${CHANNEL}: storage cap reached`);
			expect(h.broadcasts.at(-1)).toEqual({
				type: "RECORDING_STATE",
				channelId: CHANNEL,
				recordingId: null,
				refused: "cap",
			});
		});

		// Mutation caught: B left open or its buffer dropped.
		it("(d) ends every open recording, each with its buffer", () => {
			h = harness({ capBytes: 1000 });
			const a = startAuto(h, "A");
			const b = startAuto(h, "B");
			h.rec.onOutput("B", enc("b-buffered"));
			h.rec.onOutput("A", enc("a".repeat(2000)));
			h.rec.exportPart(a);
			expect(h.rec.isRecording("B")).toBe(false);
			expect(h.body(b)).toEqual([
				'[0.000, "o", "b-buffered"]',
				'[0.000, "m", "lasterm: recording stopped, storage cap reached"]',
			]);
		});

		it("(e) keeps a waiting recording's held output, and ignores its late screen", () => {
			h = harness({ capBytes: 1000 });
			const a = startAuto(h, "A");
			const { id: b, requestId } = startManual(h);
			h.rec.onOutput(CHANNEL, enc("b"));
			const late = h.pending.get(requestId);
			h.rec.onOutput("A", enc("a".repeat(2000)));
			h.rec.exportPart(a);
			late?.({
				type: "ATTACH_OK",
				channelId: CHANNEL,
				requestId,
				snapshot: { serialized: "LATE", cols: 1, rows: 1, cursorX: 0, cursorY: 0 },
				lastSeq: 0,
			} as unknown as ProtocolMessage);
			expect(h.body(b)).toEqual([
				'[0.000, "m", "lasterm: the screen before this point is not available"]',
				'[0.000, "o", "b"]',
				'[0.000, "m", "lasterm: recording stopped, storage cap reached"]',
			]);
		});
	});

	// ─── Storage errors ──────────────────────────────────────────────────────

	const sqliteFull = () => Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });

	describe("a failed block write", () => {
		// Mutation caught: the next written event timed from a lost one.
		it("is marked on the next block, and the next delay counts from the last written event", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("ok"));
			h.rec.exportPart(id);
			h.at(100);
			h.rec.onOutput(CHANNEL, enc("lost!"));
			vi.spyOn(h.dal, "writeBlock").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.exportPart(id);
			expect(h.logs.at(-1)).toBe(
				`[lasterm-recording] write failed (SQLITE_FULL), dropped 5 bytes for recording ${id}`,
			);
			h.at(300);
			h.rec.onOutput(CHANNEL, enc("next"));
			expect(h.body(id)).toEqual([
				'[0.000, "o", "ok"]',
				'[0.300, "m", "lasterm: 5 bytes not recorded (storage error)"]',
				'[0.000, "o", "next"]',
			]);
			expect(h.dal.get(id)?.unmarkedLostBytes).toBe(0);
		});

		it("ends the export with the marker after a failed last flush", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("tail"));
			vi.spyOn(h.dal, "writeBlock").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.stop(id);
			expect(h.body(id)).toEqual(['[0.000, "m", "lasterm: 4 bytes not recorded (storage error)"]']);
		});

		// Mutation caught: the export reading the row only.
		it("ends the export with the marker even when the count could not be persisted", () => {
			const id = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("tail"));
			vi.spyOn(h.dal, "writeBlock").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			vi.spyOn(h.dal, "setUnmarkedLost").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.exportPart(id);
			expect(h.dal.get(id)?.unmarkedLostBytes).toBe(0);
			expect(h.body(id)).toEqual(['[0.000, "m", "lasterm: 4 bytes not recorded (storage error)"]']);
		});
	});

	// AC-WFAIL / fixed-at-first-part. Mutation caught: the last part reading the lost count again.
	it("keeps the lost count fixed by an export's first request", () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("a".repeat(5 * MiB))); // block 1
		h.rec.onOutput(CHANNEL, enc("b".repeat(5 * MiB))); // block 2
		h.rec.onOutput(CHANNEL, enc("x"));
		vi.spyOn(h.dal, "writeBlock").mockImplementationOnce(() => {
			throw sqliteFull();
		});
		const first = h.rec.exportPart(id); // its flush fails: 1 byte lost, before this export
		expect(first).toMatchObject({ lastSeq: 2, nextSeq: 2, lost: 1 });
		h.rec.onOutput(CHANNEL, enc("y"));
		h.rec.exportPart(id); // block 3 carries the marker: the column goes back to 0
		expect(h.dal.get(id)?.unmarkedLostBytes).toBe(0);
		const last = h.rec.exportPart(id, { fromSeq: 2, lastSeq: 2, lost: first?.lost ?? 0 });
		expect(last?.nextSeq).toBeUndefined();
		expect(last?.body.trimEnd().split("\n").at(-1)).toBe(
			'[0.000, "m", "lasterm: 1 bytes not recorded (storage error)"]',
		);
		expect(last?.body).not.toContain('"y"');
	});

	describe("control rows", () => {
		it("(b) a failed end still stops the recording, and a new start opens", () => {
			const id = startAuto(h);
			vi.spyOn(h.dal, "end").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.stop(id);
			expect(h.rec.isRecording(CHANNEL)).toBe(false);
			expect(h.broadcasts.at(-1)).toMatchObject({ recordingId: null });
			expect(h.rec.listed(id)).toMatchObject({ end_reason: "stopped" });
			const again = startAuto(h);
			expect(again).not.toBe(id);
			expect(h.dal.get(id)?.endReason).toBe("stopped");
		});

		it("a failed end is written by the next GC pass", async () => {
			const id = startAuto(h);
			vi.spyOn(h.dal, "end").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.stop(id);
			expect(h.dal.get(id)?.endedAt).toBeNull();
			h.rec.retryPendingEnds();
			expect(h.dal.get(id)?.endReason).toBe("stopped");
		});

		// AC-CONTROL-ERRORS (c): the size reaches the row with the first block written.
		it("(c) writes the screen's size with the first block that succeeds", () => {
			h.at(0);
			const { id, requestId } = startManual(h);
			answerAttach(h, requestId, { serialized: "S", cols: 100, rows: 30, cursorX: 0, cursorY: 0 });
			vi.spyOn(h.dal, "writeBlock").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.exportPart(id); // the screen block fails
			h.rec.onOutput(CHANNEL, enc("after"));
			h.rec.stop(id);
			const lines = h.cast(id).split("\n");
			expect(JSON.parse(lines[0] as string).term).toMatchObject({ cols: 100, rows: 30 });
			expect(lines[1]).toBe('[0.000, "m", "lasterm: 1 bytes not recorded (storage error)"]');
			expect(h.dal.get(id)).toMatchObject({ cols: 100, rows: 30 });
		});

		it("(a) a failed open opens nothing and says so", () => {
			vi.spyOn(h.dal, "open").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.startAutomatic({
				channelId: CHANNEL,
				hostId: "host-1",
				hostLabel: "pi",
				cols: 80,
				rows: 24,
			});
			expect(h.rec.isRecording(CHANNEL)).toBe(false);
			expect(h.broadcasts.at(-1)).toEqual({
				type: "RECORDING_STATE",
				channelId: CHANNEL,
				recordingId: null,
				refused: "storage",
			});
			vi.spyOn(h.dal, "open").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			expect(
				h.rec.startManual({
					channelId: CHANNEL,
					hostId: "host-1",
					hostLabel: "pi",
					cols: 80,
					rows: 24,
				}),
			).toEqual({
				refused: "RECORDING_STORAGE_ERROR",
			});
		});
	});

	// ─── Hub start, list, deletion ──────────────────────────────────────────

	// AC-INTERRUPTED. Mutations caught: left open; marker depending on a block write.
	it("ends rows a crash left open and marks their export", () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("before"));
		h.rec.exportPart(id);
		// A new hub over the same spool, the old one gone without a shutdown.
		const next = harness({}, h.dbs);
		vi.spyOn(next.dal, "endAllOpen").mockImplementationOnce(() => {
			throw sqliteFull();
		});
		next.rec.recoverAtStart();
		expect(next.dal.get(id)?.endedAt).toBeNull();
		const third = harness({}, h.dbs);
		third.rec.recoverAtStart();
		expect(third.dal.get(id)?.endReason).toBe("crashed");
		expect(third.body(id)).toEqual([
			'[0.000, "o", "before"]',
			'[0.000, "m", "lasterm: the hub stopped unexpectedly; the end of this recording may be missing"]',
		]);
	});

	// AC-SHUTDOWN. Mutation caught: no flush at shutdown.
	it("writes the buffer and ends recordings at shutdown", () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("buffered"));
		h.rec.shutdown();
		expect(h.dal.get(id)?.endReason).toBe("interrupted");
		expect(h.dal.lastSeq(id)).toBe(1);
	});

	// AC-LIST. Mutation caught: a row being deleted listed.
	it("lists recordings newest first without the ones being deleted", () => {
		const a = startAuto(h, "A");
		h.at(2000);
		const b = startAuto(h, "B");
		h.at(4000);
		const c = startAuto(h, "C");
		h.rec.delete(c);
		const list = h.rec.list();
		expect(list.recordings.map((r) => r.id)).toEqual([b, a]);
		expect(Object.keys(list.recordings[0] ?? {}).sort()).toEqual(
			[
				"bytes",
				"channel_id",
				"cols",
				"duration_ms",
				"end_reason",
				"ended_at",
				"host_label",
				"id",
				"rows",
				"started_at",
				"title",
			].sort(),
		);
		expect(list.cap_bytes).toBe(1024 * MiB);
		expect(typeof list.used_bytes).toBe("number");
	});

	describe("deletion", () => {
		function blocks(id: string): number {
			return (
				h.dbs.spool
					.prepare("SELECT COUNT(*) AS n FROM recording_blocks WHERE recording_id = ?")
					.get(id) as { n: number }
			).n;
		}

		// AC-DELETE. Mutation caught: a delete by channel id.
		it("hides at once, then deletes blocks and row, sparing another recording of the same terminal", async () => {
			const keep = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("keep"));
			h.rec.stop(keep);
			const gone = startAuto(h);
			h.rec.onOutput(CHANNEL, enc("gone"));
			expect(h.rec.delete(gone)).toBe(true); // open: ended first
			expect(h.rec.isRecording(CHANNEL)).toBe(false);
			expect(h.rec.listed(gone)).toBeUndefined();
			expect(h.rec.exportPart(gone)).toBeUndefined();
			expect(h.purged).toEqual([gone]);
			await h.gc.purgeRecordings([gone]);
			expect(h.dal.get(gone)).toBeUndefined();
			expect(blocks(gone)).toBe(0);
			expect(blocks(keep)).toBe(1);
			expect(h.rec.delete("01UNKNOWN")).toBe(false);
		});

		it("deletes a recording without blocks", async () => {
			const id = startAuto(h);
			h.rec.stop(id);
			h.rec.delete(id);
			await h.gc.purgeRecordings([id]);
			expect(h.dal.get(id)).toBeUndefined();
		});

		// Mutation caught: an unbounded batch.
		it.each([
			[600, 100, (rows: number) => rows <= 256],
			[20, 200 * 1024, (_rows: number, bytes: number) => bytes <= MiB],
			[1, 3 * MiB, (rows: number) => rows === 1],
		])("keeps each transaction bounded: %i blocks of %i bytes", async (count, size, ok) => {
			const id = "01REC";
			h.dal.open(
				{
					id,
					channelId: CHANNEL,
					hostLabel: "pi",
					title: "t",
					startedAt: new Date(0).toISOString(),
					cols: 80,
					rows: 24,
				},
				{ reason: "crashed", endedAt: new Date(0).toISOString() },
			);
			for (let seq = 1; seq <= count; seq++) {
				h.dal.writeBlock({
					recordingId: id,
					seq,
					lines: Buffer.alloc(size, 0x61),
					durationMs: 0,
					resetLost: false,
				});
			}
			h.dal.markDeleting(id);
			const batches = vi.spyOn(h.dal, "deleteBatch");
			await h.gc.purgeRecordings([id]);
			for (const result of batches.mock.results) {
				const r = result.value as { deleted: number; bytes: number };
				expect(ok(r.deleted, r.bytes)).toBe(true);
			}
			expect(blocks(id)).toBe(0);
		});

		// AC-DELETE-RETRY. Mutation caught: a failed job dropped.
		it("finishes a failed deletion at the next GC pass, and after a hub start", async () => {
			const a = startAuto(h, "A");
			h.rec.onOutput("A", enc("a"));
			h.rec.stop(a);
			const keep = startAuto(h, "K");
			h.rec.onOutput("K", enc("k"));
			h.rec.stop(keep);
			vi.spyOn(h.dal, "deleteBatch").mockImplementationOnce(() => {
				throw sqliteFull();
			});
			h.rec.delete(a);
			await h.gc.purgeRecordings([a]);
			expect(h.dal.get(a)?.deleting).toBe(true);
			await h.gc.collect();
			expect(h.dal.get(a)).toBeUndefined();
			expect(blocks(keep)).toBe(1);

			const b = startAuto(h, "B");
			h.rec.stop(b);
			h.dal.markDeleting(b); // a hub that stopped before its purge ran
			const next = harness({}, h.dbs);
			next.rec.recoverAtStart();
			expect(next.purged).toEqual([b]);
		});
	});

	// R-NO-SILENT-DELETE: a GC pass never deletes a recording not marked.
	it("never deletes an unmarked recording in a GC pass", async () => {
		const id = startAuto(h);
		h.rec.onOutput(CHANNEL, enc("x"));
		h.rec.stop(id);
		await h.gc.collect();
		expect(h.dal.get(id)).toBeDefined();
	});
});
