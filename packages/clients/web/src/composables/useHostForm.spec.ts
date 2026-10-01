import type { Host } from "@lasterm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { iconFields, proxyFields, useHostForm } from "./useHostForm.js";

const testWsClient = vi.hoisted(() => ({ on: vi.fn(), send: vi.fn() }));
const createHostSpy = vi.fn().mockResolvedValue({ id: "test-id", label: "test" });
const updateHostSpy = vi.fn().mockResolvedValue({ id: "test-id", label: "test" });

vi.mock("../stores/hosts.js", () => ({
	useHostsStore: () => ({
		hosts: [],
		createHost: createHostSpy,
		updateHost: updateHostSpy,
	}),
}));

vi.mock("../stores/auth.js", () => ({
	useAuthStore: () => ({ token: "test-token" }),
}));

vi.mock("../stores/session.js", () => ({
	useSessionStore: () => ({ wsClient: testWsClient }),
}));

describe("useHostForm", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		testWsClient.on.mockReset();
		testWsClient.send.mockReset();
	});

	function testConnectionHarness(): {
		respondOk: (index: number, os: string) => Promise<void>;
		respondFail: (index: number) => Promise<void>;
	} {
		const handlers = new Map<
			string,
			Array<
				(message: {
					type: string;
					hostId: string;
					platform?: { os: string; system: string; agent: "ready"; agentVersion: string };
					message?: string;
				}) => void
			>
		>();
		testWsClient.on.mockImplementation(
			(
				type: string,
				handler: (message: {
					type: string;
					hostId: string;
					platform?: { os: string; system: string; agent: "ready"; agentVersion: string };
					message?: string;
				}) => void,
			) => {
				const current = handlers.get(type) ?? [];
				current.push(handler);
				handlers.set(type, current);
				return () =>
					handlers.set(
						type,
						current.filter((candidate) => candidate !== handler),
					);
			},
		);
		function messageAt(index: number): { hostId: string } {
			const message = testWsClient.send.mock.calls[index]?.[0];
			if (!message || typeof message.hostId !== "string") {
				throw new Error(`No test-connection request at index ${index}`);
			}
			return { hostId: message.hostId };
		}
		return {
			respondOk: async (index, os) => {
				await vi.waitFor(() => expect(testWsClient.send).toHaveBeenCalledTimes(index + 1));
				const { hostId } = messageAt(index);
				for (const handler of handlers.get("TEST_CONNECT_OK") ?? []) {
					handler({
						type: "TEST_CONNECT_OK",
						hostId,
						platform: { os, system: os, agent: "ready", agentVersion: "test" },
					});
				}
			},
			respondFail: async (index) => {
				await vi.waitFor(() => expect(testWsClient.send).toHaveBeenCalledTimes(index + 1));
				const { hostId } = messageAt(index);
				for (const handler of handlers.get("TEST_CONNECT_FAIL") ?? []) {
					handler({ type: "TEST_CONNECT_FAIL", hostId, message: "failed" });
				}
			},
		};
	}

	describe("SC-09: port placeholder behavior", () => {
		it("new host form has undefined sshPort", () => {
			const { form } = useHostForm();
			expect(form.value.sshPort).toBeUndefined();
		});

		it("editing host preserves existing port", () => {
			const editHost = {
				id: "h1",
				label: "myhost",
				type: "ssh" as const,
				sshHost: "10.0.0.1",
				sshPort: 2222,
				sshUser: "admin",
				sshAuth: "key" as const,
				sshKeyPath: "~/.ssh/id_rsa",
				iconType: "auto" as const,
				iconValue: "",
				color: "",
				hostGroup: "",
				defaultShell: "",
				trustRemoteHints: "apply" as const,
				sortOrder: 0,
				os: null as null,
				arch: null as null,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			};
			const { form } = useHostForm(editHost);
			expect(form.value.sshPort).toBe(2222);
		});
	});

	describe("remote daemon choice for new SSH hosts", () => {
		async function newHostSave(
			change: (form: ReturnType<typeof useHostForm>["form"]["value"]) => void = () => {},
		): Promise<Record<string, unknown>> {
			createHostSpy.mockClear();
			const { form, save } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			change(form.value);
			await save();
			return (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
		}

		it("starts at Yes and saves an explicit true", async () => {
			const { form } = useHostForm();
			expect(form.value.sshRemoteDaemon).toBe("yes");
			expect(await newHostSave()).toHaveProperty("ssh_remote_daemon", true);
		});

		it("saves No as false", async () => {
			expect(
				await newHostSave((form) => {
					form.sshRemoteDaemon = "no";
				}),
			).toHaveProperty("ssh_remote_daemon", false);
		});

		it("saves Follow the global setting as null", async () => {
			expect(
				await newHostSave((form) => {
					form.sshRemoteDaemon = "";
				}),
			).toHaveProperty("ssh_remote_daemon", null);
		});

		it("makes the setting unavailable and saves null for Windows", async () => {
			const { form, sshRemoteDaemonUnavailable } = useHostForm();
			form.value.os = "windows";
			expect(sshRemoteDaemonUnavailable.value).toBe(true);
			expect(
				await newHostSave((newForm) => {
					newForm.os = "windows";
				}),
			).toHaveProperty("ssh_remote_daemon", null);
		});

		it("keeps an explicit No through Windows then Auto", async () => {
			expect(
				await newHostSave((form) => {
					form.sshRemoteDaemon = "no";
					form.os = "windows";
					form.os = null;
				}),
			).toHaveProperty("ssh_remote_daemon", false);
		});

		it("keeps Follow the global setting through Windows then Auto", async () => {
			expect(
				await newHostSave((form) => {
					form.sshRemoteDaemon = "";
					form.os = "windows";
					form.os = null;
				}),
			).toHaveProperty("ssh_remote_daemon", null);
		});

		it("returns the setting to available after a Windows test then a Linux test", async () => {
			const { form, sshRemoteDaemonUnavailable, testConnectionInline } = useHostForm();
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			expect(sshRemoteDaemonUnavailable.value).toBe(true);
			const linux = testConnectionInline();
			await harness.respondOk(1, "linux");
			await linux;
			expect(sshRemoteDaemonUnavailable.value).toBe(false);
			expect(form.value.sshRemoteDaemon).toBe("yes");
		});

		it("returns the setting to the OS-field rule after a Windows test then a failure", async () => {
			const { form, sshRemoteDaemonUnavailable, testConnectionInline } = useHostForm();
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			expect(sshRemoteDaemonUnavailable.value).toBe(true);
			const failed = testConnectionInline();
			await harness.respondFail(1);
			await failed;
			expect(sshRemoteDaemonUnavailable.value).toBe(false);
		});

		it("keeps the Windows rule while a newer test is pending when creating", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;

			const pendingSecondTest = testConnectionInline();
			await vi.waitFor(() => expect(testWsClient.send).toHaveBeenCalledTimes(2));
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			// Catches basing the rule on testResult, which is null while this test is pending.
			expect(body).toHaveProperty("ssh_remote_daemon", null);
			await harness.respondOk(1, "linux");
			await pendingSecondTest;
		});

		it("clears the completed Windows result when a newer test fails", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			const failed = testConnectionInline();
			await harness.respondFail(1);
			await failed;
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			expect(body).toHaveProperty("ssh_remote_daemon", true);
		});

		it("clears the completed Windows result when the host address changes", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			form.value.sshHost = "10.0.0.2";
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			expect(body).toHaveProperty("ssh_remote_daemon", true);
		});

		it("does not trust a Windows result from a test started through a proxy", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			form.value.sshProxy = "jump.example.test";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			expect(body).toHaveProperty("ssh_remote_daemon", true);
		});

		it("clears a completed Windows result when the proxy changes", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			form.value.sshProxy = "jump.example.test";
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			expect(body).toHaveProperty("ssh_remote_daemon", true);
		});

		it("saves null from an unchanged Windows test without a proxy", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			expect(body).toHaveProperty("ssh_remote_daemon", null);
		});

		it("does not trust a Windows result when a proxy is set before its reply", async () => {
			createHostSpy.mockClear();
			const { form, save, testConnectionInline } = useHostForm();
			form.value.label = "daemon-host";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await vi.waitFor(() => expect(testWsClient.send).toHaveBeenCalledTimes(1));
			form.value.sshProxy = "jump.example.test";
			await harness.respondOk(0, "windows");
			await windows;
			await save();

			const body = (createHostSpy.mock.calls[0] as [Record<string, unknown>])[0];
			expect(body).toHaveProperty("ssh_remote_daemon", true);
		});
	});

	describe("SC-10: save omits sshPort when undefined", () => {
		beforeEach(() => {
			createHostSpy.mockClear();
		});

		it("omits ssh_port from API body when sshPort is undefined", async () => {
			const { form, save } = useHostForm();
			form.value.label = "test-host";
			form.value.type = "ssh";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			form.value.sshPort = undefined;

			await save();

			expect(createHostSpy).toHaveBeenCalledOnce();
			const call = createHostSpy.mock.calls[0] as [Record<string, unknown>];
			const body = call[0];
			expect(body).not.toHaveProperty("ssh_port");
		});

		it("includes ssh_port in body when sshPort is a valid number", async () => {
			const { form, save } = useHostForm();
			form.value.label = "test-host";
			form.value.type = "ssh";
			form.value.sshHost = "10.0.0.1";
			form.value.sshAuth = "agent";
			form.value.sshPort = 2222;

			await save();

			expect(createHostSpy).toHaveBeenCalledOnce();
			const call = createHostSpy.mock.calls[0] as [Record<string, unknown>];
			const body = call[0];
			expect(body).toHaveProperty("ssh_port", 2222);
		});
	});

	describe("what a save of an existing host sends", () => {
		const PNG =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

		function storedHost(fields: Partial<Host>): Host {
			return {
				id: "h1",
				label: "myhost",
				type: "ssh",
				sshHost: "10.0.0.1",
				sshAuth: "agent",
				iconType: "auto",
				trustRemoteHints: "apply",
				sortOrder: 0,
				os: null,
				arch: null,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				...fields,
			};
		}

		async function savedBody(
			host: Host,
			edit: (form: ReturnType<typeof useHostForm>["form"]["value"]) => void = () => {},
		): Promise<Record<string, unknown>> {
			updateHostSpy.mockClear();
			const { form, save } = useHostForm(host);
			edit(form.value);
			await save();
			expect(updateHostSpy).toHaveBeenCalledOnce();
			const [id, body] = updateHostSpy.mock.calls[0] as [string, Record<string, unknown>];
			expect(id).toBe(host.id);
			return body;
		}

		it("sends a reset colour as null, which the hub clears (#659)", async () => {
			const body = await savedBody(storedHost({ color: "#ff8800" }), (form) => {
				form.color = "";
			});
			expect(body).toHaveProperty("color", null);
		});

		it("sends a removed image as no icon at all (#659)", async () => {
			const host = storedHost({ iconType: "image", iconValue: PNG });
			const body = await savedBody(host, (form) => {
				form.iconValue = "";
			});
			expect(body).toMatchObject({ icon_type: "auto", icon_value: null });
		});

		it("sends no icon value once the type is back to initials (#659)", async () => {
			const host = storedHost({ iconType: "emoji", iconValue: "🚀" });
			const body = await savedBody(host, (form) => {
				form.iconType = "auto";
			});
			expect(body).toMatchObject({ icon_type: "auto", icon_value: null });
		});

		it("sends back a colour and an icon left alone", async () => {
			const host = storedHost({ color: "#ff8800", iconType: "emoji", iconValue: "🚀" });
			const body = await savedBody(host);
			expect(body).toMatchObject({ color: "#ff8800", icon_type: "emoji", icon_value: "🚀" });
		});

		it("sends back the stored custom elevation command when the field is left alone (#660)", async () => {
			for (const type of ["ssh", "local"] as const) {
				const host = storedHost({
					type,
					elevationMethod: "custom",
					customCommand: "/usr/local/bin/my-elevate",
				});
				const { form } = useHostForm(host);
				expect(form.value.customCommand).toBe("/usr/local/bin/my-elevate");

				const body = await savedBody(host, (f) => {
					f.label = "renamed";
				});
				expect(body).toMatchObject({
					elevation_method: "custom",
					custom_command: "/usr/local/bin/my-elevate",
				});
			}
		});

		it("still clears the custom elevation command when the field is emptied", async () => {
			const host = storedHost({ elevationMethod: "custom", customCommand: "/usr/bin/elevate" });
			const body = await savedBody(host, (form) => {
				form.customCommand = "";
			});
			expect(body).toHaveProperty("custom_command", null);
		});

		it.each([null, true, false])(
			"saves a stored remote daemon choice unchanged: %j",
			async (sshRemoteDaemon) => {
				const body = await savedBody(storedHost({ sshRemoteDaemon }));
				expect(body).toHaveProperty("ssh_remote_daemon", sshRemoteDaemon);
			},
		);

		it("makes the setting unavailable for a Windows host", () => {
			const { sshRemoteDaemonUnavailable } = useHostForm(
				storedHost({ os: "windows", sshRemoteDaemon: true }),
			);
			expect(sshRemoteDaemonUnavailable.value).toBe(true);
		});

		it("does not rewrite a Windows host remote daemon choice", async () => {
			const body = await savedBody(storedHost({ os: "windows", sshRemoteDaemon: true }), (form) => {
				form.label = "renamed";
			});
			expect(body).not.toHaveProperty("ssh_remote_daemon");
		});

		it("keeps the Windows rule while a newer test is pending when editing", async () => {
			updateHostSpy.mockClear();
			const { save, testConnectionInline } = useHostForm(storedHost({ os: null }));
			const harness = testConnectionHarness();
			const windows = testConnectionInline();
			await harness.respondOk(0, "windows");
			await windows;

			const pendingSecondTest = testConnectionInline();
			await vi.waitFor(() => expect(testWsClient.send).toHaveBeenCalledTimes(2));
			await save();

			const [, body] = updateHostSpy.mock.calls[0] as [string, Record<string, unknown>];
			// Catches basing the rule on testResult, which is null while this test is pending.
			expect(body).not.toHaveProperty("ssh_remote_daemon");
			await harness.respondOk(1, "linux");
			await pendingSecondTest;
		});
	});

	describe("SC-06/07/08: auth method visibility", () => {
		it("form.sshAuth can be set to agent", () => {
			const { form } = useHostForm();
			form.value.sshAuth = "agent";
			expect(form.value.sshAuth).toBe("agent");
		});

		it("form.sshAuth can be set to password", () => {
			const { form } = useHostForm();
			form.value.sshAuth = "password";
			expect(form.value.sshAuth).toBe("password");
		});

		it("form.sshAuth defaults to key for new host", () => {
			const { form } = useHostForm();
			expect(form.value.sshAuth).toBe("key");
		});
	});

	describe("INV-13: auth method change clears sshKeyPath", () => {
		it("switching from key to agent clears sshKeyPath", async () => {
			const { form } = useHostForm();
			form.value.sshAuth = "key";
			form.value.sshKeyPath = "~/.ssh/id_ed25519";

			form.value.sshAuth = "agent";
			await nextTick();

			expect(form.value.sshKeyPath).toBe("");
		});

		it("switching from key to password clears sshKeyPath", async () => {
			const { form } = useHostForm();
			form.value.sshAuth = "key";
			form.value.sshKeyPath = "~/.ssh/id_rsa";

			form.value.sshAuth = "password";
			await nextTick();

			expect(form.value.sshKeyPath).toBe("");
		});

		it("switching back to key does not clear sshKeyPath", async () => {
			const { form } = useHostForm();
			form.value.sshAuth = "key";
			form.value.sshKeyPath = "~/.ssh/id_ed25519";

			// Switch away and back
			form.value.sshAuth = "agent";
			await nextTick();
			expect(form.value.sshKeyPath).toBe("");

			// Setting a new key path and staying on key
			form.value.sshAuth = "key";
			form.value.sshKeyPath = "~/.ssh/id_ed25519";
			await nextTick();
			expect(form.value.sshKeyPath).toBe("~/.ssh/id_ed25519");
		});
	});

	describe("parseConnectionString (A1)", () => {
		it("SC-01: parses full connection string user@host:port", () => {
			const { parseConnectionString } = useHostForm();
			const result = parseConnectionString("deploy@prod.example.com:2222");
			expect(result).toEqual({ host: "prod.example.com", user: "deploy", port: 2222 });
		});

		it("SC-02: parses host-only string", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("192.168.1.50")).toEqual({ host: "192.168.1.50" });
		});

		it("SC-03: parses user@host without port", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("root@myserver")).toEqual({ host: "myserver", user: "root" });
		});

		it("SC-04: parses IPv6 with bracket syntax", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("[::1]:2222")).toEqual({ host: "::1", port: 2222 });
		});

		it("SC-04b: parses user@IPv6 with bracket syntax", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("root@[fd00::1]:2222")).toEqual({
				host: "fd00::1",
				user: "root",
				port: 2222,
			});
		});

		it("SC-04c: strips ssh:// prefix before parsing", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("ssh://deploy@web.io:2222")).toEqual({
				host: "web.io",
				user: "deploy",
				port: 2222,
			});
		});

		it("SC-05: ignores invalid port (>65535)", () => {
			const { parseConnectionString } = useHostForm();
			const result = parseConnectionString("host:99999");
			expect(result.host).toBe("host");
			expect(result.port).toBeUndefined();
		});

		it("parses host:port without user", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("db.local:5432")).toEqual({ host: "db.local", port: 5432 });
		});

		it("returns empty object for empty string", () => {
			const { parseConnectionString } = useHostForm();
			expect(parseConnectionString("")).toEqual({});
		});
	});

	describe("previewInitials (A4)", () => {
		it("SC-11: returns first 2 chars for single-word label", () => {
			const { form, previewInitials } = useHostForm();
			form.value.label = "production";
			expect(previewInitials.value).toBe("PR");
		});

		it("returns initials from hyphenated label", () => {
			const { form, previewInitials } = useHostForm();
			form.value.label = "staging-web";
			expect(previewInitials.value).toBe("SW");
		});

		it("returns initials from space-separated label", () => {
			const { form, previewInitials } = useHostForm();
			form.value.label = "my server";
			expect(previewInitials.value).toBe("MS");
		});

		it("SC-13: returns empty string when label is empty", () => {
			const { form, previewInitials } = useHostForm();
			form.value.label = "";
			expect(previewInitials.value).toBe("");
		});

		it("handles single-char label", () => {
			const { form, previewInitials } = useHostForm();
			form.value.label = "X";
			expect(previewInitials.value).toBe("X");
		});

		it("trims whitespace before computing initials", () => {
			const { form, previewInitials } = useHostForm();
			form.value.label = "  staging-web  ";
			expect(previewInitials.value).toBe("SW");
		});
	});

	describe("quickConnect watcher (INV-02)", () => {
		it("auto-fills form fields from connection string", async () => {
			const { form, quickConnect } = useHostForm();
			quickConnect.value = "admin@myhost:3333";
			await nextTick();
			expect(form.value.sshHost).toBe("myhost");
			expect(form.value.sshUser).toBe("admin");
			expect(form.value.sshPort).toBe(3333);
		});

		it("does not clear fields when quick connect is emptied (INV-02)", async () => {
			const { form, quickConnect } = useHostForm();
			quickConnect.value = "admin@myhost:3333";
			await nextTick();

			quickConnect.value = "";
			await nextTick();
			// Fields remain from previous parse
			expect(form.value.sshHost).toBe("myhost");
			expect(form.value.sshUser).toBe("admin");
			expect(form.value.sshPort).toBe(3333);
		});
	});
});

