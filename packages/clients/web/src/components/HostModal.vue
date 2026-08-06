<template>
	<Teleport to="body">
		<div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
			<div class="dialog-content host-modal">
				<div class="dialog-header">
					<h3 class="dialog-title">
						{{ editHost ? "Edit Host" : "Add Host" }}
					</h3>
					<button class="dialog-close" @click="$emit('close')">
						&times;
					</button>
				</div>

				<!-- Host Preview (A4) -->
				<div v-if="form.label.trim()" class="host-preview">
					<div
						class="preview-badge"
						:style="{ background: form.color || getColorFromLabel(form.label) }"
					>
						<img
							v-if="form.iconType === 'image' && form.iconValue"
							:src="form.iconValue"
							class="preview-icon-img"
						/>
						<template v-else-if="form.iconType === 'emoji' && form.iconValue">
							{{ form.iconValue }}
						</template>
						<template v-else>
							{{ previewInitials }}
						</template>
					</div>
					<span class="preview-label">{{ form.label }}</span>
				</div>

				<div class="dialog-body">
					<!-- Source selector (only for add) -->
					<div v-if="!editHost" class="field">
						<label class="field-label">Source</label>
						<div class="source-tabs">
							<button
								:class="['source-tab', { active: source === 'manual' }]"
								@click="source = 'manual'"
							>
								Manual
							</button>
							<button
								:class="[
									'source-tab',
									{ active: source === 'ssh-config' },
								]"
								@click="onSelectSshConfig"
							>
								From SSH config
							</button>
						</div>
					</div>

					<!-- SSH config dropdown (when source = ssh-config) -->
					<div v-if="source === 'ssh-config'" class="field">
						<label class="field-label">SSH Host</label>
						<div v-if="sshConfigHasInclude" class="warning-banner">
							Include directives detected — included hosts may be
							missing
						</div>
						<select
							v-if="!loadingSshConfig"
							v-model="selectedSshConfigHost"
							class="field-select"
							@change="applySshConfigEntry(selectedSshConfigHost)"
						>
							<option value="">Select a host...</option>
							<option
								v-for="entry in serverHosts"
								:key="entry.name"
								:value="entry.name"
							>
								{{ entry.name }} ({{
									entry.hostname ?? "no hostname"
								}})
							</option>
						</select>
						<span v-else class="field-hint">
							Loading SSH config...
						</span>
						<button
							v-if="!loadingSshConfig"
							class="btn-link batch-import-link"
							@click="$emit('batch-import')"
						>
							Import multiple hosts at once...
						</button>
					</div>

					<!-- Name -->
					<div class="field">
						<label class="field-label">Name</label>
						<input
							v-model="form.label"
							type="text"
							class="field-input"
							placeholder="prod-server"
							maxlength="64"
						/>
						<span v-if="labelError" class="field-error">
							{{ labelError }}
						</span>
					</div>

					<!-- Group selector -->
					<div class="field">
						<label class="field-label">Group</label>
						<div class="group-selector">
							<select
								v-if="!showNewGroup"
								v-model="form.hostGroup"
								class="field-select"
							>
								<option value="">Ungrouped</option>
								<option
									v-for="g in groups"
									:key="g.id"
									:value="g.id"
								>
									{{ g.name }}
								</option>
							</select>
							<button
								v-if="!showNewGroup"
								class="btn-link"
								@click="showNewGroup = true"
							>
								+ New group
							</button>
							<input
								v-if="showNewGroup"
								v-model="newGroupName"
								type="text"
								class="field-input"
								placeholder="Group name"
								maxlength="32"
							/>
							<button
								v-if="showNewGroup"
								class="btn-link"
								@click="showNewGroup = false"
							>
								Cancel
							</button>
						</div>
					</div>

					<!-- Modal Tabs (B3) -->
					<div v-if="form.type === 'ssh'" class="modal-tabs">
						<div class="tab-headers" role="tablist">
							<button
								id="tab-connection"
								role="tab"
								:aria-selected="activeTab === 'connection'"
								:aria-controls="'panel-connection'"
								:class="['tab-header', { active: activeTab === 'connection' }]"
								@click="activeTab = 'connection'"
							>
								Connection
								<span v-if="connectionTabHasError" class="tab-error-dot" />
							</button>
							<button
								id="tab-terminal"
								role="tab"
								:aria-selected="activeTab === 'terminal'"
								:aria-controls="'panel-terminal'"
								:class="['tab-header', { active: activeTab === 'terminal' }]"
								@click="activeTab = 'terminal'"
							>
								Terminal
							</button>
							<button
								id="tab-appearance"
								role="tab"
								:aria-selected="activeTab === 'appearance'"
								:aria-controls="'panel-appearance'"
								:class="['tab-header', { active: activeTab === 'appearance' }]"
								@click="activeTab = 'appearance'"
							>
								Appearance
							</button>
						</div>

						<!-- Connection tab panel -->
						<div
							id="panel-connection"
							v-show="activeTab === 'connection'"
							role="tabpanel"
							aria-labelledby="tab-connection"
							:aria-hidden="activeTab !== 'connection'"
							class="tab-panel"
						>
							<!-- Quick connect (A1) — only in manual mode -->
							<div v-if="source === 'manual'" class="field">
								<label class="field-label">Quick Connect</label>
								<input
									v-model="quickConnect"
									type="text"
									class="field-input"
									placeholder="user@hostname:port"
								/>
								<span class="field-hint">Paste a connection string to auto-fill fields below</span>
							</div>

							<div class="form-row">
								<div class="field flex-2">
									<label class="field-label">Hostname</label>
									<input
										v-model="form.sshHost"
										type="text"
										class="field-input"
										placeholder="192.168.1.100"
									/>
									<span v-if="!form.sshHost && connectionTabHasError" class="field-error">Hostname is required</span>
								</div>
								<div class="field flex-1">
									<label class="field-label">Port</label>
									<input
										:value="form.sshPort ?? ''"
										type="number"
										class="field-input"
										min="1"
										max="65535"
										placeholder="22"
										@input="onPortInput($event)"
									/>
								</div>
							</div>

							<div class="field">
								<label class="field-label">Username</label>
								<input
									v-model="form.sshUser"
									type="text"
									class="field-input"
									placeholder="deploy"
								/>
							</div>

							<div class="field">
								<label class="field-label">Auth Method</label>
								<select v-model="form.sshAuth" class="field-select">
									<option value="key">SSH Key</option>
									<option value="agent">SSH Agent</option>
									<option value="password">
										Password (prompted)
									</option>
								</select>
								<p v-if="form.sshAuth === 'agent'" class="field-hint auth-note">SSH agent will be used</p>
								<p v-if="form.sshAuth === 'password'" class="field-hint auth-note">Password prompted at connect</p>
							</div>

							<div v-if="form.sshAuth === 'key'" class="field">
								<label class="field-label">Key Path</label>
								<div style="display: flex; gap: 6px;">
									<input
										v-model="form.sshKeyPath"
										type="text"
										class="field-input"
										placeholder="~/.ssh/id_ed25519"
										style="flex: 1;"
									/>
									<button class="browse-btn" type="button" @click="showKeyPicker = true">
										Browse
									</button>
								</div>
								<SshKeyPicker
									:show="showKeyPicker"
									:model-value="form.sshKeyPath"
									@update:model-value="form.sshKeyPath = $event"
									@close="showKeyPicker = false"
								/>
							</div>

							<!-- System (OS + Architecture) -->
							<div class="form-row">
								<div class="field flex-1">
									<label class="field-label">Operating System</label>
									<select v-model="form.os" class="field-select">
										<option :value="null">Auto-detect</option>
										<option value="linux">Linux</option>
										<option value="darwin">macOS</option>
										<option value="windows">Windows</option>
									</select>
								</div>
								<div class="field flex-1">
									<label class="field-label">Architecture</label>
									<select v-model="form.arch" class="field-select">
										<option :value="null">Auto-detect</option>
										<option value="x64">x64 (AMD64)</option>
										<option value="arm64">ARM64</option>
									</select>
								</div>
							</div>

						<!-- Test Connection -->
							<div class="field field-test">
								<button
									class="btn btn-test"
									:disabled="!form.sshHost || testing"
									@click="testConnectionInline"
								>
									{{ testing ? "Testing..." : "Test Connection" }}
								</button>
								<span
									v-if="testResult"
									:class="
										testResult.ok ? 'test-ok' : 'test-fail'
									"
								>
									{{
										testResult.ok
											? "Connected"
											: testResult.message
									}}
								</span>
							</div>
						</div>

						<!-- Terminal tab panel -->
						<div
							id="panel-terminal"
							v-show="activeTab === 'terminal'"
							role="tabpanel"
							aria-labelledby="tab-terminal"
							:aria-hidden="activeTab !== 'terminal'"
							class="tab-panel"
						>
							<div class="field">
								<label class="field-label">Default Shell</label>
								<input
									v-model="form.defaultShell"
									type="text"
									class="field-input"
									placeholder="/bin/bash"
								/>
							</div>
							<div class="field">
								<label class="field-label">Elevation Method</label>
								<select v-model="form.elevationMethod" class="field-select">
									<option value="">Default (global setting)</option>
									<option value="sudo">sudo</option>
									<option value="doas">doas</option>
									<option value="pkexec">pkexec</option>
									<option value="gsudo">gsudo</option>
									<option value="custom">Custom</option>
								</select>
							</div>
							<div v-if="form.elevationMethod === 'custom'" class="field">
								<label class="field-label">Custom Elevation Command</label>
								<input
									v-model="form.customCommand"
									type="text"
									class="field-input"
									placeholder="e.g., /usr/local/bin/my-elevate"
								/>
							</div>
							<div class="form-row">
								<div class="field flex-1">
									<label class="field-label">
										Keep Alive (s)
									</label>
									<input
										v-model.number="form.keepAliveSeconds"
										type="number"
										class="field-input"
										min="0"
									/>
								</div>
								<div class="field flex-1">
									<label class="field-label">
										History (days)
									</label>
									<input
										v-model.number="form.historyRetentionDays"
										type="number"
										class="field-input"
										min="1"
									/>
								</div>
							</div>
							<div class="field">
								<label class="field-label">Remote Hints</label>
								<select
									v-model="form.trustRemoteHints"
									class="field-select"
								>
									<option value="apply">Apply</option>
									<option value="ask">Ask</option>
									<option value="ignore">Ignore</option>
								</select>
							</div>
						</div>

						<!-- Appearance tab panel -->
						<div
							id="panel-appearance"
							v-show="activeTab === 'appearance'"
							role="tabpanel"
							aria-labelledby="tab-appearance"
							:aria-hidden="activeTab !== 'appearance'"
							class="tab-panel"
						>
							<!-- Host Identity -->
							<div class="field-group">
								<div class="field-group-label">Host Identity</div>
								<div v-if="form.iconType !== 'image'" class="field">
									<label class="field-label">Color</label>
									<div class="identity-color-row">
										<input
											type="color"
											class="identity-color-input"
											:value="form.color || getColorFromLabel(form.label)"
											@input="form.color = ($event.target as HTMLInputElement).value"
										/>
										<button
											v-if="form.color"
											type="button"
											class="btn btn-secondary btn-sm"
											@click="form.color = ''"
										>Reset</button>
									</div>
								</div>
								<div class="field">
									<label class="field-label">Icon type</label>
									<div class="identity-icon-type-row">
										<label class="radio-label">
											<input type="radio" v-model="form.iconType" value="auto" />
											Auto (initials)
										</label>
										<label class="radio-label">
											<input type="radio" v-model="form.iconType" value="emoji" />
											Emoji
										</label>
										<label class="radio-label">
											<input type="radio" v-model="form.iconType" value="image" />
											Image URL
										</label>
									</div>
								</div>
								<div v-if="form.iconType !== 'auto'" class="field">
								<label class="field-label" for="icon-value">
									{{ form.iconType === 'emoji' ? 'Emoji' : 'Image URL' }}
								</label>
								<div
									v-if="form.iconType === 'emoji'"
									class="emoji-input-wrap"
									@focusout="onEmojiWrapFocusOut"
								>
									<input
										id="icon-value"
										v-model="form.iconValue"
										type="text"
										class="field-input"
										placeholder="e.g. 🚀 or :rocket:"
										@blur="onEmojiBlur()"
										@focus="showEmojiPicker = true"
									/>
									<button
										type="button"
										class="emoji-toggle"
										:aria-expanded="showEmojiPicker"
										aria-label="Open emoji picker"
										@click="showEmojiPicker = !showEmojiPicker"
									>
										&#x1F600;
									</button>
									<EmojiPicker
										v-if="showEmojiPicker"
										ref="emojiPickerRef"
										:model-value="form.iconValue"
										@update:model-value="form.iconValue = $event"
										@close="showEmojiPicker = false"
									/>
								</div>
								<input
									v-else
									id="icon-value"
									v-model="form.iconValue"
									type="text"
									class="field-input"
									placeholder="https://example.com/icon.png"
								/>
								<span v-if="form.iconType === 'emoji'" class="field-hint">Type an emoji or shortcode like :rocket:</span>
							</div>
							</div>
							<VisualProfileSettings v-model="visualProfile" />
						</div>
					</div>
				</div>

				<div class="dialog-actions">
					<button class="btn btn-secondary" @click="$emit('close')">
						Cancel
					</button>
					<button
						class="btn btn-primary"
						:disabled="!canSave || saving"
						@click="onSave"
					>
						{{
							saving
								? "Saving..."
								: editHost
									? "Save"
									: "Add Host"
						}}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, type PropType } from "vue";
