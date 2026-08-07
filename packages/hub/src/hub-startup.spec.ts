import { describe, expect, it, vi } from "vitest";
import { startHub } from "./hub-startup.js";
import { PreviousInstallationError } from "./previous-installation.js";

// The refusal has to belong to the operation that constructs a hub, not to the
// `start` command handler: the daemon child re-enters through the CLI, `pnpm dev`
// enters through `main.ts`, and both would otherwise take the new lock and serve
// alongside a Termora hub that knows nothing about it.
describe("startHub refuses beside a previous installation", () => {
	it("throws instead of constructing, and takes no authority on the way out", async () => {
		const acquireHubLock = vi.fn();
		const getStateDir = vi.fn(() => "/nonexistent/state");
		const openDatabases = vi.fn();
		const createServer = vi.fn();

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => "Found a Termora installation.",
					acquireHubLock,
					getStateDir,
					openDatabases,
					createServer,
				},
			),
		).rejects.toThrow(PreviousInstallationError);

		// The whole point of the ordering: nothing was claimed, opened or created.
		// If the check ever moves below the lock, this is what notices.
		expect(acquireHubLock).not.toHaveBeenCalled();
		expect(getStateDir).not.toHaveBeenCalled();
		expect(openDatabases).not.toHaveBeenCalled();
		expect(createServer).not.toHaveBeenCalled();
	});

	it("carries the description as the error message, since that text is the diagnosis", async () => {
		const description = "Found a Termora installation. Lasterm will not run beside it:\n  /x/y";
		await expect(
			startHub({ port: 4100 }, { describePreviousInstallation: () => description }),
		).rejects.toThrow(description);
	});

	it("consults the probe before anything else on every call", async () => {
		const describePreviousInstallation = vi.fn(() => "Found a Termora installation.");
		await expect(startHub({ port: 4100 }, { describePreviousInstallation })).rejects.toThrow(
			PreviousInstallationError,
		);
		expect(describePreviousInstallation).toHaveBeenCalledTimes(1);
	});
});
