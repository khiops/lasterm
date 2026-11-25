import { describe, expect, it } from "vitest";
import {
	attachedChannel,
	breadcrumbOf,
	clampTransfersShare,
	entryLabel,
	type FollowFacts,
	filesPanelForm,
	followBlock,
	followBlockText,
	formatAttributes,
	formatMode,
	formatSize,
	joinPath,
	optionSource,
	optionsSummary,
	panelShowing,
	parentPath,
	pathStyleOf,
	readerChoiceAfter,
	type StatusFacts,
	scopeChoices,
	sourceLabel,
	statusLines,
	TRANSFERS_SHARE_DEFAULT,
	TRANSFERS_SHARE_MAX,
	typeAheadIndex,
	writerStatements,
} from "./files-panel.js";

// ─── Where the panel shows ───────────────────────────────────────────────────

describe("the panel's form", () => {
	const wide = { windowWidth: 1400, areaWidth: 1100, panelWidth: 300 };

	it("docks beside the panes while they keep 480 px", () => {
		expect(filesPanelForm({ ...wide, follows: false })).toBe("docked");
		expect(filesPanelForm({ ...wide, areaWidth: 780, follows: false })).toBe("docked");
	});

	it("floats over the panes when docking would leave them less than 480 px", () => {
		// The desktop's narrowest window: 56 + 200 + 544, the panel 300 wide.
		expect(
			filesPanelForm({ windowWidth: 800, areaWidth: 544, panelWidth: 300, follows: false }),
		).toBe("overlay");
		expect(filesPanelForm({ ...wide, areaWidth: 779, follows: false })).toBe("overlay");
	});

	// Docked, it would narrow every pane of the reader's tab, and that window would resize the
	// terminals it writes there for everyone (#838).
	it("floats when it only follows the writer's, so that it resizes nothing", () => {
		expect(filesPanelForm({ ...wide, follows: true })).toBe("overlay");
	});

	it("is a sheet over the terminal area below a 560 px window", () => {
		expect(
			filesPanelForm({ windowWidth: 559, areaWidth: 503, panelWidth: 300, follows: false }),
		).toBe("sheet");
		expect(
			filesPanelForm({ windowWidth: 390, areaWidth: 340, panelWidth: 300, follows: true }),
		).toBe("sheet");
	});
});

// ─── Whose panel it is (#838) ────────────────────────────────────────────────

describe("a reader's choice, per terminal", () => {
	const reader = { writes: false, ownOpen: false } as const;

	it("none: follows the writer's, floating, opening and closing with it", () => {
		expect(panelShowing({ ...reader, choice: "none", writerOpen: true })).toBe("follows");
		expect(panelShowing({ ...reader, choice: "none", writerOpen: false })).toBe("hidden");
		// The window's own panel, open elsewhere, changes nothing here.
		expect(panelShowing({ ...reader, ownOpen: true, choice: "none", writerOpen: false })).toBe(
			"hidden",
		);
	});

	it("closed: stays closed whatever the writer does", () => {
		expect(panelShowing({ ...reader, choice: "closed", writerOpen: true })).toBe("hidden");
		expect(panelShowing({ ...reader, choice: "closed", writerOpen: false })).toBe("hidden");
	});

	it("open: stays open, and docks, whatever the writer does", () => {
		expect(panelShowing({ ...reader, choice: "open", writerOpen: true })).toBe("own");
		expect(panelShowing({ ...reader, choice: "open", writerOpen: false })).toBe("own");
	});

	it("is what its gestures make it: opening follows an open writer's, else is its own", () => {
		expect(readerChoiceAfter("open", true)).toBe("none");
		expect(readerChoiceAfter("open", false)).toBe("open");
		expect(readerChoiceAfter("close", true)).toBe("closed");
		expect(readerChoiceAfter("close", false)).toBe("closed");
		// "Dock here" makes the writer's panel the reader's own.
		expect(readerChoiceAfter("dock", true)).toBe("open");
	});

	it("is not read in a window that writes the terminal, or with none attached", () => {
		for (const writes of [true, null]) {
			expect(panelShowing({ writes, ownOpen: true, choice: "closed", writerOpen: false })).toBe(
				"own",
			);
			expect(panelShowing({ writes, ownOpen: false, choice: "open", writerOpen: true })).toBe(
				"hidden",
			);
		}
	});
});

