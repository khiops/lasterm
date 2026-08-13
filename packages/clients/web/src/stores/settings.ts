import type { CascadeResponse, ElevationConfig } from "@lasterm/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";
import { useConfigStore } from "./config.js";
import { useToastStore } from "./toast.js";

export type Scope = "global" | "host" | "channel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Traverse an object by dot-separated path. Returns undefined for missing keys. */
export function getNestedValue(obj: unknown, path: string): unknown {
	if (obj === null || obj === undefined) return undefined;
	const parts = path.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Set a nested value by dot-separated path, creating intermediate objects as needed. */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i] as string;
		if (
			current[part] === undefined ||
			current[part] === null ||
			typeof current[part] !== "object"
		) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	const lastKey = parts[parts.length - 1] as string;
	if (value === null) {
		delete current[lastKey];
	} else {
		current[lastKey] = value;
	}
}

export const useSettingsStore = defineStore("settings", () => {
	const cascade = ref<CascadeResponse | null>(null);
	const activeScope = ref<Scope>("global");
	const activeCategory = ref<string>("appearance");
	const loading = ref(false);
	const dirty = ref<Set<string>>(new Set());
	const lastError = ref<string | null>(null);
	const currentHostId = ref<string | null>(null);
	const currentChannelId = ref<string | null>(null);

	// ─── Load cascade from API ────────────────────────────────────────────

	async function loadCascade(hostId?: string, channelId?: string): Promise<void> {
		const authStore = useAuthStore();
		if (authStore.token === null) return;

		currentHostId.value = hostId ?? null;
		currentChannelId.value = channelId ?? null;

		loading.value = true;
		try {
			const params = new URLSearchParams();
			if (hostId) params.set("host_id", hostId);
			if (channelId) params.set("channel_id", channelId);
			const qs = params.toString();
			const url = `${hubBaseUrl()}/api/config/cascade${qs ? `?${qs}` : ""}`;
			const res = await hubFetch(url, {
				headers: { Authorization: `Bearer ${authStore.token}` },
			});
			if (!res.ok) throw new Error(`Failed to load cascade: ${res.status}`);
			cascade.value = await res.json();
		} finally {
			loading.value = false;
		}
	}

	// ─── Cascade-aware getters ────────────────────────────────────────────

	/**
	 * Get the raw value at a specific scope layer.
	 * For terminal: global reads `cascade.terminal.global`, host reads `cascade.terminal.host`, etc.
	 * For appearance and ui: reads from the flat/global config.
	 */
	function getValue(scope: Scope, section: string, path: string): unknown {
		if (!cascade.value) return undefined;

		if (section === "appearance") {
			return getNestedValue(cascade.value.appearance, path);
		}

		if (section === "terminal") {
			const layer =
				scope === "global"
					? cascade.value.terminal.global
					: scope === "host"
						? cascade.value.terminal.host
						: cascade.value.terminal.channel;
			return layer ? getNestedValue(layer, path) : undefined;
		}

		if (section === "ui") {
			// UI config is global-only; read from global overrides
			return getNestedValue(cascade.value.ui.global, path);
		}

		if (section === "elevation") {
			return cascade.value?.elevation?.[path as keyof ElevationConfig];
		}

		return undefined;
	}

	/**
	 * Check if a value is overridden at this scope (i.e. the scope's layer has a non-undefined value).
	 * Global scope is always considered the "base" — returns true.
	 */
	function isOverridden(scope: Scope, section: string, path: string): boolean {
		if (scope === "global") return true;
		const val = getValue(scope, section, path);
		return val !== undefined && val !== null;
	}

	/**
	 * Get the inherited value and source name for a setting at a given scope.
	 * Returns null for global scope (no inheritance) and for non-terminal sections.
	 */
	function inheritedFrom(
		scope: Scope,
		section: string,
		path: string,
	): { value: unknown; source: string } | null {
		if (!cascade.value || scope === "global") return null;
		if (section !== "terminal") return null;

		if (scope === "channel") {
			// Check host first, then global, then defaults
			const hostVal = cascade.value.terminal.host
				? getNestedValue(cascade.value.terminal.host, path)
				: undefined;
			if (hostVal !== undefined && hostVal !== null) {
				return { value: hostVal, source: "host" };
			}
			const globalVal = getNestedValue(cascade.value.terminal.global, path);
			if (globalVal !== undefined && globalVal !== null) {
				return { value: globalVal, source: "global" };
			}
			return { value: getNestedValue(cascade.value.terminal.defaults, path), source: "defaults" };
		}

		if (scope === "host") {
			const globalVal = getNestedValue(cascade.value.terminal.global, path);
			if (globalVal !== undefined && globalVal !== null) {
				return { value: globalVal, source: "global" };
			}
			return { value: getNestedValue(cascade.value.terminal.defaults, path), source: "defaults" };
		}

		return null;
	}

	/**
	 * Get the final merged value for a setting (all layers resolved).
	 */
	function getResolved(section: string, path: string): unknown {
		if (!cascade.value) return undefined;
		if (section === "terminal") return getNestedValue(cascade.value.terminal.resolved, path);
		if (section === "ui") return getNestedValue(cascade.value.ui.resolved, path);
		if (section === "appearance") return getNestedValue(cascade.value.appearance, path);
		return undefined;
	}

	// ─── Mutations ────────────────────────────────────────────────────────

	const pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Apply an optimistic update to the cascade ref so the UI reflects the change immediately.
	 */
	function applyOptimistic(scope: Scope, section: string, key: string, value: unknown): void {
		if (!cascade.value) return;

		// Clone cascade to trigger reactivity
		const next = JSON.parse(JSON.stringify(cascade.value)) as CascadeResponse;

		if (section === "terminal") {
			if (scope === "global") {
				setNestedValue(next.terminal.global as Record<string, unknown>, key, value);
			} else if (scope === "host" && next.terminal.host) {
				setNestedValue(next.terminal.host as Record<string, unknown>, key, value);
			} else if (scope === "channel" && next.terminal.channel) {
				setNestedValue(next.terminal.channel as Record<string, unknown>, key, value);
			}
			// Update resolved
			setNestedValue(next.terminal.resolved as unknown as Record<string, unknown>, key, value);
		} else if (section === "ui") {
			setNestedValue(next.ui.global as Record<string, unknown>, key, value);
			setNestedValue(next.ui.resolved as unknown as Record<string, unknown>, key, value);
		} else if (section === "appearance") {
			setNestedValue(next.appearance as unknown as Record<string, unknown>, key, value);
		} else if (section === "elevation" && next.elevation) {
			(next.elevation as unknown as Record<string, unknown>)[key] = value;
		}

		cascade.value = next;
	}

	/**
	 * Update a setting with optimistic UI + debounced API call.
	 */
	async function updateSetting(
		scope: Scope,
		section: string,
		key: string,
		value: unknown,
	): Promise<void> {
		// Apply optimistic update immediately
		applyOptimistic(scope, section, key, value);

		// Debounce the API call (500ms)
		const debounceKey = `${scope}:${section}:${key}`;
		const existing = pendingUpdates.get(debounceKey);
		if (existing) clearTimeout(existing);

		pendingUpdates.set(
			debounceKey,
			setTimeout(async () => {
				pendingUpdates.delete(debounceKey);
				const authStore = useAuthStore();
				if (authStore.token === null) return;
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Authorization: `Bearer ${authStore.token}`,
				};

				try {
					if (scope === "global") {
						if (section === "terminal") {
							await hubFetch(`${hubBaseUrl()}/api/config/global`, {
								method: "PUT",
								headers,
								body: JSON.stringify({ terminal: { [key]: value } }),
							});
						} else if (section === "appearance") {
							// Build nested appearance payload from dot-path key
							const payload: Record<string, unknown> = {};
							setNestedValue(payload, key, value);
							await hubFetch(`${hubBaseUrl()}/api/config/appearance`, {
								method: "PUT",
								headers,
								body: JSON.stringify(payload),
							});
						} else if (section === "elevation") {
							// Elevation settings route to their own endpoint (flat key/value)
							await hubFetch(`${hubBaseUrl()}/api/config/elevation`, {
								method: "PUT",
								headers,
								body: JSON.stringify({ [key]: value }),
							});
						} else {
							// UI sections (tabs, panes, search, startup, title)
							// key may be "tabs.closeButton" → section "tabs", sub-key "closeButton"
							const parts = key.split(".");
							const uiSection = parts[0] as string;
							const uiKey = parts.slice(1).join(".");
							// key must be "section.subKey" (e.g. "tabs.closeButton")
							// Top-level UI keys are not valid API targets -- all UI settings
							// live under a named section. A bare key with no dot would produce
							// { ui: { key: value } } which the PUT /api/config/ui endpoint
							// rejects with 400 (no such top-level UI key).
							if (uiKey) {
								await hubFetch(`${hubBaseUrl()}/api/config/ui`, {
									method: "PUT",
									headers,
									body: JSON.stringify({ [uiSection]: { [uiKey]: value } }),
								});
							}
						}
					} else if (scope === "host") {
						if (!currentHostId.value) {
							console.error("updateSetting(host): no currentHostId set");
							return;
						}
						// PATCH merge semantics: { profile: { key: value } }
						const profile: Record<string, unknown> = {};
						profile[key] = value;
						await hubFetch(`${hubBaseUrl()}/api/hosts/${currentHostId.value}/profile`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ profile }),
						});
					} else if (scope === "channel") {
						if (!currentChannelId.value) {
							console.error("updateSetting(channel): no currentChannelId set");
							return;
						}
						const profile: Record<string, unknown> = {};
						profile[key] = value;
						await hubFetch(`${hubBaseUrl()}/api/channels/${currentChannelId.value}/profile`, {
							method: "PATCH",
							headers,
							body: JSON.stringify({ profile }),
						});
					}
					// On success, clear dirty state for this key
					dirty.value = new Set([...dirty.value].filter((k) => k !== debounceKey));
					// Notify per-terminal composables and refresh global config
					const configStore = useConfigStore();
					if (section === "terminal") {
						configStore.emitProfileChange({
							scope,
							...(currentHostId.value != null && { hostId: currentHostId.value }),
							...(currentChannelId.value != null && { channelId: currentChannelId.value }),
						});
					}
					if (scope === "global" && section === "terminal") {
						await configStore.loadProfile();
					} else if (scope === "global" && section !== "appearance" && section !== "elevation") {
						await configStore.loadUiConfig();
					}
				} catch (err) {
					// Keep optimistic value — mark as dirty instead of rolling back
					console.error("Failed to save setting:", err);
					dirty.value = new Set([...dirty.value, debounceKey]);
					const message = err instanceof Error ? err.message : "Failed to save setting";
					lastError.value = message;
					const toastStore = useToastStore();
					toastStore.show("error", `Setting save failed: ${message}`);
				}
			}, 500),
		);
	}

	/**
	 * Reset a setting at a scope (send null to remove the override).
	 */
	async function resetSetting(scope: Scope, section: string, key: string): Promise<void> {
		await updateSetting(scope, section, key, null);
	}

	return {
		cascade,
		activeScope,
		activeCategory,
		loading,
		dirty,
		lastError,
		currentHostId,
		currentChannelId,
		loadCascade,
		getValue,
		isOverridden,
		inheritedFrom,
		getResolved,
		updateSetting,
		resetSetting,
	};
});
