<template>
	<div class="visual-profile-settings">
		<!-- Preset selector -->
		<div class="field">
			<label class="field-label">Visual Preset</label>
			<div class="preset-group">
				<label v-for="p in presetOptions" :key="p" class="preset-radio">
					<input
						type="radio"
						:value="p"
						:checked="modelValue.preset === p"
						name="visual-preset"
						@change="onPresetChange(p)"
					/>
					<span class="preset-label">{{ presetLabel(p) }}</span>
				</label>
			</div>
		</div>

		<!-- Banner config -->
		<fieldset class="settings-group">
			<legend>Banner</legend>
			<div class="field">
				<label class="field-label">
					<input
						type="checkbox"
						:checked="modelValue.banner.enabled"
						@change="onBannerField('enabled', ($event.target as HTMLInputElement).checked)"
					/>
					Show environment banner
				</label>
			</div>
			<template v-if="modelValue.banner.enabled">
				<div class="field">
					<label class="field-label">Text</label>
					<input
						type="text"
						class="field-input"
						:value="modelValue.banner.text"
						placeholder="PRODUCTION - {host}"
						maxlength="120"
						@input="onBannerField('text', ($event.target as HTMLInputElement).value)"
					/>
					<span class="field-hint">Tokens: {host}, {ip}, {user}, {group}</span>
					<span v-if="bannerTextError" class="field-error">{{ bannerTextError }}</span>
				</div>
				<div class="form-row">
					<div class="field flex-1">
						<label class="field-label">Background</label>
						<input
							type="color"
							:value="modelValue.banner.bgColor"
							@input="onBannerField('bgColor', ($event.target as HTMLInputElement).value)"
						/>
					</div>
					<div class="field flex-1">
						<label class="field-label">Text Color</label>
						<input
							type="color"
							:value="modelValue.banner.textColor"
							@input="onBannerField('textColor', ($event.target as HTMLInputElement).value)"
						/>
					</div>
				</div>
			</template>
		</fieldset>

		<!-- Border config -->
		<fieldset class="settings-group">
			<legend>Border</legend>
			<div class="field">
				<label class="field-label">Style</label>
				<div class="preset-group">
					<label v-for="s in borderOptions" :key="s" class="preset-radio">
						<input
							type="radio"
							:value="s"
							:checked="modelValue.border.style === s"
							name="border-style"
							@change="onBorderField('style', s)"
						/>
						<span class="preset-label">{{ s === 'none' ? 'None' : s === 'subtle' ? 'Subtle (2px left)' : 'Strong (3px L/R/B)' }}</span>
					</label>
				</div>
			</div>
			<div v-if="modelValue.border.style !== 'none'" class="field">
				<label class="field-label">Color (empty = use host color)</label>
				<input
					type="color"
					:value="modelValue.border.color || '#e06c75'"
					@input="onBorderField('color', ($event.target as HTMLInputElement).value)"
				/>
			</div>
		</fieldset>

		<!-- Tint config -->
		<fieldset class="settings-group">
			<legend>Background Tint</legend>
			<div class="field">
				<label class="field-label">
					<input
						type="checkbox"
						:checked="modelValue.tint.enabled"
						@change="onTintField('enabled', ($event.target as HTMLInputElement).checked)"
					/>
					Enable background tint
				</label>
			</div>
			<template v-if="modelValue.tint.enabled">
				<div class="field">
					<label class="field-label">Tint Color</label>
					<input
						type="color"
						:value="modelValue.tint.color"
						@input="onTintField('color', ($event.target as HTMLInputElement).value)"
					/>
				</div>
				<div class="field">
					<label class="field-label">Opacity: {{ modelValue.tint.opacity }}%</label>
					<input
						type="range"
						min="0"
						max="15"
						step="1"
						:value="modelValue.tint.opacity"
						@input="onTintField('opacity', Number(($event.target as HTMLInputElement).value))"
					/>
					<span v-if="opacityWarning" class="field-error">{{ opacityWarning }}</span>
				</div>
				<TintPreview :tint-color="modelValue.tint.color" :opacity="modelValue.tint.opacity" />
			</template>
		</fieldset>
	</div>
</template>

<script setup lang="ts">
import type { BorderStyle, VisualPreset, VisualProfile } from "@lasterm/shared";
import { computed } from "vue";
import { resolvePreset } from "../utils/visual-presets.js";
import TintPreview from "./TintPreview.vue";

const props = defineProps<{
	modelValue: VisualProfile;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: VisualProfile];
}>();

const presetOptions: VisualPreset[] = ["none", "caution", "danger", "custom"];
const borderOptions: BorderStyle[] = ["none", "subtle", "strong"];

function presetLabel(p: VisualPreset): string {
	return p.charAt(0).toUpperCase() + p.slice(1);
}

const bannerTextError = computed(() => {
	if (props.modelValue.banner.enabled && !props.modelValue.banner.text.trim()) {
		return "Banner text is required when enabled";
	}
	return null;
});

const opacityWarning = computed(() => {
	if (props.modelValue.tint.opacity > 15) {
		return "Maximum opacity is 15%";
	}
	return null;
});

function onPresetChange(preset: VisualPreset): void {
	const resolved = resolvePreset(preset);
	emit("update:modelValue", resolved);
}

function update(partial: Partial<VisualProfile>): void {
	const next: VisualProfile = { ...props.modelValue, ...partial, preset: "custom" };
	emit("update:modelValue", next);
}

function onBannerField(field: string, value: unknown): void {
	update({ banner: { ...props.modelValue.banner, [field]: value } });
}

function onBorderField(field: string, value: unknown): void {
	update({ border: { ...props.modelValue.border, [field]: value } });
}

function onTintField(field: string, value: unknown): void {
	const tint = { ...props.modelValue.tint, [field]: value };
	// Clamp opacity
	if (typeof tint.opacity === "number" && tint.opacity > 15) {
		tint.opacity = 15;
	}
	update({ tint });
}
</script>

<style scoped>
.visual-profile-settings {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.settings-group {
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	padding: 8px 12px;
	margin: 0;
}

.settings-group legend {
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	padding: 0 4px;
}

.preset-group {
	display: flex;
	gap: 12px;
	flex-wrap: wrap;
}

.preset-radio {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 12px;
	color: var(--nt-fg);
	cursor: pointer;
}

.preset-label {
	font-size: 12px;
}

.field {
	margin-bottom: 8px;
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

.field-label input[type="checkbox"] {
	margin-right: 4px;
}

.field-input {
	width: 100%;
	padding: 6px 8px;
	font-size: 12px;
	font-family: inherit;
	background: var(--nt-tab-bar);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	outline: none;
}

.field-input:focus {
	border-color: var(--nt-accent);
}

.field-hint {
	display: block;
	font-size: 10px;
	color: var(--nt-text-muted);
	margin-top: 2px;
}

.field-error {
	display: block;
	font-size: 11px;
	color: var(--nt-red, #e06c75);
	margin-top: 3px;
}

.form-row {
	display: flex;
	gap: 12px;
}

.flex-1 {
	flex: 1;
}

input[type="color"] {
	width: 40px;
	height: 28px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	padding: 2px;
	cursor: pointer;
	background: var(--nt-tab-bar);
}

input[type="range"] {
	width: 100%;
}
</style>
