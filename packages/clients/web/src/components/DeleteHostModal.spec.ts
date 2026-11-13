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

function mountModal(hostId = "pi") {
	const pinia = createPinia();
	setActivePinia(pinia);
	useHostsStore().hosts = [{ ...PI }, { ...PI, id: "nas", label: "NAS" }];
	selectedHost.value = hostId;
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
	// One row per form of D7's wording, the hub's counts as it sends them, for
	// a host whose label ("NAS") is not its id ("nas").
	it.each([
		[
			2,
			0,
			"2 terminals on NAS have not ended. Lasterm will ask their agent to end them, without waiting for it to confirm.",
		],
		[
			1,
			0,
			"1 terminal on NAS has not ended. Lasterm will ask its agent to end it, without waiting for it to confirm.",
		],
		[
			1,
			1,
			"1 terminal on NAS has not ended, and Lasterm is not connected to its agent: nothing can be sent to it, and it may keep running. Connecting NAS first may let Lasterm reach it.",
		],
		[
			3,
			3,
			"3 terminals on NAS have not ended, and Lasterm is not connected to their agent: nothing can be sent to them, and they may keep running. Connecting NAS first may let Lasterm reach them.",
		],
	])(
		"V4 asks the hub first and confirms its count: terminals=%i, unreachable=%i",
		async (terminals, unreachable, warning) => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(counted(terminals, unreachable))
				.mockResolvedValueOnce(new Response(null, { status: 204 }));
			const { onClose } = mountModal("nas");
			expect(input()).toBeNull();
			expect(button().disabled).toBe(false);
			await clickDelete();
			expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/hosts/nas");
			expect(document.body.querySelector(".warning-text")?.textContent).toBe(warning);
			expect(document.body.querySelector(".warning-text + p")?.textContent).toBe(
				"Type NAS to confirm:",
			);
			expect(button().disabled).toBe(true);
			// The id, which is the label in another case: not the label.
			input()!.value = "nas";
			input()!.dispatchEvent(new Event("input"));
			await nextTick();
			expect(button().disabled).toBe(true);
			input()!.value = "NAS";
			input()!.dispatchEvent(new Event("input"));
			await nextTick();
			await clickDelete();
			expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/hosts/nas?force=true");
			expect(onClose).toHaveBeenCalledOnce();
		},
	);
	// D7: a refusal of the forced request shows the hub's message too.
	it("V4 shows a refusal of the forced request, and stays open", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(counted(2))
			.mockResolvedValueOnce(refusal(409, "HOST_BUSY", "This host's agent is being stopped."));
		const { onClose, onDeleted } = mountModal();
		await clickDelete();
		input()!.value = "pi";
		input()!.dispatchEvent(new Event("input"));
		await nextTick();
		await clickDelete();
		expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/hosts/pi?force=true");
		expect(alert()?.textContent).toBe("This host's agent is being stopped.");
		expect(onDeleted).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});
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
