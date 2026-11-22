import type { ProtocolMessage, RecordingStateMessage, SnapshotData } from "@lasterm/shared";
import { generateId, RECORDING_MAX_BYTES, recordingFileName } from "@lasterm/shared";
import type { RecordingEndReason, RecordingRow, RecordingsDAL } from "../storage/recordings.js";

/** A block is written once this much output is buffered, or a second after the first event. */
const BLOCK_SOURCE_BYTES = 256 * 1024;
const BLOCK_FLUSH_MS = 1000;
/** How long a manual start waits for the agent's screen. */
const SCREEN_WAIT_MS = 5000;
/** Output held while waiting for the screen past which the wait is abandoned. */
const SCREEN_HOLD_BYTES = 256 * 1024;
/** One export part: blocks up to this many bytes (a larger block alone). */
export const CAST_PART_BYTES = 4 * 1024 * 1024;

const MARKER_UNAVAILABLE = "lasterm: the screen before this point is not available";
const MARKER_CONNECTION_LOST =
	"lasterm: connection to the agent lost; output until it returns may be missing or late";
const MARKER_CAP = "lasterm: recording stopped, storage cap reached";
const MARKER_SIZE = "lasterm: recording stopped, it reached 512 MiB";
const MARKER_CRASHED =
	"lasterm: the hub stopped unexpectedly; the end of this recording may be missing";

function lostMarker(bytes: number): string {
	return `lasterm: ${bytes} bytes not recorded (storage error)`;
}

type EventCode = "o" | "r" | "m" | "x";

interface PendingEvent {
	pos: number;
	code: EventCode;
	/** `o`: the bytes; others: the text. */
	data: Uint8Array | string;
}

interface Awaiting {
	requestId: string;
	timer: ReturnType<typeof setTimeout>;
	held: PendingEvent[];
	heldBytes: number;
	/** The channel's size at the open, the header's if the screen never comes. */
	cols: number;
	rows: number;
}

interface Active {
	id: string;
	channelId: string;
	hostId: string;
	hostLabel: string;
	startedAt: string;
	/** Monotonic ms of position 0. */
	t0: number;
	cols: number;
	rows: number;
	/** A size learnt from the screen, written with the next block. */
	sizePending: boolean;
	awaiting: Awaiting | null;
	buffer: PendingEvent[];
	bufferSourceBytes: number;
	flushTimer: ReturnType<typeof setTimeout> | null;
	/** Trailing bytes of an incomplete UTF-8 sequence and where they were received. */
	heldUtf8: Uint8Array;
	heldUtf8Pos: number;
	/** Position of the last event appended, and of the last one written. */
	lastPos: number;
	lastWrittenPos: number;
	nextSeq: number;
	bytes: number;
	/** Bytes lost to failed writes and not marked in a block yet. */
	lost: number;
}

/**
 * What an ended recording still owes its row, held in memory: its end when
 * the UPDATE failed, bytes lost to a failed last write whose count could not
 * be persisted, a screen size no block carried. The export reads it; it goes
 * once written, or when the recording is deleted.
 */
interface EndedInMemory {
	channelId: string;
	endedAt: string;
	reason: RecordingEndReason;
	title: string;
	endPersisted: boolean;
	lost: number;
	/** Whether the row holds `lost`; until then each GC pass writes it again. */
	lostPersisted: boolean;
	size: { cols: number; rows: number } | null;
}

export interface RecorderDeps {
	dal: RecordingsDAL;
	/** Monotonic milliseconds. */
	now(): number;
	/** Wall clock. */
	wallNow(): Date;
	capBytes: number;
	/** Per-recording export limit; RECORDING_MAX_BYTES unless a test sets it. */
	recordingMaxBytes?: number;
	broadcast(msg: RecordingStateMessage): void;
	log(level: "info" | "warn" | "debug", msg: string, fields?: Record<string, unknown>): void;
	/** Send the agent `ATTACH {channelId, requestId}`; false when no agent is connected. */
	sendAttach(hostId: string, channelId: string, requestId: string): boolean;
	/** Whether the host's connected agent reported the hub's own version. */
	agentMatchesHub(hostId: string): boolean;
	pendingRequests: Map<string, (msg: ProtocolMessage) => void>;
	/** The terminal's resolved title now. */
	titleOf(channelId: string): string;
	/** Queue the deletion of recordings marked `deleting` with the spool GC. */
	purge(recordingIds: string[]): void;
}

