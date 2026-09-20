<template>
	<Teleport to="body">
		<div
			v-if="prompt"
			class="hkw-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="hkw-title"
		>
			<div class="hkw-card">
				<div class="hkw-header">
					<span class="hkw-icon" aria-hidden="true">&#9888;</span>
					<h3 id="hkw-title" class="hkw-title">
						{{ prompt.firstConnect ? 'First SSH Connection' : 'SSH Host Key Changed' }}
					</h3>
				</div>

				<p class="hkw-hostname">{{ prompt.hostname }}</p>

				<p class="hkw-warning">
					<template v-if="prompt.firstConnect">
						First connection to this host. Verify the fingerprint before trusting it.
					</template>
					<template v-else>
						The SSH host key for this server has changed. This could indicate a
						man-in-the-middle attack.
					</template>
				</p>

				<template v-if="!prompt.firstConnect && prompt.oldFingerprint">
					<div class="hkw-fingerprint-block">
						<span class="hkw-fp-label">Previous key</span>
						<button
							class="hkw-fp-value"
							type="button"
							:title="copiedOld ? 'Copied!' : 'Click to copy'"
							@click="copyOld"
						>{{ prompt.oldFingerprint }}</button>
					</div>
				</template>

				<div class="hkw-fingerprint-block">
					<span class="hkw-fp-label">{{ prompt.firstConnect ? 'Server fingerprint' : 'New key' }}</span>
					<button
						class="hkw-fp-value"
						:class="{ 'hkw-fp-new': !prompt.firstConnect }"
						type="button"
						:title="copiedNew ? 'Copied!' : 'Click to copy'"
						@click="copyNew"
					>{{ prompt.fingerprint }}</button>
				</div>

				<template v-if="prompt.knownHosts?.verdict === 'trusted'">
					<p class="hkw-known">
						Your SSH configuration already trusts this exact key
						(<code>{{ prompt.knownHosts.file }}:{{ prompt.knownHosts.line }}</code>), which
						is why <code>ssh</code> connects to this host without asking.
					</p>
					<label class="hkw-known-choice">
						<input v-model="trustKnownHosts" type="checkbox" :disabled="savingPreference" />
						<span>
							Take that as reason enough from now on — hosts whose key is already in
							<code>known_hosts</code> will not be asked about again.
						</span>
					</label>
					<p v-if="preferenceError" class="hkw-known-error">{{ preferenceError }}</p>
				</template>

				<p v-else-if="prompt.knownHosts?.verdict === 'other-key'" class="hkw-known-warning">
					⚠ Your SSH configuration knows this host under a <strong>different</strong> key
					(<code>{{ prompt.knownHosts.file }}:{{ prompt.knownHosts.line }}</code>). Do not
					trust this one unless you know why it changed.
				</p>

				<div class="hkw-actions">
					<button
						class="hkw-btn hkw-reject"
						:data-prompt-id="prompt.promptId"
						@click="handleReject"
					>Reject</button>
					<button
						class="hkw-btn hkw-trust-once"
						:data-prompt-id="prompt.promptId"
						@click="handleTrustOnce"
					>Trust Once</button>
					<button
						class="hkw-btn hkw-accept"
						:data-prompt-id="prompt.promptId"
						@click="handleAccept"
					>
						{{ prompt.firstConnect ? 'Trust Permanently' : 'Accept New Key' }}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useHostVerifyStore } from "../stores/host-verify.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";

const store = useHostVerifyStore();
const prompt = computed(() => store.pendingPrompt);

const copiedOld = ref(false);
const copiedNew = ref(false);

/**
 * The checkbox is a setting, not part of the answer to this prompt: it says
 * what to do with the *next* host whose key is already known here. It is
 * written the moment it is ticked, so the decision survives whatever is
 * clicked next — including Reject.
 */
const trustKnownHosts = ref(false);
const savingPreference = ref(false);
const preferenceError = ref("");

