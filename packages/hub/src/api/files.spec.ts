import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken } from "../auth.js";
import { normaliseHostPath } from "../files/host-paths.js";
import { createServer } from "../server.fixture.js";
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
		expect(named("sub")).toEqual({
			name: "sub",
			kind: "directory",
			size: null,
			mtime: expect.any(String),
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
		const stat = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/files/stat?path=${encodeURIComponent(join(root, "f.txt"))}`,
			headers: bearer(),
		});
		expect(stat.statusCode).toBe(200);
		expect(stat.json()).toMatchObject({ name: "f.txt", kind: "file", size: 3 });
		const space = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/files/free-space?path=${encodeURIComponent(root)}`,
			headers: bearer(),
		});
		expect(space.statusCode).toBe(200);
		expect(space.json<{ total: number }>().total).toBeGreaterThan(0);
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
