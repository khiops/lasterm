<template>
	<Teleport to="body">
		<div class="player-overlay" @click.self="emit('close')">
			<div
				ref="root"
				class="player"
				role="dialog"
				aria-modal="true"
				:aria-label="`Replay of ${title}`"
				@keydown="onKeydown"
			>
				<header class="player__head">
					<h3 class="player__title">{{ title }}</h3>
					<button class="player__close" aria-label="Close the player" @click="emit('close')">×</button>
				</header>

				<p v-if="error" class="player__error" role="alert">{{ error }}</p>
				<div v-else ref="stage" class="player__stage">
					<div ref="screen" class="player__screen" :style="{ transform: `scale(${scale})` }" />
				</div>

				<div v-if="!error" class="player__controls">
					<button
						class="player__btn"
						:aria-label="playing ? 'Pause' : 'Play'"
						@click="togglePlay"
					>
						<svg v-if="playing" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
						<svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z" /></svg>
					</button>
					<div class="player__track">
						<input
							class="player__seek"
							type="range"
							min="0"
							:max="total"
							step="0.01"
							:value="time"
							aria-label="Position"
							@input="onSeek"
						/>
						<span
							v-for="(m, i) in markers"
							:key="i"
							class="player__marker"
							:style="{ left: `${total > 0 ? (m.time / total) * 100 : 0}%` }"
							:title="m.label || 'Marker'"
						/>
					</div>
					<span class="player__time">{{ clock(time) }} / {{ clock(total) }}</span>
					<label class="player__field">
						<span class="visually-hidden">Speed</span>
						<select :value="speed" aria-label="Speed" @change="onSpeed">
							<option v-for="s in SPEEDS" :key="s" :value="s">{{ s }}×</option>
						</select>
					</label>
					<label class="player__field">
						<input type="checkbox" :checked="skipIdle" @change="onSkipIdle" />
						Skip idle
					</label>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { useModalFocus } from "../composables/useModalFocus.js";
import { useConfigStore } from "../stores/config.js";
import { useThemeStore } from "../stores/theme.js";
import { NOT_A_CAST, type ParsedCast, parseCastChunks } from "../utils/cast-parse.js";
import { CastPlayback } from "../utils/cast-playback.js";

const props = defineProps<{
	/** The cast's text, chunk by chunk: the hub's export parts, or a file's stream. Never one string. */
	chunks: () => AsyncIterable<string>;
	title: string;
}>();

const emit = defineEmits<{ close: [] }>();

const SPEEDS = [0.5, 1, 2, 4, 8] as const;

const root = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const screen = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);
const playing = ref(false);
const time = ref(0);
const total = ref(0);
const speed = ref(1);
const skipIdle = ref(true);
const scale = ref(1);
const markers = ref<Array<{ time: number; label: string }>>([]);
const playback = shallowRef<CastPlayback | null>(null);
let current: Terminal | null = null;
let observer: ResizeObserver | null = null;
/** Set when the player closes: a load still under way stops there. */
let closed = false;
let frame: number | null = null;

/** The clock and the bar follow the time played, between events too. */
function follow(): void {
	const p = playback.value;
	if (p?.isPlaying) time.value = p.currentTime;
	frame = requestAnimationFrame(follow);
}

const opened = ref(false);
const { onKeydown: modalKeydown } = useModalFocus({
	open: () => opened.value,
	root,
	close: () => emit("close"),
});

/** Space plays or pauses, except on a control, which keeps its own Space (a button, the check box, the list). */
function ownsSpace(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && target.closest("button, input, select, textarea, a[href]") !== null;
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === " " && !ownsSpace(event.target)) {
		event.preventDefault();
		togglePlay();
		return;
	}
	modalKeydown(event);
}

/** Fit the terminal's drawn size into the stage, never larger than it is. */
function fit(): void {
	const el = current?.element;
	const box = stage.value;
	if (!el || !box) return;
	const w = el.offsetWidth;
	const h = el.offsetHeight;
	if (w === 0 || h === 0) return;
	scale.value = Math.min(1, box.clientWidth / w, box.clientHeight / h);
}

function newTerminal(cols: number, rows: number): Terminal {
	const profile = useConfigStore().profile;
	const colors = useThemeStore().activeTheme?.colors;
	const term = new Terminal({
		cols,
		rows,
		// A replay: nothing typed goes anywhere, and replies to replayed queries are not sent.
		disableStdin: true,
		cursorBlink: false,
		allowProposedApi: true,
		...(profile.fontSize !== undefined && { fontSize: profile.fontSize }),
		...(profile.fontFamily !== undefined && { fontFamily: profile.fontFamily }),
		scrollback: profile.scrollback ?? 5000,
		theme: colors ? useThemeStore().toXtermTheme(colors) : {},
	});
	// The same character widths as a live terminal (useTerminal.ts).
	term.loadAddon(new Unicode11Addon());
	term.unicode.activeVersion = "11";
	if (screen.value) {
		screen.value.replaceChildren();
		term.open(screen.value);
	}
	current = term;
	void nextTick(fit);
	return term;
}

