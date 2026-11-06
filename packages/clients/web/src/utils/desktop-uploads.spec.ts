/**
 * The seam with the desktop shell's part of uploads (#837, #863): the page reports what it sends
 * with `set_uploads_in_progress`, numbered 1, 2, 3 … in the document since the calls may arrive
 * out of order; only the newest report's answer says what quit waits; the shell's
 * `uploads-quit-pending` changes it; Cancel is `cancel_quit_when_finished`. A shell without the
 * commands changes nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import {
	CANCEL_QUIT_COMMAND,
	type DesktopBridge,
	QUIT_PENDING_EVENT,
	type QuitPending,
	readPending,
	reportUploadsToDesktop,
	SET_UPLOADS_COMMAND,
} from "./desktop-uploads.js";
import type { UploadsReport } from "./transfers-view.js";

const idle: UploadsReport = { inProgress: 0, waiting: 0, failed: 0, percent: null };

/** A shell whose answers the spec settles one by one, in any order. */
function fakeShell() {
	const calls: {
		command: string;
		args: Record<string, unknown> | undefined;
		answer: (value: unknown) => void;
		fail: (error: unknown) => void;
	}[] = [];
	const listeners = new Map<string, (payload: unknown) => void>();
	const bridge: DesktopBridge = {
		invoke: (command, args) =>
			new Promise((answer, fail) => {
				calls.push({ command, args, answer, fail });
			}),
		listen: async (event, handler) => {
			listeners.set(event, handler);
			return () => listeners.delete(event);
		},
	};
	return { bridge: Promise.resolve(bridge), calls, listeners };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await nextTick();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reporting this window's uploads to the desktop shell", () => {
	it("reports at start and on every change, numbered from 1, the last one ending included", async () => {
		const shell = fakeShell();
		const report = ref<UploadsReport>({ ...idle });
		const seam = reportUploadsToDesktop(
			() => report.value,
			() => undefined,
			shell.bridge,
		);
		await flush();
		report.value = { inProgress: 2, waiting: 0, failed: 0, percent: 10 };
		await flush();
		// The same numbers again say nothing new.
		report.value = { inProgress: 2, waiting: 0, failed: 0, percent: 10 };
		await flush();
		report.value = { ...idle };
		await flush();
		expect(shell.calls.map((call) => [call.command, call.args])).toEqual([
			[SET_UPLOADS_COMMAND, { seq: 1, inProgress: 0, waiting: 0, failed: 0, percent: null }],
			[SET_UPLOADS_COMMAND, { seq: 2, inProgress: 2, waiting: 0, failed: 0, percent: 10 }],
			[SET_UPLOADS_COMMAND, { seq: 3, inProgress: 0, waiting: 0, failed: 0, percent: null }],
		]);
		seam.stop();
	});

	it("takes the pending quit from the newest report's answer only, whatever order answers come in", async () => {
		const shell = fakeShell();
		const report = ref<UploadsReport>({ inProgress: 1, waiting: 0, failed: 0, percent: 0 });
		const seen: QuitPending[] = [];
		reportUploadsToDesktop(
			() => report.value,
			(pending) => seen.push(pending),
			shell.bridge,
		);
		await flush();
		report.value = { inProgress: 1, waiting: 0, failed: 0, percent: 50 };
		await flush();
		const [first, second] = shell.calls;
		// The newest comes back first: a quit waits.
		second?.answer({ pending: "quit" });
		await flush();
		// The older one's answer, late, does not undo it.
		first?.answer({ pending: null });
		await flush();
		expect(seen).toEqual(["quit"]);
	});

	it("hears the shell change the pending quit, and cancels it", async () => {
		const shell = fakeShell();
		const seen: QuitPending[] = [];
		const seam = reportUploadsToDesktop(
			() => idle,
			(pending) => seen.push(pending),
			shell.bridge,
		);
		await flush();
		shell.listeners.get(QUIT_PENDING_EVENT)?.({ pending: "restart" });
		const cancelling = seam.cancelQuit();
		await flush();
		const cancel = shell.calls.find((call) => call.command === CANCEL_QUIT_COMMAND);
		expect(cancel?.args).toBeUndefined();
		cancel?.answer(true);
		expect(await cancelling).toBe(true);
		expect(seen).toEqual(["restart", null]);
		seam.stop();
		expect(shell.listeners.has(QUIT_PENDING_EVENT)).toBe(false);
	});

	it("changes nothing with a shell that has not the commands, and says it once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const shell = fakeShell();
		const report = ref<UploadsReport>({ ...idle });
		const seen: QuitPending[] = [];
		const seam = reportUploadsToDesktop(
			() => report.value,
			(pending) => seen.push(pending),
			shell.bridge,
		);
		await flush();
		report.value = { inProgress: 1, waiting: 0, failed: 0, percent: 0 };
		await flush();
		for (const call of shell.calls)
			call.fail(new Error("Command set_uploads_in_progress not found"));
		const cancelling = seam.cancelQuit();
		await flush();
		shell.calls.at(-1)?.fail(new Error("Command cancel_quit_when_finished not found"));
		expect(await cancelling).toBe(false);
		expect(seen).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does nothing outside the desktop", async () => {
		const seam = reportUploadsToDesktop(
			() => idle,
			() => undefined,
			null,
		);
		expect(await seam.cancelQuit()).toBe(false);
	});

	it("reads only a quit or a restart as pending", () => {
		expect(readPending({ pending: "quit" })).toBe("quit");
		expect(readPending({ pending: "restart" })).toBe("restart");
		expect(readPending({ pending: "later" })).toBeNull();
		expect(readPending(null)).toBeNull();
	});
});