import type { Host, VisualProfile } from "@lasterm/shared";
import { useHostForm } from "../composables/useHostForm.js";
import { getColorFromLabel } from "../composables/useHostIcon.js";
import { useHostsStore } from "../stores/hosts.js";
import { DEFAULT_VISUAL_PROFILE } from "../utils/visual-presets.js";
import { resolveEmojiShortcode } from "../utils/emoji-shortcodes.js";
import VisualProfileSettings from "./VisualProfileSettings.vue";
import EmojiPicker from "./EmojiPicker.vue";
import SshKeyPicker from "./SshKeyPicker.vue";

const props = defineProps({
	visible: { type: Boolean, required: true },
	editHost: { type: Object as PropType<Host | null>, default: null },
});

const emit = defineEmits<{
	close: [];
	saved: [host: Host];
	"batch-import": [];
}>();

const hostsStore = useHostsStore();
const {
	form,
	source,
	sshConfigEntries,
	sshConfigHasInclude,
	selectedSshConfigHost,
	loadingSshConfig,
	testResult,
	testing,
	saving,
	labelError,
	canSave,
	previewInitials,
	newGroupName,
	showNewGroup,
	loadSshConfig,
	applySshConfigEntry,
	testConnectionInline,
	save,
	quickConnect,
} = useHostForm(props.editHost ?? undefined);

