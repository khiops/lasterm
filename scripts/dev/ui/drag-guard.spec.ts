/**
 * drag-guard.spec.ts
 *
 * The decisions of scripts/dev/ui/drag-guard.cs, which drag-file.ps1 loads to keep
 * its real OLE drag honest about the user's mouse: when the drag may start, what
 * stops it, and what the harness reports. A physical mouse event cannot be faked
 * (every injected one carries LLMHF_INJECTED), so these decisions are what a test
 * can reach; the rest is drag-file.ps1 -SelfTest, on a desk.
 *
 * They run in Windows PowerShell, which compiles the file with the .NET
 * Framework's C# 5 compiler, as drag-file.ps1 does: a construct that compiler
 * refuses fails here, under this spec's name.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const GUARD = join(import.meta.dirname, "drag-guard.cs");

const INTERFERED = 3;
const TIMED_OUT = 4;

/** [what it shows, a PowerShell expression, its value as JSON gives it]. */
const CASES: [string, string, unknown][] = [
	["a device's event is physical", "[DragGuard]::IsPhysical(0)", true],
	["an injected event is not", "[DragGuard]::IsPhysical(1)", false],
	["nor one injected from a lower integrity level", "[DragGuard]::IsPhysical(3)", false],
	["a move is a move", "[DragGuard]::KindOf(0x200)", 0],
	["a left press is a left press", "[DragGuard]::KindOf(0x201)", 1],
	["a wheel turn is a wheel turn", "[DragGuard]::KindOf(0x20A)", 5],
	["no event is none", "[DragGuard]::DescribeCounts([int[]]@(0,0,0,0,0,0,0,0))", "none"],
	[
		"events are counted by kind",
		"[DragGuard]::DescribeCounts([int[]]@(62,1,1,0,0,0,0,0))",
		"64 (move 62, left down 1, left up 1)",
	],
	[
		"the drag starts once the hook has watched a still mouse for 2 s",
		"[DragGuard]::QuietVerdict(2500, 500, -1, 500, 2000, 30000)",
		"go",
	],
	[
		"but not before: nothing was seen before the hook",
		"[DragGuard]::QuietVerdict(1500, 500, -1, 500, 2000, 30000)",
		"wait",
	],
	[
		"a hand on the mouse 1 s ago holds it",
		"[DragGuard]::QuietVerdict(10000, 0, 9000, 5000, 2000, 30000)",
		"wait",
	],
	[
		"2 s after the hand left, it starts",
		"[DragGuard]::QuietVerdict(11000, 0, 9000, 5000, 2000, 30000)",
		"go",
	],
	[
		"a hand that never rests makes it give up after 30 s",
		"[DragGuard]::QuietVerdict(35000, 0, 34900, 5000, 2000, 30000)",
		"busy",
	],
	["a mover that finished says nothing", "[DragGuard]::MoverReason(0)", 0],
	["nor one still running", "[DragGuard]::MoverReason([DragGuard]::MoverRunning)", 0],
	["a mover that saw the cursor drift stops the drag", "[DragGuard]::MoverReason(3)", 2],
	["a mover that failed stops it too", "[DragGuard]::MoverReason(1)", 4],
	["and so does a mover killed", "[DragGuard]::MoverReason(-1)", 4],
	[
		"an undisturbed drag reports the target's answer",
		"[DragGuard]::Decide(0, 0, 0, '', 'Copy')",
		{ ExitCode: 0, Message: "drop effect: Copy" },
	],
	[
		"a physical event that stopped the drag discards it",
		"[DragGuard]::Decide(1, 1, -1, '', 'None')",
		{
			ExitCode: INTERFERED,
			Message: "interfered: physical mouse input during the drag; result discarded",
		},
	],
	[
		"so does one seen only after the drop",
		"[DragGuard]::Decide(0, 2, 0, '', 'Copy')",
		{
			ExitCode: INTERFERED,
			Message: "interfered: physical mouse input during the drag; result discarded",
		},
	],
	[
		"a drift says where the cursor was",
		"[DragGuard]::Decide(2, 0, 3, 'step 4: cursor at (1,2), expected (3,4)', 'None')",
		{
			ExitCode: INTERFERED,
			Message:
				"interfered: the cursor left the mover's path (step 4: cursor at (1,2), expected (3,4)); result discarded",
		},
	],
	[
		"a drift reported only by the mover's exit counts as well",
		"[DragGuard]::Decide(0, 0, 3, '', 'None')",
		{
			ExitCode: INTERFERED,
			Message: "interfered: the cursor left the mover's path; result discarded",
		},
	],
	[
		"a drag past its time is discarded with its own code",
		"[DragGuard]::Decide(3, 0, [DragGuard]::MoverRunning, '', 'None')",
		{ ExitCode: TIMED_OUT, Message: "drag timed out; result discarded" },
	],
	[
		"a mouse never at rest drags nothing",
		"[DragGuard]::Decide(5, 0, [DragGuard]::MoverRunning, '', '')",
		{ ExitCode: INTERFERED, Message: "busy: physical mouse in use; nothing was dragged" },
	],
	[
		"a failed mover is the harness's failure, with what it said",
		"[DragGuard]::Decide(0, 0, 1, 'mover failed: boom', 'None')",
		{ ExitCode: 1, Message: "the mouse mover failed (exit 1): mover failed: boom" },
	],
	[
		"the first reason to stop wins",
		"$([DragGuard]::BeginDrag(); [void][DragGuard]::StopFor(3); [void][DragGuard]::StopFor(1); [DragGuard]::Reason)",
		3,
	],
	[
		"the hook installs on its own thread and comes off again",
		"$([DragGuard]::Watch(); $q = [DragGuard]::Quiet([DragGuard]::NowMs, 2000, 30000); [DragGuard]::Unwatch(); $q)",
		"wait",
	],
];