export type StartRefusal = "ALREADY_RECORDING" | "RECORDING_CAP" | "RECORDING_STORAGE_ERROR";

export interface StartInput {
	channelId: string;
	hostId: string;
	hostLabel: string;
	cols: number;
	rows: number;
}

/** What `GET /api/recordings` lists for one recording. */
export interface ListedRecording {
	id: string;
	channel_id: string;
	host_label: string;
	title: string;
	started_at: string;
	ended_at: string | null;
	end_reason: string | null;
	cols: number;
	rows: number;
	duration_ms: number;
	bytes: number;
}

export interface CastPart {
	body: string;
	fileName: string | null;
	lastSeq: number;
	nextSeq: number | undefined;
	lost: number;
}

/** One asciicast v3 event line. */
function eventLine(delayMs: number, code: EventCode, text: string): string {
	return `[${(delayMs / 1000).toFixed(3)}, "${code}", ${JSON.stringify(text)}]\n`;
}

/** How many trailing bytes of `bytes` start a UTF-8 sequence that is not complete yet. */
function incompleteTail(bytes: Uint8Array): number {
	const n = bytes.length;
	for (let back = 1; back <= Math.min(3, n); back++) {
		const b = bytes[n - back] as number;
		if ((b & 0xc0) === 0x80) continue; // continuation byte: look further back
		// A lead byte says how long its sequence is; anything else stands alone.
		const need = b < 0xc2 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : b <= 0xf4 ? 4 : 1;
		if (need <= back) return 0;
		// Held only if it can still become a valid sequence (RFC 3629 table 3-7):
		// the byte after E0, ED, F0 and F4 has a narrower range.
		const second = back >= 2 ? (bytes[n - back + 1] as number) : undefined;
		if (second !== undefined) {
			if (b === 0xe0 && second < 0xa0) return 0;
			if (b === 0xed && second > 0x9f) return 0;
			if (b === 0xf0 && second < 0x90) return 0;
			if (b === 0xf4 && second > 0x8f) return 0;
		}
		return back;
	}
	return 0;
}

// A BOM inside the output is the program's: kept, never stripped.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Records terminals into spool.db (#80, STORAGE.md § 4.3): one recording per
 * terminal at most, fed where the hub receives the agent's OUTPUT, written in
 * blocks of asciicast v3 event lines, kept until the user saves or discards it.
 */
export class SessionRecorder {
	private readonly byChannel = new Map<string, Active>();
	private readonly byId = new Map<string, Active>();
	private readonly endedInMemory = new Map<string, EndedInMemory>();
	private readonly maxBytes: number;
	private capping = false;
	/** Recordings `finish` is writing out: still allowed their last events. */
	private readonly finishing = new Set<Active>();

	constructor(private readonly deps: RecorderDeps) {
		this.maxBytes = deps.recordingMaxBytes ?? RECORDING_MAX_BYTES;
	}

	/**
	 * At hub start, before any channel is adopted: a row left open by a hub
	 * that did not shut down is ended `crashed`. A failed UPDATE leaves it for
	 * the next start. Deletions a stop cut short are queued again.
	 */
	recoverAtStart(): void {
		try {
			const ended = this.deps.dal.endAllOpen("crashed", this.deps.wallNow().toISOString());
			if (ended > 0)
				this.deps.log("info", "recorder: recordings left open ended", { count: ended });
		} catch (err) {
			this.logFailure("end-crashed", "*", err);
		}
		try {
			const deleting = this.deps.dal.deletingIds();
			if (deleting.length > 0) this.deps.purge(deleting);
		} catch (err) {
			this.logFailure("list-deleting", "*", err);
		}
	}

	/** Write the ends kept in memory after a failed UPDATE (every GC pass). */
	retryPendingEnds(): void {
		for (const [id, ended] of [...this.endedInMemory]) {
			this.persistOwed(id, ended);
			this.forgetIfSettled(id, ended);
		}
	}

	isRecording(channelId: string): boolean {
		return this.byChannel.has(channelId);
	}

	recordingIdOf(channelId: string): string | null {
		return this.byChannel.get(channelId)?.id ?? null;
	}

	// ─── Starts ───────────────────────────────────────────────────────────────

