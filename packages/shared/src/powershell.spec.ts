import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPowerShell, POWERSHELL_DIRECTORY_HELP_URL } from "./powershell.js";

/** A file of this repository, from its root. */
function repositoryFile(path: string): string {
	return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf-8");
}

/** The anchor GitHub gives a Markdown heading. */
function anchor(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s/g, "-");
}

describe("isPowerShell (#839)", () => {
	it("is true for pwsh and powershell, by file name, with or without .exe, in any case", () => {
		for (const shell of [
			"pwsh",
			"pwsh.exe",
			"PowerShell.EXE",
			"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			"C:/tools/pwsh.exe",
			"/usr/bin/pwsh",
		]) {
			expect(isPowerShell(shell), shell).toBe(true);
		}
	});

	it("is false for any other shell", () => {
		for (const shell of [
			"",
			"cmd.exe",
			"/bin/bash",
			"C:\\tools\\pwsh-preview.exe",
			"C:\\tools\\mypowershell.exe",
			"C:\\pwsh\\bash.exe",
			"pwsh.com",
		]) {
			expect(isPowerShell(shell), shell).toBe(false);
		}
	});
});

describe("the README's section on PowerShell's directory (#839)", () => {
	const readme = repositoryFile("README.md");

	it("is where the help link points", () => {
		const [page, fragment] = POWERSHELL_DIRECTORY_HELP_URL.split("#");
		expect(page).toBe("https://github.com/khiops/lasterm");
		const headings = readme
			.split("\n")
			.filter((line) => /^#{1,6} /.test(line))
			.map((line) => anchor(line.replace(/^#+ /, "")));
		expect(headings).toContain(fragment);
	});

	it("gives the very script the agent's switch runs, to paste into $PROFILE", () => {
		const script = repositoryFile("crates/lasterm-agent/src/report-directory.ps1");
		const blocks = [...readme.matchAll(/```powershell\n([\s\S]*?)```/g)].map((match) => match[1]);
		expect(blocks).toContain(script);
	});
});