// Visual profile state — initialized from editHost.profileJson
const visualProfile = ref<VisualProfile>((() => {
	if (props.editHost?.profileJson) {
		try {
			const parsed = JSON.parse(props.editHost.profileJson);
			if (parsed?.visualProfile) {
				return { ...DEFAULT_VISUAL_PROFILE, ...parsed.visualProfile };
			}
		} catch {
			// Invalid JSON — use defaults
		}
	}
	return { ...DEFAULT_VISUAL_PROFILE };
})());

// INV-05: reset to connection tab when opening for a new host, persist for edits
const activeTab = ref<"connection" | "terminal" | "appearance">("connection");

const showEmojiPicker = ref(false);
const showKeyPicker = ref(false);
const emojiPickerRef = ref<InstanceType<typeof EmojiPicker> | null>(null);

// INV-16: real-time validation error indicator for Connection tab
const connectionTabHasError = computed(() => {
	if (form.value.type === "ssh") {
		if (!form.value.sshHost) return true;
		if (form.value.sshAuth === "key" && !form.value.sshKeyPath) return true;
	}
	return false;
});

const groups = computed(() => hostsStore.getHostGroups());
const serverHosts = computed(() =>
	sshConfigEntries.value.filter((e) => !e.isGitHost),
);

function onEmojiBlur(): void {
	form.value.iconValue = resolveEmojiShortcode(form.value.iconValue);
}

