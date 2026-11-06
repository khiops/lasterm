import type {
	TransferItemState,
	TransferOnConflict,
	TransferStartItem,
	TransferStartMessage,
} from "@lasterm/shared";
import { expect, vi } from "vitest";
import { FileAccessError } from "../files/host-files.js";
import type { UploadBackend, UploadSink } from "../files/upload-backend.js";
import type { UploadBackendKind, UploadHarness } from "../files/upload-backends.fixture.js";
import type { TransfersDAL } from "../storage/transfers-dal.js";
import {
	type TransferConnectOutcome,
	type TransferDeps,
	type TransferRequester,
	TransferService,
} from "./transfer-service.js";

export const CHANNEL = "01HZ0000000000000000000CH1";
export const HOST = "01HZ0000000000000000000HO1";
export const WRITER: TransferRequester = {
	clientId: "01HZ0000000000000000000WR1",
	tokenId: "tok-a",
};
export const READER: TransferRequester = {
	clientId: "01HZ0000000000000000000RD1",
	tokenId: "tok-b",
};

/** What a spec can change of the hub around the service. */
export interface ServiceWorld {
	/** Who holds the terminal's write lock: null, nobody (anyone may type). */
	holder: string | null;
	ended: boolean;
	verify: boolean;
	maxConcurrent: number;
	/** Whether the hosts are connected, but those in `away`. */
	connected: boolean;
	/** Hosts not connected, whatever `connected` says. */
	readonly away: Set<string>;
	/** The host each terminal runs on: `HOST` for any other. */
	readonly hostOf: Map<string, string>;
	/** Every message sent, by client. */
	readonly sent: Map<string, Record<string, unknown>[]>;
	readonly idle: string[];
	/** What every backend handed out does instead, when set. */
	wrap: ((backend: UploadBackend) => Partial<UploadBackend>) | null;
	/** How many times each path was opened for bytes. */
	readonly opened: Map<string, number>;
	/** Every connection asked for, by host, in order. */
	readonly connects: string[];
	/** What a connection asked for does: by default the host is connected. */
	connect: ((hostId: string, clientId: string) => Promise<TransferConnectOutcome>) | null;
	/** The time the service reads, when set; the clock's otherwise. */
	now: number | null;
	/**
	 * The link to the remote host dropped: every backend handed out says it is
	 * lost, every write on it fails as on a lost connection, and the host is
	 * not connected until it is false again.
	 */
	linkDown: boolean;
}

/** A transfer service on a backend's host, with the rest of the hub as a spec decides it. */
export function serviceOn(
	h: UploadHarness,
	kind: UploadBackendKind,
	options: { store?: TransfersDAL; world?: ServiceWorld } = {},
) {
	const world: ServiceWorld = options.world ?? {
		holder: null,
		ended: false,
		verify: true,
		maxConcurrent: 2,
		connected: true,
		away: new Set(),
		hostOf: new Map(),
		sent: new Map(),
		idle: [],
		wrap: null,
		opened: new Map(),
		connects: [],
		connect: null,
		now: null,
		linkDown: false,
	};
	const hostType = kind.transport === "local" ? "local" : "ssh";
	const isConnected = (hostId: string) =>
		hostType === "local" || (world.connected && !world.linkDown && !world.away.has(hostId));
	const backend = (): UploadBackend => {
		const real = h.backend;
		const overrides = world.wrap?.(real) ?? {};
		const lostLink = () =>
			new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost");
		// Each upload lets go of what it is handed; the harness keeps the real one.
		const view: UploadBackend = Object.create(real, {
			release: { value: () => {} },
			lost: { get: () => world.linkDown || real.lost },
			open: {
				value: async (path: string, options: Parameters<UploadBackend["open"]>[1]) => {
					world.opened.set(path, (world.opened.get(path) ?? 0) + 1);
					const sink = await (overrides.open ?? real.open.bind(real))(path, options);
					return {
						write: async (data: Buffer, offset: number) => {
							if (world.linkDown) throw lostLink();
							await sink.write(data, offset);
						},
						finish: (sha256: string | null) => sink.finish(sha256),
						abort: () => sink.abort(),
					} satisfies UploadSink;
				},
			},
		});
		for (const [name, value] of Object.entries(overrides)) {
			if (name !== "open") Object.defineProperty(view, name, { value });
		}
		return view;
	};
	const deps: TransferDeps = {
		files: {
			channelHost: (channelId) => ({ hostId: world.hostOf.get(channelId) ?? HOST, hostType }),
			uploadBackend: async (hostId) => {
				if (!isConnected(hostId)) {
					throw new FileAccessError("HOST_NOT_CONNECTED", "This host is not connected");
				}
				return backend();
			},
		},
		mayWrite: (_channelId, clientId) => world.holder === null || world.holder === clientId,
		channelEnded: () => world.ended,
		clientsOf: () => [WRITER.clientId, READER.clientId],
		send: (clientId, message) => {
			const list = world.sent.get(clientId) ?? [];
			list.push(message as Record<string, unknown>);
			world.sent.set(clientId, list);
		},
		isConnected: (hostId) => isConnected(hostId),
		connect: async (hostId, clientId) => {
			world.connects.push(hostId);
			if (world.connect !== null) return world.connect(hostId, clientId);
			world.connected = true;
			world.away.delete(hostId);
			return { connected: true };
		},
		verifyFor: () => world.verify,
		maxConcurrent: () => world.maxConcurrent,
		onHostIdle: (hostId) => world.idle.push(hostId),
		store: options.store ?? null,
		hostType: () => hostType,
		now: () => world.now ?? Date.now(),
	};
	const service = new TransferService(deps);
	return { service, world };
}

