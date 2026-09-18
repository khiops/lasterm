/**
 * release-assets.spec.ts
 *
 * Tests for scripts/release-assets.ts: resolving a build's artifacts into the
 * exact set of release assets, and the container checks on each artifact's tar.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractArtifacts,
	globToRegExp,
	type Matrix,
	resolveReleaseAssets,
} from "./release-assets.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MATRIX = JSON.parse(
	readFileSync(join(ROOT, ".github", "build-matrix.json"), "utf8"),
) as Matrix;

/** What the v0.10.1 build wrote, per artifact, as seen in its logs and assets. */
function v0101Contents(): Map<string, string[]> {
	return new Map([
		["agent-x86_64-unknown-linux-gnu", ["lasterm-agent"]],
		["agent-aarch64-unknown-linux-gnu", ["lasterm-agent"]],
		["agent-x86_64-pc-windows-msvc", ["lasterm-agent.exe"]],
		["hub-x86_64-pc-windows-msvc", ["lasterm-hub.exe"]],
		[
			"desktop-x86_64-pc-windows-msvc",
			["Lasterm_0.10.1_x64-setup.exe", "Lasterm_0.10.1_x64_en-US.msi"],
		],
		["msix-x86_64-pc-windows-msvc", ["Lasterm_0.10.1.0_x64.msix"]],
	]);
}

