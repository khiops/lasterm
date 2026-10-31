<template>
	<div class="host-overrides-table">
		<h3 class="section-title">Per-Host Overrides</h3>
		<p class="section-desc">
			Pin, hide, or set this profile as the default for specific hosts: the profile a new terminal
			starts there, as Edit Host's Default Shell sets it.
		</p>

		<div v-if="hostsStore.hosts.length === 0" class="empty-hosts">
			No hosts configured.
		</div>
		<table v-else class="overrides-table">
			<thead>
				<tr>
					<th class="col-host">Host</th>
					<th class="col-status">Override</th>
					<th class="col-action">Action</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="host in hostsStore.hosts" :key="host.id" class="override-row">
					<td class="col-host">
						<span class="host-name">{{ host.label }}</span>
						<span class="host-addr">{{ host.type === 'ssh' ? host.sshHost : 'local' }}</span>
					</td>
					<td class="col-status">
						<span v-if="getOverride(host.id)" class="override-badge" :class="`badge-${getOverride(host.id)}`">
							{{ formatOverrideType(getOverride(host.id)!) }}
						</span>
						<span
							v-if="isAutomatic(host.id)"
							class="override-automatic"
							title="Set by Lasterm from the shells this host's agent reported: it follows the agent's default shell."
						>
							automatic
						</span>
						<span v-if="!getOverride(host.id)" class="no-override">—</span>
					</td>
					<td class="col-action">
						<select
							class="override-select"
							:aria-label="`Override for ${host.label}`"
							:value="getOverride(host.id) ?? ''"
							:disabled="saving.has(host.id)"
							@change="handleOverrideChange(host.id, ($event.target as HTMLSelectElement).value)"
						>
							<option value="">No Override</option>
							<option value="pin">Pin</option>
							<option value="hide">Hide</option>
							<option value="default">Set as Default</option>
						</select>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { toCamelCase } from "@lasterm/shared";
import { hubBaseUrl } from "../../utils/hub-url.js";
import { hubFetch } from "../../utils/hub-fetch.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useAuthStore } from "../../stores/auth.js";

const props = defineProps<{
	profileId: string;
}>();

const hostsStore = useHostsStore();
const authStore = useAuthStore();

type OverrideType = "pin" | "hide" | "default";

/**
 * A host's override of this profile, and whether its user set it or the hub
 * did, from the shells the host's agent reported (#802).
 */
interface HostOverride {
	type: OverrideType;
	setByUser: boolean;
}

/** Map<hostId, override> */
const overrides = ref<Map<string, HostOverride>>(new Map());
const saving = ref<Set<string>>(new Set());

function getOverride(hostId: string): OverrideType | undefined {
	return overrides.value.get(hostId)?.type;
}

/** Whether the hub set this host's override, rather than its user (#802). */
function isAutomatic(hostId: string): boolean {
	return overrides.value.get(hostId)?.setByUser === false;
}

function formatOverrideType(type: OverrideType): string {
	switch (type) {
		case "pin":
			return "Pinned";
		case "hide":
			return "Hidden";
		case "default":
			return "Default";
	}
}

/**
 * This profile's override on a host, as the hub lists the host's profiles:
 * null for none, undefined when the hub could not be read.
 */
