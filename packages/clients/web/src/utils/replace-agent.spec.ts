import { describe, expect, it, vi } from "vitest";
import {
	otherHubsQuestion,
	type ReplaceAgentConsent,
	type ReplaceAgentResponse,
	replaceAgentQuestion,
	replaceAgentWithConsent,
	transfersQuestion,
} from "./replace-agent.js";

/** The hub, answering each POST in turn with the next of these. */
function mockedHub(...answers: ReplaceAgentResponse[]) {
	const post = vi.fn(async (_consent: ReplaceAgentConsent) => {
		const next = answers.shift();
		if (next === undefined) throw new Error("the hub was asked more often than expected");
		return next;
	});
	return post;
}

const replaced: ReplaceAgentResponse = {
	ok: true,
	status: 200,
	body: { message: "The agent was stopped." },
};

const otherHubsHold = (count?: number): ReplaceAgentResponse => ({
	ok: false,
	status: 409,
	body: {
		error: {
			code: "OTHER_HUBS_HOLD_CHANNELS",
			message: "other hubs hold terminals here",
			...(count !== undefined && { other_owner_channels: count }),
		},
	},
});

describe("replacing an agent other hubs use (#127)", () => {
	it("asks before ending their terminals, and on a yes asks the hub again with force", async () => {
		const post = mockedHub(otherHubsHold(2), replaced);
		const confirm = vi.fn(() => true);

		const shown = await replaceAgentWithConsent({ post, confirm });

		expect(confirm).toHaveBeenCalledWith(
			"2 terminals opened by other hubs on this host will be closed. Replace anyway?",
		);
		expect(post.mock.calls).toEqual([
			[{ force: false, stop_transfers: false }],
			[{ force: true, stop_transfers: false }],
		]);
		expect(shown).toBe("The agent was stopped.");
	});

	it("on a no, sends nothing more and says nothing was replaced", async () => {
		const post = mockedHub(otherHubsHold(2));
		const confirm = vi.fn(() => false);

		const shown = await replaceAgentWithConsent({ post, confirm });

		expect(post.mock.calls).toEqual([[{ force: false, stop_transfers: false }]]);
		expect(shown).toContain("Nothing was replaced");
	});

	it("asks nothing when the agent stopped at once", async () => {
		const post = mockedHub(replaced);
		const confirm = vi.fn(() => true);

		expect(await replaceAgentWithConsent({ post, confirm })).toBe("The agent was stopped.");
		expect(confirm).not.toHaveBeenCalled();
		expect(post.mock.calls).toEqual([[{ force: false, stop_transfers: false }]]);
	});

	it("asks nothing when the refusal is of another kind, and shows it", async () => {
		const post = mockedHub({
			ok: false,
			status: 409,
			body: { error: { code: "AGENT_NOT_REPLACED", message: "no agent connected" } },
		});
		const confirm = vi.fn(() => true);

		expect(await replaceAgentWithConsent({ post, confirm })).toBe("no agent connected");
		expect(confirm).not.toHaveBeenCalled();
	});
});

const uploadsRunning = (count?: number): ReplaceAgentResponse => ({
	ok: false,
	status: 409,
	body: {
		error: {
			code: "TRANSFERS_WOULD_STOP",
			message: "Send stop_transfers: true to stop the uploads to this host.",
			...(count !== undefined && { transfers: count }),
		},
	},
});

describe("replacing while uploads to the host run (#1090)", () => {
	it("asks with the upload count, and on a yes asks again with stop_transfers", async () => {
		const post = mockedHub(uploadsRunning(2), replaced);
		const confirm = vi.fn(() => true);

		expect(await replaceAgentWithConsent({ post, confirm })).toBe("The agent was stopped.");
		expect(confirm).toHaveBeenCalledWith(
			"2 uploads to this host will be interrupted. Replace anyway?",
		);
		expect(post.mock.calls).toEqual([
			[{ force: false, stop_transfers: false }],
			[{ force: false, stop_transfers: true }],
		]);
	});

	it("on a no, sends nothing more and says nothing was replaced", async () => {
		const post = mockedHub(uploadsRunning(1));
		const shown = await replaceAgentWithConsent({ post, confirm: () => false });
		expect(shown).toContain("Nothing was replaced");
		expect(post).toHaveBeenCalledOnce();
	});

	it("keeps the uploads' yes when other hubs' terminals ask next", async () => {
		const post = mockedHub(uploadsRunning(1), otherHubsHold(2), replaced);
		await replaceAgentWithConsent({ post, confirm: () => true });
		expect(post.mock.calls.at(-1)).toEqual([{ force: true, stop_transfers: true }]);
	});

	it("keeps force when the uploads ask after other hubs", async () => {
		const post = mockedHub(otherHubsHold(2), uploadsRunning(1), replaced);
		await replaceAgentWithConsent({ post, confirm: () => true });
		expect(post.mock.calls.at(-1)).toEqual([{ force: true, stop_transfers: true }]);
	});

	it("does not ask again for the uploads once agreed", async () => {
		const post = mockedHub(uploadsRunning(1), uploadsRunning(1));
		const confirm = vi.fn(() => true);
		expect(await replaceAgentWithConsent({ post, confirm })).toContain("stop_transfers");
		expect(confirm).toHaveBeenCalledOnce();
	});
});

