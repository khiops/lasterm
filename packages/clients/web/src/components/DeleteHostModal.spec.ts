/**
 * The Delete Host dialog when the hub refuses (#734): it stays open and says
 * why beside its buttons, as the host dialog does since #703.
 *
 * Mounted with its real stores. Only the request to the hub is stood in for,
 * at fetch, which is what hubFetch calls outside the desktop.
 */
import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useHostsStore } from "../stores/hosts.js";
import DeleteHostModal from "./DeleteHostModal.vue";

const STAMP = "2026-10-28T00:00:00.000Z";

const PI: Host = {
	id: "pi",
	type: "ssh",
	label: "pi",
	sshHost: "pi.test",
	sshAuth: "agent",
	iconType: "auto",
	trustRemoteHints: "apply",
	sortOrder: 0,
	os: "linux",
	arch: null,
	createdAt: STAMP,
	updatedAt: STAMP,
};

let app: App | null = null;
let root: HTMLElement;
const visible = ref(true);

function mountModal() {
	const pinia = createPinia();
	setActivePinia(pinia);
	useHostsStore().hosts = [{ ...PI }];
	visible.value = true;
	const onDeleted = vi.fn();
	const onClose = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () => h(DeleteHostModal, { visible: visible.value, hostId: "pi", onDeleted, onClose }),
	});
	app.use(pinia);
	app.mount(root);
	return { onDeleted, onClose };
}

function refusal(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** The dialog is teleported to the body. */
const alert = (): HTMLElement | null =>
	document.body.querySelector(".dialog-actions [role='alert']");

async function clickDelete(): Promise<void> {
	document.body.querySelector<HTMLButtonElement>(".dialog-actions .btn-danger")?.click();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("DeleteHostModal when the hub refuses (#734)", () => {
	it("shows the hub's reason beside Delete, stays open, and closes once deleted", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(refusal(409, "HOST_BUSY", "This host's agent is being stopped."))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const { onDeleted, onClose } = mountModal();
		expect(alert()).toBeNull();

		await clickDelete();

		expect(alert()?.textContent).toBe("This host's agent is being stopped.");
		expect(onDeleted).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(useHostsStore().hosts.map((h) => h.id)).toEqual(["pi"]);

		await clickDelete();

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(alert()).toBeNull();
		expect(onDeleted).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("says so when the hub does not answer", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const { onClose } = mountModal();

		await clickDelete();

		expect(alert()?.textContent).toBe("Could not reach the hub: Failed to fetch");
		expect(onClose).not.toHaveBeenCalled();
	});

	it("opens again without the last refusal", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			refusal(404, "NOT_FOUND", "Host not found"),
		);
		mountModal();
		await clickDelete();
		expect(alert()?.textContent).toBe("Host not found");

		visible.value = false;
		await nextTick();
		visible.value = true;
		await nextTick();

		expect(document.body.querySelector(".delete-host-modal")).not.toBeNull();
		expect(alert()).toBeNull();
	});
});
