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
const selectedHost = ref("pi");

function mountModal() {
	const pinia = createPinia();
	setActivePinia(pinia);
	useHostsStore().hosts = [{ ...PI }, { ...PI, id: "nas", label: "NAS" }];
	selectedHost.value = "pi";
	visible.value = true;
	const onDeleted = vi.fn();
	const onClose = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(DeleteHostModal, {
				visible: visible.value,
				hostId: selectedHost.value,
				onDeleted,
				onClose,
			}),
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
		expect(useHostsStore().hosts.map((h) => h.id)).toEqual(["pi", "nas"]);

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

describe("DeleteHostModal hub consent (#910)", () => {
	const button = () => document.body.querySelector<HTMLButtonElement>(".btn-danger")!;
	const input = () => document.body.querySelector<HTMLInputElement>(".field-input");
	function counted(terminals: number, unreachable = 0) {
		return new Response(
			JSON.stringify({
				error: {
					code: "TERMINALS_WOULD_END",
					message: "hub count",
					terminals,
					...(unreachable > 0 && { unreachable }),
				},
			}),
			{ status: 409 },
		);
	}
	it.each([false, true])(
		"V4 asks the hub first and confirms its unreachable=%s count",
		async (unreachable) => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(counted(unreachable ? 1 : 2, unreachable ? 1 : 0))
				.mockResolvedValueOnce(new Response(null, { status: 204 }));
			const { onClose } = mountModal();
			expect(input()).toBeNull();
			expect(button().disabled).toBe(false);
			await clickDelete();
			expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/hosts/pi");
			expect(document.body.querySelector(".warning-text")?.textContent).toBe(
				unreachable
					? "1 terminal on pi has not ended, and Lasterm is not connected to its agent: nothing can be sent to it, and it may keep running. Connecting pi first may let Lasterm reach it."
					: "2 terminals on pi have not ended. Lasterm will ask their agent to end them, without waiting for it to confirm.",
			);
			expect(button().disabled).toBe(true);
			input()!.value = "PI";
			input()!.dispatchEvent(new Event("input"));
			await nextTick();
			expect(button().disabled).toBe(true);
			input()!.value = "pi";
			input()!.dispatchEvent(new Event("input"));
			await nextTick();
			await clickDelete();
			expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/hosts/pi?force=true");
			expect(onClose).toHaveBeenCalledOnce();
		},
	);
	it("V4 shows an upload refusal without asking for the label", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			refusal(409, "TRANSFERS_RUNNING", "Wait for the upload."),
		);
		mountModal();
		await clickDelete();
		expect(alert()?.textContent).toBe("Wait for the upload.");
		expect(input()).toBeNull();
	});
	it.each(["pi", "nas"])(
		"R9 ignores old success and refusal after reopening for %s",
		async (id) => {
			for (const oldResponse of [
				counted(2),
				new Response(null, { status: 204 }),
				refusal(409, "HOST_BUSY", "old refusal"),
			]) {
				let answer!: (res: Response) => void;
				const fetchSpy = vi
					.spyOn(globalThis, "fetch")
					.mockImplementationOnce(
						() =>
							new Promise((resolve) => {
								answer = resolve;
							}),
					)
					.mockResolvedValueOnce(new Response(null, { status: 204 }));
				const { onClose, onDeleted } = mountModal();
				await clickDelete();
				expect(button().disabled).toBe(true);
				visible.value = false;
				await nextTick();
				selectedHost.value = id;
				visible.value = true;
				await nextTick();
				const confirmation = document.body.querySelector(".confirm-text")?.textContent;
				answer(oldResponse);
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(document.body.querySelector(".confirm-text")?.textContent).toBe(confirmation);
				expect(input()).toBeNull();
				expect(alert()).toBeNull();
				expect(onClose).not.toHaveBeenCalled();
				expect(onDeleted).not.toHaveBeenCalled();
				await clickDelete();
				expect(fetchSpy.mock.calls[1]?.[0]).toBe(`/api/hosts/${id}`);
				app?.unmount();
				app = null;
				root.remove();
				fetchSpy.mockRestore();
			}
		},
	);
});
