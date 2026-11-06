/**
 * The Files part's browser (#836): where it opens, following the terminal's directory (#834)
 * and pausing on any move, "Go there", the fallback folder the hub opens it at when the
 * directory is unknown, hidden files from the settings, the list's keys, and the new folder
 * that only the writer may create.
 */
import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { IWsClient } from "../../services/ws-client.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import type { FileEntryView } from "../../utils/files-panel.js";
import type { FileListingView, FilesAnswer } from "../../utils/host-files.js";
import FilesBrowser from "./FilesBrowser.vue";

const mocks = vi.hoisted(() => ({
	listHostFiles:
		vi.fn<
			(
				channelId: string,
				path: string | undefined,
				hidden: boolean,
			) => Promise<FilesAnswer<FileListingView>>
		>(),
	createHostFolder:
		vi.fn<(channelId: string, path: string) => Promise<FilesAnswer<{ path: string }>>>(),
}));

vi.mock("../../utils/host-files.js", () => ({
	listHostFiles: mocks.listHostFiles,
	createHostFolder: mocks.createHostFolder,
	HUB_UNREACHABLE: "HUB_UNREACHABLE",
}));

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

const folder = (name: string): FileEntryView => ({
	name,
	kind: "directory",
	size: null,
	mtime: null,
});
const file = (name: string): FileEntryView => ({ name, kind: "file", size: 10, mtime: null });

/** The host's folders, as the hub would list them. */
const TREE: Record<string, FileEntryView[]> = {
	"/home/pi": [folder("src"), folder("logs"), file("notes.md")],
	"/home/pi/src": [folder("lasterm"), file("todo.txt")],
	"/home/pi/src/lasterm": [file("Cargo.toml")],
	"/home/pi/logs": [],
	"/home": [folder("pi")],
	"/srv/drop": [file("in.txt")],
};

function listing(path: string | undefined): FilesAnswer<FileListingView> {
	if (path === undefined) {
		return {
			ok: true,
			value: {
				path: "/srv/drop",
				entries: TREE["/srv/drop"] ?? [],
				truncated: 0,
				start: "fallback",
			},
		};
	}
	const entries = TREE[path];
	if (entries === undefined)
		return {
			ok: false,
			code: "NOT_FOUND",
			message: "The folder could not be listed: it does not exist",
		};
	return { ok: true, value: { path, entries, truncated: 0 } };
}

let app: App | null = null;
let root: HTMLElement;
let sent: ProtocolMessage[];

interface Mounted {
	props: Record<string, unknown>;
}

function mountBrowser(overrides: Record<string, unknown> = {}): Mounted {
	const props = {
		channelId: A,
		hostId: "H",
		hostLabel: "raspberrypi",
		hostOs: "linux",
		writer: true,
		followByDefault: true,
		showHidden: false,
		sftpUnavailable: false,
		shell: "bash",
		tint: null,
		...overrides,
	};
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(FilesBrowser, props as never) });
	app.mount(root);
	return { props };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

const lastListed = (): unknown[] => mocks.listHostFiles.mock.calls.at(-1) ?? [];
const rows = (): string[] =>
	[...root.querySelectorAll(".files-row .files-row__name")].map((el) => el.textContent ?? "");
const status = (): string =>
	[...root.querySelectorAll(".files-status__line")]
		.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
		.join(" | ");
const followToggle = (): HTMLButtonElement =>
	root.querySelector<HTMLButtonElement>(".files-follow") as HTMLButtonElement;
const rowEl = (name: string): HTMLElement =>
	[...root.querySelectorAll<HTMLElement>(".files-row")].find(
		(row) => row.querySelector(".files-row__name")?.textContent === name,
	) as HTMLElement;

function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
	target.dispatchEvent(
		new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
	);
}

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	mocks.listHostFiles.mockReset();
	mocks.listHostFiles.mockImplementation(async (_channel: string, path: string | undefined) =>
		listing(path),
	);
	mocks.createHostFolder.mockReset();
	sent = [];
	useWriteLockStore().setWsClient({
		send: (msg: ProtocolMessage) => sent.push(msg),
	} as unknown as IWsClient);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