	/** A manual start: the screen is asked of the agent. */
	startManual(input: StartInput): { id: string } | { refused: StartRefusal; openId?: string } {
		const existing = this.byChannel.get(input.channelId);
		if (existing) return { refused: "ALREADY_RECORDING", openId: existing.id };
		if (this.usedBytes() >= this.deps.capBytes) return { refused: "RECORDING_CAP" };
		const active = this.open(input);
		if (active === null) return { refused: "RECORDING_STORAGE_ERROR" };
		const requestId = generateId();
		active.awaiting = {
			requestId,
			held: [],
			heldBytes: 0,
			cols: input.cols,
			rows: input.rows,
			timer: setTimeout(() => this.abandonWait(active), SCREEN_WAIT_MS),
		};
		this.announceStart(active);
		if (!this.deps.agentMatchesHub(input.hostId)) {
			this.abandonWait(active);
			return { id: active.id };
		}
		this.deps.pendingRequests.set(requestId, (msg) => this.onAttachAnswer(active, requestId, msg));
		if (!this.deps.sendAttach(input.hostId, input.channelId, requestId)) this.abandonWait(active);
		return { id: active.id };
	}

	/**
	 * A new workload: SPAWN_OK of a new terminal, or a restart. Called in the
	 * same synchronous code that tracks the channel, so the first OUTPUT read
	 * with the SPAWN_OK is recorded.
	 */
	startAutomatic(input: StartInput): void {
		if (this.byChannel.has(input.channelId)) return;
		if (this.usedBytes() >= this.deps.capBytes) {
			this.deps.log(
				"info",
				`[lasterm-recording] not started for channel ${input.channelId}: storage cap reached`,
			);
			this.deps.broadcast({
				type: "RECORDING_STATE",
				channelId: input.channelId,
				recordingId: null,
				title: this.deps.titleOf(input.channelId),
				refused: "cap",
			});
			return;
		}
		const active = this.open(input);
		if (active === null) {
			this.deps.broadcast({
				type: "RECORDING_STATE",
				channelId: input.channelId,
				recordingId: null,
				title: this.deps.titleOf(input.channelId),
				refused: "storage",
			});
			return;
		}
		this.announceStart(active);
	}

	private open(input: StartInput): Active | null {
		const id = generateId();
		const startedAt = this.deps.wallNow().toISOString();
		try {
			this.deps.dal.open(
				{
					id,
					channelId: input.channelId,
					hostLabel: input.hostLabel,
					title: this.deps.titleOf(input.channelId),
					startedAt,
					cols: input.cols,
					rows: input.rows,
				},
				this.pendingEnds(input.channelId),
				{ reason: "crashed", endedAt: startedAt },
			);
		} catch (err) {
			this.logFailure("open", input.channelId, err);
			return null;
		}
		for (const [rid, ended] of this.endedInMemory) {
			if (ended.channelId === input.channelId && !ended.endPersisted) {
				ended.endPersisted = true;
				this.forgetIfSettled(rid, ended);
			}
		}
		const active: Active = {
			id,
			channelId: input.channelId,
			hostId: input.hostId,
			hostLabel: input.hostLabel,
			startedAt,
			t0: this.deps.now(),
			cols: input.cols,
			rows: input.rows,
			sizePending: false,
			awaiting: null,
			buffer: [],
			bufferSourceBytes: 0,
			flushTimer: null,
			heldUtf8: new Uint8Array(0),
			heldUtf8Pos: 0,
			lastPos: 0,
			lastWrittenPos: 0,
			nextSeq: 1,
			bytes: 0,
			lost: 0,
		};
		this.byChannel.set(input.channelId, active);
		this.byId.set(id, active);
		return active;
	}

	private announceStart(active: Active): void {
		this.deps.broadcast({
			type: "RECORDING_STATE",
			channelId: active.channelId,
			recordingId: active.id,
			title: this.deps.titleOf(active.channelId),
			hostLabel: active.hostLabel,
			startedAt: active.startedAt,
		});
	}

