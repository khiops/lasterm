import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IWsClient } from "../services/ws-client.js";
import { useHostVerifyStore } from "./host-verify.js";

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

describe("useHostVerifyStore", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	// --- basic enqueue ---

	it("starts with no pending prompt", () => {
		const store = useHostVerifyStore();
		expect(store.currentPrompt).toBeNull();
	});

	it("handleHostVerify enqueues a prompt and surfaces it as currentPrompt", () => {
		const store = useHostVerifyStore();
		store.handleHostVerify("host-1", "example.com", "AA:BB", "ED25519", "", "pid-1");

		expect(store.currentPrompt).toMatchObject({
			hostId: "host-1",
			hostname: "example.com",
			fingerprint: "AA:BB",
			algorithm: "ED25519",
			promptId: "pid-1",
		});
	});

	it("handleHostVerify sets firstConnect flag when passed", () => {
		const store = useHostVerifyStore();
		store.handleHostVerify("host-1", "example.com", "AA:BB", "ED25519", "", "pid-1", true);
		expect(store.currentPrompt?.firstConnect).toBe(true);
	});

	it("handleHostVerify does NOT set firstConnect when false (omitted from object)", () => {
		const store = useHostVerifyStore();
		store.handleHostVerify("host-1", "example.com", "AA:BB", "ED25519", "", "pid-1", false);
		expect(store.currentPrompt?.firstConnect).toBeUndefined();
	});

	// --- respond sends correct message ---

	it("respond trust_permanent sends HOST_VERIFY_RESPONSE and pops the prompt", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "OLD", "pid-1");

		store.respond("trust_permanent");

		expect(ws.send).toHaveBeenCalledWith({
			type: "HOST_VERIFY_RESPONSE",
			hostId: "host-1",
			action: "trust_permanent",
			promptId: "pid-1",
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("accept() calls respond(trust_permanent)", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "OLD", "pid-1");

		store.accept();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("trust_permanent");
	});

	it("trustOnce() calls respond(trust_once)", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "OLD", "pid-1");

		store.trustOnce();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("trust_once");
	});

	it("reject() calls respond(reject)", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "OLD", "pid-1");

		store.reject();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("reject");
	});

	it("dismiss() sends reject and pops", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "OLD", "pid-1");

		store.dismiss();

		const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(sent.action).toBe("reject");
		expect(store.currentPrompt).toBeNull();
	});

	it("respond when no prompt is a no-op", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);

		store.respond("trust_permanent");

		expect(ws.send).not.toHaveBeenCalled();
	});

	// --- queue behaviour ---

	it("two prompts with different promptIds are queued without overwriting", () => {
		const store = useHostVerifyStore();
		store.handleHostVerify("host-1", "h1.com", "FP1", "RSA", "", "pid-1");
		store.handleHostVerify("host-2", "h2.com", "FP2", "ED25519", "", "pid-2");

		expect(store.currentPrompt?.promptId).toBe("pid-1");
	});

	it("responding to the first prompt surfaces the second", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h1.com", "FP1", "RSA", "", "pid-1");
		store.handleHostVerify("host-2", "h2.com", "FP2", "ED25519", "", "pid-2");

		store.respond("trust_once");

		expect(store.currentPrompt?.promptId).toBe("pid-2");
	});

	it("accept(promptId) is a no-op once that prompt is no longer the queue head", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h1.com", "FP1", "RSA", "", "pid-1");
		store.handleHostVerify("host-2", "h2.com", "FP2", "ED25519", "", "pid-2");

		store.handlePromptCancel("pid-1");
		store.accept("pid-1");

		expect(ws.send).not.toHaveBeenCalled();
		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(warn).toHaveBeenCalledWith(
			"[host-verify] ignoring stale prompt action",
			expect.objectContaining({ promptId: "pid-1", currentPromptId: "pid-2" }),
		);
		warn.mockRestore();
	});

	it("trustOnce(promptId) sends when the promptId matches the current head", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h1.com", "FP1", "RSA", "", "pid-1");
		store.handleHostVerify("host-2", "h2.com", "FP2", "ED25519", "", "pid-2");

		store.handlePromptCancel("pid-1");
		store.trustOnce("pid-2");

		expect(ws.send).toHaveBeenCalledWith({
			type: "HOST_VERIFY_RESPONSE",
			hostId: "host-2",
			action: "trust_once",
			promptId: "pid-2",
		});
		expect(store.currentPrompt).toBeNull();
	});

	it("duplicate promptId is not enqueued twice", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "", "pid-dup");
		store.handleHostVerify("host-1", "h.c", "FP2", "RSA", "", "pid-dup");

		store.respond("trust_permanent");
		expect(store.currentPrompt).toBeNull();
	});

	// --- PROMPT_CANCEL ---

	it("handlePromptCancel removes the current prompt without sending a response", () => {
		const store = useHostVerifyStore();
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.handleHostVerify("host-1", "h1.com", "FP1", "RSA", "", "pid-1");
		store.handleHostVerify("host-2", "h2.com", "FP2", "ED25519", "", "pid-2");

		store.handlePromptCancel("pid-1");

		expect(store.currentPrompt?.promptId).toBe("pid-2");
		expect(ws.send).not.toHaveBeenCalled();
	});

	it("handlePromptCancel removes a queued (non-current) prompt", () => {
		const store = useHostVerifyStore();
		store.handleHostVerify("host-1", "h1.com", "FP1", "RSA", "", "pid-1");
		store.handleHostVerify("host-2", "h2.com", "FP2", "ED25519", "", "pid-2");

		store.handlePromptCancel("pid-2");

		expect(store.currentPrompt?.promptId).toBe("pid-1");
		const ws = makeMockWsClient();
		store.setWsClient(ws);
		store.respond("reject");
		expect(store.currentPrompt).toBeNull();
	});

	it("handlePromptCancel for unknown promptId is a no-op", () => {
		const store = useHostVerifyStore();
		store.handleHostVerify("host-1", "h.c", "FP", "RSA", "", "pid-1");

		store.handlePromptCancel("pid-unknown");

		expect(store.currentPrompt?.promptId).toBe("pid-1");
	});
});
