import { describe, expect, it, vi } from "vitest";
import type { HostConnectionAnswer } from "../stores/hosts.js";
import { closeConnectionWithConsent, terminalsEndQuestion } from "./host-connection.js";

const done: HostConnectionAnswer = {
	ok: true,
	status: 200,
	body: { status: "disconnected", ended: 0 },
};

function wouldEnd(terminals: number): HostConnectionAnswer {
	return {
		ok: false,
		status: 409,
		body: {
			error: {
				code: "TERMINALS_WOULD_END",
				message: `${terminals} terminals on this host would end. Send force: true to end them.`,
				terminals,
			},
		},
	};
}

describe("terminalsEndQuestion (#648)", () => {
	it("says how many terminals end, on which host, and names the gesture", () => {
		expect(terminalsEndQuestion("disconnect", "pi", 3)).toEqual({
			title: "Disconnect pi?",
			message: "3 terminals on pi will end.",
			confirmLabel: "Disconnect",
		});
		expect(terminalsEndQuestion("reconnect", "box", 1)).toEqual({
			title: "Reconnect box?",
			message: "1 terminal on box will end.",
			confirmLabel: "Reconnect",
		});
	});
});

describe("closeConnectionWithConsent (#648)", () => {
	it("asks nothing when nothing ends: a daemon keeps them, or there are none", async () => {
		const post = vi.fn(async () => done);
		const confirm = vi.fn(() => true);

		await expect(
			closeConnectionWithConsent("disconnect", "pi", { post, confirm }),
		).resolves.toEqual({ kind: "done" });
		expect(post.mock.calls).toEqual([[false]]);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("asks when terminals would end, and forces only after a yes", async () => {
		const post = vi.fn(async (force: boolean) => (force ? done : wouldEnd(2)));
		const confirm = vi.fn(() => true);

		await expect(
			closeConnectionWithConsent("reconnect", "box", { post, confirm }),
		).resolves.toEqual({
			kind: "done",
		});
		expect(confirm).toHaveBeenCalledWith(terminalsEndQuestion("reconnect", "box", 2));
		expect(post.mock.calls).toEqual([[false], [true]]);
	});

	it("leaves everything as it was on a no", async () => {
		const post = vi.fn(async () => wouldEnd(2));
		const confirm = vi.fn(async () => false);

		await expect(
			closeConnectionWithConsent("disconnect", "box", { post, confirm }),
		).resolves.toEqual({ kind: "declined" });
		expect(post.mock.calls).toEqual([[false]]);
	});

	it("says the hub's reason for any other refusal, and asks nothing", async () => {
		const post = vi.fn(async () => ({
			ok: false,
			status: 409,
			body: { error: { code: "HUB_QUITTING", message: "The hub is quitting." } },
		}));
		const confirm = vi.fn(() => true);

		await expect(
			closeConnectionWithConsent("disconnect", "pi", { post, confirm }),
		).resolves.toEqual({ kind: "failed", message: "The hub is quitting." });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("says the status when the hub gave no reason", async () => {
		const post = vi.fn(async (force: boolean) =>
			force ? { ok: false, status: 500, body: {} } : wouldEnd(1),
		);

		await expect(
			closeConnectionWithConsent("disconnect", "pi", { post, confirm: () => true }),
		).resolves.toEqual({ kind: "failed", message: "The hub answered 500." });
	});
});

/** The hub's 409 for a close that would stop transfers: `transfers` holds the `downloads`. */
function refused(
	code: "TERMINALS_WOULD_END" | "TRANSFERS_WOULD_STOP",
	counts: { terminals?: number; transfers?: number; downloads?: number },
): HostConnectionAnswer {
	return { ok: false, status: 409, body: { error: { code, message: "hub reason", ...counts } } };
}

describe("closeConnectionWithConsent, while files go to or come from the host (#833, #840)", () => {
	it.each([
		["a download alone", { transfers: 1, downloads: 1 }, "1 download on pi will stop."],
		["uploads alone", { transfers: 2 }, "2 uploads to pi will stop."],
		["both", { transfers: 3, downloads: 2 }, "1 upload and 2 downloads on pi will stop."],
	])("asks before stopping %s, and forces only after a yes", async (_what, counts, message) => {
		const post = vi.fn(async (force: boolean) =>
			force ? done : refused("TRANSFERS_WOULD_STOP", counts),
		);
		const confirm = vi.fn(() => true);

		await expect(
			closeConnectionWithConsent("disconnect", "pi", { post, confirm }),
		).resolves.toEqual({ kind: "done" });
		expect(confirm.mock.calls).toEqual([
			[{ title: "Disconnect pi?", message, confirmLabel: "Disconnect" }],
		]);
		expect(post.mock.calls).toEqual([[false], [true]]);
	});

	it("leaves the download running on a no", async () => {
		const post = vi.fn(async () => refused("TRANSFERS_WOULD_STOP", { transfers: 1, downloads: 1 }));

		await expect(
			closeConnectionWithConsent("reconnect", "box", { post, confirm: () => false }),
		).resolves.toEqual({ kind: "declined" });
		expect(post.mock.calls).toEqual([[false]]);
	});

	it.each([
		[
			{ terminals: 1, transfers: 1, downloads: 1 },
			"1 terminal on box will end, and 1 download on it will stop.",
		],
		[
			{ terminals: 2, transfers: 3, downloads: 1 },
			"2 terminals on box will end, and 2 uploads and 1 download on it will stop.",
		],
		[{ terminals: 1, transfers: 1 }, "1 terminal on box will end, and 1 upload to it will stop."],
	])("names the transfers beside the terminals that end: %o", async (counts, message) => {
		const post = vi.fn(async (force: boolean) =>
			force ? done : refused("TERMINALS_WOULD_END", counts),
		);
		const confirm = vi.fn(() => true);

		await expect(
			closeConnectionWithConsent("reconnect", "box", { post, confirm }),
		).resolves.toEqual({ kind: "done" });
		expect(confirm.mock.calls).toEqual([
			[{ title: "Reconnect box?", message, confirmLabel: "Reconnect" }],
		]);
		expect(post.mock.calls).toEqual([[false], [true]]);
	});
});