	private onAttachAnswer(active: Active, requestId: string, msg: ProtocolMessage): void {
		this.deps.pendingRequests.delete(requestId);
		const awaiting = active.awaiting;
		if (awaiting === null || awaiting.requestId !== requestId) return;
		if (msg.type !== "ATTACH_OK") {
			this.abandonWait(active);
			return;
		}
		clearTimeout(awaiting.timer);
		active.awaiting = null;
		const snapshot = (msg as { snapshot: SnapshotData }).snapshot;
		active.t0 = this.deps.now();
		active.lastPos = 0;
		active.lastWrittenPos = 0;
		active.cols = snapshot.cols;
		active.rows = snapshot.rows;
		active.sizePending = true;
		let screen = "";
		if (snapshot.alternateScreen === true) screen += "\u001b[?1049h";
		screen += (snapshot as { serialized?: string }).serialized ?? "";
		if (snapshot.inputModes) screen += snapshot.inputModes;
		this.append(active, { pos: 0, code: "o", data: new TextEncoder().encode(screen) }, true);
		// The held output is in the screen; the held resizes reached the agent after it.
		for (const event of awaiting.held) {
			if (event.code === "r") this.append(active, { pos: 0, code: "r", data: event.data }, true);
		}
	}

	/** The screen will not come: a marker, then the held events at their positions. */
	private abandonWait(active: Active): void {
		const awaiting = active.awaiting;
		if (awaiting === null) return;
		clearTimeout(awaiting.timer);
		this.deps.pendingRequests.delete(awaiting.requestId);
		active.awaiting = null;
		this.append(active, { pos: 0, code: "m", data: MARKER_UNAVAILABLE }, true);
		for (const event of awaiting.held) this.append(active, event, true);
	}

	// ─── Events ───────────────────────────────────────────────────────────────

	onOutput(channelId: string, data: Uint8Array): void {
		const active = this.byChannel.get(channelId);
		if (!active || data.byteLength === 0) return;
		const event: PendingEvent = { pos: this.position(active), code: "o", data };
		if (active.awaiting !== null) {
			active.awaiting.held.push(event);
			active.awaiting.heldBytes += data.byteLength;
			if (active.awaiting.heldBytes >= SCREEN_HOLD_BYTES) this.abandonWait(active);
			return;
		}
		this.append(active, event);
	}

	/** A size change the hub applied (`handleResize`, size changed). */
	onResize(channelId: string, cols: number, rows: number): void {
		const active = this.byChannel.get(channelId);
		if (!active) return;
		const event: PendingEvent = { pos: this.position(active), code: "r", data: `${cols}x${rows}` };
		if (active.awaiting !== null) {
			active.awaiting.held.push(event);
			return;
		}
		this.append(active, event);
	}

	/** The hub lost its current connection to a host's agent. */
	onAgentLost(hostId: string): void {
		for (const active of [...this.byChannel.values()]) {
			if (active.hostId !== hostId) continue;
			if (active.awaiting !== null) this.abandonWait(active);
			this.append(active, { pos: this.position(active), code: "m", data: MARKER_CONNECTION_LOST });
		}
	}

	// ─── Ends ─────────────────────────────────────────────────────────────────

	/** End a terminal's open recording, if any. */
	endChannel(channelId: string, reason: RecordingEndReason, exitCode?: number): void {
		const active = this.byChannel.get(channelId);
		if (active) this.finish(active, reason, exitCode);
	}

	/** Stop by id; a recording already ended is left as it is. */
	stop(recordingId: string): RecordingRow | ListedRecording | undefined {
		const active = this.activeById(recordingId);
		if (active) this.finish(active, "stopped");
		return this.listed(recordingId);
	}

	/** Hub shutdown: every open recording is written and ended `interrupted`. */
	shutdown(): void {
		for (const active of [...this.byChannel.values()]) this.finish(active, "interrupted");
		this.retryPendingEnds();
	}

	private finish(
		active: Active,
		reason: RecordingEndReason,
		exitCode?: number,
		lastMarker?: string,
	): void {
		if (this.byChannel.get(active.channelId) !== active) return;
		this.finishing.add(active);
		try {
			this.finishWrites(active, exitCode, lastMarker);
		} finally {
			this.finishing.delete(active);
		}
		this.finishRow(active, reason);
	}

	private finishWrites(active: Active, exitCode?: number, lastMarker?: string): void {
		if (active.awaiting !== null) this.abandonWait(active);
		if (exitCode !== undefined) {
			this.append(active, { pos: this.position(active), code: "x", data: String(exitCode) }, true);
		}
		if (lastMarker !== undefined) {
			this.append(active, { pos: this.position(active), code: "m", data: lastMarker }, true);
		}
		this.flushHeldUtf8(active);
		this.byChannel.delete(active.channelId);
		this.byId.delete(active.id);
		this.flush(active);
	}

