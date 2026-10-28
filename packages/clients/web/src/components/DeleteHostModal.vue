<template>
	<Teleport to="body">
		<div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
			<div class="dialog-content delete-host-modal">
				<div class="dialog-header">
					<h3 class="dialog-title">Delete Host</h3>
					<button class="dialog-close" @click="$emit('close')">
						&times;
					</button>
				</div>

				<div class="dialog-body">
					<p class="confirm-text">
						Are you sure you want to delete
						<strong>{{ hostLabel }}</strong
						>?
					</p>
					<p v-if="hasActiveSessions" class="warning-text">
						This host has active sessions. They will be
						disconnected. Type
						<strong>{{ hostLabel }}</strong> to confirm:
					</p>
					<input
						v-if="hasActiveSessions"
						v-model="confirmText"
						type="text"
						class="field-input"
						:placeholder="hostLabel"
					/>
				</div>

				<div class="dialog-actions">
					<span v-if="deleteError" class="action-error" role="alert">{{ deleteError }}</span>
					<button class="btn btn-secondary" @click="$emit('close')">
						Cancel
					</button>
					<button
						class="btn btn-danger"
						:disabled="
							hasActiveSessions && confirmText !== hostLabel
						"
						@click="onDelete"
					>
						Delete
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { whyRefused } from "../utils/hub-answer.js";

const props = defineProps<{
	visible: boolean;
	hostId: string;
}>();

const emit = defineEmits<{
	(e: "close"): void;
	(e: "deleted"): void;
}>();

const hostsStore = useHostsStore();
const channelsStore = useChannelsStore();
const confirmText = ref("");
/** Why the hub did not delete the host, or that it did not answer (#734). */
const deleteError = ref<string | null>(null);

const host = computed(() =>
	hostsStore.hosts.find((h) => h.id === props.hostId) ?? null,
);

const hostLabel = computed(() => host.value?.label ?? "");

const hasActiveSessions = computed(() => {
	// Check channel-level status: any channel belonging to this host that is
	// alive (live or orphan) means the host has active sessions.
	for (const [chId, hId] of channelsStore.channelHostMap) {
		if (hId !== props.hostId) continue;
		const ch = channelsStore.channels.find((c) => c.id === chId);
		if (ch && (ch.status === "live" || ch.status === "orphan")) return true;
	}
	// Fallback: session-level status for non-active hosts whose channels
	// aren't loaded in the channels store.
	const status = hostsStore.getHostStatus(props.hostId);
	return status === "live" || status === "reconnecting";
});

// Reset confirm text and the last refusal when modal opens/closes or host changes
watch(
	() => [props.visible, props.hostId],
	() => {
		confirmText.value = "";
		deleteError.value = null;
	},
);

/** Delete the host, or stay open and say why the hub did not. */
async function onDelete(): Promise<void> {
	deleteError.value = await whyRefused(hostsStore.deleteHost(props.hostId));
	if (deleteError.value !== null) return;
	emit("deleted");
	emit("close");
}
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

.dialog-content.delete-host-modal {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	min-width: 360px;
	max-width: 440px;
	width: 100%;
	box-shadow: var(--nt-shadow);
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
}

.confirm-text {
	margin: 0 0 8px;
	font-size: 13px;
	color: var(--nt-fg);
}

.warning-text {
	margin: 0 0 8px;
	font-size: 12px;
	color: var(--nt-yellow, #e5c07b);
}

.field-input {
	width: 100%;
	padding: 6px 8px;
	font-size: 12px;
	font-family: inherit;
	background: var(--nt-tab-bar);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	outline: none;
	transition: border-color 0.15s;
}

.field-input:focus {
	border-color: var(--nt-accent);
}

.dialog-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	justify-content: flex-end;
	padding: 12px 20px 16px;
	border-top: 1px solid var(--nt-border);
}

/* Why the hub did not delete the host (#734), beside the buttons that retry it. */
.action-error {
	flex: 1;
	min-width: 0;
	font-size: 12px;
	color: var(--nt-red, #e06c75);
	overflow-wrap: anywhere;
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

.btn-danger {
	background: var(--nt-red, #e06c75);
	color: #fff;
}
</style>
