import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.fixture.js";
import { resolveHostOs } from "../session/host-profile-menu.js";
import { seedShellProfiles } from "../session/shell-profile-seed.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { getTestTls } from "../test-tls.fixture.js";
import {
	type CreateLaunchProfileBody,
	launchProfileOverridesError,
	type UpdateLaunchProfileBody,
	validateCreateBody,
	validateUpdateBody,
} from "./launch-profiles.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../ssh/ssh-config-parser.js", () => ({
	readSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
	parseSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
}));

vi.mock("ssh2", () => ({
	// Extended as the key-auth agent signer loads (#876).
	BaseAgent: class {},
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

/** A whole hub server, for the describes that test a route through one. */
function useHubServer(): void {
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
}

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
	useHubServer();

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
	useHubServer();

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

	// Each rule of validateCreateBody is unit-tested below; this proves the route
	// consults it and answers with its message.
	it("refuses a profile validateCreateBody rejects, with its message (SC-35)", async () => {
		const payload = { name: "Injection", shell: "/bin/bash; rm -rf /" };
		const res = await server.inject({ method: "POST", url: "/api/launch-profiles", payload });
		expect(res.statusCode).toBe(400);
		expect(res.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message: validateCreateBody(payload) },
		});
	});
});

// ─── validateCreateBody — the rules POST /api/launch-profiles applies ─────────
//
// Asserted where they live, so a broken rule fails under its own name. The
// shell rules themselves belong to validateShell, unit-tested in @lasterm/shared.

describe("validateCreateBody", () => {
	/** A body as a client sends it: JSON, which the interface does not police. */
	function body(fields: Record<string, unknown>): CreateLaunchProfileBody {
		return fields as unknown as CreateLaunchProfileBody;
	}

	it("accepts a name and a shell (SC-02)", () => {
		expect(validateCreateBody(body({ name: "Min", shell: "/bin/bash" }))).toBeNull();
	});

	it("accepts a plain executable path such as /usr/bin/env", () => {
		expect(validateCreateBody(body({ name: "Parens", shell: "/usr/bin/env" }))).toBeNull();
	});

	it("refuses a missing name", () => {
		expect(validateCreateBody(body({ shell: "/bin/bash" }))).toBe("name is required");
	});

	it("refuses an empty shell (SC-04)", () => {
		expect(validateCreateBody(body({ name: "Bad", shell: "" }))).toBe("shell must not be empty");
	});

	it("refuses a missing shell, as an empty one", () => {
		expect(validateCreateBody(body({ name: "NoShell" }))).toBe("shell must not be empty");
	});

	it.each([
		["a semicolon", "Injection", "/bin/bash; rm -rf /"],
		["a pipe", "Pipe", "/bin/bash | cat"],
		["an ampersand", "Amp", "/bin/bash & evil"],
	])("refuses a shell with %s (SC-35)", (_what, name, shell) => {
		expect(validateCreateBody(body({ name, shell }))).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("refuses a color that is not #rrggbb", () => {
		expect(validateCreateBody(body({ name: "BadColor", shell: "/bin/bash", color: "red" }))).toBe(
			"color must be in hex format #rrggbb",
		);
	});

	it("takes report_directory as true or false, or none, and refuses anything else (#839)", () => {
		const pwsh = { name: "PowerShell", shell: "/usr/bin/pwsh" };
		for (const report_directory of [true, false, null, undefined]) {
			expect(validateCreateBody(body({ ...pwsh, report_directory }))).toBeNull();
		}
		for (const report_directory of ["yes", 1, 0, "true", {}]) {
			expect(validateCreateBody(body({ ...pwsh, report_directory }))).toBe(
				"report_directory must be true or false",
			);
		}
	});

	it("takes sort_order as a safe integer, or none, and refuses anything else (#916)", () => {
		const min = { name: "Min", shell: "/bin/bash" };
		for (const sort_order of [-3, 0, null, undefined]) {
			expect(validateCreateBody(body({ ...min, sort_order }))).toBeNull();
		}
		for (const sort_order of [1.5, 2 ** 53 + 2, "7"]) {
			expect(validateCreateBody(body({ ...min, sort_order }))).toBe(
				"sort_order must be an integer",
			);
		}
	});
});

describe("a launch profile's report_directory through the routes (#839)", () => {
	useHubServer();

	it("is off unless asked, stored as given, and changed by a PUT that names it only", async () => {
		const plain = await createProfile({ name: "PowerShell", shell: "/usr/bin/pwsh" });
		expect(plain.report_directory).toBe(false);

		const reporting = await createProfile({
			name: "PowerShell, reporting",
			shell: "/usr/bin/pwsh",
			report_directory: true,
		});
		expect(reporting.report_directory).toBe(true);
		const url = `/api/launch-profiles/${reporting.id}`;
		const read = (await server.inject({ method: "GET", url })).json<Record<string, unknown>>();
		expect(read.report_directory).toBe(true);

		const renamed = await server.inject({ method: "PUT", url, payload: { name: "Renamed" } });
		expect(renamed.json<Record<string, unknown>>().report_directory).toBe(true);

		const off = await server.inject({ method: "PUT", url, payload: { report_directory: false } });
		expect(off.statusCode).toBe(200);
		expect(off.json<Record<string, unknown>>().report_directory).toBe(false);

		const payload = { report_directory: "yes" };
		const refused = await server.inject({ method: "PUT", url, payload });
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: validateUpdateBody(payload as unknown as UpdateLaunchProfileBody),
			},
		});
	});
});

