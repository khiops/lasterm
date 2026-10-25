import type { TestConnectMessage } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { handleTestConnect } from "./test-connect.js";
import type { WsHandlerContext } from "./types.js";

const message: TestConnectMessage = {
	type: "TEST_CONNECT",
	hostId: "request-id",
	hostname: "target",
	port: 22,
	sshAuth: "agent",
};
function setup() {
	const send = vi.fn();
	const handle = vi.fn().mockResolvedValue(undefined);
	const ctx = {
		clientId: "client",
		client: { send },
		sessionManager: { handleTestConnect: handle },
		log: { error: vi.fn() },
	} as unknown as WsHandlerContext;
	return { ctx, send, handle };
}
describe("TEST_CONNECT proxy validation", () => {
	it.each([
		{ sshProxyHostId: "jump", sshProxySpec: "jump" },
		{ sshProxyHostId: " " },
		{ sshProxySpec: " " },
		{ sshProxyHostId: "x".repeat(129) },
		{ sshProxySpec: "x".repeat(4097) },
		{ sshProxyHostId: 1 },
		{ sshProxySpec: null },
	])("answers invalid proxy %j with request-scoped failure", (fields) => {
		const { ctx, send, handle } = setup();
		handleTestConnect({ ...message, ...fields } as TestConnectMessage, ctx);
		expect(send).toHaveBeenCalledWith({
			type: "TEST_CONNECT_FAIL",
			hostId: message.hostId,
			message: expect.stringMatching(/sshProxy(HostId|Spec)/),
		});
		expect(handle).not.toHaveBeenCalled();
	});
	it.each([{}, { sshProxyHostId: "jump" }, { sshProxySpec: "user@jump" }])(
		"forwards valid proxy %j",
		(fields) => {
			const { ctx, send, handle } = setup();
			const msg = { ...message, ...fields };
			handleTestConnect(msg, ctx);
			expect(handle).toHaveBeenCalledWith("client", msg);
			expect(send).not.toHaveBeenCalled();
		},
	);
	it("retains ERROR for existing input checks", () => {
		const { ctx, send } = setup();
		handleTestConnect({ ...message, hostId: "", sshProxySpec: " " }, ctx);
		expect(send).toHaveBeenCalledWith({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "Invalid hostId",
		});
	});
});
