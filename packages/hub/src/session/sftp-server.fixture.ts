import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { type Attributes, type Connection, Server, type SFTPWrapper, utils } from "ssh2";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const codes = utils.sftp.STATUS_CODE;

/** How many entries one READDIR answers, as a server splits a large folder. */
const READDIR_BATCH = 64;

/** The OpenSSH extensions this server can offer, as OpenSSH names them in its VERSION. */
export type SftpExtension =
	| "hardlink@openssh.com"
	| "posix-rename@openssh.com"
	| "fsync@openssh.com";

/**
 * Name `extensions` in the VERSION this SFTP session answers with. ssh2's server
 * always answers a bare VERSION 3, so the packet is swapped on its way out: the
 * client then offers what OpenSSH and Win32-OpenSSH offer (#833).
 */
function advertise(sftp: SFTPWrapper, extensions: readonly SftpExtension[]): void {
	if (extensions.length === 0) return;
	const inner = sftp as unknown as {
		_protocol: { channelData(id: number, data: Buffer): void };
		outgoing: { id: number };
	};
	const protocol = inner._protocol;
	const send = protocol.channelData;
	let swapped = false;
	protocol.channelData = function (this: unknown, id: number, data: Buffer) {
		// VERSION: uint32 length 5, type 2, uint32 version.
		if (!swapped && id === inner.outgoing.id && data.length === 9 && data[4] === 2) {
			swapped = true;
			const strings = extensions
				.flatMap((name) => [name, "1"])
				.map((text) => {
					const bytes = Buffer.from(text, "utf8");
					const length = Buffer.alloc(4);
					length.writeUInt32BE(bytes.length);
					return Buffer.concat([length, bytes]);
				});
			const body = Buffer.concat([Buffer.from([2, 0, 0, 0, 3]), ...strings]);
			const length = Buffer.alloc(4);
			length.writeUInt32BE(body.length);
			return send.call(this, id, Buffer.concat([length, body]));
		}
		return send.call(this, id, data);
	};
}

/** The strings an EXTENDED request carries after its name. */
function readStrings(data: Buffer | undefined, count: number): Buffer[] {
	const strings: Buffer[] = [];
	let at = 0;
	for (let i = 0; i < count && data !== undefined && at + 4 <= data.length; i++) {
		const length = data.readUInt32BE(at);
		strings.push(data.subarray(at + 4, at + 4 + length));
		at += 4 + length;
	}
	return strings;
}

