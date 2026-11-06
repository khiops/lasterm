// biome-ignore-all lint/suspicious/noTemplateCurlyInString: test data holds literal ${VAR} text, which the hub expands as the agent does
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostOs } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SftpSupport } from "../session/agent-deployer.js";
import type { SftpServerOptions } from "../session/sftp-server.fixture.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { failsWith } from "./file-names.fixture.js";
import { FileAccessError, type FileBackend } from "./host-files.js";
import {
	ChannelNotFound,
	HostFilesService,
	type SshFileHost,
	type StartFolderSettings,
} from "./host-files-service.js";
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

/** What a recording backend's host holds besides its files: its environment, and folders it refuses. */
interface RecordedHost {
	/** The host's environment, as `env` reads it. */
	env?: Record<string, string>;
	/** Why `env` fails, when it does. */
	envFails?: FileAccessError;
	/** Folders whose listing fails, and how. */
	refused?: Record<string, FileAccessError>;
}

/** A local backend that records what it is asked, as the hub's own file system would answer. */
function recordingBackend(
	home: string,
	host: RecordedHost = {},
): FileBackend & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		home: async () => home,
		env: async (names) => {
			calls.push(["env", [...names]]);
			if (host.envFails) throw host.envFails;
			const found = new Map<string, string>();
			for (const name of names) {
				const value = host.env?.[name];
				if (value !== undefined) found.set(name, value);
			}
			return found;
		},
		list: async (dir, hidden) => {
			calls.push(["list", dir, hidden]);
			const refused = host.refused?.[dir];
			if (refused) throw refused;
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
			start: "home",
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

// The folder a panel opens at, without a path (#836): the fallback folder the
// settings name for a terminal whose directory is unknown, expanded as the
// agent expands a cwd, else the home.
describe("the folder a panel opens at", () => {
	const notFound = new FileAccessError(
		"NOT_FOUND",
		"The folder could not be listed: it does not exist",
	);

	function opening(
		settings: StartFolderSettings,
		host: RecordedHost = {},
		os: HostOs = "linux",
		home = "/home/me",
	) {
		const backend = recordingBackend(home, host);
		const service = new HostFilesService({
			channelHost: () => ({ hostId: "local", hostType: "local" }),
			hostOs: () => null,
			sshHost: () => null,
			local: { backend, os },
			startFolder: (id) => {
				expect(id).toBe(LOCAL_CHANNEL);
				return settings;
			},
		});
		return { backend, service };
	}

	it("is the fallback folder when one is set, and a folder asked by its path is only that", async () => {
		const { backend, service } = opening({ fallbackDir: "/srv/drop/", env: {} });
		const listing = await service.list(LOCAL_CHANNEL, undefined, false);
		expect(listing).toMatchObject({ path: "/srv/drop", start: "fallback" });
		expect(listing.fallbackProblem).toBeUndefined();
		const byPath = await service.list(LOCAL_CHANNEL, "/etc", false);
		expect(byPath.start).toBeUndefined();
		expect(byPath.fallbackProblem).toBeUndefined();
		expect(backend.calls).toEqual([
			["list", "/srv/drop", false],
			["list", "/etc", false],
		]);
	});

	it("expands its variables from the terminal's own first, then from the host's", async () => {
		const { backend, service } = opening(
			{ fallbackDir: "${BASE}/${USER}/\\${KEPT}", env: { BASE: "/srv" } },
			{ env: { USER: "me", BASE: "/nowhere" } },
		);
		expect(await service.list(LOCAL_CHANNEL, undefined, true)).toMatchObject({
			path: "/srv/me/${KEPT}",
			start: "fallback",
		});
		// The host is asked only for what the terminal's variables do not hold.
		expect(backend.calls).toEqual([
			["env", ["USER"]],
			["list", "/srv/me/${KEPT}", true],
		]);
	});

	it("is the home when none is set, without asking the host anything else", async () => {
		for (const fallbackDir of ["", "   "]) {
			const { backend, service } = opening({ fallbackDir, env: {} });
			const listing = await service.list(LOCAL_CHANNEL, undefined, false);
			expect(listing).toMatchObject({ path: "/home/me", start: "home" });
			expect(listing.fallbackProblem).toBeUndefined();
			expect(backend.calls).toEqual([["list", "/home/me", false]]);
		}
	});

	it("is the home when the fallback folder cannot be opened, saying why", async () => {
		const { service } = opening(
			{ fallbackDir: "/srv/missing", env: {} },
			{ refused: { "/srv/missing": notFound } },
		);
		expect(await service.list(LOCAL_CHANNEL, undefined, false)).toMatchObject({
			path: "/home/me",
			start: "home",
			fallbackProblem: "The fallback folder /srv/missing cannot be opened: it does not exist",
		});
	});

	it("is the home when a variable has no value, and the folder is no path", async () => {
		const { service } = opening({ fallbackDir: "${NOWHERE_SET}/x", env: {} });
		const listing = await service.list(LOCAL_CHANNEL, undefined, false);
		expect(listing).toMatchObject({ path: "/home/me", start: "home" });
		expect(listing.fallbackProblem).toMatch(
			/^The fallback folder \$\{NOWHERE_SET\}\/x cannot be opened: /,
		);
	});

	it("is the home when the host's variables cannot be read, saying why", async () => {
		const { service } = opening(
			{ fallbackDir: "${HOME}/drop", env: {} },
			{ envFails: new FileAccessError("FILE_ACCESS_FAILED", "no shell") },
		);
		expect(await service.list(LOCAL_CHANNEL, undefined, false)).toMatchObject({
			path: "/home/me",
			start: "home",
			fallbackProblem:
				"The fallback folder ${HOME}/drop cannot be opened: its variables could not be read on the host (no shell)",
		});
	});

	it("says a host that cannot be reached as it is, rather than opening the home", async () => {
		const lost = new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost");
		await failsWith(
			opening({ fallbackDir: "${HOME}", env: {} }, { envFails: lost }).service.list(
				LOCAL_CHANNEL,
				undefined,
				false,
			),
			"HOST_NOT_CONNECTED",
		);
		const failed = new FileAccessError("FILE_ACCESS_FAILED", "Over SFTP: x. Over SSH commands: y");
		await failsWith(
			opening(
				{ fallbackDir: "/srv/drop", env: {} },
				{ refused: { "/srv/drop": failed } },
			).service.list(LOCAL_CHANNEL, undefined, false),
			"FILE_ACCESS_FAILED",
		);
	});

	it("reads variable names without regard to case on a Windows host, exactly elsewhere", async () => {
		const windows = opening(
			{ fallbackDir: "${userprofile}\\Drop", env: { USERPROFILE: "C:\\Users\\me" } },
			{},
			"windows",
			"C:\\Users\\me",
		);
		expect(await windows.service.list(LOCAL_CHANNEL, undefined, false)).toMatchObject({
			path: "C:\\Users\\me\\Drop",
			start: "fallback",
		});
		const posix = opening({ fallbackDir: "${home}/drop", env: { HOME: "/home/me" } });
		const listing = await posix.service.list(LOCAL_CHANNEL, undefined, false);
		expect(listing.start).toBe("home");
		// Not the terminal's HOME: the host is asked for `home` itself.
		expect(posix.backend.calls[0]).toEqual(["env", ["home"]]);
	});
});

/** A remote terminal's host: the mock SSH server, and the hub's connection to it. */
function useRemote(
	options: SftpServerOptions & {
		support?: SftpSupport | null;
		os?: HostOs | null;
		/** The terminal's start folder settings, given the folder the spec works in. */
		startFolder?: (root: string) => StartFolderSettings;
	} = {},
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
			...(options.startFolder !== undefined
				? { startFolder: () => options.startFolder?.(state.root) ?? { fallbackDir: "", env: {} } }
				: {}),
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

// The mock server's commands run with this process's environment, as an SSH
// server's run with the account's.
describe("a remote host's fallback folder, its variables read over SSH commands (#836)", () => {
	const variable = "LASTERM_SPEC_FALLBACK_836";
	const state = useRemote({
		startFolder: () => ({ fallbackDir: `\${${variable}}`, env: {} }),
	});
	afterEach(() => {
		delete process.env[variable];
	});

	it("lists the folder its variable names on the host, the listing itself over SFTP", async () => {
		process.env[variable] = state.root;
		writeFileSync(join(state.root, "dropped"), "");
		const listing = await state.service.list(REMOTE_CHANNEL, undefined, false);
		expect(listing).toMatchObject({ path: hostPath(state.root), start: "fallback" });
		expect(listing.entries.map((entry) => entry.name)).toEqual(["dropped"]);
		// SFTP has no request for the environment: one command asked for it.
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
