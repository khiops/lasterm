/**
 * release-assets.spec.ts
 *
 * Tests for scripts/release-assets.ts: resolving a build's artifacts into the
 * exact set of release assets, and the container checks on each artifact's tar.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checksumsName,
	extractArtifacts,
	globToRegExp,
	HUB_ADDONS,
	type Matrix,
	resolveReleaseAssets,
	zipArchive,
} from "./release-assets.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MATRIX = JSON.parse(
	readFileSync(join(ROOT, ".github", "build-matrix.json"), "utf8"),
) as Matrix;

/** The release artifacts the current matrix's producers write. */
function releaseContents(): Map<string, string[]> {
	return new Map([
		["agent-x86_64-unknown-linux-gnu", ["lasterm-agent"]],
		["agent-aarch64-unknown-linux-gnu", ["lasterm-agent"]],
		["agent-x86_64-pc-windows-msvc", ["lasterm-agent.exe"]],
		[
			"hub-x86_64-pc-windows-msvc",
			["lasterm-hub.exe", "lasterm_hub_lock.node", "lasterm_tls_identity.node"],
		],
	]);
}

function installerMatrix(): Matrix {
	return {
		targets: [
			{
				triple: "x86_64-pc-windows-msvc",
				os: "windows",
				enabled: true,
				desktop: true,
				artifacts: {
					bundles: ["nsis", "msi"],
					desktop: ["Lasterm_{version}_x64-setup.exe", "Lasterm_{version}_x64_*.msi"],
				},
			},
		],
	};
}

function installerContents(files: string[]): Map<string, string[]> {
	return new Map([["desktop-x86_64-pc-windows-msvc", files]]);
}

