import type { Host, SshConfigEntry, TestConnectPlatform } from "@lasterm/shared";
import { generateId } from "@lasterm/shared";
import { computed, ref, shallowRef, watch } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useHostsStore } from "../stores/hosts.js";
import { type HostVisibleProfile, useProfilesStore } from "../stores/profiles.js";

/**
 * The jump, as the hub stores it: a host of this list, or an address.
 *
 * Never both, and an empty choice clears the two — so a host that stops going
 * through a bastion stops, rather than keeping a leftover nobody can see.
 */
export function proxyFields(
	chosen: string,
	knownHostIds: string[],
): { ssh_proxy_host_id: string | null; ssh_proxy_spec: string | null } {
	const value = chosen.trim();
	if (value === "") return { ssh_proxy_host_id: null, ssh_proxy_spec: null };
	if (knownHostIds.includes(value)) return { ssh_proxy_host_id: value, ssh_proxy_spec: null };
	return { ssh_proxy_host_id: null, ssh_proxy_spec: value };
}

import { resolveEmojiShortcode } from "../utils/emoji-shortcodes.js";
import { hubRefusal, hubUnreachable } from "../utils/hub-answer.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { type SshConfigWireAnswer, sshConfigEntryFromWire } from "../utils/ssh-config.js";
import { getInitials } from "./useHostIcon.js";

/**
 * The icon, as the hub stores it. Both keys are always sent: null is how the
 * hub clears a value, and a key left out kept the stored one, so a removed
 * image came back (#659). No value is no icon, whatever type was picked, and
 * the initials show again.
 */
export function iconFields(
	iconType: HostFormData["iconType"],
	iconValue: string,
): { icon_type: HostFormData["iconType"]; icon_value: string | null } {
	const value = iconType === "emoji" ? resolveEmojiShortcode(iconValue) : iconValue;
	if (iconType === "auto" || value.trim() === "") return { icon_type: "auto", icon_value: null };
	return { icon_type: iconType, icon_value: value };
}

export interface HostFormData {
	label: string;
	type: "local" | "ssh";
	sshHost: string;
	sshPort: number | undefined;
	sshUser: string;
	sshAuth: "agent" | "key" | "password";
	sshKeyPath: string;
	/** The host this one is reached through: "" none, an id, or an address. */
	sshProxy: string;
	/**
	 * Whether this host may keep an agent of its own running, so its terminals
	 * outlive the connection. "" follows the global setting.
	 */
	sshRemoteDaemon: "" | "yes" | "no";
	iconType: "auto" | "emoji" | "image";
	iconValue: string;
	color: string;
	hostGroup: string;
	trustRemoteHints: "apply" | "ask" | "ignore";
	elevationMethod: string;
	customCommand: string;
	os: "linux" | "darwin" | "windows" | null;
	arch: "x64" | "arm64" | null;
}

/** The form for a host as the hub has it, or for a new one. */
function formOf(host?: Host): HostFormData {
	return {
		label: host?.label ?? "",
		type: host?.type ?? "ssh",
		sshHost: host?.sshHost ?? "",
		sshPort: host?.sshPort ?? undefined,
		sshUser: host?.sshUser ?? "",
		sshAuth: host?.sshAuth ?? "key",
		sshKeyPath: host?.sshKeyPath ?? "",
		sshProxy: host?.sshProxyHostId ?? host?.sshProxySpec ?? "",
		sshRemoteDaemon:
			host === undefined
				? "yes"
				: host.sshRemoteDaemon == null
					? ""
					: host.sshRemoteDaemon
						? "yes"
						: "no",
		iconType: host?.iconType ?? "auto",
		iconValue: host?.iconValue ?? "",
		color: host?.color ?? "",
		hostGroup: host?.hostGroupId ?? "",
		trustRemoteHints: host?.trustRemoteHints ?? "apply",
		elevationMethod: host?.elevationMethod ?? "",
		// Loaded, so that a save does not erase it: starting empty made every
		// save erase it (#660). Emptying the field still clears it.
		customCommand: host?.customCommand ?? "",
		os: host?.os ?? null,
		arch: host?.arch ?? null,
	};
}

