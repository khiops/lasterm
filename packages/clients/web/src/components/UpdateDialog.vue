<template>
	<Teleport to="body">
		<div v-if="visible" class="update-overlay">
			<div
				ref="dialogEl"
				class="update-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="update-dialog-title"
				aria-describedby="update-dialog-body"
				data-update-dialog
				@keydown="onKeydown"
			>
				<h3 id="update-dialog-title" class="update-title">{{ title }}</h3>
				<div id="update-dialog-body" class="update-body">
					<p>You are running {{ runningVersion }}.</p>
					<p v-if="fallbackLine" class="update-fallback">{{ fallbackLine }}</p>
					<p>Update now opens the Microsoft Store, which installs the update.</p>
					<p class="update-sessions">{{ SESSIONS_TEXT }}</p>
					<p v-if="offer?.mandatory" class="update-mandatory">
						This update is marked as required. It may fix a security problem.
					</p>
				</div>
				<p v-if="error" class="update-error" role="alert">{{ error }}</p>
				<div class="update-actions">
					<button class="btn btn-primary" type="button" :disabled="busy" @click="onUpdateNow">
						Update now
					</button>
					<button class="btn btn-secondary" type="button" :disabled="busy" @click="onWhatsNew">
						See what's new
					</button>
					<button
						v-if="state?.mode !== 'auto'"
						class="btn btn-secondary"
						type="button"
						:disabled="busy"
						@click="onAlwaysUpdate"
					>
						Always update
					</button>
					<button ref="laterEl" class="btn btn-secondary update-later" type="button" @click="onLater">
						Later
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useModalFocus } from "../composables/useModalFocus.js";
import { useDesktopUpdatesStore } from "../stores/desktopUpdates.js";
import { useToastStore } from "../stores/toast.js";
import { commandError, type UpdateNotice, updateCommands } from "../utils/desktop-updates.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";

/**
 * The desktop's update dialog and its notices (STORE-UPDATE-NOTICE, #1214).
 *
 * It shows when the desktop wants it, or when Settings' Update now… opened it, and only while
 * no other modal dialog is there (Settings excepted when it opened it) and the window is shown:
 * a dialog that comes later, an SSH prompt or the close question, hides it until it has gone.
 */

const SESSIONS_TEXT =
	"Installing the update may close Lasterm, or the Microsoft Store may ask you to close it. " +
	"Save your work first: terminals on this computer can end, whoever is viewing them, and file " +
	"transfers in progress stop. Terminals kept by a Lasterm agent on another host usually keep " +
	"running (a host that ends a user's processes at logout may end them): select the host after " +
	"the update to reattach them. Other SSH terminals end.";

const updates = useDesktopUpdatesStore();
const toasts = useToastStore();

const state = computed(() => updates.state);
const offer = computed(() => (state.value?.eligible ? state.value.offer : undefined));

const title = computed(() =>
	offer.value?.version
		? `Lasterm ${offer.value.version} is available`
		: "A newer version of Lasterm is available",
);

const runningVersion = computed(() => {
	const parts = (state.value?.runningVersion ?? "").split(".");
	return parts.slice(0, 3).join(".");
});

const fallbackLine = computed(() => {
	if (state.value?.mode !== "auto" || !offer.value) return null;
	if (offer.value.signal === "false") {
		return "The Microsoft Store may not install this update by itself: its automatic app updates are off, or the network is metered.";
	}
	if (offer.value.signal === "error") {
		return "Lasterm could not tell whether the Microsoft Store will install this update by itself.";
	}
	return null;
});

// ── When it shows ──

const pageShown = ref(typeof document === "undefined" || document.visibilityState === "visible");
/**
 * The desktop window is visible and not minimized, which the page's visibility does not always
 * say. In the desktop app it counts as not shown until the window has been read.
 */
const windowShown = ref(!isTauriRuntime());
const shown = computed(() => pageShown.value && windowShown.value);
const otherDialog = ref(false);
const dialogEl = ref<HTMLElement | null>(null);
const laterEl = ref<HTMLElement | null>(null);

