import { describe, expect, it, vi } from "vitest";
import {
	otherHubsQuestion,
	type ReplaceAgentResponse,
	replaceAgentWithConsent,
} from "./replace-agent.js";

/** The hub, answering each POST in turn with the next of these. */
function mockedHub(...answers: ReplaceAgentResponse[]) {
	const post = vi.fn(async (_force: boolean) => {
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
		expect(post.mock.calls).toEqual([[false], [true]]);
		expect(shown).toBe("The agent was stopped.");
	});

	it("on a no, sends nothing more and says nothing was replaced", async () => {
		const post = mockedHub(otherHubsHold(2));
		const confirm = vi.fn(() => false);

		const shown = await replaceAgentWithConsent({ post, confirm });

		expect(post.mock.calls).toEqual([[false]]);
		expect(shown).toContain("Nothing was replaced");
	});

	it("asks nothing when the agent stopped at once", async () => {
		const post = mockedHub(replaced);
		const confirm = vi.fn(() => true);

		expect(await replaceAgentWithConsent({ post, confirm })).toBe("The agent was stopped.");
		expect(confirm).not.toHaveBeenCalled();
		expect(post.mock.calls).toEqual([[false]]);
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