function load(cast: ParsedCast): void {
	const p = new CastPlayback(cast, {
		createTerminal: (cols, rows) => {
			const term = newTerminal(cols, rows);
			return {
				write: (data, done) => term.write(data, done),
				resize: (c, r) => term.resize(c, r),
				dispose: () => term.dispose(),
			};
		},
		onTerminal: () => void nextTick(fit),
		onTime: (s) => {
			time.value = s;
		},
		onEnd: () => {
			playing.value = false;
		},
	});
	playback.value = p;
	total.value = p.totalTime;
	markers.value = p.markers();
	p.play();
	// A cast with no event has ended already.
	playing.value = p.isPlaying;
	frame = requestAnimationFrame(follow);
}

function togglePlay(): void {
	const p = playback.value;
	if (!p) return;
	if (p.isPlaying) p.pause();
	else p.play();
	playing.value = p.isPlaying;
	time.value = p.currentTime;
}

function onSeek(event: Event): void {
	const target = Number((event.target as HTMLInputElement).value);
	time.value = target;
	void playback.value?.seek(target);
}

function onSpeed(event: Event): void {
	speed.value = Number((event.target as HTMLSelectElement).value);
	playback.value?.setSpeed(speed.value);
}

function onSkipIdle(event: Event): void {
	skipIdle.value = (event.target as HTMLInputElement).checked;
	const p = playback.value;
	if (!p) return;
	p.setSkipIdle(skipIdle.value);
	total.value = p.totalTime;
	markers.value = p.markers();
	time.value = p.currentTime;
}

function clock(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rest = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** Where the keyboard was before the player opened: it goes back there when the player closes. */
let returnTo: Element | null = null;

onMounted(async () => {
	returnTo = document.activeElement;
	opened.value = true;
	let parsed: ParsedCast | { error: string } | null;
	try {
		parsed = await parseCastChunks(props.chunks(), () => closed);
	} catch {
		if (!closed) error.value = "The recording could not be read.";
		return;
	}
	if (parsed === null || closed) return;
	if ("error" in parsed) {
		error.value = parsed.error ?? NOT_A_CAST;
		return;
	}
	await nextTick();
	if (closed) return;
	load(parsed);
	if (stage.value && typeof ResizeObserver !== "undefined") {
		observer = new ResizeObserver(fit);
		observer.observe(stage.value);
	}
});

onUnmounted(() => {
	closed = true;
	if (frame !== null) cancelAnimationFrame(frame);
	opened.value = false;
	observer?.disconnect();
	playback.value?.dispose();
	if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
});
</script>

<style scoped>
.player-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.player {
	display: flex;
	flex-direction: column;
	gap: 10px;
	width: min(1100px, calc(100vw - 32px));
	height: min(760px, calc(100vh - 32px));
	padding: 14px 16px 12px;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	box-shadow: var(--nt-shadow);
}

.player__head {
	display: flex;
	align-items: center;
	gap: 8px;
}

.player__title {
	flex: 1;
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.player__close {
	width: 26px;
	height: 26px;
	border: none;
	border-radius: 4px;
	background: transparent;
	color: var(--nt-text-secondary);
	font-size: 18px;
	cursor: pointer;
}

.player__close:hover,
.player__btn:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.player__stage {
	flex: 1;
	min-height: 0;
	overflow: hidden;
	border-radius: 4px;
	background: var(--nt-bg);
}

.player__screen {
	transform-origin: top left;
	width: max-content;
}

.player__error {
	flex: 1;
	margin: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 13px;
	color: var(--nt-text-secondary);
}

.player__controls {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.player__btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border: none;
	border-radius: 4px;
	background: transparent;
	color: var(--nt-fg);
	cursor: pointer;
}

.player__btn svg {
	width: 16px;
	height: 16px;
	fill: currentColor;
}

.player__track {
	position: relative;
	flex: 1;
	display: flex;
	align-items: center;
}

.player__seek {
	width: 100%;
	accent-color: var(--nt-accent, var(--nt-blue, #3b82f6));
}

.player__marker {
	position: absolute;
	top: -4px;
	width: 2px;
	height: 8px;
	margin-left: -1px;
	border-radius: 1px;
	background: var(--nt-yellow, #e5c07b);
	pointer-events: auto;
}

.player__time {
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.player__field {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	cursor: pointer;
}

.player__field select {
	font: inherit;
	color: var(--nt-fg);
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	padding: 2px 4px;
}

.player button:focus-visible,
.player select:focus-visible,
.player input:focus-visible {
	outline: 2px solid var(--nt-accent, var(--nt-blue, #3b82f6));
	outline-offset: 2px;
}

.visually-hidden {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
	white-space: nowrap;
}
</style>