describe("resolveReleaseAssets", () => {
	it("resolves the current matrix to exactly the Store-only release assets", () => {
		const { assets, errors } = resolveReleaseAssets(MATRIX, "0.10.1", releaseContents());
		expect(errors).toEqual([]);
		// SHA256SUMS is written by publish-release from the agent assets below.
		expect([...assets.map((a) => a.asset), checksumsName("0.10.1")].sort()).toEqual(
			[
				"SHA256SUMS-0.10.1.txt",
				"lasterm-agent-aarch64-unknown-linux-gnu-0.10.1",
				"lasterm-agent-x86_64-pc-windows-msvc-0.10.1.exe",
				"lasterm-agent-x86_64-unknown-linux-gnu-0.10.1",
				"lasterm-hub-x86_64-pc-windows-msvc.zip",
			].sort(),
		);
	});

	it("publishes the hub as one zip of the executable and its addons, executable first", () => {
		const { assets, errors } = resolveReleaseAssets(MATRIX, "0.10.1", releaseContents());
		expect(errors).toEqual([]);
		expect(assets.find((a) => a.kind === "hub")).toEqual({
			kind: "hub",
			triple: "x86_64-pc-windows-msvc",
			artifact: "hub-x86_64-pc-windows-msvc",
			file: "lasterm-hub-x86_64-pc-windows-msvc.zip",
			asset: "lasterm-hub-x86_64-pc-windows-msvc.zip",
			members: ["lasterm-hub.exe", ...HUB_ADDONS],
		});
	});

	it("refuses a hub artifact missing an addon, or carrying anything more", () => {
		const missing = releaseContents();
		missing.set("hub-x86_64-pc-windows-msvc", ["lasterm-hub.exe", "lasterm_hub_lock.node"]);
		expect(resolveReleaseAssets(MATRIX, "0.10.1", missing).errors).toEqual([
			'hub-x86_64-pc-windows-msvc: expected exactly "lasterm-hub.exe", "lasterm_hub_lock.node", "lasterm_tls_identity.node", found "lasterm-hub.exe", "lasterm_hub_lock.node"',
		]);
		const more = releaseContents();
		more.set("hub-x86_64-pc-windows-msvc", [
			"addons.json",
			"lasterm-hub.exe",
			"lasterm_hub_lock.node",
			"lasterm_tls_identity.node",
		]);
		expect(resolveReleaseAssets(MATRIX, "0.10.1", more).errors).toHaveLength(1);
	});

	it("refuses an MSIX workflow artifact so it cannot reach a release", () => {
		const contents = releaseContents();
		contents.set("msix-x86_64-pc-windows-msvc", ["Lasterm_0.10.1.0_x64.msix"]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", contents);
		expect(errors).toEqual([
			'unexpected artifact "msix-x86_64-pc-windows-msvc": no enabled target produces it',
		]);
	});

	it("reports a missing artifact and one no enabled target produces", () => {
		const contents = releaseContents();
		contents.delete("agent-aarch64-unknown-linux-gnu");
		contents.set("hub-x86_64-unknown-linux-gnu", ["lasterm-hub"]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", contents);
		expect(errors).toContain(
			'missing artifact "agent-aarch64-unknown-linux-gnu" for the agent of aarch64-unknown-linux-gnu',
		);
		expect(errors).toContain(
			'unexpected artifact "hub-x86_64-unknown-linux-gnu": no enabled target produces it',
		);
	});

	it("requires the executable's own name, so a bare name on Windows is refused", () => {
		const contents = releaseContents();
		// The shape MSYS fabricated for 0.10.0: `lasterm-hub` next to `lasterm-hub.exe`.
		contents.set("hub-x86_64-pc-windows-msvc", [
			"lasterm-hub",
			"lasterm-hub.exe",
			"lasterm_hub_lock.node",
			"lasterm_tls_identity.node",
		]);
		contents.set("agent-x86_64-pc-windows-msvc", ["lasterm-agent"]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", contents);
		expect(errors).toEqual([
			'agent-x86_64-pc-windows-msvc: expected exactly "lasterm-agent.exe", found "lasterm-agent"',
			'hub-x86_64-pc-windows-msvc: expected exactly "lasterm-hub.exe", "lasterm_hub_lock.node", "lasterm_tls_identity.node", found "lasterm-hub", "lasterm-hub.exe", "lasterm_hub_lock.node", "lasterm_tls_identity.node"',
		]);
	});

	it("refuses a desktop file no declaration names, such as an updater signature", () => {
		const { errors } = resolveReleaseAssets(
			installerMatrix(),
			"0.10.1",
			installerContents([
				"Lasterm_0.10.1_x64-setup.exe",
				"Lasterm_0.10.1_x64-setup.exe.sig",
				"Lasterm_0.10.1_x64_en-US.msi",
			]),
		);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: "Lasterm_0.10.1_x64-setup.exe.sig" matches no artifacts.desktop declaration; declared: "Lasterm_0.10.1_x64-setup.exe", "Lasterm_0.10.1_x64_*.msi"',
		]);
	});

	it("refuses a declaration that matches nothing, or more than one file", () => {
		const { errors } = resolveReleaseAssets(
			installerMatrix(),
			"0.10.1",
			installerContents(["Lasterm_0.10.1_x64_en-US.msi", "Lasterm_0.10.1_x64_fr-FR.msi"]),
		);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop[0] "Lasterm_0.10.1_x64-setup.exe" matched no file; candidates: "Lasterm_0.10.1_x64_en-US.msi", "Lasterm_0.10.1_x64_fr-FR.msi"',
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop[1] "Lasterm_0.10.1_x64_*.msi" matched more than one file: "Lasterm_0.10.1_x64_en-US.msi", "Lasterm_0.10.1_x64_fr-FR.msi"',
		]);
	});

	it("refuses two declarations resolving to the same file", () => {
		const matrix = installerMatrix();
		const windows = matrix.targets[0];
		if (!windows?.artifacts) throw new Error("the matrix has no Windows artifacts");
		windows.artifacts.desktop = ["Lasterm_{version}_x64*", "Lasterm_{version}_x64-setup.exe"];
		const { errors } = resolveReleaseAssets(
			matrix,
			"0.10.1",
			installerContents(["Lasterm_0.10.1_x64-setup.exe"]),
		);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop "Lasterm_0.10.1_x64*" and "Lasterm_0.10.1_x64-setup.exe" both matched "Lasterm_0.10.1_x64-setup.exe"',
		]);
	});

	it("shows a trailing CR in a declaration instead of silently matching nothing", () => {
		const matrix = structuredClone(MATRIX);
		const windows = matrix.targets.find((t) => t.triple === "x86_64-pc-windows-msvc");
		if (!windows?.artifacts) throw new Error("the matrix has no Windows artifacts");
		windows.artifacts.hub = ["lasterm-hub-x86_64-pc-windows-msvc.zip\r"];
		const { errors } = resolveReleaseAssets(matrix, "0.10.1", releaseContents());
		expect(errors[0]).toContain('"lasterm-hub-x86_64-pc-windows-msvc.zip\\r" matched no file');
	});

	it("refuses bracket expressions rather than giving them a meaning", () => {
		const matrix = installerMatrix();
		const windows = matrix.targets[0];
		if (!windows?.artifacts) throw new Error("the matrix has no Windows artifacts");
		windows.artifacts.desktop = ["Lasterm_{version}.[0-9]_x64.msix"];
		const { errors } = resolveReleaseAssets(
			matrix,
			"0.10.1",
			installerContents(["Lasterm_0.10.1.0_x64.msix"]),
		);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop[0] "Lasterm_{version}.[0-9]_x64.msix" uses a bracket expression, which this resolver does not support',
		]);
	});

	it("refuses two deliverables with one public name", () => {
		const matrix: Matrix = {
			targets: [
				{
					triple: "x86_64-unknown-linux-gnu",
					os: "linux",
					enabled: true,
					desktop: true,
					artifacts: { bundles: ["deb"], desktop: ["lasterm_{version}_amd64.deb"] },
				},
				{
					triple: "x86_64-unknown-linux-musl",
					os: "linux",
					enabled: true,
					desktop: true,
					artifacts: { bundles: ["deb"], desktop: ["lasterm_{version}_amd64.deb"] },
				},
			],
		};
		const contents = new Map([
			["desktop-x86_64-unknown-linux-gnu", ["lasterm_1.0.0_amd64.deb"]],
			["desktop-x86_64-unknown-linux-musl", ["lasterm_1.0.0_amd64.deb"]],
		]);
		const { errors } = resolveReleaseAssets(matrix, "1.0.0", contents);
		expect(errors).toEqual([
			'"lasterm_1.0.0_amd64.deb" is produced by both desktop-x86_64-unknown-linux-gnu and desktop-x86_64-unknown-linux-musl',
		]);
	});
});