function onEmojiWrapFocusOut(e: FocusEvent): void {
	const wrap = (e.currentTarget as HTMLElement);
	const related = e.relatedTarget as Node | null;
	if (!related || !wrap.contains(related)) {
		showEmojiPicker.value = false;
	}
}

function onSelectSshConfig(): void {
	source.value = "ssh-config";
	if (sshConfigEntries.value.length === 0) void loadSshConfig();
}

function onPortInput(e: Event): void {
	const val = (e.target as HTMLInputElement).value;
	form.value.sshPort = val ? Number.parseInt(val, 10) || undefined : undefined;
}

async function onSave(): Promise<void> {
	// EFF-08/SC-10b: auto-switch to first tab containing a validation error
	if (connectionTabHasError.value) {
		activeTab.value = "connection";
		return;
	}

	// Build profile_json by merging visualProfile into any existing profile
	let existingProfile: Record<string, unknown> = {};
	if (props.editHost?.profileJson) {
		try {
			existingProfile = JSON.parse(props.editHost.profileJson);
		} catch {
			// Invalid JSON — start fresh
		}
	}
	const profileJson = JSON.stringify({
		...existingProfile,
		visualProfile: visualProfile.value,
	});

	const host = await save({ profile_json: profileJson });
	if (host) {
		emit("saved", host);
		emit("close");
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

.dialog-content.host-modal {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	min-width: 420px;
	max-width: 520px;
	width: 100%;
	box-shadow: var(--nt-shadow);
	max-height: 85vh;
	display: flex;
	flex-direction: column;
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
	overflow-y: auto;
	flex: 1;
}

.dialog-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding: 12px 20px 16px;
	border-top: 1px solid var(--nt-border);
}

.field {
	margin-bottom: 12px;
}

.field-label {
	display: block;
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-bottom: 4px;
}

.field-input,
.field-select {
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

.field-input:focus,
.field-select:focus {
	border-color: var(--nt-accent);
}

.field-error {
	display: block;
	font-size: 11px;
	color: var(--nt-red, #e06c75);
	margin-top: 3px;
}

.field-hint {
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.auth-note {
	margin-top: 4px;
	margin-bottom: 0;
	font-style: italic;
}

.field-test {
	display: flex;
	align-items: center;
	gap: 10px;
}

.form-row {
	display: flex;
	gap: 12px;
}

.flex-1 {
	flex: 1;
}

.flex-2 {
	flex: 2;
}

.source-tabs {
	display: flex;
	gap: 0;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	overflow: hidden;
}

.source-tab {
	flex: 1;
	padding: 5px 10px;
	font-size: 12px;
	font-family: inherit;
	background: var(--nt-tab-bar);
	color: var(--nt-text-secondary);
	border: none;
	cursor: pointer;
	transition:
		background 0.12s,
		color 0.12s;
}

.source-tab + .source-tab {
	border-left: 1px solid var(--nt-border);
}

.source-tab.active {
	background: var(--nt-accent);
	color: #fff;
}

.group-selector {
	display: flex;
	gap: 8px;
	align-items: center;
}

.group-selector .field-select,
.group-selector .field-input {
	flex: 1;
}

.btn-link {
	background: none;
	border: none;
	color: var(--nt-accent);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	padding: 0;
	white-space: nowrap;
}

.btn-link:hover {
	text-decoration: underline;
}

.batch-import-link {
	display: block;
	margin-top: 6px;
	font-size: 11px;
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

.btn-primary {
	background: var(--nt-accent);
	color: #fff;
}

.btn-test {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.browse-btn {
	padding: 6px 10px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	background: var(--nt-tab-hover);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	cursor: pointer;
	white-space: nowrap;
	flex-shrink: 0;
	transition: background 0.12s;
}

.browse-btn:hover {
	background: rgba(var(--nt-fg-rgb), 0.12);
}

.warning-banner {
	padding: 6px 10px;
	font-size: 11px;
	color: var(--nt-yellow, #e5c07b);
	background: rgba(229, 192, 123, 0.1);
	border: 1px solid var(--nt-yellow, #e5c07b);
	border-radius: 4px;
	margin-bottom: 8px;
}

.test-ok {
	font-size: 12px;
	color: var(--nt-green, #98c379);
}

.test-fail {
	font-size: 12px;
	color: var(--nt-red, #e06c75);
}

.modal-tabs {
	margin-top: 8px;
	border-top: 1px solid var(--nt-border);
	padding-top: 8px;
}

.tab-headers {
	display: flex;
	gap: 0;
	border-bottom: 1px solid var(--nt-border);
	margin-bottom: 12px;
}

.tab-header {
	position: relative;
	flex: 1;
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--nt-text-secondary);
	cursor: pointer;
	transition: color 0.12s, border-color 0.12s;
}

.tab-header:hover {
	color: var(--nt-fg);
}

.tab-header.active {
	color: var(--nt-accent);
	border-bottom-color: var(--nt-accent);
}

.tab-error-dot {
	display: inline-block;
	width: 6px;
	height: 6px;
	background: var(--nt-red, #e06c75);
	border-radius: 50%;
	margin-left: 4px;
	vertical-align: middle;
}

.tab-panel {
	min-height: 120px;
}

.field-group {
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	padding: 12px 14px;
	margin-bottom: 14px;
}

.field-group-label {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--nt-text-secondary);
	margin-bottom: 10px;
}

.identity-color-row {
	display: flex;
	align-items: center;
	gap: 10px;
}

.identity-color-input {
	width: 40px;
	height: 30px;
	padding: 2px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	cursor: pointer;
}

.identity-icon-type-row {
	display: flex;
	gap: 16px;
	flex-wrap: wrap;
}

.radio-label {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
	color: var(--nt-fg);
	cursor: pointer;
}

.btn-sm {
	padding: 3px 10px;
	font-size: 12px;
}

.host-preview {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 20px;
	border-bottom: 1px solid var(--nt-border);
}

.preview-badge {
	width: 32px;
	height: 32px;
	border-radius: 6px;
	background: var(--nt-accent);
	color: #fff;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 12px;
	font-weight: 600;
	flex-shrink: 0;
}

.preview-icon-img {
	width: 100%;
	height: 100%;
	border-radius: 6px;
	object-fit: cover;
}

.preview-label {
	font-size: 13px;
	font-weight: 500;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.emoji-input-wrap {
	position: relative;
	display: flex;
	align-items: center;
	gap: 6px;
}

.emoji-input-wrap .field-input {
	flex: 1;
}

.emoji-toggle {
	flex-shrink: 0;
	width: 32px;
	height: 32px;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--nt-bg-raised, #2a2a2a);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	cursor: pointer;
	font-size: 1rem;
	padding: 0;
	transition: background 0.1s;
}

.emoji-toggle:hover {
	background: var(--nt-hover, rgba(255, 255, 255, 0.1));
}
</style>
