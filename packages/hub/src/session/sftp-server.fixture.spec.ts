/**
 * The mock SFTP server the hub specs upload to: closing it leaves none of its
 * files open, not even one an OPEN was still opening (#1046).
 */
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SFTPWrapper } from "ssh2";
import { afterEach, expect, it, vi } from "vitest";
import { startMockSshHost } from "../files/ssh-host.fixture.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";

/** The opens of `held.path`, held once their file is open until `held.release()`. */
const held = vi.hoisted(() => {
	const state = {
		path: "",
		started: 0,
		files: [] as FileHandle[],
		release: () => {},
		gate: Promise.resolve(),
	};
	state.gate = new Promise<void>((resolve) => {
		state.release = resolve;
	});
	return state;
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...real,
		open: async (...args: Parameters<typeof real.open>) => {
			if (String(args[0]) !== held.path) return real.open(...args);
			held.started++;
			const file = await real.open(...args);
			await held.gate;
			held.files.push(file);
			return file;
		},
	};
});

let root = "";
afterEach(async () => {
	for (const file of held.files) if (file.fd !== -1) await file.close();
	await removeTempDir(root);
});

it("closes, before its close resolves, a file an OPEN was still opening", async () => {
	root = makeTempDir("lasterm-sftp-close-");
	held.path = join(root, "x.bin.partial");
	const host = await startMockSshHost({ view: { style: "posix", root } });
	const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
		host.client.sftp((error, session) => (error ? reject(error) : resolve(session))),
	);
	sftp.open("/x.bin.partial", "w", () => {});
	await vi.waitFor(() => expect(held.started).toBe(1));

	// Held until the close resolves, or for long enough that a close waiting for it is.
	const closed = host.close();
	await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
	held.release();
	await closed;

	expect({
		opened: held.files.length,
		stillOpen: held.files.filter((file) => file.fd !== -1).length,
	}).toEqual({ opened: 1, stillOpen: 0 });
});
