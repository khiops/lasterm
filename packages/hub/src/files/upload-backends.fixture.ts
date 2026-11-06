import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SftpExtension } from "../session/sftp-server.fixture.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { ExecFileBackend } from "./exec-files.js";
import { ExecUploadBackend } from "./exec-upload.js";
import { joinHostPath, normaliseHostPath, type PathStyle } from "./host-paths.js";
import { LocalUploadBackend } from "./local-upload.js";
import { SftpFileBackend, SharedSftp } from "./sftp-files.js";
import { SftpUploadBackend } from "./sftp-upload.js";
import { type MockSshHost, startMockSshHost } from "./ssh-host.fixture.js";
import type { UploadBackend } from "./upload-backend.js";

export const windowsMachine = process.platform === "win32";

/** How this machine spells its paths, for the backends that act on its own files. */
export const machineStyle: PathStyle = windowsMachine ? "windows" : "posix";

/** An upload backend on a host whose files are a temporary folder of this machine. */
export interface UploadHarness {
	readonly backend: UploadBackend;
	/** The destination folder, as the host spells it. */
	readonly dir: string;
	/** The path of `names` under the destination, as the host spells it. */
	at(...names: string[]): string;
	/** Where a host path is on this machine. */
	local(path: string): string;
	/** The mock SSH host, for a remote backend. */
	readonly host: MockSshHost | null;
	close(): Promise<void>;
}

export interface UploadBackendKind {
	readonly name: string;
	/** Whether it runs on this machine: SSH commands run as this machine's shell does. */
	readonly runs: boolean;
	readonly transport: "local" | "sftp" | "exec";
	start(): Promise<UploadHarness>;
}

function harness(
	backend: UploadBackend,
	style: PathStyle,
	dir: string,
	local: (path: string) => string,
	host: MockSshHost | null,
	root: string,
	extra: () => void = () => {},
): UploadHarness {
	return {
		backend,
		dir,
		at: (...names) => names.reduce((path, name) => joinHostPath(path, name, style), dir),
		local,
		host,
		close: async () => {
			backend.release();
			extra();
			await host?.close();
			await removeTempDir(root);
		},
	};
}

function hostPathOf(path: string, style: PathStyle): string {
	const normalised = normaliseHostPath(path, style);
	if (!normalised.ok) throw new Error(normalised.reason);
	return normalised.path;
}

export const LOCAL_BACKEND: UploadBackendKind = {
	name: "the hub's own file system",
	runs: true,
	transport: "local",
	start: async () => {
		const root = makeTempDir("lasterm-upload-local-");
		const dir = hostPathOf(join(root, "up"), machineStyle);
		mkdirSync(join(root, "up"));
		return harness(
			new LocalUploadBackend(windowsMachine ? "windows" : "linux"),
			machineStyle,
			dir,
			(path) => path,
			null,
			root,
		);
	},
};

/** SFTP on a mock host whose files `root` serves as a POSIX or a Windows host would show them. */
export function sftpBackend(
	style: PathStyle,
	extensions: readonly SftpExtension[],
	options: { renameReplaces?: boolean; label?: string } = {},
): UploadBackendKind {
	return {
		name: `SFTP, ${style === "windows" ? "Windows-shaped" : "POSIX"}${options.label ?? ""}`,
		runs: true,
		transport: "sftp",
		start: async () => {
			const root = makeTempDir("lasterm-upload-sftp-");
			const host = await startMockSshHost({
				view: { style, root },
				extensions,
				...(options.renameReplaces !== undefined ? { renameReplaces: options.renameReplaces } : {}),
			});
			const shared = new SharedSftp(host.client);
			const backend = new SftpUploadBackend(shared, style, new SftpFileBackend(shared, style));
			if (style === "windows") {
				mkdirSync(join(root, "C", "up"), { recursive: true });
				return harness(
					backend,
					style,
					"C:\\up",
					(path) => join(root, "C", ...path.slice(3).split("\\")),
					host,
					root,
					() => shared.close(),
				);
			}
			mkdirSync(join(root, "up"));
			return harness(
				backend,
				style,
				"/up",
				(path) => join(root, ...path.split("/").filter((part) => part !== "")),
				host,
				root,
				() => shared.close(),
			);
		},
	};
}

/**
 * SSH commands on a mock host without SFTP whose exec runs on this machine:
 * `/bin/sh` on POSIX, `cmd.exe /c` on Windows as Win32-OpenSSH runs it.
 */
export function execBackend(style: PathStyle): UploadBackendKind {
	return {
		name: `SSH commands, ${style === "windows" ? "Windows" : "POSIX"}`,
		runs: style === machineStyle,
		transport: "exec",
		start: async () => {
			const root = makeTempDir("lasterm-upload-exec-");
			const host = await startMockSshHost({
				sftp: false,
				...(style === "windows" ? { shell: "cmd" as const } : {}),
			});
			const browse = new ExecFileBackend(host.client, style, () => false);
			const backend = new ExecUploadBackend(host.client, style, () => false, browse);
			mkdirSync(join(root, "up"));
			return harness(
				backend,
				style,
				hostPathOf(join(root, "up"), style),
				(path) => path,
				host,
				root,
			);
		},
	};
}

/** Every backend, each as its host is reached. */
export const UPLOAD_BACKENDS: readonly UploadBackendKind[] = [
	LOCAL_BACKEND,
	sftpBackend("posix", ["hardlink@openssh.com", "posix-rename@openssh.com", "fsync@openssh.com"]),
	sftpBackend("posix", [], { label: " without extensions" }),
	sftpBackend("windows", ["hardlink@openssh.com", "posix-rename@openssh.com"]),
	execBackend("posix"),
	execBackend("windows"),
];