function setField<K extends keyof HostFormData>(
	form: HostFormData,
	key: K,
	value: HostFormData[K],
): void {
	form[key] = value;
}

/** Sent together or not at all: each pair is one setting to the hub. */
const LINKED_FIELDS = [
	["icon_type", "icon_value"],
	["ssh_proxy_host_id", "ssh_proxy_spec"],
] as const;

/**
 * What a save of an edit sends: the fields of `body` that differ from
 * `before`, the body the host as the hub last said it would make (#789). A
 * field left out keeps what the hub has, which can be newer than what the
 * dialog was opened on: an OS detected meanwhile, or another window's save.
 *
 * A field `before` has and `body` no longer does was emptied: the SSH user,
 * the port, or the key path of a host that stopped signing in with a key. It
 * is sent as null, which the hub clears; left out, the hub kept it, and once
 * set it could never be removed (#792).
 */
function changedFields(
	before: Record<string, unknown>,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const changed = Object.fromEntries(
		Object.entries(body).filter(([key, value]) => !(key in before) || before[key] !== value),
	);
	for (const key of Object.keys(before)) if (!(key in body)) changed[key] = null;
	for (const pair of LINKED_FIELDS) {
		if (!pair.some((key) => key in changed)) continue;
		for (const key of pair) if (key in body) changed[key] = body[key];
	}
	return changed;
}