describe("what a writer's window tells the hub", () => {
	const hubHas =
		(...open: string[]) =>
		(id: string) =>
			open.includes(id);

	it("says its panel open on the terminal it is attached to, and nothing the hub has already", () => {
		expect(
			writerStatements({ written: ["A", "D"], attached: "A", ownOpen: true, hubOpen: hubHas() }),
		).toEqual([{ channelId: "A", open: true }]);
		expect(
			writerStatements({ written: ["A", "D"], attached: "A", ownOpen: true, hubOpen: hubHas("A") }),
		).toEqual([]);
	});

	it("closes it on A and opens it on B as it moves", () => {
		expect(
			writerStatements({ written: ["A", "B"], attached: "B", ownOpen: true, hubOpen: hubHas("A") }),
		).toEqual([
			{ channelId: "A", open: false },
			{ channelId: "B", open: true },
		]);
	});

	it("closes it where it was once closed, or attached to a terminal the window only reads", () => {
		expect(
			writerStatements({ written: ["A"], attached: "A", ownOpen: false, hubOpen: hubHas("A") }),
		).toEqual([{ channelId: "A", open: false }]);
		expect(
			writerStatements({ written: ["A"], attached: "R", ownOpen: true, hubOpen: hubHas("A") }),
		).toEqual([{ channelId: "A", open: false }]);
	});

	it("says nothing of a terminal it does not write", () => {
		expect(
			writerStatements({ written: [], attached: "R", ownOpen: true, hubOpen: hubHas() }),
		).toEqual([]);
	});
});

describe("the terminal the panel is attached to", () => {
	const inTabs =
		(...ids: string[]) =>
		(id: string) =>
			ids.includes(id);

	it("is the focused one, and moves with the focus", () => {
		expect(attachedChannel(null, "A", inTabs("A", "B"))).toBe("A");
		expect(attachedChannel(null, "B", inTabs("A", "B"))).toBe("B");
		expect(attachedChannel(null, null, inTabs("A"))).toBeNull();
	});

	it("stays on the pinned one, wherever the focus goes, while a tab shows it", () => {
		expect(attachedChannel("A", "B", inTabs("A", "B"))).toBe("A");
		expect(attachedChannel("A", null, inTabs("A"))).toBe("A");
		// Its tab closed: back to the focus.
		expect(attachedChannel("A", "B", inTabs("B"))).toBe("B");
	});
});

// ─── Paths ───────────────────────────────────────────────────────────────────