	private finishRow(active: Active, reason: RecordingEndReason): void {
		const endedAt = this.deps.wallNow().toISOString();
		const title = this.deps.titleOf(active.channelId);
		const owed: EndedInMemory = {
			channelId: active.channelId,
			endedAt,
			reason,
			title,
			endPersisted: false,
			lost: active.lost,
			lostPersisted: active.lost === 0,
			size: active.sizePending ? { cols: active.cols, rows: active.rows } : null,
		};
		this.persistOwed(active.id, owed);
		// Kept in memory while the row lacks any of it; each GC pass and the
		// hub's shutdown write it again.
		this.endedInMemory.set(active.id, owed);
		this.forgetIfSettled(active.id, owed);
		this.deps.broadcast({
			type: "RECORDING_STATE",
			channelId: active.channelId,
			recordingId: null,
			endReason: reason,
		});
	}

	// ─── Writing ──────────────────────────────────────────────────────────────

	private position(active: Active): number {
		return Math.max(active.lastPos, Math.floor(this.deps.now() - active.t0));
	}

	/**
	 * Add an event to the buffer. `o` bytes keep their incomplete UTF-8 tail
	 * for the next `o`; any other event first writes that tail on its own.
	 */
	private append(active: Active, event: PendingEvent, noFlushTrigger = false): void {
		// A recording a cap stop ended in the middle of a loop over several takes nothing more.
		if (this.byChannel.get(active.channelId) !== active && !this.finishing.has(active)) return;
		const pos = Math.max(active.lastPos, event.pos);
		if (event.code === "o") {
			const bytes = event.data as Uint8Array;
			let joined = bytes;
			if (active.heldUtf8.length > 0) {
				joined = new Uint8Array(active.heldUtf8.length + bytes.length);
				joined.set(active.heldUtf8, 0);
				joined.set(bytes, active.heldUtf8.length);
			}
			const tail = incompleteTail(joined);
			const complete = joined.subarray(0, joined.length - tail);
			active.heldUtf8 = joined.slice(joined.length - tail);
			active.heldUtf8Pos = pos;
			if (complete.length > 0) this.push(active, { pos, code: "o", data: complete });
		} else {
			this.flushHeldUtf8(active);
			this.push(active, { ...event, pos });
		}
		active.lastPos = pos;
		if (!noFlushTrigger) this.maybeFlush(active);
		else if (active.flushTimer === null && active.buffer.length > 0) this.armTimer(active);
	}

	private flushHeldUtf8(active: Active): void {
		if (active.heldUtf8.length === 0) return;
		const held = active.heldUtf8;
		active.heldUtf8 = new Uint8Array(0);
		this.push(active, { pos: active.heldUtf8Pos, code: "o", data: held });
	}

	private push(active: Active, event: PendingEvent): void {
		active.buffer.push(event);
		active.bufferSourceBytes +=
			typeof event.data === "string" ? event.data.length : event.data.byteLength;
	}

	private maybeFlush(active: Active): void {
		if (active.bufferSourceBytes >= BLOCK_SOURCE_BYTES) {
			this.flush(active);
			return;
		}
		if (active.flushTimer === null && active.buffer.length > 0) this.armTimer(active);
	}

	private armTimer(active: Active): void {
		active.flushTimer = setTimeout(() => {
			active.flushTimer = null;
			this.flush(active);
		}, BLOCK_FLUSH_MS);
	}

