import type { InjectionKey } from "vue";

/**
 * The id of a setting row's label, which the control in the row is named by (#637). The label
 * is the row's, the control is a slot: without it, a switch or a select says nothing of what it
 * sets to a screen reader.
 */
export const SETTING_ROW_LABEL_ID: InjectionKey<string> = Symbol("setting-row-label-id");