// ─── validateUpdateBody — the rules PUT /api/launch-profiles/:id applies ──────

describe("validateUpdateBody", () => {
	/** A body as a client sends it: JSON, which the interface does not police. */
	function body(fields: Record<string, unknown>): UpdateLaunchProfileBody {
		return fields as unknown as UpdateLaunchProfileBody;
	}

	it("accepts a body that changes nothing, or one field", () => {
		expect(validateUpdateBody(body({}))).toBeNull();
		expect(validateUpdateBody(body({ name: "Renamed" }))).toBeNull();
		expect(validateUpdateBody(body({ color: "#A0b1C2" }))).toBeNull();
	});

	it("accepts null on a field that may be empty, which clears it (#665)", () => {
		for (const field of ["args", "cwd", "env", "icon_value", "color", "profile_overrides"]) {
			expect(validateUpdateBody(body({ [field]: null }))).toBeNull();
		}
	});

	it("refuses null on a field that always holds a value", () => {
		for (const field of [
			"mode",
			"elevated",
			"supported_os",
			"icon_type",
			"sort_order",
			"report_directory",
		]) {
			expect(validateUpdateBody(body({ [field]: null }))).toBe(`${field} cannot be cleared`);
		}
	});

	it("takes report_directory as true or false only (#839)", () => {
		expect(validateUpdateBody(body({ report_directory: true }))).toBeNull();
		expect(validateUpdateBody(body({ report_directory: false }))).toBeNull();
		expect(validateUpdateBody(body({ report_directory: "false" }))).toBe(
			"report_directory must be true or false",
		);
	});

	it("takes sort_order as a safe integer only (#916)", () => {
		for (const sort_order of [-3, 0]) {
			expect(validateUpdateBody(body({ sort_order }))).toBeNull();
		}
		for (const sort_order of [1.5, 2 ** 53 + 2, "7"]) {
			expect(validateUpdateBody(body({ sort_order }))).toBe("sort_order must be an integer");
		}
	});

	it("refuses an empty or missing name, and a shell POST would refuse", () => {
		for (const name of ["", "   ", null, "x".repeat(101)]) {
			expect(validateUpdateBody(body({ name }))).toBe("name must be 1-100 characters");
		}
		expect(validateUpdateBody(body({ shell: "" }))).toBe("shell must not be empty");
		expect(validateUpdateBody(body({ shell: null }))).toBe("shell must not be empty");
		expect(validateUpdateBody(body({ shell: "/bin/bash; evil" }))).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("refuses a colour that is not #rrggbb, the empty string included", () => {
		for (const color of ["red", "", "#fff"]) {
			expect(validateUpdateBody(body({ color }))).toBe("color must be in hex format #rrggbb");
		}
	});

	it("applies the rules POST applies to the other fields", () => {
		expect(validateUpdateBody(body({ cwd: "x".repeat(1025) }))).toBe(
			"cwd must be 1024 characters or fewer",
		);
		expect(validateUpdateBody(body({ icon_value: "x".repeat(257) }))).toBe(
			"icon_value must be 256 characters or fewer",
		);
		expect(validateUpdateBody(body({ args: "not-an-array" }))).toBe(
			"args must be an array of at most 64 items",
		);
		expect(validateUpdateBody(body({ mode: "daemon" }))).toBe("mode must be 'shell' or 'process'");
		expect(validateUpdateBody(body({ supported_os: "beos" }))).toBe(
			"supported_os must be 'linux', 'darwin', 'windows', or 'any'",
		);
		expect(validateUpdateBody(body({ icon_type: "svg" }))).toBe(
			"icon_type must be 'auto', 'emoji', or 'image'",
		);
	});
});

// ─── launchProfileOverridesError — the check of profile_overrides (#916) ───────

describe("launchProfileOverridesError", () => {
	it("passes none, null and an object the profile writes accept", () => {
		expect(launchProfileOverridesError(undefined)).toBeNull();
		expect(launchProfileOverridesError(null)).toBeNull();
		expect(launchProfileOverridesError({ fontSize: 14, transferDrop: "upload" })).toBeNull();
	});

	it("refuses what is not an object", () => {
		for (const value of [[], "x", 1]) {
			expect(launchProfileOverridesError(value)).toEqual({
				code: "VALIDATION_ERROR",
				message: "profile_overrides must be an object",
			});
		}
	});

	it("refuses what a terminal's profile write refuses, with its code", () => {
		let nested: unknown = 1;
		for (let i = 0; i < 33; i++) nested = [nested];
		expect(launchProfileOverridesError({ nope: 1 })).toEqual({
			code: "VALIDATION_ERROR",
			message: "Unknown profile key: nope",
		});
		expect(launchProfileOverridesError({ transferVerify: true })).toEqual({
			code: "VALIDATION_ERROR",
			message: '"transferVerify" is set globally or for a host, not for one terminal',
		});
		expect(launchProfileOverridesError({ transferDrop: "bogus" })).toEqual({
			code: "INVALID_VALUE",
			message: 'Invalid value for "transferDrop": "bogus"',
		});
		expect(launchProfileOverridesError({ fontSize: Number.POSITIVE_INFINITY })).toEqual({
			code: "INVALID_VALUE",
			message: 'Invalid value for "fontSize": numbers must be finite',
		});
		expect(launchProfileOverridesError({ themeOverrides: nested })).toEqual({
			code: "INVALID_VALUE",
			message: 'Invalid value for "themeOverrides": nested more than 32 levels deep',
		});
	});
});

// ─── What the launch profile routes refuse (#916) ─────────────────────────────

describe("the launch profile routes refuse what they cannot store or read back (#916)", () => {
	useHubServer();

	/** A request whose JSON body is sent as written: 1e400 and 2^53+2 have no JS literal. */
	async function send(
		method: "POST" | "PUT",
		url: string,
		body?: string,
	): Promise<{ status: number; json: unknown }> {
		const res = await server.inject({
			method,
			url,
			...(body !== undefined && {
				payload: body,
				headers: { "content-type": "application/json" },
			}),
		});
		return { status: res.statusCode, json: res.body === "" ? undefined : res.json() };
	}

	function refusal(code: string, message: string): { status: number; json: unknown } {
		return { status: 400, json: { error: { code, message } } };
	}

	type WireProfile = Record<string, unknown> & { id: string; name: string };

	async function launchProfiles(): Promise<WireProfile[]> {
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles" });
		expect(res.statusCode).toBe(200);
		return res.json<WireProfile[]>();
	}

	async function hostProfiles(): Promise<WireProfile[]> {
		const hosts = (await server.inject({ method: "GET", url: "/api/hosts" })).json<
			Array<{ id: string; type: string }>
		>();
		const local = hosts.find((h) => h.type === "local");
		if (!local) throw new Error("local host not found");
		const res = await server.inject({ method: "GET", url: `/api/hosts/${local.id}/profiles` });
		expect(res.statusCode).toBe(200);
		return res.json<WireProfile[]>();
	}

	/** The row by name, read from both lists, which must agree on its overrides. */
	async function inBothLists(name: string): Promise<WireProfile | undefined> {
		const listed = (await launchProfiles()).find((p) => p.name === name);
		const onHost = (await hostProfiles()).find((p) => p.name === name);
		expect(onHost?.profile_overrides).toEqual(listed?.profile_overrides);
		return listed;
	}

	const deep = (n: number): string => `${"[".repeat(n)}1${"]".repeat(n)}`;

	it("refuses a body that is not an object on the launch profile routes (#916)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const profile = await createProfile({ name: "Kept" });
			vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
			const notObject = refusal("VALIDATION_ERROR", "body must be an object");
			const url = `/api/launch-profiles/${profile.id}`;
			for (const body of [undefined, "null", "[]", "true"]) {
				expect(await send("POST", "/api/launch-profiles", body)).toEqual(notObject);
				expect(await send("PUT", url, body)).toEqual(notObject);
				expect(await send("PUT", "/api/launch-profiles/order", body)).toEqual(notObject);
			}
			const listed = await launchProfiles();
			expect(listed.map((p) => p.name)).toEqual(["Kept"]);
			expect(listed[0]?.updated_at).toBe("2026-01-01T00:00:00.000Z");
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses a profile_overrides the profile writes refuse, and stores nothing (#916)", async () => {
		const tooDeep = 'Invalid value for "themeOverrides": nested more than 32 levels deep';
		const cases: Array<[string, string, string]> = [
			['{"nope":1}', "VALIDATION_ERROR", "Unknown profile key: nope"],
			[
				'{"transferVerify":true}',
				"VALIDATION_ERROR",
				'"transferVerify" is set globally or for a host, not for one terminal',
			],
			['{"transferDrop":"bogus"}', "INVALID_VALUE", 'Invalid value for "transferDrop": "bogus"'],
			[
				'{"fontSize":1e400}',
				"INVALID_VALUE",
				'Invalid value for "fontSize": numbers must be finite',
			],
			[`{"themeOverrides":${deep(33)}}`, "INVALID_VALUE", tooDeep],
			[`{"themeOverrides":${deep(5000)}}`, "INVALID_VALUE", tooDeep],
			["[1,2]", "VALIDATION_ERROR", "profile_overrides must be an object"],
			['"x"', "VALIDATION_ERROR", "profile_overrides must be an object"],
		];
		for (const [overrides, code, message] of cases) {
			const body = `{"name":"Refused","shell":"/bin/bash","profile_overrides":${overrides}}`;
			expect(await send("POST", "/api/launch-profiles", body)).toEqual(refusal(code, message));
			expect(await inBothLists("Refused")).toBeUndefined();
		}
	});

	it("refuses on PUT what POST refuses in profile_overrides (#916)", async () => {
		const profile = await createProfile({ name: "Edited", profile_overrides: { fontSize: 12 } });
		const body = '{"profile_overrides":{"transferDrop":"bogus"}}';
		expect(await send("PUT", `/api/launch-profiles/${profile.id}`, body)).toEqual(
			refusal("INVALID_VALUE", 'Invalid value for "transferDrop": "bogus"'),
		);
		expect((await inBothLists("Edited"))?.profile_overrides).toEqual({ font_size: 12 });
	});

	it("stores, replaces and clears the profile_overrides the web form sends (#916)", async () => {
		const profile = await createProfile({
			name: "Form",
			profile_overrides: {
				fontFamily: "Consolas",
				fontSize: 14,
				cursorStyle: "bar",
				scrollback: 5000,
				envMode: "inherit",
				transferDrop: "upload",
			},
		});
		const asSent = {
			font_family: "Consolas",
			font_size: 14,
			cursor_style: "bar",
			scrollback: 5000,
			env_mode: "inherit",
			transfer_drop: "upload",
		};
		expect((await inBothLists("Form"))?.profile_overrides).toEqual(asSent);
		const url = `/api/launch-profiles/${profile.id}`;

		expect((await send("PUT", url, '{"name":"Form2"}')).status).toBe(200);
		expect((await inBothLists("Form2"))?.profile_overrides).toEqual(asSent);

		expect((await send("PUT", url, '{"profile_overrides":{"fontSize":16}}')).status).toBe(200);
		expect((await inBothLists("Form2"))?.profile_overrides).toEqual({ font_size: 16 });

		expect((await send("PUT", url, '{"profile_overrides":null}')).status).toBe(200);
		const cleared = await inBothLists("Form2");
		expect(cleared).toBeDefined();
		expect(cleared).not.toHaveProperty("profile_overrides");
	});

	it("treats a null member of profile_overrides as the profile writes do (#916)", async () => {
		const post = (name: string, overrides: string) =>
			send(
				"POST",
				"/api/launch-profiles",
				`{"name":"${name}","shell":"/bin/bash","profile_overrides":${overrides}}`,
			);
		expect((await post("Known", '{"fontSize":null}')).status).toBe(201);
		expect((await inBothLists("Known"))?.profile_overrides).toEqual({ font_size: null });

		expect(await post("Unknown", '{"nope":null}')).toEqual(
			refusal("VALIDATION_ERROR", "Unknown profile key: nope"),
		);
		expect(await inBothLists("Unknown")).toBeUndefined();

		expect((await post("HostOnly", '{"transferVerify":null}')).status).toBe(201);

		const none = await post("None", "null");
		expect(none.status).toBe(201);
		expect(none.json).not.toHaveProperty("profile_overrides");
	});

	it("keeps 404 first and every 400 before a 409 (#916)", async () => {
		expect(await send("PUT", "/api/launch-profiles/unknown-id", "null")).toEqual({
			status: 404,
			json: { error: { code: "NOT_FOUND", message: "Launch profile not found" } },
		});
		const a = await createProfile({ name: "A" });
		await createProfile({ name: "B" });
		const unknownKey = refusal("VALIDATION_ERROR", "Unknown profile key: nope");
		const taken = '{"name":"A","shell":"/bin/bash","profile_overrides":{"nope":1}}';
		expect(await send("POST", "/api/launch-profiles", taken)).toEqual(unknownKey);
		const renamed = '{"name":"B","profile_overrides":{"nope":1}}';
		expect(await send("PUT", `/api/launch-profiles/${a.id}`, renamed)).toEqual(unknownKey);
		expect((await launchProfiles()).map((p) => p.name).sort()).toEqual(["A", "B"]);
	});

	it("refuses a sort_order that is not a safe integer, keeping the lists readable (#916)", async () => {
		const notInteger = refusal("VALIDATION_ERROR", "sort_order must be an integer");
		for (const sortOrder of ["9007199254740994", "1.5", '"7"']) {
			const body = `{"name":"Refused","shell":"/bin/bash","sort_order":${sortOrder}}`;
			expect(await send("POST", "/api/launch-profiles", body)).toEqual(notInteger);
			expect(await inBothLists("Refused")).toBeUndefined();
		}
		const kept = await createProfile({ name: "Kept", sort_order: 4 });
		const unsafe = '{"sort_order":9007199254740994}';
		expect(await send("PUT", `/api/launch-profiles/${kept.id}`, unsafe)).toEqual(notInteger);
		expect((await inBothLists("Kept"))?.sort_order).toBe(4);

		expect((await createProfile({ name: "Negative", sort_order: -3 })).sort_order).toBe(-3);
		expect((await createProfile({ name: "Omitted" })).sort_order).toBe(0);
		expect((await createProfile({ name: "Null", sort_order: null })).sort_order).toBe(0);
	});

	it("refuses ids that are not all strings (#916)", async () => {
		await createProfile({ name: "A", sort_order: 5 });
		const b = await createProfile({ name: "B", sort_order: 6 });
		const notStrings = refusal("VALIDATION_ERROR", "ids must be an array of strings");
		for (const ids of ["[{}]", `["${b.id}",7]`, '"x"']) {
			const res = await send("PUT", "/api/launch-profiles/order", `{"ids":${ids}}`);
			expect(res).toEqual(notStrings);
		}
		expect((await launchProfiles()).find((p) => p.id === b.id)?.sort_order).toBe(6);
	});
});

// ─── GET /api/launch-profiles/:id ─────────────────────────────────────────────

describe("GET /api/launch-profiles/:id", () => {
	useHubServer();

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
	useHubServer();

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

	// validateUpdateBody is unit-tested above; this proves the route consults it,
	// and stores the clears the profile form sends (#665).
	it("stores the fields given as null as none, keeps the others, and refuses what the validator refuses", async () => {
		const created = await createProfile({
			name: "ClearMe",
			args: ["-l"],
			cwd: "/srv",
			env: { KEEP: "1" },
			icon_type: "emoji",
			icon_value: "🐚",
			color: "#123456",
		});
		const url = `/api/launch-profiles/${created.id}`;

		const cleared = await server.inject({
			method: "PUT",
			url,
			payload: { cwd: null, icon_value: null, color: null },
		});
		expect(cleared.statusCode).toBe(200);

		const stored = (await server.inject({ method: "GET", url })).json<Record<string, unknown>>();
		expect(stored).not.toHaveProperty("cwd");
		expect(stored).not.toHaveProperty("icon_value");
		expect(stored).not.toHaveProperty("color");
		expect(stored).toMatchObject({
			name: "ClearMe",
			args: ["-l"],
			env: { KEEP: "1" },
			icon_type: "emoji",
		});

		const payload = { color: "" };
		const refused = await server.inject({ method: "PUT", url, payload });
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message: validateUpdateBody(payload) },
		});
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
	useHubServer();

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
	useHubServer();

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
		expect(res.json()).toEqual({
			error: { code: "VALIDATION_ERROR", message: "ids must be an array of strings" },
		});
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
	useHubServer();

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
	useHubServer();

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

	// "Set as Default" lasted until the host's agent connected again (#800).
	it("keeps a default set here when the host's agent connects again", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string; type: string }>>();
		const localHost = hosts.find((h) => h.type === "local");
		if (!localHost) throw new Error("local host not found");
		const hostId = localHost.id;
		const dal = new MetaDAL(dbs.meta);
		// The seeding reports what it seeded on stderr
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		const connect = () =>
			seedShellProfiles(hostId, ["/bin/bash", "/usr/bin/fish"], "/bin/bash", "linux", dal);
		await connect();
		const fishId = dal.getLaunchProfileByName("fish")?.id ?? "";

		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${fishId}`,
			payload: { override_type: "default" },
		});
		await connect();
		quiet.mockRestore();

		expect(res.statusCode).toBe(204);
		const profiles = (
			await server.inject({ method: "GET", url: `/api/hosts/${hostId}/profiles?os=linux` })
		).json<Array<{ name: string; override_type?: string }>>();
		expect(profiles.filter((p) => p.override_type === "default").map((p) => p.name)).toEqual([
			"fish",
		]);
		expect(dal.getHostDefaultOverride(hostId)?.setByUser).toBe(true);
	});
});

describe("DELETE /api/hosts/:id/profiles/:profileId", () => {
	useHubServer();

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

// ─── One default per host: what Edit Host's Default Shell saves (#802) ────────
//
// Edit Host's Default Shell and Settings › Profiles › "Set as Default" save the
// same mark, through these routes: PUT `default` for a profile, DELETE of the
// user's default for "Automatic", which gives the host its agent's default.

describe("a host's default profile through the hosts' profile routes (#802)", () => {
	useHubServer();

	interface MenuEntry {
		id: string;
		name: string;
		override_type?: string;
		set_by_user?: boolean;
	}

	let hostId: string;
	let dal: MetaDAL;
	const id = (name: string) => dal.getLaunchProfileByName(name)?.id ?? "";
	const menu = async () =>
		(await server.inject({ method: "GET", url: `/api/hosts/${hostId}/profiles?os=linux` })).json<
			MenuEntry[]
		>();

	beforeEach(async () => {
		const hosts = (await server.inject({ method: "GET", url: "/api/hosts" })).json<
			Array<{ id: string; type: string }>
		>();
		const local = hosts.find((h) => h.type === "local");
		if (!local) throw new Error("local host not found");
		hostId = local.id;
		dal = new MetaDAL(dbs.meta);
		// A connection, as the hub records it: its agent reported bash.
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		dal.updateHostDiscoveredShells(hostId, ["/bin/bash", "/usr/bin/fish"], "/bin/bash");
		await seedShellProfiles(hostId, ["/bin/bash", "/usr/bin/fish"], "/bin/bash", "linux", dal);
		quiet.mockRestore();
	});

	it("lists the default first, and says whose mark each override is", async () => {
		expect((await menu())[0]).toMatchObject({
			name: "bash",
			override_type: "default",
			set_by_user: false,
		});

		await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${id("fish")}`,
			payload: { override_type: "default" },
		});

		const listed = await menu();
		expect(listed[0]).toMatchObject({ name: "fish", override_type: "default", set_by_user: true });
		// A profile with no override says nothing of whose it is.
		expect(listed.find((p) => p.name === "bash")).not.toHaveProperty("set_by_user");
	});

	it("gives the host its agent's default again at once when the user's is removed: Automatic", async () => {
		await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${id("fish")}`,
			payload: { override_type: "default" },
		});

		const res = await server.inject({
			method: "DELETE",
			url: `/api/hosts/${hostId}/profiles/${id("fish")}`,
		});

		expect(res.statusCode).toBe(204);
		expect((await menu())[0]).toMatchObject({
			name: "bash",
			override_type: "default",
			set_by_user: false,
		});
	});

	it("gives it back at once when the user's default turns into a pin, or its profile is deleted", async () => {
		await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${id("fish")}`,
			payload: { override_type: "default" },
		});
		await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${id("fish")}`,
			payload: { override_type: "pin" },
		});
		expect((await menu())[0]).toMatchObject({ name: "bash", set_by_user: false });

		await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}/profiles/${id("fish")}`,
			payload: { override_type: "default" },
		});
		const deleted = await server.inject({
			method: "DELETE",
			url: `/api/launch-profiles/${id("fish")}`,
		});
		expect(deleted.statusCode).toBe(204);
		expect((await menu())[0]).toMatchObject({ name: "bash", set_by_user: false });
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
			os: null,
			arch: null,
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
	useHubServer();

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