export function useHostForm(editHost?: Host) {
	const hostsStore = useHostsStore();
	const authStore = useAuthStore();

	const isEdit = !!editHost;

	const form = ref<HostFormData>(formOf(editHost));

	/**
	 * The host being edited as the hub last said it: as the dialog opened on
	 * it, then as this window reads the hosts again (#789). A save sends only
	 * what the user changed from it.
	 */
	const storedHost = shallowRef<Host | undefined>(editHost);

	// The hub changed this host while the dialog is open: another window saved
	// it, or the hub detected its OS. A field the user has not touched shows
	// what the hub has now; one they changed keeps what they chose.
	if (editHost) {
		watch(
			() => hostsStore.hosts.find((host) => host.id === editHost.id),
			(current) => {
				if (current === undefined) return;
				const before = formOf(storedHost.value);
				const now = formOf(current);
				for (const key of Object.keys(now) as Array<keyof HostFormData>) {
					if (form.value[key] === before[key]) setField(form.value, key, now[key]);
				}
				storedHost.value = current;
			},
		);
	}

	/**
	 * The host's launch profiles, among which its Default Shell is chosen
	 * (#802), as the hub lists them: null until read. A host that never
	 * connected has none of its own yet.
	 */
	const hostProfiles = ref<HostVisibleProfile[] | null>(null);
	/** Why they could not be read, as the hub said it, or that it did not answer. */
	const hostProfilesError = ref<string | null>(null);
	/** The Default Shell chosen: "" for Automatic, else the id of a launch profile. */
	const defaultProfileId = ref("");
	/** The default profile the user had chosen, as last read or saved: what Automatic removes. */
	let userDefaultRead: string | null = null;

	/**
	 * Read the host's launch profiles, once, for its Default Shell: the one
	 * marked default by its user is the choice shown, and one the hub marked
	 * for its agent's default shell is "Automatic" (#802).
	 */
	async function loadHostProfiles(): Promise<void> {
		if (!editHost || hostProfiles.value !== null) return;
		hostProfilesError.value = null;
		try {
			const listed = await useProfilesStore().fetchHostProfiles(editHost.id);
			const chosen = listed.find((p) => p.overrideType === "default" && p.setByUser === true);
			userDefaultRead = chosen?.id ?? null;
			defaultProfileId.value = userDefaultRead ?? "";
			hostProfiles.value = listed;
		} catch (error) {
			hostProfilesError.value = `Could not read its launch profiles: ${
				error instanceof Error ? error.message : String(error)
			}`;
			hostProfiles.value = [];
		}
	}

	/**
	 * Save the Default Shell chosen, when it changed (#802): the profile made
	 * the host's default, as the user's choice, or for Automatic the user's
	 * default removed. Null once done, else why not.
	 */
	async function saveDefaultProfile(hostId: string): Promise<string | null> {
		if (hostProfiles.value === null) return null;
		const chosen = defaultProfileId.value === "" ? null : defaultProfileId.value;
		if (chosen === userDefaultRead) return null;
		const answer = await useProfilesStore().setHostDefaultProfile(hostId, chosen, userDefaultRead);
		if (!answer.ok) return answer.message;
		userDefaultRead = chosen;
		return null;
	}

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
	/** Why the SSH config could not be read, as the hub said it, or that it did not answer (#734). */
	const sshConfigError = ref<string | null>(null);

	const testResult = ref<{
		ok: boolean;
		message?: string;
		platform?: TestConnectPlatform;
	} | null>(null);
	const lastCompletedTestPlatformOs = ref<string | undefined>(undefined);
	const testing = ref(false);
	const saving = ref(false);
	/**
	 * Why the last save did not go through, as the hub said it, or that it did
	 * not answer (#703). The form keeps what was typed; the next save clears it.
	 */
	const saveError = ref<string | null>(null);
	let latestTestConnection = 0;

	// A completed test only describes the connection details it tested. Clear
	// it before a synchronous save can use it after any detail changes.
	watch(
		() => [form.value.sshHost, form.value.sshPort, form.value.sshUser, form.value.sshProxy],
		() => {
			lastCompletedTestPlatformOs.value = undefined;
		},
		{ flush: "sync" },
	);

	const connectedThroughRemoteDaemon = computed(
		() => !!editHost && hostsStore.isConnectedThroughRemoteDaemon(editHost.id),
	);

	const sshRemoteDaemonUnavailable = computed(
		() => form.value.os === "windows" || lastCompletedTestPlatformOs.value === "windows",
	);

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

	/**
	 * Read the hub's SSH config for the host picker. No config file (404) is
	 * an empty list; any other failure is said in `sshConfigError`, never
	 * thrown (#734).
	 */
	async function loadSshConfig(): Promise<void> {
		loadingSshConfig.value = true;
		sshConfigError.value = null;
		try {
			const res = await hubFetch(`${hubBaseUrl()}/api/ssh-config`, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!res.ok) {
				if (res.status === 404) {
					sshConfigEntries.value = [];
					return;
				}
				sshConfigError.value = (await hubRefusal(res)).message;
				return;
			}
			// Snake_case, as the hub sends it: read in camelCase, or an entry's
			// identity file and git-host flag go unseen (#757).
			const data = (await res.json()) as SshConfigWireAnswer;
			sshConfigEntries.value = data.entries.map(sshConfigEntryFromWire);
			sshConfigHasInclude.value = data.has_include;
		} catch (error) {
			sshConfigError.value = hubUnreachable(error);
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

	function formProxyFields(chosen = form.value.sshProxy) {
		return proxyFields(
			chosen,
			hostsStore.hosts.map((candidate) => candidate.id),
		);
	}

	async function testConnectionInline(): Promise<void> {
		const testConnection = ++latestTestConnection;
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
			const sshPort = form.value.sshPort;
			const port = sshPort ?? 22;
			const sshAuth = form.value.sshAuth;
			const sshKeyPath = form.value.sshKeyPath;
			const sshUser = form.value.sshUser;
			const sshProxy = form.value.sshProxy;
			const proxy = formProxyFields(sshProxy);

			const result = await new Promise<{
				ok: boolean;
				message?: string;
				platform?: TestConnectPlatform;
			}>((resolve) => {
				const cleanup = (): void => {
					unsubOk();
					unsubFail();
				};

				const unsubOk = wsClient.on("TEST_CONNECT_OK", (msg) => {
					if (msg.type === "TEST_CONNECT_OK" && msg.hostId === testHostId) {
						cleanup();
						resolve(msg.platform ? { ok: true, platform: msg.platform } : { ok: true });
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
					...(proxy.ssh_proxy_host_id && { sshProxyHostId: proxy.ssh_proxy_host_id }),
					...(proxy.ssh_proxy_spec && { sshProxySpec: proxy.ssh_proxy_spec }),
				});
			});

			if (testConnection === latestTestConnection) {
				testResult.value = result;
				lastCompletedTestPlatformOs.value =
					result.ok &&
					form.value.sshHost === host &&
					form.value.sshPort === sshPort &&
					form.value.sshUser === sshUser &&
					form.value.sshProxy === sshProxy
						? result.platform?.os
						: undefined;
			}
		} catch {
			if (testConnection === latestTestConnection) {
				testResult.value = { ok: false, message: "Connection test failed" };
				lastCompletedTestPlatformOs.value = undefined;
			}
		} finally {
			if (testConnection === latestTestConnection) testing.value = false;
		}
	}

	/**
	 * The body the hub is sent for a host filled as `f`. An empty field is left
	 * out: a new host stores none (no port is 22), and an edit sends it as null
	 * to clear the stored one (`changedFields`).
	 */
	function bodyOf(f: HostFormData): Record<string, unknown> {
		return {
			label: f.label.trim(),
			type: f.type,
			...(f.type === "ssh" && {
				ssh_host: f.sshHost,
				...(f.sshPort !== undefined && f.sshPort > 0 && { ssh_port: f.sshPort }),
				...(f.sshUser && { ssh_user: f.sshUser }),
				ssh_auth: f.sshAuth,
				...(f.sshAuth === "key" && {
					ssh_key_path: f.sshKeyPath,
				}),
				// One of the two, never both: an id names a host this hub knows,
				// anything else is an address written the way ssh_config writes
				// it. Empty clears whichever was set.
				...formProxyFields(f.sshProxy),
				// An unavailable setting is recorded as null for a new Windows host.
				// On an existing one, leave the stored answer alone instead.
				...(!connectedThroughRemoteDaemon.value && (!isEdit || !sshRemoteDaemonUnavailable.value)
					? {
							ssh_remote_daemon:
								sshRemoteDaemonUnavailable.value || f.sshRemoteDaemon === ""
									? null
									: f.sshRemoteDaemon === "yes",
						}
					: {}),
			}),
			...iconFields(f.iconType, f.iconValue),
			// null once reset: the colour then comes from the label (#659).
			color: f.color || null,
			host_group_id: f.hostGroup || null,
			trust_remote_hints: f.trustRemoteHints,
			elevation_method: f.elevationMethod || null,
			custom_command: f.customCommand || null,
			os: f.os,
			arch: f.arch,
		};
	}

	async function save(extraBody?: Record<string, unknown>): Promise<Host | null> {
		if (!canSave.value) return null;
		saving.value = true;
		saveError.value = null;
		try {
			// Inline group creation: create the group first, then assign by ID.
			// A refused group stops the save: the host would land outside it.
			if (showNewGroup.value && newGroupName.value.trim()) {
				const created = await hostsStore.createHostGroup(newGroupName.value.trim());
				if (!created.ok) {
					saveError.value = created.message;
					return null;
				}
				// Chosen in the form, so a save the hub then refuses keeps it.
				form.value.hostGroup = created.group.id;
				showNewGroup.value = false;
				newGroupName.value = "";
			}

			const body = bodyOf(form.value);
			// An edit sends what the user changed, and nothing it would write back
			// over what the hub recorded since (#789).
			const answer =
				isEdit && editHost
					? await hostsStore.updateHost(editHost.id, {
							...changedFields(bodyOf(formOf(storedHost.value)), body),
							...extraBody,
						})
					: await hostsStore.createHost({ ...body, ...extraBody });
			if (!answer.ok) {
				saveError.value = answer.message;
				return null;
			}
			// The Default Shell is the host's default profile, saved apart (#802).
			if (isEdit) {
				const refused = await saveDefaultProfile(answer.host.id);
				if (refused !== null) {
					saveError.value = refused;
					return null;
				}
			}
			return answer.host;
		} catch (error) {
			saveError.value = hubUnreachable(error);
			return null;
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
		storedHost,
		source,
		sshConfigEntries,
		sshConfigHasInclude,
		selectedSshConfigHost,
		loadingSshConfig,
		sshConfigError,
		testResult,
		testing,
		saving,
		saveError,
		sshRemoteDaemonUnavailable,
		connectedThroughRemoteDaemon,
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
		hostProfiles,
		hostProfilesError,
		defaultProfileId,
		loadHostProfiles,
	};
}
