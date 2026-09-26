import { type CascadeResponse, DEFAULT_PROFILE } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type Ref, ref } from "vue";
import { type Scope, useSettingsStore } from "../../../stores/settings.js";
import { useEnvironmentEditor } from "./environmentEditor.js";

vi.mock("../../../utils/hub-url.js", () => ({ hubBaseUrl: () => "http://hub" }));

type Editor = ReturnType<typeof useEnvironmentEditor>;

/** Mount the editor as the settings page does, inside a Vue app. */
function mountEditor(scope: Ref<Scope>): { editor: Editor; unmount: () => void } {
	let editor!: Editor;
	const app = createApp(
		defineComponent({
			setup() {
				editor = useEnvironmentEditor(scope);
				return {};
			},
			template: "<div />",
		}),
	);
	app.mount(document.createElement("div"));
	return { editor, unmount: () => app.unmount() };
}

function cascade(terminal: Partial<CascadeResponse["terminal"]>): CascadeResponse {
	return {
		terminal: { defaults: DEFAULT_PROFILE, global: {}, resolved: DEFAULT_PROFILE, ...terminal },
	} as CascadeResponse;
}

function answer(status: number, body: unknown) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The hub: the agent's environment on GET, an acknowledgement for every write. */
function hub(environment: (url: string) => ReturnType<typeof answer>) {
	return vi.fn(async (url: string, init?: RequestInit) =>
		init?.method === undefined && url.includes("/agent-environment")
			? environment(url)
			: answer(200, { ok: true }),
	);
}

async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

const PI = { HOME: "/home/pi", PATH: "/usr/bin:/bin", TERM: "xterm-256color" };

