<template>
	<Teleport to="body">
		<div
			v-if="visible"
			class="profile-dropdown-backdrop"
			@mousedown.self="emit('close')"
			@keydown.escape="emit('close')"
		>
			<div
				ref="dropdownEl"
				class="profile-dropdown"
				:style="positionStyle"
				role="menu"
				aria-label="Launch profiles"
			>
				<!-- Profile list -->
				<template v-if="loadingProfiles">
					<div class="profile-dropdown__loading">Loading…</div>
				</template>

				<template v-else>
					<button
						v-for="profile in visibleProfiles"
						:key="profile.id"
						class="profile-dropdown__item"
						:class="{ 'profile-dropdown__item--default': isDefault(profile.id) }"
						role="menuitem"
						type="button"
						@click="onProfileClick(profile.id)"
					>
						<span class="profile-dropdown__icon" aria-hidden="true">
							{{ profileIcon(profile) }}
						</span>
						<span class="profile-dropdown__info">
							<span class="profile-dropdown__name">
								{{ profile.name }}
								<span v-if="isDefault(profile.id)" class="profile-dropdown__default-mark" aria-label="Default profile">✓</span>
							</span>
							<span class="profile-dropdown__shell" :title="profile.shell">{{ truncateShell(profile.shell) }}</span>
						</span>
					</button>

					<template v-if="visibleProfiles.length > 0">
						<div class="profile-dropdown__divider" role="separator" />
					</template>

					<!-- Quick command -->
					<button
						v-if="!showQuickInput"
						class="profile-dropdown__item profile-dropdown__item--action"
						role="menuitem"
						type="button"
						@click="onRunCommand"
					>
						<span class="profile-dropdown__icon" aria-hidden="true">⌨</span>
						<span class="profile-dropdown__info">
							<span class="profile-dropdown__name">Run command…</span>
						</span>
					</button>

					<QuickCommandInput
						v-else
						@close="emit('close')"
					/>
				</template>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import type { LaunchProfile } from "@lasterm/shared";
import type { HostVisibleProfile } from "../stores/profiles.js";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useProfilesStore } from "../stores/profiles.js";
import QuickCommandInput from "./QuickCommandInput.vue";

const props = defineProps<{
	visible: boolean;
	/** Anchor element — the dropdown will align to its bottom-right edge. */
	anchorEl: HTMLElement | null;
	/** Active host ID for fetching host-specific profiles. */
	hostId: string | null;
}>();

const emit = defineEmits<{
	(e: "close"): void;
}>();

const profilesStore = useProfilesStore();

const dropdownEl = ref<HTMLElement | null>(null);
const loadingProfiles = ref(false);
const visibleProfiles = ref<HostVisibleProfile[]>([]);
const showQuickInput = ref(false);

// -------------------------------------------------------------------------
// Position: align dropdown below and right-aligned to the anchor button
// -------------------------------------------------------------------------

const positionStyle = ref<Record<string, string>>({});

function updatePosition(): void {
	if (!props.anchorEl) return;
	const rect = props.anchorEl.getBoundingClientRect();
	positionStyle.value = {
		position: "fixed",
		top: `${rect.bottom + 4}px`,
		right: `${window.innerWidth - rect.right}px`,
	};
}

// -------------------------------------------------------------------------
// Load profiles when visible
// -------------------------------------------------------------------------

watch(
	() => props.visible,
	async (isVisible) => {
		if (!isVisible) {
			showQuickInput.value = false;
			visibleProfiles.value = [];
			return;
		}

		updatePosition();
		showQuickInput.value = false;

		if (props.hostId === null) return;

		loadingProfiles.value = true;
		try {
			visibleProfiles.value = await profilesStore.fetchHostProfiles(props.hostId);
		} catch {
			visibleProfiles.value = [];
		} finally {
			loadingProfiles.value = false;
		}
	},
);

// -------------------------------------------------------------------------
// Click-outside: close via Escape key
// -------------------------------------------------------------------------

function onGlobalKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") {
		emit("close");
	}
}

onMounted(() => {
	window.addEventListener("keydown", onGlobalKeydown, { capture: true });
});

onUnmounted(() => {
	window.removeEventListener("keydown", onGlobalKeydown, { capture: true });
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Whether a profile is the "default" for this host (marked via overrideType=default). */
function isDefault(profileId: string): boolean {
	const profile = visibleProfiles.value.find((p) => p.id === profileId);
	return profile?.overrideType === "default";
}

function profileIcon(profile: LaunchProfile): string {
	if (profile.iconType === "emoji" && profile.iconValue) return profile.iconValue;
	return "▶";
}

function truncateShell(shell: string): string {
	const max = 28;
	if (shell.length <= max) return shell;
	const parts = shell.split("/");
	const name = parts[parts.length - 1] ?? shell;
	if (name.length <= max) return `…/${name}`;
	return `${name.slice(0, max)}…`;
}

// -------------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------------

function onProfileClick(profileId: string): void {
	profilesStore.spawnFromProfile(profileId);
	emit("close");
}

function onRunCommand(): void {
	showQuickInput.value = true;
}

/** ID of the default profile for this host (if any). */
const defaultProfileId = computed(() => {
	const def = visibleProfiles.value.find((p) => p.overrideType === "default");
	return def?.id ?? null;
});

defineExpose({ defaultProfileId });
</script>

<style scoped>
.profile-dropdown-backdrop {
	position: fixed;
	inset: 0;
	z-index: 9000;
}

.profile-dropdown {
	min-width: 220px;
	max-width: 320px;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
	padding: 4px 0;
	z-index: 9001;
	overflow: hidden;
}

.profile-dropdown__loading {
	padding: 8px 12px;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.profile-dropdown__item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 6px 12px;
	background: transparent;
	border: none;
	color: var(--nt-fg);
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	text-align: left;
	transition: background 0.1s;
}

.profile-dropdown__item:hover {
	background: var(--nt-tab-hover);
}

.profile-dropdown__item--default {
	font-weight: 600;
}

.profile-dropdown__item--action {
	color: var(--nt-text-secondary);
}

.profile-dropdown__item--action:hover {
	color: var(--nt-fg);
}

.profile-dropdown__icon {
	flex-shrink: 0;
	width: 18px;
	text-align: center;
	font-size: 13px;
}

.profile-dropdown__info {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.profile-dropdown__name {
	display: flex;
	align-items: center;
	gap: 4px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.profile-dropdown__default-mark {
	color: var(--nt-accent);
	font-size: 11px;
}

.profile-dropdown__shell {
	font-size: 10px;
	color: var(--nt-text-secondary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.profile-dropdown__divider {
	height: 1px;
	background: var(--nt-border);
	margin: 4px 0;
}
</style>
