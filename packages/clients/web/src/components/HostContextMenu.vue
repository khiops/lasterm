<template>
	<Teleport to="body">
		<div
			v-if="visible"
			ref="menuEl"
			class="ctx-menu"
			:style="{ left: `${x}px`, top: `${y}px` }"
			@click.stop
		>
			<template v-if="host?.type === 'local'">
				<button class="ctx-item" @click="onEdit">
					Edit Name / Icon
				</button>
			</template>

			<template v-else-if="host">
				<!-- What can be done with its connection, as it stands (#648). -->
				<button
					v-if="canConnect"
					class="ctx-item"
					data-action="connect"
					@click="onConnect"
				>
					Connect
				</button>
				<button
					v-if="canReconnect"
					class="ctx-item"
					data-action="reconnect"
					@click="onReconnect"
				>
					Reconnect
				</button>
				<button
					v-if="status === 'live'"
					class="ctx-item"
					data-action="disconnect"
					@click="onDisconnect"
				>
					Disconnect
				</button>

				<div class="ctx-sep" />

				<button class="ctx-item" @click="onEdit">Edit Host</button>
				<button class="ctx-item" @click="onDuplicate">
					Duplicate
				</button>

				<div class="ctx-sep" />

				<div
					class="ctx-item has-submenu"
					@mouseenter="showGroupSubmenu = true"
					@mouseleave="showGroupSubmenu = false"
				>
					Move to Group
					<span class="submenu-arrow">&#x25B8;</span>
					<div v-if="showGroupSubmenu" class="ctx-submenu">
						<button
							class="ctx-item"
							:class="{ active: !host.hostGroupId }"
							@click="moveToGroup(null)"
						>
							Ungrouped
						</button>
						<button
							v-for="g in groups"
							:key="g.id"
							class="ctx-item"
							:class="{ active: host.hostGroupId === g.id }"
							@click="moveToGroup(g.id)"
						>
							{{ g.name }}
						</button>
						<div class="ctx-sep" />
						<button class="ctx-item" @click="onNewGroup">
							+ New group
						</button>
					</div>
				</div>

				<div class="ctx-sep" />

				<button class="ctx-item ctx-item--danger" @click="onDelete">
					Delete
				</button>
			</template>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useHostsStore } from "../stores/hosts.js";

const props = defineProps<{
	visible: boolean;
	hostId: string;
	x: number;
	y: number;
}>();

const emit = defineEmits<{
	(e: "close"): void;
	(e: "edit", hostId: string): void;
	(e: "delete", hostId: string): void;
	(e: "connect", hostId: string): void;
	(e: "reconnect", hostId: string): void;
	(e: "disconnect", hostId: string): void;
	(e: "new-group", hostId: string): void;
}>();

const hostsStore = useHostsStore();
const menuEl = ref<HTMLElement | null>(null);
const showGroupSubmenu = ref(false);

const host = computed(() =>
	hostsStore.hosts.find((h) => h.id === props.hostId) ?? null,
);

const status = computed(() => hostsStore.getHostStatus(props.hostId));

/** Nothing connected: never, or its user disconnected it. */
const canConnect = computed(() => status.value === "offline" || status.value === "disconnected");

/** A connection up, being reached, or lost: close it and open it again. */
const canReconnect = computed(
	() => status.value === "live" || status.value === "reconnecting" || status.value === "error",
);

const groups = computed(() => hostsStore.getHostGroups());

// ── Click-outside close ──────────────────────────────────────────────────

function onClickOutside(event: MouseEvent): void {
	if (menuEl.value && !menuEl.value.contains(event.target as Node)) {
		emit("close");
	}
}

onMounted(() => {
	document.addEventListener("mousedown", onClickOutside, true);
});

onUnmounted(() => {
	document.removeEventListener("mousedown", onClickOutside, true);
});

// ── Action handlers ──────────────────────────────────────────────────────

function onEdit(): void {
	if (host.value) {
		emit("edit", host.value.id);
	}
	emit("close");
}

function onDelete(): void {
	if (host.value) {
		emit("delete", host.value.id);
	}
	emit("close");
}

function onConnect(): void {
	if (host.value) {
		emit("connect", host.value.id);
	}
	emit("close");
}

function onReconnect(): void {
	if (host.value) {
		emit("reconnect", host.value.id);
	}
	emit("close");
}

function onDisconnect(): void {
	if (host.value) {
		emit("disconnect", host.value.id);
	}
	emit("close");
}

async function onDuplicate(): Promise<void> {
	if (host.value) {
		await hostsStore.duplicateHost(host.value.id);
		await hostsStore.fetchHosts();
	}
	emit("close");
}

async function moveToGroup(groupId: string | null): Promise<void> {
	if (!host.value) return;
	await hostsStore.moveHostToGroup(host.value.id, groupId);
	showGroupSubmenu.value = false;
	emit("close");
}

function onNewGroup(): void {
	if (host.value) {
		emit("new-group", host.value.id);
	}
	emit("close");
}
</script>

<style scoped>
.ctx-menu {
	position: fixed;
	z-index: 9999;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	padding: 4px 0;
	min-width: 200px;
	box-shadow: var(--nt-shadow);
}

.ctx-item {
	display: flex;
	align-items: center;
	width: 100%;
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	color: var(--nt-fg);
	background: transparent;
	border: none;
	cursor: pointer;
	text-align: left;
	transition: background 0.08s;
	position: relative;
}

.ctx-item:hover:not(:disabled) {
	background: var(--nt-tab-hover);
}

.ctx-item:disabled {
	opacity: 0.4;
	pointer-events: none;
}

.ctx-item--danger {
	color: var(--nt-red, #e06c75);
}

.ctx-item--danger:hover {
	background: rgba(224, 108, 117, 0.12);
}

.ctx-item.active {
	color: var(--nt-accent);
}

.ctx-sep {
	border-top: 1px solid var(--nt-border);
	margin: 4px 0;
}

.has-submenu {
	cursor: default;
}

.submenu-arrow {
	margin-left: auto;
	font-size: 10px;
	opacity: 0.6;
}

.ctx-submenu {
	position: absolute;
	left: 100%;
	top: -4px;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	padding: 4px 0;
	min-width: 160px;
	box-shadow: var(--nt-shadow);
}
</style>
