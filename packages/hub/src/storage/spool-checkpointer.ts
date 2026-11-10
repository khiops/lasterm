import { Worker, type WorkerOptions } from "node:worker_threads";
import type { Database } from "./sqlite.js";

const CHECKPOINT_PAUSE_MS = 1000;
const THRESHOLD_FRAMES = 65_536;
const WAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;
const FALLBACK_FRAMES = 2000;
const STOP = 0;

/** Fault injection for storage lifecycle tests; production leaves these unset. */
export interface SpoolCheckpointerTestOptions {
	readonly closeDelayMs?: number;
	readonly workerSource?: string;
	readonly createWorker?: (source: string, options: WorkerOptions) => Worker;
}

export interface SpoolCheckpointer {
	stop(): Promise<void>;
	/** Observability for ordering/failure tests, not a second lifecycle owner. */
	readonly worker: Worker | undefined;
	readonly ready: Promise<void>;
}

// CommonJS source, rather than a module path: the SEA carries no worker file.
// Alongside sqlite.ts this is the only node:sqlite boundary (#786).
function workerSource(closeDelayMs: number): string {
	return `
const { DatabaseSync } = require("node:sqlite");
const { workerData, parentPort } = require("node:worker_threads");
const { path, control } = workerData;
const db = new DatabaseSync(path, { timeout: 5000 });
try {
  db.exec("PRAGMA synchronous = NORMAL");
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  parentPort.postMessage("ready");
  while (Atomics.wait(control, ${STOP}, 0, ${CHECKPOINT_PAUSE_MS}) === "timed-out") {
    checkpoint.get();
  }
} finally {
  ${closeDelayMs > 0 ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${closeDelayMs});` : ""}
  db.close();
}
`;
}

export function startSpoolCheckpointer(
	path: string,
	spool: Database,
	testOptions: SpoolCheckpointerTestOptions = {},
): SpoolCheckpointer {
	spool.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
	spool.pragma(`wal_autocheckpoint = ${THRESHOLD_FRAMES}`);
	const control = new Int32Array(new SharedArrayBuffer(4));
	let reported = false;
	const fallback = (code: string) => {
		if (reported) return;
		reported = true;
		if (spool.open) spool.pragma(`wal_autocheckpoint = ${FALLBACK_FRAMES}`);
		process.stderr.write(
			`[storage] spool checkpoint worker stopped (${code}): checkpoints run on commits again\n`,
		);
	};
	const errorCode = (error: unknown): string => {
		return error instanceof Error
			? ((error as NodeJS.ErrnoException).code ?? error.name)
			: typeof error;
	};
	let worker: Worker;
	try {
		const source = testOptions.workerSource ?? workerSource(testOptions.closeDelayMs ?? 0);
		const options = { eval: true, workerData: { path, control } };
		worker = testOptions.createWorker
			? testOptions.createWorker(source, options)
			: new Worker(source, options);
	} catch (error) {
		fallback(errorCode(error));
		const finished = Promise.resolve();
		return { worker: undefined, ready: finished, stop: () => finished };
	}

	let stopping = false;
	let exited = false;
	const ready = new Promise<void>((resolve) => worker.once("message", () => resolve()));
	worker.on("error", (error) => {
		if (!stopping) fallback(errorCode(error));
	});
	const exit = new Promise<void>((resolve) => {
		worker.once("exit", (code) => {
			exited = true;
			if (!stopping) fallback(`exit ${code}`);
			resolve();
		});
	});
	worker.unref();
	return {
		worker,
		ready,
		stop() {
			stopping = true;
			if (!exited) {
				worker.ref();
				Atomics.store(control, STOP, 1);
				Atomics.notify(control, STOP);
			}
			return exit;
		},
	};
}
