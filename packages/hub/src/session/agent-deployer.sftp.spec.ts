import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { uploadAgentBinary } from "./agent-deployer.js";
import { startSftpServer } from "./sftp-server.fixture.js";

// uploadAgentBinary's execRename needs a POSIX shell.
describe.skipIf(process.platform === "win32")("agent upload over filesystem SFTP", () => {
	let root: string;
	let home: string;
	let local: string;
	let target: string;
	let server: Awaited<ReturnType<typeof startSftpServer>> | undefined;
	let client: Client | undefined;
	beforeEach(async () => {
		root = makeTempDir("lasterm-sftp-");
		home = join(root, "home");
		local = join(root, "binary");
		target = join(home, ".local/bin/lasterm-agent");
		await mkdir(home);
		await writeFile(local, "new agent bytes");
		const started = await startSftpServer();
		server = started;
		const connection = new Client();
		client = connection;
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
		if (client) {
			const closed = new Promise<void>((resolve) => client?.once("close", resolve));
			client.destroy();
			await closed;
		}
		await server?.close();
		await chmod(home, 0o700);
		await removeTempDir(root);
	});
	const upload = () => {
		if (!client) throw new Error("Client not connected");
		return uploadAgentBinary(client, local, target, "linux");
	};
	it.each(["password", "none"] as const)(
		"refuses %s authentication without the server password",
		async (method) => {
			if (!server) throw new Error("Server not started");
			const port = server.port;
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
		expect(await readFile(target, "utf8")).toBe("new agent bytes");
		expect((await stat(target)).mode & 0o777).toBe(0o755);
	});
	it("P2 replaces an old agent when all directory levels exist", async () => {
		await mkdir(join(home, ".local/bin"), { recursive: true });
		await writeFile(target, "old agent");
		await upload();
		expect(await readFile(target, "utf8")).toBe("new agent bytes");
	});
	it("R1 rejects a regular file ancestor before any upload", async () => {
		await writeFile(join(home, ".local"), "not a directory");
		await expect(upload()).rejects.toThrow(`Could not create the directory ${home}/.local`);
		expect(await readdir(home, { recursive: true })).toEqual([".local"]);
	});
	// Root ignores the home directory's mode.
	it.skipIf(process.getuid?.() === 0)(
		"R2 reports permission denied at the refused level",
		async () => {
			await chmod(home, 0o500);
			await expect(upload()).rejects.toThrow(
				`Could not create the directory ${home}/.local: Permission denied`,
			);
			expect(await readdir(home)).toEqual([]);
		},
	);
});
