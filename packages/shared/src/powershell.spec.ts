import { describe, expect, it } from "vitest";
import { isPowerShell } from "./powershell.js";

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
