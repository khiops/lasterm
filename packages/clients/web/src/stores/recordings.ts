import { type RecordingStateMessage, recordingFileName } from "@lasterm/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { useToastStore } from "./toast.js";

/** A recording as `GET /api/recordings` lists it (#80). */
export interface RecordingRow {
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

/** What a pane knows of its terminal's open recording. */
export interface OpenRecording {
	recordingId: string;
	title: string;
	hostLabel: string;
	startedAt: string;
}

interface SocketLike {
	on(type: string, handler: (msg: { type: string }) => void): () => void;
}

/** The save dialog the File System Access API gives, where the browser has it. */
type SaveFilePicker = (options: {
	suggestedName: string;
	types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<{ createWritable(): Promise<WritableLike> }>;

interface WritableLike {
	write(data: string): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}

function authHeaders(): Record<string, string> {
	const token = useAuthStore().token;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Terminal recordings (#80). The hub keeps a recording only until it is saved
 * or discarded: this store knows which terminals record (for their REC mark),
 * lists the recordings waiting, starts one, saves one and discards one.
 */
/** `work`, or a rejection once `LIST_DEADLINE_MS` passes without it settling. */
function withDeadline<T>(work: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no answer in time")), LIST_DEADLINE_MS);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/** How long states are gathered before the list is read again. */
const REFRESH_BURST_MS = 100;
/** A failed list read is tried again after this, doubled each time up to the cap. */
const RETRY_FIRST_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** A list read that has not answered by then counts as failed, so it is tried again. */
const LIST_DEADLINE_MS = 15_000;
/** While a deletion still counts bytes no listed row holds, the list is read again this often. */
const PURGE_POLL_MS = 2000;
/** And at most this many times in a row, so a deletion that keeps failing reads no further. */
const PURGE_POLL_LIMIT = 60;

/** What a channel list fetch merges against: see `mergeListed`. */
export interface ListFetchStart {
	heard: ReadonlyMap<string, number>;
	lifetime: number;
}

/** The `recording_id` of channel rows, where the hub sent the field. */
export function listedRecordings(
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<{ channelId: string; recordingId: string | null }> {
	const out: Array<{ channelId: string; recordingId: string | null }> = [];
	for (const row of rows) {
		if (typeof row.id !== "string" || !("recording_id" in row)) continue;
		out.push({
			channelId: row.id,
			recordingId: typeof row.recording_id === "string" ? row.recording_id : null,
		});
	}
	return out;
}

export const useRecordingsStore = defineStore("recordings", () => {
	/** channelId → its open recording. Keyed by channel, whether or not its row is known yet. */
	const open = ref(new Map<string, OpenRecording>());
	const rows = ref<RecordingRow[]>([]);
	const usedBytes = ref(0);
	const capBytes = ref(0);
	/** channelId → how many RECORDING_STATE were heard: a list answer older than one loses (#1099's rule). */
	const heard = new Map<string, number>();
	/** Each list fetch's turn: an answer older than one already applied is dropped. */
	let fetches = 0;
	let applied = 0;
	/** One list fetch for a burst of states. */
	let refreshQueued: ReturnType<typeof setTimeout> | null = null;
	/**
	 * The list is the one source of which terminals record: a read that fails
	 * is tried again until one succeeds. Each refresh starts a new chain of
	 * tries (`chain`), and a try of an older chain neither retries nor stops the
	 * current one. `lifetime` changes when the connection is let go: nothing
	 * read before then is applied after it.
	 */
	let chain = 0;
	let lifetime = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = RETRY_FIRST_MS;
	let purgePolls = 0;

	function refreshSoon(delay = REFRESH_BURST_MS): void {
		if (refreshQueued !== null) return;
		refreshQueued = setTimeout(() => {
			refreshQueued = null;
			void refresh();
		}, delay);
	}

	/** The connection is gone: no try goes on; the next authentication reads the list again. */
	function stopRetrying(): void {
		lifetime++;
		chain++;
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		if (refreshQueued !== null) clearTimeout(refreshQueued);
		refreshQueued = null;
		retryDelay = RETRY_FIRST_MS;
	}

	function onState(msg: RecordingStateMessage): void {
		heard.set(msg.channelId, (heard.get(msg.channelId) ?? 0) + 1);
		// Only this terminal's entry changes: no copy of the others.
		const next = open.value;
		if (msg.recordingId !== null) {
			next.set(msg.channelId, {
				recordingId: msg.recordingId,
				title: msg.title ?? "",
				hostLabel: msg.hostLabel ?? "",
				startedAt: msg.startedAt ?? new Date().toISOString(),
			});
		} else {
			next.delete(msg.channelId);
			if (msg.refused !== undefined) {
				const name = msg.title ? `“${msg.title}”` : "A terminal";
				useToastStore().show(
					"warning",
					msg.refused === "cap"
						? `${name} was not recorded: recordings take all the space allowed. Save or discard some in Recordings.`
						: `${name} was not recorded: the recording could not be stored.`,
				);
			}
		}
		refreshSoon();
	}

	/** The client the handler is on: each connect calls this again with the same one. */
	let registeredOn: SocketLike | null = null;

	function registerHandlers(socket: SocketLike): void {
		if (registeredOn === socket) return;
		registeredOn = socket;
		socket.on("RECORDING_STATE", (msg) => {
			if (msg.type === "RECORDING_STATE") onState(msg as RecordingStateMessage);
		});
	}

	/**
	 * Read the list again, every host's, and rebuild which terminals record from
	 * its open rows. A channel heard of since the fetch began keeps what it heard.
	 */
	/** Read the list now, and again until a read succeeds (a newer refresh takes over). */
	async function refresh(): Promise<void> {
		const mine = ++chain;
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		retryDelay = RETRY_FIRST_MS;
		await tryList(mine);
	}

	async function tryList(mine: number): Promise<void> {
		if (await readList()) {
			if (mine === chain) retryDelay = RETRY_FIRST_MS;
			return;
		}
		if (mine !== chain) return;
		// Jittered, so windows that failed together do not try again together.
		const delay = retryDelay * (0.8 + Math.random() * 0.4);
		retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (mine === chain) void tryList(mine);
		}, delay);
	}

	/** One read of the list, with a fresh turn; false when it could not be used. */
	async function readList(): Promise<boolean> {
		const before = new Map(heard);
		const turn = ++fetches;
		const at = lifetime;
		type ListBody = { recordings?: unknown; used_bytes?: unknown; cap_bytes?: unknown } | null;
		let body: ListBody;
		try {
			body = await withDeadline(
				(async (): Promise<ListBody> => {
					const res = await hubFetch(`${hubBaseUrl()}/api/recordings`, {
						headers: authHeaders(),
					});
					if (!res.ok) return null;
					return (await res.json().catch(() => null)) as ListBody;
				})(),
			);
		} catch {
			return false;
		}
		if (body === null || !Array.isArray(body.recordings)) return false;
		if (at !== lifetime) return true; // read before the connection was let go
		if (turn < applied) return true;
		applied = turn;
		rows.value = body.recordings as RecordingRow[];
		usedBytes.value = typeof body.used_bytes === "number" ? body.used_bytes : 0;
		capBytes.value = typeof body.cap_bytes === "number" ? body.cap_bytes : 0;
		const next = new Map<string, OpenRecording>();
		for (const [channelId, rec] of open.value) {
			if ((heard.get(channelId) ?? 0) !== (before.get(channelId) ?? 0)) next.set(channelId, rec);
		}
		for (const row of rows.value) {
			if (row.ended_at !== null) continue;
			if ((heard.get(row.channel_id) ?? 0) !== (before.get(row.channel_id) ?? 0)) continue;
			next.set(row.channel_id, {
				recordingId: row.id,
				title: row.title,
				hostLabel: row.host_label,
				startedAt: row.started_at,
			});
		}
		open.value = next;
		// A discarded or saved recording's bytes count until its deletion ends,
		// and nothing announces that end: the list is read again until the space
		// used matches the rows it lists, so a "full" badge does not outlive it.
		const listedBytes = rows.value.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
		if (usedBytes.value > listedBytes && purgePolls < PURGE_POLL_LIMIT) {
			purgePolls++;
			refreshSoon(PURGE_POLL_MS);
		} else {
			purgePolls = 0;
		}
		return true;
	}

	/** Where a channel list fetch starts: what was heard by then, and in which connection. */
	function listFetchStarted(): ListFetchStart {
		return { heard: new Map(heard), lifetime };
	}

	/**
	 * Merge the `recording_id` of channel rows (GET /api/channels) by the same
	 * rule as the recordings list: the newer news wins, so a RECORDING_STATE heard
	 * since the fetch began keeps its terminal; otherwise the row says which
	 * recording is open, if any. An id this window does not know yet reads the
	 * recordings list for its title and start time.
	 */
	function mergeListed(
		start: ListFetchStart,
		listed: ReadonlyArray<{ channelId: string; recordingId: string | null }>,
	): void {
		if (start.lifetime !== lifetime) return;
		let unknown = false;
		const map = open.value;
		for (const { channelId, recordingId } of listed) {
			if ((heard.get(channelId) ?? 0) !== (start.heard.get(channelId) ?? 0)) continue;
			if (recordingId === null) {
				map.delete(channelId);
				continue;
			}
			if (map.get(channelId)?.recordingId === recordingId) continue;
			const row = rows.value.find((r) => r.id === recordingId);
			map.set(channelId, {
				recordingId,
				title: row?.title ?? "",
				hostLabel: row?.host_label ?? "",
				startedAt: row?.started_at ?? new Date().toISOString(),
			});
			if (row === undefined) unknown = true;
		}
		if (unknown) refreshSoon();
	}

	/** Start recording a terminal now. */
	async function start(channelId: string): Promise<void> {
		let res: Response;
		try {
			res = await hubFetch(
				`${hubBaseUrl()}/api/channels/${encodeURIComponent(channelId)}/recording`,
				{ method: "POST", headers: authHeaders() },
			);
		} catch {
			useToastStore().show("error", "The recording could not start: the hub did not answer.");
			return;
		}
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			useToastStore().show("error", body?.error?.message ?? "The recording could not start.");
		}
	}

	/** The parts of a recording's export, in order (PROTOCOL.md § 6 Recordings). */
	async function* castParts(recordingId: string): AsyncGenerator<string> {
		const base = `${hubBaseUrl()}/api/recordings/${encodeURIComponent(recordingId)}/cast`;
		let res = await hubFetch(base, { headers: authHeaders() });
		if (!res.ok) throw new Error(`export answered ${res.status}`);
		// Without its cursor the export cannot say whether parts follow: a page
		// the headers do not reach would save the first part as the whole.
		const lastSeq = res.headers.get("X-Lasterm-Cast-Last-Seq");
		const lost = res.headers.get("X-Lasterm-Cast-Lost");
		if (lastSeq === null || lost === null) throw new Error("export without its cursor headers");
		yield await res.text();
		let next = res.headers.get("X-Lasterm-Cast-Next-Seq");
		while (next !== null) {
			res = await hubFetch(`${base}?from_seq=${next}&last_seq=${lastSeq}&lost=${lost}`, {
				headers: authHeaders(),
			});
			if (!res.ok) throw new Error(`export answered ${res.status}`);
			yield await res.text();
			next = res.headers.get("X-Lasterm-Cast-Next-Seq");
		}
	}

	async function stop(recordingId: string): Promise<void> {
		const res = await hubFetch(
			`${hubBaseUrl()}/api/recordings/${encodeURIComponent(recordingId)}/stop`,
			{ method: "POST", headers: authHeaders() },
		);
		if (!res.ok) throw new Error(`stop answered ${res.status}`);
	}

	async function discard(recordingId: string): Promise<boolean> {
		let res: Response;
		try {
			res = await hubFetch(`${hubBaseUrl()}/api/recordings/${encodeURIComponent(recordingId)}`, {
				method: "DELETE",
				headers: authHeaders(),
			});
		} catch {
			return false;
		}
		if (res.ok) {
			rows.value = rows.value.filter((r) => r.id !== recordingId);
			void refresh();
		}
		return res.ok;
	}

	/**
	 * Save a recording to a file the user picks, then delete the hub's copy.
	 *
	 * Called from the click itself: the save dialog opens first, before any
	 * request, while the click still counts as the user's gesture. An open
	 * recording is stopped next, then every part is written in order, the file
	 * closed, and only then is the copy deleted. A cancelled dialog changes
	 * nothing; any failure after it deletes nothing. Without the dialog (no File
	 * System Access API), the file downloads and the copy stays listed until
	 * Discard: nothing tells this page the download succeeded.
	 */
	function save(
		recording: { id: string; title: string; startedAt: string },
		isOpen: boolean,
	): Promise<void> {
		const suggestedName = recordingFileName(recording.title, recording.startedAt);
		const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
		if (picker === undefined) return download(recording.id, isOpen, suggestedName);
		let handle: ReturnType<SaveFilePicker>;
		try {
			handle = picker({
				suggestedName,
				types: [
					{ description: "asciicast recording", accept: { "application/x-asciicast": [".cast"] } },
				],
			});
		} catch (err) {
			handle = Promise.reject(err);
		}
		return (async () => {
			let file: Awaited<typeof handle>;
			try {
				file = await handle;
			} catch (err) {
				// Cancelled: nothing changes. Any other refusal of the dialog is said.
				if (!(err instanceof DOMException && err.name === "AbortError")) {
					useToastStore().show(
						"error",
						"The save dialog could not open. The recording is still in Recordings.",
					);
				}
				return;
			}
			let writable: WritableLike | null = null;
			try {
				// Opened before the stop, so any failure after the dialog goes through abort().
				writable = await file.createWritable();
				if (isOpen) await stop(recording.id);
				for await (const part of castParts(recording.id)) await writable.write(part);
				await writable.close();
			} catch {
				await writable?.abort().catch(() => undefined);
				// The dialog made the file already: it is left empty, or as it was.
				useToastStore().show(
					"error",
					"The recording could not be saved, and the file you chose may be empty. It is still in Recordings.",
				);
				void refresh();
				return;
			}
			if (!(await discard(recording.id))) {
				useToastStore().show(
					"warning",
					"The recording was saved, but its copy could not be removed from Recordings.",
				);
			}
		})();
	}

	async function download(recordingId: string, isOpen: boolean, name: string): Promise<void> {
		try {
			if (isOpen) await stop(recordingId);
			// The parts as they came, never joined into one string (a string holds at most ~512 M characters).
			const parts: string[] = [];
			for await (const part of castParts(recordingId)) parts.push(part);
			const url = URL.createObjectURL(new Blob(parts, { type: "application/x-asciicast" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
			// Revoked once the download has had time to start: some browsers
			// drop a download whose URL goes in the same turn as the click.
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch {
			useToastStore().show("error", "The recording could not be saved. It is still in Recordings.");
		}
		void refresh();
	}

	return {
		open,
		rows,
		usedBytes,
		capBytes,
		onState,
		registerHandlers,
		refresh,
		stopRetrying,
		listFetchStarted,
		mergeListed,
		start,
		stop,
		discard,
		save,
		castParts,
	};
});
