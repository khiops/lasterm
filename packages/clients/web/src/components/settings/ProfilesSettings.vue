<template>
	<div class="profiles-settings">
		<!-- ── Form view ──────────────────────────────────────────────────── -->
		<ProfileForm
			v-if="formMode !== 'list'"
			v-bind="editingProfile !== undefined ? { profile: editingProfile } : {}"
			@saved="handleSaved"
			@cancel="formMode = 'list'"
		/>

		<!-- ── List view ──────────────────────────────────────────────────── -->
		<template v-else>
			<div class="profiles-header">
				<h3 class="profiles-title">Launch Profiles</h3>
				<button type="button" class="btn btn-primary" @click="openCreate">
					+ Add Profile
				</button>
			</div>

			<div v-if="profilesStore.loading" class="profiles-loading">
				Loading profiles…
			</div>

			<div v-else-if="profilesStore.profiles.length === 0" class="profiles-empty">
				<p class="empty-message">No profiles configured.</p>
				<p class="empty-sub">Create one to get started.</p>
			</div>

			<ul v-else class="profile-list" role="list">
				<li
					v-for="(profile, index) in profilesStore.profiles"
					:key="profile.id"
					class="profile-card"
				>
					<!-- Reorder controls -->
					<div class="reorder-col" aria-label="Reorder">
						<button
							type="button"
							class="reorder-btn"
							:disabled="index === 0"
							title="Move up"
							aria-label="Move profile up"
							@click="moveUp(index)"
						>
							▲
						</button>
						<button
							type="button"
							class="reorder-btn"
							:disabled="index === profilesStore.profiles.length - 1"
							title="Move down"
							aria-label="Move profile down"
							@click="moveDown(index)"
						>
							▼
						</button>
					</div>

					<!-- Icon -->
					<div class="profile-icon" :style="iconStyle(profile)">
						{{ profileIcon(profile) }}
					</div>

					<!-- Info -->
					<div class="profile-info">
						<div class="profile-name-row">
							<span class="profile-name">{{ profile.name }}</span>
							<span v-if="profile.elevated" class="elevated-badge" title="Elevated">🔒</span>
						</div>
						<span class="profile-shell">{{ profile.shell }}</span>
						<div class="profile-badges">
							<span class="badge" :class="`badge-os-${profile.supportedOs}`">
								{{ osBadgeLabel(profile.supportedOs) }}
							</span>
							<span class="badge badge-mode">
								{{ profile.mode === 'shell' ? 'Shell' : 'Process' }}
							</span>
						</div>
					</div>

					<!-- Actions -->
					<div class="profile-actions">
						<button
							type="button"
							class="action-btn"
							aria-label="Edit profile"
							@click="openEdit(profile)"
						>
							Edit
						</button>
						<button
							type="button"
							class="action-btn action-btn-danger"
							aria-label="Delete profile"
							@click="confirmDelete(profile)"
						>
							Delete
						</button>
					</div>
				</li>
			</ul>
		</template>

		<!-- ── Delete confirmation ────────────────────────────────────────── -->
		<div v-if="deletingProfile" class="delete-confirm-overlay" @click.self="deletingProfile = null">
			<div class="delete-confirm-dialog" role="alertdialog" aria-modal="true">
				<h4 class="delete-confirm-title">Delete Profile</h4>
				<p class="delete-confirm-msg">
					Delete <strong>{{ deletingProfile.name }}</strong>? This cannot be undone.
					Terminals using this profile will not be affected.
				</p>
				<div class="delete-confirm-actions">
					<button type="button" class="btn btn-ghost" @click="deletingProfile = null">Cancel</button>
					<button
						type="button"
						class="btn btn-danger"
						:disabled="deleteInProgress"
						@click="doDelete"
					>
						{{ deleteInProgress ? 'Deleting…' : 'Delete' }}
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import type { LaunchProfile, SupportedOs } from "@lasterm/shared";
import ProfileForm from "./ProfileForm.vue";
import { useProfilesStore } from "../../stores/profiles.js";

const profilesStore = useProfilesStore();