async function readOverride(hostId: string): Promise<HostOverride | null | undefined> {
	try {
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${encodeURIComponent(hostId)}/profiles`, {
			headers: { Authorization: `Bearer ${authStore.token!}` },
		});
		if (!res.ok) return undefined;
		const items = toCamelCase(await res.json()) as Array<{
			id: string;
			overrideType?: string;
			setByUser?: boolean;
		}>;
		const match = items.find((p) => p.id === props.profileId);
		if (!match?.overrideType || !["pin", "hide", "default"].includes(match.overrideType)) {
			return null;
		}
		return { type: match.overrideType as OverrideType, setByUser: match.setByUser !== false };
	} catch {
		return undefined;
	}
}

async function fetchOverrides(): Promise<void> {
	if (authStore.token === null) return;
	// Each host's profiles, as it lists them, say its override of this one.
	const newMap = new Map<string, HostOverride>();

	await Promise.all(
		hostsStore.hosts.map(async (host) => {
			const read = await readOverride(host.id);
			if (read) newMap.set(host.id, read);
		}),
	);

	overrides.value = newMap;
}

/**
 * What the hub says this host's override is once a change went through: a
 * default the user removed gives way to the one the hub marks for the host's
 * agent (#802). Kept as set when the hub cannot be read.
 */
async function readAgain(hostId: string): Promise<void> {
	const read = await readOverride(hostId);
	if (read === undefined) return;
	const newMap = new Map(overrides.value);
	if (read === null) newMap.delete(hostId);
	else newMap.set(hostId, read);
	overrides.value = newMap;
}

async function handleOverrideChange(hostId: string, value: string): Promise<void> {
	if (authStore.token === null) return;

	saving.value = new Set(saving.value).add(hostId);

	try {
		if (value === "") {
			// Remove override
			const res = await hubFetch(
				`${hubBaseUrl()}/api/hosts/${encodeURIComponent(hostId)}/profiles/${encodeURIComponent(props.profileId)}`,
				{
					method: "DELETE",
					headers: { Authorization: `Bearer ${authStore.token}` },
				},
			);
			if (res.ok) {
				const newMap = new Map(overrides.value);
				newMap.delete(hostId);
				overrides.value = newMap;
				await readAgain(hostId);
			}
		} else {
			// Upsert override
			const overrideType = value as OverrideType;
			const res = await hubFetch(
				`${hubBaseUrl()}/api/hosts/${encodeURIComponent(hostId)}/profiles/${encodeURIComponent(props.profileId)}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${authStore.token}`,
					},
					// snake_case, as the hub reads it: it refused `overrideType` (#800)
					body: JSON.stringify({ override_type: overrideType }),
				},
			);
			if (res.ok) {
				const newMap = new Map(overrides.value);
				newMap.set(hostId, { type: overrideType, setByUser: true });
				overrides.value = newMap;
				await readAgain(hostId);
			}
		}
	} finally {
		const next = new Set(saving.value);
		next.delete(hostId);
		saving.value = next;
	}
}

onMounted(async () => {
	if (hostsStore.hosts.length === 0) {
		await hostsStore.fetchHosts();
	}
	await fetchOverrides();
});
</script>

<style scoped>
.host-overrides-table {
	margin-top: 24px;
	padding-top: 16px;
	border-top: 1px solid var(--nt-border);
}

.section-title {
	margin: 0 0 4px 0;
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.section-desc {
	margin: 0 0 12px 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.empty-hosts {
	font-size: 13px;
	color: var(--nt-text-secondary);
	padding: 8px 0;
}

.overrides-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
}

.overrides-table th {
	text-align: left;
	padding: 6px 8px;
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	border-bottom: 1px solid var(--nt-border);
}

.override-row td {
	padding: 8px;
	border-bottom: 1px solid var(--nt-border);
	vertical-align: middle;
}

.override-row:last-child td {
	border-bottom: none;
}

.col-host {
	width: 45%;
}

.col-status {
	width: 25%;
}

.col-action {
	width: 30%;
}

.host-name {
	display: block;
	font-weight: 500;
	color: var(--nt-fg);
}

.host-addr {
	display: block;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.override-badge {
	display: inline-block;
	padding: 2px 8px;
	border-radius: 10px;
	font-size: 11px;
	font-weight: 600;
}

.badge-pin {
	background: rgba(var(--nt-accent-rgb), 0.15);
	color: var(--nt-accent);
}

.badge-hide {
	background: rgba(var(--nt-danger-rgb, 239, 68, 68), 0.15);
	color: var(--nt-danger);
}

.badge-default {
	background: rgba(var(--nt-green-rgb), 0.15);
	color: var(--nt-green);
}

.no-override {
	color: var(--nt-text-secondary);
}

/* A mark the hub made, not the user (#802). */
.override-automatic {
	margin-left: 6px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.override-select {
	width: 100%;
	padding: 4px 8px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
}

.override-select:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.override-select:focus {
	outline: none;
	border-color: var(--nt-accent);
}
</style>
