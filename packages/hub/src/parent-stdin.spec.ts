import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { shutdownWhenStdinCloses } from "./parent-stdin.js";

describe("shutdownWhenStdinCloses (#188)", () => {
	it("shuts down once when the parent's end of the pipe closes", async () => {
		const stdin = new PassThrough();
		const shutdown = vi.fn();
		shutdownWhenStdinCloses(stdin, shutdown);

		stdin.write("ignored");
		await new Promise((resolve) => setImmediate(resolve));
		expect(shutdown).not.toHaveBeenCalled();

		stdin.end();
		await vi.waitFor(() => expect(shutdown).toHaveBeenCalled());
		// `end` and then `close` both arrive; the hub must not shut down twice.
		await new Promise((resolve) => setImmediate(resolve));
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("treats a read error as the parent being gone", async () => {
		const stdin = new PassThrough();
		const shutdown = vi.fn();
		shutdownWhenStdinCloses(stdin, shutdown);

		stdin.destroy(new Error("broken pipe"));
		await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
	});
});