describe("replacing while downloads from the host run (#840)", () => {
	it.each([
		[
			{ transfers: 1, downloads: 1 },
			"1 download on this host will be interrupted. Replace anyway?",
			"Nothing was replaced: the downloads on this host are still running.",
		],
		[
			{ transfers: 2, downloads: 1 },
			"1 upload and 1 download on this host will be interrupted. Replace anyway?",
			"Nothing was replaced: the uploads and downloads on this host are still running.",
		],
		[
			{ transfers: 2 },
			"2 uploads to this host will be interrupted. Replace anyway?",
			"Nothing was replaced: the uploads to this host are still running.",
		],
	])("names downloads apart from uploads: %o", async (counts, question, declined) => {
		const running: ReplaceAgentResponse = {
			ok: false,
			status: 409,
			body: { error: { code: "TRANSFERS_WOULD_STOP", message: "hub reason", ...counts } },
		};
		const post = mockedHub(running, running, replaced);
		const confirm = vi.fn(() => false);

		expect(await replaceAgentWithConsent({ post, confirm })).toBe(declined);
		confirm.mockReturnValue(true);
		expect(await replaceAgentWithConsent({ post, confirm })).toBe("The agent was stopped.");
		expect(confirm.mock.calls).toEqual([[question], [question]]);
		expect(post.mock.calls).toEqual([
			[{ force: false, stop_transfers: false }],
			[{ force: false, stop_transfers: false }],
			[{ force: false, stop_transfers: true }],
		]);
	});
});

describe("transfersQuestion", () => {
	it("says how many, in the right number, or none when unknown", () => {
		expect(transfersQuestion(1)).toBe("1 upload to this host will be interrupted. Replace anyway?");
		expect(transfersQuestion(undefined)).toBe(
			"Uploads to this host will be interrupted. Replace anyway?",
		);
	});
});

describe("otherHubsQuestion", () => {
	it("says how many when the hub said, in the right number", () => {
		expect(otherHubsQuestion(1)).toBe(
			"1 terminal opened by another hub on this host will be closed. Replace anyway?",
		);
		expect(otherHubsQuestion(3)).toBe(
			"3 terminals opened by other hubs on this host will be closed. Replace anyway?",
		);
	});

	it("still asks when the count is unknown", () => {
		expect(otherHubsQuestion(undefined)).toBe(
			"Terminals opened by other hubs on this host will be closed. Replace anyway?",
		);
	});
});

describe("what a daemon's own list refuses a Replace (#701)", () => {
	it.each(["OTHER_HOST_TERMINALS", "AGENT_INVENTORY_UNKNOWN", "TERMINALS_SHOWN_ENDED"])(
		"says %s's message and asks nothing",
		async (code) => {
			const post = mockedHub({
				ok: false,
				status: 409,
				body: { error: { code, message: `the hub says ${code}` } },
			});
			const confirm = vi.fn();
			expect(await replaceAgentWithConsent({ post, confirm })).toBe(`the hub says ${code}`);
			expect(confirm).not.toHaveBeenCalled();
			expect(post).toHaveBeenCalledOnce();
		},
	);
});

describe("replaceAgentQuestion (#1185)", () => {
	it("names the host and both versions, and says the agent's terminals end", () => {
		expect(replaceAgentQuestion("Pi", { running: "0.15.2", expected: "0.22.1" })).toEqual({
			title: "Update the agent on Pi?",
			message:
				"Pi is served by agent 0.15.2; this Lasterm carries 0.22.1. Updating stops that agent and ends every terminal it is holding.",
			confirmLabel: "Update agent",
		});
	});
});
