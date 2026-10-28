import { afterEach, describe, expect, it, vi } from "vitest";
import { usePromptQueue } from "./usePromptQueue.js";

interface TestPrompt {
	hostId: string;
	label: string;
	promptId: string;
}

describe("usePromptQueue", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("enqueues prompts FIFO and deduplicates by promptId", () => {
		const queue = usePromptQueue<TestPrompt>();

		expect(queue.currentPrompt.value).toBeNull();
		expect(queue.enqueue({ hostId: "host-1", label: "first", promptId: "pid-1" })).toBe(true);
		expect(queue.enqueue({ hostId: "host-2", label: "duplicate", promptId: "pid-1" })).toBe(false);
		expect(queue.enqueue({ hostId: "host-2", label: "second", promptId: "pid-2" })).toBe(true);

		expect(queue.currentPrompt.value).toMatchObject({ label: "first", promptId: "pid-1" });
		expect(queue.pendingPrompts.value.map((prompt) => prompt.promptId)).toEqual(["pid-1", "pid-2"]);
	});

	it("computes the head prompt and resolveHead advances the queue", () => {
		const queue = usePromptQueue<TestPrompt>();

		queue.enqueue({ hostId: "host-1", label: "first", promptId: "pid-1" });
		queue.enqueue({ hostId: "host-2", label: "second", promptId: "pid-2" });

		expect(queue.currentPrompt.value?.label).toBe("first");
		expect(queue.resolveHead()).toMatchObject({ label: "first", promptId: "pid-1" });
		expect(queue.currentPrompt.value).toMatchObject({ label: "second", promptId: "pid-2" });
		expect(queue.resolveHead()).toMatchObject({ label: "second", promptId: "pid-2" });
		expect(queue.resolveHead()).toBeNull();
		expect(queue.currentPrompt.value).toBeNull();
	});

	it("withHeadPrompt runs only for the current head when promptId is provided", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const queue = usePromptQueue<TestPrompt>({
			stalePromptWarning: "[test] ignoring stale prompt action",
		});
		const handled: string[] = [];

		queue.enqueue({ hostId: "host-1", label: "first", promptId: "pid-1" });
		queue.enqueue({ hostId: "host-2", label: "second", promptId: "pid-2" });

		expect(
			queue.withHeadPrompt(
				"pid-2",
				(prompt) => {
					handled.push(prompt.label);
				},
				"accept",
			),
		).toBe(false);
		expect(handled).toEqual([]);
		expect(warn).toHaveBeenCalledWith("[test] ignoring stale prompt action", {
			action: "accept",
			promptId: "pid-2",
			currentPromptId: "pid-1",
		});

		expect(
			queue.withHeadPrompt("pid-1", (prompt) => {
				handled.push(prompt.label);
			}),
		).toBe(true);
		expect(handled).toEqual(["first"]);
	});

	it("withHeadPrompt acts on the head when no promptId is given", () => {
		const queue = usePromptQueue<TestPrompt>();
		const handled: string[] = [];

		queue.enqueue({ hostId: "host-1", label: "first", promptId: "pid-1" });

		expect(
			queue.withHeadPrompt(undefined, (prompt) => {
				handled.push(prompt.label);
			}),
		).toBe(true);
		expect(handled).toEqual(["first"]);
	});

	it("removeByPromptId and handlePromptCancel drop matching prompts", () => {
		const queue = usePromptQueue<TestPrompt>();

		queue.enqueue({ hostId: "host-1", label: "first", promptId: "pid-1" });
		queue.enqueue({ hostId: "host-2", label: "second", promptId: "pid-2" });
		queue.enqueue({ hostId: "host-3", label: "third", promptId: "pid-3" });

		queue.removeByPromptId("pid-2");
		expect(queue.pendingPrompts.value.map((prompt) => prompt.promptId)).toEqual(["pid-1", "pid-3"]);

		queue.handlePromptCancel("pid-1");
		expect(queue.currentPrompt.value?.promptId).toBe("pid-3");

		queue.handlePromptCancel("pid-missing");
		expect(queue.currentPrompt.value?.promptId).toBe("pid-3");
	});
});
