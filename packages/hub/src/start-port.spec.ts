import { describe, expect, it } from "vitest";
import { resolveStartPort } from "./start-port.js";

describe("resolveStartPort", () => {
	it("prefers the flag over the environment", () => {
		expect(resolveStartPort(4300, "4200")).toBe(4300);
	});

	it("uses LASTERM_PORT when no flag is given", () => {
		// Mutation caught: `lasterm start` read only the flag and bound elsewhere (#175).
		expect(resolveStartPort(undefined, "4200")).toBe(4200);
	});

	it("leaves the choice to the operating system when neither is set", () => {
		expect(resolveStartPort(undefined, undefined)).toBeUndefined();
		expect(resolveStartPort(undefined, "")).toBeUndefined();
	});

	it("refuses a port that is not an integer in range, naming where it came from", () => {
		expect(() => resolveStartPort(undefined, "http")).toThrow("Invalid LASTERM_PORT: http");
		expect(() => resolveStartPort(undefined, "70000")).toThrow("Invalid LASTERM_PORT: 70000");
		expect(() => resolveStartPort(Number.NaN, undefined)).toThrow("Invalid --port: NaN");
		expect(() => resolveStartPort(0, "4200")).toThrow("Invalid --port: 0");
	});
});
