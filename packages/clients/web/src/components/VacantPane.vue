<template>
	<div class="vacant-pane">
		<div class="picker">
			<div class="picker-head">
				<span>Open in this pane</span>
				<button type="button" class="picker-close" @click="emit('rearrange', vacantId)">
					Close pane
				</button>
			</div>

			<div class="picker-search">
				<svg
					class="picker-search-icon"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="11" cy="11" r="8" />
					<line x1="21" y1="21" x2="16.65" y2="16.65" />
				</svg>
				<label :for="inputId" class="visually-hidden">Search hosts and terminals</label>
				<input
					:id="inputId"
					ref="inputRef"
					v-model="picker.query.value"
					class="picker-input"
					type="text"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded="true"
					:aria-controls="listId"
					:aria-activedescendant="activeDomId"
					placeholder="Search hosts and terminals"
					autocomplete="off"
					spellcheck="false"
					@keydown="picker.onKeydown"
				/>
			</div>

			<p v-if="list.noMatch" class="picker-empty" role="status">
				No host or terminal matches "{{ picker.query.value.trim() }}".
			</p>

			<div
				:id="listId"
				class="picker-list"
				:class="{ 'picker-list--whole': list.noRemoteHost }"
				role="listbox"
				aria-label="Hosts and terminals"
			>
				<div
					v-for="section in list.sections"
					:key="section.id"
					role="group"
					:aria-labelledby="domId(`section-${section.id}`)"
				>
					<div :id="domId(`section-${section.id}`)" class="picker-section" role="presentation">
						{{ section.title }}
					</div>
					<template v-for="option in section.options" :key="option.id">
						<button
							v-if="option.kind === 'host'"
							:id="domId(option.id)"
							type="button"
							role="option"
							tabindex="-1"
							class="picker-row"
							:class="{ 'picker-row--active': option.id === activeId }"
							:aria-selected="option.id === activeId"
							@mousedown.prevent
							@click="picker.choose(option)"
						>
							<HostPickRow
								:host="option.host"
								:status="picker.status(option.host.id)"
								:address="picker.address(option.host)"
								:count="picker.count(option.host.id)"
								:action="picker.hostView(option).action"
								:note="picker.hostView(option).note"
							/>
						</button>
						<button
							v-else-if="option.kind === 'terminal'"
							:id="domId(option.id)"
							type="button"
							role="option"
							tabindex="-1"
							class="picker-row"
							:class="{ 'picker-row--active': option.id === activeId }"
							:aria-selected="option.id === activeId"
							@mousedown.prevent
							@click="picker.choose(option)"
						>
							<span class="picker-terminal-icon" aria-hidden="true">
								<svg
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<polyline points="4 17 10 11 4 5" />
									<line x1="12" y1="19" x2="20" y2="19" />
								</svg>
							</span>
							<span class="picker-terminal-names">
								<span class="picker-terminal-title">{{ option.title }}</span>
								<span class="picker-terminal-sub">{{ option.hostLabel }} · detached</span>
							</span>
							<span class="picker-row-action">Reattach</span>
						</button>
					</template>
				</div>
				<button
					v-if="list.add"
					:id="domId(list.add.id)"
					type="button"
					role="option"
					tabindex="-1"
					class="picker-row picker-row--add"
					:class="{ 'picker-row--active': list.add.id === activeId }"
					:aria-selected="list.add.id === activeId"
					@mousedown.prevent
					@click="picker.choose(list.add)"
				>
					<span class="picker-add-icon" aria-hidden="true">+</span>
					<span class="picker-add-text">{{ addHostText(list.add.name) }}</span>
				</button>
			</div>

			<div v-if="list.noRemoteHost" class="picker-invite">
				<span class="picker-invite-title">Reach another machine</span>
				<span class="picker-invite-text">
					Hosts you add over SSH appear here and in the rail, with their status.
				</span>
				<button type="button" class="picker-invite-button" @click="emit('add-host')">
					Add a host
				</button>
			</div>

			<div class="picker-keys" aria-hidden="true">
				<span><kbd>↑ ↓</kbd> move</span>
				<span><kbd>Enter</kbd> open</span>
				<span><kbd>Esc</kbd> clear</span>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, toRef, watch } from "vue";
