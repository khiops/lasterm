/**
 * The group dialog's refusal (#734): its parent keeps it open and hands it
 * why the hub refused, which it shows beside its buttons. What the parent
 * does with the hub's answer is in App.spec.ts and utils/hub-answer.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import GroupActionDialog from "./GroupActionDialog.vue";

let app: App | null = null;
let root: HTMLElement;
const error = ref<string | null>(null);

function mountDialog() {
	error.value = null;
	const onConfirm = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(GroupActionDialog, {
				visible: true,
				title: "Rename Group",
				message: "Rename group 'Prod'.",
				confirmLabel: "Rename",
				inputLabel: "NEW NAME",
				inputValue: "Prod",
				error: error.value,
				onConfirm,
			}),
	});
	app.mount(root);
	return { onConfirm };
}

/** The dialog is teleported to the body. */
const alert = (): HTMLElement | null =>
	document.body.querySelector(".dialog-actions [role='alert']");
const input = (): HTMLInputElement | null =>
	document.body.querySelector<HTMLInputElement>(".field-input");

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

describe("GroupActionDialog's refusal (#734)", () => {
	it("shows nothing until there is one", () => {
		mountDialog();
		expect(alert()).toBeNull();
	});

	it("shows why beside its buttons, and keeps what was typed for another try", async () => {
		const { onConfirm } = mountDialog();
		const field = input();
		if (!field) throw new Error("no input");
		field.value = "Lab";
		field.dispatchEvent(new Event("input"));
		document.body.querySelector<HTMLButtonElement>(".dialog-actions .btn-primary")?.click();
		expect(onConfirm).toHaveBeenCalledWith("Lab");

		error.value = "Host group with this name already exists";
		await nextTick();

		expect(alert()?.textContent).toBe("Host group with this name already exists");
		expect(input()?.value).toBe("Lab");
		expect(
			document.body.querySelector<HTMLButtonElement>(".dialog-actions .btn-primary")?.disabled,
		).toBe(false);
	});

	it("drops it once the parent clears it", async () => {
		mountDialog();
		error.value = "Could not reach the hub: Failed to fetch";
		await nextTick();
		expect(alert()?.textContent).toBe("Could not reach the hub: Failed to fetch");

		error.value = null;
		await nextTick();
		expect(alert()).toBeNull();
	});
});