let refreshWindow: () => Promise<void> = async () => {};
let stopWindow: (() => void) | null = null;
let unmounted = false;

/** Follows the native window: shown, hidden to the tray, minimized, restored (D4). */
async function followWindow(): Promise<void> {
	if (!isTauriRuntime()) return;
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		const win = getCurrentWindow();
		refreshWindow = async () => {
			try {
				windowShown.value = (await win.isVisible()) && !(await win.isMinimized());
			} catch {
				windowShown.value = true;
			}
		};
		const stops = await Promise.all([
			win.onResized(() => void refreshWindow()),
			win.onFocusChanged(() => void refreshWindow()),
		]);
		stopWindow = () => {
			for (const stop of stops) stop();
		};
		if (unmounted) stopWindow();
		await refreshWindow();
	} catch {
		// No window to follow: the page's own visibility decides.
		windowShown.value = true;
	}
}

function otherDialogPresent(): boolean {
	for (const element of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
		if (element.closest("[data-update-dialog]")) continue;
		if (updates.openedFromSettings && element.classList.contains("settings-panel")) continue;
		return true;
	}
	return false;
}

let observer: MutationObserver | null = null;
const onVisibility = () => {
	pageShown.value = document.visibilityState === "visible";
	void refreshWindow();
};

onMounted(() => {
	document.addEventListener("visibilitychange", onVisibility);
	void followWindow();
});

onUnmounted(() => {
	unmounted = true;
	observer?.disconnect();
	observer = null;
	stopWindow?.();
	document.removeEventListener("visibilitychange", onVisibility);
});

const wanted = computed(
	() => offer.value !== undefined && (state.value?.wantsDialog === true || updates.openedFromSettings),
);
const visible = computed(() => wanted.value && shown.value && !otherDialog.value);

// The page's other dialogs are watched only while this one is wanted: the terminal's output
// changes the page all the time, and nothing needs to look at it otherwise.
watch(
	wanted,
	(isWanted) => {
		if (isWanted && !observer && typeof MutationObserver !== "undefined") {
			otherDialog.value = otherDialogPresent();
			observer = new MutationObserver(() => {
				otherDialog.value = otherDialogPresent();
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["aria-modal", "class"],
			});
		} else if (!isWanted && observer) {
			observer.disconnect();
			observer = null;
			otherDialog.value = false;
		}
	},
	{ immediate: true },
);

// The opened-from-Settings flag changes what counts as "another dialog".
watch(
	() => updates.openedFromSettings,
	() => {
		if (observer) otherDialog.value = otherDialogPresent();
	},
);

// Opened from Settings and hidden by another dialog: it comes back only while Settings and its
// Update now… are still there.
watch(otherDialog, (present) => {
	if (!present && updates.openedFromSettings && !document.querySelector("[data-update-opener]")) {
		updates.closeDialog();
	}
});

// ── Its buttons ──

const busy = ref(false);
const error = ref<string | null>(null);

watch(visible, (now) => {
	if (now) error.value = null;
});

async function snoozeShown(key = offer.value?.key): Promise<void> {
	if (!key) return;
	try {
		const saved = await updateCommands.snooze(key);
		if (!saved) {
			toasts.show("warning", "Lasterm could not save this choice; it holds until Lasterm restarts.");
		}
	} catch {
		// A newer offer than the one shown: nothing to snooze (D5).
	}
}

async function onUpdateNow(): Promise<void> {
	// The offer the user saw: a newer answer arriving meanwhile is not snoozed in its place (D5).
	const key = offer.value?.key;
	busy.value = true;
	error.value = null;
	try {
		await updateCommands.openStoreUpdates();
	} catch (cause) {
		error.value = commandError(cause);
		busy.value = false;
		return;
	}
	await snoozeShown(key);
	busy.value = false;
	updates.closeDialog();
}

