<template>
	<div class="agent-manager-category">
		<section class="agent-section agent-section--first">
			<div class="section-heading">
				<div>
					<h3 class="section-title">Agents</h3>
					<p class="section-note">Cached remote agent binaries for built targets.</p>
				</div>
				<button class="agent-button agent-button--secondary" type="button" @click="refresh">
					Refresh
				</button>
			</div>

			<div class="version-triplet" aria-label="Version triplet diagnostic">
				<div class="triplet-item">
					<span class="triplet-label">Desktop</span>
					<span class="triplet-value">{{ desktopVersionLabel }}</span>
				</div>
				<div class="triplet-item">
					<span class="triplet-label">Hub</span>
					<span class="triplet-value">{{ store.hubVersion ?? "N/A" }}</span>
				</div>
				<div class="triplet-item">
					<span class="triplet-label">Bundled agent</span>
					<span class="triplet-value">{{ bundledAgentVersion ?? "N/A" }}</span>
				</div>
			</div>

			<div v-if="versionMismatch" class="agent-warning">
				Desktop, hub, and bundled agent versions do not match. Use the update path tracked in
				<a
					href="https://github.com/khiops/lasterm/issues/94"
					target="_blank"
					rel="noreferrer"
				>
					#94
				</a>
				.
			</div>
		</section>

		<section class="agent-section">
			<div class="agent-toolbar">
				<button
					class="agent-button"
					type="button"
					:disabled="bulkFetching || fetchAllTargets.length === 0"
					@click="onFetchAll"
				>
					{{ bulkFetching ? "Fetching..." : "Fetch all built" }}
				</button>
				<button
					class="agent-button agent-button--secondary"
					type="button"
					:disabled="pruning"
					@click="onPruneStale"
				>
					{{ pruning ? "Pruning..." : "Prune stale" }}
				</button>
				<button class="agent-button agent-button--secondary" type="button" @click="showImport = true">
					Import...
				</button>
			</div>

			<div v-if="store.lastError" class="agent-error">{{ store.lastError }}</div>
			<div v-if="store.loading && sortedTargets.length === 0" class="agent-empty">
				Loading agent targets...
			</div>

			<div v-else class="targets-table-wrap">
				<table class="targets-table">
					<thead>
						<tr>
							<th>Target</th>
							<th>Triple</th>
							<th>Status</th>
							<th>Version</th>
							<th class="action-col">Action</th>
						</tr>
					</thead>
					<tbody>
						<template
							v-for="target in sortedTargets"
							:key="agentTargetKey(target.os, target.arch)"
						>
							<tr>
								<td>
									<span class="target-name">{{ formatTarget(target) }}</span>
								</td>
								<td class="mono-cell">{{ target.triple ?? "N/A" }}</td>
								<td>
									<span
										class="status-badge"
										:class="`status-badge--${target.status}`"
									>
										{{ target.status }}
									</span>
								</td>
								<td>
									<div class="version-cell">
										<span>{{ target.version ?? "N/A" }}</span>
										<span
											v-if="target.expectedVersion && target.expectedVersion !== target.version"
											class="expected-version"
										>
											expected {{ target.expectedVersion }}
										</span>
									</div>
								</td>
								<td class="action-col">
									<button
										v-if="canFetchTarget(target)"
										class="agent-button agent-button--compact"
										type="button"
										:disabled="store.isTargetInFlight(target.os, target.arch) || target.status === 'cached'"
										@click="onFetchTarget(target)"
									>
										{{ store.isTargetInFlight(target.os, target.arch) ? "Fetching..." : target.status === "cached" ? "Up to date" : "Fetch" }}
									</button>
								</td>
							</tr>
							<tr v-if="progressFor(target)" class="progress-row">
								<td colspan="5">
									<div class="target-progress">
										<div class="progress-meta">
											<span>{{ progressFor(target)?.phase }}</span>
											<span>{{ formatProgress(progressFor(target)) }}</span>
										</div>
										<div
											class="progress-track"
											:class="{ 'progress-track--indeterminate': progressPercent(progressFor(target)) === null }"
										>
											<div
												class="progress-bar"
												:style="progressStyle(progressFor(target))"
											/>
										</div>
									</div>
								</td>
							</tr>
						</template>
					</tbody>
				</table>
			</div>
		</section>

		<AgentImportModal :show="showImport" @close="showImport = false" />
	</div>
</template>

<script setup lang="ts">
import type { HostArch, HostOs } from "@lasterm/shared";
import { computed, inject, onMounted, ref, watch } from "vue";
import AgentImportModal from "../AgentImportModal.vue";
import {
	agentTargetKey,
	type AgentFetchJob,
	type AgentTarget,
	useAgentManagerStore,
} from "../../../stores/agent-manager.js";
import { useToastStore } from "../../../stores/toast.js";

const TARGET_ORDER: { os: HostOs; arch: HostArch }[] = [
	{ os: "linux", arch: "x64" },
	{ os: "linux", arch: "arm64" },
	{ os: "darwin", arch: "x64" },
	{ os: "darwin", arch: "arm64" },
	{ os: "windows", arch: "x64" },
	{ os: "windows", arch: "arm64" },
];

