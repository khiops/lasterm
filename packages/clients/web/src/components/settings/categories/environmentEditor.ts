import type { AgentEnvironmentResponse, EnvMode } from "@lasterm/shared";
import { computed, type Ref, ref, watch } from "vue";
import { useAuthStore } from "../../../stores/auth.js";
import { type Scope, useSettingsStore } from "../../../stores/settings.js";
import { hubFetch } from "../../../utils/hub-fetch.js";
import { hubBaseUrl } from "../../../utils/hub-url.js";
import {
	changeCounts,
	type EnvChanges,
	environmentRows,
	modeLabel,
	type OuterChanges,
	readChanges,
	removeVariable,
	renameVariable,
	restoreVariable,
	setVariable,
	toStored,
} from "./environmentSettings.js";

/**
 * What the host's agent says a terminal starts with, as far as the editor
 * knows. Held by the editor alone, for as long as it is on screen: the values
 * can be secrets, and they are neither stored nor cached anywhere (#576).
 */
export type AgentEnvironmentState =
	/** The global scope: no single agent to ask. */
	| { status: "none" }
	| { status: "loading" }
	| { status: "ready"; os: string; env: Record<string, string> }
	| { status: "unavailable"; message: string };

/** What the page says when the host's variables cannot be shown. */
export function agentEnvironmentMessage(status: number, code: string | undefined): string {
	switch (code) {
		case "HOST_NOT_CONNECTED":
			return "This host is not connected, so its variables cannot be shown. Open a terminal on it, then come back here. Changes can still be made by name.";
		case "AGENT_TOO_OLD":
			return "The agent on this host is too old to report its variables. Replace it (Settings › Agents) to see them. Changes can still be made by name.";
		case "AGENT_TIMEOUT":
			return "The agent on this host did not answer in time. Changes can still be made by name.";
		default:
			return `The host's variables could not be read (${status}). Changes can still be made by name.`;
	}
}

/**
 * The environment editor of a settings scope: the agent's variables for the
 * mode, fetched live at host and terminal scope, and the changes the scope
 * stores, which every edit writes back whole.
 */
export function useEnvironmentEditor(scope: Ref<Scope>) {
	const settings = useSettingsStore();
	const auth = useAuthStore();
	const agent = ref<AgentEnvironmentState>({ status: "none" });

	/** The mode a terminal of this scope starts with: its own, or the one it inherits. */
	const mode = computed<EnvMode>(() => {
		const own = settings.getValue(scope.value, "terminal", "envMode");
		const value =
			own ??
			settings.inheritedFrom(scope.value, "terminal", "envMode")?.value ??
			settings.cascade?.terminal.defaults.envMode;
		return value === "minimal" ? "minimal" : "inherit";
	});

	/** The host whose agent is asked: a terminal's is its host's. */
	const hostId = computed(() => (scope.value === "global" ? null : settings.currentHostId));

	const own = computed(() => readChanges(settings.getValue(scope.value, "terminal", "env")));

	const outer = computed<OuterChanges[]>(() => {
		const terminal = settings.cascade?.terminal;
		if (terminal === undefined || scope.value === "global") return [];
		const layers: OuterChanges[] = [{ scope: "global", changes: readChanges(terminal.global.env) }];
		if (scope.value === "channel") {
			layers.push({ scope: "host", changes: readChanges(terminal.host?.env) });
		}
		return layers;
	});

	const ignoreCase = computed(() => agent.value.status === "ready" && agent.value.os === "windows");

	const rows = computed(() =>
		environmentRows(
			agent.value.status === "ready" ? agent.value.env : null,
			outer.value,
			own.value,
			ignoreCase.value,
		),
	);
	const counts = computed(() => changeCounts(rows.value));
	const customized = computed(() => Object.keys(own.value).length > 0);
	const modeOptions = computed(() =>
		(["inherit", "minimal"] as const).map((value) => ({
			value,
			label: modeLabel(value, customized.value && mode.value === value),
		})),
	);

	let asked = 0;
	async function load(): Promise<void> {
		const host = hostId.value;
		const token = auth.token;
		const ask = ++asked;
		if (host === null || token === null) {
			agent.value = { status: "none" };
			return;
		}
		agent.value = { status: "loading" };
		try {
			const res = await hubFetch(
				`${hubBaseUrl()}/api/hosts/${encodeURIComponent(host)}/agent-environment?mode=${mode.value}`,
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!res.ok) {
				let code: string | undefined;
				try {
					code = ((await res.json()) as { error?: { code?: string } }).error?.code;
				} catch {
					code = undefined;
				}
				if (ask === asked) {
					agent.value = {
						status: "unavailable",
						message: agentEnvironmentMessage(res.status, code),
					};
				}
				return;
			}
			const body = (await res.json()) as AgentEnvironmentResponse;
			if (ask === asked) {
				agent.value = { status: "ready", os: body.os, env: body.env ?? {} };
			}
		} catch {
			if (ask === asked) {
				agent.value = {
					status: "unavailable",
					message: agentEnvironmentMessage(0, undefined),
				};
			}
		}
	}

	// A new scope, host or mode is another question, asked again.
	watch([scope, hostId, mode], () => void load(), { immediate: true });

	function commit(next: EnvChanges): Promise<void> {
		return settings.updateSetting(scope.value, "terminal", "env", toStored(next));
	}

	return {
		agent,
		mode,
		modeOptions,
		rows,
		counts,
		customized,
		reload: load,
		setMode: (value: EnvMode) => settings.updateSetting(scope.value, "terminal", "envMode", value),
		/** Stored as `env[name] = value` at this scope. */
		set: (name: string, value: string) =>
			commit(setVariable(own.value, name, value, ignoreCase.value)),
		/** Stored as `env[name] = null` at this scope. */
		remove: (name: string) => commit(removeVariable(own.value, name, ignoreCase.value)),
		/** This scope's change for `name` taken back: the key is reset here. */
		restore: (name: string) => commit(restoreVariable(own.value, name, ignoreCase.value)),
		rename: (from: string, to: string, value: string) =>
			commit(renameVariable(own.value, from, to, value, ignoreCase.value)),
	};
}