// ── View mode ────────────────────────────────────────────────────────────────

type FormMode = "list" | "create" | "edit";
const formMode = ref<FormMode>("list");
const editingProfile = ref<LaunchProfile | undefined>(undefined);

function openCreate(): void {
	editingProfile.value = undefined;
	formMode.value = "create";
}

function openEdit(profile: LaunchProfile): void {
	editingProfile.value = profile;
	formMode.value = "edit";
}

function handleSaved(_profile: LaunchProfile): void {
	formMode.value = "list";
	editingProfile.value = undefined;
}

// ── Delete ───────────────────────────────────────────────────────────────────

const deletingProfile = ref<LaunchProfile | null>(null);
const deleteInProgress = ref(false);

function confirmDelete(profile: LaunchProfile): void {
	deletingProfile.value = profile;
}

async function doDelete(): Promise<void> {
	if (!deletingProfile.value) return;
	deleteInProgress.value = true;
	try {
		await profilesStore.deleteProfile(deletingProfile.value.id);
		deletingProfile.value = null;
	} finally {
		deleteInProgress.value = false;
	}
}

// ── Reorder ──────────────────────────────────────────────────────────────────

async function moveUp(index: number): Promise<void> {
	if (index === 0) return;
	const profiles = [...profilesStore.profiles];
	const temp = profiles[index - 1]!;
	profiles[index - 1] = profiles[index]!;
	profiles[index] = temp;
	profilesStore.profiles = profiles;
	await profilesStore.reorderProfiles(profiles.map((p) => p.id));
}

async function moveDown(index: number): Promise<void> {
	if (index >= profilesStore.profiles.length - 1) return;
	const profiles = [...profilesStore.profiles];
	const temp = profiles[index + 1]!;
	profiles[index + 1] = profiles[index]!;
	profiles[index] = temp;
	profilesStore.profiles = profiles;
	await profilesStore.reorderProfiles(profiles.map((p) => p.id));
}

// ── Display helpers ──────────────────────────────────────────────────────────

function profileIcon(profile: LaunchProfile): string {
	if (profile.iconType === "emoji" && profile.iconValue) {
		return profile.iconValue;
	}
	// Auto-select by shell name
	const shell = profile.shell.toLowerCase();
	if (shell.includes("zsh")) return "🐚";
	if (shell.includes("fish")) return "🐟";
	if (shell.includes("bash")) return "💲";
	if (shell.includes("pwsh") || shell.includes("powershell")) return "🟦";
	if (shell.includes("cmd")) return "⬛";
	return ">";
}

function iconStyle(profile: LaunchProfile): Record<string, string> {
	if (profile.color) {
		return { background: profile.color + "33", color: profile.color };
	}
	return {};
}

function osBadgeLabel(os: SupportedOs): string {
	switch (os) {
		case "linux":
			return "Linux";
		case "darwin":
			return "macOS";
		case "windows":
			return "Windows";
		case "any":
			return "Any OS";
	}
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
	await profilesStore.fetchProfiles();
});
</script>

<style scoped>
.profiles-settings {
	display: flex;
	flex-direction: column;
	position: relative;
}

/* ── Header ──────────────────────────────────────────────────────────────── */

.profiles-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 16px;
}

.profiles-title {
	margin: 0;
	font-size: 15px;
	font-weight: 700;
	color: var(--nt-fg);
}

/* ── Loading / empty ─────────────────────────────────────────────────────── */

.profiles-loading {
	color: var(--nt-text-secondary);
	font-size: 13px;
	padding: 24px 0;
	text-align: center;
}

.profiles-empty {
	padding: 40px 0;
	text-align: center;
}

.empty-message {
	margin: 0;
	font-size: 14px;
	color: var(--nt-fg);
}

