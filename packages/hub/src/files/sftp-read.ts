import { Readable } from "node:stream";
import type { Stats } from "ssh2";
import {
	describeError,
	SftpChannelClosed,
	type SftpSession,
	sftpRequest,
} from "../session/ssh-file-transport.js";
import { FileAccessError, REASONS } from "./host-files.js";
import type { PathStyle } from "./host-paths.js";
import {
	type FileLook,
	fileChanged,
	linkNotFollowed,
	notAFile,
	type OpenedFile,
	type ReadBackend,
	sameLook,
} from "./read-backend.js";
import {
	hostNotConnected,
	isMissing,
	type SharedSftp,
	sftpPathOf,
	statusOf,
} from "./sftp-files.js";

/** How many bytes one SFTP READ asks for. */
export const SFTP_READ_BYTES = 64 * 1024;

/**
 * How many READs are outstanding at once. ssh2's own `createReadStream` keeps
 * one in flight, so a download would go at one 64 KiB block per round trip.
 */
export const SFTP_READS_IN_FLIGHT = 8;

const PERMISSION_DENIED = 3;
const WHAT = "The file could not be read";

/** `S_IFMT` and the kinds a download tells apart. */
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * A host's files over SFTP, for a download (#840). The shared session is held
 * from before the open to the close, so its idle close never runs under a read
 * (`SharedSftp.hold`).
 */
export class SftpReadBackend implements ReadBackend {
	constructor(
		private readonly shared: SharedSftp,
		private readonly style: PathStyle,
		/** Called between the LSTAT and the OPEN, for tests that change the file there. */
		private readonly betweenLookAndOpen?: (path: string) => Promise<void>,
		/** Called before the second look, for tests that change the file there. */
		readonly beforeRecheck?: (path: string) => Promise<void>,
	) {}

	async open(path: string): Promise<OpenedFile> {
		const release = this.shared.hold();
		try {
			const session = await this.shared.current();
			const wire = sftpPathOf(path, this.style);
			const before = await this.request<Stats>(session, (done) =>
				session.channel.lstat(wire, done),
			);
			const type = before.mode & S_IFMT;
			if (type === S_IFLNK) throw linkNotFollowed(WHAT);
			if (type !== S_IFREG) throw notAFile(WHAT);
			await this.betweenLookAndOpen?.(path);
			const handle = await this.request<Buffer>(session, (done) =>
				session.channel.open(wire, "r", done),
			);
			const opened = new SftpOpenedFile(this, session, handle, wire, release);
			try {
				const look = await opened.lookNow();
				if (!sameLook(look, lookOf(before))) throw fileChanged(WHAT);
				opened.setLook(look);
				return opened;
			} catch (error) {
				await opened.close();
				throw error;
			}
		} catch (error) {
			release();
			throw this.failure(error);
		}
	}

	request<T>(
		session: SftpSession,
		ask: (done: (error: Error | undefined | null, value: T) => void) => void,
	): Promise<T> {
		return sftpRequest<T>(session, ask);
	}

