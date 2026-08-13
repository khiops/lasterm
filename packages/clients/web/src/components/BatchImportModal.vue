<template>
	<Teleport to="body">
		<div v-if="show" class="dialog-overlay" @click.self="close">
			<div class="dialog-content batch-import-modal">
				<div class="dialog-header">
					<h3 class="dialog-title">Import from SSH Config</h3>
					<button class="dialog-close" @click="close">
						&times;
					</button>
				</div>

				<div class="dialog-body">
					<!-- Loading state -->
					<div v-if="loading" class="loading-text">
						Loading SSH config...
					</div>

					<!-- Error state -->
					<div v-else-if="fetchError" class="error-banner">
						{{ fetchError }}
					</div>

					<!-- Empty state -->
					<div
						v-else-if="entries.length === 0"
						class="empty-text"
					>
						No hosts found in SSH config.
					</div>

					<!-- Entry list -->
					<template v-else>
						<!-- Include directive warning -->
						<div
							v-if="hasIncludeDirective"
							class="info-banner"
						>
							Include directives detected — included hosts
							may be missing
						</div>

						<!-- Conflict error -->
						<div
							v-if="conflictError"
							class="error-banner"
						>
							{{ conflictError }}
						</div>

						<!-- Success message -->
						<div v-if="successMessage" class="success-banner">
							{{ successMessage }}
						</div>

						<!-- Select all / none -->
						<div class="select-controls">
							<button
								class="btn-link"
								@click="selectAllServers"
							>
								Select all servers
							</button>
							<span class="select-sep">|</span>
							<button class="btn-link" @click="selectNone">
								Select none
							</button>
						</div>

						<!-- Host entries -->
						<div class="entry-list">
							<label
								v-for="entry in entries"
								:key="entry.name"
								class="entry-row"
								:class="{
									'entry-git': entry.isGitHost,
									'entry-disabled': importing,
								}"
							>
								<input
									v-model="checked"
									type="checkbox"
									:value="entry.name"
									:disabled="importing"
									class="entry-checkbox"
								/>
								<span class="entry-name">{{
									entry.name
								}}</span>
								<span
									v-if="entry.hostname"
									class="entry-hostname"
								>
									{{ entry.hostname
									}}{{
										entry.port !== 22
											? `:${entry.port}`
											: ""
									}}
								</span>
								<span
									v-if="entry.isGitHost"
									class="entry-hint"
								>
									(git host — not a server)
								</span>
								<!-- ProxyJump dependency warning -->
								<span
									v-if="proxyWarnings.has(entry.name)"
									class="entry-proxy-warn"
								>
									{{ proxyWarnings.get(entry.name) }}
								</span>
							</label>
						</div>
					</template>
				</div>

				<div
					v-if="!loading && !fetchError && entries.length > 0"
					class="dialog-actions"
				>
					<button class="btn btn-secondary" @click="close">
						Cancel
					</button>
					<button
						class="btn btn-primary"
						:disabled="checkedCount === 0 || importing"
						@click="onImport"
					>
						{{
							importing
								? "Importing..."
								: `Import ${checkedCount} host${checkedCount !== 1 ? "s" : ""}`
						}}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SshConfigEntry } from "@lasterm/shared";
import { hubBaseUrl } from "../utils/hub-url.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { useAuthStore } from "../stores/auth.js";

/** Wire format from GET /api/ssh-config (snake_case keys). */
interface SshConfigWire {
	name: string;
	hostname: string | null;
	port: number;
	user: string | null;
	identity_file: string | null;
	proxy_jump: string | null;
	is_git_host: boolean;
}

/** Convert snake_case wire entry to camelCase SshConfigEntry. */
function fromWire(w: SshConfigWire): SshConfigEntry {
	return {
		name: w.name,
		hostname: w.hostname,
		port: w.port,
		user: w.user,
		identityFile: w.identity_file,
		proxyJump: w.proxy_jump,
		isGitHost: w.is_git_host,
	};
}

const props = defineProps<{
	show: boolean;
}>();

const emit = defineEmits<{
	"update:show": [value: boolean];
	imported: [];
}>();

