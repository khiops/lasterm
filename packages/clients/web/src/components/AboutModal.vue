<template>
	<Teleport to="body">
		<div v-if="show" class="dialog-overlay" @click.self="emit('close')">
			<div class="dialog-content about-modal" role="dialog" aria-modal="true" aria-label="About Lasterm">
				<!-- Header -->
				<div class="dialog-header">
					<h3 class="dialog-title">About</h3>
					<button class="dialog-close" type="button" aria-label="Close" @click="emit('close')">
						&times;
					</button>
				</div>

				<!-- Body -->
				<div class="dialog-body">
					<!-- App identity -->
					<div class="about-identity">
						<span class="about-appname">Lasterm</span>
						<span class="about-tagline">Local-first session terminal platform</span>
					</div>

					<!-- Version row -->
					<div class="about-row">
						<span class="about-label">Version</span>
						<span class="about-value version-value">
							<span class="version-text">{{ versionString }}</span>
							<button
								class="btn-copy"
								type="button"
								:title="copied ? 'Copied!' : 'Copy version for bug reports'"
								@click="copyVersion"
							>
								<span v-if="copied" class="copy-icon copy-ok">✓</span>
								<span v-else class="copy-icon">⎘</span>
							</button>
						</span>
					</div>

					<!-- License row -->
					<div class="about-row">
						<span class="about-label">License</span>
						<span class="about-value">MIT</span>
					</div>

					<!-- Links -->
					<div class="about-links">
						<a
							href="https://o2csi.com"
							target="_blank"
							rel="noopener noreferrer"
							class="about-link"
						>
							Website
							<span class="ext-icon">↗</span>
						</a>
						<a
							href="https://github.com/khiops/lasterm"
							target="_blank"
							rel="noopener noreferrer"
							class="about-link"
						>
							GitHub
							<span class="ext-icon">↗</span>
						</a>
						<a
							href="https://github.com/khiops/lasterm/issues"
							target="_blank"
							rel="noopener noreferrer"
							class="about-link"
						>
							Report an issue
							<span class="ext-icon">↗</span>
						</a>
					</div>
				</div>

				<!-- Footer -->
				<div class="dialog-actions">
					<button class="btn btn-secondary" type="button" @click="emit('close')">
						Close
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { hubBaseUrl } from '../utils/hub-url.js';
import { hubFetch } from '../utils/hub-fetch.js';

const BUILD_HASH: string = (import.meta.env['VITE_BUILD_HASH'] as string | undefined) ?? 'dev';

const props = defineProps<{
	show: boolean;
}>();

const emit = defineEmits<{
	close: [];
}>();

const authStore = useAuthStore();

// ─── Version fetch (lazy, cached) ─────────────────────────────────────

const version = ref<string | null>(null);
const fetchError = ref(false);

async function fetchVersion(): Promise<void> {
	if (version.value !== null || fetchError.value) return;
	try {
		const res = await hubFetch(`${hubBaseUrl()}/api/health`, {
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { status: string; version: string; build: string };
		version.value = data.version;
	} catch {
		fetchError.value = true;
		version.value = 'unknown';
	}
}

watch(
	() => props.show,
	(visible) => {
		if (visible) void fetchVersion();
	},
);

// ─── Derived display strings ───────────────────────────────────────────

const versionString = computed(() => {
	if (version.value === null) return 'Loading…';
	return `v${version.value} (${BUILD_HASH})`;
});

const copyText = computed(() => `Lasterm ${versionString.value}`);

// ─── Copy to clipboard ─────────────────────────────────────────────────

const copied = ref(false);

async function copyVersion(): Promise<void> {
	try {
		await navigator.clipboard.writeText(copyText.value);
		copied.value = true;
		setTimeout(() => {
			copied.value = false;
		}, 1500);
	} catch {
		// clipboard not available — silently ignore
	}
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

.dialog-content.about-modal {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	width: 380px;
	max-width: calc(100vw - 48px);
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
}

/* ── Header ─────────────────────────────────────────────────────────── */

.dialog-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	border-bottom: 1px solid var(--nt-border);
}

.dialog-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.dialog-close {
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 18px;
	cursor: pointer;
	padding: 2px 6px;
	line-height: 1;
	border-radius: 4px;
	transition: color 0.15s ease, background 0.15s ease;
}

.dialog-close:hover {
	color: var(--nt-fg);
	background: var(--nt-border);
}

/* ── Body ────────────────────────────────────────────────────────────── */

.dialog-body {
	padding: 24px 24px 16px;
	display: flex;
	flex-direction: column;
	gap: 16px;
}

/* App identity block */
.about-identity {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding-bottom: 16px;
	border-bottom: 1px solid var(--nt-border);
}

.about-appname {
	font-size: 22px;
	font-weight: 700;
	color: var(--nt-fg);
	letter-spacing: -0.3px;
}

.about-tagline {
	font-size: 12px;
	color: var(--nt-text-secondary);
}

/* Info rows */
.about-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 13px;
}

.about-label {
	color: var(--nt-text-secondary);
}

.about-value {
	color: var(--nt-fg);
}

.version-value {
	display: flex;
	align-items: center;
	gap: 6px;
}

.version-text {
	font-family: monospace;
	font-size: 12px;
}

.btn-copy {
	background: transparent;
	border: 1px solid var(--nt-border);
	color: var(--nt-text-secondary);
	font-size: 13px;
	cursor: pointer;
	padding: 1px 5px;
	line-height: 1.4;
	border-radius: 4px;
	transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.btn-copy:hover {
	color: var(--nt-fg);
	background: var(--nt-border);
	border-color: var(--nt-text-secondary);
}

.copy-icon {
	display: inline-block;
}

.copy-ok {
	color: var(--nt-badge-success);
}

/* Links section */
.about-links {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding-top: 4px;
	border-top: 1px solid var(--nt-border);
}

.about-link {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 13px;
	color: var(--nt-accent);
	text-decoration: none;
	padding: 6px 0;
	transition: color 0.15s ease;
}

.about-link:hover {
	color: var(--nt-fg);
}

.ext-icon {
	font-size: 11px;
	color: var(--nt-text-secondary);
}

/* ── Footer ──────────────────────────────────────────────────────────── */

.dialog-actions {
	display: flex;
	justify-content: flex-end;
	padding: 12px 20px 16px;
	border-top: 1px solid var(--nt-border);
}

.btn {
	padding: 7px 16px;
	font-size: 13px;
	border-radius: 6px;
	cursor: pointer;
	transition: background 0.15s ease, border-color 0.15s ease;
	border: 1px solid transparent;
}

.btn-secondary {
	background: var(--nt-border);
	border-color: var(--nt-border);
	color: var(--nt-fg);
}

.btn-secondary:hover {
	background: var(--nt-text-secondary);
	border-color: var(--nt-text-secondary);
}
</style>