	failure(error: unknown): Error {
		if (error instanceof FileAccessError) return error;
		if (this.shared.lost) return hostNotConnected(error);
		if (error instanceof SftpChannelClosed) return hostNotConnected(error);
		if (isMissing(error)) {
			return new FileAccessError("NOT_FOUND", `${WHAT}: ${REASONS.NOT_FOUND}`, { cause: error });
		}
		if (statusOf(error) === PERMISSION_DENIED) {
			return new FileAccessError("PERMISSION_DENIED", `${WHAT}: ${REASONS.PERMISSION_DENIED}`, {
				cause: error,
			});
		}
		return new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: SFTP said ${describeError(error)}`, {
			cause: error,
		});
	}
}

function lookOf(stats: Stats): FileLook {
	return { size: stats.size, mtime: stats.mtime, unit: "s" };
}

class SftpOpenedFile implements OpenedFile {
	private current: FileLook | null = null;
	private closed = false;

	constructor(
		private readonly backend: SftpReadBackend,
		private readonly session: SftpSession,
		private readonly handle: Buffer,
		private readonly wire: string,
		private readonly release: () => void,
	) {}

	get look(): FileLook {
		if (this.current === null) throw new Error("not looked at yet");
		return this.current;
	}

	setLook(look: FileLook): void {
		this.current = look;
	}

	/** The opened file's size and time: FSTAT, or, from a server that does not answer it, a STAT of the path. */
	async lookNow(): Promise<FileLook> {
		try {
			return lookOf(
				await this.backend.request<Stats>(this.session, (done) =>
					this.session.channel.fstat(this.handle, done),
				),
			);
		} catch (error) {
			if (this.session.ended) throw error;
			return lookOf(
				await this.backend.request<Stats>(this.session, (done) =>
					this.session.channel.stat(this.wire, done),
				),
			);
		}
	}

	async read(start: number, length: number): Promise<Readable> {
		return new SftpReadStream(this.backend, this.session, this.handle, start, length);
	}

	async recheck(): Promise<FileLook> {
		await this.backend.beforeRecheck?.(this.wire);
		try {
			return await this.lookNow();
		} catch (error) {
			throw this.backend.failure(error);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			if (!this.session.ended) {
				await this.backend.request<void>(this.session, (done) =>
					this.session.channel.close(this.handle, (error) => done(error, undefined)),
				);
			}
		} catch {
			// The handle goes with the session, if it is gone.
		} finally {
			this.release();
		}
	}
}

/**
 * The bytes `[start, start + length)` of an open SFTP file, in order, with up
 * to `SFTP_READS_IN_FLIGHT` READs outstanding and none asked while the reader
 * is paused. A short answer has its rest asked before the next block is given;
 * an end of file before `length` fails the stream.
 */
export class SftpReadStream extends Readable {
	private next: number;
	private readonly end: number;
	private readonly queue: Array<{ offset: number; length: number; result: Promise<Buffer> }> = [];
	private pumping = false;
	private wanted = false;

	constructor(
		private readonly backend: SftpReadBackend,
		private readonly session: SftpSession,
		private readonly handle: Buffer,
		start: number,
		length: number,
	) {
		super({ highWaterMark: SFTP_READ_BYTES });
		this.next = start;
		this.end = start + length;
	}

	override _read(): void {
		this.wanted = true;
		void this.pump();
	}

	private ask(offset: number, length: number): Promise<Buffer> {
		return this.backend.request<Buffer>(this.session, (done) => {
			const buffer = Buffer.allocUnsafe(length);
			this.session.channel.read(this.handle, buffer, 0, length, offset, (error, bytesRead) =>
				done(error, buffer.subarray(0, bytesRead ?? 0)),
			);
		});
	}

	private fill(): void {
		while (this.queue.length < SFTP_READS_IN_FLIGHT && this.next < this.end) {
			const length = Math.min(SFTP_READ_BYTES, this.end - this.next);
			const offset = this.next;
			const result = this.ask(offset, length);
			// Settled when its turn comes; never an unhandled rejection meanwhile.
			result.catch(() => {});
			this.queue.push({ offset, length, result });
			this.next += length;
		}
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.wanted && !this.destroyed) {
				this.fill();
				const head = this.queue.shift();
				if (head === undefined) {
					this.push(null);
					return;
				}
				let { offset, length } = head;
				let data = await head.result;
				while (!this.destroyed) {
					if (data.length === 0) {
						throw new FileAccessError("FILE_CHANGED", `${WHAT}: ${REASONS.FILE_CHANGED}`);
					}
					this.wanted = this.push(data);
					if (data.length === length) break;
					offset += data.length;
					length -= data.length;
					data = await this.ask(offset, length);
				}
			}
		} catch (error) {
			this.destroy(this.backend.failure(error));
		} finally {
			this.pumping = false;
		}
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.queue.length = 0;
		callback(error);
	}
}
