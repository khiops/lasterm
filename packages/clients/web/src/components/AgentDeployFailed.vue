<template>
	<Teleport to="body">
		<div
			v-if="error"
			class="adf-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="adf-title"
		>
			<div class="adf-card">
				<div class="adf-header">
					<span class="adf-icon" aria-hidden="true">
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M12 2L4 6V12C4 16.418 7.582 20.582 12 22C16.418 20.582 20 16.418 20 12V6L12 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>
							<path d="M12 8V12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
							<circle cx="12" cy="15.5" r="0.75" fill="currentColor" stroke="currentColor" stroke-width="1"/>
						</svg>
					</span>
					<h3 id="adf-title" class="adf-title">Agent binary not available</h3>
				</div>

				<p class="adf-body">
					The agent binary required to connect to <strong>{{ hostname }}</strong> was not found in the local cache.
				</p>

				<div class="adf-info-box">
					<table class="adf-detail-table">
						<tbody>
							<tr>
								<td class="adf-detail-label">Expected file</td>
								<td><code class="adf-code">{{ expectedBinary }}</code></td>
							</tr>
							<tr>
								<td class="adf-detail-label">Cache directory</td>
								<td><code class="adf-code">{{ cacheDir }}</code></td>
							</tr>
						</tbody>
					</table>
				</div>

				<div class="adf-info-box">
					<p class="adf-info-heading">To resolve this:</p>
					<ol class="adf-instructions">
						<li>
							Download the matching agent binary from the
							<a
								href="https://github.com/khiops/lasterm/releases/latest"
								target="_blank"
								rel="noopener noreferrer"
								class="adf-link"
							>releases page</a>
						</li>
						<li>Rename it to <code class="adf-code">{{ expectedBinary }}</code></li>
						<li>Save it to the cache directory shown above</li>
						<li>Click "Try Again"</li>
					</ol>
				</div>

				<div class="adf-actions">
					<button class="adf-btn adf-close" @click="handleClose">Close</button>
					<button class="adf-btn adf-retry" @click="handleRetry" :disabled="retrying">
						{{ retrying ? 'Retrying…' : 'Try Again' }}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAgentVerifyStore } from '../stores/agent-verify.js';
import { useChannelsStore } from '../stores/channels.js';

const store = useAgentVerifyStore();
const channelsStore = useChannelsStore();

const error = computed(() => store.deployError);
const retrying = ref(false);

/**
 * Parse the cache directory and expected binary name from the deployer error message.
 * Message format: "Agent binary not found in cache: /path/to/cache/lasterm-agent-<os>-<arch>[.exe]. ..."
 */
const parsedDetails = computed(() => {
	const msg = error.value?.message ?? '';
	const match = msg.match(/Agent binary not found in cache:\s*(.+?)(?:\s*\.|$)/);
	if (!match) {
		return { expectedBinary: 'lasterm-agent-<os>-<arch>', cacheDir: '(unknown)' };
	}
	const fullPath = (match[1] ?? '').trim();
	const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
	const binaryName = lastSlash >= 0 ? fullPath.slice(lastSlash + 1) : fullPath;
	const dir = lastSlash >= 0 ? fullPath.slice(0, lastSlash) : '.';
	return { expectedBinary: binaryName, cacheDir: dir };
});

const expectedBinary = computed(() => parsedDetails.value.expectedBinary);
const cacheDir = computed(() => parsedDetails.value.cacheDir);

/**
 * Use hostId as display name — the full sshHost label is not available in the error payload.
 */
const hostname = computed(() => error.value?.hostId ?? 'remote host');

function handleClose(): void {
	store.clearDeployError();
}

async function handleRetry(): Promise<void> {
	const hostId = error.value?.hostId;
	store.clearDeployError();
	if (!hostId) return;

	retrying.value = true;
	try {
		await channelsStore.spawnChannel(hostId);
	} catch {
		// spawn error will be surfaced via WS ERROR again if still unavailable
	} finally {
		retrying.value = false;
	}
}
</script>

<style scoped>
.adf-backdrop {
	position: fixed;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(0, 0, 0, 0.55);
	z-index: 10200;
}

.adf-card {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 10px;
	padding: 24px 28px;
	width: 480px;
	max-width: calc(100vw - 48px);
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
	gap: 14px;
	animation: adf-slide-in 0.2s ease-out;
}

@keyframes adf-slide-in {
	from {
		transform: translateY(-12px);
		opacity: 0;
	}
	to {
		transform: translateY(0);
		opacity: 1;
	}
}

.adf-header {
	display: flex;
	align-items: center;
	gap: 10px;
}

.adf-icon {
	display: flex;
	align-items: center;
	flex-shrink: 0;
	color: #e0a030;
}

.adf-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: #e0a030;
}

.adf-body {
	margin: 0;
	font-size: 12px;
	color: var(--nt-text-muted);
	line-height: 1.5;
}

.adf-info-box {
	background: var(--nt-tab-bar);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	padding: 12px 14px;
}

.adf-info-heading {
	margin: 0 0 8px;
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-muted);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.adf-instructions {
	margin: 0;
	padding-left: 18px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.adf-instructions li {
	font-size: 12px;
	color: var(--nt-fg);
	line-height: 1.5;
}

.adf-code {
	font-family: monospace;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 3px;
	padding: 1px 4px;
	font-size: 11px;
	color: var(--nt-fg);
	word-break: break-all;
}

.adf-detail-table {
	width: 100%;
	border-collapse: collapse;
}

.adf-detail-table td {
	font-size: 12px;
	padding: 3px 0;
	vertical-align: top;
}

.adf-detail-label {
	color: var(--nt-text-muted);
	white-space: nowrap;
	padding-right: 12px;
	width: 1%;
}

.adf-link {
	color: var(--nt-accent);
	text-decoration: none;
}

.adf-link:hover {
	text-decoration: underline;
}

.adf-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 4px;
}

.adf-btn {
	height: 32px;
	padding: 0 14px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	border: 1px solid transparent;
	transition: background 0.12s, opacity 0.12s;
}

.adf-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.adf-close {
	background: var(--nt-border);
	border-color: var(--nt-tab-hover);
	color: var(--nt-text-muted);
}

.adf-close:hover:not(:disabled) {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.adf-retry {
	background: var(--nt-accent);
	color: #fff;
}

.adf-retry:hover:not(:disabled) {
	opacity: 0.85;
}
</style>
