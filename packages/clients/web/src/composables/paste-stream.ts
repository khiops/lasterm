import {
	PASTE_CHUNK_BYTES,
	PASTE_WINDOW_BYTES,
	type PasteAckMessage,
	type PasteCancelMessage,
	type PasteClosedMessage,
	type PasteMessage,
	type ProtocolMessage,
} from "@lasterm/shared";
import { formatSize } from "../utils/files-panel.js";

/**
 * One counter for every pane of the page (#1014): a pane remounted for the
 * same terminal never reuses the id of a paste whose answers may still come.
 */
let nextPasteId = 1;

/** How long a paste goes before its progress shows. */
export const PASTE_PROGRESS_DELAY_MS = 1000;

/** What a paste reads and does around it. */
export interface PasteStreamDeps {
	/** Send a frame to the hub. */
	send(msg: ProtocolMessage): void;
	/** The socket is up: a cancel can go. */
	connected(): boolean;
	/** The pane may send input (socket up, write lock held). */
	canSend(): boolean;
	toast: {
		show(
			level: "error" | "warning" | "info",
			text: string,
			durationMs?: number | null,
			action?: { label: string; run: () => void },
		): number;
		update(id: number, text: string): void;
		dismiss(id: number): void;
	};
	/** Send `data` as INPUT, as `onData` does. */
	sendInput(data: string): void;
}

interface Paste {
	channelId: string;
	id: number;
	chunks: Uint8Array[];
	total: number;
	/** Chunks sent, the next one's `seq`. */
	sent: number;
	/** Chunks acknowledged, by `seq`. */
	acked: Set<number>;
	ackedBytes: number;
	inFlight: number;
	/** What was typed while chunks were still unsent, in order. */
	held: string[];
	progressToast: number | null;
	progressTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * A pane's paste on its way to its terminal as PASTE chunks (#1014): at most
 * `PASTE_WINDOW_BYTES` sent and not acknowledged, what is typed meanwhile held
 * behind it, its progress shown once it takes a while, and its outcome said
 * when it ends early. One paste at a time.
 */
export class PasteStream {
	private paste: Paste | null = null;

	constructor(private readonly deps: PasteStreamDeps) {}

	/** A paste is in progress, until its final answer. */
	get active(): boolean {
		return this.paste !== null;
	}

	/** Send `bytes` to `channelId` as a paste. */
	start(channelId: string, bytes: Uint8Array): void {
		const chunks: Uint8Array[] = [];
		for (let at = 0; at < bytes.byteLength; at += PASTE_CHUNK_BYTES) {
			chunks.push(bytes.subarray(at, at + PASTE_CHUNK_BYTES));
		}
		const paste: Paste = {
			channelId,
			id: nextPasteId++,
			chunks,
			total: bytes.byteLength,
			sent: 0,
			acked: new Set(),
			ackedBytes: 0,
			inFlight: 0,
			held: [],
			progressToast: null,
			progressTimer: null,
		};
		this.paste = paste;
		paste.progressTimer = setTimeout(() => {
			paste.progressTimer = null;
			if (this.paste !== paste) return;
			paste.progressToast = this.deps.toast.show("info", this.progressText(paste), null, {
				label: "Cancel",
				run: () => this.cancelByUser(),
			});
		}, PASTE_PROGRESS_DELAY_MS);
		this.pump(paste);
	}

	/**
	 * What `onData` gives while a paste is in progress: held behind its unsent
	 * chunks, or, with a Ctrl+C, the cause of its cancel. True when taken here.
	 */
	takeInput(data: string): boolean {
		const paste = this.paste;
		if (paste === null) return false;
		if (data.includes("\u0003")) {
			this.cancelByUser([data]);
			return true;
		}
		if (paste.sent < paste.chunks.length) {
			paste.held.push(data);
			return true;
		}
		return false;
	}