import { DISPLAYED_CHANNELS_KEY } from "../composables/displayedChannels.js";
import { addHostText } from "../composables/hostPicker.js";
import { useHostPicker } from "../composables/useHostPicker.js";
import HostPickRow from "./HostPickRow.vue";

/**
 * An empty pane: a picker for what goes in it (#625). This tab's host and
 * its detached terminals first, then every host as the rail lists them, each
 * opening a new terminal here.
 */
const props = defineProps<{
	vacantId: string;
	/** This tab's host: the one in view. */
	hostId: string | null;
}>();

const emit = defineEmits<{
	(e: "select-channel", vacantId: string, channelId: string): void;
	(e: "new-terminal", vacantId: string, hostId: string): void;
	(e: "rearrange", vacantId: string): void;
	(e: "add-host"): void;
}>();

/** Channels a pane shows already, in any tab (provided by App.vue). */
const displayed = inject(
	DISPLAYED_CHANNELS_KEY,
	computed(() => new Set<string>()),
);

const picker = useHostPicker(
	{ hostId: toRef(props, "hostId"), displayed },
	{
		newTerminal: (hostId) => emit("new-terminal", props.vacantId, hostId),
		fill: (channelId) => emit("select-channel", props.vacantId, channelId),
		addHost: () => emit("add-host"),
	},
);

const list = picker.list;
const activeId = computed(() => picker.activeOption.value?.id ?? null);

