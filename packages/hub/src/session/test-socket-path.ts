/**
 * Cross-platform socket path helper for tests.
 *
 * On Linux/macOS: returns a UDS path inside a temp directory.
 * On Windows: returns a named pipe path (UDS paths in Windows temp dirs
 * exceed the 108-byte limit and may produce EACCES errors).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function getTestSocketPath(): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\lasterm-test-${randomBytes(8).toString("hex")}`;
	}
	const dir = mkdtempSync(join(tmpdir(), "lasterm-test-"));
	return join(dir, "agent.sock");
}
