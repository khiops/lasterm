import type { AgentSpawnOkMessage, ChannelCreatedMessage, ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import { clearContext, clientDisconnect, respond } from "./prompt-context.js";
import type { PromptContext, SharedSessionContext } from "./session-context.js";
import { StateBroadcaster } from "./state-broadcaster.js";

// ─── Minimal context stub ─────────────────────────────────────────────────────
// _buildPromptAuth uses PromptContext ops (openContext, promptCtx, clearContext).
// We provide the full PromptCtxSlice surface so PromptContext ops work correctly.

function makeMinimalCtx(): Pick<
	SharedSessionContext,
	"promptContexts" | "promptIndex" | "pendingPrompts" | "clients" | "acquisitions"
> {
	return {
		promptContexts: new Map<string, PromptContext>(),
		promptIndex: new Map<string, string>(),
		pendingPrompts: new Map() as SharedSessionContext["pendingPrompts"],
		clients: new Map(),
		acquisitions: new Map() as SharedSessionContext["acquisitions"],
	};
}

// Minimal WsClient stub
function makeWsClient(id: string, onSend?: (msg: unknown) => void) {
	return {
		id,
		send: (msg: unknown) => onSend?.(msg),
		attachedChannels: new Set<string>(),
	};
}

// ─── SEC-015 Tests (updated for PromptContext-based _buildPromptAuth) ─────────
//
// _buildPromptAuth now uses PromptContext ops.
// Each call opens a dedicated "elevation" PromptContext, issues the prompt
// via prompt(), and clears the context after the prompt settles.

describe("ChannelLifecycleManager — SEC-015 pending auth prompt security", () => {
	let ctx: ReturnType<typeof makeMinimalCtx>;
	let lifecycle: ChannelLifecycleManager;

	// Minimal broadcaster stub — only used by constructor, not by auth-prompt methods
	const broadcaster = {} as import("./state-broadcaster.js").StateBroadcaster;

	beforeEach(() => {
		ctx = makeMinimalCtx();
		// Cast ctx: ChannelLifecycleManager uses PromptContext slice for _buildPromptAuth
		lifecycle = new ChannelLifecycleManager(ctx as unknown as SharedSessionContext, broadcaster);
	});

	afterEach(() => {
		// Drain any open PromptContexts to prevent timer leaks.
		for (const [id] of ctx.promptContexts) {
			clearContext(ctx as unknown as SharedSessionContext, id);
		}
	});

	it("SEC-015-A: _buildPromptAuth opens a PromptContext and sends AUTH_PROMPT to the client", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const hostId = "host-001";
			const sentMessages: unknown[] = [];
			const client = makeWsClient("c-a", (m) => sentMessages.push(m));

			// Wire the client into ctx so the send callback can reach it.
			ctx.clients.set("c-a", client as never);

			// Access _buildPromptAuth via cast (private method under test)
			const buildPromptAuth = (
				lifecycle as unknown as {
					_buildPromptAuth: (
						client: typeof client,
					) => (hostId: string, promptType: string, message: string) => Promise<string | null>;
				}
			)._buildPromptAuth.bind(lifecycle);

			const promptFn = buildPromptAuth(client as never);

			// Invoke the prompt function (does NOT await — we want to inspect mid-flight)
			void promptFn(hostId, "elevation", "Enter sudo password");

			// AUTH_PROMPT should have been sent to the client.
			expect(sentMessages).toHaveLength(1);
			expect((sentMessages[0] as Record<string, unknown>).type).toBe("AUTH_PROMPT");
			expect((sentMessages[0] as Record<string, unknown>).hostId).toBe(hostId);
			expect((sentMessages[0] as Record<string, unknown>).promptType).toBe("elevation");

			// A PromptContext must exist (kind="elevation").
			expect(ctx.promptContexts.size).toBe(1);
			const [, context] = [...ctx.promptContexts.entries()][0]!;
			expect(context.kind).toBe("elevation");
			expect(context.hostId).toBe(hostId);
			expect(context.routeClientId).toBe("c-a");

			// A pendingPrompt entry must exist with type="elevation".
			expect(ctx.pendingPrompts.size).toBe(1);
			const [, pp] = [...ctx.pendingPrompts.entries()][0]!;
			expect(pp.type).toBe("elevation");
			expect(pp.hostId).toBe(hostId);

			expect(ctx.pendingPrompts.size).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("SEC-015-B: _buildPromptAuth resolves with the client's answer when respond() is called", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const hostId = "host-002";
			const sentMessages: unknown[] = [];
			const client = makeWsClient("c-b", (m) => sentMessages.push(m));
			ctx.clients.set("c-b", client as never);

			const buildPromptAuth = (
				lifecycle as unknown as {
					_buildPromptAuth: (
						client: typeof client,
					) => (hostId: string, promptType: string, message: string) => Promise<string | null>;
				}
			)._buildPromptAuth.bind(lifecycle);

			const promptFn = buildPromptAuth(client as never);
			const promptPromise = promptFn(hostId, "elevation", "Enter sudo password");

			// Capture the promptId from the sent message.
			expect(sentMessages).toHaveLength(1);
			const promptId = (sentMessages[0] as Record<string, unknown>).promptId as string;
			expect(promptId).toBeTruthy();

			// Simulate client response via respond().
			const accepted = respond(
				ctx as unknown as SharedSessionContext,
				promptId,
				"c-b",
				undefined,
				"sudo-password",
			);
			expect(accepted).toBe(true);

			const result = await promptPromise;
			expect(result).toBe("sudo-password");

			// Context must be cleared after prompt settles.
			expect(ctx.promptContexts.size).toBe(0);
			expect(ctx.pendingPrompts.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("KIND-D8 _buildPromptAuth delivery failure cleans pending elevation prompt immediately", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let hasSpy: { mockRestore: () => void } | undefined;
		let getSpy: { mockRestore: () => void } | undefined;
		try {
			const hostId = "host-d8-clm";
			const client = makeWsClient("c-d8-clm");
			ctx.clients.set("c-d8-clm", client as never);
			hasSpy = vi.spyOn(ctx.clients, "has").mockReturnValue(true);
			getSpy = vi.spyOn(ctx.clients, "get").mockReturnValue(undefined);

			const buildPromptAuth = (
				lifecycle as unknown as {
					_buildPromptAuth: (
						client: typeof client,
					) => (hostId: string, promptType: string, message: string) => Promise<string | null>;
				}
			)._buildPromptAuth.bind(lifecycle);

			const promptPromise = buildPromptAuth(client as never)(
				hostId,
				"elevation",
				"Enter sudo password",
			);

			expect(ctx.pendingPrompts.size).toBe(0);
			expect(ctx.promptIndex.size).toBe(0);
			await expect(promptPromise).resolves.toBeNull();
			expect(ctx.promptContexts.size).toBe(0);
		} finally {
			getSpy?.mockRestore();
			hasSpy?.mockRestore();
			vi.useRealTimers();
		}
	});

	it("KIND-D5 elevation owner disconnect clears instead of retargeting to a live follower", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const hostId = "host-003";
			const oldMessages: unknown[] = [];
			const followerMessages: unknown[] = [];
			const oldClient = makeWsClient("c-c", (m) => oldMessages.push(m));
			const followerClient = makeWsClient("c-follower", (m) => followerMessages.push(m));
			ctx.clients.set("c-c", oldClient as never);
			ctx.clients.set("c-follower", followerClient as never);

			const acq = {
				id: "acq-elev-retarget",
				hostId,
				state: "CONNECTING" as const,
				controller: new AbortController(),
				connectPromise: new Promise(() => {}),
				_resolve: vi.fn(),
				_reject: vi.fn(),
				leases: new Set(),
			};
			const leaseOld = {
				id: "lease-old",
				hostId,
				acqId: acq.id,
				clientId: "c-c",
				released: false,
				_acq: acq,
			};
			const leaseFollower = {
				id: "lease-follower",
				hostId,
				acqId: acq.id,
				clientId: "c-follower",
				released: false,
				_acq: acq,
			};
			acq.leases.add(leaseOld);
			acq.leases.add(leaseFollower);
			ctx.acquisitions.set(hostId, acq as never);

			const buildPromptAuth = (
				lifecycle as unknown as {
					_buildPromptAuth: (
						client: typeof oldClient,
					) => (hostId: string, promptType: string, message: string) => Promise<string | null>;
				}
			)._buildPromptAuth.bind(lifecycle);

			const promptPromise = buildPromptAuth(oldClient as never)(
				hostId,
				"elevation",
				"Enter sudo password",
			);

			expect(oldMessages).toHaveLength(1);
			const firstPrompt = oldMessages[0] as Record<string, unknown>;
			const promptId = firstPrompt.promptId as string;
			expect(promptId).toBeTruthy();

			clientDisconnect(ctx as unknown as SharedSessionContext, "c-c", (clientId, msg) => {
				ctx.clients.get(clientId)?.send(msg as ProtocolMessage);
			});

			expect(oldMessages).toContainEqual({ type: "PROMPT_CANCEL", promptId });
			expect(followerMessages).toHaveLength(0);
			expect(ctx.pendingPrompts.has(promptId)).toBe(false);
			expect(ctx.promptContexts.size).toBe(0);

			const oldAccepted = respond(
				ctx as unknown as SharedSessionContext,
				promptId,
				"c-c",
				undefined,
				"old-secret",
			);
			expect(oldAccepted).toBe(false);

			await expect(promptPromise).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("SEC-015-D: unanswered elevation prompt resolves null after 60s timeout (de-wedge)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const hostId = "host-005";
			const sentMessages: unknown[] = [];
			const client = makeWsClient("c-d", (m) => sentMessages.push(m));
			ctx.clients.set("c-d", client as never);

			const buildPromptAuth = (
				lifecycle as unknown as {
					_buildPromptAuth: (
						client: typeof client,
					) => (hostId: string, promptType: string, message: string) => Promise<string | null>;
				}
			)._buildPromptAuth.bind(lifecycle);

			const promptFn = buildPromptAuth(client as never);
			const promptPromise = promptFn(hostId, "elevation", "Enter sudo password");

			// Context and pending entry are live.
			expect(ctx.promptContexts.size).toBe(1);
			expect(ctx.pendingPrompts.size).toBe(1);

			// Advance fake timers past 60s — timeout resolves null and clears the entry.
			await vi.advanceTimersByTimeAsync(60_000);

			// pendingPrompts entry is removed by the timeout handler.
			expect(ctx.pendingPrompts.size).toBe(0);

			const result = await promptPromise;
			// null → spawn fails cleanly → no wedge.
			expect(result).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── CHANNEL_CREATED broadcast tests ─────────────────────────────────────────

/**
 * Build a minimal SharedSessionContext that has just enough surface area for
 * sendSpawnAndWait: pendingRequests, channels, clients, metaDal, scheduler,
 * chunker, and hubLogger.
 */
function makeSpawnCtx(overrides?: {
	getChannel?: () => import("@lasterm/shared").Channel | undefined;
}) {
	const clients = new Map<string, ReturnType<typeof makeWsClient>>();
	const channels = new Map<
		string,
		{
			sessionId: string;
			hostId: string;
			status: string;
			clients: Set<string>;
			shell: string;
			cols: number;
			rows: number;
			dynamicTitle: null;
			processTitle: null;
			displayTitle: string;
		}
	>();
	const pendingRequests = new Map<string, (msg: ProtocolMessage) => void>();

	const now = new Date().toISOString();
	const metaDal = {
		createChannel: vi.fn(),
		updateChannelStatus: vi.fn(),
		getChannel:
			overrides?.getChannel ??
			vi.fn().mockReturnValue({
				id: "ch-1",
				sessionId: "sess-1",
				shell: "/bin/bash",
				cols: 80,
				rows: 24,
				status: "live" as const,
				createdAt: now,
				updatedAt: now,
			}),
	};

	const scheduler = { trackChannel: vi.fn() };
	const chunker = { trackChannel: vi.fn() };

	return {
		clients,
		channels,
		pendingRequests,
		metaDal,
		scheduler,
		chunker,
		sessions: new Map(),
		agents: new Map(),
		hubLogger: null,
		now,
	};
}

describe("ChannelLifecycleManager — CHANNEL_CREATED broadcast (multi-client sync)", () => {
	it("broadcasts CHANNEL_CREATED to all attached clients including an observer", async () => {
		// ── Arrange ──────────────────────────────────────────────────────────
		const spawnerMessages: ProtocolMessage[] = [];
		const observerMessages: ProtocolMessage[] = [];

		const spawner = makeWsClient("spawner", (m) => spawnerMessages.push(m as ProtocolMessage));
		const observer = makeWsClient("observer", (m) => observerMessages.push(m as ProtocolMessage));

		const { clients, channels, pendingRequests, metaDal, scheduler, chunker, now } = makeSpawnCtx();

		// Both clients are registered (e.g. both browsing the same hub)
		clients.set(spawner.id, spawner as never);
		clients.set(observer.id, observer as never);

		const ctx = {
			clients,
			channels,
			pendingRequests,
			metaDal,
			scheduler,
			chunker,
			sessions: new Map(),
			agents: new Map(),
			hubLogger: null,
			primaryToken: null,
		} as unknown as SharedSessionContext;

		const broadcaster = new StateBroadcaster(ctx);
		const manager = new ChannelLifecycleManager(ctx, broadcaster);

		const mockAgent = {
			connected: true,
			send: vi.fn(),
		};

		const spawnMsg = {
			type: "SPAWN" as const,
			requestId: "req-1",
			channelId: "ch-1",
			cols: 80,
			rows: 24,
		} as import("@lasterm/shared").AgentSpawnMessage;

		const session = { id: "sess-1" };
		const hostId = "host-1";

		// ── Act ───────────────────────────────────────────────────────────────
		// Start the spawn; it will hang waiting for SPAWN_OK — resolve it after
		const spawnPromise = manager.sendSpawnAndWait({
			agent: mockAgent as never,
			spawnMsg,
			clientId: spawner.id,
			hostId,
			session,
			client: spawner as never,
			resolvedShell: "/bin/bash",
			resolvedArgs: [],
			resolvedCwd: undefined,
			resolvedDirectProcess: false,
			resolvedLaunchProfileId: undefined,
			cols: 80,
			rows: 24,
		});

		// Simulate the agent responding with SPAWN_OK
		const spawnOk: AgentSpawnOkMessage = {
			type: "SPAWN_OK",
			requestId: "req-1",
			channelId: "ch-1",
		};
		const handler = pendingRequests.get("req-1");
		expect(handler).toBeDefined();
		handler?.(spawnOk);

		const result = await spawnPromise;

		// ── Assert ────────────────────────────────────────────────────────────
		expect(result.channelId).toBe("ch-1");
		expect(result.errCode).toBeNull();

		// Observer must have received a CHANNEL_CREATED message
		const createdMsgs = observerMessages.filter((m) => m.type === "CHANNEL_CREATED");
		expect(createdMsgs).toHaveLength(1);

		const created = createdMsgs[0] as ChannelCreatedMessage;
		expect(created.channelId).toBe("ch-1");
		expect(created.hostId).toBe(hostId);
		expect(created.sessionId).toBe(session.id);
		expect(created.status).toBe("live");
		expect(created.shell).toBe("/bin/bash");
		expect(created.cols).toBe(80);
		expect(created.rows).toBe(24);
		expect(created.createdAt).toBe(now);

		// Spawner also receives CHANNEL_CREATED (it deduplicates on the web side)
		const spawnerCreated = spawnerMessages.filter((m) => m.type === "CHANNEL_CREATED");
		expect(spawnerCreated).toHaveLength(1);

		// Spawner also received SPAWN_OK (its primary response)
		const spawnerOk = spawnerMessages.filter((m) => m.type === "SPAWN_OK");
		expect(spawnerOk).toHaveLength(1);
	});

	it("F2: CHANNEL_CREATED displayTitle uses resolveDisplayTitle (not hardcoded DEFAULT_CHANNEL_NAME)", async () => {
		// Arrange: give the channel a custom title in the DB so resolveDisplayTitle
		// returns a value DIFFERENT from DEFAULT_CHANNEL_NAME.
		// Mutation caught: setting displayTitle: DEFAULT_CHANNEL_NAME directly would
		// disagree with the resolver when a custom title exists.
		const CUSTOM_TITLE = "My Custom Terminal";
		const now = new Date().toISOString();
		const { clients, channels, pendingRequests, scheduler, chunker } = makeSpawnCtx();

		const spawner = makeWsClient("spawner-f2", (m) => {
			/* ignore spawner messages */
			void m;
		});
		const observerMessages: ProtocolMessage[] = [];
		const observer = makeWsClient("observer-f2", (m) =>
			observerMessages.push(m as ProtocolMessage),
		);
		clients.set(spawner.id, spawner as never);
		clients.set(observer.id, observer as never);

		// metaDal.getChannel returns a channel with a custom title
		const metaDal = {
			createChannel: vi.fn(),
			updateChannelStatus: vi.fn(),
			getChannel: vi.fn().mockReturnValue({
				id: "ch-f2",
				sessionId: "sess-f2",
				shell: "/bin/bash",
				cols: 80,
				rows: 24,
				status: "live" as const,
				title: CUSTOM_TITLE,
				createdAt: now,
				updatedAt: now,
			}),
		};

		const ctx = {
			clients,
			channels,
			pendingRequests,
			metaDal,
			scheduler,
			chunker,
			sessions: new Map(),
			agents: new Map(),
			hubLogger: null,
			primaryToken: null,
			configResolver: null,
		} as unknown as SharedSessionContext;

		const broadcaster = new StateBroadcaster(ctx);
		const manager = new ChannelLifecycleManager(ctx, broadcaster);

		const spawnMsg = {
			type: "SPAWN" as const,
			requestId: "req-f2",
			channelId: "ch-f2",
			cols: 80,
			rows: 24,
		} as import("@lasterm/shared").AgentSpawnMessage;

		const spawnPromise = manager.sendSpawnAndWait({
			agent: { connected: true, send: vi.fn() } as never,
			spawnMsg,
			clientId: spawner.id,
			hostId: "host-f2",
			session: { id: "sess-f2" },
			client: spawner as never,
			resolvedShell: "/bin/bash",
			resolvedArgs: [],
			resolvedCwd: undefined,
			resolvedDirectProcess: false,
			resolvedLaunchProfileId: undefined,
			cols: 80,
			rows: 24,
		});

		// Simulate SPAWN_OK
		const handler = pendingRequests.get("req-f2");
		expect(handler).toBeDefined();
		handler?.({ type: "SPAWN_OK", requestId: "req-f2", channelId: "ch-f2" } as AgentSpawnOkMessage);
		await spawnPromise;

		// Assert: CHANNEL_CREATED must carry the resolved title, not DEFAULT_CHANNEL_NAME
		const createdMsgs = observerMessages.filter((m) => m.type === "CHANNEL_CREATED");
		expect(createdMsgs).toHaveLength(1);
		const created = createdMsgs[0] as ChannelCreatedMessage;
		expect(created.displayTitle).toBe(CUSTOM_TITLE);
		expect(created.displayTitle).not.toBe("Terminal"); // guard: DEFAULT_CHANNEL_NAME is "Terminal"
	});

	it("does not broadcast CHANNEL_CREATED when spawn fails with SPAWN_ERR", async () => {
		// ── Arrange ──────────────────────────────────────────────────────────
		const observerMessages: ProtocolMessage[] = [];
		const spawnerMessages: ProtocolMessage[] = [];

		const spawner = makeWsClient("spawner-2", (m) => spawnerMessages.push(m as ProtocolMessage));
		const observer = makeWsClient("observer-2", (m) => observerMessages.push(m as ProtocolMessage));

		const { clients, channels, pendingRequests, metaDal, scheduler, chunker } = makeSpawnCtx();
		clients.set(spawner.id, spawner as never);
		clients.set(observer.id, observer as never);

		const ctx = {
			clients,
			channels,
			pendingRequests,
			metaDal,
			scheduler,
			chunker,
			sessions: new Map(),
			agents: new Map(),
			hubLogger: null,
			primaryToken: null,
		} as unknown as SharedSessionContext;

		const broadcaster = new StateBroadcaster(ctx);
		const manager = new ChannelLifecycleManager(ctx, broadcaster);

		const spawnMsg = {
			type: "SPAWN" as const,
			requestId: "req-err",
			channelId: "ch-err",
			cols: 80,
			rows: 24,
		} as import("@lasterm/shared").AgentSpawnMessage;

		const spawnPromise = manager.sendSpawnAndWait({
			agent: { connected: true, send: vi.fn() } as never,
			spawnMsg,
			clientId: spawner.id,
			hostId: "host-1",
			session: { id: "sess-1" },
			client: spawner as never,
			resolvedShell: "/bin/bash",
			resolvedArgs: [],
			resolvedCwd: undefined,
			resolvedDirectProcess: false,
			resolvedLaunchProfileId: undefined,
			cols: 80,
			rows: 24,
		});

		// Agent responds with SPAWN_ERR
		const handler = pendingRequests.get("req-err");
		handler?.({
			type: "SPAWN_ERR",
			requestId: "req-err",
			code: "SHELL_NOT_FOUND",
			message: "shell not found",
		} as import("@lasterm/shared").AgentSpawnErrMessage);

		await spawnPromise;

		// ── Assert ────────────────────────────────────────────────────────────
		// Observer must NOT receive CHANNEL_CREATED on failure
		const createdMsgs = observerMessages.filter((m) => m.type === "CHANNEL_CREATED");
		expect(createdMsgs).toHaveLength(0);
	});
});