describe("where the panel opens", () => {
	// Without a live directory (#834 not there, or not said yet), the hub opens it at the host's
	// fallback folder, expanded there, else at the home (#836's fallback, hub side).
	it("asks the hub for its opening folder when the terminal's directory is unknown, and says why", async () => {
		mountBrowser();
		await settle();
		expect(lastListed()).toEqual([A, undefined, false]);
		expect(rows()).toEqual(["in.txt"]);
		expect(status()).toContain(
			"Update the agent on raspberrypi to follow this terminal's directory",
		);
		expect(status()).toContain("Showing the folder set for unknown directories");
		expect(followToggle().getAttribute("aria-pressed")).toBe("true");
	});

	it("says why a fallback folder the hub could not open was not used", async () => {
		mocks.listHostFiles.mockResolvedValueOnce({
			ok: true,
			value: {
				path: "/home/pi",
				entries: TREE["/home/pi"] ?? [],
				truncated: 0,
				start: "home",
				fallbackProblem: "The fallback folder /nope cannot be opened: it does not exist",
			},
		});
		mountBrowser();
		await settle();
		expect(status()).toContain("Showing the home folder");
		expect(status()).toContain("The fallback folder /nope cannot be opened: it does not exist");
	});

	it("lists hidden files when the settings say so", async () => {
		mountBrowser({ showHidden: true });
		await settle();
		expect(lastListed()).toEqual([A, undefined, true]);
	});
});

describe("following the terminal's directory", () => {
	it("opens at the terminal's directory and follows each cd", async () => {
		useFilesPanelStore().takeCwd({
			channelId: A,
			cwd: "/home/pi/src",
			source: "process",
			atPrompt: true,
		});
		mountBrowser();
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi/src", false]);
		expect(rows()).toEqual(["lasterm", "todo.txt"]);
		expect(status()).toBe("Following the terminal");
		useFilesPanelStore().takeCwd({ channelId: A, cwd: "/home/pi/logs", source: "process" });
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi/logs", false]);
		expect(root.querySelector(".files-note")?.textContent).toContain("This folder is empty.");
	});

	it("pauses on any move, says where the terminal is, and goes there again", async () => {
		const store = useFilesPanelStore();
		store.takeCwd({ channelId: A, cwd: "/home/pi/src", source: "process" });
		mountBrowser();
		await settle();
		// Opening a folder pauses following.
		key(rowEl("lasterm"), "Enter");
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi/src/lasterm", false]);
		expect(followToggle().getAttribute("aria-pressed")).toBe("false");
		expect(status()).toBe("Terminal is in /home/pi/src Go there");
		// A cd meanwhile moves the line, not the folder shown.
		store.takeCwd({ channelId: A, cwd: "/home/pi", source: "process" });
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi/src/lasterm", false]);
		expect(status()).toBe("Terminal is in /home/pi Go there");
		// "Go there" follows again.
		root.querySelector<HTMLButtonElement>(".files-status .files-link")?.click();
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi", false]);
		expect(followToggle().getAttribute("aria-pressed")).toBe("true");
	});

	it("pauses and resumes with the toggle, and remembers the folder for the terminal", async () => {
		const store = useFilesPanelStore();
		store.takeCwd({ channelId: A, cwd: "/home/pi/src", source: "process" });
		mountBrowser();
		await settle();
		followToggle().click();
		await settle();
		expect(store.terminalFiles(A, true)).toEqual({ following: false, path: "/home/pi/src" });
		expect(followToggle().textContent?.trim()).toBe("Follow");
		followToggle().click();
		await settle();
		expect(store.terminalFiles(A, false)).toEqual({ following: true, path: null });
	});

	it("starts paused where the setting says not to follow", async () => {
		useFilesPanelStore().takeCwd({ channelId: A, cwd: "/home/pi/src", source: "process" });
		mountBrowser({ followByDefault: false });
		await settle();
		expect(lastListed()).toEqual([A, undefined, false]);
		expect(followToggle().getAttribute("aria-pressed")).toBe("false");
		expect(status()).toContain("Terminal is in /home/pi/src");
	});
});

