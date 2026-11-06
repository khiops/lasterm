import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { type Attributes, type Connection, Server, utils } from "ssh2";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const codes = utils.sftp.STATUS_CODE;

/** How many entries one READDIR answers, as a server splits a large folder. */
const READDIR_BATCH = 64;

export interface SftpServerOptions {
	sftp?: boolean;
	/** False: refuse every exec request, as a server that runs no command for this account. */
	exec?: boolean;
	closeOnRequest?: {
		type: "STAT" | "LSTAT" | "MKDIR" | "OPEN" | "OPENDIR" | "READDIR" | "WRITE" | "SETSTAT";
		occurrence?: number;
		connection?: boolean;
	};
	/**
	 * How SFTP spells paths. Without it, as this machine's file system does. With
	 * it, `root` seen as a host would show it (#832):
	 * - `posix` serves `/x` from `<root>/x`, its home at `/home/test`;
	 * - `windows` serves `C:\x`, `C:/x` and `/C:/x` from `<root>/C/x`, lists the
	 *   drives (`<root>`'s one-letter folders) at `/`, and answers `realpath` as
	 *   Win32-OpenSSH does, `/C:/Users/test`.
	 *
	 * Exec requests still run on this machine's paths.
	 */
	view?: { style: "posix" | "windows"; root: string };
	/**
	 * What runs an exec request: `/bin/sh -c` by default, or `cmd.exe /c "…"`
	 * as Win32-OpenSSH runs it under its default shell (Windows only).
	 */
	shell?: "sh" | "cmd";
	/** What every exec prints before its command does, as an account's profile may (#749). */
	prelude?: string;
}

/** A path as the client sent it, mapped on to this machine's; null for one the view does not serve. */
type PathMap = (path: string) => string | null;

function pathMap(view: SftpServerOptions["view"]): PathMap {
	if (view === undefined) return (path) => path;
	if (view.style === "posix") {
		return (path) => {
			const absolute = path.startsWith("/") ? path : `/home/test/${path}`;
			return join(view.root, ...absolute.split("/").filter((part) => part !== "" && part !== "."));
		};
	}
	return (path) => {
		const match = /^\/?([A-Za-z]):((?:[\\/].*)?)$/s.exec(path);
		if (!match) return null;
		const [, drive = "", rest = ""] = match;
		return join(
			view.root,
			drive.toUpperCase(),
			...rest.split(/[\\/]/).filter((part) => part !== ""),
		);
	};
}

function attrsOf(stat: Stats) {
	return {
		mode: stat.mode,
		size: stat.size,
		uid: stat.uid,
		gid: stat.gid,
		atime: Math.floor(stat.atimeMs / 1000),
		mtime: Math.floor(stat.mtimeMs / 1000),
	};
}

/**
 * A real ssh2 server on loopback, password-authenticated, whose exec runs
 * `/bin/sh -c` with the channel on its stdin, and whose SFTP acts on the
 * filesystem. With `sftp: false` it refuses the subsystem, as a server whose
 * `sshd_config` has no `Subsystem sftp` does (#722).
 */