const authStore = useAuthStore();

const loading = ref(false);
const fetchError = ref<string | null>(null);
const entries = ref<SshConfigEntry[]>([]);
const hasIncludeDirective = ref(false);
const checked = ref<string[]>([]);
const importing = ref(false);
const conflictError = ref<string | null>(null);
const successMessage = ref<string | null>(null);

/** Count of checked entries. */
const checkedCount = computed(() => checked.value.length);

/**
 * ProxyJump dependency warnings.
 * If host A uses ProxyJump to host B, and A is checked but B is not,
 * warn and auto-check B.
 */
const proxyWarnings = computed(() => {
	const warnings = new Map<string, string>();
	const checkedSet = new Set(checked.value);

	for (const entry of entries.value) {
		if (!entry.proxyJump || !checkedSet.has(entry.name)) continue;

		// proxyJump can be a comma-separated chain
		const jumps = entry.proxyJump.split(",").map((j) => j.trim());
		for (const jump of jumps) {
			// Extract just the host name (strip user@ and :port)
			const jumpHost = jump.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
			const jumpEntry = entries.value.find((e) => e.name === jumpHost);
			if (jumpEntry && !checkedSet.has(jumpHost)) {
				warnings.set(
					jumpHost,
					`required by ${entry.name} (ProxyJump)`,
				);
			}
		}
	}

	return warnings;
});

/**
 * Auto-check ProxyJump dependencies when warnings appear.
 */
watch(proxyWarnings, (warnings) => {
	if (warnings.size === 0) return;
	const toAdd: string[] = [];
	for (const name of warnings.keys()) {
		if (!checked.value.includes(name)) {
			toAdd.push(name);
		}
	}
	if (toAdd.length > 0) {
		checked.value = [...checked.value, ...toAdd];
	}
});

function close(): void {
	emit("update:show", false);
}

async function fetchSshConfig(): Promise<void> {
	loading.value = true;
	fetchError.value = null;
	conflictError.value = null;
	successMessage.value = null;
	try {
		const res = await hubFetch(`${hubBaseUrl()}/api/ssh-config`, {
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) {
			if (res.status === 404) {
				entries.value = [];
				fetchError.value =
					"No SSH config file found at ~/.ssh/config";
				return;
			}
			throw new Error(`Failed to load SSH config (${res.status})`);
		}
		const data = (await res.json()) as {
			entries: SshConfigWire[];
			has_include: boolean;
		};
		entries.value = data.entries.map(fromWire);
		hasIncludeDirective.value = data.has_include;

		// Default: check all non-git hosts, uncheck git hosts
		checked.value = entries.value
			.filter((e) => !e.isGitHost)
			.map((e) => e.name);
	} catch (err) {
		fetchError.value =
			err instanceof Error ? err.message : "Failed to load SSH config";
	} finally {
		loading.value = false;
	}
}

function selectAllServers(): void {
	checked.value = entries.value
		.filter((e) => !e.isGitHost)
		.map((e) => e.name);
}

function selectNone(): void {
	checked.value = [];
}

async function onImport(): Promise<void> {
	if (checkedCount.value === 0) return;
	importing.value = true;
	conflictError.value = null;
	successMessage.value = null;

	const importEntries = checked.value.map((name) => ({
		name,
		label: name,
	}));

	try {
		const res = await hubFetch(`${hubBaseUrl()}/api/hosts/import`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ entries: importEntries }),
		});

		if (res.status === 409) {
			const data = (await res.json()) as {
				error: {
					conflicting_labels?: string[];
					message: string;
				};
			};
			const labels = data.error.conflicting_labels ?? [];
			conflictError.value = labels.length > 0
				? `These host names already exist: ${labels.join(", ")}`
				: data.error.message;
			return;
		}

		if (!res.ok) {
			const data = (await res.json()) as {
				error: { message: string };
			};
			conflictError.value =
				data.error?.message ?? `Import failed (${res.status})`;
			return;
		}

		const imported = (await res.json()) as unknown[];
		successMessage.value = `Successfully imported ${imported.length} host${imported.length !== 1 ? "s" : ""}.`;

		// Brief delay so user sees the success message, then close
		setTimeout(() => {
			emit("imported");
			close();
		}, 1200);
	} catch (err) {
		conflictError.value =
			err instanceof Error ? err.message : "Import failed";
	} finally {
		importing.value = false;
	}
}

