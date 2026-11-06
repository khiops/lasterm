/**
 * Runs before every hub and scripts spec file (vitest `setupFiles`): the file
 * starts with its state, configuration and cache directories in a temporary
 * root, so a spec that never isolates them, or a child process it starts,
 * cannot touch the developer's own hub (#333). Specs that need a fresh root per
 * test still call usePlatformDirs themselves.
 *
 * The SSH agent is kept out the same way: key auth asks the agent whether it
 * holds the key (#876), and the developer's own agent is not a spec's to ask.
 * `SSH_AUTH_SOCK` points at an agent that does not exist, which also keeps
 * Windows from falling back to its OpenSSH agent's pipe. A spec that wants an
 * agent starts a fake one and points `SSH_AUTH_SOCK` at it. Set directly rather
 * than stubbed, so that a spec's `vi.unstubAllEnvs` comes back to it.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { usePlatformDirs } from "./platform-dirs.fixture.js";

const root = mkdtempSync(join(tmpdir(), "lasterm-spec-"));
const restore = usePlatformDirs({
	state: join(root, "state"),
	config: join(root, "config"),
	cache: join(root, "cache"),
});

const developerAgent = process.env.SSH_AUTH_SOCK;
process.env.SSH_AUTH_SOCK =
	process.platform === "win32"
		? String.raw`\\.\pipe\lasterm-spec-no-agent-${randomUUID()}`
		: join(root, "no-agent.sock");

afterAll(() => {
	restore();
	if (developerAgent === undefined) delete process.env.SSH_AUTH_SOCK;
	else process.env.SSH_AUTH_SOCK = developerAgent;
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// A handle Windows has not released yet leaves the directory in the
		// system temp folder; failing the spec file over it would be noise.
	}
});
