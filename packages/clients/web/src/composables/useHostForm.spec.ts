import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { proxyFields, useHostForm } from "./useHostForm.js";

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

describe("useHostForm", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

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
				keepAliveSeconds: 60,
				historyRetentionDays: 30,
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