describe("the environment editor", () => {
	let settings: ReturnType<typeof useSettingsStore>;
	let mounted: { unmount: () => void } | undefined;

	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.setItem("lasterm_token", "test-token");
		settings = useSettingsStore();
		settings.currentHostId = "host-1";
	});

	afterEach(() => {
		mounted?.unmount();
		mounted = undefined;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		localStorage.clear();
	});

	it("asks the host's agent, for the mode the scope resolves, and shows its variables with the changes", async () => {
		settings.cascade = cascade({
			global: { env: { PAGER: "less" } },
			host: { envMode: "minimal", env: { HOME: null } },
		});
		const fetchMock = hub(() => answer(200, { mode: "minimal", os: "linux", env: PI }));
		vi.stubGlobal("fetch", fetchMock);

		const { editor, unmount } = mountEditor(ref<Scope>("host"));
		mounted = { unmount };
		await settle();

		expect(fetchMock).toHaveBeenCalledWith(
			"http://hub/api/hosts/host-1/agent-environment?mode=minimal",
			expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
		);
		expect(editor.agent.value.status).toBe("ready");
		expect(editor.rows.value.map((row) => [row.name, row.state, row.from])).toEqual([
			["HOME", "removed", "agent"],
			["PAGER", "inherited", "global"],
			["PATH", "inherited", "agent"],
			["TERM", "inherited", "agent"],
		]);
		expect(editor.modeOptions.value).toEqual([
			{ value: "inherit", label: "Inherited" },
			{ value: "minimal", label: "Minimal (customized)" },
		]);
		expect(editor.counts.value).toEqual({ removed: 1, changed: 0, added: 0 });
	});

	// A terminal's variables are those of the agent on its host.
	it("asks a terminal's host, and reads the host's changes as an outer scope", async () => {
		settings.cascade = cascade({
			host: { env: { TERM: null } },
			channel: { env: { EDITOR: "hx" } },
		});
		const fetchMock = hub(() => answer(200, { mode: "inherit", os: "linux", env: PI }));
		vi.stubGlobal("fetch", fetchMock);

		const { editor, unmount } = mountEditor(ref<Scope>("channel"));
		mounted = { unmount };
		await settle();

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://hub/api/hosts/host-1/agent-environment?mode=inherit",
		);
		expect(editor.rows.value.map((row) => [row.name, row.state])).toEqual([
			["EDITOR", "added"],
			["HOME", "inherited"],
			["PATH", "inherited"],
			["TERM", "removed-above"],
		]);
	});

	// Only the change is written, never the environment it produces; and the
	// page shows it at once, even for a host that had no profile yet.
	it("stores a removal as null and a restore as the key taken back", async () => {
		vi.useFakeTimers();
		settings.cascade = cascade({});
		const fetchMock = hub(() => answer(200, { mode: "inherit", os: "linux", env: PI }));
		vi.stubGlobal("fetch", fetchMock);
		const { editor, unmount } = mountEditor(ref<Scope>("host"));
		mounted = { unmount };
		await settle();

		void editor.remove("PATH");
		await nextTick();
		expect(editor.rows.value.find((row) => row.name === "PATH")?.state).toBe("removed");
		await vi.advanceTimersByTimeAsync(600);

		void editor.set("EDITOR", "hx");
		await vi.advanceTimersByTimeAsync(600);
		void editor.restore("PATH");
		await vi.advanceTimersByTimeAsync(600);
		void editor.restore("EDITOR");
		await vi.advanceTimersByTimeAsync(600);

		const writes = fetchMock.mock.calls
			.filter(([, init]) => init?.method === "PATCH")
			.map(([url, init]) => [url, JSON.parse(String(init?.body))]);
		expect(writes).toEqual([
			["http://hub/api/hosts/host-1/profile", { profile: { env: { PATH: null } } }],
			["http://hub/api/hosts/host-1/profile", { profile: { env: { PATH: null, EDITOR: "hx" } } }],
			["http://hub/api/hosts/host-1/profile", { profile: { env: { EDITOR: "hx" } } }],
			["http://hub/api/hosts/host-1/profile", { profile: { env: null } }],
		]);
	});

	it("asks again when the mode changes", async () => {
		vi.useFakeTimers();
		settings.cascade = cascade({ host: {} });
		const fetchMock = hub((url) =>
			answer(200, { mode: url.endsWith("minimal") ? "minimal" : "inherit", os: "linux", env: PI }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { editor, unmount } = mountEditor(ref<Scope>("host"));
		mounted = { unmount };
		await settle();

		void editor.setMode("minimal");
		await settle();

		const asked = fetchMock.mock.calls
			.map(([url]) => url)
			.filter((url) => url.includes("/agent-environment"));
		expect(asked).toEqual([
			"http://hub/api/hosts/host-1/agent-environment?mode=inherit",
			"http://hub/api/hosts/host-1/agent-environment?mode=minimal",
		]);
	});

	it("says why a host's variables cannot be shown, and keeps the changes editable", async () => {
		settings.cascade = cascade({ host: { env: { NO_COLOR: null } } });
		vi.stubGlobal(
			"fetch",
			hub(() => answer(409, { error: { code: "HOST_NOT_CONNECTED", message: "…" } })),
		);

		const { editor, unmount } = mountEditor(ref<Scope>("host"));
		mounted = { unmount };
		await settle();

		expect(editor.agent.value).toEqual({
			status: "unavailable",
			message: expect.stringContaining("not connected"),
		});
		expect(editor.rows.value).toEqual([
			{ name: "NO_COLOR", value: "", state: "removed", from: null },
		]);
	});

	it("says so of an agent too old to answer", async () => {
		settings.cascade = cascade({ host: {} });
		vi.stubGlobal(
			"fetch",
			hub(() => answer(409, { error: { code: "AGENT_TOO_OLD" } })),
		);

		const { editor, unmount } = mountEditor(ref<Scope>("host"));
		mounted = { unmount };
		await settle();

		expect(editor.agent.value).toEqual({
			status: "unavailable",
			message: expect.stringContaining("too old"),
		});
	});

	// There is no single agent behind the global scope: the page keeps the
	// editor, and a removal is typed by name.
	it("asks no agent at global scope, and stores a removal typed by name", async () => {
		settings.cascade = cascade({});
		const fetchMock = hub(() => answer(200, {}));
		vi.stubGlobal("fetch", fetchMock);
		const update = vi.spyOn(settings, "updateSetting").mockResolvedValue();

		const { editor, unmount } = mountEditor(ref<Scope>("global"));
		mounted = { unmount };
		await settle();
		await editor.remove("NO_COLOR");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(editor.agent.value).toEqual({ status: "none" });
		expect(update).toHaveBeenCalledWith("global", "terminal", "env", { NO_COLOR: null });
	});

	it("compares names as the host's agent does: without case on Windows", async () => {
		settings.cascade = cascade({ host: { env: { path: "C:\\Tools" } } });
		vi.stubGlobal(
			"fetch",
			hub(() => answer(200, { mode: "inherit", os: "windows", env: { Path: "C:\\Windows" } })),
		);
		const update = vi.spyOn(settings, "updateSetting").mockResolvedValue();

		const { editor, unmount } = mountEditor(ref<Scope>("host"));
		mounted = { unmount };
		await settle();

		expect(editor.rows.value).toEqual([
			{ name: "Path", value: "C:\\Tools", state: "changed", from: "agent", before: "C:\\Windows" },
		]);
		await editor.remove("Path");
		expect(update).toHaveBeenCalledWith("host", "terminal", "env", { Path: null });
	});
});
