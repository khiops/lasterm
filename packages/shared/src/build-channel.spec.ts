import { afterEach, describe, expect, it } from "vitest";
import { buildChannel, channelBaseName, channelFromValue } from "./build-channel.js";

describe("channelFromValue (#1084)", () => {
	it("gives release for exactly 'release'", () => {
		expect(channelFromValue("release")).toBe("release");
	});

	it.each([
		["absent", undefined],
		["empty", ""],
		["capitalised", "Release"],
		["dev", "dev"],
		["anything else", "x"],
	])("gives dev when the value is %s", (_label, value) => {
		expect(channelFromValue(value)).toBe("dev");
	});
});

describe("buildChannel run from source (#1084)", () => {
	const original = process.env.LASTERM_CHANNEL;

	afterEach(() => {
		if (original === undefined) delete process.env.LASTERM_CHANNEL;
		else process.env.LASTERM_CHANNEL = original;
	});

	it("reads LASTERM_CHANNEL by the same rule", () => {
		process.env.LASTERM_CHANNEL = "release";
		expect(buildChannel()).toBe("release");
		process.env.LASTERM_CHANNEL = "Release";
		expect(buildChannel()).toBe("dev");
		delete process.env.LASTERM_CHANNEL;
		expect(buildChannel()).toBe("dev");
	});
});

describe("channelBaseName (#1084)", () => {
	it("is lasterm on release and lasterm-dev on dev", () => {
		expect(channelBaseName("release")).toBe("lasterm");
		expect(channelBaseName("dev")).toBe("lasterm-dev");
	});
});