/** Ids unique to this pane: several can be empty at once. */
function domId(part: string): string {
	return `vacant-${props.vacantId}-${part.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

const inputId = computed(() => domId("search"));
const listId = computed(() => domId("list"));
const activeDomId = computed(() => (activeId.value === null ? undefined : domId(activeId.value)));

const inputRef = ref<HTMLInputElement | null>(null);

// The search has the focus when the pane appears, so a host is a few keys away.
onMounted(async () => {
	await nextTick();
	inputRef.value?.focus({ preventScroll: true });
});

// The row lit by the keyboard stays in sight.
watch(activeDomId, async (id) => {
	if (id === undefined) return;
	await nextTick();
	document.getElementById(id)?.scrollIntoView({ block: "nearest" });
});
</script>

<style scoped>
.vacant-pane {
	flex: 1 1 auto;
	display: flex;
	justify-content: center;
	width: 100%;
	height: 100%;
	min-height: 0;
	overflow: hidden;
	background: var(--nt-tab-bar);
	container: host-picker / size;
}

.picker {
	width: 100%;
	max-width: 460px;
	box-sizing: border-box;
	padding: 40px 20px 16px;
	display: flex;
	flex-direction: column;
	gap: 12px;
	min-height: 0;
	/* A pane too short for all of it scrolls, rather than hide a row. */
	overflow-y: auto;
}

.picker-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	font-size: 12px;
	line-height: 16px;
	color: var(--nt-text-muted);
}

.picker-close {
	height: 26px;
	padding: 0 10px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: var(--nt-text-secondary);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
}

.picker-close:hover {
	background: var(--nt-hover);
	color: var(--nt-fg);
}

.picker-search {
	position: relative;
	flex-shrink: 0;
}

.picker-search-icon {
	position: absolute;
	left: 12px;
	top: 50%;
	width: 16px;
	height: 16px;
	transform: translateY(-50%);
	color: var(--nt-text-muted);
	pointer-events: none;
}

.picker-input {
	width: 100%;
	box-sizing: border-box;
	height: 38px;
	padding: 0 12px 0 36px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-fg);
	font-size: 14px;
	font-family: inherit;
	caret-color: var(--nt-accent);
}

.picker-input::placeholder {
	color: var(--nt-text-muted);
}

.picker-input:focus {
	outline: none;
	border-color: var(--nt-accent);
}

.picker-empty {
	margin: 0;
	padding: 4px 10px 0;
	font-size: 13px;
	line-height: 18px;
	color: var(--nt-text-secondary);
}

.picker-list {
	flex: 0 1 auto;
	/* At least a row, whatever else the pane holds. */
	min-height: 44px;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 2px;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-border) transparent;
}

.picker-list:empty {
	min-height: 0;
}

/* The local host alone: its rows stay whole above the invitation, and the pane scrolls. */
.picker-list--whole {
	flex-shrink: 0;
}

.picker-list > [role="group"] {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.picker-section {
	padding: 12px 10px 4px;
	font-size: 10px;
	line-height: 14px;
	font-weight: 600;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--nt-text-secondary);
	user-select: none;
}

.picker-list > [role="group"]:first-child .picker-section {
	padding-top: 4px;
}

.picker-row {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	box-sizing: border-box;
	min-height: 38px;
	padding: 6px 10px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--nt-fg);
	font-family: inherit;
	text-align: left;
	cursor: pointer;
	--host-badge-ring: var(--nt-tab-bar);
}

.picker-row:hover {
	background: var(--nt-hover);
}

.picker-row--active,
.picker-row--active:hover {
	background: rgba(var(--nt-accent-rgb), 0.14);
	box-shadow: inset 0 0 0 1px rgba(var(--nt-accent-rgb), 0.45);
}

.picker-row:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.picker-terminal-icon {
	width: 24px;
	height: 24px;
	flex: 0 0 24px;
	border-radius: 6px;
	background: var(--nt-border);
	color: var(--nt-text-secondary);
	display: flex;
	align-items: center;
	justify-content: center;
}

.picker-terminal-icon svg {
	width: 14px;
	height: 14px;
}

.picker-terminal-names {
	flex: 1 1 0;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.picker-terminal-title {
	font-size: 13px;
	color: var(--nt-fg);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.picker-terminal-sub {
	font-size: 11px;
	color: var(--nt-text-muted);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.picker-row-action {
	font-size: 12px;
	font-weight: 600;
	color: var(--nt-accent);
	white-space: nowrap;
}

.picker-add-icon {
	width: 24px;
	height: 24px;
	flex: 0 0 24px;
	box-sizing: border-box;
	border-radius: 50%;
	border: 2px dashed var(--nt-border);
	color: var(--nt-text-secondary);
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 14px;
	line-height: 1;
}

.picker-add-text {
	flex: 1 1 0;
	min-width: 0;
	font-size: 13px;
	color: var(--nt-text-secondary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.picker-invite {
	flex-shrink: 0;
	margin-top: 8px;
	padding: 16px;
	border: 1px dashed var(--nt-border);
	border-radius: 8px;
	display: flex;
	flex-direction: column;
	gap: 10px;
	font-size: 13px;
	line-height: 18px;
}

.picker-invite-title {
	color: var(--nt-fg);
	font-weight: 600;
}

.picker-invite-text {
	color: var(--nt-text-secondary);
}

.picker-invite-button {
	align-self: flex-start;
	height: 30px;
	padding: 0 12px;
	border: 0;
	border-radius: 4px;
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
	font-size: 12px;
	font-weight: 600;
	font-family: inherit;
	cursor: pointer;
}

.picker-invite-button:focus-visible,
.picker-close:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

.picker-keys {
	flex-shrink: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 14px;
	margin-top: auto;
	padding-top: 10px;
	border-top: 1px solid var(--nt-border);
	font-size: 11px;
	line-height: 16px;
	color: var(--nt-text-muted);
}

.picker-keys kbd {
	font-family: ui-monospace, monospace;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.visually-hidden {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
	white-space: nowrap;
	border: 0;
}

/* A small pane keeps its list: less air above it, and no key line. */
@container host-picker (max-height: 380px) {
	.picker {
		padding-top: 12px;
		gap: 8px;
	}

	.picker-keys {
		display: none;
	}
}
</style>
