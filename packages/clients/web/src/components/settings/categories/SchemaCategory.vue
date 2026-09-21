<script setup lang="ts">
import { computed } from "vue";
import SettingRow from "../SettingRow.vue";
import SettingControl from "../SettingControl.vue";
import { useSettingsStore, type Scope } from "../../../stores/settings.js";
import {
	getSchemaForCategoryScope,
	settingsSchema,
	toStoreParams,
	type SettingDefinition,
} from "../settingsSchema.js";

const props = defineProps<{
	category: string;
	scope: Scope;
	hostName?: string;
}>();

const settingsStore = useSettingsStore();

const filteredSchema = computed(() =>
	getSchemaForCategoryScope(props.category, props.scope).filter((def) => {
		if (!def.showWhen) return true;
		// Find the sibling setting that controls visibility
		const sibling = settingsSchema.find(
			(s) => s.key === def.showWhen!.key && s.section === def.showWhen!.section,
		);
		if (!sibling) return false;
		const { storeSection, storeKey } = storeFor(sibling);
		const current = settingsStore.getValue(props.scope, storeSection, storeKey);
		return current === def.showWhen.value;
	}),
);

function storeFor(def: SettingDefinition) {
	return toStoreParams(def);
}

function getValueForDef(def: SettingDefinition): unknown {
	const { storeSection, storeKey } = storeFor(def);
	return settingsStore.getValue(props.scope, storeSection, storeKey);
}

function getResolvedForDef(def: SettingDefinition): unknown {
	const { storeSection, storeKey } = storeFor(def);
	return settingsStore.getResolved(storeSection, storeKey);
}

function isOverriddenForDef(def: SettingDefinition): boolean {
	const { storeSection, storeKey } = storeFor(def);
	return settingsStore.isOverridden(props.scope, storeSection, storeKey);
}

function inheritedFromForDef(def: SettingDefinition) {
	const { storeSection, storeKey } = storeFor(def);
	return settingsStore.inheritedFrom(props.scope, storeSection, storeKey);
}

function handleUpdate(def: SettingDefinition, value: unknown) {
	const { storeSection, storeKey } = storeFor(def);
	settingsStore.updateSetting(props.scope, storeSection, storeKey, value);
}

function handleReset(def: SettingDefinition) {
	const { storeSection, storeKey } = storeFor(def);
	settingsStore.resetSetting(props.scope, storeSection, storeKey);
}

function displayValue(def: SettingDefinition): unknown {
	if (props.scope === "global" || isOverriddenForDef(def)) {
		return getValueForDef(def) ?? getResolvedForDef(def);
	}
	return getResolvedForDef(def);
}

/**
 * Normalize SettingDefinition options for SettingControl: filter out
 * boolean values since SettingControl only accepts string | number options.
 * (Boolean settings use the `toggle` type, not `select`.)
 */
function normalizedOptions(
	def: SettingDefinition,
): { label: string; value: string | number }[] | undefined {
	if (!def.options) return undefined;
	return def.options
		.filter((o): o is { label: string; value: string | number } => typeof o.value !== "boolean")
		.map((o) => ({ label: o.label, value: o.value }));
}

/**
 * Build SettingRow v-bind props — omit keys whose value is undefined to
 * satisfy exactOptionalPropertyTypes.
 */
/**
 * Whether this setting can act, and why not when it cannot.
 *
 * A setting another one has made meaningless stays on screen, disabled, saying
 * what would bring it back. Removing it would leave someone looking for it.
 */
function disabledFor(def: SettingDefinition): { disabled: boolean; reason?: string } {
	if (!def.disabledWhen) return { disabled: false };
	const { key, section, value, reason } = def.disabledWhen;
	const sibling = settingsSchema.find((s) => s.key === key && s.section === section);
	if (!sibling) return { disabled: false };
	const { storeSection, storeKey } = storeFor(sibling);
	const current = settingsStore.getValue(props.scope, storeSection, storeKey);
	return current === value ? { disabled: true, reason } : { disabled: false };
}

function rowBindings(def: SettingDefinition): Record<string, unknown> {
	const inherited = inheritedFromForDef(def);
	const blocked = disabledFor(def);
	const description = blocked.reason ?? def.description;
	return {
		...(description !== undefined && { description }),
		...(inherited !== null && { inheritedFrom: inherited }),
		...(props.hostName !== undefined && { hostName: props.hostName }),
	};
}

/**
 * Build SettingControl v-bind props — omit undefined optional keys.
 */
function controlBindings(def: SettingDefinition): Record<string, unknown> {
	const opts = normalizedOptions(def);
	return {
		...(opts !== undefined && { options: opts }),
		...(def.min !== undefined && { min: def.min }),
		...(def.max !== undefined && { max: def.max }),
		...(def.step !== undefined && { step: def.step }),
	};
}
</script>

<template>
	<div class="schema-category">
		<SettingRow
			v-for="def in filteredSchema"
			:key="`${def.section}.${def.key}`"
			:label="def.label"
			:scope="scope"
			:is-overridden="isOverriddenForDef(def)"
			v-bind="rowBindings(def)"
			@reset="handleReset(def)"
		>
			<SettingControl
				:model-value="displayValue(def)"
				:type="def.type"
				:disabled="disabledFor(def).disabled"
				v-bind="controlBindings(def)"
				@update:model-value="handleUpdate(def, $event)"
			/>
		</SettingRow>
	</div>
</template>
