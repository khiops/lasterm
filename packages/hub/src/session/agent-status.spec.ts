import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TARGET_TRIPLES } from "./agent-cache.js";
import {
	type AgentTargetArch,
	type AgentTargetOs,
	computeTargetStatus,
	type HubPlatform,
} from "./agent-status.js";

const HUB_VERSION = "0.4.1";
const HUB_PLATFORM = { os: "linux", arch: "x64" } as const satisfies HubPlatform;
const BUNDLED_PATH = "/tmp/lasterm-agent-test";

type AgentTargetEntry = {
	readonly triple: string | null;
	readonly ext: "" | ".exe";
	readonly built: boolean;
};

const AGENT_TARGET_TABLE = AGENT_TARGET_TRIPLES as Record<
	AgentTargetOs,
	Record<AgentTargetArch, AgentTargetEntry>
>;

let tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("computeTargetStatus", () => {
	it("reports the hub platform as bundled with a stubbed version reader", async () => {
		const cacheDir = makeTempDir();
		const snapshot = await computeTargetStatus({
			cacheDir,
			hubVersion: HUB_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => BUNDLED_PATH,
			versionReader: (binaryPath) => {
				expect(binaryPath).toBe(BUNDLED_PATH);
				return "0.4.2";
			},
		});

		const target = targetRow(snapshot, "linux", "x64");
		expect(target.status).toBe("bundled");
		expect(target.version).toBe("0.4.2");
		expect(target.expected_version).toBe(HUB_VERSION);
	});

	it("memoizes successful bundled version reads", async () => {
		const cacheDir = makeTempDir();
		let calls = 0;
		const versionReader = () => {
			calls++;
			return HUB_VERSION;
		};
		const opts = {
			cacheDir,
			hubVersion: HUB_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => BUNDLED_PATH,
			versionReader,
		};

		await computeTargetStatus(opts);
		await computeTargetStatus(opts);

		expect(calls).toBe(1);
	});

	it("reports bundled error when the binary is absent", async () => {
		const cacheDir = makeTempDir();
		let calls = 0;
		const snapshot = await computeTargetStatus({
			cacheDir,
			hubVersion: HUB_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => null,
			versionReader: () => {
				calls++;
				return HUB_VERSION;
			},
		});

		expect(targetRow(snapshot, "linux", "x64").status).toBe("error");
		expect(calls).toBe(0);
	});

	it("reports bundled error when the version reader throws and retries the next call", async () => {
		const cacheDir = makeTempDir();
		let calls = 0;
		const versionReader = () => {
			calls++;
			if (calls === 1) throw new Error("version unreadable");
			return HUB_VERSION;
		};
		const opts = {
			cacheDir,
			hubVersion: HUB_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => `${BUNDLED_PATH}-retry`,
			versionReader,
		};

		const first = await computeTargetStatus(opts);
		const second = await computeTargetStatus(opts);

		expect(targetRow(first, "linux", "x64").status).toBe("error");
		expect(targetRow(second, "linux", "x64").status).toBe("bundled");
		expect(calls).toBe(2);
	});

	it("reports cached, stale, missing, and unsupported remote targets", async () => {
		const cacheDir = makeTempDir();
		writeFileSync(agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION), "current");
		writeFileSync(agentCachePath(cacheDir, "windows", "x64", "0.3.9"), "stale");

		const snapshot = await baseSnapshot(cacheDir);
		const cached = targetRow(snapshot, "linux", "arm64");
		const stale = targetRow(snapshot, "windows", "x64");

		expect(cached.status).toBe("cached");
		expect(cached.version).toBe(HUB_VERSION);
		expect(cached.size).toBe("current".length);
		expect(cached.mtime).toEqual(expect.any(String));
		expect(stale.status).toBe("stale");
		expect(stale.version).toBe("0.3.9");
		expect(targetRow(snapshot, "windows", "arm64").status).toBe("unsupported");
		expect(targetRow(snapshot, "darwin", "x64").status).toBe("unsupported");
		expect(targetRow(snapshot, "darwin", "arm64").status).toBe("unsupported");

		const empty = await baseSnapshot(makeTempDir());
		expect(targetRow(empty, "linux", "arm64").status).toBe("missing");
		expect(targetRow(empty, "windows", "x64").status).toBe("missing");
	});

	it.skipIf(process.platform === "win32")(
		"reports a planted symlink cache entry as untrusted",
		async () => {
			const cacheDir = makeTempDir();
			const outsideDir = makeTempDir();
			const outsideBinary = path.join(outsideDir, "outside-agent");
			writeFileSync(outsideBinary, "outside");
			symlinkSync(outsideBinary, agentCachePath(cacheDir, "linux", "arm64", HUB_VERSION));

			const snapshot = await baseSnapshot(cacheDir);

			expect(targetRow(snapshot, "linux", "arm64").status).toBe("untrusted");
			expect(existsSync(outsideBinary)).toBe(true);
		},
	);

	it("selects stale cache entries using numeric semver order", async () => {
		const cacheDir = makeTempDir();
		writeFileSync(agentCachePath(cacheDir, "linux", "arm64", "2.9.0"), "older");
		writeFileSync(agentCachePath(cacheDir, "linux", "arm64", "2.10.0"), "newer");

		const snapshot = await computeTargetStatus({
			cacheDir,
			hubVersion: "3.0.0",
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => BUNDLED_PATH,
			versionReader: () => HUB_VERSION,
		});

		const stale = targetRow(snapshot, "linux", "arm64");
		expect(stale.status).toBe("stale");
		expect(stale.version).toBe("2.10.0");
	});
});

async function baseSnapshot(cacheDir: string) {
	return computeTargetStatus({
		cacheDir,
		hubVersion: HUB_VERSION,
		hubPlatform: HUB_PLATFORM,
		resolveAgentBinaryPath: () => BUNDLED_PATH,
		versionReader: () => HUB_VERSION,
	});
}

function targetRow(
	snapshot: Awaited<ReturnType<typeof computeTargetStatus>>,
	os: AgentTargetOs,
	arch: AgentTargetArch,
) {
	const target = snapshot.targets.find((row) => row.os === os && row.arch === arch);
	expect(target).toBeDefined();
	return target!;
}

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lasterm-agent-status-"));
	chmodSync(dir, 0o700);
	tempDirs.push(dir);
	return dir;
}

function agentCachePath(
	cacheDir: string,
	osName: AgentTargetOs,
	arch: AgentTargetArch,
	version: string,
): string {
	const target = AGENT_TARGET_TABLE[osName][arch];
	return path.join(cacheDir, `lasterm-agent-${osName}-${arch}-${version}${target.ext}`);
}
