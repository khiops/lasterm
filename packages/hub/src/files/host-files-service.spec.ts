import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostOs } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SftpSupport } from "../session/agent-deployer.js";
import type { SftpServerOptions } from "../session/sftp-server.fixture.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { failsWith } from "./file-names.fixture.js";
import type { FileBackend } from "./host-files.js";
import { ChannelNotFound, HostFilesService, type SshFileHost } from "./host-files-service.js";
import { normaliseHostPath, WINDOWS_ROOT } from "./host-paths.js";
import { type MockSshHost, startMockSshHost } from "./ssh-host.fixture.js";

const windowsMachine = process.platform === "win32";
/** How this machine spells its paths, and the shell its exec runs as an SSH server would. */
const machine = windowsMachine
	? ({ style: "windows", os: "windows", shell: "cmd" } as const)
	: ({ style: "posix", os: "linux", shell: "sh" } as const);

const LOCAL_CHANNEL = "01HZ00000000000000000000L1";
const REMOTE_CHANNEL = "01HZ00000000000000000000R1";
const REMOTE_HOST = "01HZ00000000000000000000H1";

/** A local backend that records what it is asked, as the hub's own file system would answer. */
function recordingBackend(home: string): FileBackend & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		home: async () => home,
		list: async (dir, hidden) => {
			calls.push(["list", dir, hidden]);
			return [
				{ name: ".dot", kind: "file", size: 1, mtime: null },
				{ name: "b", kind: "file", size: 1, mtime: null },
				{ name: "a", kind: "directory", size: null, mtime: null },
			];
		},
		stat: async (path) => {
			calls.push(["stat", path]);
			return { name: "x", kind: "file", size: 3, mtime: null };
		},
		freeSpace: async (dir) => {
			calls.push(["freeSpace", dir]);
			return { available: 1, total: 2 };
		},
		mkdir: async (path) => {
			calls.push(["mkdir", path]);
		},
	};
}

describe("the files of a terminal on the local host", () => {
	const backend = recordingBackend("/home/me");
	const service = new HostFilesService({
		channelHost: (id) => (id === LOCAL_CHANNEL ? { hostId: "local", hostType: "local" } : null),
		hostOs: () => null,
		sshHost: () => {
			throw new Error("the local host has no SSH connection");
		},
		local: { backend, os: "linux" },
	});

	beforeEach(() => {
		backend.calls.length = 0;
	});

	it("opens at the home, sorted, without hidden entries unless asked", async () => {
		const listing = await service.list(LOCAL_CHANNEL, undefined, false);
		expect(listing).toEqual({
			path: "/home/me",
			entries: [
				{ name: "a", kind: "directory", size: null, mtime: null },
				{ name: "b", kind: "file", size: 1, mtime: null },
			],
			truncated: 0,
		});
		expect((await service.list(LOCAL_CHANNEL, "/srv//x/", true)).entries).toHaveLength(3);
		expect(backend.calls).toEqual([
			["list", "/home/me", false],
			["list", "/srv/x", true],
		]);
	});

	it("hands the backend only normalised paths, and refuses others with their reason", async () => {
		expect(await service.stat(LOCAL_CHANNEL, "/etc/")).toMatchObject({ path: "/etc", name: "x" });
		expect(await service.freeSpace(LOCAL_CHANNEL, undefined)).toEqual({
			path: "/home/me",
			available: 1,
			total: 2,
		});
		expect(await service.mkdir(LOCAL_CHANNEL, "/srv/new/")).toEqual({ path: "/srv/new" });
		const message = await failsWith(service.list(LOCAL_CHANNEL, "~/x", false), "UNSUPPORTED_PATH");
		expect(message).toContain("~");
		await failsWith(service.mkdir(LOCAL_CHANNEL, "/"), "UNSUPPORTED_PATH");
		expect(backend.calls).toEqual([
			["stat", "/etc"],
			["freeSpace", "/home/me"],
			["mkdir", "/srv/new"],
		]);
	});

	it("knows no terminal it was not given", async () => {
		await expect(service.list("01HZ0000000000000000000000", undefined, false)).rejects.toThrow(
			ChannelNotFound,
		);
	});
});

