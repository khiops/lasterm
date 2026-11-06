/**
 * The round trips a small file costs over SFTP (#873). On a LAN each one is
 * the latency of the link and of the server's turn, and a folder of small
 * files pays them per file: they are counted here against the mock server,
 * by what the backend sent before any of it was answered, rather than timed.
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SftpExtension } from "../session/sftp-server.fixture.js";
import type { SftpSession } from "../session/ssh-file-transport.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { PathStyle } from "./host-paths.js";
import { SftpFileBackend, SharedSftp } from "./sftp-files.js";
import { SftpUploadBackend } from "./sftp-upload.js";
import { startMockSshHost } from "./ssh-host.fixture.js";
import { tempPathFor } from "./upload-backend.js";

const MTIME = 1_700_000_000_000;

/**
 * The requests an upload makes of SFTP. `futimes` is sent as an FSETSTAT by
 * ssh2, through its own `fsetstat`, which is left alone so as not to count it
 * twice.
 */
const REQUESTS = [
	"open",
	"write",
	"ext_openssh_fsync",
	"futimes",
	"fstat",
	"close",
	"lstat",
	"stat",
	"setstat",
	"ext_openssh_hardlink",
	"ext_openssh_rename",
	"rename",
	"unlink",
] as const;

/**
 * Record the requests sent on `session`, in rounds: a round is what was sent
 * before any of it was answered, so each round is one round trip. A request
 * ssh2 refuses before sending anything (an extension the server did not
 * offer) is not one.
 */
function recordRounds(session: SftpSession): string[][] {
	const rounds: string[][] = [];
	let answered = 0;
	let roundAt = -1;
	const channel = session.channel as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const name of REQUESTS) {
		const send = channel[name] as (...args: unknown[]) => unknown;
		channel[name] = (...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback === "function") {
				args[args.length - 1] = (...answer: unknown[]) => {
					answered++;
					callback(...answer);
				};
			}
			const sent = send.apply(session.channel, args);
			if (roundAt !== answered) {
				rounds.push([]);
				roundAt = answered;
			}
			rounds.at(-1)?.push(name);
			return sent;
		};
	}
	return rounds;
}

interface Host {
	backend: SftpUploadBackend;
	rounds: string[][];
	dir: string;
	style: PathStyle;
	local(name: string): string;
}

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An SFTP host serving a temporary folder as `style` shows it, its requests recorded. */
async function sftpHost(
	style: PathStyle,
	extensions: readonly SftpExtension[],
	options: { fstat?: boolean } = {},
): Promise<Host> {
	const root = makeTempDir("lasterm-sftp-rounds-");
	cleanups.push(() => removeTempDir(root));
	const folder = style === "windows" ? join(root, "C", "up") : join(root, "up");
	mkdirSync(folder, { recursive: true });
	const host = await startMockSshHost({ view: { style, root }, extensions, ...options });
	cleanups.push(() => host.close());
	const shared = new SharedSftp(host.client);
	const backend = new SftpUploadBackend(shared, style, new SftpFileBackend(shared, style));
	cleanups.push(() => {
		backend.release();
		shared.close();
	});
	return {
		backend,
		rounds: recordRounds(await shared.current()),
		dir: style === "windows" ? "C:\\up" : "/up",
		style,
		local: (name) => join(folder, name),
	};
}

/** Send one small file as an upload does: a new temporary, its bytes, finished, placed. */
async function sendSmallFile(host: Host, name: string): Promise<void> {
	const data = Buffer.from("ten bytes!");
	const target = host.style === "windows" ? `${host.dir}\\${name}` : `${host.dir}/${name}`;
	const temp = tempPathFor(target, host.style);
	const sink = await host.backend.open(temp, {
		resumeAt: 0,
		size: data.length,
		mtime: MTIME,
		hash: false,
	});
	await sink.write(data, 0);
	expect(await sink.finish(null)).toBe("size");
	expect(await host.backend.place(temp, target, false)).toEqual({ kind: "placed" });
	expect(readFileSync(host.local(name))).toEqual(data);
	expect(statSync(host.local(name)).mtimeMs).toBe(MTIME);
}

describe("a small file sent over SFTP (#873)", () => {
	it("costs five round trips on OpenSSH: open, write, its end in one, link, removal", async () => {
		const host = await sftpHost("posix", [
			"hardlink@openssh.com",
			"posix-rename@openssh.com",
			"fsync@openssh.com",
		]);

		await sendSmallFile(host, "a.txt");

		expect(host.rounds).toEqual([
			// Created exclusively: its handle is what the rest is sent on.
			["open"],
			["write"],
			// Flushed, its time set, its size read, closed: run in that order on one handle.
			["ext_openssh_fsync", "futimes", "fstat", "close"],
			// Placed without replacing: what removing the temporary waits for, since a
			// link refused leaves it there for a conflict's answer.
			["ext_openssh_hardlink"],
			["unlink"],
		]);
	});

	it("as many on Win32-OpenSSH, which offers no fsync", async () => {
		const host = await sftpHost("windows", ["hardlink@openssh.com", "posix-rename@openssh.com"]);

		await sendSmallFile(host, "a.txt");

		expect(host.rounds).toEqual([
			["open"],
			["write"],
			["futimes", "fstat", "close"],
			["ext_openssh_hardlink"],
			["unlink"],
		]);
	});

	it("four on a server without hard links, whose rename refuses a name taken", async () => {
		const host = await sftpHost("posix", []);

		await sendSmallFile(host, "a.txt");

		expect(host.rounds).toEqual([["open"], ["write"], ["futimes", "fstat", "close"], ["rename"]]);
	});

	it("reads the size by the path once closed, on a server that answers no FSTAT", async () => {
		const host = await sftpHost("posix", ["hardlink@openssh.com"], { fstat: false });

		await sendSmallFile(host, "a.txt");

		expect(host.rounds).toEqual([
			["open"],
			["write"],
			["futimes", "fstat", "close"],
			["lstat"],
			["ext_openssh_hardlink"],
			["unlink"],
		]);
	});
});
