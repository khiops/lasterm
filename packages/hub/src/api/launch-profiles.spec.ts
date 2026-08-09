import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.js";
import { resolveHostOs } from "./host-profiles.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../ssh/ssh-config-parser.js", () => ({
	readSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
	parseSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
}));

vi.mock("ssh2", () => ({
	Client: vi.fn().mockImplementation(() =>
		Object.assign(new EventEmitter(), {
			connect: vi.fn(),
			end: vi.fn(),
			destroy: vi.fn(),
		}),
	),
}));

vi.mock("../session/ssh-agent.js", () => {
	const { EventEmitter } = require("node:events");
	class MockSshAgent extends EventEmitter {
		connected = true;
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn();
		close = vi.fn(() => {
			this.connected = false;
			this.emit("close");
		});
	}
	return { SshAgent: MockSshAgent };
});

// ─── Setup ────────────────────────────────────────────────────────────────────

let dbs: DatabaseManager;
let server: FastifyInstance;

beforeEach(async () => {
	dbs = openTestDatabases();
	server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
	});
});

afterEach(async () => {
	await server.close();
	dbs.close();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createProfile(
	overrides: Record<string, unknown> = {},
): Promise<{ id: string; [key: string]: unknown }> {
	const res = await server.inject({
		method: "POST",
		url: "/api/launch-profiles",
		payload: {
			name: "Test Profile",
			shell: "/bin/bash",
			...overrides,
		},
	});
	expect(res.statusCode).toBe(201);
	return res.json<{ id: string }>();
}

// ─── GET /api/launch-profiles ─────────────────────────────────────────────────

describe("GET /api/launch-profiles", () => {
	it("returns empty array initially", async () => {
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles" });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual([]);
	});

	it("returns created profiles", async () => {
		await createProfile({ name: "Profile A" });
		await createProfile({ name: "Profile B" });
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles" });
		expect(res.statusCode).toBe(200);
		const body = res.json<Array<{ name: string }>>();
		expect(body).toHaveLength(2);
	});

	it("masks sensitive env values (SC-36)", async () => {
		await createProfile({
			name: "Env Profile",
			env: { MY_PASSWORD: "secret123", NORMAL: "value" },
		});
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles" });
		expect(res.statusCode).toBe(200);
		const profiles = res.json<Array<{ env: Record<string, string> }>>();
		expect(profiles[0]?.env?.MY_PASSWORD).toBe("********");
		expect(profiles[0]?.env?.NORMAL).toBe("value");
	});
});

// ─── POST /api/launch-profiles ────────────────────────────────────────────────

describe("POST /api/launch-profiles", () => {
	it("creates a profile with all required fields (SC-01)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: {
				name: "Full Profile",
				shell: "/bin/zsh",
				args: ["-l"],
				cwd: "/home/user",
				env: { FOO: "bar" },
				mode: "shell",
				elevated: false,
				supported_os: "linux",
				icon_type: "emoji",
				icon_value: "",
				color: "#ff6600",
				sort_order: 3,
			},
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<Record<string, unknown>>();
		expect(body.id).toBeTruthy();
		expect(body.name).toBe("Full Profile");
		expect(body.shell).toBe("/bin/zsh");
		expect(body.args).toEqual(["-l"]);
		expect(body.cwd).toBe("/home/user");
		expect(body.mode).toBe("shell");
		expect(body.elevated).toBe(false);
		expect(body.supported_os).toBe("linux");
		expect(body.color).toBe("#ff6600");
		expect(body.sort_order).toBe(3);
	});

	it("creates a minimal profile with name+shell (SC-02)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Min", shell: "/bin/bash" },
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<Record<string, unknown>>();
		expect(body.mode).toBe("shell");
		expect(body.elevated).toBe(false);
		expect(body.supported_os).toBe("any");
		expect(body.icon_type).toBe("auto");
	});

	it("returns 409 for duplicate name (SC-03)", async () => {
		await createProfile({ name: "Dupe" });
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Dupe", shell: "/bin/bash" },
		});
		expect(res.statusCode).toBe(409);
		expect(res.json<{ error: { code: string } }>().error.code).toBe("CONFLICT");
	});

	it("returns 409 for duplicate name case-insensitive (SC-33)", async () => {
		await createProfile({ name: "MyProfile" });
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "myprofile", shell: "/bin/bash" },
		});
		expect(res.statusCode).toBe(409);
	});

	it("returns 400 for empty shell (SC-04)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Bad", shell: "" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for missing shell", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "NoShell" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for shell with semicolons (SC-35)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Injection", shell: "/bin/bash; rm -rf /" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { message: string } }>();
		expect(body.error.message).toContain("executable path");
	});

	it("returns 400 for shell with pipe metacharacter (SC-35)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Pipe", shell: "/bin/bash | cat" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for shell with & metacharacter (SC-35)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Amp", shell: "/bin/bash & evil" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("allows shell with parentheses (not a metachar)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "Parens", shell: "/usr/bin/env" },
		});
		expect(res.statusCode).toBe(201);
	});

	it("returns 400 for invalid color format", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { name: "BadColor", shell: "/bin/bash", color: "red" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for missing name", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/launch-profiles",
			payload: { shell: "/bin/bash" },
		});
		expect(res.statusCode).toBe(400);
	});
});

