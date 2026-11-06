import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// #868, temporary tracing: does a churn of ssh2's ciphers abort the process, and who signals it.

const cryptoModule = createRequire(import.meta.url).resolve("ssh2/lib/protocol/crypto.js");

const CHURN = `
const { createCipher, createDecipher, CIPHER_INFO, bindingAvailable } = require(process.argv[1]);
const forceNative = process.argv[2] === "js";
const info = CIPHER_INFO["aes128-gcm@openssh.com"];
const key = Buffer.alloc(info.keyLen, 1);
const iv = Buffer.alloc(info.ivLen, 2);
(async () => {
	let junk = [];
	for (let round = 0; round < 30; round++) {
		for (let i = 0; i < 10000; i++) {
			createCipher({ outbound: { onWrite() {}, cipherInfo: info, cipherKey: key, cipherIV: iv, seqno: 0, forceNative } });
			createDecipher({ inbound: { onPayload() {}, decipherInfo: info, decipherKey: key, decipherIV: iv, seqno: 0, forceNative } });
			junk.push({ round, i });
			if (junk.length > 1000) junk = [];
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
	process.stdout.write("survived binding=" + bindingAvailable + " js=" + forceNative + "\\n");
})();
`;

const trace = (line: string): void => {
	try {
		writeSync(2, `[868] ${line}\n`);
	} catch {
		// Nowhere to say it.
	}
};

const sh = (command: string): string => {
	try {
		return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		return `failed: ${(error as Error).message}`;
	}
};

const TRACEFS = existsSync("/sys/kernel/tracing/events") ? "/sys/kernel/tracing" : "/sys/kernel/debug/tracing";

function churn(
	mode: "binding" | "js",
): Promise<{ pid: number; code: number | null; signal: string | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", CHURN, cryptoModule, mode]);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code, signal) =>
			resolve({ pid: child.pid ?? -1, code, signal, stdout, stderr }),
		);
	});
}

describe("ssh2's ciphers (#868 trace)", () => {
	it("survive the garbage collector reclaiming them by the thousand", async () => {
		const gypi = join(dirname(cryptoModule), "crypto", "build", "config.gypi");
		trace(`node ${process.version}, ssh2 crypto at ${cryptoModule}`);
		trace(
			`binding config.gypi: ${existsSync(gypi) ? (/"nodedir": "[^"]*"/.exec(readFileSync(gypi, "utf8"))?.[0] ?? "no nodedir") : "absent"}`,
		);
		if (process.platform === "linux") {
			trace(
				`tracefs: ${sh(`sudo -n sh -c "echo 20000 > ${TRACEFS}/buffer_size_kb; echo 'sig != 17' > ${TRACEFS}/events/signal/signal_generate/filter && echo 1 > ${TRACEFS}/events/signal/signal_generate/enable && echo 1 > ${TRACEFS}/tracing_on && echo on" 2>&1`).trim()}`,
			);
		}
		const runs = [];
		for (const mode of ["binding", "binding", "binding", "binding", "binding", "js", "js", "js"] as const) {
			const result = await churn(mode);
			runs.push({ mode, ...result });
			trace(
				`${mode} pid ${result.pid}: code ${result.code} signal ${result.signal} stdout ${JSON.stringify(result.stdout.trim())}`,
			);
			for (const line of result.stderr.split("\n").slice(0, 12)) trace(`  stderr: ${line}`);
		}
		if (process.platform === "linux") {
			const pids = runs.map((run) => run.pid).join("|");
			const lines = sh(`sudo -n cat ${TRACEFS}/trace 2>&1`)
				.split("\n")
				.filter((line) => new RegExp(` pid=(${pids}) `).test(line));
			for (const line of lines.slice(-30)) trace(`signal: ${line.trim()}`);
			trace(`signal lines for the churn children: ${lines.length}`);
		}
		expect(
			runs.map(({ mode, signal, stdout }) => ({ mode, signal, survived: stdout.startsWith("survived") })),
		).toEqual(runs.map(({ mode }) => ({ mode, signal: null, survived: true })));
	}, 120_000);
});
