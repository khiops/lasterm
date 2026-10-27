import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { probeSftp, uploadAgentBinary } from "./agent-deployer.js";
import { startSftpServer } from "./sftp-server.fixture.js";

/** A real ssh2 server on loopback, a client connected to it, and a home directory on disk. */
function useServer(options: { sftp: boolean }) {
	const state: {
		root: string;
		home: string;
		local: string;
		target: string;
		server: Awaited<ReturnType<typeof startSftpServer>> | undefined;
		client: Client | undefined;
	} = { root: "", home: "", local: "", target: "", server: undefined, client: undefined };
	beforeEach(async () => {
		state.root = makeTempDir("lasterm-sftp-");
		state.home = join(state.root, "home");
		state.local = join(state.root, "binary");
		state.target = join(state.home, ".local/bin/lasterm-agent");
		await mkdir(state.home);
		await writeFile(state.local, "new agent bytes");
		const started = await startSftpServer(options);
		state.server = started;
		const connection = new Client();
		state.client = connection;
		await new Promise<void>((resolve, reject) => {
			connection.once("ready", resolve).once("error", reject);
			connection.connect({
				host: "127.0.0.1",
				port: started.port,
				username: "test",
				password: started.password,
			});
		});
	});
	afterEach(async () => {
		const client = state.client;
		if (client) {
			const closed = new Promise<void>((resolve) => client.once("close", resolve));
			client.destroy();
			await closed;
		}
		await state.server?.close();
		await chmod(state.home, 0o700);
		await removeTempDir(state.root);
	});
	const connected = (): Client => {
		if (!state.client) throw new Error("Client not connected");
		return state.client;
	};
	const started = (): Awaited<ReturnType<typeof startSftpServer>> => {
		if (!state.server) throw new Error("Server not started");
		return state.server;
	};
	return { state, connected, started };
}

/** Every byte value, then enough random bytes to fill the channel's window more than once. */
function agentBytes(): Buffer {
	return Buffer.concat([Buffer.from([...Array(256).keys()]), randomBytes(3 * 1024 * 1024)]);
}