describe("globToRegExp", () => {
	it("gives * and ? their glob meaning and keeps every other character literal", () => {
		expect(globToRegExp("a*b").test("a-anything-b")).toBe(true);
		expect(globToRegExp("a?b").test("axb")).toBe(true);
		expect(globToRegExp("a?b").test("ab")).toBe(false);
		expect(globToRegExp("1.0.0+build").test("1.0.0+build")).toBe(true);
		expect(globToRegExp("1.0.0").test("1x0y0")).toBe(false);
		expect(globToRegExp("(x)|y").test("(x)|y")).toBe(true);
		expect(globToRegExp("x").test("xx")).toBe(false);
	});
});

/** A zip read back by the format alone: every entry, from its central directory. */
function readZip(zip: Buffer): { name: string; data: Buffer; mode: number }[] {
	const end = zip.length - 22;
	expect(zip.readUInt32LE(end)).toBe(0x06054b50);
	const count = zip.readUInt16LE(end + 10);
	let at = zip.readUInt32LE(end + 16);
	const entries: { name: string; data: Buffer; mode: number }[] = [];
	for (let i = 0; i < count; i++) {
		expect(zip.readUInt32LE(at)).toBe(0x02014b50);
		const crc = zip.readUInt32LE(at + 16);
		const compressedSize = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLength = zip.readUInt16LE(at + 28);
		const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
		const mode = (zip.readUInt32LE(at + 38) >>> 16) & 0o777;
		const local = zip.readUInt32LE(at + 42);
		const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		expect(zip.readUInt32LE(local)).toBe(0x04034b50);
		const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const data = inflateRawSync(zip.subarray(start, start + compressedSize));
		expect([name, data.length, crc32(data)]).toEqual([name, size, crc]);
		entries.push({ name, data, mode });
		at += 46 + nameLength + skip;
	}
	return entries;
}