export async function startSftpServer(options: SftpServerOptions = {}): Promise<{
	port: number;
	password: string;
	/** Every command an exec request asked for, in order. */
	execCommands: string[];
	/** How many times a client asked for the SFTP subsystem, granted or refused. */
	sftpRequests: () => number;
	/** How many SFTP sessions have closed. */
	sftpClosures: () => number;
	closeFirings: () => number;
	firedRequest: () => string | undefined;
	sftpClosed: Promise<void>;
	close: () => Promise<void>;
}> {
	const offersSftp = options.sftp ?? true;
	const local = pathMap(options.view);
	const windowsView = options.view?.style === "windows";
	const execCommands: string[] = [];
	let sftpRequests = 0;
	let sftpClosures = 0;
	let closeFirings = 0;
	let firedRequest: string | undefined;
	let matchingRequests = 0;
	let channelClosed!: () => void;
	const sftpClosed = new Promise<void>((resolve) => {
		channelClosed = resolve;
	});
	const password = randomBytes(32).toString("hex");
	const expectedPassword = Buffer.from(password);
	const clients = new Set<Connection>();
	const handles = new Map<string, fs.FileHandle>();
	const dirs = new Map<string, { names: string[]; from: string }>();
	let nextHandle = 0;
	const server = new Server({ hostKeys: [privateKey] }, (client) => {
		clients.add(client);
		client.on("close", () => clients.delete(client));
		client.on("error", () => {});
		client.on("authentication", (context) => {
			if (context.method === "password") {
				const supplied = Buffer.from(context.password);
				if (
					supplied.length === expectedPassword.length &&
					timingSafeEqual(supplied, expectedPassword)
				) {
					context.accept();
					return;
				}
			}
			context.reject();
		});
		client.on("ready", () => {
			client.on("session", (accept) => {
				const session = accept();
				session.on("exec", (acceptExec, rejectExec, info) => {
					execCommands.push(info.command);
					if (options.exec === false) {
						rejectExec();
						return;
					}
					const stream = acceptExec();
					if (options.prelude !== undefined) stream.write(options.prelude);
					const child =
						options.shell === "cmd"
							? spawn("cmd.exe", ["/c", `"${info.command}"`], {
									windowsVerbatimArguments: true,
									windowsHide: true,
								})
							: spawn("/bin/sh", ["-c", info.command]);
					// A command that exits without reading all of it closes its stdin under the pipe.
					child.stdin.on("error", () => {});
					stream.pipe(child.stdin);
					child.stdout.pipe(stream, { end: false });
					child.stderr.pipe(stream.stderr, { end: false });
					child.on("close", (code) => {
						stream.unpipe(child.stdin);
						stream.exit(code ?? 1);
						stream.end();
					});
				});
				session.on("sftp", (acceptSftp, rejectSftp) => {
					sftpRequests++;
					if (!offersSftp) {
						rejectSftp();
						return;
					}
					const sftp = acceptSftp();
					sftp.once("close", () => {
						sftpClosures++;
						channelClosed();
					});
					const intercept = (type: string): boolean => {
						const close = options.closeOnRequest;
						if (!close || type !== close.type || closeFirings !== 0) return false;
						if (++matchingRequests !== (close.occurrence ?? 1)) return false;
						closeFirings++;
						firedRequest = type;
						if (close.connection) client.end();
						else sftp.end();
						return true;
					};
					const status = (id: number, error?: unknown) => {
						// OpenSSH errno_to_portable: https://github.com/openssh/openssh-portable/blob/master/sftp-server.c
						const errno = (error as NodeJS.ErrnoException | undefined)?.code;
						const [code, message] = !error
							? [codes.OK, "Success"]
							: ["ENOENT", "ENOTDIR", "EBADF", "ELOOP"].includes(errno ?? "")
								? [codes.NO_SUCH_FILE, "No such file"]
								: ["EPERM", "EACCES", "EFAULT"].includes(errno ?? "")
									? [codes.PERMISSION_DENIED, "Permission denied"]
									: ["ENAMETOOLONG", "EINVAL"].includes(errno ?? "")
										? [codes.BAD_MESSAGE, "Bad message"]
										: errno === "ENOSYS"
											? [codes.OP_UNSUPPORTED, "Operation unsupported"]
											: [codes.FAILURE, "Failure"];
						sftp.status(id, code as number, message as string);
					};
					const missing = () => Object.assign(new Error("No such file"), { code: "ENOENT" });
					/** The local path, or a rejection as a path the view does not serve. */
					const resolve = (path: string): Promise<string> => {
						const mapped = local(path);
						return mapped === null ? Promise.reject(missing()) : Promise.resolve(mapped);
					};
					/** The drives' root of a Windows view. */
					const isDrives = (path: string) => windowsView && /^[\\/]+$/.test(path);
					const run = (id: number, action: () => Promise<unknown>) => {
						void action().then(
							() => status(id),
							(error) => status(id, error),
						);
					};
					sftp.on("MKDIR", (id, path) => {
						if (intercept("MKDIR")) return;
						run(id, async () => fs.mkdir(await resolve(path)));
					});
					for (const event of ["STAT", "LSTAT"] as const) {
						sftp.on(event, (id: number, path: string) => {
							if (intercept(event)) return;
							if (isDrives(path)) {
								sftp.attrs(id, { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 });
								return;
							}
							void resolve(path)
								.then((mapped) => (event === "STAT" ? fs.stat(mapped) : fs.lstat(mapped)))
								.then(
									(stat) => sftp.attrs(id, attrsOf(stat)),
									(error) => status(id, error),
								);
						});
					}
					sftp.on("OPEN", (id, path, flags) => {
						if (intercept("OPEN")) return;
						const mode = utils.sftp.flagsToString(flags);
						if (mode === null) {
							sftp.status(id, codes.BAD_MESSAGE, "Bad message");
							return;
						}
						void resolve(path)
							.then((mapped) => fs.open(mapped, mode))
							.then(
								(file) => {
									const handle = String(nextHandle++);
									handles.set(handle, file);
									sftp.handle(id, Buffer.from(handle));
								},
								(error) => status(id, error),
							);
					});
					sftp.on("OPENDIR", (id, path) => {
						if (intercept("OPENDIR")) return;
						const listed = isDrives(path)
							? fs.readdir(options.view?.root ?? "").then((names) => ({
									names: names.filter((name) => /^[A-Z]$/.test(name)),
									from: "",
								}))
							: resolve(path).then(async (mapped) => {
									// Like opendir(3): a file is ENOTDIR, which OpenSSH says as "No such file".
									const names = await fs.readdir(mapped);
									return { names: [".", "..", ...names], from: mapped };
								});
						void listed.then(
							(dir) => {
								const handle = String(nextHandle++);
								dirs.set(handle, dir);
								sftp.handle(id, Buffer.from(handle));
							},
							(error) => status(id, error),
						);
					});
					sftp.on("READDIR", (id, handle) => {
						if (intercept("READDIR")) return;
						const dir = dirs.get(handle.toString());
						if (!dir) {
							sftp.status(id, codes.FAILURE, "Bad handle");
							return;
						}
						const batch = dir.names.splice(0, READDIR_BATCH);
						if (batch.length === 0) {
							sftp.status(id, codes.EOF);
							return;
						}
						void Promise.all(
							batch.map(async (name) => {
								if (dir.from === "") {
									const drive = `${name}:`;
									const attrs = { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 };
									return { filename: drive, longname: drive, attrs };
								}
								const stat = await fs.lstat(join(dir.from, name)).catch(() => null);
								if (stat === null) return null;
								return { filename: name, longname: name, attrs: attrsOf(stat) };
							}),
						).then((names) =>
							sftp.name(
								id,
								names.filter((name) => name !== null),
							),
						);
					});
					// A NAME answer to REALPATH or READLINK carries no attributes.
					const noAttrs = {} as Attributes;
					sftp.on("REALPATH", (id, path) => {
						const home =
							options.view === undefined
								? process.cwd()
								: windowsView
									? "/C:/Users/test"
									: "/home/test";
						const real = path === "." || path === "" ? home : path;
						sftp.name(id, [{ filename: real, longname: real, attrs: noAttrs }]);
					});
					sftp.on("READLINK", (id, path) => {
						void resolve(path)
							.then((mapped) => fs.readlink(mapped))
							.then(
								(target) => sftp.name(id, [{ filename: target, longname: target, attrs: noAttrs }]),
								(error) => status(id, error),
							);
					});
					const file = (handle: Buffer) => {
						const result = handles.get(handle.toString());
						if (!result) throw Object.assign(new Error("Bad handle"), { code: "EBADF" });
						return result;
					};
					sftp.on("WRITE", (id, handle, offset, data) => {
						if (intercept("WRITE")) return;
						run(id, async () => {
							let written = 0;
							while (written < data.length)
								written += (
									await file(handle).write(data, written, data.length - written, offset + written)
								).bytesWritten;
						});
					});
					sftp.on("CLOSE", (id, handle) =>
						run(id, async () => {
							if (dirs.delete(handle.toString())) return;
							await file(handle).close();
							handles.delete(handle.toString());
						}),
					);
					sftp.on("SETSTAT", (id, path, attrs) => {
						if (intercept("SETSTAT")) return;
						run(id, async () => {
							if (attrs.mode !== undefined) await fs.chmod(await resolve(path), attrs.mode);
						});
					});
					sftp.on("REMOVE", (id, path) => run(id, async () => fs.unlink(await resolve(path))));
					for (const event of [
						"READ",
						"FSTAT",
						"FSETSTAT",
						"RMDIR",
						"RENAME",
						"SYMLINK",
						"EXTENDED",
					] as const) {
						sftp.on(event, (id: number) =>
							sftp.status(id, codes.OP_UNSUPPORTED, "Operation unsupported"),
						);
					}
				});
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		password,
		port: (server.address() as { port: number }).port,
		execCommands,
		sftpRequests: () => sftpRequests,
		sftpClosures: () => sftpClosures,
		closeFirings: () => closeFirings,
		firedRequest: () => firedRequest,
		sftpClosed,
		close: async () => {
			for (const client of clients) client.end();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.all([...handles.values()].map((handle) => handle.close()));
		},
	};
}
