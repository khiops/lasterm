import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHubTlsIdentity } from "./tls-identity.js";

type TestTls = { cert: string; key: string };

const TEST_TLS_IDENTITY = Symbol.for("lasterm.testTlsIdentity");
type ProcessWithTestTls = typeof process & { [TEST_TLS_IDENTITY]?: TestTls };

/**
 * One generated identity per test-worker process. The key is only ever written
 * to a temporary directory, never to the repository.
 */
export function getTestTls(): TestTls {
	const processWithTestTls = process as ProcessWithTestTls;
	if (processWithTestTls[TEST_TLS_IDENTITY] === undefined) {
		const stateDir = mkdtempSync(join(tmpdir(), "lasterm-test-tls-"));
		processWithTestTls[TEST_TLS_IDENTITY] = resolveHubTlsIdentity(stateDir, {}).tls;
	}
	return processWithTestTls[TEST_TLS_IDENTITY];
}