describe("zipArchive", () => {
	const entries = [
		{ name: "lasterm-hub.exe", data: Buffer.from("MZ the executable ".repeat(4096)), mode: 0o755 },
		{ name: "lasterm_hub_lock.node", data: randomBytes(70_000), mode: 0o644 },
		{ name: "lasterm_tls_identity.node", data: Buffer.alloc(0), mode: 0o644 },
	];

	let work: string;

	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), "lasterm-release-zip-"));
	});

	afterEach(() => {
		rmSync(work, { recursive: true, force: true });
	});

	it("holds each file, in order, with its bytes and its mode", () => {
		expect(readZip(zipArchive(entries))).toEqual(entries);
	});

	it("gives the same bytes for the same files", () => {
		expect(zipArchive(entries).equals(zipArchive(entries))).toBe(true);
	});

	it("is read by the system's own tools", (context) => {
		writeFileSync(join(work, "hub.zip"), zipArchive(entries));
		mkdirSync(join(work, "out"));
		// Windows' own tar is libarchive's, which reads zip; Git's GNU tar on PATH does not.
		const tool =
			process.platform === "win32"
				? {
						cmd: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
						args: ["-xf", "hub.zip", "-C", "out"],
					}
				: { cmd: "unzip", args: ["-q", "hub.zip", "-d", "out"] };
		const run = spawnSync(tool.cmd, tool.args, { cwd: work, encoding: "utf8" });
		if (run.error && (run.error as NodeJS.ErrnoException).code === "ENOENT") {
			context.skip(`${tool.cmd} is not installed`);
		}
		expect(run.status, run.stderr).toBe(0);
		for (const entry of entries) {
			expect(readFileSync(join(work, "out", entry.name))).toEqual(entry.data);
			if (process.platform !== "win32") {
				expect(statSync(join(work, "out", entry.name)).mode & 0o777).toBe(entry.mode);
			}
		}
	});
});

