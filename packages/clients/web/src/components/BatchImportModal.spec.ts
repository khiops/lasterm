import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import BatchImportModal from "./BatchImportModal.vue";

let app: App | null = null;
let root: HTMLElement;

function mountModal() {
	const pinia = createPinia();
	setActivePinia(pinia);
	const show = ref(false);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		setup: () => () => h(BatchImportModal, { show: show.value }),
	});
	app.use(pinia);
	app.mount(root);
	show.value = true;
	return nextTick();
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sshConfigResponse(): Response {
	return new Response(
		JSON.stringify({
			entries: [
				{
					name: "app",
					hostname: "10.0.0.8",
					port: 22,
					user: null,
					identity_file: null,
					proxy_jump: null,
					is_git_host: false,
				},
			],
			has_include: false,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

async function importBody(keepRemoteDaemon: boolean): Promise<Array<Record<string, unknown>>> {
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(sshConfigResponse())
		.mockResolvedValueOnce(new Response(JSON.stringify([{}]), { status: 201 }));
	await mountModal();
	await settle();
	const daemonOption = document.body.querySelector<HTMLInputElement>(
		".remote-daemon-option input[type='checkbox']",
	);
	if (!daemonOption) throw new Error("no remote daemon option");
	expect(daemonOption.checked).toBe(true);
	if (!keepRemoteDaemon) {
		daemonOption.checked = false;
		daemonOption.dispatchEvent(new Event("change"));
		await nextTick();
	}
	const submit = document.body.querySelector<HTMLButtonElement>(".dialog-actions .btn-primary");
	if (!submit) throw new Error("no import button");
	submit.click();
	await settle();
	const [, init] = fetchSpy.mock.calls[1] ?? [];
	const body = JSON.parse(String(init?.body));
	if (!body || !Array.isArray(body.entries)) throw new Error("no import entries");
	return body.entries;
}

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("BatchImportModal remote daemon choice", () => {
	it("imports every selected host with the disclosed default", async () => {
		expect(await importBody(true)).toEqual([{ name: "app", label: "app", sshRemoteDaemon: true }]);
		expect(document.body.textContent).toContain("30 minutes with no terminal and no hub connected");
	});

	it("imports every selected host with false after the option is unticked", async () => {
		expect(await importBody(false)).toEqual([
			{ name: "app", label: "app", sshRemoteDaemon: false },
		]);
	});
});
