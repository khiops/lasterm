import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { type Connection, Server, utils } from "ssh2";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const codes = utils.sftp.STATUS_CODE;

export interface SftpServerOptions {
	sftp?: boolean;
	closeOnRequest?: {
		type: "STAT" | "MKDIR" | "OPEN" | "WRITE" | "SETSTAT";
		occurrence?: number;
		connection?: boolean;
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
	closeFirings: () => number;
	firedRequest: () => string | undefined;
	sftpClosed: Promise<void>;
	close: () => Promise<void>;
}> {
	const offersSftp = options.sftp ?? true;
	const execCommands: string[] = [];
	let sftpRequests = 0;
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
				session.on("exec", (acceptExec, _reject, info) => {
					execCommands.push(info.command);
					const stream = acceptExec();
					const child = spawn("/bin/sh", ["-c", info.command]);
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
					sftp.once("close", channelClosed);
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
					const run = (id: number, action: () => Promise<unknown>) => {
						void action().then(
							() => status(id),
							(error) => status(id, error),
						);
					};
					sftp.on("MKDIR", (id, path) => {
						if (intercept("MKDIR")) return;
						run(id, () => fs.mkdir(path));
					});
					for (const event of ["STAT", "LSTAT"] as const) {
						sftp.on(event, (id: number, path: string) => {
							if (intercept(event)) return;
							void (event === "STAT" ? fs.stat(path) : fs.lstat(path)).then(
								(stat) =>
									sftp.attrs(id, {
										mode: stat.mode,
										size: stat.size,
										uid: stat.uid,
										gid: stat.gid,
										atime: Math.floor(stat.atimeMs / 1000),
										mtime: Math.floor(stat.mtimeMs / 1000),
									}),
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
						void fs.open(path, mode).then(
							(file) => {
								const handle = String(nextHandle++);
								handles.set(handle, file);
								sftp.handle(id, Buffer.from(handle));
							},
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
							await file(handle).close();
							handles.delete(handle.toString());
						}),
					);
					sftp.on("SETSTAT", (id, path, attrs) => {
						if (intercept("SETSTAT")) return;
						run(id, async () => {
							if (attrs.mode !== undefined) await fs.chmod(path, attrs.mode);
						});
					});
					sftp.on("REMOVE", (id, path) => run(id, () => fs.unlink(path)));
					for (const event of [
						"READ",
						"FSTAT",
						"FSETSTAT",
						"OPENDIR",
						"READDIR",
						"RMDIR",
						"REALPATH",
						"RENAME",
						"READLINK",
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