const props = defineProps<{
	desktopVersion?: string | undefined;
}>();

const injectedDesktopVersion = inject<string | undefined>("desktopVersion", undefined);
const store = useAgentManagerStore();
const toastStore = useToastStore();

const showImport = ref(false);
const bulkFetching = ref(false);
const pruning = ref(false);

const effectiveDesktopVersion = computed(() => props.desktopVersion ?? injectedDesktopVersion);
const desktopVersionLabel = computed(() => effectiveDesktopVersion.value ?? "N/A");
const bundledAgentVersion = computed(
	() => store.targets.find((target) => target.status === "bundled")?.version,
);
const versionMismatch = computed(() => {
	const versions = [
		effectiveDesktopVersion.value,
		store.hubVersion ?? undefined,
		bundledAgentVersion.value,
	].filter((version): version is string => typeof version === "string" && version.length > 0);
	return new Set(versions).size > 1;
});

const sortedTargets = computed(() => {
	const byKey = new Map(
		store.targets.map((target) => [agentTargetKey(target.os, target.arch), target]),
	);
	return TARGET_ORDER.map((target) => byKey.get(agentTargetKey(target.os, target.arch))).filter(
		(target): target is AgentTarget => target !== undefined,
	);
});

const fetchAllTargets = computed(() =>
	sortedTargets.value.filter(
		(target) =>
			target.triple !== null &&
			(target.status === "missing" ||
				target.status === "stale" ||
				target.status === "untrusted") &&
			!store.isTargetInFlight(target.os, target.arch),
	),
);

async function refresh(): Promise<void> {
	try {
		await store.loadTargets();
	} catch (error) {
		toastStore.show("error", error instanceof Error ? error.message : String(error), 10_000);
	}
}

onMounted(() => {
	void refresh();
});

watch(
	() => store.lastFetchError,
	(error) => {
		if (!error) return;
		toastStore.show(
			"error",
			`${error.message}\n\nFor an offline or air-gapped hub, use Import... with the agent binary and SHA256SUMS manifest.`,
			12_000,
		);
		store.clearLastFetchError();
	},
);

function canFetchTarget(target: AgentTarget): boolean {
	return !["bundled", "error", "unsupported"].includes(target.status);
}

function progressFor(target: AgentTarget): AgentFetchJob | null {
	return store.progressFor(target.os, target.arch);
}

async function onFetchTarget(target: AgentTarget): Promise<void> {
	try {
		await store.fetchTarget(target.os, target.arch);
	} catch (error) {
		toastStore.show("error", error instanceof Error ? error.message : String(error), 10_000);
	}
}

async function onFetchAll(): Promise<void> {
	bulkFetching.value = true;
	try {
		await store.fetchAllMissing();
	} catch (error) {
		toastStore.show("error", error instanceof Error ? error.message : String(error), 10_000);
	} finally {
		bulkFetching.value = false;
	}
}

async function onPruneStale(): Promise<void> {
	if (!window.confirm("Remove stale cached agent binaries?")) return;

	pruning.value = true;
	try {
		const removed = await store.pruneStale();
		toastStore.show("info", `Removed ${removed} stale agent ${removed === 1 ? "binary" : "binaries"}.`);
	} catch (error) {
		toastStore.show("error", error instanceof Error ? error.message : String(error), 10_000);
	} finally {
		pruning.value = false;
	}
}

function formatTarget(target: AgentTarget): string {
	return `${formatOs(target.os)} / ${target.arch}`;
}

