// The card a paste of several lines waits on (#1015), mounted alone: what it
// says and how it answers keys. When it shows and what Paste sends are the
// pane's (TerminalPane.spec.ts) and the composable's (useTerminal.browser.spec.ts).
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import type { PendingPaste } from "../composables/useTerminal.js";
import PasteConfirm from "./PasteConfirm.vue";

let app: App | null = null;
let host: HTMLElement;
let answers: Array<["paste", "host" | "global" | null] | ["cancel"]>;

async function mountCard(pending: Partial<PendingPaste>): Promise<HTMLElement> {
	host = document.createElement("div");
	document.body.appendChild(host);
	answers = [];
	app = createApp({
		render: () =>
			h(PasteConfirm, {
				pending: { id: 1, lines: 2, preview: ["a", "b"], bracketed: false, ...pending },
				hostLabel: "raspberrypi",
				onPaste: (where: "host" | "global" | null) => answers.push(["paste", where]),
				onCancel: () => answers.push(["cancel"]),
			}),
	});
	app.mount(host);
	await nextTick();
	await nextTick();
	return host.querySelector<HTMLElement>(".paste-confirm") as HTMLElement;
}

afterEach(() => {
	app?.unmount();
	app = null;
	host.remove();
});

const previewLines = (card: HTMLElement) =>
	[...card.querySelectorAll(".paste-confirm__preview li")].map((li) => li.textContent);

describe("PasteConfirm (#1015)", () => {
	it("says how many lines, what they may do, the first three, and how many more", async () => {
		const long = "y".repeat(100);
		const card = await mountCard({ lines: 5, preview: ["one", long, "three"] });
		expect(card.querySelector(".paste-confirm__title")?.textContent).toBe("Paste 5 lines?");
		expect(card.textContent).toContain("Its line breaks may run commands as soon as they arrive.");
		expect(previewLines(card)).toEqual(["one", `${"y".repeat(80)}…`, "three"]);
		expect(card.querySelector(".paste-confirm__more")?.textContent?.trim()).toBe("2 more lines");
	});

	it("cuts a line whole characters at a time, never inside an emoji", async () => {
		const card = await mountCard({ preview: [`${"x".repeat(79)}😀and more`, "b"] });
		expect(previewLines(card)[0]).toBe(`${"x".repeat(79)}😀…`);
	});

	it("shows markup in a pasted line as text", async () => {
		const card = await mountCard({ preview: ["echo '<b>hello</b>'", "b"] });
		expect(previewLines(card)[0]).toBe("echo '<b>hello</b>'");
		expect(card.querySelector("b")).toBeNull();
	});

	it("says the program asked for pastes as one block when it has bracketed paste on", async () => {
		const card = await mountCard({ bracketed: true });
		expect(card.textContent).toContain(
			"The program in this terminal has asked to receive pastes as one block.",
		);
		expect(card.textContent).not.toContain("Its line breaks may run commands");
	});

	it("takes the keyboard itself, not Paste, and cancels on Escape", async () => {
		const card = await mountCard({});
		expect(document.activeElement).toBe(card);
		card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(answers).toEqual([]);
		card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(answers).toEqual([["cancel"]]);
	});
});
