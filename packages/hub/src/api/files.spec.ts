import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken } from "../auth.js";
import { type Answer, answering, FakeFilesAgent, sent } from "../files/agent-files.fixture.js";
import { normaliseHostPath } from "../files/host-paths.js";
import { createServer } from "../server.fixture.js";
import type { AgentConnection } from "../session/agent-connection.js";
import { SessionManager } from "../session/session-manager.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";
import { MAX_PATH_LENGTH, readFilesQuery, readFolderBody } from "./files.js";

describe("readFilesQuery", () => {
	it("reads an optional path, an empty one being none, and hidden as a flag", () => {
		expect(readFilesQuery({})).toEqual({ hidden: false });
		expect(readFilesQuery({ path: "" })).toEqual({ hidden: false });
		expect(readFilesQuery({ path: "/x", hidden: "1" })).toEqual({ path: "/x", hidden: true });
		expect(readFilesQuery({ hidden: "true" })).toEqual({ hidden: true });
		expect(readFilesQuery({ hidden: "0" })).toEqual({ hidden: false });
		expect(readFilesQuery({ hidden: "false" })).toEqual({ hidden: false });
	});

	it("refuses a parameter given twice, a path too long, and any other hidden", () => {
		expect(readFilesQuery({ path: ["/a", "/b"] })).toEqual({
			error: "path must be given once, as text.",
		});
		expect(readFilesQuery({ path: `/${"a".repeat(MAX_PATH_LENGTH)}` })).toEqual({
			error: `path must be at most ${MAX_PATH_LENGTH} characters.`,
		});
		expect(readFilesQuery({ hidden: "yes" })).toEqual({
			error: "hidden must be 1, true, 0 or false.",
		});
	});
});

describe("readFolderBody", () => {
	it("takes { path }, and nothing without one", () => {
		expect(readFolderBody({ path: "/x/New folder" })).toEqual({ path: "/x/New folder" });
		expect(readFolderBody({})).toEqual({ error: "path is required." });
		expect(readFolderBody({ path: "" })).toEqual({ error: "path is required." });
		expect(readFolderBody({ path: 3 })).toEqual({ error: "path must be given once, as text." });
		expect(readFolderBody(null)).toEqual({ error: "The body must be a JSON object." });
		expect(readFolderBody(["/x"])).toEqual({ error: "The body must be a JSON object." });
	});
});

const PRIMARY_TOKEN = "3c".repeat(32);
const bearer = (token = PRIMARY_TOKEN) => ({ authorization: `Bearer ${token}` });

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