describe("extractArtifacts", () => {
	let work: string;

	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), "lasterm-release-assets-"));
	});

	afterEach(() => {
		rmSync(work, { recursive: true, force: true });
	});

	/**
	 * Write `files` into a fresh directory and pack it the way build.yml does:
	 * `tar -cf <name>.tar -C <staging> .`, with relative paths only.
	 */
	function packArtifact(name: string, files: Record<string, string>): void {
		const staging = join(work, "staging", name);
		for (const [file, body] of Object.entries(files)) {
			const path = join(staging, file);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, body);
		}
		const dir = join(work, "downloads", name);
		mkdirSync(dir, { recursive: true });
		const packed = spawnSync("tar", ["-cf", `${name}.tar`, "-C", `../../staging/${name}`, "."], {
			cwd: dir,
			encoding: "utf8",
		});
		if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`);
	}

	it("extracts a flat tar and lists its regular files", () => {
		packArtifact("desktop-x", { "b.msi": "msi", "a-setup.exe": "exe" });
		const { contents, errors } = extractArtifacts(join(work, "downloads"), join(work, "out"));
		expect(errors).toEqual([]);
		expect(contents.get("desktop-x")).toEqual(["a-setup.exe", "b.msi"]);
		expect(readFileSync(join(work, "out", "desktop-x", "b.msi"), "utf8")).toBe("msi");
	});

	it("extracts into a directory whose Windows path holds escape-like sequences", () => {
		// `\e` of `\extracted` and `\a` of `\agent-x` are escapes to the GNU tar
		// that Git puts on PATH on Windows, when it gets an absolute path from Node.
		packArtifact("agent-x", { "lasterm-agent": "agent" });
		const { contents, errors } = extractArtifacts(join(work, "downloads"), join(work, "extracted"));
		expect(errors).toEqual([]);
		expect(contents.get("agent-x")).toEqual(["lasterm-agent"]);
	});

	it("refuses a tar holding a nested entry, before extracting anything", () => {
		packArtifact("desktop-x", { "Lasterm.app/Contents/Info.plist": "plist" });
		const { contents, errors } = extractArtifacts(join(work, "downloads"), join(work, "out"));
		expect(contents.has("desktop-x")).toBe(false);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/^desktop-x: tar holds entries outside its top level: /);
	});

	it("refuses an artifact that is not exactly its own tar", () => {
		const dir = join(work, "downloads", "hub-x");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "lasterm-hub.exe"), "not a tar");
		const { errors } = extractArtifacts(join(work, "downloads"), join(work, "out"));
		expect(errors).toEqual(['hub-x: expected exactly "hub-x.tar", found "lasterm-hub.exe"']);
	});
});

describe("release-assets CLI", () => {
	let work: string;

	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), "lasterm-release-assets-cli-"));
	});

	afterEach(() => {
		rmSync(work, { recursive: true, force: true });
	});

	it("runs under plain node, with no dependency installed, and writes the manifest", () => {
		const matrix: Matrix = {
			targets: [{ triple: "x86_64-unknown-linux-gnu", os: "linux", enabled: true, agent: true }],
		};
		writeFileSync(join(work, "matrix.json"), JSON.stringify(matrix));
		mkdirSync(join(work, "staging"), { recursive: true });
		writeFileSync(join(work, "staging", "lasterm-agent"), "agent");
		const dir = join(work, "downloads", "agent-x86_64-unknown-linux-gnu");
		mkdirSync(dir, { recursive: true });
		const packed = spawnSync(
			"tar",
			["-cf", "agent-x86_64-unknown-linux-gnu.tar", "-C", "../../staging", "."],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(packed.status, packed.stderr).toBe(0);

		const run = spawnSync(
			process.execPath,
			[
				join(ROOT, "scripts", "release-assets.ts"),
				"--matrix",
				"matrix.json",
				"--version",
				"1.2.3",
				"--downloads",
				"downloads",
				"--extract-to",
				"extracted",
				"--out",
				"manifest.json",
			],
			{ cwd: work, encoding: "utf8" },
		);
		expect(run.status, run.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
		expect(manifest).toEqual([
			{
				kind: "agent",
				triple: "x86_64-unknown-linux-gnu",
				artifact: "agent-x86_64-unknown-linux-gnu",
				file: "lasterm-agent",
				asset: "lasterm-agent-x86_64-unknown-linux-gnu-1.2.3",
				path: join("extracted", "agent-x86_64-unknown-linux-gnu", "lasterm-agent"),
			},
		]);
	});

	it("writes the hub's zip from its artifact, and points the manifest at it", () => {
		const triple = "x86_64-pc-windows-msvc";
		const matrix: Matrix = {
			targets: [
				{
					triple,
					os: "windows",
					enabled: true,
					hub: true,
					artifacts: { hub: [`lasterm-hub-${triple}.zip`] },
				},
			],
		};
		writeFileSync(join(work, "matrix.json"), JSON.stringify(matrix));
		const files: Record<string, string> = {
			"lasterm-hub.exe": "the executable",
			"lasterm_hub_lock.node": "the hub lock",
			"lasterm_tls_identity.node": "the TLS identity",
		};
		mkdirSync(join(work, "staging"), { recursive: true });
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(work, "staging", name), body);
		}
		const dir = join(work, "downloads", `hub-${triple}`);
		mkdirSync(dir, { recursive: true });
		const packed = spawnSync("tar", ["-cf", `hub-${triple}.tar`, "-C", "../../staging", "."], {
			cwd: dir,
			encoding: "utf8",
		});
		expect(packed.status, packed.stderr).toBe(0);

		const run = spawnSync(
			process.execPath,
			[
				join(ROOT, "scripts", "release-assets.ts"),
				"--matrix",
				"matrix.json",
				"--version",
				"1.2.3",
				"--downloads",
				"downloads",
				"--extract-to",
				"extracted",
				"--out",
				"manifest.json",
			],
			{ cwd: work, encoding: "utf8" },
		);
		expect(run.status, run.stderr).toBe(0);
		const [asset, ...others] = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
		expect(others).toEqual([]);
		expect(asset).toMatchObject({
			kind: "hub",
			asset: `lasterm-hub-${triple}.zip`,
			path: join("extracted", `hub-${triple}`, `lasterm-hub-${triple}.zip`),
		});
		const zipped = readZip(readFileSync(join(work, asset.path)));
		expect(zipped.map((e) => [e.name, e.data.toString("utf8"), e.mode])).toEqual([
			["lasterm-hub.exe", "the executable", 0o755],
			["lasterm_hub_lock.node", "the hub lock", 0o644],
			["lasterm_tls_identity.node", "the TLS identity", 0o644],
		]);
	});

	it("exits 1 with a workflow error annotation when resolution fails", () => {
		writeFileSync(join(work, "matrix.json"), JSON.stringify({ targets: [] }));
		mkdirSync(join(work, "downloads", "agent-y"), { recursive: true });
		const run = spawnSync(
			process.execPath,
			[
				join(ROOT, "scripts", "release-assets.ts"),
				"--matrix",
				"matrix.json",
				"--version",
				"1.2.3",
				"--downloads",
				"downloads",
				"--extract-to",
				"extracted",
				"--out",
				"manifest.json",
			],
			{ cwd: work, encoding: "utf8" },
		);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('::error::agent-y: expected exactly "agent-y.tar", found (none)');
	});
});