	/** Write the buffer as one block. A failure drops it and counts the loss. */
	private flush(active: Active): void {
		if (active.flushTimer !== null) {
			clearTimeout(active.flushTimer);
			active.flushTimer = null;
		}
		if (active.buffer.length === 0) return;
		const events = active.buffer;
		const sourceBytes = active.bufferSourceBytes;
		active.buffer = [];
		active.bufferSourceBytes = 0;
		let lines = "";
		let last = active.lastWrittenPos;
		const resetLost = active.lost > 0;
		if (resetLost) {
			const first = events[0] as PendingEvent;
			lines += eventLine(first.pos - last, "m", lostMarker(active.lost));
			last = first.pos;
		}
		for (const event of events) {
			const text = typeof event.data === "string" ? event.data : utf8.decode(event.data);
			lines += eventLine(event.pos - last, event.code, text);
			last = event.pos;
		}
		const blob = Buffer.from(lines, "utf8");
		try {
			this.deps.dal.writeBlock({
				recordingId: active.id,
				seq: active.nextSeq,
				lines: blob,
				durationMs: last,
				resetLost,
				...(active.sizePending && { size: { cols: active.cols, rows: active.rows } }),
			});
		} catch (err) {
			const dropped = sourceBytes + active.heldUtf8.length;
			active.heldUtf8 = new Uint8Array(0);
			active.lost += dropped;
			const code = (err as { code?: unknown } | null)?.code;
			this.deps.log(
				"warn",
				`[lasterm-recording] write failed (${typeof code === "string" ? code : "no code"}), dropped ${dropped} bytes for recording ${active.id}`,
			);
			try {
				this.deps.dal.setUnmarkedLost(active.id, active.lost);
			} catch (persistErr) {
				this.logFailure("lost-count", active.channelId, persistErr);
			}
			return;
		}
		active.nextSeq++;
		active.lastWrittenPos = last;
		active.bytes += blob.byteLength;
		active.sizePending = false;
		if (resetLost) active.lost = 0;
		this.checkLimits(active);
	}

	/** After a block: the per-recording limit, then the total cap. */
	private checkLimits(active: Active): void {
		if (this.capping) return;
		if (active.bytes >= this.maxBytes && this.byChannel.get(active.channelId) === active) {
			this.capping = true;
			try {
				this.finish(active, "cap", undefined, MARKER_SIZE);
			} finally {
				this.capping = false;
			}
		}
		// A total that cannot be read stops nothing: the next block reads it
		// again. Only a start is refused on it.
		let used: number;
		try {
			used = this.deps.dal.usedBytes();
		} catch (err) {
			this.logFailure("used-bytes", active.channelId, err);
			return;
		}
		if (used < this.deps.capBytes) return;
		this.capping = true;
		try {
			for (const other of [...this.byChannel.values()]) {
				this.finish(other, "cap", undefined, MARKER_CAP);
			}
		} finally {
			this.capping = false;
		}
	}

	/** What all recordings hold; a failed read counts as full, so nothing starts past the cap. */
	private usedBytes(): number {
		try {
			return this.deps.dal.usedBytes();
		} catch (err) {
			this.logFailure("used-bytes", "*", err);
			return Number.POSITIVE_INFINITY;
		}
	}

	// ─── Reading ──────────────────────────────────────────────────────────────

	list(): { recordings: ListedRecording[]; used_bytes: number; cap_bytes: number } {
		const rows = this.deps.dal.list();
		return {
			recordings: rows.map((row) => this.toListed(row)),
			used_bytes: Math.min(this.usedBytes(), Number.MAX_SAFE_INTEGER),
			cap_bytes: this.deps.capBytes,
		};
	}

	/** The listed form of one recording, or undefined (unknown or being deleted). */
	listed(recordingId: string): ListedRecording | undefined {
		const row = this.deps.dal.get(recordingId);
		if (row === undefined || row.deleting) return undefined;
		return this.toListed(row);
	}

	private toListed(row: RecordingRow): ListedRecording {
		const active = this.activeById(row.id);
		const ended = this.endedInMemory.get(row.id);
		return {
			id: row.id,
			channel_id: row.channelId,
			host_label: row.hostLabel,
			title: ended && !ended.endPersisted ? ended.title : row.title,
			started_at: row.startedAt,
			ended_at: ended && !ended.endPersisted ? ended.endedAt : row.endedAt,
			end_reason: ended && !ended.endPersisted ? ended.reason : row.endReason,
			cols: active?.cols ?? ended?.size?.cols ?? row.cols,
			rows: active?.rows ?? ended?.size?.rows ?? row.rows,
			duration_ms: row.durationMs,
			bytes: row.bytes,
		};
	}

