/**
 * What the web client says when the hub refuses an action or does not answer
 * (#703, #734): in a dialog beside its buttons, or in a toast for a menu, the
 * rail or a drag.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "../stores/toast.js";
import {
	type HubAnswer,
	hubRefusal,
	hubUnreachable,
	toastRefusal,
	whyRefused,
} from "./hub-answer.js";

const refused: HubAnswer = {
	ok: false,
	status: 409,
	code: "HOST_BUSY",
	message: "This host's agent is being stopped.",
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("hubRefusal", () => {
	it("reads the hub's code and message", async () => {
		expect(
			await hubRefusal(
				json(404, { error: { code: "NOT_FOUND", message: "Host group not found" } }),
			),
		).toEqual({ ok: false, status: 404, code: "NOT_FOUND", message: "Host group not found" });
	});

	it("says the status when the hub gave no reason of its own", async () => {
		expect(await hubRefusal(new Response(null, { status: 502 }))).toEqual({
			ok: false,
			status: 502,
			code: null,
			message: "The hub answered 502.",
		});
	});
});

describe("hubUnreachable", () => {
	it("says the hub could not be reached, and what failed", () => {
		expect(hubUnreachable(new TypeError("Failed to fetch"))).toBe(
			"Could not reach the hub: Failed to fetch",
		);
		expect(hubUnreachable("offline")).toBe("Could not reach the hub: offline");
	});
});

describe("whyRefused, for a dialog", () => {
	it("is the hub's reason when it refused", async () => {
		expect(await whyRefused(Promise.resolve(refused))).toBe("This host's agent is being stopped.");
	});

	it("says so when the hub does not answer", async () => {
		expect(await whyRefused(Promise.reject(new TypeError("Failed to fetch")))).toBe(
			"Could not reach the hub: Failed to fetch",
		);
	});

	it("is null when the action went through", async () => {
		expect(await whyRefused(Promise.resolve({ ok: true }))).toBeNull();
	});
});

describe("toastRefusal, for a menu, the rail or a drag", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	const toasts = () => useToastStore().messages.map(({ level, text }) => ({ level, text }));

	it("shows the hub's reason in an error toast", async () => {
		expect(await toastRefusal(Promise.resolve(refused))).toBe(false);
		expect(toasts()).toEqual([{ level: "error", text: "This host's agent is being stopped." }]);
	});

	it("says so when the hub does not answer", async () => {
		expect(await toastRefusal(Promise.reject(new TypeError("Failed to fetch")))).toBe(false);
		expect(toasts()).toEqual([
			{ level: "error", text: "Could not reach the hub: Failed to fetch" },
		]);
	});

	it("shows nothing when the action went through", async () => {
		expect(await toastRefusal(Promise.resolve({ ok: true }))).toBe(true);
		expect(toasts()).toEqual([]);
	});
});