export type Service = ReturnType<typeof serviceOn>;

/** The messages of `type` a client got. */
export function received(
	world: ServiceWorld,
	clientId: string,
	type: string,
): Record<string, unknown>[] {
	return (world.sent.get(clientId) ?? []).filter((message) => message.type === type);
}

/** Start an upload, and wait for the hub's answer: its id, or the error it gave. */
export async function startUpload(
	{ service, world }: Service,
	dir: string,
	items: TransferStartItem[],
	onConflict: TransferOnConflict = "ask",
	requester: TransferRequester = WRITER,
	channelId: string = CHANNEL,
): Promise<{ transferId: string; accepted: Record<string, unknown> }> {
	const requestId = `r${Math.random().toString(36).slice(2)}`;
	const msg: TransferStartMessage = {
		type: "TRANSFER_START",
		requestId,
		channelId,
		dir,
		items,
		onConflict,
	};
	await service.start(requester, msg);
	const answer = (world.sent.get(requester.clientId) ?? []).find(
		(message) => message.requestId === requestId,
	);
	if (answer?.type !== "TRANSFER_ACCEPTED") {
		throw Object.assign(new Error(`not accepted: ${JSON.stringify(answer)}`), { answer });
	}
	return { transferId: answer.transferId as string, accepted: answer };
}

/** What the hub answered a start that it refused. */
export async function refusedStart(
	s: Service,
	dir: string,
	items: TransferStartItem[],
	requester: TransferRequester = WRITER,
): Promise<Record<string, unknown>> {
	const error = await startUpload(s, dir, items, "ask", requester).then(
		() => null,
		(caught: { answer?: Record<string, unknown> }) => caught.answer ?? null,
	);
	expect(error?.type).toBe("TRANSFER_ERROR");
	return error as Record<string, unknown>;
}

export interface ItemView {
	item_id: number;
	rel_path: string;
	state: TransferItemState;
	acked?: number;
	outcome?: string;
	final_name?: string;
	verification?: string;
	reason?: string;
	code?: string;
	type_clash?: boolean;
	late?: boolean;
}

export function itemsOf(s: Service, transferId: string): ItemView[] {
	return (s.service.describe(transferId)?.items ?? []) as ItemView[];
}

export function itemOf(s: Service, transferId: string, relPath: string): ItemView {
	const found = itemsOf(s, transferId).find((item) => item.rel_path === relPath);
	if (found === undefined) throw new Error(`no item ${relPath}`);
	return found;
}

export async function waitFor<T>(check: () => T, timeout = 20_000): Promise<T> {
	return vi.waitFor(check, { timeout, interval: 20 });
}

export async function waitState(
	s: Service,
	transferId: string,
	relPath: string,
	state: TransferItemState,
): Promise<ItemView> {
	return waitFor(() => {
		const item = itemOf(s, transferId, relPath);
		expect(item.state).toBe(state);
		return item;
	});
}

/**
 * Send a file's bytes as a window does: once the hub says it is sending, from
 * where the host's bytes end, chunk by chunk.
 */
export async function sendFile(
	s: Service,
	transferId: string,
	relPath: string,
	data: Buffer,
	chunk = 64 * 1024,
	requester: TransferRequester = WRITER,
): Promise<void> {
	const item = await waitState(s, transferId, relPath, "sending");
	for (let at = item.acked ?? 0; at < data.length; at += chunk) {
		await s.service.receive(requester, transferId, item.item_id, at, data.subarray(at, at + chunk));
	}
}

/** A sink that hands the host other bytes than the hub hashes, or fails as a full disk. */
export function tamperedSink(
	sink: UploadSink,
	change: (data: Buffer, offset: number) => Buffer | Error,
): UploadSink {
	return {
		write: async (data, offset) => {
			const changed = change(data, offset);
			if (changed instanceof Error) throw changed;
			await sink.write(changed, offset);
		},
		finish: (sha256) => sink.finish(sha256),
		abort: () => sink.abort(),
	};
}
