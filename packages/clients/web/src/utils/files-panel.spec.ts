import { describe, expect, it } from "vitest";
import {
	attachedChannel,
	breadcrumbOf,
	clampTransfersShare,
	entryLabel,
	filesPanelForm,
	formatSize,
	groupTransfers,
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
	type TransferEntry,
	transfersCount,
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
		expect(entryLabel({ name: "src", kind: "directory", size: null, mtime: null }, now)).toBe(
			"folder src",
		);
		expect(
			entryLabel(
				{ name: "docs", kind: "symlink", size: 4, mtime: null, linkKind: "directory" },
				now,
			),
		).toBe("folder docs");
		const file = entryLabel(
			{ name: "notes.md", kind: "file", size: 4096, mtime: "2026-10-30T10:00:00Z" },
			now,
		);
		expect(file).toMatch(/^file notes\.md, 4 KB, modified .+/);
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

	it("says why it cannot follow, and where it opened instead", () => {
		// No agent ever said a directory: one that does not report it.
		expect(texts({ start: "fallback" })).toEqual([
			"Update the agent on raspberrypi to follow this terminal's directory",
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

describe("the Transfers part's groups", () => {
	const upload = (
		id: string,
		hostId: string,
		channelId: string,
		state: TransferEntry["state"] = "running",
	) => ({
		id,
		hostId,
		channelId,
		state,
	});

	it("groups the window's uploads by host, then terminal, the focused terminal's first", () => {
		const entries = [
			upload("1", "AD", "a1", "failed"),
			upload("2", "RPI", "r1"),
			upload("3", "RPI", "r2"),
			upload("4", "AD", "a1", "done"),
		];
		const groups = groupTransfers(entries, "r2");
		expect(groups.map((group) => group.hostId)).toEqual(["RPI", "AD"]);
		expect(groups[0]?.focused).toBe(true);
		expect(groups[0]?.terminals.map((t) => t.channelId)).toEqual(["r2", "r1"]);
		expect(groups[1]?.terminals[0]?.transfers.map((t) => t.id)).toEqual(["1", "4"]);
		// A focus change reorders and removes nothing.
		const after = groupTransfers(entries, "a1");
		expect(after.map((group) => group.hostId)).toEqual(["AD", "RPI"]);
		expect(after.flatMap((g) => g.terminals.flatMap((t) => t.transfers)).length).toBe(4);
		expect(groupTransfers([], "a1")).toEqual([]);
	});

	it("counts what runs and fails for the header, a failure in the warning style", () => {
		expect(transfersCount([])).toEqual({ text: "none", warn: false });
		expect(
			transfersCount([
				upload("1", "A", "a", "running"),
				upload("2", "A", "a", "queued"),
				upload("3", "A", "a", "failed"),
				upload("4", "A", "a", "done"),
			]),
		).toEqual({ text: "2 running, 1 failed", warn: true });
	});

	it("never gives Transfers more than 70 % of the panel", () => {
		expect(clampTransfersShare(0.9)).toBe(TRANSFERS_SHARE_MAX);
		expect(TRANSFERS_SHARE_MAX).toBe(0.7);
		expect(clampTransfersShare(0.4)).toBe(0.4);
		expect(clampTransfersShare(Number.NaN)).toBe(TRANSFERS_SHARE_DEFAULT);
	});
});
