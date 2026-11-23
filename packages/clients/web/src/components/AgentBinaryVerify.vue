<template>
	<Teleport to="body">
		<div
			v-if="prompt"
			class="abv-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="abv-title"
		>
			<div class="abv-card">
				<div class="abv-header">
					<span class="abv-icon" aria-hidden="true">
						<svg v-if="!prompt.mismatch" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M12 2L4 6V12C4 16.418 7.582 20.582 12 22C16.418 20.582 20 16.418 20 12V6L12 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>
							<path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
						<svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M12 2L4 6V12C4 16.418 7.582 20.582 12 22C16.418 20.582 20 16.418 20 12V6L12 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>
							<path d="M12 8V12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
							<circle cx="12" cy="15.5" r="0.75" fill="currentColor" stroke="currentColor" stroke-width="1"/>
						</svg>
					</span>
					<h3 id="abv-title" class="abv-title" :class="{ 'abv-title--mismatch': prompt.mismatch }">
						{{ prompt.mismatch ? 'Remote Agent Changed' : 'Verify Remote Agent' }}
					</h3>
				</div>

				<p class="abv-hostname">{{ prompt.hostname }}</p>

				<p class="abv-body">
					<template v-if="!prompt.mismatch">
						An agent binary was found on <strong>{{ prompt.hostname }}</strong> at
						<code class="abv-path">{{ prompt.remotePath }}</code>, but its identity cannot be verified.
					</template>
					<template v-else>
						The agent binary on <strong>{{ prompt.hostname }}</strong> has changed since it was last verified.
					</template>
				</p>

				<div class="abv-badge-row">
					<span class="abv-badge">{{ prompt.os }} / {{ prompt.arch }}</span>
				</div>

				<template v-if="prompt.mismatch && prompt.pinnedSha256">
					<div class="abv-hash-block">
						<span class="abv-hash-label">Previous</span>
						<button
							class="abv-hash-value abv-hash-old"
							type="button"
							:title="copiedOld ? 'Copied!' : 'Click to copy'"
							@click="copyOld"
						>{{ prompt.pinnedSha256 }}</button>
					</div>
				</template>

				<div class="abv-hash-block">
					<span class="abv-hash-label">{{ prompt.mismatch ? 'Current' : 'SHA256' }}</span>
					<button
						class="abv-hash-value"
						:class="{ 'abv-hash-new': prompt.mismatch }"
						type="button"
						:title="copiedNew ? 'Copied!' : 'Click to copy'"
						@click="copyNew"
					>{{ prompt.remoteSha256 }}</button>
				</div>

				<div class="abv-actions">
					<span class="abv-countdown">Auto-reject in {{ remaining }}s</span>
					<button
						class="abv-btn abv-reject"
						:data-prompt-id="prompt.promptId"
						@click="handleReject"
					>Reject</button>
					<button
						class="abv-btn abv-trust-once"
						:data-prompt-id="prompt.promptId"
						@click="handleTrustOnce"
					>Trust Once</button>
					<button
						class="abv-btn abv-accept"
						:data-prompt-id="prompt.promptId"
						@click="handleAccept"
					>Trust Permanently</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useAgentVerifyStore } from "../stores/agent-verify.js";

const store = useAgentVerifyStore();
const prompt = computed(() => store.currentPrompt);

const copiedOld = ref(false);
const copiedNew = ref(false);
const remaining = ref(30);
const TIMEOUT_MS = 30_000;
let deadline = 0;
let interval: ReturnType<typeof setInterval> | null = null;

watch(
	() => store.currentPrompt,
	(prompt) => {
		// Always clear any previous interval first — handles the case where
		// one prompt is immediately replaced by the next (promptA → promptB
		// never goes through null, so the old interval would keep ticking).
		if (interval) {
			clearInterval(interval);
			interval = null;
		}
		if (prompt) {
			deadline = Date.now() + TIMEOUT_MS;
			remaining.value = 30;
			const promptId = prompt.promptId;
			interval = setInterval(() => {
				const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
				remaining.value = left;
				if (left <= 0) {
					clearInterval(interval!);
					interval = null;
					store.reject(promptId);
				}
			}, 250);
		}
	},
	{ immediate: true },
);