describe("a host's paths in the path bar", () => {
	it("reads the style from the host's OS, else from the path", () => {
		expect(pathStyleOf("windows", "/")).toBe("windows");
		expect(pathStyleOf("linux", "C:\\x")).toBe("posix");
		expect(pathStyleOf(null, "C:\\Users")).toBe("windows");
		expect(pathStyleOf(null, "\\\\nas\\share")).toBe("windows");
		expect(pathStyleOf(null, "/home/pi")).toBe("posix");
		expect(pathStyleOf(undefined, null)).toBe("posix");
	});

	it("splits a POSIX path into its folders from the root", () => {
		expect(breadcrumbOf("/home/pi/src", "posix")).toEqual([
			{ label: "/", path: "/" },
			{ label: "home", path: "/home" },
			{ label: "pi", path: "/home/pi" },
			{ label: "src", path: "/home/pi/src" },
		]);
		expect(breadcrumbOf("/", "posix")).toEqual([{ label: "/", path: "/" }]);
	});

	it("splits a Windows path from the drives, a drive and a share", () => {
		expect(breadcrumbOf("C:\\Users\\pi", "windows")).toEqual([
			{ label: "Drives", path: "/" },
			{ label: "C:", path: "C:\\" },
			{ label: "Users", path: "C:\\Users" },
			{ label: "pi", path: "C:\\Users\\pi" },
		]);
		expect(breadcrumbOf("\\\\nas\\backup\\2026", "windows")).toEqual([
			{ label: "Drives", path: "/" },
			{ label: "\\\\nas\\backup", path: "\\\\nas\\backup" },
			{ label: "2026", path: "\\\\nas\\backup\\2026" },
		]);
		expect(breadcrumbOf("/", "windows")).toEqual([{ label: "Drives", path: "/" }]);
	});

	it("reads a WSL directory report as a share per distribution (#1196)", () => {
		const path = "\\\\wsl.localhost\\Ubuntu\\home\\me";
		expect(pathStyleOf("windows", path)).toBe("windows");
		expect(breadcrumbOf(path, "windows")).toEqual([
			{ label: "Drives", path: "/" },
			{ label: "\\\\wsl.localhost\\Ubuntu", path: "\\\\wsl.localhost\\Ubuntu" },
			{ label: "home", path: "\\\\wsl.localhost\\Ubuntu\\home" },
			{ label: "me", path: "\\\\wsl.localhost\\Ubuntu\\home\\me" },
		]);
		expect(parentPath(path, "windows")).toBe("\\\\wsl.localhost\\Ubuntu\\home");
		expect(joinPath(path, "src", "windows")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\src");
	});

	it("goes up to the folder above, and stops at the root or a share", () => {
		expect(parentPath("/home/pi", "posix")).toBe("/home");
		expect(parentPath("/home", "posix")).toBe("/");
		expect(parentPath("/", "posix")).toBeNull();
		expect(parentPath("C:\\Users", "windows")).toBe("C:\\");
		expect(parentPath("C:\\", "windows")).toBe("/");
		expect(parentPath("/", "windows")).toBeNull();
		expect(parentPath("\\\\nas\\backup\\x", "windows")).toBe("\\\\nas\\backup");
		expect(parentPath("\\\\nas\\backup", "windows")).toBeNull();
	});

	it("joins a name onto a folder as the host spells it", () => {
		expect(joinPath("/home/pi", "src", "posix")).toBe("/home/pi/src");
		expect(joinPath("/", "etc", "posix")).toBe("/etc");
		expect(joinPath("C:\\Users", "pi", "windows")).toBe("C:\\Users\\pi");
		expect(joinPath("C:\\", "Users", "windows")).toBe("C:\\Users");
		expect(joinPath("/", "D:", "windows")).toBe("D:\\");
	});
});

// ─── Rows ────────────────────────────────────────────────────────────────────

describe("a listing's rows", () => {
	const now = new Date("2026-11-06T12:00:00Z");

	it("gives sizes in words a person reads", () => {
		expect(formatSize(812)).toBe("812 B");
		expect(formatSize(4096)).toBe("4 KB");
		expect(formatSize(2.1 * 1024 * 1024)).toBe("2.1 MB");
		expect(formatSize(98 * 1024)).toBe("98 KB");
		expect(formatSize(null)).toBe("");
	});

	it("reads each row to a screen reader as what it is, its size and when it changed", () => {
		expect(
			entryLabel(
				{
					name: "src",
					kind: "directory",
					size: null,
					mtime: null,
					mode: null,
					attributes: null,
					owner: null,
					group: null,
				},
				now,
			),
		).toBe("folder src");
		expect(
			entryLabel(
				{
					name: "docs",
					kind: "symlink",
					size: 4,
					mtime: null,
					mode: null,
					attributes: null,
					owner: null,
					group: null,
					linkKind: "directory",
				},
				now,
			),
		).toBe("folder docs");
		const file = entryLabel(
			{
				name: "notes.md",
				kind: "file",
				size: 4096,
				mtime: "2026-10-30T10:00:00Z",
				mode: null,
				attributes: null,
				owner: null,
				group: null,
			},
			now,
		);
		expect(file).toMatch(/^file notes\.md, 4 KB, modified [^,]+$/);
		const known = entryLabel(
			{
				name: "notes.md",
				kind: "file",
				size: 4096,
				mtime: "2026-10-30T10:00:00Z",
				mode: 0o100644,
				attributes: null,
				owner: null,
				group: null,
			},
			now,
		);
		expect(known).toBe(`${file}, permissions -rw-r--r--`);
		const unix = entryLabel(
			{
				name: "notes.md",
				kind: "file",
				size: 4096,
				mtime: "2026-10-30T10:00:00Z",
				mode: 0o100644,
				attributes: null,
				owner: "o",
				group: "g",
			},
			now,
		);
		expect(unix).toBe(`${file}, permissions -rw-r--r--, owner o, group g`);
		const windows = entryLabel(
			{
				name: "notes.md",
				kind: "file",
				size: 4096,
				mtime: "2026-10-30T10:00:00Z",
				mode: null,
				attributes: 0x20,
				owner: "D\\o",
				group: null,
			},
			now,
		);
		expect(windows).toBe(`${file}, attributes -a----, owner D\\o`);
	});

	it("spells Windows attributes as PowerShell's Mode", () => {
		const spelt: [number | null, string][] = [
			[0x10, "d-----"],
			[0x20, "-a----"],
			[0x21, "-ar---"],
			[0x22, "-a-h--"],
			[0x24, "-a--s-"],
			[0x80, "------"],
			[0x410, "d----l"],
			[0x420, "-a---l"],
			[0x37, "darhs-"],
			[0x180020, "-a----"],
			[null, ""],
		];
		for (const [attributes, letters] of spelt) {
			expect(formatAttributes(attributes), String(attributes)).toBe(letters);
		}
	});

	it("spells a mode as ls -l does", () => {
		const spelt: [number | null, string][] = [
			[0o40755, "drwxr-xr-x"],
			[0o104755, "-rwsr-xr-x"],
			[0o102640, "-rw-r-S---"],
			[0o120777, "lrwxrwxrwx"],
			[0o10644, "prw-r--r--"],
			[0o41777, "drwxrwxrwt"],
			[0o41776, "drwxrwxrwT"],
			[0o104644, "-rwSr--r--"],
			[0o42755, "drwxr-sr-x"],
			[0o20620, "crw--w----"],
			[0o60660, "brw-rw----"],
			[0o140755, "srwxr-xr-x"],
			[0o644, "?rw-r--r--"],
			[0o100444, "-r--r--r--"],
			[0o100000, "----------"],
			[null, ""],
		];
		for (const [mode, text] of spelt) expect([mode, formatMode(mode)]).toEqual([mode, text]);
	});

	it("jumps to the next row whose name starts with what is typed", () => {
		const names = ["crates", "docs", "Cargo.toml", "CLAUDE.md", "packages"];
		expect(typeAheadIndex(names, 0, "c")).toBe(2);
		expect(typeAheadIndex(names, 2, "c")).toBe(3);
		expect(typeAheadIndex(names, 3, "c")).toBe(0);
		expect(typeAheadIndex(names, 0, "pa")).toBe(4);
		expect(typeAheadIndex(names, 2, "ca")).toBe(2);
		expect(typeAheadIndex(names, 0, "z")).toBeNull();
	});
});

// ─── The status line ─────────────────────────────────────────────────────────

describe("the status line", () => {
	const base: StatusFacts = {
		following: true,
		live: undefined,
		shown: null,
		start: undefined,
		fallbackProblem: undefined,
		hostLabel: "raspberrypi",
		shell: undefined,
		sftpUnavailable: false,
		agentUpdatable: true,
	};
	const texts = (facts: Partial<StatusFacts>) =>
		statusLines({ ...base, ...facts }).map((l) => l.text);

	it("says it follows the terminal while it shows its directory", () => {
		const live = { cwd: "/home/pi/src", source: "process" as const, atPrompt: true };
		expect(texts({ live, shown: "/home/pi/src" })).toEqual(["Following the terminal"]);
	});

	// Browsing away pauses following: the line says where the terminal is, with "Go there".
	it("names where the terminal is, with Go there, once browsing paused following", () => {
		const live = { cwd: "/home/pi/src", source: "process" as const };
		const [line] = statusLines({ ...base, following: false, live, shown: "/var/log" });
		expect(line).toMatchObject({ text: "Terminal is in", path: "/home/pi/src", goThere: true });
	});

	it("names no menu entry where the host's menu has no Update agent", () => {
		expect(texts({ agentUpdatable: false })).toEqual(["This terminal's directory is not known"]);
	});

	it("says why it cannot follow, and where it opened instead", () => {
		// No agent ever said a directory: one that does not report it.
		expect(texts({ start: "fallback" })).toEqual([
			"Update the agent on raspberrypi (host menu › Update agent) to follow this terminal's directory",
			"Showing the folder set for unknown directories",
		]);
		const unknown = { cwd: null, source: "process" as const };
		expect(texts({ live: unknown, shell: "pwsh.exe", start: "home" })).toEqual([
			"PowerShell does not tell other programs its directory",
			"Showing the home folder",
		]);
		expect(texts({ live: unknown, shell: "bash", start: "home" })[0]).toBe(
			"Can't follow this shell's directory",
		);
	});

	it("says WSL does not tell its directory", () => {
		const unknown = { cwd: null, source: "process" as const };
		expect(texts({ live: unknown, shell: "wsl.exe" })).toEqual([
			"WSL does not tell other programs its directory",
		]);
	});

	it("says what the hub said of a fallback folder it could not open", () => {
		const lines = statusLines({
			...base,
			start: "home",
			fallbackProblem: "The fallback folder /srv/drop cannot be opened: it does not exist",
		});
		expect(lines.at(-1)).toMatchObject({ id: "fallback", tone: "warn" });
	});

	it("says ssh holds the terminal, a nested host, and a host without SFTP", () => {
		const ssh = { cwd: "/home/pi", source: "process" as const, atPrompt: false, foreground: "ssh" };
		expect(texts({ live: ssh, shown: "/home/pi" })).toContain(
			"ssh is running in this terminal: showing the shell's directory",
		);
		const nested = { cwd: null, source: "shell" as const, otherHost: "db01" };
		expect(texts({ live: nested })[0]).toBe(
			"This terminal shows db01; these are the files of raspberrypi",
		);
		expect(texts({ sftpUnavailable: true })).toContain(
			"Over SSH commands: this server offers no SFTP",
		);
	});
});

// ─── Where Follow cannot work ────────────────────────────────────────────────

describe("why Follow is disabled (#1196)", () => {
	const none = { cwd: null, source: "process" as const };
	const facts = (over: Partial<FollowFacts>): FollowFacts => ({
		live: none,
		program: "bash",
		hostOs: "linux",
		agentUpdatable: false,
		...over,
	});

	it("blocks PowerShell on any host until it reports", () => {
		expect(followBlock(facts({ program: "pwsh" }))).toBe("powershell");
		expect(followBlock(facts({ program: "C:\\Windows\\powershell.exe", hostOs: "windows" }))).toBe(
			"powershell",
		);
	});

	it("blocks WSL and any other program the agent does not read on a Windows host, not cmd", () => {
		expect(followBlock(facts({ program: "wsl.exe", hostOs: "windows" }))).toBe("wsl");
		expect(followBlock(facts({ program: "bash.exe", hostOs: "windows" }))).toBe("unread");
		expect(followBlock(facts({ program: "cmd.exe", hostOs: "windows" }))).toBeNull();
		expect(followBlock(facts({ program: "zsh", hostOs: "linux" }))).toBeNull();
	});

	it("blocks an older agent that never said a directory", () => {
		expect(followBlock(facts({ live: undefined, agentUpdatable: true }))).toBe("agent");
		expect(followBlock(facts({ live: undefined, agentUpdatable: false }))).toBeNull();
	});

	it("never blocks a program the agent reads for a null directory", () => {
		expect(followBlock(facts({ program: "bash", live: none }))).toBeNull();
		expect(followBlock(facts({ program: "cmd.exe", hostOs: "windows", live: none }))).toBeNull();
		expect(followBlock(facts({ program: undefined, hostOs: "windows" }))).toBeNull();
	});

	it("lifts as soon as a directory is reported or read, or a nested host is named", () => {
		const reported = { cwd: "C:\\Users\\me", source: "shell" as const };
		expect(followBlock(facts({ program: "pwsh", live: reported }))).toBeNull();
		expect(
			followBlock(facts({ program: "wsl.exe", hostOs: "windows", live: reported })),
		).toBeNull();
		const nested = { cwd: null, source: "shell" as const, otherHost: "db01" };
		expect(followBlock(facts({ program: "pwsh", live: nested }))).toBeNull();
	});

	it("tells what makes each work", () => {
		expect(followBlockText("agent", "pi")).toContain("host menu › Update agent");
		expect(followBlockText("powershell", "pc")).toContain("Report its directory");
		expect(followBlockText("powershell", "pc")).toContain("report-directory.ps1");
		expect(followBlockText("wsl", "pc")).toContain("wslpath -w");
		expect(followBlockText("unread", "pc")).toContain("OSC 9;9");
	});
});

// ─── Options ─────────────────────────────────────────────────────────────────

describe("the Options section", () => {
	it("says where each value comes from: this terminal, the host, or everywhere", () => {
		const layers = {
			global: { transferOnConflict: "skip" as const },
			host: { transferFollowCwd: false },
			channel: { transferConfirmDrop: false },
		};
		expect(optionSource(layers, "transferConfirmDrop")).toBe("terminal");
		expect(optionSource(layers, "transferFollowCwd")).toBe("host");
		expect(optionSource(layers, "transferOnConflict")).toBe("everywhere");
		// The built-in default holds everywhere.
		expect(optionSource(layers, "transferVerify")).toBe("everywhere");
		expect(optionSource({ host: { transferVerify: null } as never }, "transferVerify")).toBe(
			"everywhere",
		);
		expect(sourceLabel("host", "nas")).toBe("nas");
		expect(sourceLabel("terminal", "nas")).toBe("this terminal");
		expect(sourceLabel("everywhere", "nas")).toBe("everywhere");
	});

	it("names the effective values in one line when collapsed, Verify only without SFTP", () => {
		expect(
			optionsSummary({ onConflict: "ask", followCwd: true, verify: true, verifyApplies: false }),
		).toBe("Options · Ask if a file exists · Following");
		expect(
			optionsSummary({
				onConflict: "keep_both",
				followCwd: true,
				verify: true,
				verifyApplies: true,
			}),
		).toBe("Options · Keep both · Following · Verify");
		expect(
			optionsSummary({ onConflict: "skip", followCwd: false, verify: false, verifyApplies: true }),
		).toBe("Options · Skip existing files · Not following");
	});

	// The question says it first when Everywhere would drop the host's or the terminal's value.
	it("offers this host and everywhere, saying what each would drop", () => {
		const target = { hostId: "H", channelId: "C" };
		const choices = scopeChoices(
			"transferFollowCwd",
			false,
			target,
			{ host: { transferFollowCwd: true }, channel: {} },
			"nas",
		);
		expect(choices).toEqual([
			{ scope: "host", label: "nas", drops: null },
			{
				scope: "global",
				label: "Everywhere",
				drops: "Everywhere also drops nas's own value (On).",
			},
		]);
		const both = scopeChoices(
			"transferOnConflict",
			"replace",
			target,
			{ host: { transferOnConflict: "skip" }, channel: { transferOnConflict: "ask" } },
			"nas",
		);
		expect(both[0]?.drops).toBe("nas also drops this terminal's own value (Ask).");
		expect(both[1]?.drops).toBe(
			"Everywhere also drops nas's own value (Skip) and this terminal's own value (Ask).",
		);
		// A host-only key has no terminal value to drop.
		expect(
			scopeChoices("transferVerify", false, target, { channel: { transferVerify: true } }, "nas")[0]
				?.drops,
		).toBeNull();
		// Without a host, only everywhere.
		expect(
			scopeChoices("transferVerify", false, { hostId: null, channelId: null }, {}, "nas").map(
				(choice) => choice.scope,
			),
		).toEqual(["global"]);
	});
});

// ─── Transfers ───────────────────────────────────────────────────────────────

describe("the split between Files and Transfers", () => {
	it("never gives Transfers more than 70 % of the panel", () => {
		expect(clampTransfersShare(0.9)).toBe(TRANSFERS_SHARE_MAX);
		expect(TRANSFERS_SHARE_MAX).toBe(0.7);
		expect(clampTransfersShare(0.4)).toBe(0.4);
		expect(clampTransfersShare(Number.NaN)).toBe(TRANSFERS_SHARE_DEFAULT);
	});
});