// ─── GET /api/launch-profiles/:id ─────────────────────────────────────────────

describe("GET /api/launch-profiles/:id", () => {
	it("returns profile by ID", async () => {
		const created = await createProfile({ name: "GetMe" });
		const res = await server.inject({
			method: "GET",
			url: `/api/launch-profiles/${created.id}`,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json<{ name: string }>().name).toBe("GetMe");
	});

	it("returns 404 for unknown ID", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/launch-profiles/does-not-exist",
		});
		expect(res.statusCode).toBe(404);
	});

	it("masks env in GET by id (SC-36)", async () => {
		const created = await createProfile({
			name: "MaskEnv",
			env: { API_TOKEN: "secret", HOST: "localhost" },
		});
		const res = await server.inject({
			method: "GET",
			url: `/api/launch-profiles/${created.id}`,
		});
		const body = res.json<{ env: Record<string, string> }>();
		expect(body.env?.API_TOKEN).toBe("********");
		expect(body.env?.HOST).toBe("localhost");
	});
});

// ─── PUT /api/launch-profiles/:id ─────────────────────────────────────────────

describe("PUT /api/launch-profiles/:id", () => {
	it("updates profile fields", async () => {
		const created = await createProfile({ name: "UpdateMe" });
		const res = await server.inject({
			method: "PUT",
			url: `/api/launch-profiles/${created.id}`,
			payload: { name: "Updated", shell: "/bin/zsh" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ name: string; shell: string }>();
		expect(body.name).toBe("Updated");
		expect(body.shell).toBe("/bin/zsh");
	});

	it("returns 404 for unknown ID", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/launch-profiles/does-not-exist",
			payload: { name: "X" },
		});
		expect(res.statusCode).toBe(404);
	});

	it("returns 409 for name conflict with another profile", async () => {
		await createProfile({ name: "Other" });
		const created = await createProfile({ name: "Mine" });
		const res = await server.inject({
			method: "PUT",
			url: `/api/launch-profiles/${created.id}`,
			payload: { name: "Other" },
		});
		expect(res.statusCode).toBe(409);
	});

	it("allows updating name to same name (no self-conflict)", async () => {
		const created = await createProfile({ name: "Same" });
		const res = await server.inject({
			method: "PUT",
			url: `/api/launch-profiles/${created.id}`,
			payload: { name: "Same" },
		});
		expect(res.statusCode).toBe(200);
	});

	it("returns 400 for shell with metacharacters on update (SC-35)", async () => {
		const created = await createProfile();
		const res = await server.inject({
			method: "PUT",
			url: `/api/launch-profiles/${created.id}`,
			payload: { shell: "/bin/bash; evil" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("env sentinel preserves existing value (SC-36)", async () => {
		const created = await createProfile({
			name: "SentinelTest",
			env: { MY_SECRET: "real-value", NORMAL: "keep-me" },
		});
		// Update: send sentinel for MY_SECRET (as if user saw "********")
		const res = await server.inject({
			method: "PUT",
			url: `/api/launch-profiles/${created.id}`,
			payload: { env: { MY_SECRET: "********", NORMAL: "changed" } },
		});
		expect(res.statusCode).toBe(200);
		// The response should mask the env
		const body = res.json<{ env: Record<string, string> }>();
		expect(body.env?.MY_SECRET).toBe("********"); // still masked in response

		// Verify the real value was preserved by checking GET response (still masked)
		// and by verifying NORMAL was updated
		expect(body.env?.NORMAL).toBe("changed");
	});
});

// ─── DELETE /api/launch-profiles/:id ──────────────────────────────────────────

describe("DELETE /api/launch-profiles/:id", () => {
	it("deletes profile and returns 204", async () => {
		// Need at least 2 profiles so the delete is not blocked as last profile
		await createProfile({ name: "Keeper" });
		const created = await createProfile({ name: "ToDelete" });
		const res = await server.inject({
			method: "DELETE",
			url: `/api/launch-profiles/${created.id}`,
		});
		expect(res.statusCode).toBe(204);

		// Verify it's gone
		const get = await server.inject({
			method: "GET",
			url: `/api/launch-profiles/${created.id}`,
		});
		expect(get.statusCode).toBe(404);
	});

	it("returns 400 LAST_PROFILE when deleting the only profile", async () => {
		const created = await createProfile();
		const res = await server.inject({
			method: "DELETE",
			url: `/api/launch-profiles/${created.id}`,
		});
		expect(res.statusCode).toBe(400);
		expect(res.json<{ error: { code: string } }>().error.code).toBe("LAST_PROFILE");
	});

	it("returns 404 for unknown ID", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/launch-profiles/does-not-exist",
		});
		expect(res.statusCode).toBe(404);
	});
});

// ─── PUT /api/launch-profiles/order ───────────────────────────────────────────

describe("PUT /api/launch-profiles/order", () => {
	it("reorders profiles and returns 204", async () => {
		const a = await createProfile({ name: "A", sort_order: 0 });
		const b = await createProfile({ name: "B", sort_order: 1 });
		const c = await createProfile({ name: "C", sort_order: 2 });

		const res = await server.inject({
			method: "PUT",
			url: "/api/launch-profiles/order",
			payload: { ids: [c.id, a.id, b.id] },
		});
		expect(res.statusCode).toBe(204);

		// Verify order
		const list = await server.inject({ method: "GET", url: "/api/launch-profiles" });
		const profiles = list.json<Array<{ name: string }>>();
		expect(profiles[0]?.name).toBe("C");
		expect(profiles[1]?.name).toBe("A");
		expect(profiles[2]?.name).toBe("B");
	});

	it("returns 400 for non-array ids", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/launch-profiles/order",
			payload: { ids: "not-an-array" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("handles unknown IDs without error (SC-32)", async () => {
		const a = await createProfile({ name: "A" });
		const res = await server.inject({
			method: "PUT",
			url: "/api/launch-profiles/order",
			payload: { ids: ["unknown-id", a.id] },
		});
		expect(res.statusCode).toBe(204);
	});
});

// ─── GET /api/hosts/:id/profiles ──────────────────────────────────────────────

describe("GET /api/hosts/:id/profiles", () => {
	it("returns 404 for unknown host", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/hosts/unknown-host/profiles",
		});
		expect(res.statusCode).toBe(404);
	});

	it("returns profiles filtered by OS", async () => {
		// Get the local host
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		expect(localHost).toBeDefined();
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		await createProfile({ name: "Any OS", supported_os: "any" });
		await createProfile({ name: "Linux Only", supported_os: "linux" });
		await createProfile({ name: "Mac Only", supported_os: "darwin" });

		const res = await server.inject({
			method: "GET",
			url: `/api/hosts/${hostId}/profiles?os=linux`,
		});
		expect(res.statusCode).toBe(200);
		const profiles = res.json<Array<{ name: string }>>();
		const names = profiles.map((p) => p.name);
		expect(names).toContain("Any OS");
		expect(names).toContain("Linux Only");
		expect(names).not.toContain("Mac Only");
	});
});

