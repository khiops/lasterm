import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IWsClient } from "../services/ws-client.js";
import { useAuthPromptStore } from "./auth-prompt.js";

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

describe("useAuthPromptStore", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	// --- basic single-prompt behaviour ---

	it("handleAuthPrompt sets currentPrompt", () => {
		const store = useAuthPromptStore();
		expect(store.currentPrompt).toBeNull();

		store.handleAuthPrompt("host-1", "password", "Enter SSH password", "pid-1", 1);
		expect(store.currentPrompt).toMatchObject({
			hostId: "host-1",
			promptType: "password",
			message: "Enter SSH password",
		});
	});

	it("handleAuthPrompt sets currentPrompt for passphrase type", () => {
		const store = useAuthPromptStore();
		store.handleAuthPrompt("host-2", "passphrase", "Enter key passphrase", "pid-1", 1);
		expect(store.currentPrompt).toMatchObject({
			hostId: "host-2",
			promptType: "passphrase",
			message: "Enter key passphrase",
		});
	});

	it("respond(secret) sends AUTH_PROMPT_RESPONSE and clears currentPrompt", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);
		store.handleAuthPrompt("host-1", "password", "Enter SSH password", "pid-1", 1);

		store.respond("mysecret");

		expect(wsClient.send).toHaveBeenCalledWith({
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-1",
			secret: "mysecret",
			rememberSession: false,
			promptId: "pid-1",
			deliveryEpoch: 1,
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("respond(secret) sends rememberSession=true when opted in", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);
		store.handleAuthPrompt("host-1", "passphrase", "Enter passphrase", "pid-1", 1);
		store.rememberSession = true;

		store.respond("my-passphrase");

		expect(wsClient.send).toHaveBeenCalledWith({
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-1",
			secret: "my-passphrase",
			rememberSession: true,
			promptId: "pid-1",
			deliveryEpoch: 1,
		});
		expect(store.currentPrompt).toBeNull();
		// rememberSession is reset after respond
		expect(store.rememberSession).toBe(false);
	});

	it("dismiss() sends AUTH_PROMPT_RESPONSE with secret=null", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);
		store.handleAuthPrompt("host-1", "password", "Enter SSH password", "pid-1", 1);

		store.dismiss();

		expect(wsClient.send).toHaveBeenCalledWith({
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-1",
			secret: null,
			rememberSession: false,
			promptId: "pid-1",
			deliveryEpoch: 1,
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("respond when no pending prompt is a no-op", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.respond("secret");

		expect(wsClient.send).not.toHaveBeenCalled();
		expect(store.currentPrompt).toBeNull();
	});

	it("respond without wsClient set does not throw", () => {
		const store = useAuthPromptStore();
		store.handleAuthPrompt("host-1", "password", "Enter SSH password", "pid-1", 1);

		expect(() => store.respond("secret")).not.toThrow();
		expect(store.currentPrompt).toBeNull();
	});

	// --- promptId + deliveryEpoch echo ---

	it("echoes promptId and deliveryEpoch in the response", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);
		store.handleAuthPrompt("host-1", "password", "Enter password", "pid-abc", 12345);

		store.respond("s3cr3t");

		expect(wsClient.send).toHaveBeenCalledWith({
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-1",
			secret: "s3cr3t",
			rememberSession: false,
			promptId: "pid-abc",
			deliveryEpoch: 12345,
		});
	});

	// --- queue behaviour ---

	it("two prompts with different promptIds are both queued (no overwrite)", () => {
		const store = useAuthPromptStore();
		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		// Only first prompt is current
		expect(store.currentPrompt?.promptId).toBe("pid-1");
	});

	it("responding to the first prompt surfaces the second", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		store.respond("first-secret");

		// First was popped, second is now current
		expect(store.currentPrompt).toMatchObject({ hostId: "host-2", promptId: "pid-2" });
	});

	it("mutation: rememberSession stays scoped to the current queued prompt", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-a", "passphrase", "msg-a", "pid-a", 1);
		store.handleAuthPrompt("host-b", "passphrase", "msg-b", "pid-b", 1);

		store.rememberSession = true;
		expect(store.currentPrompt?.rememberSession).toBe(true);

		store.handlePromptCancel("pid-a");
		expect(store.currentPrompt).toMatchObject({ hostId: "host-b", promptId: "pid-b" });
		expect(store.rememberSession).toBe(false);

		store.respond("second-passphrase", "pid-b");

		expect(wsClient.send).toHaveBeenNthCalledWith(1, {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-b",
			secret: "second-passphrase",
			rememberSession: false,
			promptId: "pid-b",
			deliveryEpoch: 1,
		});

		store.handleAuthPrompt("host-c", "passphrase", "msg-c", "pid-c", 1);
		store.rememberSession = true;
		store.respond("third-passphrase", "pid-c");

		expect(wsClient.send).toHaveBeenNthCalledWith(2, {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-c",
			secret: "third-passphrase",
			rememberSession: true,
			promptId: "pid-c",
			deliveryEpoch: 1,
		});
	});

	it("respond echoes promptId of the FIRST queued prompt (not a later one)", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		store.respond("s");

		const sent = (wsClient.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.promptId).toBe("pid-1");
	});

	it("respond(secret, promptId) is a no-op once that prompt is no longer the queue head", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		store.handlePromptCancel("pid-1");
		store.respond("stale-secret", "pid-1");

		expect(wsClient.send).not.toHaveBeenCalled();
		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(warn).toHaveBeenCalledWith(
			"[auth-prompt] ignoring stale prompt action",
			expect.objectContaining({ promptId: "pid-1", currentPromptId: "pid-2" }),
		);
		warn.mockRestore();
	});

	it("dismiss(promptId) is a no-op once that prompt is no longer the queue head", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		store.handlePromptCancel("pid-1");
		store.dismiss("pid-1");

		expect(wsClient.send).not.toHaveBeenCalled();
		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(warn).toHaveBeenCalledWith(
			"[auth-prompt] ignoring stale prompt action",
			expect.objectContaining({ promptId: "pid-1", currentPromptId: "pid-2" }),
		);
		warn.mockRestore();
	});

	it("respond(secret, promptId) sends when the promptId matches the current head", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		store.handlePromptCancel("pid-1");
		store.respond("second-secret", "pid-2");

		expect(wsClient.send).toHaveBeenCalledWith({
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-2",
			secret: "second-secret",
			rememberSession: false,
			promptId: "pid-2",
			deliveryEpoch: 1,
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("duplicate promptId is not enqueued twice", () => {
		const store = useAuthPromptStore();
		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-dup", 1);
		store.handleAuthPrompt("host-1", "password", "msg-1-repeat", "pid-dup", 1);

		store.respond("x");
		// After responding the queue should be empty (only one entry was added)
		expect(store.currentPrompt).toBeNull();
	});

	// --- PROMPT_CANCEL ---

	it("handlePromptCancel removes a queued prompt by promptId", () => {
		const store = useAuthPromptStore();
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);

		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		// Cancel the first (currently shown) prompt
		store.handlePromptCancel("pid-1");

		// Second prompt now surfaces without a response being sent
		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(wsClient.send).not.toHaveBeenCalled();
	});

	it("handlePromptCancel removes a queued (non-current) prompt by promptId", () => {
		const store = useAuthPromptStore();
		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);
		store.handleAuthPrompt("host-2", "passphrase", "msg-2", "pid-2", 1);

		// Cancel the second (background) prompt
		store.handlePromptCancel("pid-2");

		// First prompt is still current; queue now has only one entry
		expect(store.currentPrompt?.promptId).toBe("pid-1");
		// Respond clears the queue entirely
		const wsClient = makeMockWsClient();
		store.setWsClient(wsClient);
		store.respond("x");
		expect(store.currentPrompt).toBeNull();
	});

	it("handlePromptCancel for unknown promptId is a no-op", () => {
		const store = useAuthPromptStore();
		store.handleAuthPrompt("host-1", "password", "msg-1", "pid-1", 1);

		store.handlePromptCancel("pid-unknown");

		expect(store.currentPrompt?.promptId).toBe("pid-1");
	});
});
