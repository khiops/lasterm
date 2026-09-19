import { describe, expect, it } from "vitest";
import { hubExitMessage } from "./hub-exit.js";

describe("hubExitMessage", () => {
	it("names the exit code when the hub reported one", () => {
		expect(hubExitMessage(3)).toContain("stopped with exit code 3");
	});

	it("still explains the way back when the code is unknown", () => {
		const message = hubExitMessage(null);
		expect(message).toContain("The Lasterm hub stopped,");
		expect(message).toContain("quit Lasterm and open it again");
	});
});
