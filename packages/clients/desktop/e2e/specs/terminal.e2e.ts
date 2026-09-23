type Element = {
	click(): Promise<void>;
	isExisting(): Promise<boolean>;
};
// The runner injects these; the e2e tsconfig carries no WebdriverIO globals.
declare const browser: {
	execute<T, A>(script: (argument: A) => T, argument: A): Promise<T>;
	keys(value: string): Promise<void>;
	refresh(): Promise<void>;
	pause(ms: number): Promise<void>;
};
declare function $(selector: string): Promise<Element>;
declare function describe(name: string, body: () => void): void;
declare function it(name: string, body: () => Promise<void>): void;

/**
 * The gestures that found the defects of the acceptance pass (#471), run on
 * the packaged application with its own hub and agent.
 *
 * Every one of these passed the unit suite while failing on screen: Restart
 * did nothing (#472), a reload left the terminals untypable (#488), a burst of
 * attaches closed the transport (#490). What is asserted here is what a person
 * sees: the command they typed, answered by the shell.
 */

/** Long enough for a first start: the hub creates its host and finds shells. */
const READY_MS = 45_000;
const ANSWER_MS = 15_000;

const VISIBLE_PANE = '.pane-tab-container:not([style*="display: none"]) .terminal-pane';

/** The visible pane's rows, as xterm's DOM renderer draws them. */
function paneText(): Promise<string> {
	return browser.execute((selector: string) => {
		const pane = document.querySelector(selector);
		return Array.from(pane?.querySelectorAll(".xterm-rows > div") ?? [])
			.map((row) => row.textContent ?? "")
			.join("\n");
	}, VISIBLE_PANE);
}

function paneState(): Promise<{ lock: string | null; overlay: string | null }> {
	return browser.execute((selector: string) => {
		const pane = document.querySelector(selector);
		return {
			lock: pane?.querySelector(".wl-label")?.textContent?.trim() ?? null,
			overlay: pane?.querySelector(".exit-overlay")?.textContent?.trim() ?? null,
		};
	}, VISIBLE_PANE);
}

/**
 * Poll until `condition` holds. On timeout the message is built then, from
 * what the pane shows at that moment — not from what it showed before.
 */
async function waitFor(
	condition: () => Promise<boolean>,
	timeout: number,
	failure: () => Promise<string>,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await browser.pause(250);
	}
	throw new Error(await failure());
}

async function waitForWriter(context: string): Promise<void> {
	await waitFor(
		async () => (await paneState()).lock === "Writer",
		READY_MS,
		async () =>
			`${context}: the visible pane never became the writer (${JSON.stringify(await paneState())})`,
	);
}

/**
 * Type as a person does: click the terminal, then keys. xterm's own textarea
 * is kept out of sight, and a driver refuses to click what cannot be seen.
 */
async function type(text: string): Promise<void> {
	await (await $(`${VISIBLE_PANE} .xterm-screen`)).click();
	await browser.keys(text);
	await browser.keys("Enter");
}

/**
 * Type a command whose answer is not in its own text, so that seeing the
 * answer proves the shell ran it rather than echoed the keys: the command
 * holds `label` and `42` apart, only the shell joins them.
 *
 * No character is typed twice in a row. WebKitGTK's driver dropped one of each
 * doubled shifted key — `$((6*7))` arrived as `$(6*7)` — where the app itself,
 * fed the same keys one by one, received them all.
 */
async function runAndExpect(label: string): Promise<void> {
	await type(`printf %s-%s ${label} 42`);
	await waitFor(
		async () => (await paneText()).includes(`${label}-42`),
		ANSWER_MS,
		async () => `${label}: the shell never answered. Screen:\n${await paneText()}`,
	);
}

describe("a terminal, used", () => {
	it("opens, and runs what is typed", async () => {
		await waitFor(
			async () => (await $(".rail-hosts .status-dot--live")).isExisting(),
			READY_MS,
			async () => "the local host never came up",
		);
		await (await $(".tab-bar__add--main")).click();
		await waitForWriter("new terminal");
		await runAndExpect("opened");
	});

	it("still takes typing after the page is reloaded (#488)", async () => {
		await browser.refresh();
		await waitForWriter("after reload");
		await runAndExpect("reloaded");

		// The previous document's socket used to linger as a second client:
		// twice more, and the pane is still this page's to type in.
		await browser.refresh();
		await browser.refresh();
		await waitForWriter("after three reloads");
		await runAndExpect("reloaded-thrice");
	});

	it("comes back when Restart is pressed after its shell has ended (#472, #486)", async () => {
		await type("exit");
		await waitFor(
			async () => (await paneState()).overlay !== null,
			ANSWER_MS,
			async () => `the pane never said its shell had ended (${JSON.stringify(await paneState())})`,
		);
		await browser.execute((selector: string) => {
			const restart = Array.from(
				document.querySelector(selector)?.querySelectorAll(".exit-overlay .exit-btn") ?? [],
			).find((button) => button.textContent?.trim() === "Restart");
			(restart as HTMLButtonElement | undefined)?.click();
		}, VISIBLE_PANE);

		await waitFor(
			async () => (await paneState()).overlay === null,
			READY_MS,
			async () => `Restart left the overlay up (${JSON.stringify(await paneState())})`,
		);
		await waitForWriter("after restart");
		await runAndExpect("restarted");
	});
});
