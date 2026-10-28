/**
 * The SSH key picker's upload into the folder it shows (#768): the hub reads
 * only the multipart fields that precede the file, so `dir` must come first.
 *
 * Mounted with its real stores. Only the requests to the hub are stood in for,
 * at fetch, which is what hubFetch calls outside the desktop.
 */
import type { SshKeyEntry } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import SshKeyPicker from "./SshKeyPicker.vue";

let app: App | null = null;
let root: HTMLElement;

function listing(entries: SshKeyEntry[]): Response {
	return new Response(JSON.stringify({ path: "", entries }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("SshKeyPicker upload (#768)", () => {
	it("sends the folder it shows as dir, before the file", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(listing([{ name: "work", type: "directory", items: 0 }]))
			.mockResolvedValueOnce(listing([]))
			.mockResolvedValueOnce(new Response(JSON.stringify({ name: "id_ed25519" }), { status: 200 }))
			.mockResolvedValue(listing([]));
		const pinia = createPinia();
		setActivePinia(pinia);
		const show = ref(false);
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(SshKeyPicker, { modelValue: undefined, show: show.value }) });
		app.use(pinia);
		app.mount(root);
		show.value = true;
		await nextTick();
		await settle();

		document.body.querySelector<HTMLElement>(".key-card--dir")?.click();
		await nextTick();
		await settle();

		const input = document.body.querySelector<HTMLInputElement>(".ssh-picker-footer input");
		if (!input) throw new Error("no file input");
		const key = new File(["key"], "id_ed25519");
		Object.defineProperty(input, "files", { value: [key], configurable: true });
		input.dispatchEvent(new Event("change"));
		await settle();

		const upload = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST");
		const body = upload?.[1]?.body;
		expect(body).toBeInstanceOf(FormData);
		const form = body as FormData;
		expect([...form.keys()]).toEqual(["dir", "file"]);
		expect(form.get("dir")).toBe("work");
	});
});