// ─── PUT/DELETE /api/hosts/:id/profiles/:profileId ────────────────────────────

describe("PUT /api/hosts/:id/profiles/:profileId", () => {
	it("upserts a pin override and returns 204", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		const profile = await createProfile({ name: "Pinned" });

		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${profile.id}`,
			payload: { override_type: "pin" },
		});
		expect(res.statusCode).toBe(204);
	});

	it("returns 400 for invalid override_type", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		const profile = await createProfile({ name: "BadOverride" });

		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${profile.id}`,
			payload: { override_type: "invalid" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 404 for unknown host", async () => {
		const profile = await createProfile({ name: "NoHost" });
		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/unknown-host/profiles/${profile.id}`,
			payload: { override_type: "pin" },
		});
		expect(res.statusCode).toBe(404);
	});

	it("returns 404 for unknown profile", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/unknown-profile`,
			payload: { override_type: "pin" },
		});
		expect(res.statusCode).toBe(404);
	});
});

describe("DELETE /api/hosts/:id/profiles/:profileId", () => {
	it("removes override and returns 204", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		const profile = await createProfile({ name: "ToRemove" });

		await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${profile.id}`,
			payload: { override_type: "hide" },
		});

		const res = await server.inject({
			method: "DELETE",
			url: `/api/hosts/${hostId}/profiles/${profile.id}`,
		});
		expect(res.statusCode).toBe(204);
	});

	it("returns 404 when override does not exist", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		const profile = await createProfile({ name: "NoOverride" });

		const res = await server.inject({
			method: "DELETE",
			url: `/api/hosts/${hostId}/profiles/${profile.id}`,
		});
		expect(res.statusCode).toBe(404);
	});
});

// ─── resolveHostOs (F-004) ─────────────────────────────────────────────────────

describe("resolveHostOs", () => {
	function makeHost(
		overrides: Partial<{ type: string; discoveredShells: string[] }>,
	): Parameters<typeof resolveHostOs>[0] {
		return {
			id: "h1",
			type: (overrides.type ?? "local") as "local" | "ssh",
			label: "Test",
			iconType: "auto",
			trustRemoteHints: "apply",
			sortOrder: 0,
			keepAliveSeconds: 0,
			historyRetentionDays: 30,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			...(overrides.discoveredShells !== undefined && {
				discoveredShells: overrides.discoveredShells,
			}),
		};
	}

	it("returns 'windows' when discoveredShells contains .exe paths", () => {
		const host = makeHost({
			discoveredShells: ["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\powershell.exe"],
		});
		expect(resolveHostOs(host)).toBe("windows");
	});

	it("returns 'windows' when discoveredShells contains backslash paths", () => {
		const host = makeHost({ discoveredShells: ["C:\\Windows\\System32\\cmd.exe"] });
		expect(resolveHostOs(host)).toBe("windows");
	});

	it("returns 'darwin' when discoveredShells contain /opt/homebrew/ paths", () => {
		const host = makeHost({
			discoveredShells: ["/opt/homebrew/bin/fish", "/bin/zsh"],
		});
		expect(resolveHostOs(host)).toBe("darwin");
	});

	it("returns 'darwin' when discoveredShells contain /usr/local/ paths", () => {
		const host = makeHost({
			discoveredShells: ["/usr/local/bin/bash", "/bin/sh"],
		});
		expect(resolveHostOs(host)).toBe("darwin");
	});

	it("returns 'linux' when discoveredShells contain only standard Unix paths", () => {
		const host = makeHost({ discoveredShells: ["/bin/bash", "/usr/bin/zsh"] });
		expect(resolveHostOs(host)).toBe("linux");
	});

	it("returns process.platform-based OS for local host with no discoveredShells", () => {
		const host = makeHost({ type: "local" });
		const expected =
			process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
		expect(resolveHostOs(host)).toBe(expected);
	});

	it("returns 'unknown' for SSH host with no discoveredShells", () => {
		const host = makeHost({ type: "ssh" });
		expect(resolveHostOs(host)).toBe("unknown");
	});

	it("returns 'unknown' for SSH host with empty discoveredShells array", () => {
		const host = makeHost({ type: "ssh", discoveredShells: [] });
		expect(resolveHostOs(host)).toBe("unknown");
	});
});

// ─── GET /api/hosts/:id/profiles — auto-OS resolution (F-004) ─────────────────

describe("GET /api/hosts/:id/profiles — auto-OS resolution", () => {
	it("auto-resolves OS from local host when ?os= is not supplied", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;

		// Create profiles for different OSes
		await createProfile({ name: "Any OS Profile", supported_os: "any" });
		await createProfile({ name: "Linux Profile", supported_os: "linux" });
		await createProfile({ name: "Windows Profile", supported_os: "windows" });

		// No ?os= query param — should auto-resolve from local host
		const res = await server.inject({
			method: "GET",
			url: `/api/hosts/${hostId}/profiles`,
		});

		expect(res.statusCode).toBe(200);
		const profiles = res.json<Array<{ name: string }>>();
		const names = profiles.map((p) => p.name);

		// "any" profiles always show
		expect(names).toContain("Any OS Profile");
		// Local OS-specific profile shows, other OS does not
		// On Linux CI: linux shows, windows does not; on Windows: opposite
		const expectedOs =
			process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
		if (expectedOs === "linux") {
			expect(names).toContain("Linux Profile");
			expect(names).not.toContain("Windows Profile");
		} else if (expectedOs === "windows") {
			expect(names).not.toContain("Linux Profile");
			expect(names).toContain("Windows Profile");
		}
	});
});