// uploadAgentBinary's execRename needs a POSIX shell.
describe.skipIf(process.platform === "win32")("agent upload over filesystem SFTP", () => {
	const { state, connected, started } = useServer({ sftp: true });
	const upload = () => uploadAgentBinary(connected(), state.local, state.target, "linux");
	it.each(["password", "none"] as const)(
		"refuses %s authentication without the server password",
		async (method) => {
			const port = started().port;
			const refused = new Client();
			try {
				await expect(
					new Promise<void>((resolve, reject) => {
						refused.once("ready", resolve).once("error", reject);
						refused.connect({
							host: "127.0.0.1",
							port,
							username: "test",
							password: "wrong",
							authHandler: [method],
						});
					}),
				).rejects.toThrow("All configured authentication methods failed");
			} finally {
				const closed = new Promise<void>((resolve) => refused.once("close", resolve));
				refused.destroy();
				await closed;
			}
		},
	);
	it("P1 creates every missing level and uploads executable bytes", async () => {
		await upload();
		expect(await readFile(state.target, "utf8")).toBe("new agent bytes");
		expect((await stat(state.target)).mode & 0o777).toBe(0o755);
	});
	it("P2 replaces an old agent when all directory levels exist", async () => {
		await mkdir(join(state.home, ".local/bin"), { recursive: true });
		await writeFile(state.target, "old agent");
		await upload();
		expect(await readFile(state.target, "utf8")).toBe("new agent bytes");
	});
	it("reports the regular-file ancestor when the transfer fails and leaves no agent bytes", async () => {
		await writeFile(join(state.home, ".local"), "not a directory");
		const failure = upload();
		await expect(failure).rejects.toThrow(`Could not create the directory ${state.home}/.local`);
		await expect(failure).rejects.toThrow("; the transfer also failed:");
		expect(await readdir(state.home, { recursive: true })).toEqual([".local"]);
	});
	// Root ignores the home directory's mode.
	it.skipIf(process.getuid?.() === 0)(
		"R2 reports permission denied at the refused level",
		async () => {
			await chmod(state.home, 0o500);
			const failure = upload();
			await expect(failure).rejects.toThrow(
				`Could not create the directory ${state.home}/.local: Permission denied`,
			);
			await expect(failure).rejects.toThrow("; the transfer also failed:");
			expect(await readdir(state.home)).toEqual([]);
		},
	);

	it("finds SFTP offered, and keeps uploading over it (#722)", async () => {
		const bytes = agentBytes();
		await writeFile(state.local, bytes);
		const support = await probeSftp(connected());
		expect(support).toEqual({ offered: true });

		expect(await uploadAgentBinary(connected(), state.local, state.target, "linux", support)).toBe(
			"sftp",
		);
		expect((await readFile(state.target)).equals(bytes)).toBe(true);
		// The probe's session, then the upload's.
		expect(started().sftpRequests()).toBe(2);
		expect(started().execCommands.filter((command) => command.includes("cat >"))).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")(
	"agent upload without the SFTP subsystem (#722)",
	() => {
		const { state, connected, started } = useServer({ sftp: false });
		const refused = { offered: false, reason: "Unable to start subsystem: sftp" } as const;

		it("finds SFTP refused at connect time, and says what refused it", async () => {
			expect(await probeSftp(connected())).toEqual(refused);
			expect(started().sftpRequests()).toBe(1);
		});

		it("sends the agent over the exec channel: the same bytes, executable, renamed into place", async () => {
			const bytes = agentBytes();
			await writeFile(state.local, bytes);

			expect(
				await uploadAgentBinary(connected(), state.local, state.target, "linux", refused),
			).toBe("exec");

			expect((await readFile(state.target)).equals(bytes)).toBe(true);
			expect((await stat(state.target)).mode & 0o777).toBe(0o755);
			// Moved into place: nothing else is left beside it.
			expect(await readdir(dirname(state.target))).toEqual(["lasterm-agent"]);
			// The probe already said: SFTP is not asked again.
			expect(started().sftpRequests()).toBe(0);
			const commands = started().execCommands;
			const write = commands.findIndex((command) => / && cat > \S+ && wc -c < \S+$/.test(command));
			const hash = commands.findIndex((command) => command.startsWith("sha256sum "));
			const mode = commands.findIndex((command) => command.startsWith("chmod 755 -- "));
			const move = commands.findIndex((command) => /^test ! -d \S+ && mv -f -- /.test(command));
			expect([write, hash, mode, move].every((index) => index !== -1)).toBe(true);
			expect(write < hash && hash < mode && mode < move).toBe(true);
		});

		it("replaces an agent already there", async () => {
			await mkdir(dirname(state.target), { recursive: true });
			await writeFile(state.target, "old agent");

			expect(
				await uploadAgentBinary(connected(), state.local, state.target, "linux", refused),
			).toBe("exec");

			expect(await readFile(state.target, "utf8")).toBe("new agent bytes");
			expect(await readdir(dirname(state.target))).toEqual(["lasterm-agent"]);
		});

		it("falls back by itself when nobody probed: SFTP refused, then the exec channel", async () => {
			expect(await uploadAgentBinary(connected(), state.local, state.target, "linux")).toBe("exec");

			expect(await readFile(state.target, "utf8")).toBe("new agent bytes");
			expect(started().sftpRequests()).toBe(1);
		});

		// Root ignores the home directory's mode.
		it.skipIf(process.getuid?.() === 0)(
			"names both attempts when the exec channel fails too, and leaves nothing behind",
			async () => {
				await chmod(state.home, 0o500);

				const failure = uploadAgentBinary(connected(), state.local, state.target, "linux", refused);

				await expect(failure).rejects.toThrow(
					"Could not upload the agent: the server does not offer SFTP (Unable to start subsystem: sftp), " +
						"and the upload over the SSH command channel failed too: Could not upload the agent to ",
				);
				await expect(failure).rejects.toThrow(/: exit 1: mkdir: .*Permission denied/);
				expect(await readdir(state.home)).toEqual([]);
			},
		);
	},
);