// Fetch SSH config when modal opens
watch(
	() => props.show,
	(visible) => {
		if (visible) {
			void fetchSshConfig();
		} else {
			// Reset state on close
			entries.value = [];
			checked.value = [];
			fetchError.value = null;
			conflictError.value = null;
			successMessage.value = null;
		}
	},
);
</script>

<style scoped>
.dialog-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.dialog-content.batch-import-modal {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	min-width: 420px;
	max-width: 560px;
	width: 100%;
	box-shadow: var(--nt-shadow);
	max-height: 85vh;
	display: flex;
	flex-direction: column;
}

.dialog-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px 0;
}

.dialog-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.dialog-close {
	background: none;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 18px;
	cursor: pointer;
	padding: 0 4px;
	line-height: 1;
}

.dialog-close:hover {
	color: var(--nt-fg);
}

.dialog-body {
	padding: 16px 20px;
	overflow-y: auto;
	flex: 1;
}

.dialog-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding: 12px 20px 16px;
	border-top: 1px solid var(--nt-border);
}

.loading-text,
.empty-text {
	font-size: 13px;
	color: var(--nt-text-secondary);
	text-align: center;
	padding: 24px 0;
}

.info-banner {
	padding: 6px 10px;
	font-size: 11px;
	color: var(--nt-accent);
	background: rgba(var(--nt-accent-rgb), 0.08);
	border: 1px solid var(--nt-accent);
	border-radius: 4px;
	margin-bottom: 10px;
}

.error-banner {
	padding: 6px 10px;
	font-size: 11px;
	color: var(--nt-red, #e06c75);
	background: rgba(224, 108, 117, 0.1);
	border: 1px solid var(--nt-red, #e06c75);
	border-radius: 4px;
	margin-bottom: 10px;
}

.success-banner {
	padding: 6px 10px;
	font-size: 11px;
	color: var(--nt-green, #98c379);
	background: rgba(152, 195, 121, 0.1);
	border: 1px solid var(--nt-green, #98c379);
	border-radius: 4px;
	margin-bottom: 10px;
}

.select-controls {
	display: flex;
	gap: 6px;
	align-items: center;
	margin-bottom: 8px;
}

.select-sep {
	color: var(--nt-text-secondary);
	font-size: 11px;
}

.btn-link {
	background: none;
	border: none;
	color: var(--nt-accent);
	font-size: 11px;
	font-family: inherit;
	cursor: pointer;
	padding: 0;
}

.btn-link:hover {
	text-decoration: underline;
}

.entry-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	max-height: 320px;
	overflow-y: auto;
}

.entry-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 5px 8px;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.1s;
	font-size: 12px;
}

.entry-row:hover {
	background: var(--nt-tab-hover);
}

.entry-disabled {
	opacity: 0.6;
	pointer-events: none;
}

.entry-checkbox {
	accent-color: var(--nt-accent);
	flex-shrink: 0;
}

.entry-name {
	font-weight: 500;
	color: var(--nt-fg);
	white-space: nowrap;
}

.entry-hostname {
	color: var(--nt-text-secondary);
	font-size: 11px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.entry-hint {
	color: var(--nt-text-secondary);
	font-size: 11px;
	font-style: italic;
	white-space: nowrap;
}

.entry-git .entry-name {
	color: var(--nt-text-secondary);
}

.entry-proxy-warn {
	color: var(--nt-yellow, #e5c07b);
	font-size: 10px;
	white-space: nowrap;
	margin-left: auto;
}

.btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition:
		background 0.12s,
		opacity 0.12s;
}

.btn:hover {
	opacity: 0.85;
}

.btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.btn-primary {
	background: var(--nt-accent);
	color: #fff;
}
</style>
