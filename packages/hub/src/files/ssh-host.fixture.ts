import { Client } from "ssh2";
import { type SftpServerOptions, startSftpServer } from "../session/sftp-server.fixture.js";
import { connectWithoutDelay } from "../session/ssh-nodelay.js";

export type MockSshServer = Awaited<ReturnType<typeof startSftpServer>>;

/** The mock SSH server of the hub specs, and a client connected to it, as the hub's own connection. */
export interface MockSshHost {
	readonly server: MockSshServer;
	readonly client: Client;
	/** End the connection, as a lost link would, and wait for it to close. */
	drop(): Promise<void>;
	close(): Promise<void>;
}

export async function startMockSshHost(options: SftpServerOptions = {}): Promise<MockSshHost> {
	const server = await startSftpServer(options);
	const client = new Client();
	client.on("error", () => {});
	const closed = new Promise<void>((resolve) => client.once("close", resolve));
	await new Promise<void>((resolve, reject) => {
		client.once("ready", resolve).once("error", reject);
		connectWithoutDelay(client, {
			host: "127.0.0.1",
			port: server.port,
			username: "test",
			password: server.password,
		});
	});
	return {
		server,
		client,
		drop: async () => {
			client.destroy();
			await closed;
		},
		close: async () => {
			client.destroy();
			await closed;
			await server.close();
		},
	};
}