describe("the files of a terminal's host, over REST (#832)", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let root: string;
	let channelId: string;
	let sshChannelId: string;
	const sockets: InjectedSocket[] = [];

	beforeEach(async () => {
		dbs = openTestDatabases();
		root = makeTempDir("lasterm-files-route-");
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
		});
		await server.ready();
		const dal = new MetaDAL(dbs.meta);
		const [local] = dal.listLocalHosts();
		if (!local) throw new Error("the hub made no local host");
		channelId = "01K832CHAN0000000000000001";
		dal.createSession({ id: "01K832SESS0000000000000001", hostId: local.id, status: "active" });
		dal.createChannel({ id: channelId, sessionId: "01K832SESS0000000000000001", status: "live" });
		const pi = dal.createHost({ type: "ssh", label: "pi", sshHost: "pi@pi.test" });
		sshChannelId = "01K832CHAN0000000000000002";
		dal.createSession({ id: "01K832SESS0000000000000002", hostId: pi.id, status: "closed" });
		dal.createChannel({
			id: sshChannelId,
			sessionId: "01K832SESS0000000000000002",
			status: "dead",
		});
	});

	afterEach(async () => {
		for (const socket of sockets.splice(0)) socket.terminate();
		await server.close();
		dbs.close();
		await removeTempDir(root);
	});

	/** A window: a socket authenticated with `token`, its id as AUTH_OK gave it. */
	async function window(
		token = PRIMARY_TOKEN,
	): Promise<{ id: string; socket: InjectedSocket; seen: ProtocolMessage[] }> {
		const socket = await server.injectWS("/ws", {
			socket: { remoteAddress: "127.0.0.1" },
		} as never);
		sockets.push(socket);
		const seen: ProtocolMessage[] = [];
		socket.on("message", (data: unknown) => {
			seen.push(decodeMessage(new Uint8Array(data as Buffer)));
		});
		socket.send(encodeMessage({ type: "AUTH", token }));
		await vi.waitFor(() => expect(seen.some((message) => message.type === "AUTH_OK")).toBe(true));
		const ok = seen.find((message) => message.type === "AUTH_OK") as { clientId: string };
		return { id: ok.clientId, socket, seen };
	}

	/**
	 * `writer` takes the terminal's free write lock, as a click on its pane does.
	 * Not attached, it hears no WRITE_LOCK; the PONG after its claim says the
	 * hub has handled it, since a socket's frames are handled in order.
	 */
	async function takeLock(writer: Awaited<ReturnType<typeof window>>): Promise<void> {
		writer.socket.send(encodeMessage({ type: "WRITE_CLAIM", channelId } as ProtocolMessage));
		writer.socket.send(encodeMessage({ type: "PING" }));
		await vi.waitFor(() =>
			expect(writer.seen.some((message) => message.type === "PONG")).toBe(true),
		);
	}

	const list = (path: string, extra = "") =>
		server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/files?path=${encodeURIComponent(path)}${extra}`,
			headers: bearer(),
		});

	const newFolder = (path: string, clientId?: string, token = PRIMARY_TOKEN) =>
		server.inject({
			method: "POST",
			url: `/api/channels/${channelId}/folders`,
			headers: { ...bearer(token), ...(clientId ? { "x-lasterm-client-id": clientId } : {}) },
			payload: { path },
		});

	it("lists a folder of the local host in the wire's shape, for any client", async () => {
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "f.txt"), "abc");
		writeFileSync(join(root, ".hidden"), "");
		chmodSync(join(root, "sub"), 0o750);
		chmodSync(join(root, "f.txt"), 0o640);
		if (process.platform !== "win32") symlinkSync("sub", join(root, "link"));

		const res = await list(root);
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		const body = res.json<{
			path: string;
			entries: Record<string, unknown>[];
			truncated: number;
		}>();
		expect(body.truncated).toBe(0);
		const named = (name: string) => body.entries.find((entry) => entry.name === name);
		// A Windows hub gives no mode: Node's is made up from the read-only attribute alone.
		expect(named("sub")).toEqual({
			name: "sub",
			kind: "directory",
			size: null,
			mtime: expect.any(String),
			mode: process.platform === "win32" ? null : 16872,
			attributes: null,
			owner: null,
			group: null,
		});
		expect(named("f.txt")).toMatchObject({
			mode: process.platform === "win32" ? null : 33184,
			attributes: null,
			owner: null,
			group: null,
		});
		expect(body.entries.map((entry) => entry.name)).toEqual(
			process.platform === "win32" ? ["sub", "f.txt"] : ["link", "sub", "f.txt"],
		);
		if (process.platform !== "win32") {
			expect(named("link")).toMatchObject({
				kind: "symlink",
				link_target: "sub",
				link_kind: "directory",
			});
		}
		const hidden = await list(root, "&hidden=1");
		expect(hidden.json<{ entries: unknown[] }>().entries).toHaveLength(
			process.platform === "win32" ? 3 : 4,
		);
	});

	it.skipIf(process.platform === "win32")(
		"sends each entry's mode whole, special bits and special files included",
		async () => {
			mkdirSync(join(root, "shared"));
			chmodSync(join(root, "shared"), 0o2750);
			const socketServer = createNetServer();
			await new Promise<void>((resolve) => socketServer.listen(join(root, "s.sock"), resolve));
			try {
				chmodSync(join(root, "s.sock"), 0o750);
				const entries = (await list(root)).json<{ entries: Record<string, unknown>[] }>().entries;
				const named = (name: string) => entries.find((entry) => entry.name === name);
				expect(named("shared")).toMatchObject({ kind: "directory", mode: 17896 });
				expect(named("s.sock")).toMatchObject({ kind: "other", mode: 49640 });
			} finally {
				await new Promise<void>((resolve) => socketServer.close(() => resolve()));
			}
		},
	);

	it("opens without a path at the fallback folder its host's settings name, else at the home (#836)", async () => {
		const dal = new MetaDAL(dbs.meta);
		const [local] = dal.listLocalHosts();
		if (!local) throw new Error("the hub made no local host");
		mkdirSync(join(root, "drop"));
		writeFileSync(join(root, "drop", "in.txt"), "");
		const style = process.platform === "win32" ? "windows" : "posix";
		const spelt = (path: string) => {
			const normalised = normaliseHostPath(path, style);
			if (!normalised.ok) throw new Error(normalised.reason);
			return normalised.path;
		};
		const opening = () =>
			server.inject({ method: "GET", url: `/api/channels/${channelId}/files`, headers: bearer() });

		// Its variable from the host's own: the agent expands a cwd from those first.
		const variable = "LASTERM_SPEC_ROUTE_836";
		dal.updateHostProfile(
			local.id,
			JSON.stringify({ transferFallbackDir: `\${${variable}}/drop`, env: { [variable]: root } }),
		);
		const opened = await opening();
		expect(opened.statusCode).toBe(200);
		const body = opened.json<Record<string, unknown>>();
		expect(body).toMatchObject({
			path: spelt(join(root, "drop")),
			start: "fallback",
			entries: [{ name: "in.txt", kind: "file" }],
		});
		expect(body).not.toHaveProperty("fallback_problem");

		const missing = spelt(join(root, "missing"));
		dal.updateHostProfile(local.id, JSON.stringify({ transferFallbackDir: missing }));
		const home = await opening();
		expect(home.statusCode).toBe(200);
		expect(home.json()).toMatchObject({
			start: "home",
			fallback_problem: `The fallback folder ${missing} cannot be opened: it does not exist`,
		});

		// A folder asked for by its path is only that folder.
		const byPath = (await list(root)).json<Record<string, unknown>>();
		expect(byPath).not.toHaveProperty("start");
		expect(byPath).not.toHaveProperty("fallback_problem");
	});

	it("says what a path is, and the free space where it is", async () => {
		writeFileSync(join(root, "f.txt"), "abc");
		chmodSync(join(root, "f.txt"), 0o640);
		const stat = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/files/stat?path=${encodeURIComponent(join(root, "f.txt"))}`,
			headers: bearer(),
		});
		expect(stat.statusCode).toBe(200);
		expect(stat.json()).toMatchObject({
			name: "f.txt",
			kind: "file",
			size: 3,
			mode: process.platform === "win32" ? null : 33184,
			attributes: null,
			owner: null,
			group: null,
		});
		const space = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/files/free-space?path=${encodeURIComponent(root)}`,
			headers: bearer(),
		});
		expect(space.statusCode).toBe(200);
		expect(space.json<{ total: number }>().total).toBeGreaterThan(0);
	});

	/** The local host's agent, saying `files` and answering with `answer` (#1201). */
	function localAgent(answer: Answer): { agent: FakeFilesAgent; hostId: string } {
		const [local] = new MetaDAL(dbs.meta).listLocalHosts();
		if (!local) throw new Error("the hub made no local host");
		const agent = new FakeFilesAgent(answer);
		vi.spyOn(SessionManager.prototype, "connectedAgent").mockImplementation((hostId) =>
			hostId === local.id ? (agent as unknown as AgentConnection) : null,
		);
		return { agent, hostId: local.id };
	}

	const hostSpelt = (path: string) => {
		const normalised = normaliseHostPath(path, process.platform === "win32" ? "windows" : "posix");
		if (!normalised.ok) throw new Error(normalised.reason);
		return normalised.path;
	};

	it("lists a folder through the host's agent, with owner, group and attributes", async () => {
		const { agent } = localAgent(
			answering({
				type: "FILES_ENTRIES",
				entries: [
					sent("f.txt", {
						size: 3,
						mode: null,
						attributes: 33,
						owner: "O2CSI\\olivier",
						group: null,
					}),
					sent("zl", {
						kind: "symlink",
						size: 3,
						mode: 0o120777,
						linkTarget: "sub",
						linkKind: "directory",
					}),
					sent("sub", {
						kind: "directory",
						size: null,
						mode: 16872,
						owner: "olivier",
						group: "staff",
						mtimeMs: 1_700_000_000_000,
					}),
				],
				done: true,
			}),
		);
		try {
			const res = await list(root);
			expect(res.statusCode).toBe(200);
			const body = res.json<{ entries: Record<string, unknown>[] }>();
			expect(body.entries.map((entry) => entry.name)).toEqual(["sub", "zl", "f.txt"]);
			expect(body.entries[0]).toEqual({
				name: "sub",
				kind: "directory",
				size: null,
				mtime: "2023-11-14T22:13:20.000Z",
				mode: 16872,
				attributes: null,
				owner: "olivier",
				group: "staff",
			});
			expect(body.entries[1]).toMatchObject({ link_target: "sub", link_kind: "directory" });
			expect(body.entries[2]).toMatchObject({
				attributes: 33,
				mode: null,
				owner: "O2CSI\\olivier",
				group: null,
			});
			expect(agent.asked).toEqual([
				{ type: "FILES_LIST", path: hostSpelt(root), hidden: false, requestId: expect.any(String) },
			]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("opens at the home through the host's agent", async () => {
		const { agent } = localAgent(
			answering({ type: "FILES_ENTRIES", entries: [sent("at-home")], done: true }),
		);
		try {
			const res = await server.inject({
				method: "GET",
				url: `/api/channels/${channelId}/files`,
				headers: bearer(),
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				path: hostSpelt(homedir()),
				start: "home",
				entries: [{ name: "at-home", owner: "alice", group: "staff" }],
			});
			expect(agent.asked.map((message) => (message as { path?: string }).path)).toEqual([
				hostSpelt(homedir()),
			]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("opens at the fallback folder through the host's agent", async () => {
		const { agent, hostId } = localAgent(
			answering({ type: "FILES_ENTRIES", entries: [sent("in-fallback")], done: true }),
		);
		new MetaDAL(dbs.meta).updateHostProfile(hostId, JSON.stringify({ transferFallbackDir: root }));
		try {
			const res = await server.inject({
				method: "GET",
				url: `/api/channels/${channelId}/files`,
				headers: bearer(),
			});
			expect(res.json()).toMatchObject({
				path: hostSpelt(root),
				start: "fallback",
				entries: [{ name: "in-fallback" }],
			});
			expect(agent.asked.map((message) => (message as { path?: string }).path)).toEqual([
				hostSpelt(root),
			]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("says what a path is through the host's agent", async () => {
		const { agent } = localAgent(
			answering({
				type: "FILES_ENTRIES",
				entries: [sent("named-by-agent", { owner: "o", group: "g", attributes: 32, mode: null })],
				done: true,
			}),
		);
		try {
			const path = join(root, "f.txt");
			const res = await server.inject({
				method: "GET",
				url: `/api/channels/${channelId}/files/stat?path=${encodeURIComponent(path)}`,
				headers: bearer(),
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				path: hostSpelt(path),
				name: "f.txt",
				owner: "o",
				group: "g",
				attributes: 32,
			});
			expect(agent.asked.map((message) => message.type)).toEqual(["FILES_STAT"]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("answers each error by its code", async () => {
		expect((await list(join(root, "missing"))).json()).toEqual({
			error: { code: "NOT_FOUND", message: "The folder could not be listed: it does not exist" },
		});
		expect((await list(join(root, "missing"))).statusCode).toBe(404);
		const relative = await list("relative/path");
		expect(relative.statusCode).toBe(400);
		expect(relative.json<{ error: { code: string } }>().error.code).toBe("UNSUPPORTED_PATH");
		const badHidden = await list(root, "&hidden=yes");
		expect(badHidden.statusCode).toBe(400);
		expect(badHidden.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
		const unknown = await server.inject({
			method: "GET",
			url: "/api/channels/01K832CHAN000000000000000Z/files",
			headers: bearer(),
		});
		expect(unknown.statusCode).toBe(404);
		expect(unknown.json<{ error: { code: string } }>().error.code).toBe("CHANNEL_NOT_FOUND");
		const away = await server.inject({
			method: "GET",
			url: `/api/channels/${sshChannelId}/files`,
			headers: bearer(),
		});
		expect(away.statusCode).toBe(409);
		expect(away.json<{ error: { code: string } }>().error.code).toBe("HOST_NOT_CONNECTED");
	});

	it("lets a reader list, refuses a reader's new folder, and creates the writer's", async () => {
		const writer = await window();
		const reader = await window();
		await takeLock(writer);

		expect((await list(root)).statusCode).toBe(200);

		const refused = await newFolder(join(root, "by reader"), reader.id);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toEqual({
			error: {
				code: "WRITE_LOCK_DENIED",
				message: "This window does not hold the write lock for this terminal",
			},
		});
		const unnamed = await newFolder(join(root, "by nobody"));
		expect(unnamed.statusCode).toBe(403);
		expect(unnamed.json<{ error: { code: string } }>().error.code).toBe("WRITE_LOCK_DENIED");

		const made = await newFolder(join(root, "by writer"), writer.id);
		expect(made.statusCode).toBe(201);
		expect(statSync(join(root, "by writer")).isDirectory()).toBe(true);
		expect(() => statSync(join(root, "by reader"))).toThrow();
		expect(() => statSync(join(root, "by nobody"))).toThrow();

		const again = await newFolder(join(root, "by writer"), writer.id);
		expect(again.statusCode).toBe(409);
		expect(again.json<{ error: { code: string } }>().error.code).toBe("ALREADY_EXISTS");
	});

	it("refuses to act as the writer's window for a request with another credential", async () => {
		const writer = await window();
		await takeLock(writer);
		const other = createToken(dbs.meta, { label: "browser", expiresAt: null });

		const res = await newFolder(join(root, "borrowed"), writer.id, other.token);
		expect(res.statusCode).toBe(403);
		expect(res.json<{ error: { message: string } }>().error.message).toContain("names no window");
		expect(() => statSync(join(root, "borrowed"))).toThrow();
	});

	it("refuses a window that is gone, though it held the lock", async () => {
		const writer = await window();
		await takeLock(writer);
		writer.socket.terminate();
		await vi.waitFor(async () => {
			expect((await newFolder(join(root, "late"), writer.id)).statusCode).toBe(403);
		});
	});
});

describe("downloads from a terminal's host, over REST (#840)", () => {
	const CHANNEL = "01K840CHAN0000000000000001";
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let root: string;
	let dir: string;
	let localHostId: string;
	const style = process.platform === "win32" ? "windows" : "posix";

	async function start(fileTransfer: boolean, corsOrigins?: string[]): Promise<void> {
		dbs = openTestDatabases();
		root = makeTempDir("lasterm-download-route-");
		mkdirSync(join(root, "config"));
		mkdirSync(join(root, "files"));
		writeFileSync(
			join(root, "config", "config.toml"),
			`[experimental]\nfile_transfer = ${fileTransfer}\n`,
		);
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
			configDir: join(root, "config"),
			...(corsOrigins !== undefined ? { corsOrigins } : {}),
		});
		await server.ready();
		const dal = new MetaDAL(dbs.meta);
		const [local] = dal.listLocalHosts();
		if (!local) throw new Error("the hub made no local host");
		localHostId = local.id;
		dal.createSession({ id: "01K840SESS0000000000000001", hostId: local.id, status: "active" });
		dal.createChannel({ id: CHANNEL, sessionId: "01K840SESS0000000000000001", status: "live" });
		const normalised = normaliseHostPath(join(root, "files"), style);
		if (!normalised.ok) throw new Error(normalised.reason);
		dir = normalised.path;
	}

	afterEach(async () => {
		await server?.close();
		dbs?.close();
		if (root) await removeTempDir(root);
	});

	const at = (name: string) => `${dir}${style === "windows" ? "\\" : "/"}${name}`;
	const download = (path: string, headers: Record<string, string> = bearer()) =>
		server.inject({
			method: "GET",
			url: `/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(path)}`,
			headers,
		});
	const ticketFor = async (path: string, url = `/api/channels/${CHANNEL}/files/content-ticket`) => {
		const response = await server.inject({
			method: "POST",
			url,
			headers: bearer(),
			payload: { path },
		});
		expect(response.statusCode).toBe(200);
		return response.json().ticket as string;
	};

	it("a reader downloads", async () => {
		await start(true);
		writeFileSync(join(root, "files", "report.txt"), "the report");
		// No window, no write lock, no client id: only the bearer.
		const response = await download(at("report.txt"));
		expect(response.statusCode).toBe(200);
		expect(response.body).toBe("the report");
	});

	it("content waits behind the flag", async () => {
		await start(false);
		writeFileSync(join(root, "files", "report.txt"), "the report");
		const response = await download(at("report.txt"));
		expect(response.statusCode).toBe(404);
		expect(response.json().error.code).toBe("FILE_TRANSFER_DISABLED");
	});

	it("content refuses unsupported paths", async () => {
		await start(true);
		const refused =
			style === "windows"
				? ["relative\\x", "C:\\a\\..\\b", "C:\\%USERPROFILE%\\x"]
				: ["relative/x", "/a/../b", "~/x"];
		for (const path of refused) {
			const response = await download(path);
			expect(response.statusCode, path).toBe(400);
			expect(response.json().error.code, path).toBe("UNSUPPORTED_PATH");
		}
		const long = await download(`/${"a".repeat(MAX_PATH_LENGTH)}`);
		expect(long.statusCode).toBe(400);
		expect(long.json().error.code).toBe("VALIDATION_ERROR");
		// Literal characters a name may hold are not refused: the file is simply looked for.
		const literal = await download(at("$HOME x"));
		expect(literal.statusCode).toBe(404);
	});

	it("content on an unknown channel or host", async () => {
		await start(true);
		const channel = await server.inject({
			method: "GET",
			url: `/api/channels/01K840CHAN0000000000000099/files/content?path=${encodeURIComponent(at("x"))}`,
			headers: bearer(),
		});
		expect(channel.statusCode).toBe(404);
		expect(channel.json().error.code).toBe("CHANNEL_NOT_FOUND");
		const host = await server.inject({
			method: "GET",
			url: `/api/hosts/01K840HOST0000000000000099/files/content?path=${encodeURIComponent(at("x"))}`,
			headers: bearer(),
		});
		expect(host.statusCode).toBe(404);
		expect(host.json().error.code).toBe("HOST_NOT_FOUND");
		// A remote host with no agent connected to this hub.
		const dal = new MetaDAL(dbs.meta);
		const pi = dal.createHost({ type: "ssh", label: "pi", sshHost: "pi@pi.test" });
		dal.createSession({ id: "01K840SESS0000000000000002", hostId: pi.id, status: "closed" });
		dal.createChannel({
			id: "01K840CHAN0000000000000002",
			sessionId: "01K840SESS0000000000000002",
			status: "dead",
		});
		const offline = await server.inject({
			method: "GET",
			url: "/api/channels/01K840CHAN0000000000000002/files/content?path=%2Fhome%2Fpi%2Fx",
			headers: bearer(),
		});
		expect(offline.statusCode).toBe(409);
		expect(offline.json().error.code).toBe("HOST_NOT_CONNECTED");
	});

	it("content disposition of unusual names", async () => {
		await start(true);
		const names: Array<[string, string, string]> = [
			[
				"rapport été.pdf",
				'filename="rapport _t_.pdf"',
				"filename*=UTF-8''rapport%20%C3%A9t%C3%A9.pdf",
			],
			[
				'say "hi" 100%.txt',
				'filename="say _hi_ 100_.txt"',
				"filename*=UTF-8''say%20%22hi%22%20100%25.txt",
			],
		];
		names.push(["100% sure.txt", 'filename="100_ sure.txt"', "filename*=UTF-8''100%25%20sure.txt"]);
		if (style === "posix") {
			names.push(["new\nline.txt", 'filename="new_line.txt"', "filename*=UTF-8''new%0Aline.txt"]);
		}
		for (const [name, fallback, encoded] of names) {
			if (style === "windows" && name.includes('"')) continue; // Windows refuses `"` in a name
			writeFileSync(join(root, "files", name), "x");
			const response = await download(at(name));
			expect(response.statusCode, name).toBe(200);
			expect(response.headers["content-disposition"], name).toBe(
				`attachment; ${fallback}; ${encoded}`,
			);
		}
	});

	it("download tickets", async () => {
		await start(true);
		writeFileSync(join(root, "files", "p.txt"), "P");
		writeFileSync(join(root, "files", "q.txt"), "Q");
		const plain = (url: string) => server.inject({ method: "GET", url });
		const contentUrl = (query: string) => `/api/channels/${CHANNEL}/files/content?${query}`;

		// A ticket for something that is not there is refused when it is asked for,
		// so the browser's own download never meets the hub's refusal.
		const gone = await server.inject({
			method: "POST",
			url: `/api/channels/${CHANNEL}/files/content-ticket`,
			headers: bearer(),
			payload: { path: at("nothing.txt") },
		});
		expect(gone.statusCode).toBe(404);
		expect(gone.json().error.code).toBe("NOT_FOUND");

		// No bearer and no ticket.
		expect((await plain(contentUrl(`path=${encodeURIComponent(at("p.txt"))}`))).statusCode).toBe(
			401,
		);

		// Used once; the path is the ticket's, whatever the query says.
		const ticket = await ticketFor(at("p.txt"));
		const first = await plain(
			contentUrl(`ticket=${ticket}&path=${encodeURIComponent(at("q.txt"))}`),
		);
		expect(first.statusCode).toBe(200);
		expect(first.body).toBe("P");
		expect((await plain(contentUrl(`ticket=${ticket}`))).statusCode).toBe(401);

		// Expired.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const old = await ticketFor(at("p.txt"));
			vi.setSystemTime(Date.now() + 61_000);
			expect((await plain(contentUrl(`ticket=${old}`))).statusCode).toBe(401);
		} finally {
			vi.useRealTimers();
		}

		// Another host, a listing, a trailing slash.
		const pi = new MetaDAL(dbs.meta).createHost({
			type: "ssh",
			label: "pi",
			sshHost: "pi@pi.test",
		});
		const forLocal = await ticketFor(at("p.txt"));
		expect((await plain(`/api/hosts/${pi.id}/files/content?ticket=${forLocal}`)).statusCode).toBe(
			401,
		);
		const forListing = await ticketFor(at("p.txt"));
		expect(
			(
				await plain(
					`/api/channels/${CHANNEL}/files?ticket=${forListing}&path=${encodeURIComponent(dir)}`,
				)
			).statusCode,
		).toBe(401);
		const slash = await ticketFor(at("p.txt"));
		expect(
			(await plain(`/api/channels/${CHANNEL}/files/content/?ticket=${slash}`)).statusCode,
		).toBe(401);
		// Refused before the ticket was taken: it still opens the exact route.
		expect((await plain(contentUrl(`ticket=${slash}`))).statusCode).toBe(200);

		// The host form takes a ticket made for its host.
		const hostTicket = await ticketFor(
			at("p.txt"),
			`/api/hosts/${localHostId}/files/content-ticket`,
		);
		const byHost = await plain(`/api/hosts/${localHostId}/files/content?ticket=${hostTicket}`);
		expect(byHost.statusCode).toBe(200);

		// A request with a bearer leaves a ticket usable.
		const kept = await ticketFor(at("p.txt"));
		const withBearer = await server.inject({
			method: "GET",
			url: contentUrl(`ticket=${kept}&path=${encodeURIComponent(at("q.txt"))}`),
			headers: bearer(),
		});
		expect(withBearer.body).toBe("Q");
		expect((await plain(contentUrl(`ticket=${kept}`))).statusCode).toBe(200);

		// The 33rd ticket of a token drops the first.
		const tickets: string[] = [];
		for (let i = 0; i < 33; i++) tickets.push(await ticketFor(at("p.txt")));
		expect((await plain(contentUrl(`ticket=${tickets[0]}`))).statusCode).toBe(401);
		expect((await plain(contentUrl(`ticket=${tickets[32]}`))).statusCode).toBe(200);
	});

	it("an open download holds its host in the session manager", async () => {
		await start(true);
		writeFileSync(join(root, "files", "big.bin"), Buffer.alloc(1024 * 1024, 1));
		const released: string[] = [];
		const opened = vi
			.spyOn(SessionManager.prototype, "downloadOpened")
			.mockImplementation((hostId: string) => () => {
				released.push(hostId);
			});
		try {
			await server.listen({ port: 0, host: "127.0.0.1" });
			const port = (server.server.address() as AddressInfo).port;
			await new Promise<void>((resolve, reject) => {
				const request = httpsGet(
					`https://127.0.0.1:${port}/api/channels/${CHANNEL}/files/content?path=${encodeURIComponent(at("big.bin"))}`,
					{ headers: bearer(), rejectUnauthorized: false },
					(response) => {
						response.once("data", () => {
							expect(opened).toHaveBeenCalledTimes(1);
							expect(opened).toHaveBeenCalledWith(localHostId);
							request.destroy();
							resolve();
						});
					},
				);
				request.on("error", () => {});
				setTimeout(() => reject(new Error("no answer")), 10_000);
			});
			await vi.waitFor(() => expect(released).toEqual([localHostId]));
		} finally {
			opened.mockRestore();
		}
	});

	it("content cors", async () => {
		await start(true, ["https://other.example"]);
		const preflight = await server.inject({
			method: "OPTIONS",
			url: `/api/channels/${CHANNEL}/files/content?path=x`,
			headers: {
				origin: "https://other.example",
				"access-control-request-method": "GET",
				"access-control-request-headers": "authorization,range,if-range,x-lasterm-download",
			},
		});
		expect(preflight.statusCode).toBeLessThan(300);
		const members = (value: unknown) =>
			new Set(
				String(value)
					.split(",")
					.map((name) => name.trim().toLowerCase()),
			);
		const allowed = members(preflight.headers["access-control-allow-headers"]);
		for (const header of ["range", "if-range", "x-lasterm-download"]) {
			expect(allowed.has(header), header).toBe(true);
		}
		writeFileSync(join(root, "files", "c.txt"), "c");
		const response = await download(at("c.txt"), { ...bearer(), origin: "https://other.example" });
		const exposed = members(response.headers["access-control-expose-headers"]);
		for (const header of ["etag", "content-range", "content-length", "content-disposition"]) {
			expect(exposed.has(header), header).toBe(true);
		}
	});
});