describe("resolveReleaseAssets", () => {
	it("resolves the v0.10.1 build to exactly the assets v0.10.1 published", () => {
		const { assets, errors } = resolveReleaseAssets(MATRIX, "0.10.1", true, v0101Contents());
		expect(errors).toEqual([]);
		// The release as published, minus SHA256SUMS, which publish-release writes itself.
		expect(assets.map((a) => a.asset).sort()).toEqual(
			[
				"lasterm-agent-aarch64-unknown-linux-gnu-0.10.1",
				"lasterm-agent-x86_64-pc-windows-msvc-0.10.1.exe",
				"lasterm-agent-x86_64-unknown-linux-gnu-0.10.1",
				"lasterm-hub-x86_64-pc-windows-msvc.exe",
				"Lasterm_0.10.1.0_x64.msix",
				"Lasterm_0.10.1_x64-setup.exe",
				"Lasterm_0.10.1_x64_en-US.msi",
			].sort(),
		);
	});

	it("neither expects nor accepts an MSIX when publication is disabled", () => {
		const contents = v0101Contents();
		const withMsix = resolveReleaseAssets(MATRIX, "0.10.1", false, contents);
		expect(withMsix.errors).toEqual([
			'unexpected artifact "msix-x86_64-pc-windows-msvc": no enabled target produces it',
		]);
		contents.delete("msix-x86_64-pc-windows-msvc");
		const without = resolveReleaseAssets(MATRIX, "0.10.1", false, contents);
		expect(without.errors).toEqual([]);
		expect(without.assets.some((a) => a.kind === "msix")).toBe(false);
	});

	it("reports a missing artifact and one no enabled target produces", () => {
		const contents = v0101Contents();
		contents.delete("agent-aarch64-unknown-linux-gnu");
		contents.set("hub-x86_64-unknown-linux-gnu", ["lasterm-hub"]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", true, contents);
		expect(errors).toContain(
			'missing artifact "agent-aarch64-unknown-linux-gnu" for the agent of aarch64-unknown-linux-gnu',
		);
		expect(errors).toContain(
			'unexpected artifact "hub-x86_64-unknown-linux-gnu": no enabled target produces it',
		);
	});

	it("requires the executable's own name, so a bare name on Windows is refused", () => {
		const contents = v0101Contents();
		// The shape MSYS fabricated for 0.10.0: `lasterm-hub` next to `lasterm-hub.exe`.
		contents.set("hub-x86_64-pc-windows-msvc", ["lasterm-hub", "lasterm-hub.exe"]);
		contents.set("agent-x86_64-pc-windows-msvc", ["lasterm-agent"]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", true, contents);
		expect(errors).toEqual([
			'agent-x86_64-pc-windows-msvc: expected exactly "lasterm-agent.exe", found "lasterm-agent"',
			'hub-x86_64-pc-windows-msvc: expected exactly "lasterm-hub.exe", found "lasterm-hub", "lasterm-hub.exe"',
		]);
	});

	it("refuses a desktop file no declaration names, such as an updater signature", () => {
		const contents = v0101Contents();
		contents.set("desktop-x86_64-pc-windows-msvc", [
			"Lasterm_0.10.1_x64-setup.exe",
			"Lasterm_0.10.1_x64-setup.exe.sig",
			"Lasterm_0.10.1_x64_en-US.msi",
		]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", true, contents);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: "Lasterm_0.10.1_x64-setup.exe.sig" matches no artifacts.desktop declaration; declared: "Lasterm_0.10.1_x64-setup.exe", "Lasterm_0.10.1_x64_*.msi"',
		]);
	});

	it("refuses a declaration that matches nothing, or more than one file", () => {
		const contents = v0101Contents();
		contents.set("desktop-x86_64-pc-windows-msvc", [
			"Lasterm_0.10.1_x64_en-US.msi",
			"Lasterm_0.10.1_x64_fr-FR.msi",
		]);
		const { errors } = resolveReleaseAssets(MATRIX, "0.10.1", true, contents);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop[0] "Lasterm_0.10.1_x64-setup.exe" matched no file; candidates: "Lasterm_0.10.1_x64_en-US.msi", "Lasterm_0.10.1_x64_fr-FR.msi"',
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop[1] "Lasterm_0.10.1_x64_*.msi" matched more than one file: "Lasterm_0.10.1_x64_en-US.msi", "Lasterm_0.10.1_x64_fr-FR.msi"',
		]);
	});

	it("refuses two declarations resolving to the same file", () => {
		const matrix = structuredClone(MATRIX);
		const windows = matrix.targets.find((t) => t.triple === "x86_64-pc-windows-msvc");
		if (!windows?.artifacts) throw new Error("the matrix has no Windows artifacts");
		windows.artifacts.desktop = ["Lasterm_{version}_x64*", "Lasterm_{version}_x64-setup.exe"];
		const contents = v0101Contents();
		contents.set("desktop-x86_64-pc-windows-msvc", ["Lasterm_0.10.1_x64-setup.exe"]);
		const { errors } = resolveReleaseAssets(matrix, "0.10.1", true, contents);
		expect(errors).toEqual([
			'desktop-x86_64-pc-windows-msvc: artifacts.desktop "Lasterm_0.10.1_x64*" and "Lasterm_0.10.1_x64-setup.exe" both matched "Lasterm_0.10.1_x64-setup.exe"',
		]);
	});

	it("shows a trailing CR in a declaration instead of silently matching nothing", () => {
		const matrix = structuredClone(MATRIX);
		const windows = matrix.targets.find((t) => t.triple === "x86_64-pc-windows-msvc");
		if (!windows?.artifacts) throw new Error("the matrix has no Windows artifacts");
		windows.artifacts.hub = ["lasterm-hub-x86_64-pc-windows-msvc.exe\r"];
		const { errors } = resolveReleaseAssets(matrix, "0.10.1", true, v0101Contents());
		expect(errors[0]).toContain('"lasterm-hub-x86_64-pc-windows-msvc.exe\\r" matched no file');
	});

	it("refuses bracket expressions rather than giving them a meaning", () => {
		const matrix = structuredClone(MATRIX);
		const windows = matrix.targets.find((t) => t.triple === "x86_64-pc-windows-msvc");
		if (!windows?.artifacts) throw new Error("the matrix has no Windows artifacts");
		windows.artifacts.msix = ["Lasterm_{version}.[0-9]_x64.msix"];
		const { errors } = resolveReleaseAssets(matrix, "0.10.1", true, v0101Contents());
		expect(errors).toEqual([
			'msix-x86_64-pc-windows-msvc: artifacts.msix[0] "Lasterm_{version}.[0-9]_x64.msix" uses a bracket expression, which this resolver does not support',
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
					artifacts: { desktop: ["lasterm_{version}_amd64.deb"] },
				},
				{
					triple: "x86_64-unknown-linux-musl",
					os: "linux",
					enabled: true,
					desktop: true,
					artifacts: { desktop: ["lasterm_{version}_amd64.deb"] },
				},
			],
		};
		const contents = new Map([
			["desktop-x86_64-unknown-linux-gnu", ["lasterm_1.0.0_amd64.deb"]],
			["desktop-x86_64-unknown-linux-musl", ["lasterm_1.0.0_amd64.deb"]],
		]);
		const { errors } = resolveReleaseAssets(matrix, "1.0.0", false, contents);
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
				"--msix",
				"false",
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
				"--msix",
				"false",
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