/** A remote terminal's host: the mock SSH server, and the hub's connection to it. */
function useRemote(
	options: SftpServerOptions & { support?: SftpSupport | null; os?: HostOs | null } = {},
) {
	const state = {} as {
		root: string;
		host: MockSshHost;
		service: HostFilesService;
		connected: boolean;
	};
	beforeEach(async () => {
		state.root = makeTempDir("lasterm-host-files-");
		state.host = await startMockSshHost({ shell: machine.shell, ...options });
		state.connected = true;
		const ssh: SshFileHost = {
			get sshConnection() {
				return state.connected ? state.host.client : null;
			},
			sftpSupport: options.support === undefined ? { offered: true } : options.support,
		};
		state.service = new HostFilesService({
			channelHost: (id) =>
				id === REMOTE_CHANNEL ? { hostId: REMOTE_HOST, hostType: "ssh" } : null,
			hostOs: () => (options.os === undefined ? machine.os : options.os),
			sshHost: () => ssh,
		});
	});
	afterEach(async () => {
		await state.host.close();
		await removeTempDir(state.root);
	});
	return state;
}

/** `path` on this machine as the host spells it. */
function hostPath(path: string): string {
	const normalised = normaliseHostPath(path, machine.style);
	if (!normalised.ok) throw new Error(normalised.reason);
	return normalised.path;
}

describe("a remote host that is not connected", () => {
	const state = useRemote();

	it("is said as HOST_NOT_CONNECTED", async () => {
		state.connected = false;
		await failsWith(state.service.list(REMOTE_CHANNEL, undefined, false), "HOST_NOT_CONNECTED");
		await failsWith(state.service.mkdir(REMOTE_CHANNEL, "/x/y"), "HOST_NOT_CONNECTED");
	});
});

describe("a remote host that offers SFTP", () => {
	const state = useRemote();

	it("is browsed over SFTP, and a verdict is not asked again over SSH commands", async () => {
		writeFileSync(join(state.root, "f"), "");
		const listing = await state.service.list(REMOTE_CHANNEL, state.root, false);
		expect(listing.path).toBe(hostPath(state.root));
		expect(listing.entries.map((entry) => entry.name)).toEqual(["f"]);
		await failsWith(
			state.service.list(REMOTE_CHANNEL, join(state.root, "missing"), false),
			"NOT_FOUND",
		);
		expect(state.host.server.execCommands).toEqual([]);
	});

	it("asks over SSH commands what SFTP could not answer: the free space, here", async () => {
		const space = await state.service.freeSpace(REMOTE_CHANNEL, state.root);
		expect(space.path).toBe(hostPath(state.root));
		expect(space.total).toBeGreaterThan(0);
		expect(state.host.server.execCommands).toHaveLength(1);
	});
});

describe("a remote host whose SFTP and SSH commands both fail", () => {
	const state = useRemote({ exec: false });

	it("says what each said", async () => {
		const message = await failsWith(
			state.service.freeSpace(REMOTE_CHANNEL, state.root),
			"FILE_ACCESS_FAILED",
		);
		expect(message).toMatch(/^Over SFTP: .*does not report free space.*\. Over SSH commands: /);
	});
});

describe("a remote host without SFTP (#722, #723)", () => {
	const reason = "Unable to start subsystem: sftp";
	const state = useRemote({ sftp: false, support: { offered: false, reason } });

	it("is browsed over SSH commands alone", async () => {
		mkdirSync(join(state.root, "d"));
		writeFileSync(join(state.root, "f"), "");
		const listing = await state.service.list(REMOTE_CHANNEL, state.root, false);
		expect(listing.entries.map((entry) => entry.name)).toEqual(["d", "f"]);
		await state.service.mkdir(REMOTE_CHANNEL, join(state.root, "new"));
		expect((await state.service.stat(REMOTE_CHANNEL, join(state.root, "new"))).kind).toBe(
			"directory",
		);
		expect(state.host.server.sftpRequests()).toBe(0);
	});
});

describe("a remote host without SFTP that runs no command either", () => {
	const reason = "Unable to start subsystem: sftp";
	const state = useRemote({ sftp: false, exec: false, support: { offered: false, reason } });

	it("says SFTP is not offered, and what the SSH commands said", async () => {
		const message = await failsWith(
			state.service.list(REMOTE_CHANNEL, state.root, false),
			"FILE_ACCESS_FAILED",
		);
		expect(message).toContain(`Over SFTP: the server does not offer SFTP (${reason})`);
		expect(message).toContain("Over SSH commands: ");
	});
});