watch(trustKnownHosts, async (wanted) => {
	savingPreference.value = true;
	preferenceError.value = "";
	try {
		const response = await hubFetch(`${hubBaseUrl()}/api/config/ssh`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${useAuthStore().token ?? ""}`,
			},
			body: JSON.stringify({ trustKnownHosts: wanted }),
		});
		if (!response.ok) throw new Error(`hub answered ${response.status}`);
	} catch (error) {
		// Saying it did not take is the point: a checkbox that silently failed
		// would be read as a decision made.
		preferenceError.value = `Could not save that preference: ${error instanceof Error ? error.message : String(error)}`;
		trustKnownHosts.value = !wanted;
	} finally {
		savingPreference.value = false;
	}
});

async function copyOld(): Promise<void> {
	if (!prompt.value) return;
	await navigator.clipboard.writeText(prompt.value.oldFingerprint);
	copiedOld.value = true;
	setTimeout(() => {
		copiedOld.value = false;
	}, 1500);
}

async function copyNew(): Promise<void> {
	if (!prompt.value) return;
	await navigator.clipboard.writeText(prompt.value.fingerprint);
	copiedNew.value = true;
	setTimeout(() => {
		copiedNew.value = false;
	}, 1500);
}

function promptIdFromEvent(event: MouseEvent): string | undefined {
	return (event.currentTarget as HTMLElement | null)?.dataset.promptId;
}

function handleAccept(event: MouseEvent): void {
	store.accept(promptIdFromEvent(event));
}

function handleTrustOnce(event: MouseEvent): void {
	store.trustOnce(promptIdFromEvent(event));
}

function handleReject(event: MouseEvent): void {
	store.reject(promptIdFromEvent(event));
}
</script>

<style scoped>
.hkw-backdrop {
	position: fixed;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(0, 0, 0, 0.55);
	z-index: 10200;
}

.hkw-card {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 10px;
	padding: 24px 28px;
	width: 440px;
	max-width: calc(100vw - 48px);
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
	gap: 14px;
	animation: hkw-slide-in 0.2s ease-out;
}

@keyframes hkw-slide-in {
	from {
		transform: translateY(-12px);
		opacity: 0;
	}
	to {
		transform: translateY(0);
		opacity: 1;
	}
}

.hkw-header {
	display: flex;
	align-items: center;
	gap: 10px;
}

.hkw-icon {
	font-size: 20px;
	color: #e5534b;
	flex-shrink: 0;
}

.hkw-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: #e5534b;
}

.hkw-hostname {
	margin: 0;
	font-size: 13px;
	font-weight: 500;
	color: var(--nt-fg);
}

.hkw-warning {
	margin: 0;
	font-size: 12px;
	color: var(--nt-text-muted);
	line-height: 1.5;
}

.hkw-fingerprint-block {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.hkw-fp-label {
	font-size: 11px;
	color: var(--nt-text-muted);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.hkw-fp-value {
	font-family: monospace;
	font-size: 11px;
	background: var(--nt-tab-bar);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	padding: 6px 8px;
	color: var(--nt-fg);
	cursor: pointer;
	text-align: left;
	word-break: break-all;
	transition: border-color 0.12s;
}

.hkw-fp-value:hover {
	border-color: var(--nt-accent);
}

.hkw-fp-new {
	border-color: rgba(229, 83, 75, 0.4);
}

.hkw-known {
	margin: 0 0 8px;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.hkw-known code {
	font-size: 11px;
}

.hkw-known-choice {
	display: flex;
	gap: 8px;
	align-items: flex-start;
	margin: 0 0 12px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	cursor: pointer;
}

.hkw-known-error {
	margin: -6px 0 12px;
	font-size: 12px;
	color: var(--nt-danger);
}

.hkw-known-warning {
	margin: 0 0 12px;
	font-size: 12px;
	color: var(--nt-badge-warning, #f9e2af);
}

.hkw-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 4px;
}

.hkw-btn {
	height: 32px;
	padding: 0 14px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	border: 1px solid transparent;
	transition: background 0.12s, opacity 0.12s;
}

.hkw-reject {
	background: var(--nt-border);
	border-color: var(--nt-tab-hover);
	color: var(--nt-text-muted);
}

.hkw-reject:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.hkw-trust-once {
	background: var(--nt-border);
	border-color: var(--nt-tab-hover);
	color: var(--nt-accent);
}

.hkw-trust-once:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-accent);
	opacity: 0.9;
}

.hkw-accept {
	background: #e5534b;
	color: #fff;
}

.hkw-accept:hover {
	opacity: 0.85;
}
</style>
