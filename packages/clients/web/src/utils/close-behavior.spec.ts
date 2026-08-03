import { describe, expect, it } from "vitest";
import {
	closeBehaviorOptionsForTray,
	closeBehaviorWriteError,
	readCloseBehavior,
	resolveCloseAction,
	saveCloseBehavior,
	writeCloseBehavior,
} from "./close-behavior.js";

describe("close behavior helpers", () => {
	it("defaults to ask when native configuration is unavailable", async () => {
		expect(await readCloseBehavior()).toBe("ask");
		expect(resolveCloseAction(undefined)).toBe("modal");
	});

	it("treats unknown native values as ask", async () => {
		const invoke = async <T>(): Promise<T> => ({ behavior: "close-now" }) as T;

		expect(await readCloseBehavior(invoke)).toBe("ask");
		expect(resolveCloseAction("close-now")).toBe("modal");
	});

	it("shows a stored hide value as unavailable when no tray can offer it", () => {
		expect(closeBehaviorOptionsForTray(false, "hide")).toEqual([
			{ label: "Ask every time", value: "ask" },
			{ disabled: true, label: "Keep running in tray (unavailable)", value: "hide" },
			{ label: "Quit completely", value: "quit" },
		]);
		expect(closeBehaviorOptionsForTray(false, "ask").map((option) => option.value)).toEqual([
			"ask",
			"quit",
		]);
		expect(resolveCloseAction("hide")).toBe("hide");
	});

	it("reports a failed native read instead of treating it as stored ask", async () => {
		const invoke = async (): Promise<never> => {
			throw new Error("failed to read close preference");
		};

		await expect(readCloseBehavior(invoke)).rejects.toThrow("failed to read close preference");
	});

	it("writes from the webview through native IPC", async () => {
		const calls: Array<[string, Record<string, unknown> | undefined]> = [];
		const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
			calls.push([command, args]);
			return undefined as T;
		};

		await writeCloseBehavior("quit", invoke);
		expect(calls).toEqual([["set_close_behavior", { behavior: "quit" }]]);
	});

	it("reports a failed native write instead of resolving as though it persisted", async () => {
		const invoke = async (): Promise<never> => {
			throw new Error("failed to write close preference");
		};

		await expect(writeCloseBehavior("quit", invoke)).rejects.toThrow(
			"failed to write close preference",
		);
	});

	it("reports a failed write and leaves the settings value on its persisted preference", async () => {
		const result = await saveCloseBehavior("ask", "quit", async () => {
			throw new Error("disk unavailable");
		});

		expect(result).toEqual({
			behavior: "ask",
			error: "Close preference was not saved: disk unavailable",
		});
		expect(closeBehaviorWriteError(new Error("disk unavailable"))).toBe(
			"Close preference was not saved: disk unavailable",
		);
	});
});