	/**
	 * One part of a recording's export (STORAGE.md § 4.3). The first part
	 * (`cursor` undefined) flushes an open recording, fixes the last block and
	 * the lost count, and carries the header; a later part reads from its
	 * cursor only. Undefined when the recording is unknown, being deleted, or a
	 * block in range is missing.
	 */
	exportPart(
		recordingId: string,
		cursor?: { fromSeq: number; lastSeq: number; lost: number },
	): CastPart | undefined {
		const row = this.deps.dal.get(recordingId);
		if (row === undefined || row.deleting) return undefined;
		const active = this.activeById(recordingId);
		let lastSeq: number;
		let lost: number;
		let fromSeq: number;
		let header = "";
		let fileName: string | null = null;
		if (cursor === undefined) {
			if (active) {
				if (active.awaiting !== null) this.abandonWait(active);
				this.flush(active);
			}
			const fresh = this.deps.dal.get(recordingId) ?? row;
			lastSeq = this.deps.dal.lastSeq(recordingId);
			lost = Math.max(
				fresh.unmarkedLostBytes,
				active?.lost ?? this.endedInMemory.get(recordingId)?.lost ?? 0,
			);
			fromSeq = 1;
			const listed = this.toListed(fresh);
			header = `${JSON.stringify({
				version: 3,
				term: { cols: listed.cols, rows: listed.rows, type: "xterm-256color" },
				timestamp: Math.floor(new Date(listed.started_at).getTime() / 1000),
				title: `${listed.title} — ${listed.host_label}`,
			})}\n`;
			fileName = recordingFileName(listed.title, listed.started_at);
		} else {
			({ lastSeq, lost, fromSeq } = cursor);
		}
		const read = this.deps.dal.readBlocks(recordingId, fromSeq, lastSeq, CAST_PART_BYTES);
		if (read === null) return undefined;
		let body = header;
		for (const block of read.blocks) body += block.lines.toString("utf8");
		if (read.nextSeq === undefined) {
			if (lost > 0) body += eventLine(0, "m", lostMarker(lost));
			const ended = this.endedInMemory.get(recordingId);
			const reason = ended && !ended.endPersisted ? ended.reason : row.endReason;
			if (reason === "crashed") body += eventLine(0, "m", MARKER_CRASHED);
		}
		return { body, fileName, lastSeq, nextSeq: read.nextSeq, lost };
	}

	// ─── Deleting ─────────────────────────────────────────────────────────────

	/** Mark a recording for deletion and queue it; false when unknown. */
	delete(recordingId: string): boolean {
		const row = this.deps.dal.get(recordingId);
		if (row === undefined || row.deleting) return false;
		const active = this.activeById(recordingId);
		if (active) this.finish(active, "stopped");
		try {
			this.deps.dal.markDeleting(recordingId);
		} catch (err) {
			this.logFailure("deleting", row.channelId, err);
			throw err;
		}
		this.endedInMemory.delete(recordingId);
		this.deps.purge([recordingId]);
		return true;
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

	private activeById(recordingId: string): Active | undefined {
		return this.byId.get(recordingId);
	}

	/** The ends of this terminal's recordings whose UPDATE failed, to write with the next open. */
	private pendingEnds(
		channelId: string,
	): Array<{ id: string; reason: RecordingEndReason; endedAt: string; title: string }> {
		const out: Array<{ id: string; reason: RecordingEndReason; endedAt: string; title: string }> =
			[];
		for (const [id, ended] of this.endedInMemory) {
			if (ended.channelId === channelId && !ended.endPersisted) {
				out.push({ id, reason: ended.reason, endedAt: ended.endedAt, title: ended.title });
			}
		}
		return out;
	}

	/** Write what an ended recording's row still lacks: its end, lost count and size. */
	private persistOwed(id: string, ended: EndedInMemory): void {
		if (!ended.endPersisted) {
			try {
				this.deps.dal.end(id, ended.reason, ended.endedAt, ended.title);
				ended.endPersisted = true;
			} catch (err) {
				this.logFailure("end", ended.channelId, err);
			}
		}
		if (!ended.lostPersisted) {
			try {
				this.deps.dal.setUnmarkedLost(id, ended.lost);
				ended.lostPersisted = true;
			} catch (err) {
				this.logFailure("lost-count", ended.channelId, err);
			}
		}
		if (ended.size !== null) {
			try {
				this.deps.dal.setSize(id, ended.size.cols, ended.size.rows);
				ended.size = null;
			} catch (err) {
				this.logFailure("size", ended.channelId, err);
			}
		}
	}

	private forgetIfSettled(id: string, ended: EndedInMemory): void {
		if (ended.endPersisted && ended.lostPersisted && ended.size === null)
			this.endedInMemory.delete(id);
	}

	private logFailure(operation: string, channelId: string, err: unknown): void {
		const code = (err as { code?: unknown } | null)?.code;
		this.deps.log(
			"warn",
			`[lasterm-recording] ${operation} failed (${typeof code === "string" ? code : "no code"}) for channel ${channelId}`,
		);
	}
}
