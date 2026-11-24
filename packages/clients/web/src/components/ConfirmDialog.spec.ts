/**
 * The question's keyboard (#1189): it goes onto Cancel when the dialog opens, Esc cancels, Tab
 * stays inside, and the keyboard goes back to where it was when the dialog closes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = "";
});

async function mountAsking() {
	const visible = ref(false);
	const events: string[] = [];
	const root = document.createElement("div");
	document.body.appendChild(root);
	const opener = document.createElement("button");
	opener.textContent = "Ask";
	document.body.appendChild(opener);
	opener.focus();
	app = createApp({
		render: () =>
			h(ConfirmDialog, {
				visible: visible.value,
				title: "Update the agent?",
				message: "It ends terminals.",
				confirmLabel: "Update agent",
				onCancel: () => {
					events.push("cancel");
					visible.value = false;
				},
				onConfirm: () => events.push("confirm"),
			}),
	});
	app.mount(root);
	await nextTick();
	return { visible, events, opener };
}

const keydown = (key: string, shiftKey = false) =>
	document.activeElement?.dispatchEvent(
		new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
	);

describe("the confirmation dialog's keyboard (#1189)", () => {
	it("is a modal alertdialog, so the window leaves its keys to it", async () => {
		const { visible } = await mountAsking();
		visible.value = true;
		await nextTick();
		const dialog = document.querySelector(".confirm-dialog");
		expect(dialog?.getAttribute("role")).toBe("alertdialog");
		expect(dialog?.getAttribute("aria-modal")).toBe("true");
	});

	it("puts the keyboard on Cancel, not on the confirming button", async () => {
		const { visible } = await mountAsking();
		visible.value = true;
		await nextTick();
		await nextTick();
		expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
	});

	it("cancels on Escape and gives the keyboard back to what had it", async () => {
		const { visible, events, opener } = await mountAsking();
		visible.value = true;
		await nextTick();
		await nextTick();

		keydown("Escape");
		await nextTick();
		await nextTick();

		expect(events).toEqual(["cancel"]);
		expect(document.activeElement).toBe(opener);
	});

	it("keeps Tab inside: from the confirming button it goes round to Cancel", async () => {
		const { visible } = await mountAsking();
		visible.value = true;
		await nextTick();
		await nextTick();
		document.querySelector<HTMLElement>(".btn-danger")?.focus();

		keydown("Tab");

		expect(document.activeElement?.textContent?.trim()).toBe("Cancel");
	});
});
