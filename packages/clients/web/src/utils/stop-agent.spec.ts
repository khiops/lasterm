import type { Host } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import type { StopKeepingAgentAnswer } from "../stores/hosts.js";
import { stopAgentWithConsent } from "./stop-agent.js";

const host: Host = {
	id: "pi",
	label: "pi",
	type: "ssh",
	iconType: "auto",
	trustRemoteHints: "apply",
	sortOrder: 0,
	os: null,
	arch: null,
	createdAt: "",
	updatedAt: "",
};
const done: StopKeepingAgentAnswer = {
	ok: true,
	status: 200,
	body: { outcome: "stopped", host, ended: 2 },
};
function refusal(code: string, status = 409): StopKeepingAgentAnswer {
	return {
		ok: false,
		status,
		body: {
			error: { code, message: "hub reason", terminals: 2, transfers: 4, other_owner_channels: 3 },
		},
	};
}
const codes = ["TERMINALS_WOULD_END", "OTHER_HUBS_HOLD_CHANNELS", "TRANSFERS_WOULD_STOP"];

describe("stopAgentWithConsent", () => {
	it("posts an empty body and returns the outcome", async () => {
		const post = vi.fn().mockResolvedValue(done);
		const confirm = vi.fn();
		expect(await stopAgentWithConsent("pi", { post, confirm })).toEqual({
			kind: "done",
			outcome: done.body,
		});
		expect(post.mock.calls).toEqual([[{}]]);
		expect(confirm).not.toHaveBeenCalled();
	});

	it.each(codes)("declines %s without another post", async (code) => {
		const post = vi.fn().mockResolvedValue(refusal(code));
		const confirm = vi.fn().mockResolvedValue(false);
		expect(await stopAgentWithConsent("pi", { post, confirm })).toEqual({ kind: "declined" });
		expect(post).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it.each(codes)("consents to %s with only its flag", async (code) => {
		const post = vi.fn().mockResolvedValueOnce(refusal(code)).mockResolvedValueOnce(done);
		const confirm = vi.fn().mockResolvedValue(true);
		expect((await stopAgentWithConsent("pi", { post, confirm })).kind).toBe("done");
		expect(post.mock.calls).toEqual([
			[{}],
			[
				code === "TERMINALS_WOULD_END"
					? { end_terminals: true }
					: code === "TRANSFERS_WOULD_STOP"
						? { stop_transfers: true }
						: { force: true },
			],
		]);
		const question = confirm.mock.calls[0]?.[0];
		expect(question.title).toBe("Stop the agent on pi?");
		if (code === "TERMINALS_WOULD_END") expect(question.message).toBe("Its 2 terminals here end.");
		if (code === "TRANSFERS_WOULD_STOP")
			expect(question.message).toBe("4 uploads to this host stop.");
		if (code === "OTHER_HUBS_HOLD_CHANNELS") expect(question.message).toContain("3 terminals");
	});

	it("retains terminal consent before OTHER_HUBS_HOLD_CHANNELS", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(refusal("TERMINALS_WOULD_END"))
			.mockResolvedValueOnce(refusal("OTHER_HUBS_HOLD_CHANNELS"))
			.mockResolvedValueOnce(done);
		await stopAgentWithConsent("pi", { post, confirm: () => true });
		expect(post.mock.calls).toEqual([
			[{}],
			[{ end_terminals: true }],
			[{ end_terminals: true, force: true }],
		]);
	});

	it("keeps every consent given when the uploads ask last (#1090)", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(refusal("TERMINALS_WOULD_END"))
			.mockResolvedValueOnce(refusal("TRANSFERS_WOULD_STOP"))
			.mockResolvedValueOnce(refusal("OTHER_HUBS_HOLD_CHANNELS"))
			.mockResolvedValueOnce(done);
		await stopAgentWithConsent("pi", { post, confirm: () => true });
		expect(post.mock.calls.at(-1)).toEqual([
			{ end_terminals: true, stop_transfers: true, force: true },
		]);
	});

	it("declines OTHER_HUBS_HOLD_CHANNELS after terminal consent", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(refusal("TERMINALS_WOULD_END"))
			.mockResolvedValueOnce(refusal("OTHER_HUBS_HOLD_CHANNELS"));
		const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await stopAgentWithConsent("pi", { post, confirm })).toEqual({ kind: "declined" });
		expect(post).toHaveBeenCalledTimes(2);
	});

	it.each(["HOST_BUSY", "HOST_NOT_CONNECTED", "NO_DAEMON_CONNECTION", "OTHER_ERROR"])(
		"returns %s without retry",
		async (code) => {
			const post = vi.fn().mockResolvedValue(refusal(code));
			const confirm = vi.fn();
			expect(await stopAgentWithConsent("pi", { post, confirm })).toEqual({
				kind: "failed",
				message: "hub reason",
			});
			expect(post).toHaveBeenCalledTimes(1);
			expect(confirm).not.toHaveBeenCalled();
		},
	);

	it("returns errors after consent without retry", async () => {
		const post = vi
			.fn()
			.mockResolvedValueOnce(refusal("TERMINALS_WOULD_END"))
			.mockResolvedValueOnce(refusal("HOST_BUSY"));
		expect(await stopAgentWithConsent("pi", { post, confirm: () => true })).toEqual({
			kind: "failed",
			message: "hub reason",
		});
		expect(post).toHaveBeenCalledTimes(2);
	});

	it("does not ask again for consent already given", async () => {
		const post = vi.fn().mockResolvedValue(refusal("OTHER_HUBS_HOLD_CHANNELS"));
		expect((await stopAgentWithConsent("pi", { post, confirm: () => true })).kind).toBe("failed");
		expect(post).toHaveBeenCalledTimes(2);
	});

	it("returns disabled_not_stopped with its message and host", async () => {
		const body = { outcome: "disabled_not_stopped", message: "may still run", host } as const;
		expect(
			await stopAgentWithConsent("pi", {
				post: async () => ({ ok: true, status: 200, body }),
				confirm: () => true,
			}),
		).toEqual({ kind: "done", outcome: body });
	});

	it("does not treat a non-409 as a consent request", async () => {
		const post = vi.fn().mockResolvedValue(refusal("TERMINALS_WOULD_END", 500));
		expect((await stopAgentWithConsent("pi", { post, confirm: () => true })).kind).toBe("failed");
		expect(post).toHaveBeenCalledTimes(1);
	});

	it("falls back to status without an error message", async () => {
		expect(
			await stopAgentWithConsent("pi", {
				post: async () => ({ ok: false, status: 502, body: {} }),
				confirm: () => true,
			}),
		).toEqual({ kind: "failed", message: "The hub answered 502." });
	});
});

describe("what a daemon's own list refuses (#701)", () => {
	it.each(["OTHER_HOST_TERMINALS", "AGENT_INVENTORY_UNKNOWN"])(
		"shows %s as a failure with its message, asking nothing",
		async (code) => {
			const post = vi.fn().mockResolvedValue(refusal(code));
			const confirm = vi.fn();
			expect(await stopAgentWithConsent("pi", { post, confirm })).toEqual({
				kind: "failed",
				message: "hub reason",
			});
			expect(confirm).not.toHaveBeenCalled();
			expect(post).toHaveBeenCalledOnce();
		},
	);
});
