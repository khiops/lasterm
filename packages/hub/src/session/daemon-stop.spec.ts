import { EventEmitter } from "node:events";
import type { ProtocolMessage } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConnection } from "./agent-connection.js";
import { requestDaemonStop } from "./daemon-stop.js";

/** A connection to a daemon, reduced to what a STOP touches. */
class FakeDaemonConnection extends EventEmitter {
	readonly sent: ProtocolMessage[] = [];
	otherOwnerChannels: number | undefined;
	closedByHub = false;
	send = vi.fn((msg: ProtocolMessage) => {
		this.sent.push(msg);
	});

	/** The daemon answering, a tick later, as a socket would. */
	answer(msg: Record<string, unknown>): void {
		setImmediate(() => this.emit("message", msg));
	}

	end(): void {
		setImmediate(() => this.emit("close"));
	}
}

const asAgent = (fake: FakeDaemonConnection) => fake as unknown as AgentConnection;

describe("requestDaemonStop (#127)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("asks with the force it was given", async () => {
		for (const force of [false, true]) {
			const daemon = new FakeDaemonConnection();
			daemon.end();
			await requestDaemonStop(asAgent(daemon), { force });
			expect(daemon.sent).toEqual([{ type: "STOP", force }]);
		}
	});

	it("reads the connection ending as the stop, and lets the owner go before anyone else hears", async () => {
		const daemon = new FakeDaemonConnection();
		const events: string[] = [];
		// Registered first, like the manager's own close handling.
		daemon.on("close", () => events.push("close handling"));
		daemon.end();

		const outcome = await requestDaemonStop(asAgent(daemon), {
			force: true,
			onStopped: () => events.push("let go"),
		});

		expect(outcome).toEqual({ kind: "stopped" });
		expect(events).toEqual(["let go", "close handling"]);
	});

	it("reports a refusal with the count the agent gives as a field", async () => {
		const daemon = new FakeDaemonConnection();
		daemon.otherOwnerChannels = 9;
		// Decoded from the wire's other_owner_channels. The message states another
		// number, and the connection's count is older: the field is what counts.
		daemon.answer({
			type: "ERROR",
			code: "OTHER_HUBS_HOLD_CHANNELS",
			message: "refused at 12:00 by 1 daemon",
			otherOwnerChannels: 5,
		});

		expect(await requestDaemonStop(asAgent(daemon), { force: false })).toEqual({
			kind: "refused",
			message: "refused at 12:00 by 1 daemon",
			otherOwnerChannels: 5,
		});
	});

	it("reads the message when the field is not a count", async () => {
		for (const field of [-1, 2.5, "5", null]) {
			const daemon = new FakeDaemonConnection();
			daemon.answer({
				type: "ERROR",
				code: "OTHER_HUBS_HOLD_CHANNELS",
				message: "3 channels belong to other hubs",
				otherOwnerChannels: field,
			});

			expect(await requestDaemonStop(asAgent(daemon), { force: false })).toMatchObject({
				kind: "refused",
				otherOwnerChannels: 3,
			});
		}
	});

	it("reports a refusal with the count its message states, from an agent that sends no field", async () => {
		const daemon = new FakeDaemonConnection();
		daemon.answer({
			type: "ERROR",
			code: "OTHER_HUBS_HOLD_CHANNELS",
			message: "3 channels belong to other hubs; nothing was stopped",
		});

		expect(await requestDaemonStop(asAgent(daemon), { force: false })).toEqual({
			kind: "refused",
			message: "3 channels belong to other hubs; nothing was stopped",
			otherOwnerChannels: 3,
		});
	});

	it("falls back on the count the daemon gave at connection when the refusal states none", async () => {
		const daemon = new FakeDaemonConnection();
		daemon.otherOwnerChannels = 4;
		daemon.answer({ type: "ERROR", code: "OTHER_HUBS_HOLD_CHANNELS", message: "other hubs" });

		expect(await requestDaemonStop(asAgent(daemon), { force: false })).toMatchObject({
			kind: "refused",
			otherOwnerChannels: 4,
		});
	});

	it("is not answered by a channel's error", async () => {
		const daemon = new FakeDaemonConnection();
		daemon.answer({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "x", channelId: "ch-1" });
		daemon.end();

		expect(await requestDaemonStop(asAgent(daemon), { force: false })).toEqual({ kind: "stopped" });
	});

	it("gives up when nothing comes back in time", async () => {
		vi.useFakeTimers();
		const daemon = new FakeDaemonConnection();
		const pending = requestDaemonStop(asAgent(daemon), { force: false, timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);

		expect(await pending).toEqual({ kind: "timeout" });
		// Nothing is left listening on a connection the hub keeps using.
		expect(daemon.listenerCount("message")).toBe(0);
		expect(daemon.listenerCount("close")).toBe(0);
	});

	it("says it could not ask when there is no connection to ask on", async () => {
		const daemon = new FakeDaemonConnection();
		daemon.send.mockImplementation(() => {
			throw new Error("SSH agent not connected");
		});

		expect(await requestDaemonStop(asAgent(daemon), { force: false })).toEqual({
			kind: "unsent",
			message: "SSH agent not connected",
		});
	});
});

describe("#674 stop close classification", () => {
	it("observes DISPLACED before an earlier listener closes the connection", async () => {
		const daemon = new FakeDaemonConnection();
		daemon.on("message", () => {
			daemon.closedByHub = true;
			daemon.emit("close");
		});
		const stopped = vi.fn();
		const pending = requestDaemonStop(asAgent(daemon), { force: false, onStopped: stopped });
		daemon.emit("message", { type: "ERROR", code: "DISPLACED", message: "another hub" });
		expect(await pending).toEqual({ kind: "displaced" });
		expect(stopped).not.toHaveBeenCalled();
	});
	it("reads a hub-issued close as unconfirmed", async () => {
		const daemon = new FakeDaemonConnection();
		const stopped = vi.fn();
		const pending = requestDaemonStop(asAgent(daemon), { force: false, onStopped: stopped });
		daemon.closedByHub = true;
		daemon.emit("close");
		expect(await pending).toEqual({ kind: "closed_by_hub" });
		expect(stopped).not.toHaveBeenCalled();
	});
	it("reads a close while quitting as unconfirmed", async () => {
		const daemon = new FakeDaemonConnection();
		let quitting = false;
		const stopped = vi.fn();
		const pending = requestDaemonStop(asAgent(daemon), {
			force: false,
			onStopped: stopped,
			isHubQuitting: () => quitting,
		});
		quitting = true;
		daemon.emit("close");
		expect(await pending).toEqual({ kind: "closed_by_hub" });
		expect(stopped).not.toHaveBeenCalled();
	});
	it("still confirms a plain daemon close", async () => {
		const daemon = new FakeDaemonConnection();
		const stopped = vi.fn();
		const pending = requestDaemonStop(asAgent(daemon), {
			force: false,
			onStopped: stopped,
			isHubQuitting: () => false,
		});
		daemon.emit("close");
		expect(await pending).toEqual({ kind: "stopped" });
		expect(stopped).toHaveBeenCalledOnce();
	});
});
