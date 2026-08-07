import type { Host, SshConfigEntry } from "@lasterm/shared";
import { generateId } from "@lasterm/shared";
import { computed, ref, watch } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useHostsStore } from "../stores/hosts.js";
import { resolveEmojiShortcode } from "../utils/emoji-shortcodes.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { getInitials } from "./useHostIcon.js";

export interface HostFormData {
	label: string;
	type: "local" | "ssh";
	sshHost: string;
	sshPort: number | undefined;
	sshUser: string;
	sshAuth: "agent" | "key" | "password";
	sshKeyPath: string;
	iconType: "auto" | "emoji" | "image";
	iconValue: string;
	color: string;
	hostGroup: string;
	defaultShell: string;
	keepAliveSeconds: number;
	historyRetentionDays: number;
	trustRemoteHints: "apply" | "ask" | "ignore";
	elevationMethod: string;
	customCommand: string;
	os: "linux" | "darwin" | "windows" | null;
	arch: "x64" | "arm64" | null;
}

export function useHostForm(editHost?: Host) {
	const hostsStore = useHostsStore();
	const authStore = useAuthStore();

	const isEdit = !!editHost;

	const form = ref<HostFormData>({
		label: editHost?.label ?? "",
		type: editHost?.type ?? "ssh",
		sshHost: editHost?.sshHost ?? "",
		sshPort: editHost?.sshPort ?? undefined,
		sshUser: editHost?.sshUser ?? "",
		sshAuth: editHost?.sshAuth ?? "key",
		sshKeyPath: editHost?.sshKeyPath ?? "",
		iconType: editHost?.iconType ?? "auto",
		iconValue: editHost?.iconValue ?? "",
		color: editHost?.color ?? "",
		hostGroup: editHost?.hostGroupId ?? "",
		defaultShell: editHost?.defaultShell ?? "",
		keepAliveSeconds: editHost?.keepAliveSeconds ?? 60,
		historyRetentionDays: editHost?.historyRetentionDays ?? 30,
		trustRemoteHints: editHost?.trustRemoteHints ?? "apply",
		elevationMethod: editHost?.elevationMethod ?? "",
		customCommand: "",
		os: editHost?.os ?? null,
		arch: editHost?.arch ?? null,
	});

	// INV-13: clear key path when switching away from key auth
	watch(
		() => form.value.sshAuth,
		(auth) => {
			if (auth !== "key") {
				form.value.sshKeyPath = "";
			}
		},
	);

	// Source: "manual" or "ssh-config"
	const source = ref<"manual" | "ssh-config">("manual");
	const sshConfigEntries = ref<SshConfigEntry[]>([]);
	const sshConfigHasInclude = ref(false);
	const selectedSshConfigHost = ref<string>("");
	const loadingSshConfig = ref(false);

	const testResult = ref<{ ok: boolean; message?: string } | null>(null);
	const testing = ref(false);
	const saving = ref(false);

	// New group creation inline
	const newGroupName = ref("");
	const showNewGroup = ref(false);

	const labelError = computed(() => {
		const label = form.value.label.trim();
		if (!label) return "Label is required";
		if (label.length > 64) return "Label must be 64 characters or fewer";
		if (!/^[a-zA-Z0-9._-]+$/.test(label)) return "Only letters, numbers, dots, dashes, underscores";
		// Check for duplicate (excluding self if editing)
		const existing = hostsStore.hosts.find((h) => h.label.toLowerCase() === label.toLowerCase());
		if (existing && (!isEdit || existing.id !== editHost?.id)) return "Host name already exists";
		return null;
	});

	const previewInitials = computed(() => {
		const label = form.value.label.trim();
		if (!label) return "";
		return getInitials(label);
	});

	const canSave = computed(() => {
		if (labelError.value) return false;
		if (form.value.type === "ssh") {
			if (!form.value.sshHost) return false;
			if (form.value.sshAuth === "key" && !form.value.sshKeyPath) return false;
		}
		return true;
	});

	async function loadSshConfig(): Promise<void> {
		loadingSshConfig.value = true;
		try {
			const res = await fetch(`${hubBaseUrl()}/api/ssh-config`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!res.ok) {
				if (res.status === 404) {
					sshConfigEntries.value = [];
					return;
				}
				throw new Error("Failed to load SSH config");
			}
			const data = (await res.json()) as {
				entries: SshConfigEntry[];
				has_include: boolean;
			};
			sshConfigEntries.value = data.entries;
			sshConfigHasInclude.value = data.has_include;
		} finally {
			loadingSshConfig.value = false;
		}
	}

	function applySshConfigEntry(name: string): void {
		const entry = sshConfigEntries.value.find((e) => e.name === name);
		if (!entry) return;
		selectedSshConfigHost.value = name;
		if (entry.hostname) form.value.sshHost = entry.hostname;
		form.value.sshPort = entry.port;
		if (entry.user) form.value.sshUser = entry.user;
		if (entry.identityFile) {
			form.value.sshKeyPath = entry.identityFile;
			form.value.sshAuth = "key";
		}
		if (!form.value.label) form.value.label = name;
	}

	async function testConnectionInline(): Promise<void> {
		testing.value = true;
		testResult.value = null;
		try {
			const { useSessionStore } = await import("../stores/session.js");
			const sessionStore = useSessionStore();
			const wsClient = sessionStore.wsClient;

			// Use real hostId for saved hosts, temp ID for unsaved
			const testHostId = isEdit && editHost ? editHost.id : generateId();

			// Always read from form — it's initialized with editHost values,
			// so form.value already reflects DB state + user edits
			const host = form.value.sshHost;
			const port = form.value.sshPort ?? 22;
			const sshAuth = form.value.sshAuth;
			const sshKeyPath = form.value.sshKeyPath;
			const sshUser = form.value.sshUser;

			const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
				const cleanup = (): void => {
					unsubOk();
					unsubFail();
				};

				const unsubOk = wsClient.on("TEST_CONNECT_OK", (msg) => {
					if (msg.type === "TEST_CONNECT_OK" && msg.hostId === testHostId) {
						cleanup();
						resolve({ ok: true });
					}
				});

				const unsubFail = wsClient.on("TEST_CONNECT_FAIL", (msg) => {
					if (msg.type === "TEST_CONNECT_FAIL" && msg.hostId === testHostId) {
						cleanup();
						resolve({ ok: false, message: msg.message });
					}
				});

				wsClient.send({
					type: "TEST_CONNECT",
					hostId: testHostId,
					hostname: host,
					port: port,
					sshAuth: sshAuth,
					...(sshKeyPath && { sshKeyPath }),
					...(sshUser && { sshUser }),
				});
			});

			testResult.value = result;
		} catch {
			testResult.value = { ok: false, message: "Connection test failed" };
		} finally {
			testing.value = false;
		}
	}

	async function save(extraBody?: Record<string, unknown>): Promise<Host | null> {
		if (!canSave.value) return null;
		saving.value = true;
		try {
			// Inline group creation: create the group first, then assign by ID
			let groupId: string | null = form.value.hostGroup || null;
			if (showNewGroup.value && newGroupName.value.trim()) {
				const created = await hostsStore.createHostGroup(newGroupName.value.trim());
				if (created) {
					groupId = created.id;
					showNewGroup.value = false;
					newGroupName.value = "";
				}
			}

			const body: Record<string, unknown> = {
				label: form.value.label.trim(),
				type: form.value.type,
				...(form.value.type === "ssh" && {
					ssh_host: form.value.sshHost,
					...(form.value.sshPort !== undefined &&
						form.value.sshPort > 0 && { ssh_port: form.value.sshPort }),
					...(form.value.sshUser && { ssh_user: form.value.sshUser }),
					ssh_auth: form.value.sshAuth,
					...(form.value.sshAuth === "key" && {
						ssh_key_path: form.value.sshKeyPath,
					}),
				}),
				icon_type: form.value.iconType,
				...(form.value.iconValue && {
					icon_value:
						form.value.iconType === "emoji"
							? resolveEmojiShortcode(form.value.iconValue)
							: form.value.iconValue,
				}),
				...(form.value.color && { color: form.value.color }),
				host_group_id: groupId,
				...(form.value.defaultShell && {
					default_shell: form.value.defaultShell,
				}),
				keep_alive_seconds: form.value.keepAliveSeconds,
				history_retention_days: form.value.historyRetentionDays,
				trust_remote_hints: form.value.trustRemoteHints,
				elevation_method: form.value.elevationMethod || null,
				custom_command: form.value.customCommand || null,
				os: form.value.os,
				arch: form.value.arch,
				...extraBody,
			};

			if (isEdit && editHost) {
				return await hostsStore.updateHost(editHost.id, body);
			}
			return await hostsStore.createHost(body);
		} finally {
			saving.value = false;
		}
	}

	// Quick connect parser (A1)
	const quickConnect = ref("");

	function parseConnectionString(input: string): {
		host?: string | undefined;
		user?: string | undefined;
		port?: number | undefined;
	} {
		let str = input.trim();
		if (!str) return {};

		// Strip ssh:// prefix (INV-14)
		if (str.startsWith("ssh://")) {
			str = str.slice(6);
		}

		let user: string | undefined;
		let host: string | undefined;
		let port: number | undefined;

		// Extract user@ prefix (before any brackets or host)
		const atIdx = str.indexOf("@");
		if (atIdx > 0) {
			user = str.slice(0, atIdx);
			str = str.slice(atIdx + 1);
		}

		// Check for IPv6 bracket syntax: [addr]:port or [addr]
		if (str.startsWith("[")) {
			const closeBracket = str.indexOf("]");
			if (closeBracket > 0) {
				host = str.slice(1, closeBracket);
				const after = str.slice(closeBracket + 1);
				if (after.startsWith(":")) {
					const p = Number.parseInt(after.slice(1), 10);
					if (p > 0 && p <= 65535) port = p;
				}
			}
		} else {
			// Regular host:port or host
			const colonIdx = str.lastIndexOf(":");
			if (colonIdx > 0) {
				const portStr = str.slice(colonIdx + 1);
				const p = Number.parseInt(portStr, 10);
				if (!Number.isNaN(p) && p > 0 && p <= 65535) {
					host = str.slice(0, colonIdx);
					port = p;
				} else {
					// Invalid port — use host part only, leave port undefined
					host = str.slice(0, colonIdx);
				}
			} else {
				host = str;
			}
		}

		return { host, user, port };
	}

	// Watch quick connect input and auto-fill form fields (INV-02, INV-15)
	watch(quickConnect, (val) => {
		const parsed = parseConnectionString(val);
		if (parsed.host !== undefined) form.value.sshHost = parsed.host;
		if (parsed.user !== undefined) form.value.sshUser = parsed.user;
		if (parsed.port !== undefined) form.value.sshPort = parsed.port;
	});

	return {
		form,
		isEdit,
		source,
		sshConfigEntries,
		sshConfigHasInclude,
		selectedSshConfigHost,
		loadingSshConfig,
		testResult,
		testing,
		saving,
		labelError,
		canSave,
		previewInitials,
		newGroupName,
		showNewGroup,
		loadSshConfig,
		applySshConfigEntry,
		testConnectionInline,
		save,
		quickConnect,
		parseConnectionString,
	};
}
