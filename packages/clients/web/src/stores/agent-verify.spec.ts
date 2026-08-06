import type { AgentBinaryVerifyMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IWsClient } from "../services/ws-client.js";
import { useAgentVerifyStore } from "./agent-verify.js";

function makeMockWsClient(): IWsClient {
	return {
		send: vi.fn(),
		on: vi.fn(),
		isConnected: true,
		connect: vi.fn(),
		close: vi.fn(),
		onDisconnect: vi.fn(),
		onReconnect: vi.fn(),
	} as unknown as IWsClient;
}

function makeVerifyMsg(
	overrides: Partial<AgentBinaryVerifyMessage> = {},
): AgentBinaryVerifyMessage {
	return {
		type: "AGENT_BINARY_VERIFY",
		promptId: "pid-1",
		hostId: "host-1",
		hostname: "example.com",
		remotePath: "/usr/bin/lasterm-agent",
		remoteSha256: "abc123",
		os: "linux",
		arch: "x64",
		mismatch: false,
		...overrides,
	};
}

describe("useAgentVerifyStore", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	// --- basic enqueue ---

	it("starts with no currentPrompt", () => {
		const store = useAgentVerifyStore();
		expect(store.currentPrompt).toBeNull();
	});

	it("handleAgentVerify enqueues a prompt and surfaces it as currentPrompt", () => {
		const store = useAgentVerifyStore();
		store.handleAgentVerify(makeVerifyMsg());

		expect(store.currentPrompt).toMatchObject({
			promptId: "pid-1",
			hostId: "host-1",
			hostname: "example.com",
		});
	});

	// --- respond sends correct message ---

	it("respond trust_permanent sends AGENT_BINARY_VERIFY_RESPONSE and pops", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-abc" }));

		store.respond("trust_permanent");

		expect(ws.send).toHaveBeenCalledWith({
			type: "AGENT_BINARY_VERIFY_RESPONSE",
			promptId: "pid-abc",
			action: "trust_permanent",
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("respond trust_once sends correct action", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg());

		store.respond("trust_once");

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("trust_once");
	});

	it("respond reject sends correct action", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg());

		store.respond("reject");

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("reject");
	});

	it("trustPermanently() calls respond(trust_permanent)", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg());

		store.trustPermanently();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("trust_permanent");
	});

	it("trustOnce() calls respond(trust_once)", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg());

		store.trustOnce();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("trust_once");
	});

	it("reject() calls respond(reject)", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg());

		store.reject();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("reject");
	});

	it("dismiss() removes the first prompt WITHOUT sending a response", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		store.dismiss();

		expect(ws.send).not.toHaveBeenCalled();
		expect(store.currentPrompt?.promptId).toBe("pid-2");
	});

	it("respond when no pending prompt is a no-op", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);

		store.respond("reject");

		expect(ws.send).not.toHaveBeenCalled();
	});

	// --- queue behaviour ---

	it("two prompts with different promptIds are queued without overwriting", () => {
		const store = useAgentVerifyStore();
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		expect(store.currentPrompt?.promptId).toBe("pid-1");
	});

	it("responding to the first prompt surfaces the second", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		store.respond("trust_once");

		expect(store.currentPrompt?.promptId).toBe("pid-2");
	});

	it("respond echoes promptId of the first queued prompt", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-first" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-second" }));

		store.respond("trust_permanent");

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.promptId).toBe("pid-first");
	});

	it("trustOnce(promptId) is a no-op once that prompt is no longer the queue head", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		store.handlePromptCancel("pid-1");
		store.trustOnce("pid-1");

		expect(ws.send).not.toHaveBeenCalled();
		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(warn).toHaveBeenCalledWith(
			"[agent-verify] ignoring stale prompt action",
			expect.objectContaining({ promptId: "pid-1", currentPromptId: "pid-2" }),
		);
		warn.mockRestore();
	});

	it("trustPermanently(promptId) sends when the promptId matches the current head", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		store.handlePromptCancel("pid-1");
		store.trustPermanently("pid-2");

		expect(ws.send).toHaveBeenCalledWith({
			type: "AGENT_BINARY_VERIFY_RESPONSE",
			promptId: "pid-2",
			action: "trust_permanent",
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("duplicate promptId is not enqueued twice", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-dup" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-dup", remoteSha256: "different" }));

		store.respond("trust_permanent");
		expect(store.currentPrompt).toBeNull();
	});

	// --- PROMPT_CANCEL ---

	it("handlePromptCancel removes the current prompt without sending a response", () => {
		const store = useAgentVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		store.handlePromptCancel("pid-1");

		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(ws.send).not.toHaveBeenCalled();
	});

	it("handlePromptCancel removes a queued (non-current) prompt", () => {
		const store = useAgentVerifyStore();
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-2" }));

		store.handlePromptCancel("pid-2");

		expect(store.currentPrompt?.promptId).toBe("pid-1");
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.respond("reject");
		expect(store.currentPrompt).toBeNull();
	});

	it("handlePromptCancel for unknown promptId is a no-op", () => {
		const store = useAgentVerifyStore();
		store.handleAgentVerify(makeVerifyMsg({ promptId: "pid-1" }));

		store.handlePromptCancel("pid-unknown");

		expect(store.currentPrompt?.promptId).toBe("pid-1");
	});

	// --- deployError ---

	it("handleDeployError sets deployError", () => {
		const store = useAgentVerifyStore();
		store.handleDeployError("agent not available", "host-1");
		expect(store.deployError).toEqual({ message: "agent not available", hostId: "host-1" });
	});

	it("handleDeployError without hostId sets message only", () => {
		const store = useAgentVerifyStore();
		store.handleDeployError("generic error");
		expect(store.deployError).toEqual({ message: "generic error" });
	});

	it("clearDeployError clears the error", () => {
		const store = useAgentVerifyStore();
		store.handleDeployError("err");
		store.clearDeployError();
		expect(store.deployError).toBeNull();
	});
});
