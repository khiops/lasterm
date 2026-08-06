
<template>
	<!-- SshKeyCard component -->
	<div
		v-if="entry.type === 'directory'"
		class="key-card key-card--dir"
		@click="emit('select')"
	>
		<svg class="key-card-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
			<path d="M2 4.5C2 3.67 2.67 3 3.5 3H7l1.5 2H14.5C15.33 5 16 5.67 16 6.5V13.5C16 14.33 15.33 15 14.5 15H3.5C2.67 15 2 14.33 2 13.5V4.5Z" fill="currentColor" fill-opacity="0.18" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
		</svg>
		<span class="key-card-name">{{ entry.name }}</span>
		<span v-if="entry.items !== undefined" class="key-card-badge key-card-badge--count">
			{{ entry.items }}
		</span>
		<svg class="key-card-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
			<path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
		</svg>
	</div>
	<!-- Key mode -->
	<div
		v-else
		class="key-card key-card--key"
		:class="{ 'key-card--selected': selected }"
		@click="emit('select')"
	>
		<div class="key-card-main">
			<svg class="key-card-icon key-card-icon--key" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
				<circle cx="7" cy="9" r="4" stroke="currentColor" stroke-width="1.3"/>
				<path d="M10.5 9H16M14 7v2M12 7v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
			</svg>
			<span class="key-card-name key-card-name--mono">{{ entry.name }}</span>
			<div class="key-card-badges">
				<span v-if="entry.algorithm" class="key-card-badge" :style="algoBadgeStyle(entry.algorithm)">{{ entry.algorithm }}</span>
				<span v-if="entry.encrypted" class="key-card-badge key-card-badge--danger">encrypted</span>
			</div>
			<button v-if="!confirmDelete" class="key-card-delete" title="Delete key" @click.stop="confirmDelete = true">
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
					<path d="M2 3h10M5 3V2h4v1M3 3l.8 9h6.4L11 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<div v-else class="key-card-confirm" @click.stop>
				<span class="key-card-confirm-label">Delete?</span>
				<button class="key-card-confirm-btn key-card-confirm-btn--danger" @click.stop="emit('delete')">Delete</button>
				<button class="key-card-confirm-btn" @click.stop="confirmDelete = false">Cancel</button>
			</div>
		</div>
		<div class="key-card-meta">
			<span v-if="entry.bits" class="key-card-meta-item">{{ entry.bits }} bits</span>
			<span v-if="entry.mtime" class="key-card-meta-item">{{ formatDate(entry.mtime) }}</span>
			<span v-if="entry.fingerprint" class="key-card-meta-item key-card-fingerprint" :title="entry.fingerprint">{{ truncateFingerprint(entry.fingerprint) }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { SshKeyEntry } from "@lasterm/shared";

const props = defineProps<{
	entry: SshKeyEntry;
	selected: boolean;
}>();

const emit = defineEmits<{
	select: [];
	delete: [];
}>();

const confirmDelete = ref(false);

function algoBadgeStyle(algorithm: string): Record<string, string> {
	let color: string;
	const alg = algorithm.toUpperCase();
	if (alg.includes("ED25519")) {
		color = "var(--nt-badge-info)";
	} else if (alg.includes("ECDSA")) {
		color = "var(--nt-badge-success)";
	} else if (alg.includes("RSA")) {
		color = "var(--nt-badge-warning)";
	} else if (alg.includes("DSA")) {
		color = "var(--nt-badge-danger)";
	} else {
		color = "var(--nt-fg-muted)";
	}
	return {
		color,
		background: `color-mix(in srgb, ${color} 13%, transparent)`,
		borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
	};
}

function truncateFingerprint(fp: string): string {
	const idx = fp.indexOf("SHA256:");
	if (idx !== -1) {
		return fp.slice(0, idx + "SHA256:".length + 12);
	}
	return fp.slice(0, 12);
}

function formatDate(mtime: string): string {
	try {
		return new Date(mtime).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		return mtime;
	}
}
</script>

<style scoped>
.key-card {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	background: var(--nt-bg-surface);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	cursor: pointer;
	transition: border-color 0.15s ease;
}

.key-card:hover {
	border-color: var(--nt-fg-muted);
}

.key-card--selected {
	border-color: var(--nt-accent);
	box-shadow: 0 0 0 1px var(--nt-accent);
}

.key-card--dir {
	flex-direction: row;
}

.key-card--dir .key-card-name {
	flex: 1;
	font-size: 13px;
	font-weight: 500;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.key-card-chevron {
	color: var(--nt-fg-muted);
	flex-shrink: 0;
}

.key-card--key {
	flex-direction: column;
	align-items: stretch;
	gap: 6px;
}

.key-card-main {
	display: flex;
	align-items: center;
	gap: 8px;
}

.key-card-icon {
	flex-shrink: 0;
	color: var(--nt-fg-muted);
}

.key-card-name {
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex: 1;
}

.key-card-name--mono {
	font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", monospace;
	font-size: 12px;
}

.key-card-badges {
	display: flex;
	gap: 4px;
	flex-shrink: 0;
}

.key-card-badge {
	display: inline-flex;
	align-items: center;
	padding: 1px 6px;
	font-size: 10px;
	font-weight: 600;
	border-radius: 4px;
	border: 1px solid transparent;
	white-space: nowrap;
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.key-card-badge--count {
	color: var(--nt-fg-muted);
	background: color-mix(in srgb, var(--nt-fg-muted) 13%, transparent);
	border-color: color-mix(in srgb, var(--nt-fg-muted) 25%, transparent);
}

.key-card-badge--danger {
	color: var(--nt-badge-danger);
	background: color-mix(in srgb, var(--nt-badge-danger) 13%, transparent);
	border-color: color-mix(in srgb, var(--nt-badge-danger) 30%, transparent);
}

.key-card-meta {
	display: flex;
	gap: 10px;
	padding-left: 26px;
}

.key-card-meta-item {
	font-size: 11px;
	color: var(--nt-fg-muted);
	white-space: nowrap;
}

.key-card-fingerprint {
	font-family: ui-monospace, "SFMono-Regular", monospace;
	cursor: help;
}

.key-card-delete {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	padding: 0;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	color: var(--nt-fg-muted);
	cursor: pointer;
	opacity: 0;
	transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.key-card:hover .key-card-delete {
	opacity: 1;
}

.key-card-delete:hover {
	color: var(--nt-danger);
	border-color: var(--nt-danger);
	background: rgba(var(--nt-danger-rgb, 220 50 50), 0.08);
}

.key-card-confirm {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}

.key-card-confirm-label {
	font-size: 11px;
	color: var(--nt-fg-muted);
}

.key-card-confirm-btn {
	padding: 2px 8px;
	font-size: 11px;
	font-family: inherit;
	background: rgba(var(--nt-fg-rgb), 0.06);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	cursor: pointer;
}

.key-card-confirm-btn:hover {
	background: rgba(var(--nt-fg-rgb), 0.12);
}

.key-card-confirm-btn--danger {
	background: rgba(var(--nt-danger-rgb, 220 50 50), 0.12);
	border-color: var(--nt-danger);
	color: var(--nt-danger);
}

.key-card-confirm-btn--danger:hover {
	background: rgba(var(--nt-danger-rgb, 220 50 50), 0.22);
}
</style>