async function onWhatsNew(): Promise<void> {
	error.value = null;
	try {
		await updateCommands.openStorePage();
	} catch (cause) {
		error.value = commandError(cause);
	}
}

async function onAlwaysUpdate(): Promise<void> {
	const key = offer.value?.key;
	if (!key) return;
	busy.value = true;
	error.value = null;
	try {
		await updateCommands.chooseAlwaysUpdate(key);
	} catch (cause) {
		error.value = commandError(cause);
		busy.value = false;
		return;
	}
	busy.value = false;
	updates.closeDialog();
	toasts.show(
		"info",
		"Lasterm will no longer ask about ordinary updates. The Microsoft Store installs them while Lasterm is closed when its automatic updates are on. You can change this in Settings › Desktop.",
		10_000,
	);
}

async function onLater(): Promise<void> {
	if (updates.openedFromSettings) {
		updates.closeDialog();
		return;
	}
	await snoozeShown();
}

const { onKeydown } = useModalFocus({
	open: () => visible.value,
	root: dialogEl,
	close: () => void onLater(),
	initial: () => laterEl.value,
	fallback: () => document.querySelector<HTMLElement>("[data-update-check]"),
	// Stepping aside for another dialog leaves it the keyboard (D4).
	restore: () => !otherDialog.value,
});

// ── Notices ──

/** Each notice id shows once, as a toast that stays until the user closes it. */
const shownNotices = new Map<number, number>();
/** Acknowledged here and not yet gone from the state: never shown again meanwhile. */
const acknowledged = new Set<number>();

function noticeToast(notice: UpdateNotice): void {
	const acknowledge = () => {
		acknowledged.add(notice.id);
		const toastId = shownNotices.get(notice.id);
		shownNotices.delete(notice.id);
		if (toastId !== undefined) toasts.dismiss(toastId);
		void updateCommands.acknowledge(notice.id);
	};
	const action =
		notice.kind === "updated"
			? {
					label: "What's new",
					// The toast stays while the Store opens, and stays if it cannot (D9).
					keepOpen: true,
					run: () => {
						updateCommands.openStorePage().then(acknowledge, (cause) => {
							toasts.show("error", commandError(cause));
						});
					},
				}
			: {
					label: "Open Settings",
					run: () => {
						acknowledge();
						updates.requestSettings();
					},
				};
	const toastId = toasts.show("info", notice.text, null, action, acknowledge);
	shownNotices.set(notice.id, toastId);
}

function showNotices(): void {
	const notices = state.value?.eligible ? state.value.notices : [];
	const ids = new Set(notices.map((notice) => notice.id));
	// A notice that left the state takes its toast with it, unacknowledged.
	for (const [noticeId, toastId] of shownNotices) {
		if (!ids.has(noticeId)) {
			shownNotices.delete(noticeId);
			toasts.dismiss(toastId);
		}
	}
	for (const noticeId of acknowledged) {
		if (!ids.has(noticeId)) acknowledged.delete(noticeId);
	}
	if (!shown.value) return;
	for (const notice of notices) {
		if (!shownNotices.has(notice.id) && !acknowledged.has(notice.id)) noticeToast(notice);
	}
}

watch([() => state.value?.notices, shown], showNotices, { immediate: true });
</script>

<style scoped>
.update-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.update-dialog {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 20px;
	min-width: 340px;
	max-width: 480px;
	box-shadow: var(--nt-shadow);
}

.update-title {
	margin: 0 0 8px;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.update-body p {
	margin: 0 0 10px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	line-height: 1.45;
}

.update-body .update-fallback,
.update-body .update-mandatory {
	color: var(--nt-fg);
}

.update-error {
	margin: 0 0 12px;
	font-size: 12px;
	color: var(--nt-danger);
}

.update-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 6px;
}

.btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition: box-shadow 0.12s;
}

.btn:hover {
	box-shadow: inset 0 0 0 1px currentColor;
}

.btn:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

.btn:disabled {
	cursor: default;
	opacity: 0.6;
}

.btn-primary {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}
</style>