function formatOs(os: HostOs): string {
	if (os === "darwin") return "macOS";
	if (os === "windows") return "Windows";
	return "Linux";
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressPercent(progress: AgentFetchJob | null): number | null {
	if (!progress?.total) return null;
	return Math.max(0, Math.min(100, Math.round((progress.downloaded / progress.total) * 100)));
}

function progressStyle(progress: AgentFetchJob | null): Record<string, string> {
	const percent = progressPercent(progress);
	return percent === null ? {} : { width: `${percent}%` };
}

function formatProgress(progress: AgentFetchJob | null): string {
	if (!progress) return "";
	if (!progress.total) return formatBytes(progress.downloaded);
	return `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`;
}
</script>

<style scoped>
.agent-manager-category {
	display: flex;
	flex-direction: column;
}

.agent-section {
	margin-top: 24px;
	padding-top: 16px;
	border-top: 1px solid var(--nt-border);
}

.agent-section--first {
	margin-top: 0;
	padding-top: 0;
	border-top: none;
}

.section-heading {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 14px;
}

.section-title {
	margin: 0;
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.section-note {
	margin: 4px 0 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.version-triplet {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	overflow: hidden;
}

.triplet-item {
	padding: 10px 12px;
	border-left: 1px solid var(--nt-border);
	background: var(--nt-bg-surface);
	min-width: 0;
}

.triplet-item:first-child {
	border-left: none;
}

.triplet-label,
.triplet-value {
	display: block;
	overflow-wrap: anywhere;
}

.triplet-label {
	font-size: 11px;
	color: var(--nt-text-secondary);
	margin-bottom: 3px;
}

.triplet-value {
	font-size: 13px;
	color: var(--nt-fg);
	font-family: ui-monospace, "SFMono-Regular", monospace;
}

.agent-warning,
.agent-error {
	margin-top: 12px;
	padding: 9px 11px;
	border-radius: 6px;
	font-size: 12px;
	line-height: 1.4;
}

.agent-warning {
	border: 1px solid var(--nt-yellow, #e5c07b);
	color: var(--nt-yellow, #e5c07b);
	background: rgba(229, 192, 123, 0.12);
}

.agent-warning a {
	color: inherit;
	font-weight: 600;
}

.agent-error {
	border: 1px solid var(--nt-red, #e06c75);
	color: var(--nt-red, #e06c75);
	background: rgba(224, 108, 117, 0.12);
}

.agent-toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 12px;
	flex-wrap: wrap;
}

.agent-button {
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	background: var(--nt-accent);
	border: 1px solid var(--nt-accent);
	border-radius: 6px;
	color: var(--nt-bg);
	cursor: pointer;
	transition:
		background 0.15s ease,
		border-color 0.15s ease,
		opacity 0.15s ease;
}

.agent-button:hover:not(:disabled) {
	filter: brightness(1.08);
}

.agent-button:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.agent-button--secondary {
	background: rgba(var(--nt-fg-rgb, 171, 178, 191), 0.06);
	border-color: var(--nt-border);
	color: var(--nt-fg);
}

.agent-button--compact {
	padding: 4px 9px;
	min-width: 68px;
}

.agent-empty {
	padding: 24px 0;
	text-align: center;
	color: var(--nt-text-secondary);
	font-size: 13px;
}

.targets-table-wrap {
	overflow-x: auto;
	border: 1px solid var(--nt-border);
	border-radius: 6px;
}

.targets-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 12px;
	color: var(--nt-fg);
}

.targets-table th,
.targets-table td {
	padding: 9px 10px;
	border-bottom: 1px solid var(--nt-border);
	text-align: left;
	vertical-align: middle;
}

.targets-table th {
	color: var(--nt-text-secondary);
	background: var(--nt-bg-surface);
	font-weight: 600;
}

.targets-table tbody tr:last-child td {
	border-bottom: none;
}

.target-name {
	font-weight: 600;
}

.mono-cell {
	font-family: ui-monospace, "SFMono-Regular", monospace;
	color: var(--nt-text-secondary);
	white-space: nowrap;
}

.status-badge {
	display: inline-flex;
	align-items: center;
	padding: 2px 7px;
	border-radius: 999px;
	border: 1px solid currentColor;
	font-size: 11px;
	font-weight: 600;
	text-transform: capitalize;
	white-space: nowrap;
}

.status-badge--bundled,
.status-badge--cached {
	color: var(--nt-green, #98c379);
	background: rgba(152, 195, 121, 0.12);
}

.status-badge--stale {
	color: var(--nt-yellow, #e5c07b);
	background: rgba(229, 192, 123, 0.12);
}

.status-badge--missing {
	color: var(--nt-accent);
	background: rgba(var(--nt-accent-rgb, 97, 175, 239), 0.12);
}

.status-badge--untrusted,
.status-badge--error {
	color: var(--nt-red, #e06c75);
	background: rgba(224, 108, 117, 0.12);
}

.status-badge--unsupported {
	color: var(--nt-text-secondary);
	background: rgba(var(--nt-fg-rgb, 171, 178, 191), 0.06);
}

.version-cell {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 90px;
}

.expected-version {
	color: var(--nt-text-secondary);
	font-size: 11px;
}

.action-col {
	width: 86px;
	text-align: right;
}

.progress-row td {
	padding-top: 0;
	background: var(--nt-bg);
}

.target-progress {
	padding: 0 0 8px;
}

.progress-meta {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 4px;
	font-size: 11px;
	color: var(--nt-text-secondary);
	text-transform: capitalize;
}

.progress-track {
	height: 6px;
	border-radius: 999px;
	background: var(--nt-bg-surface);
	overflow: hidden;
}

.progress-bar {
	height: 100%;
	width: 100%;
	border-radius: inherit;
	background: var(--nt-accent);
	transition: width 0.15s ease;
}

.progress-track--indeterminate .progress-bar {
	width: 35%;
	animation: progress-indeterminate 1.1s ease-in-out infinite;
}

@keyframes progress-indeterminate {
	0% {
		transform: translateX(-110%);
	}
	100% {
		transform: translateX(300%);
	}
}

@media (max-width: 720px) {
	.version-triplet {
		grid-template-columns: 1fr;
	}

	.triplet-item,
	.triplet-item:first-child {
		border-left: none;
		border-top: 1px solid var(--nt-border);
	}

	.triplet-item:first-child {
		border-top: none;
	}
}
</style>
