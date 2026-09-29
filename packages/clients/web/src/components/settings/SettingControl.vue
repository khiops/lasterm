<template>
	<div class="setting-control">
		<input
			v-if="type === 'text'"
			type="text"
			class="control-text"
			:aria-labelledby="labelledBy"
			:value="modelValue"
			:disabled="disabled"
			:placeholder="placeholder"
			@input="onInput"
		/>

		<input
			v-else-if="type === 'number'"
			type="number"
			class="control-number"
			:aria-labelledby="labelledBy"
			:value="modelValue"
			:min="min"
			:max="max"
			:step="step"
			:disabled="disabled"
			@input="onInput"
		/>

		<select
			v-else-if="type === 'select'"
			class="control-select"
			:aria-labelledby="labelledBy"
			:value="modelValue"
			:disabled="disabled"
			@change="onSelectChange"
		>
			<option
				v-for="opt in options"
				:key="String(opt.value)"
				:disabled="opt.disabled"
				:value="opt.value"
			>
				{{ opt.label }}
			</option>
		</select>

		<!-- A switch (#637): the checkbox covers the track, so it has a box, takes the click, and
		     is what the keyboard reaches; Space turns it, as a checkbox's own key. -->
		<label v-else-if="type === 'toggle'" class="control-toggle">
			<input
				type="checkbox"
				role="switch"
				:checked="Boolean(modelValue)"
				:disabled="disabled"
				:aria-labelledby="labelledBy"
				@change="onToggleChange"
			/>
			<span class="toggle-track">
				<span class="toggle-thumb" />
			</span>
		</label>

		<div v-else-if="type === 'range'" class="control-range-wrapper">
			<input
				type="range"
				class="control-range"
				:aria-labelledby="labelledBy"
				:value="modelValue"
				:min="min"
				:max="max"
				:step="step"
				:disabled="disabled"
				@input="onInput"
			/>
			<span class="range-value">{{ modelValue }}</span>
		</div>

		<input
			v-else-if="type === 'color'"
			type="color"
			class="control-color"
			:aria-labelledby="labelledBy"
			:value="modelValue"
			:disabled="disabled"
			@input="onInput"
		/>

		<div v-else-if="type === 'font'" class="control-font">
			<button
				:id="fontTriggerId"
				type="button"
				class="control-font-trigger"
				:disabled="disabled"
				:aria-labelledby="labelledBy === undefined ? undefined : `${labelledBy} ${fontTriggerId}`"
				aria-haspopup="dialog"
				@click="showFontPicker = true"
			>
				{{ modelValue || 'Default' }}
			</button>
			<FontPicker
				:show="showFontPicker"
				:model-value="modelValue as string | undefined"
				@update:model-value="onFontSelect"
				@close="showFontPicker = false"
			/>
		</div>
	</div>
</template>

<script setup lang="ts">
import { inject, ref, useId } from "vue";
import FontPicker from "./FontPicker.vue";
import { SETTING_ROW_LABEL_ID } from "./settingRowLabel.js";

const props = defineProps<{
	modelValue: unknown;
	type: "text" | "number" | "select" | "toggle" | "range" | "color" | "font";
	options?: { disabled?: boolean; label: string; value: string | number }[];
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	placeholder?: string;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: unknown];
}>();

/** The label of the row the control is in, which names it (#637); none outside a row. */
const labelledBy = inject(SETTING_ROW_LABEL_ID, undefined);
const fontTriggerId = `font-trigger-${useId()}`;

function onInput(event: Event): void {
	const target = event.target as HTMLInputElement;
	const inputType = target.type;
	if (inputType === "number" || inputType === "range") {
		const parsed = Number.parseFloat(target.value);
		emit("update:modelValue", Number.isNaN(parsed) ? target.value : parsed);
	} else {
		emit("update:modelValue", target.value);
	}
}

function onSelectChange(event: Event): void {
	const target = event.target as HTMLSelectElement;
	emit("update:modelValue", target.value);
}

function onToggleChange(event: Event): void {
	const target = event.target as HTMLInputElement;
	emit("update:modelValue", target.checked);
}

const showFontPicker = ref(false);

function onFontSelect(value: string | undefined): void {
	emit("update:modelValue", value ?? "");
	showFontPicker.value = false;
}
</script>

<style scoped>
.setting-control {
	display: inline-flex;
	align-items: center;
}

.control-text,
.control-number {
	padding: 4px 8px;
	font-size: 12px;
	background: var(--nt-input-bg);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	min-width: 120px;
}

.control-number {
	min-width: 80px;
}

.control-text:focus,
.control-number:focus {
	outline: 1px solid var(--nt-accent);
}

.control-select {
	padding: 4px 8px;
	font-size: 12px;
	background: var(--nt-input-bg);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	cursor: pointer;
	min-width: 140px;
}

.control-select:focus {
	outline: 1px solid var(--nt-accent);
}

/* ── Toggle switch ─────────────────────────────────────────────────── */

.control-toggle {
	position: relative;
	cursor: pointer;
	display: inline-flex;
	align-items: center;
}

/* Invisible, but the size of the track it stands on: a real box for the click and the keyboard. */
.control-toggle input {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	margin: 0;
	opacity: 0;
	cursor: inherit;
	z-index: 1;
}

/* The keyboard's ring goes on the track, which is what shows. */
.control-toggle input:focus-visible + .toggle-track {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

.toggle-track {
	position: relative;
	display: inline-block;
	width: 36px;
	height: 20px;
	background: var(--nt-border);
	border: 1px solid var(--nt-border);
	border-radius: 10px;
	transition: background 0.2s ease;
}

.control-toggle input:checked + .toggle-track {
	background: var(--nt-accent);
}

/* The track is border-box, so its inside is 34 by 18: a 14px thumb leaves 2px all round. */
.toggle-thumb {
	position: absolute;
	top: 2px;
	left: 2px;
	width: 14px;
	height: 14px;
	background: var(--nt-fg);
	border-radius: 50%;
	transition: transform 0.2s ease;
}

.control-toggle input:checked + .toggle-track .toggle-thumb {
	transform: translateX(16px);
	background: var(--nt-accent-fg);
}

/* ── Range ─────────────────────────────────────────────────────────── */

.control-range-wrapper {
	display: flex;
	align-items: center;
	gap: 8px;
}

.control-range {
	flex: 1;
	max-width: 140px;
	accent-color: var(--nt-accent);
	cursor: pointer;
}

.range-value {
	font-size: 12px;
	color: var(--nt-text-secondary);
	min-width: 32px;
	text-align: right;
}

/* ── Color ─────────────────────────────────────────────────────────── */

.control-color {
	width: 32px;
	height: 24px;
	padding: 0;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	cursor: pointer;
	background: transparent;
}

/* ── Font picker trigger ───────────────────────────────────────────── */

.control-font {
	display: inline-flex;
	align-items: center;
}

.control-font-trigger {
	padding: 4px 10px;
	font-size: 12px;
	font-family: inherit;
	background: var(--nt-input-bg);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	cursor: pointer;
	min-width: 120px;
	text-align: left;
	transition: border-color 0.15s ease;
}

.control-font-trigger:hover:not(:disabled) {
	border-color: var(--nt-fg-muted);
}

.control-font-trigger:focus {
	outline: 1px solid var(--nt-accent);
}

/* ── Disabled state ────────────────────────────────────────────────── */

.control-text:disabled,
.control-number:disabled,
.control-select:disabled,
.control-range:disabled,
.control-color:disabled,
.control-font-trigger:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.control-toggle:has(input:disabled) {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
