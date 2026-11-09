import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { getTestTls } from "../test-tls.fixture.js";

let dbs: DatabaseManager;
let server: FastifyInstance;
let meta: MetaDAL;

beforeEach(async () => {
	dbs = openTestDatabases();
	meta = new MetaDAL(dbs.meta);
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

type Method = "GET" | "POST" | "PUT" | "PATCH";

/** A body as a value, or as the exact text sent with a JSON content type. */
type Body = { value: unknown } | { raw: string } | undefined;

async function send(method: Method, url: string, body?: Body) {
	if (body === undefined) return server.inject({ method, url });
	const payload = "raw" in body ? body.raw : JSON.stringify(body.value);
	return server.inject({
		method,
		url,
		payload,
		headers: { "content-type": "application/json" },
	});
}

function refusal(message: string, code = "VALIDATION_ERROR") {
	return { error: { code, message } };
}

async function createHost(fields: Record<string, unknown> = {}): Promise<string> {
	const res = await send("POST", "/api/hosts", {
		value: { type: "local", label: `h${Math.random().toString(36).slice(2, 8)}`, ...fields },
	});
	expect(res.statusCode, res.body).toBe(201);
	return res.json<{ id: string }>().id;
}

/** `levels` objects nested inside one another, `inner` at the bottom, as JSON text. */
function nested(levels: number, inner = '"x"'): string {
	return `${'{"a":'.repeat(levels)}${inner}${"}".repeat(levels)}`;
}

// ─── A body that is not an object (#798) ─────────────────────────────────────

describe("the host routes refuse a body that is not an object (#798)", () => {
	async function routes(): Promise<Array<[name: string, method: Method, url: string]>> {
		const hostId = await createHost();
		const profileId = (
			await send("POST", "/api/launch-profiles", { value: { name: "p", shell: "/bin/sh" } })
		).json<{ id: string }>().id;
		meta.createSession({ id: "ses-body", hostId, status: "starting" });
		meta.createChannel({ id: "ch-body", sessionId: "ses-body", status: "born" });
		return [
			["POST /api/hosts", "POST", "/api/hosts"],
			["PUT /api/hosts/:id", "PUT", `/api/hosts/${hostId}`],
			["PUT /api/hosts/order", "PUT", "/api/hosts/order"],
			[
				"PUT /api/hosts/:id/profiles/:profileId",
				"PUT",
				`/api/hosts/${hostId}/profiles/${profileId}`,
			],
			["PUT /api/hosts/:id/welcome", "PUT", `/api/hosts/${hostId}/welcome`],
			["PATCH /api/hosts/:id/profile", "PATCH", `/api/hosts/${hostId}/profile`],
			["PATCH /api/channels/:id/profile", "PATCH", "/api/channels/ch-body/profile"],
		];
	}

	const bodies: Array<[name: string, body: Body]> = [
		["no body", undefined],
		["null", { raw: "null" }],
		["an array", { raw: "[]" }],
		["a string", { raw: '"x"' }],
	];

	it("answers 400 for each route and each body, with the project's error shape", async () => {
		const all = await routes();
		const seen: string[] = [];
		for (const [route, method, url] of all) {
			for (const [name, body] of bodies) {
				const res = await send(method, url, body);
				seen.push(`${route}, ${name}: ${res.statusCode} ${res.body}`);
			}
		}
		const expected = all.flatMap(([route]) =>
			bodies.map(
				([name]) => `${route}, ${name}: 400 ${JSON.stringify(refusal("body must be an object"))}`,
			),
		);
		expect(seen).toEqual(expected);
	});

	it("answers 400 for a null profile on both profile PATCH routes", async () => {
		const all = await routes();
		for (const [, method, url] of all.filter(([route]) => route.startsWith("PATCH"))) {
			const res = await send(method, url, { value: { profile: null } });
			expect(res.statusCode, url).toBe(400);
			expect(res.json(), url).toEqual(refusal("body.profile must be an object"));
		}
	});
});

// ─── Ids that name nothing (#798) ────────────────────────────────────────────

describe("the host routes refuse an id that names nothing (#798)", () => {
	const UNKNOWN = "01JZZZZZZZZZZZZZZZZZZZZZZZ";

	it("POST refuses an unknown group or jump host, and creates nothing", async () => {
		const before = (await send("GET", "/api/hosts")).json<unknown[]>().length;

		const group = await send("POST", "/api/hosts", {
			value: { type: "local", label: "grouped", host_group_id: UNKNOWN },
		});
		expect(group.statusCode).toBe(400);
		expect(group.json()).toEqual(refusal("host_group_id names no host group"));

		const jump = await send("POST", "/api/hosts", {
			value: {
				type: "ssh",
				label: "jumped",
				ssh_host: "example.org",
				ssh_auth: "agent",
				ssh_proxy_host_id: UNKNOWN,
			},
		});
		expect(jump.statusCode).toBe(400);
		expect(jump.json()).toEqual(refusal("ssh_proxy_host_id names no host"));

		expect((await send("GET", "/api/hosts")).json<unknown[]>()).toHaveLength(before);
	});

	it("PUT refuses an unknown group or jump host, and leaves the host as it was", async () => {
		const groupId = (await send("POST", "/api/host-groups", { value: { name: "g" } })).json<{
			id: string;
		}>().id;
		const jumpId = await createHost({
			type: "ssh",
			ssh_host: "bastion.example.org",
			ssh_auth: "agent",
		});
		const id = await createHost({ host_group_id: groupId, ssh_proxy_host_id: jumpId });

		const group = await send("PUT", `/api/hosts/${id}`, { value: { host_group_id: UNKNOWN } });
		expect(group.statusCode).toBe(400);
		expect(group.json()).toEqual(refusal("host_group_id names no host group"));

		const jump = await send("PUT", `/api/hosts/${id}`, { value: { ssh_proxy_host_id: UNKNOWN } });
		expect(jump.statusCode).toBe(400);
		expect(jump.json()).toEqual(refusal("ssh_proxy_host_id names no host"));

		const stored = meta.getHost(id);
		expect(stored?.hostGroupId).toBe(groupId);
		expect(stored?.sshProxyHostId).toBe(jumpId);
	});

	it("PUT /api/hosts/order refuses an unknown group and ids that are not text, and moves nothing", async () => {
		const a = await createHost();
		const b = await createHost();
		const order = () => [meta.getHost(a)?.sortOrder, meta.getHost(b)?.sortOrder];
		const before = order();

		const cases: Array<[body: unknown, message: string]> = [
			[{ group_id: UNKNOWN, host_ids: [b, a] }, "group_id names no host group"],
			[{ group_id: 5, host_ids: [b, a] }, "group_id must be a string or null"],
			[{ group_id: null, host_ids: [{}] }, "host_ids must be a non-empty array of host ids"],
			[{ group_id: null, host_ids: [b, 7] }, "host_ids must be a non-empty array of host ids"],
		];
		for (const [body, message] of cases) {
			const res = await send("PUT", "/api/hosts/order", { value: body });
			expect(res.statusCode, JSON.stringify(body)).toBe(400);
			expect(res.json(), JSON.stringify(body)).toEqual(refusal(message));
		}
		expect(order()).toEqual(before);
	});

	it("a launch profile override refuses a sort order that is not a safe integer, and stores none", async () => {
		const id = await createHost();
		const profileId = (
			await send("POST", "/api/launch-profiles", { value: { name: "p", shell: "/bin/sh" } })
		).json<{ id: string }>().id;
		const url = `/api/hosts/${id}/profiles/${profileId}`;

		for (const sortOrder of [{}, "1", 1.5, 2 ** 53, -(2 ** 53)]) {
			for (const overrideType of ["pin", "default"]) {
				const res = await send("PUT", url, {
					value: { override_type: overrideType, sort_order: sortOrder },
				});
				expect(res.statusCode, `${overrideType} ${String(sortOrder)}`).toBe(400);
				expect(res.json()).toEqual(refusal("sort_order must be an integer"));
				expect(meta.getHostLaunchProfileOverride(id, profileId)).toBeUndefined();
			}
		}

		const accepted = await send("PUT", url, {
			value: { override_type: "pin", sort_order: Number.MAX_SAFE_INTEGER },
		});
		expect(accepted.statusCode).toBe(204);
		expect(meta.getHostLaunchProfileOverride(id, profileId)?.overrideType).toBe("pin");
	});
});

// ─── profile_json: what is stored is what was checked (#848) ─────────────────

describe("POST and PUT /api/hosts store the profile they checked (#848)", () => {
	it("stores the checked object, without the members sent as null, not the text sent", async () => {
		const text = '{ "fontSize" : null, "transferDrop" : "off" }';
		const id = await createHost({ profile_json: text });
		expect(meta.getHostProfile(id)).toBe('{"transferDrop":"off"}');

		meta.updateHostProfile(id, null);
		const put = await send("PUT", `/api/hosts/${id}`, { value: { profile_json: text } });
		expect(put.statusCode, put.body).toBe(200);
		expect(meta.getHostProfile(id)).toBe('{"transferDrop":"off"}');
	});

	it("refuses a profile that is not a JSON object", async () => {
		const id = await createHost();
		for (const text of ["123", "[1]", "null", '"x"']) {
			const post = await send("POST", "/api/hosts", {
				value: { type: "local", label: "notobject", profile_json: text },
			});
			expect(post.statusCode, text).toBe(400);
			expect(post.json(), text).toEqual(refusal("profile_json must be a JSON object"));

			const put = await send("PUT", `/api/hosts/${id}`, { value: { profile_json: text } });
			expect(put.statusCode, text).toBe(400);
			expect(put.json(), text).toEqual(refusal("profile_json must be a JSON object"));
		}
		expect(meta.getHostProfile(id)).toBeNull();
	});

	it("keeps the members the stored profile holds unchanged, null and refused values included", async () => {
		const id = await createHost();
		const stored = {
			fontSize: null,
			transferDrop: "download",
			visualProfile: { tint: { enabled: true, color: "#112233", opacity: 50 } },
		};
		// The text an earlier version's raw route stored, written as it did.
		meta.updateHostProfile(id, JSON.stringify(stored));

		const edited = {
			...stored,
			visualProfile: { ...stored.visualProfile, border: { style: "subtle", color: "#445566" } },
		};
		const kept = await send("PUT", `/api/hosts/${id}`, {
			value: { profile_json: JSON.stringify(edited) },
		});
		expect(kept.statusCode, kept.body).toBe(200);
		expect(JSON.parse(meta.getHostProfile(id) ?? "")).toEqual(edited);

		const changed = await send("PUT", `/api/hosts/${id}`, {
			value: { profile_json: JSON.stringify({ ...edited, transferDrop: "both" }) },
		});
		expect(changed.statusCode).toBe(400);
		expect(changed.json()).toEqual(
			refusal('Invalid value for "transferDrop": "both"', "INVALID_VALUE"),
		);
		expect(JSON.parse(meta.getHostProfile(id) ?? "")).toEqual(edited);
	});

	it("keeps the other stored members when one of them is malformed", async () => {
		const id = await createHost();
		meta.updateHostProfile(id, '{"transferDrop":"download","fontSize":1e400}');

		const res = await send("PUT", `/api/hosts/${id}`, {
			value: { profile_json: '{"transferDrop":"download","fontSize":13}' },
		});
		expect(res.statusCode, res.body).toBe(200);
		expect(JSON.parse(meta.getHostProfile(id) ?? "")).toEqual({
			transferDrop: "download",
			fontSize: 13,
		});
	});

	it("takes the profile Edit Host sends, before and after a setting saved elsewhere", async () => {
		const visualProfile = {
			preset: "custom",
			banner: { enabled: true, text: "{host}", bgColor: "#e06c75", textColor: "#ffffff" },
			border: { style: "subtle", color: "" },
			tint: { enabled: false, color: "#e06c75", opacity: 5 },
		};
		const id = await createHost({ profile_json: JSON.stringify({ visualProfile }) });
		const patched = await send("PATCH", `/api/hosts/${id}/profile`, {
			value: { profile: { transferDrop: "off" } },
		});
		expect(patched.statusCode).toBe(200);

		const profile = {
			transferDrop: "off",
			visualProfile: { ...visualProfile, border: { style: "bold", color: "#123456" } },
		};
		const res = await send("PUT", `/api/hosts/${id}`, {
			value: { profile_json: JSON.stringify(profile) },
		});
		expect(res.statusCode, res.body).toBe(200);
		expect((await send("GET", `/api/hosts/${id}/profile`)).json()).toEqual({ profile });
	});

	it("refuses a number that is not finite and a value nested too deep, and stores nothing", async () => {
		const id = await createHost();
		const cases: Array<[text: string, message: string]> = [
			['{"fontSize":1e400}', 'Invalid value for "fontSize": numbers must be finite'],
			[
				'{"visualProfile":{"tint":{"opacity":1e400}}}',
				'Invalid value for "visualProfile": numbers must be finite',
			],
			[
				`{"themeOverrides":${nested(40)}}`,
				'Invalid value for "themeOverrides": nested more than 32 levels deep',
			],
			[
				`{"transferDrop":${nested(10_000)}}`,
				'Invalid value for "transferDrop": nested more than 32 levels deep',
			],
		];
		for (const [text, message] of cases) {
			const put = await send("PUT", `/api/hosts/${id}`, { value: { profile_json: text } });
			expect(put.statusCode, message).toBe(400);
			expect(put.json(), message).toEqual(refusal(message, "INVALID_VALUE"));

			const post = await send("POST", "/api/hosts", {
				value: { type: "local", label: "deep", profile_json: text },
			});
			expect(post.statusCode, message).toBe(400);
			expect(post.json(), message).toEqual(refusal(message, "INVALID_VALUE"));
		}
		expect(meta.getHostProfile(id)).toBeNull();
		expect(meta.getHostByLabel("deep")).toBeUndefined();
	});
});
