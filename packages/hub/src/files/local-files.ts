import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import type { HostOs } from "@lasterm/shared";
import {
	FileAccessError,
	type FileBackend,
	type FileEntry,
	type FileKind,
	isHiddenName,
	type LinkKind,
	mapLimited,
	REASONS,
} from "./host-files.js";
import {
	baseNameOf,
	joinHostPath,
	normaliseHostPath,
	type PathStyle,
	pathStyleOf,
	WINDOWS_ROOT,
} from "./host-paths.js";

/** The OS this hub runs on, as a host's `os` names it. */
export function localHostOs(platform: NodeJS.Platform = process.platform): HostOs {
	return platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
}

/** How many entries of a folder are looked at at once. */
const STAT_CONCURRENCY = 32;

/**
 * A failure of Node's `fs`, by its code; its message names the path, so it is
 * the client's only. `parent`: a missing folder, or one that is not, is the
 * new path's parent, as for mkdir.
 */
export function localFailure(error: unknown, what: string, parent = false): FileAccessError {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	switch (code) {
		case "ENOENT":
			return new FileAccessError(
				"NOT_FOUND",
				`${what}: ${parent ? REASONS.PARENT_NOT_FOUND : REASONS.NOT_FOUND}`,
				{ cause: error },
			);
		case "ENOTDIR":
			return new FileAccessError(
				"NOT_A_DIRECTORY",
				`${what}: ${parent ? REASONS.PARENT_NOT_A_DIRECTORY : REASONS.NOT_A_DIRECTORY}`,
				{ cause: error },
			);
		case "EEXIST":
			return new FileAccessError("ALREADY_EXISTS", `${what}: ${REASONS.ALREADY_EXISTS}`, {
				cause: error,
			});
		case "EACCES":
		case "EPERM":
			return new FileAccessError("PERMISSION_DENIED", `${what}: ${REASONS.PERMISSION_DENIED}`, {
				cause: error,
			});
		case "ENOSPC":
		case "EDQUOT":
			return new FileAccessError("NO_SPACE", `${what}: ${REASONS.NO_SPACE}`, { cause: error });
		default:
			return new FileAccessError(
				"FILE_ACCESS_FAILED",
				`${what}: ${code ?? (error instanceof Error ? error.message : String(error))}`,
				{ cause: error },
			);
	}
}

function kindOf(stats: Stats | Dirent): FileKind {
	if (stats.isSymbolicLink()) return "symlink";
	if (stats.isDirectory()) return "directory";
	if (stats.isFile()) return "file";
	return "other";
}

function linkKindOf(stats: Stats): LinkKind {
	if (stats.isDirectory()) return "directory";
	if (stats.isFile()) return "file";
	return "other";
}

/**
 * The local host's files, through the hub's own file system: the hub runs as
 * the OS user the local agent runs terminals as, so it reads what they can.
 * No SSH, no agent.
 */
export class LocalFileBackend implements FileBackend {
	private readonly style: PathStyle;

	constructor(os: HostOs = localHostOs()) {
		this.style = pathStyleOf(os);
	}

	async home(): Promise<string> {
		const home = normaliseHostPath(homedir(), this.style);
		return home.ok ? home.path : this.style === "windows" ? WINDOWS_ROOT : "/";
	}

	async list(dir: string, hidden: boolean): Promise<FileEntry[]> {
		if (this.style === "windows" && dir === WINDOWS_ROOT) return this.drives();
		let names: Dirent[];
		try {
			names = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			throw localFailure(error, "The folder could not be listed");
		}
		const shown = hidden ? names : names.filter((dirent) => !isHiddenName(dirent.name));
		const entries = await mapLimited(shown, STAT_CONCURRENCY, (dirent) =>
			this.entry(joinHostPath(dir, dirent.name, this.style), dirent.name).catch(() => null),
		);
		// An entry that went between the listing and its stat is no longer there.
		return entries.filter((entry): entry is FileEntry => entry !== null);
	}

	async stat(path: string): Promise<FileEntry> {
		if (this.style === "windows" && path === WINDOWS_ROOT) {
			return { name: WINDOWS_ROOT, kind: "directory", size: null, mtime: null };
		}
		try {
			return await this.entry(path, baseNameOf(path, this.style));
		} catch (error) {
			throw localFailure(error, "The path could not be read");
		}
	}

	async freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		try {
			const space = await fs.statfs(dir);
			return { available: space.bavail * space.bsize, total: space.blocks * space.bsize };
		} catch (error) {
			throw localFailure(error, "The free space could not be read");
		}
	}

	async mkdir(path: string): Promise<void> {
		try {
			await fs.mkdir(path);
		} catch (error) {
			throw localFailure(error, "The folder could not be created", true);
		}
	}

	private async entry(path: string, name: string): Promise<FileEntry> {
		const stats = await fs.lstat(path);
		const kind = kindOf(stats);
		const entry: FileEntry = {
			name,
			kind,
			size: kind === "directory" ? null : stats.size,
			mtime: Number.isFinite(stats.mtimeMs) ? new Date(stats.mtimeMs).toISOString() : null,
		};
		if (kind !== "symlink") return entry;
		const [target, followed] = await Promise.all([
			fs.readlink(path).catch(() => undefined),
			fs.stat(path).then(linkKindOf, (): LinkKind => "missing"),
		]);
		return {
			...entry,
			...(target !== undefined ? { linkTarget: target } : {}),
			linkKind: followed,
		};
	}

	/** The drives of this Windows machine: each letter whose root answers. */
	private async drives(): Promise<FileEntry[]> {
		const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
		const found = await Promise.all(
			letters.map((letter) =>
				fs.stat(`${letter}:\\`).then(
					(): FileEntry => ({ name: `${letter}:`, kind: "directory", size: null, mtime: null }),
					() => null,
				),
			),
		);
		return found.filter((entry): entry is FileEntry => entry !== null);
	}
}
