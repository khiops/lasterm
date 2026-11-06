import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { HostOs, TransferVerification } from "@lasterm/shared";
import { FileAccessError, type FileEntry } from "./host-files.js";
import { pathStyleOf } from "./host-paths.js";
import { LocalFileBackend, localFailure, localHostOs } from "./local-files.js";
import {
	type FolderResult,
	isFolderLike,
	type OpenOptions,
	type PlaceResult,
	TargetExists,
	type UploadBackend,
	type UploadSink,
	VerifyFailed,
} from "./upload-backend.js";

/** How often a rename refused on Windows (a scanner or an indexer has the file open) is tried. */
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 100;

/** The errors that say a file system makes no hard links, where a copy places the file instead. */
const NO_HARD_LINKS = new Set([
	"EPERM",
	"ENOTSUP",
	"EOPNOTSUPP",
	"ENOSYS",
	"EXDEV",
	"EINVAL",
	"EMLINK",
]);

function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class LocalSink implements UploadSink {
	constructor(
		private readonly file: fs.FileHandle,
		private readonly path: string,
		private readonly options: OpenOptions,
	) {}

	async write(data: Buffer, offset: number): Promise<void> {
		let written = 0;
		try {
			while (written < data.length) {
				written += (await this.file.write(data, written, data.length - written, offset + written))
					.bytesWritten;
			}
		} catch (error) {
			throw localFailure(error, "The file could not be written");
		}
	}

	async finish(): Promise<TransferVerification> {
		try {
			await this.file.sync();
			if (this.options.mtime !== null) {
				const time = new Date(this.options.mtime);
				await this.file.utimes(time, time);
			}
		} catch (error) {
			await this.file.close().catch(() => {});
			throw localFailure(error, "The file could not be written");
		}
		await this.file.close();
		const { size } = await fs.lstat(this.path);
		if (size !== this.options.size) {
			throw new VerifyFailed(
				"SIZE_MISMATCH",
				`${size} of ${this.options.size} bytes are on the host`,
			);
		}
		return "size";
	}

	async abort(): Promise<void> {
		await this.file.close().catch(() => {});
	}
}

/**
 * The local host's files for an upload, through the hub's own file system,
 * as the OS user the local agent runs terminals as.
 *
 * The temporary is created with `wx` (O_CREAT | O_EXCL), synced, then placed
 * with `link` (which refuses a name that exists) and unlinked. Where the file
 * system makes no hard links, `copyFile` with `COPYFILE_EXCL` places it
 * instead, as exclusive. Replace is `rename`, retried while Windows says the
 * target is busy.
 */
export class LocalUploadBackend implements UploadBackend {
	readonly transport = "local";
	readonly style;
	readonly lost = false;
	private readonly browse: LocalFileBackend;

	constructor(os: HostOs = localHostOs()) {
		this.style = pathStyleOf(os);
		this.browse = new LocalFileBackend(os);
	}

	list(dir: string): Promise<FileEntry[]> {
		return this.browse.list(dir, true);
	}

	stat(path: string): Promise<FileEntry> {
		return this.browse.stat(path);
	}

	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		return this.browse.freeSpace(dir);
	}

	async mkdirs(paths: readonly string[]): Promise<FolderResult[]> {
		const results: FolderResult[] = [];
		for (const path of paths) {
			try {
				await fs.mkdir(path);
				results.push({ kind: "created" });
			} catch (error) {
				if (codeOf(error) !== "EEXIST") {
					results.push({
						kind: "failed",
						error: localFailure(error, "The folder could not be created", true),
					});
					continue;
				}
				const there = await this.browse.stat(path).catch(() => null);
				results.push(
					there !== null && isFolderLike(there)
						? { kind: "merged" }
						: { kind: "clash", existing: there },
				);
			}
		}
		return results;
	}

	async open(path: string, options: OpenOptions): Promise<UploadSink> {
		let file: fs.FileHandle;
		try {
			file = await fs.open(path, options.resumeAt === 0 ? "wx" : "r+");
		} catch (error) {
			if (codeOf(error) === "EEXIST") {
				throw new TargetExists(await this.browse.stat(path).catch(() => null));
			}
			throw localFailure(error, "The file could not be created", options.resumeAt === 0);
		}
		return new LocalSink(file, path, options);
	}

	async place(temp: string, target: string, replace: boolean): Promise<PlaceResult> {
		if (replace) {
			if ((await this.statOrNull(target))?.kind === "directory") {
				throw new FileAccessError("ALREADY_EXISTS", "A folder has that name: it is not replaced");
			}
			for (let attempt = 1; ; attempt++) {
				try {
					await fs.rename(temp, target);
					return { kind: "placed" };
				} catch (error) {
					const busy = ["EPERM", "EBUSY", "EACCES"].includes(codeOf(error) ?? "");
					if (!busy || attempt >= RENAME_ATTEMPTS) {
						throw localFailure(error, "The file could not be put in place");
					}
					await sleep(RENAME_RETRY_MS);
				}
			}
		}
		try {
			await fs.link(temp, target);
		} catch (error) {
			if (codeOf(error) === "EEXIST") return this.exists(target);
			if (!NO_HARD_LINKS.has(codeOf(error) ?? "")) {
				throw localFailure(error, "The file could not be put in place");
			}
			try {
				await fs.copyFile(temp, target, constants.COPYFILE_EXCL);
			} catch (copyError) {
				if (codeOf(copyError) === "EEXIST") return this.exists(target);
				throw localFailure(copyError, "The file could not be put in place");
			}
			// A copy is a new file: it takes the temporary's time again.
			const { mtime } = await fs.stat(temp);
			await fs.utimes(target, mtime, mtime).catch(() => {});
		}
		await this.remove(temp);
		return { kind: "placed" };
	}

	async remove(path: string): Promise<void> {
		await fs.rm(path, { force: true }).catch(() => {});
	}

	async truncate(path: string, size: number): Promise<void> {
		// Not through a link: a temporary is a file the hub created, and a link
		// put in its place is not followed (where the system has O_NOFOLLOW).
		let file: fs.FileHandle;
		try {
			file = await fs.open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
		} catch (error) {
			throw localFailure(error, "The file could not be cut to what the host acknowledged");
		}
		try {
			await file.truncate(size);
		} catch (error) {
			throw localFailure(error, "The file could not be cut to what the host acknowledged");
		} finally {
			await file.close().catch(() => {});
		}
	}

	async placement(): Promise<"temp"> {
		return "temp";
	}

	release(): void {}

	private async exists(target: string): Promise<PlaceResult> {
		return { kind: "exists", existing: await this.statOrNull(target) };
	}

	private statOrNull(path: string): Promise<FileEntry | null> {
		return this.browse.stat(path).catch(() => null);
	}
}