describe("proxyFields", () => {
	const known = ["host-1", "host-2"];

	// Never both: an id names a host this hub knows, and anything else is an
	// address written the way ssh_config writes it.
	it("names a host of the list by its id", () => {
		expect(proxyFields("host-2", known)).toEqual({
			ssh_proxy_host_id: "host-2",
			ssh_proxy_spec: null,
		});
	});

	it("keeps anything else as the address it is", () => {
		expect(proxyFields("jump@bastion:2222", known)).toEqual({
			ssh_proxy_host_id: null,
			ssh_proxy_spec: "jump@bastion:2222",
		});
	});

	// A host that stops going through a bastion stops, rather than keeping a
	// leftover nobody can see.
	it("clears both when nothing is chosen", () => {
		expect(proxyFields("   ", known)).toEqual({ ssh_proxy_host_id: null, ssh_proxy_spec: null });
	});
});

describe("iconFields", () => {
	it("keeps an emoji, its shortcode resolved", () => {
		expect(iconFields("emoji", ":rocket:")).toEqual({ icon_type: "emoji", icon_value: "🚀" });
	});

	it("keeps an image", () => {
		expect(iconFields("image", "data:image/png;base64,AAAA")).toEqual({
			icon_type: "image",
			icon_value: "data:image/png;base64,AAAA",
		});
	});

	// null, not a missing key: the hub keeps what a body leaves out (#659).
	it("sends no icon for no value, or for the initials", () => {
		expect(iconFields("image", "")).toEqual({ icon_type: "auto", icon_value: null });
		expect(iconFields("emoji", "  ")).toEqual({ icon_type: "auto", icon_value: null });
		expect(iconFields("auto", "🚀")).toEqual({ icon_type: "auto", icon_value: null });
	});
});