.empty-sub {
	margin: 4px 0 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

/* ── Profile list ────────────────────────────────────────────────────────── */

.profile-list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.profile-card {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	transition: border-color 0.15s ease;
}

.profile-card:hover {
	border-color: var(--nt-accent);
}

/* ── Reorder ─────────────────────────────────────────────────────────────── */

.reorder-col {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.reorder-btn {
	background: none;
	border: none;
	color: var(--nt-text-secondary);
	cursor: pointer;
	font-size: 9px;
	padding: 1px 3px;
	line-height: 1;
	border-radius: 3px;
}

.reorder-btn:hover:not(:disabled) {
	color: var(--nt-fg);
	background: var(--nt-border);
}

.reorder-btn:disabled {
	opacity: 0.2;
	cursor: not-allowed;
}

/* ── Icon ────────────────────────────────────────────────────────────────── */

.profile-icon {
	width: 36px;
	height: 36px;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--nt-bg-surface);
	border-radius: 8px;
	font-size: 18px;
	font-family: var(--nt-font-mono, monospace);
}

/* ── Info ────────────────────────────────────────────────────────────────── */

.profile-info {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.profile-name-row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.profile-name {
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
}

.elevated-badge {
	font-size: 12px;
}

.profile-shell {
	font-size: 11px;
	color: var(--nt-text-secondary);
	font-family: var(--nt-font-mono, monospace);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.profile-badges {
	display: flex;
	gap: 4px;
	flex-wrap: wrap;
}

.badge {
	display: inline-block;
	padding: 1px 7px;
	border-radius: 10px;
	font-size: 10px;
	font-weight: 600;
}

.badge-os-linux {
	background: color-mix(in srgb, var(--nt-yellow) 16%, transparent);
	color: var(--nt-yellow);
}

.badge-os-darwin {
	background: color-mix(in srgb, var(--nt-cyan) 16%, transparent);
	color: var(--nt-cyan);
}

.badge-os-windows {
	background: rgba(var(--nt-accent-rgb), 0.16);
	color: var(--nt-accent);
}

.badge-os-any {
	background: color-mix(in srgb, var(--nt-text-secondary) 16%, transparent);
	color: var(--nt-text-secondary);
}

.badge-mode {
	background: var(--nt-bg-surface);
	color: var(--nt-text-secondary);
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

.profile-actions {
	display: flex;
	gap: 6px;
	flex-shrink: 0;
}

.action-btn {
	padding: 4px 10px;
	background: transparent;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	transition:
		background 0.15s ease,
		border-color 0.15s ease;
}

.action-btn:hover {
	background: var(--nt-hover);
}

.action-btn-danger:hover {
	border-color: var(--nt-danger);
	color: var(--nt-danger);
	background: rgba(var(--nt-danger-rgb, 239, 68, 68), 0.08);
}

/* ── Delete confirm ──────────────────────────────────────────────────────── */

.delete-confirm-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 950;
}

.delete-confirm-dialog {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 10px;
	padding: 24px;
	max-width: 380px;
	width: 90%;
	box-shadow: var(--nt-shadow);
}

.delete-confirm-title {
	margin: 0 0 10px;
	font-size: 15px;
	font-weight: 700;
	color: var(--nt-fg);
}

.delete-confirm-msg {
	margin: 0 0 20px;
	font-size: 13px;
	color: var(--nt-text-secondary);
	line-height: 1.5;
}

.delete-confirm-actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
}

/* ── Buttons (shared with ProfileForm) ───────────────────────────────────── */

.btn {
	padding: 6px 14px;
	border-radius: 5px;
	font-size: 13px;
	font-family: inherit;
	font-weight: 500;
	cursor: pointer;
	border: 1px solid transparent;
	transition:
		background 0.15s ease,
		border-color 0.15s ease,
		opacity 0.15s ease;
}

.btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.btn-primary {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
	border-color: var(--nt-accent);
}

.btn-primary:hover:not(:disabled) {
	filter: brightness(1.1);
}

.btn-ghost {
	background: transparent;
	color: var(--nt-fg);
	border-color: var(--nt-border);
}

.btn-ghost:hover:not(:disabled) {
	background: var(--nt-hover);
}

.btn-danger {
	background: var(--nt-danger);
	color: var(--nt-danger-fg);
	border-color: var(--nt-danger);
}

.btn-danger:hover:not(:disabled) {
	filter: brightness(1.1);
}
</style>