describe("a remote host whose OS no connection recorded", () => {
	const state = useRemote({ os: null });

	it("is asked once per connection", async () => {
		writeFileSync(join(state.root, "f"), "");
		await state.service.list(REMOTE_CHANNEL, state.root, false);
		await state.service.stat(REMOTE_CHANNEL, join(state.root, "f"));
		const asked = state.host.server.execCommands;
		expect(asked.length).toBeGreaterThan(0);
		await state.service.list(REMOTE_CHANNEL, state.root, false);
		expect(state.host.server.execCommands).toEqual(asked);
	});
});

describe("a Windows host over SFTP, as Win32-OpenSSH serves it", () => {
	let view: string;
	let windowsHost: HostFilesService;
	let host: MockSshHost;

	beforeEach(async () => {
		view = makeTempDir("lasterm-host-files-windows-");
		mkdirSync(join(view, "C", "Users", "test", "Documents"), { recursive: true });
		host = await startMockSshHost({ view: { style: "windows", root: view } });
		const ssh: SshFileHost = { sshConnection: host.client, sftpSupport: { offered: true } };
		windowsHost = new HostFilesService({
			channelHost: () => ({ hostId: REMOTE_HOST, hostType: "ssh" }),
			hostOs: () => "windows",
			sshHost: () => ssh,
		});
	});
	afterEach(async () => {
		await host.close();
		await removeTempDir(view);
	});

	it("opens at the home, in its Windows form", async () => {
		expect((await windowsHost.list(REMOTE_CHANNEL, undefined, false)).path).toBe("C:\\Users\\test");
	});

	it.each(["C:\\Users\\test", "C:/Users/test", "/C:/Users/test", "c:\\Users\\test\\"])(
		"reads %j as C:\\Users\\test",
		async (form) => {
			const listing = await windowsHost.list(REMOTE_CHANNEL, form, false);
			expect(listing.path).toBe("C:\\Users\\test");
			expect(listing.entries.map((entry) => entry.name)).toEqual(["Documents"]);
		},
	);

	it("lists the drives at its root, and a drive joined onto it", async () => {
		const root = await windowsHost.list(REMOTE_CHANNEL, WINDOWS_ROOT, false);
		expect(root).toEqual({
			path: WINDOWS_ROOT,
			entries: [{ name: "C:", kind: "directory", size: null, mtime: null }],
			truncated: 0,
		});
		const drive = await windowsHost.list(REMOTE_CHANNEL, `${WINDOWS_ROOT}C:`, false);
		expect(drive.path).toBe("C:\\");
		expect(drive.entries.map((entry) => entry.name)).toEqual(["Users"]);
	});

	it.each(["\\\\server\\share\\x", "//server/share/x", "///server/share/x"])(
		"reads the UNC path %j as \\\\server\\share\\x, and lists the share over SFTP",
		async (form) => {
			mkdirSync(join(view, "UNC", "server", "share", "x", "inside"), { recursive: true });
			const listing = await windowsHost.list(REMOTE_CHANNEL, form, false);
			expect(listing.path).toBe("\\\\server\\share\\x");
			expect(listing.entries.map((entry) => entry.name)).toEqual(["inside"]);
		},
	);

	it("says a missing folder of a share is not found, and refuses %VAR% text with its reason", async () => {
		mkdirSync(join(view, "UNC", "server", "share"), { recursive: true });
		await failsWith(windowsHost.list(REMOTE_CHANNEL, "\\\\server\\share\\x", false), "NOT_FOUND");
		const message = await failsWith(
			windowsHost.list(REMOTE_CHANNEL, "%USERPROFILE%\\Documents", false),
			"UNSUPPORTED_PATH",
		);
		expect(message).toContain("environment variable");
	});

	it("creates a folder, and says one exists though the server says only 'Failure'", async () => {
		expect(await windowsHost.mkdir(REMOTE_CHANNEL, "C:/Users/test/New folder")).toEqual({
			path: "C:\\Users\\test\\New folder",
		});
		await failsWith(
			windowsHost.mkdir(REMOTE_CHANNEL, "C:\\Users\\test\\New folder"),
			"ALREADY_EXISTS",
		);
	});
});