export interface SftpServerOptions {
	sftp?: boolean;
	/** False: refuse every exec request, as a server that runs no command for this account. */
	exec?: boolean;
	closeOnRequest?: {
		type:
			| "STAT"
			| "LSTAT"
			| "MKDIR"
			| "OPEN"
			| "OPENDIR"
			| "READDIR"
			| "WRITE"
			| "SETSTAT"
			| "RENAME"
			| "EXTENDED";
		occurrence?: number;
		connection?: boolean;
	};
	/**
	 * How SFTP spells paths. Without it, as this machine's file system does. With
	 * it, `root` seen as a host would show it (#832):
	 * - `posix` serves `/x` from `<root>/x`, its home at `/home/test`;
	 * - `windows` serves `C:\x`, `C:/x` and `/C:/x` from `<root>/C/x`, lists the
	 *   drives (`<root>`'s one-letter folders) at `/`, and answers `realpath` as
	 *   Win32-OpenSSH does, `/C:/Users/test`. A share is served as Win32-OpenSSH
	 *   9.5 serves one: `//server/share/x` from `<root>/UNC/server/share/x`, its
	 *   realpath `///server/share/x`; `\\server\share` is a folder of drive C:,
	 *   which does not exist, and `/\\server\share` a bad message.
	 *
	 * `home` is what `realpath(".")` answers, in the server's own form.
	 * Exec requests still run on this machine's paths.
	 */
	view?: { style: "posix" | "windows"; root: string; home?: string };
	/**
	 * What runs an exec request: `/bin/sh -c` by default, or `cmd.exe /c "…"`
	 * as Win32-OpenSSH runs it under its default shell (Windows only).
	 */
	shell?: "sh" | "cmd";
	/** What every exec prints before its command does, as an account's profile may (#749). */
	prelude?: string;
	/** The environment exec requests run with under `/bin/sh`, as an account's would; this process's by default. */
	execEnv?: NodeJS.ProcessEnv;
	/**
	 * The OpenSSH extensions the server offers (#833); none by default. With
	 * `hardlink@openssh.com`, a link refuses a name that exists, as link(2);
	 * `posix-rename@openssh.com` replaces, as rename(2), and as Win32-OpenSSH's.
	 */
	extensions?: readonly SftpExtension[];
	/**
	 * Whether the plain SFTP rename replaces what it lands on. By default it
	 * refuses a name that exists with `SSH_FX_FAILURE`, as OpenSSH and
	 * Win32-OpenSSH 9.5 both do; some servers replace.
	 */
	renameReplaces?: boolean;
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
		const share = /^\/\/([^/\\]+)\/([^/\\]+)((?:\/.*)?)$/s.exec(path);
		if (share) {
			const [, server = "", name = "", rest = ""] = share;
			return join(view.root, "UNC", server, name, ...rest.split("/").filter((part) => part !== ""));
		}
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
	/** Every path an SFTP request named, as the client sent it, in order. */
	sftpPaths: string[];
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
	const sftpPaths: string[] = [];
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
							: spawn("/bin/sh", ["-c", info.command], {
									...(options.execEnv !== undefined ? { env: options.execEnv } : {}),
								});
					// A command that exits without reading all of it closes its stdin under the pipe.
					child.stdin.on("error", () => {});
					stream.pipe(child.stdin);
					// A channel that closes, with its connection or alone, ends the command's
					// stdin, as sshd closes its pipes: a command that reads until then ends.
					stream.once("close", () => child.stdin.end());
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
					advertise(sftp, options.extensions ?? []);
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
						sftpPaths.push(path);
						if (windowsView && path.startsWith("/\\")) {
							return Promise.reject(Object.assign(new Error("Bad message"), { code: "EINVAL" }));
						}
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
							options.view?.home ??
							(options.view === undefined
								? process.cwd()
								: windowsView
									? "/C:/Users/test"
									: "/home/test");
						// Win32-OpenSSH 9.5 answers a share with three leading slashes.
						const real =
							path === "." || path === ""
								? home
								: windowsView && /^\/\/[^/]/.test(path)
									? `/${path}`
									: path;
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
					sftp.on("FSETSTAT", (id, handle, attrs) =>
						run(id, async () => {
							if (attrs.mtime !== undefined) {
								await file(handle).utimes(attrs.atime ?? attrs.mtime, attrs.mtime);
							}
							if (attrs.size !== undefined) await file(handle).truncate(attrs.size);
						}),
					);
					// rename(2) replaces, on POSIX and through Node on Windows alike: a server
					// that refuses an existing name looks first.
					sftp.on("RENAME", (id, from, to) => {
						if (intercept("RENAME")) return;
						run(id, async () => {
							const [source, target] = [await resolve(from), await resolve(to)];
							if (!options.renameReplaces && (await fs.lstat(target).catch(() => null)) !== null) {
								throw Object.assign(new Error("exists"), { code: "EEXIST" });
							}
							await fs.rename(source, target);
						});
					});
					sftp.on("EXTENDED", (id, name, data) => {
						if (intercept("EXTENDED")) return;
						const offered = (options.extensions ?? []) as readonly string[];
						if (!offered.includes(name)) {
							sftp.status(id, codes.OP_UNSUPPORTED, "Operation unsupported");
							return;
						}
						if (name === "fsync@openssh.com") {
							const [handle] = readStrings(data, 1);
							run(id, async () => file(handle ?? Buffer.alloc(0)).sync());
							return;
						}
						const [from = Buffer.alloc(0), to = Buffer.alloc(0)] = readStrings(data, 2);
						run(id, async () => {
							const [source, target] = [
								await resolve(from.toString()),
								await resolve(to.toString()),
							];
							if (name === "hardlink@openssh.com") await fs.link(source, target);
							else await fs.rename(source, target);
						});
					});
					for (const event of ["READ", "FSTAT", "RMDIR", "SYMLINK"] as const) {
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
		sftpPaths,
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
