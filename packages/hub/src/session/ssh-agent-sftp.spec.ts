import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "@lasterm/shared";
import { encodeFrame } from "@lasterm/shared";
import { Server } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { type DeployOptions, deployAgentIfNeeded, type SftpSupport } from "./agent-deployer.js";
import { SshAgent } from "./ssh-agent.js";

// Whether the server offers SFTP is asked once the connection is up, and is
// known from then on: the deploy is handed the answer, and the connection keeps
// it for the host's status (#722).

vi.mock("./agent-deployer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./agent-deployer.js")>();
	return {
		...actual,
		deployAgentIfNeeded: vi.fn().mockResolvedValue({
			deployed: false,
			remoteMatchesHubVersionCache: false,
			remotePath: "lasterm-agent",
			os: null,
			arch: null,
		}),
	};
});

const { privateKey: HOST_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const { privateKey: CLIENT_KEY } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "pkcs1", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const KEY_DIR = makeTempDir("lasterm-ssh-sftp-probe-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, CLIENT_KEY, { mode: 0o600 });

const HELLO = Buffer.from(
	encodeFrame({ type: "HELLO", version: 1, agentVersion: "0.0.0-test", capabilities: [] }),
);

/** A server whose every exec is an agent saying HELLO, and which offers SFTP or refuses it. */
function startServer(offersSftp: boolean): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (context) => context.accept());
			client.on("ready", () => {
				client.on("session", (accept) => {
					const session = accept();
					session.on("exec", (acceptExec) => {
						acceptExec().write(HELLO);
					});
					session.on("sftp", (acceptSftp, rejectSftp) => {
						if (offersSftp) acceptSftp();
						else rejectSftp();
					});
				});
			});
		});
		server.on("error", () => {});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as { port: number }).port });
		});
	});
}

function makeHost(port: number): Host {
	return {
		id: "01HZ000000000000000000001",
		type: "ssh",
		label: "no-sftp",
		sshHost: "127.0.0.1",
		sshPort: port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		iconType: "auto",
		trustRemoteHints: "ignore",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

/** The key the server presents, as a first connection reads it. */
async function fingerprintOf(host: Host): Promise<string> {
	const probe = new SshAgent(host);
	await probe.start(null).catch(() => {});
	await probe.close();
	return probe.lastKeyVerification.capturedFingerprint;
}

const servers: Server[] = [];
const agents: SshAgent[] = [];

afterEach(async () => {
	for (const agent of agents.splice(0)) await agent.close();
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	vi.mocked(deployAgentIfNeeded).mockClear();
});

afterAll(async () => {
	await removeTempDir(KEY_DIR);
});

async function connect(offersSftp: boolean, deploy: boolean): Promise<SshAgent> {
	const { server, port } = await startServer(offersSftp);
	servers.push(server);
	const host = makeHost(port);
	const fingerprint = await fingerprintOf(host);
	const agent = new SshAgent(host, undefined, deploy ? { binaryCache: KEY_DIR } : undefined);
	agents.push(agent);
	await agent.start(fingerprint);
	return agent;
}

describe("SshAgent — whether the server offers SFTP (#722)", () => {
	it("records a refusal once connected, before the agent is reached", async () => {
		const agent = await connect(false, false);
		expect(agent.sftpSupport).toEqual({
			offered: false,
			reason: "Unable to start subsystem: sftp",
		});
	});

	it("records SFTP offered", async () => {
		const agent = await connect(true, false);
		expect(agent.sftpSupport).toEqual({ offered: true });
	});

	it.each([false, true])("hands the deploy the same answer (offered: %s)", async (offersSftp) => {
		const agent = await connect(offersSftp, true);
		const options = vi.mocked(deployAgentIfNeeded).mock.calls[0]?.[2] as DeployOptions;
		const support: SftpSupport | undefined = await options.sftp;
		expect(support).toEqual(agent.sftpSupport);
		expect(support?.offered).toBe(offersSftp);
	});
});
