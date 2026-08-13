<template>
	<div class="generator">
		<button class="gen-btn" :disabled="loading || !!activeCode" @click="generate">
			<span v-if="loading" class="spinner" aria-hidden="true" />
			{{ loading ? "Generating…" : "Generate Pairing Code" }}
		</button>

		<div v-if="activeCode" class="code-display">
			<div class="code-row">
				<span class="code-value">{{ activeCode }}</span>
				<button class="copy-btn" :class="{ copied }" @click="copyCode" :aria-label="copied ? 'Copied' : 'Copy code'">
					{{ copied ? "Copied!" : "Copy" }}
				</button>
			</div>
			<div class="countdown-bar-wrap" :title="`Expires in ${secondsLeft}s`">
				<div
					class="countdown-bar"
					:style="{ width: `${totalSeconds > 0 ? (secondsLeft / totalSeconds) * 100 : 0}%` }"
					:class="{ urgent: secondsLeft <= 10 }"
				/>
			</div>
			<p class="countdown-label">Expires in {{ secondsLeft }}s</p>
		</div>

		<p v-if="errorMsg" class="gen-error" role="alert">{{ errorMsg }}</p>
	</div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { hubBaseUrl } from "../utils/hub-url.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { useAuthStore } from "../stores/auth.js";

const authStore = useAuthStore();

const loading = ref(false);
const activeCode = ref<string | null>(null);
const secondsLeft = ref(60);
const totalSeconds = ref(60);
const copied = ref(false);
const errorMsg = ref<string | null>(null);

let countdown: ReturnType<typeof setInterval> | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function clearCountdown(): void {
	if (countdown !== null) {
		clearInterval(countdown);
		countdown = null;
	}
}

onUnmounted(() => {
	clearCountdown();
	if (copyTimer !== null) clearTimeout(copyTimer);
});

async function generate(): Promise<void> {
	loading.value = true;
	errorMsg.value = null;
	activeCode.value = null;
	secondsLeft.value = 60;
	totalSeconds.value = 60;
	clearCountdown();

	try {
		const res = await hubFetch(`${hubBaseUrl()}/api/pair`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authStore.token ?? ""}`,
			},
		});

		if (!res.ok) {
			const body = (await res.json().catch(() => ({ message: "Request failed" }))) as {
				message?: string;
			};
			throw new Error(body.message ?? `HTTP ${res.status}`);
		}

		const data = (await res.json()) as { code: string; expires_at?: string };
		activeCode.value = data.code;

		if (data.expires_at) {
			const remaining = Math.floor(
				(new Date(data.expires_at).getTime() - Date.now()) / 1_000,
			);
			secondsLeft.value = Math.max(remaining, 0);
		}
		totalSeconds.value = secondsLeft.value;

		countdown = setInterval(() => {
			secondsLeft.value--;
			if (secondsLeft.value <= 0) {
				clearCountdown();
				activeCode.value = null;
			}
		}, 1_000);
	} catch (err) {
		errorMsg.value = err instanceof Error ? err.message : String(err);
	} finally {
		loading.value = false;
	}
}

async function copyCode(): Promise<void> {
	if (!activeCode.value) return;
	try {
		await navigator.clipboard.writeText(activeCode.value);
		copied.value = true;
		if (copyTimer !== null) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied.value = false;
		}, 2_000);
	} catch {
		// Clipboard unavailable — silently ignore
	}
}
</script>

<style scoped>
.generator {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 12px 0;
}

.gen-btn {
	height: 36px;
	padding: 0 16px;
	background: var(--nt-accent);
	border: 1px solid var(--nt-accent);
	border-radius: 6px;
	color: #fff;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	transition: background 0.15s, opacity 0.15s;
	display: inline-flex;
	align-items: center;
	gap: 8px;
}

.gen-btn:hover:not(:disabled) {
	opacity: 0.85;
}

.gen-btn:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.code-display {
	background: var(--nt-tab-bar);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 12px 16px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.code-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.code-value {
	font-size: 26px;
	font-weight: 700;
	letter-spacing: 0.25em;
	font-family: "Cascadia Code", "Fira Code", monospace;
	color: var(--nt-accent);
}

.copy-btn {
	height: 28px;
	padding: 0 10px;
	background: var(--nt-border);
	border: 1px solid var(--nt-tab-hover);
	border-radius: 4px;
	color: var(--nt-text-muted);
	font-size: 12px;
	cursor: pointer;
	transition: background 0.15s, color 0.15s;
	white-space: nowrap;
}

.copy-btn:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.copy-btn.copied {
	color: var(--nt-green);
	border-color: var(--nt-green);
}

.countdown-bar-wrap {
	width: 100%;
	height: 3px;
	background: var(--nt-border);
	border-radius: 2px;
	overflow: hidden;
}

.countdown-bar {
	height: 100%;
	background: var(--nt-accent);
	border-radius: 2px;
	transition: width 1s linear, background 0.3s;
}

.countdown-bar.urgent {
	background: var(--nt-badge);
}

.countdown-label {
	margin: 0;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.gen-error {
	margin: 0;
	font-size: 12px;
	color: var(--nt-badge);
}

.spinner {
	width: 12px;
	height: 12px;
	border: 2px solid rgba(var(--nt-fg-rgb), 0.2);
	border-top-color: var(--nt-fg);
	border-radius: 50%;
	animation: spin 0.7s linear infinite;
	flex-shrink: 0;
}

@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}
</style>