onUnmounted(() => {
	if (interval) clearInterval(interval);
});

async function copyOld(): Promise<void> {
	if (!prompt.value?.pinnedSha256) return;
	await navigator.clipboard.writeText(prompt.value.pinnedSha256);
	copiedOld.value = true;
	setTimeout(() => {
		copiedOld.value = false;
	}, 1500);
}

async function copyNew(): Promise<void> {
	if (!prompt.value) return;
	await navigator.clipboard.writeText(prompt.value.remoteSha256);
	copiedNew.value = true;
	setTimeout(() => {
		copiedNew.value = false;
	}, 1500);
}

function promptIdFromEvent(event: MouseEvent): string | undefined {
	return (event.currentTarget as HTMLElement | null)?.dataset.promptId;
}

function handleAccept(event: MouseEvent): void {
	store.trustPermanently(promptIdFromEvent(event));
}

function handleTrustOnce(event: MouseEvent): void {
	store.trustOnce(promptIdFromEvent(event));
}

function handleReject(event: MouseEvent): void {
	store.reject(promptIdFromEvent(event));
}
</script>

<style scoped>
.abv-backdrop {
	position: fixed;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(0, 0, 0, 0.55);
	z-index: 10200;
}

.abv-card {
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
	animation: abv-slide-in 0.2s ease-out;
}

@keyframes abv-slide-in {
	from {
		transform: translateY(-12px);
		opacity: 0;
	}
	to {
		transform: translateY(0);
		opacity: 1;
	}
}

.abv-header {
	display: flex;
	align-items: center;
	gap: 10px;
}

.abv-icon {
	display: flex;
	align-items: center;
	flex-shrink: 0;
	color: var(--nt-accent);
}

.abv-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-accent);
}

.abv-title--mismatch {
	color: #e0a030;
}

.abv-icon:has(+ .abv-title--mismatch) {
	color: #e0a030;
}

.abv-hostname {
	margin: 0;
	font-size: 13px;
	font-weight: 500;
	color: var(--nt-fg);
}

.abv-body {
	margin: 0;
	font-size: 12px;
	color: var(--nt-text-muted);
	line-height: 1.5;
}

.abv-path {
	font-family: monospace;
	background: var(--nt-tab-bar);
	border: 1px solid var(--nt-border);
	border-radius: 3px;
	padding: 1px 4px;
	font-size: 11px;
	color: var(--nt-fg);
	word-break: break-all;
}

.abv-badge-row {
	display: flex;
	gap: 6px;
}

.abv-badge {
	display: inline-flex;
	align-items: center;
	font-size: 10px;
	font-weight: 600;
	font-family: monospace;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	background: var(--nt-tab-bar);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	padding: 2px 7px;
	color: var(--nt-text-muted);
}

.abv-hash-block {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.abv-hash-label {
	font-size: 11px;
	color: var(--nt-text-muted);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.abv-hash-value {
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

.abv-hash-value:hover {
	border-color: var(--nt-accent);
}

.abv-hash-old {
	border-color: rgba(229, 83, 75, 0.4);
}

.abv-hash-new {
	border-color: rgba(224, 160, 48, 0.5);
}

.abv-actions {
	display: flex;
	gap: 8px;
	align-items: center;
	justify-content: flex-end;
	margin-top: 4px;
}

.abv-countdown {
	font-size: 11px;
	color: var(--nt-text-muted);
	margin-right: auto;
}

.abv-btn {
	height: 32px;
	padding: 0 14px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	border: 1px solid transparent;
	transition: background 0.12s, opacity 0.12s;
}

.abv-reject {
	background: var(--nt-border);
	border-color: var(--nt-tab-hover);
	color: var(--nt-text-muted);
}

.abv-reject:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.abv-trust-once {
	background: var(--nt-border);
	border-color: var(--nt-tab-hover);
	color: var(--nt-accent);
}

.abv-trust-once:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-accent);
	opacity: 0.9;
}

.abv-accept {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.abv-accept:hover {
	box-shadow: inset 0 0 0 1px currentColor;
}
</style>
