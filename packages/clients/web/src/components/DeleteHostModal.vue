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
					<p v-if="consent" class="warning-text">{{ warningText }}</p>
					<p v-if="consent">Type <strong>{{ hostLabel }}</strong> to confirm:</p>
					<input
						v-if="consent"
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
							submitting || (consent !== null && confirmText !== hostLabel)
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
import { type HostDeleteAnswer, useHostsStore } from "../stores/hosts.js";
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
const confirmText = ref("");
const consent = ref<{ terminals: number; unreachable: number } | null>(null);
const submitting = ref(false);
let opening = 0;
/** Why the hub did not delete the host, or that it did not answer (#734). */
const deleteError = ref<string | null>(null);

const host = computed(() =>
	hostsStore.hosts.find((h) => h.id === props.hostId) ?? null,
);

// An older opening's successful delete can remove the cached row while this one is open.
const openingLabel = ref(host.value?.label ?? "");
const hostLabel = computed(() => host.value?.label ?? openingLabel.value);

const warningText = computed(() => {
	if (!consent.value) return "";
	const { terminals, unreachable } = consent.value;
	const one = terminals === 1;
	const text = `${terminals} ${one ? "terminal" : "terminals"} on ${hostLabel.value} ${one ? "has" : "have"} not ended`;
	if (unreachable > 0) {
		return `${text}, and Lasterm is not connected to ${one ? "its" : "their"} agent: nothing can be sent to ${one ? "it" : "them"}, and ${one ? "it" : "they"} may keep running.${host.value?.type === "ssh" ? ` Connecting ${hostLabel.value} first may let Lasterm reach ${one ? "it" : "them"}.` : ""}`;
	}
	return `${text}. Lasterm will ask ${one ? "its" : "their"} agent to end ${one ? "it" : "them"}, without waiting for it to confirm.`;
});

// Reset confirm text and the last refusal when modal opens/closes or host changes
watch(
	() => [props.visible, props.hostId],
	() => {
		opening++;
		openingLabel.value = host.value?.label ?? "";
		confirmText.value = "";
		deleteError.value = null;
		consent.value = null;
		submitting.value = false;
	},
);

/** Delete the host, or stay open and say why the hub did not. */
async function onDelete(): Promise<void> {
	if (submitting.value || (consent.value !== null && confirmText.value !== hostLabel.value)) return;
	const hostId = props.hostId;
	const sentFrom = opening;
	const force = consent.value !== null;
	submitting.value = true;
	let answer: HostDeleteAnswer | undefined;
	const reason = await whyRefused(
		hostsStore.deleteHost(hostId, { force }).then((value) => {
			answer = value;
			return value;
		}),
	);
	if (hostId !== props.hostId || sentFrom !== opening || !props.visible) return;
	submitting.value = false;
	if (
		!force && answer && !answer.ok && answer.status === 409 &&
		answer.code === "TERMINALS_WOULD_END" && typeof answer.terminals === "number"
	) {
		consent.value = { terminals: answer.terminals, unreachable: answer.unreachable ?? 0 };
		deleteError.value = null;
		return;
	}
	deleteError.value = reason;
	if (reason !== null) return;
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