	/** A PASTE_ACK from the hub: credit for its chunk, if it is this paste's. */
	onAck(msg: PasteAckMessage): void {
		const paste = this.paste;
		if (paste === null || msg.channelId !== paste.channelId || msg.pasteId !== paste.id) return;
		if (msg.seq >= paste.sent || paste.acked.has(msg.seq)) return;
		const length = paste.chunks[msg.seq]?.byteLength ?? 0;
		paste.acked.add(msg.seq);
		paste.inFlight -= length;
		paste.ackedBytes += length;
		if (paste.acked.size === paste.chunks.length) {
			this.finish(paste);
			return;
		}
		if (paste.progressToast !== null) {
			this.deps.toast.update(paste.progressToast, this.progressText(paste));
		}
		this.pump(paste);
	}

	/** A PASTE_CLOSED from the hub: the paste ended early. */
	onClosed(msg: PasteClosedMessage): void {
		const paste = this.paste;
		if (paste === null || msg.channelId !== paste.channelId || msg.pasteId !== paste.id) return;
		this.finish(paste);
		// Typed for this terminal, still shown: it goes, unless its agent is gone.
		if (msg.reason !== "agent_lost") this.release(paste.held);
		const reached =
			msg.written === undefined
				? `at least ${formatSize(paste.ackedBytes)}`
				: formatSize(msg.written);
		this.deps.toast.show(
			"error",
			`Paste interrupted: ${reached} of ${formatSize(paste.total)} reached the terminal.`,
		);
	}

	/** The toast's Cancel, or a Ctrl+C typed meanwhile (`after`). */
	cancelByUser(after: string[] = []): void {
		const paste = this.paste;
		if (paste === null) return;
		this.finish(paste);
		this.sendCancel(paste);
		this.release([...paste.held, ...after]);
		this.deps.toast.show(
			"info",
			`Paste cancelled: at least ${formatSize(paste.ackedBytes)} of ${formatSize(paste.total)} reached the terminal.`,
		);
	}

	/**
	 * The pane can no longer send (socket down, write lock lost), or leaves the
	 * terminal: the paste stops, what was held is dropped, never sent to
	 * another terminal or after the lock comes back.
	 */
	interrupt(): void {
		const paste = this.paste;
		if (paste === null) return;
		this.finish(paste);
		if (this.deps.connected()) this.sendCancel(paste);
		this.deps.toast.show(
			"error",
			`Paste interrupted: at least ${formatSize(paste.ackedBytes)} of ${formatSize(paste.total)} reached the terminal.`,
		);
	}

	private pump(paste: Paste): void {
		while (paste.sent < paste.chunks.length) {
			const chunk = paste.chunks[paste.sent] as Uint8Array;
			if (paste.inFlight + chunk.byteLength > PASTE_WINDOW_BYTES) return;
			if (!this.deps.canSend()) {
				this.interrupt();
				return;
			}
			const seq = paste.sent;
			paste.sent++;
			paste.inFlight += chunk.byteLength;
			this.deps.send({
				type: "PASTE",
				channelId: paste.channelId,
				pasteId: paste.id,
				seq,
				data: chunk,
				last: paste.sent === paste.chunks.length,
			} satisfies PasteMessage);
		}
		// The last chunk is out: what was typed meanwhile follows it, and the
		// agent keeps it after the paste.
		const held = paste.held.splice(0);
		this.release(held);
	}

	private release(inputs: string[]): void {
		for (const data of inputs) this.deps.sendInput(data);
	}

	private sendCancel(paste: Paste): void {
		this.deps.send({
			type: "PASTE_CANCEL",
			channelId: paste.channelId,
			pasteId: paste.id,
		} satisfies PasteCancelMessage);
	}

	/** Forget `paste`: its progress goes. */
	private finish(paste: Paste): void {
		if (this.paste === paste) this.paste = null;
		if (paste.progressTimer !== null) clearTimeout(paste.progressTimer);
		paste.progressTimer = null;
		if (paste.progressToast !== null) this.deps.toast.dismiss(paste.progressToast);
		paste.progressToast = null;
	}

	private progressText(paste: Paste): string {
		const percent = paste.total === 0 ? 100 : Math.floor((paste.ackedBytes * 100) / paste.total);
		return `Pasting ${formatSize(paste.ackedBytes)} of ${formatSize(paste.total)} (${percent} %)`;
	}
}
