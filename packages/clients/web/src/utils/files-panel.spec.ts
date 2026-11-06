import { describe, expect, it } from "vitest";
import {
	attachedChannel,
	breadcrumbOf,
	clampTransfersShare,
	entryLabel,
	filesPanelForm,
	formatSize,
	joinPath,
	optionSource,
	optionsSummary,
	parentPath,
	pathStyleOf,
	type StatusFacts,
	scopeChoices,
	sourceLabel,
	statusLines,
	TRANSFERS_SHARE_DEFAULT,
	TRANSFERS_SHARE_MAX,
	typeAheadIndex,
} from "./files-panel.js";

// ─── Where the panel shows ───────────────────────────────────────────────────

describe("the panel's form", () => {
	const wide = { windowWidth: 1400, areaWidth: 1100, panelWidth: 300 };

	it("docks beside the panes while they keep 480 px", () => {
		expect(filesPanelForm({ ...wide, writesAttached: true })).toBe("docked");
		expect(filesPanelForm({ ...wide, areaWidth: 780, writesAttached: true })).toBe("docked");
		// With no terminal attached (an empty pane), nothing of its own to resize either.
		expect(filesPanelForm({ ...wide, writesAttached: null })).toBe("docked");
	});

	it("floats over the panes when docking would leave them less than 480 px", () => {
		// The desktop's narrowest window: 56 + 200 + 544, the panel 300 wide.
		expect(
			filesPanelForm({ windowWidth: 800, areaWidth: 544, panelWidth: 300, writesAttached: true }),
		).toBe("overlay");
		expect(filesPanelForm({ ...wide, areaWidth: 779, writesAttached: true })).toBe("overlay");
	});

	// Until the writer's panel reaches the readers (#838): docking narrows every pane of the tab,
	// and the window would resize the terminals it writes there for everyone.
	it("floats in a window that only reads the attached terminal, so that it resizes nothing", () => {
		expect(filesPanelForm({ ...wide, writesAttached: false })).toBe("overlay");
	});

	it("is a sheet over the terminal area below a 560 px window", () => {
		expect(
			filesPanelForm({ windowWidth: 559, areaWidth: 503, panelWidth: 300, writesAttached: true }),
		).toBe("sheet");
		expect(
			filesPanelForm({ windowWidth: 390, areaWidth: 340, panelWidth: 300, writesAttached: false }),
		).toBe("sheet");
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

describe("the split between Files and Transfers", () => {
	it("never gives Transfers more than 70 % of the panel", () => {
		expect(clampTransfersShare(0.9)).toBe(TRANSFERS_SHARE_MAX);
		expect(TRANSFERS_SHARE_MAX).toBe(0.7);
		expect(clampTransfersShare(0.4)).toBe(0.4);
		expect(clampTransfersShare(Number.NaN)).toBe(TRANSFERS_SHARE_DEFAULT);
	});
});
