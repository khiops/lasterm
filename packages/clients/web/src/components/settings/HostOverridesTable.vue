<template>
	<div class="host-overrides-table">
		<h3 class="section-title">Per-Host Overrides</h3>
		<p class="section-desc">Pin, hide, or set this profile as the default for specific hosts.</p>

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
						<span v-else class="no-override">—</span>
					</td>
					<td class="col-action">
						<select
							class="override-select"
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
import type { HostLaunchProfileOverride } from "@lasterm/shared";
import { hubBaseUrl } from "../../utils/hub-url.js";
import { hubFetch } from "../../utils/hub-fetch.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useAuthStore } from "../../stores/auth.js";

const props = defineProps<{
	profileId: string;
}>();

const hostsStore = useHostsStore();
const authStore = useAuthStore();

/** Map<hostId, overrideType> */
const overrides = ref<Map<string, "pin" | "hide" | "default">>(new Map());
const saving = ref<Set<string>>(new Set());

function getOverride(hostId: string): "pin" | "hide" | "default" | undefined {
	return overrides.value.get(hostId);
}

function formatOverrideType(type: "pin" | "hide" | "default"): string {
	switch (type) {
		case "pin":
			return "Pinned";
		case "hide":
			return "Hidden";
		case "default":
			return "Default";
	}
}

async function fetchOverrides(): Promise<void> {
	if (authStore.token === null) return;
	// Fetch per-host overrides for this profile by querying each host's profiles
	// We read the full profiles list for each host to detect override types.
	// More efficient: query /api/hosts per host. We aggregate from all hosts.
	const newMap = new Map<string, "pin" | "hide" | "default">();

	await Promise.all(
		hostsStore.hosts.map(async (host) => {
			try {
				const res = await hubFetch(`${hubBaseUrl()}/api/hosts/${encodeURIComponent(host.id)}/profiles`, {
					headers: { Authorization: `Bearer ${authStore.token!}` },
				});
				if (!res.ok) return;
				const items = (await res.json()) as Array<{ id: string; overrideType?: string }>;
				const match = items.find((p) => p.id === props.profileId);
				if (match?.overrideType && ["pin", "hide", "default"].includes(match.overrideType)) {
					newMap.set(host.id, match.overrideType as "pin" | "hide" | "default");
				}
			} catch {
				// ignore per-host failure
			}
		}),
	);

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
			}
		} else {
			// Upsert override
			const overrideType = value as "pin" | "hide" | "default";
			const res = await hubFetch(
				`${hubBaseUrl()}/api/hosts/${encodeURIComponent(hostId)}/profiles/${encodeURIComponent(props.profileId)}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${authStore.token}`,
					},
					body: JSON.stringify({ overrideType }),
				},
			);
			if (res.ok) {
				const newMap = new Map(overrides.value);
				newMap.set(hostId, overrideType);
				overrides.value = newMap;
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