describe("the list and the path bar", () => {
	it("moves with the arrows, opens on Enter, goes up on Backspace back onto the folder left", async () => {
		useFilesPanelStore().browse(A, "/home/pi");
		mountBrowser();
		await settle();
		const list = root.querySelector('[role="listbox"]') as HTMLElement;
		expect(list.getAttribute("aria-label")).toBe("Files in /home/pi");
		const current = () =>
			root.querySelector('[role="option"][tabindex="0"]')?.textContent?.trim() ?? "";
		expect(current()).toMatch(/^src/);
		key(rowEl("src"), "ArrowDown");
		await settle();
		expect(current()).toMatch(/^logs/);
		key(rowEl("logs"), "End");
		await settle();
		expect(current()).toMatch(/^notes\.md/);
		// Type-ahead.
		key(rowEl("notes.md"), "s");
		await settle();
		expect(current()).toMatch(/^src/);
		key(rowEl("src"), "Enter");
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi/src", false]);
		key(rowEl("lasterm"), "Backspace");
		await settle();
		expect(lastListed()).toEqual([A, "/home/pi", false]);
		expect(current()).toMatch(/^src/);
	});

	it("says each row as what it is, and marks the folder shown in the path", async () => {
		useFilesPanelStore().browse(A, "/home/pi");
		mountBrowser();
		await settle();
		expect(rowEl("src").getAttribute("aria-label")).toBe("folder src");
		expect(rowEl("notes.md").getAttribute("aria-label")).toBe("file notes.md, 10 B");
		const crumbs = [...root.querySelectorAll(".files-crumb")].map((c) => c.textContent?.trim());
		expect(crumbs).toEqual(["/", "home", "pi"]);
		expect(root.querySelector('[aria-current="location"]')?.textContent?.trim()).toBe("pi");
		// A folder of the path opens it, and pauses following.
		(root.querySelectorAll<HTMLButtonElement>(".files-crumb")[1] as HTMLButtonElement).click();
		await settle();
		expect(lastListed()).toEqual([A, "/home", false]);
	});

	it("edits the path as text on F2, and goes there on Enter", async () => {
		useFilesPanelStore().browse(A, "/home/pi");
		mountBrowser();
		await settle();
		key(rowEl("src"), "F2");
		await settle();
		const input = root.querySelector<HTMLInputElement>(
			'input[aria-label="Path"]',
		) as HTMLInputElement;
		expect(input.value).toBe("/home/pi");
		input.value = "/srv/drop";
		input.dispatchEvent(new Event("input"));
		key(input, "Enter");
		await settle();
		expect(lastListed()).toEqual([A, "/srv/drop", false]);
	});

	it("says a host that is not connected, and offers to connect it", async () => {
		mocks.listHostFiles.mockResolvedValue({ ok: false, code: "HOST_NOT_CONNECTED", message: "x" });
		mountBrowser();
		await settle();
		expect(root.querySelector(".files-card")?.textContent).toContain(
			"raspberrypi is not connected.",
		);
		expect(root.querySelector(".files-card")?.getAttribute("role")).toBe("alert");
		expect(
			[...root.querySelectorAll(".files-card button")].map((b) => b.textContent?.trim()),
		).toEqual(["Connect", "Retry"]);
	});
});

describe("a new folder", () => {
	it("is the writer's: created where the panel is, then listed", async () => {
		useFilesPanelStore().browse(A, "/home/pi");
		mocks.createHostFolder.mockResolvedValue({ ok: true, value: { path: "/home/pi/new" } });
		mountBrowser();
		await settle();
		const create = [...root.querySelectorAll<HTMLButtonElement>(".files-actions button")].find(
			(b) => b.textContent?.includes("New folder"),
		) as HTMLButtonElement;
		expect(create.disabled).toBe(false);
		create.click();
		await settle();
		const name = root.querySelector<HTMLInputElement>(
			'input[aria-label="New folder name"]',
		) as HTMLInputElement;
		name.value = "new";
		name.dispatchEvent(new Event("input"));
		key(name, "Enter");
		await settle();
		expect(mocks.createHostFolder).toHaveBeenCalledWith(A, "/home/pi/new");
	});

	it("is disabled for a reader, with the reason in words and a way to ask for the lock", async () => {
		useFilesPanelStore().browse(A, "/home/pi");
		mountBrowser({ writer: false });
		await settle();
		const create = [...root.querySelectorAll<HTMLButtonElement>(".files-actions button")].find(
			(b) => b.textContent?.includes("New folder"),
		) as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		const note = root.querySelector(".files-actions__note") as HTMLElement;
		expect(note.textContent).toContain("Only the writer can create folders here.");
		expect(create.getAttribute("aria-describedby")).toBe(note.id);
		// Readers still browse.
		expect(rows()).toEqual(["src", "logs", "notes.md"]);
		note.querySelector<HTMLButtonElement>("button")?.click();
		expect(sent).toEqual([{ type: "WRITE_CLAIM", channelId: A }]);
	});
});