/** Every case's value, from one Windows PowerShell that compiles the guard once. */
function evaluateCases(): unknown[] {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		`Add-Type -Path '${GUARD.replace(/'/g, "''")}'`,
		...CASES.map(
			([, expression]) =>
				`[Console]::WriteLine((ConvertTo-Json -Compress -InputObject (${expression})))`,
		),
	].join("\n");
	const run = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{ encoding: "utf8" },
	);
	const lines = run.stdout.split(/\r?\n/).filter((line) => line !== "");
	if (run.status !== 0 || lines.length !== CASES.length) {
		throw new Error(`powershell exited ${run.status}:\n${run.stdout}\n${run.stderr}`);
	}
	return lines.map((line) => JSON.parse(line));
}

function powershell(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const run = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
		{ encoding: "utf8", timeout: 60_000 },
	);
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe.runIf(process.platform === "win32")("drag-guard.cs", () => {
	let values: unknown[] = [];
	beforeAll(() => {
		values = evaluateCases();
	}, 60_000);

	it.each(
		CASES.map(([what, expression, expected], index) => ({ what, expression, expected, index })),
	)("$what", ({ expected, index }) => {
		expect(values[index]).toEqual(expected);
	});

	it("ends a drag the target never returns from, exiting 4, with nothing to release", () => {
		// No drag and no press: the watchdog finds nothing of the harness's to release,
		// and puts the cursor back where it already is. A reason already set spares the
		// nudge, so nothing moves.
		const script = [
			"$ErrorActionPreference = 'Stop'",
			`Add-Type -Path '${GUARD.replace(/'/g, "''")}'`,
			"[DragGuard]::UsePhysicalPixels()",
			"[void][DragGuard]::StopFor([DragGuard]::ReasonPhysical)",
			"$at = [DragGuard]::Cursor()",
			"[DragGuard]::Arm(50, 150, $at.X, $at.Y)",
			"Start-Sleep -Seconds 20",
			"exit 0",
		].join("\n");
		const run = powershell(["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
		expect(run.status, run.stderr).toBe(TIMED_OUT);
		expect(run.stdout.split(/\r?\n/)[0]).toBe(
			"drag timed out: DoDragDrop did not return; result discarded",
		);
	}, 60_000);
});

describe.runIf(process.platform === "win32")("drag-mover.ps1", () => {
	it("stops at once, moving and releasing nothing, when the cursor is not where it should be", () => {
		// A start point no cursor can be at: the first check fails before any move. Given
		// as drag-file.ps1 gives it, named with a colon, so that a negative one binds.
		const run = powershell([
			"-File",
			join(import.meta.dirname, "drag-mover.ps1"),
			"-FromX:-12345",
			"-FromY:-12345",
			"-ToX:-12000",
			"-ToY:-12000",
		]);
		expect(run.status, run.stderr).toBe(INTERFERED);
		expect(run.stdout).toMatch(
			/^step 0: cursor at \(-?\d+,-?\d+\), expected \(-12345,-12345\)\r?\n$/,
		);
	}, 60_000);
});
