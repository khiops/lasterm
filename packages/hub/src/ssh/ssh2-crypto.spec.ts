import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/** ssh2's cipher module, resolved as the hub resolves ssh2. */
const CRYPTO_MODULE = createRequire(import.meta.url).resolve("ssh2/lib/protocol/crypto.js");

/**
 * Makes and drops the AES-GCM cipher and decipher every SSH connection of the hub negotiates,
 * by the hundred thousand and amid other garbage, letting the event loop turn between rounds:
 * the garbage collector then reclaims them on its own, as it does in a worker or a hub that
 * opens SSH connections all day. Whichever ciphers ssh2 loaded, its native binding's or its
 * JavaScript ones, are the ones made.
 */
const CHURN = `
const { createCipher, createDecipher, CIPHER_INFO } = require(process.argv[1]);
const info = CIPHER_INFO["aes128-gcm@openssh.com"];
const key = Buffer.alloc(info.keyLen, 1);
const iv = Buffer.alloc(info.ivLen, 2);
(async () => {
	let garbage = [];
	for (let round = 0; round < 30; round++) {
		for (let i = 0; i < 10000; i++) {
			createCipher({ outbound: { onWrite() {}, cipherInfo: info, cipherKey: key, cipherIV: iv, seqno: 0 } });
			createDecipher({ inbound: { onPayload() {}, decipherInfo: info, decipherKey: key, decipherIV: iv, seqno: 0 } });
			garbage.push({ round, i });
			if (garbage.length > 1000) garbage = [];
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
	process.stdout.write("survived\\n");
})();
`;

/** Run the churn in a process of its own: an abort is then a result, not the end of this worker. */
function churn(): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", CHURN, CRYPTO_MODULE]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}

describe("ssh2's ciphers", () => {
	// #868: ssh2 1.17.0's native cipher binding, compiled against Node 24.19 headers or later,
	// aborts the process with `Assertion failed: (env) != nullptr` when the garbage collector
	// reclaims one of its ciphers (nodejs/node#65446). It killed the test worker of whichever
	// spec opened the most SSH connections, upload-backends.spec.ts, with no exit event and
	// nothing in dmesg. pnpm-workspace.yaml no longer builds that binding, which the shipped hub
	// never loads. Mutation: allow ssh2's build again, install afresh and run this spec on Node
	// 24.21, and the churn aborts.
	it("survive the garbage collector reclaiming them by the hundred thousand", async () => {
		const { stderr, ...result } = await churn();
		expect(result, stderr).toEqual({ code: 0, signal: null, stdout: "survived\n" });
	});
});
