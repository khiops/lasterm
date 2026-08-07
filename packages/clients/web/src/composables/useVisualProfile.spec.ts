import type { Host } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import {
	clampOpacity,
	getVisualProfile,
	isValidHexColor,
	resolveBannerTokens,
} from "./useVisualProfile.js";

function makeHost(overrides: Partial<Host> = {}): Host {
	return {
		id: "01TESTHOST",
		type: "ssh",
		label: "prod-server",
		sshHost: "10.0.1.5",
		sshUser: "deploy",
		iconType: "auto",
		trustRemoteHints: "apply",
		sortOrder: 0,
		keepAliveSeconds: 60,
		historyRetentionDays: 30,
		hostGroup: "production",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	} as Host;
}

describe("getVisualProfile", () => {
	it("returns default for null host", () => {
		const p = getVisualProfile(null);
		expect(p.preset).toBe("none");
		expect(p.banner.enabled).toBe(false);
		expect(p.tint.enabled).toBe(false);
	});

	it("returns default for host with no profileJson", () => {
		const p = getVisualProfile(makeHost());
		expect(p.preset).toBe("none");
	});

	it("parses visualProfile from profileJson", () => {
		const host = makeHost({
			profileJson: JSON.stringify({
				visualProfile: {
					preset: "danger",
					banner: {
						enabled: true,
						text: "PROD",
						bgColor: "#e06c75",
						textColor: "#ffffff",
					},
					border: { style: "strong", color: "#e06c75" },
					tint: { enabled: true, color: "#e06c75", opacity: 5 },
				},
			}),
		});
		const p = getVisualProfile(host);
		expect(p.preset).toBe("danger");
		expect(p.banner.enabled).toBe(true);
		expect(p.banner.text).toBe("PROD");
		expect(p.border.style).toBe("strong");
		expect(p.tint.opacity).toBe(5);
	});

	it("returns default for invalid JSON in profileJson", () => {
		const host = makeHost({ profileJson: "{{invalid" });
		const p = getVisualProfile(host);
		expect(p.preset).toBe("none");
	});

	it("deep-merges partial nested overrides — default sub-keys are preserved", () => {
		// Override only banner.enabled — bgColor/textColor/text should come from defaults
		const host = makeHost({
			profileJson: JSON.stringify({
				visualProfile: {
					preset: "custom",
					banner: { enabled: true },
				},
			}),
		});
		const p = getVisualProfile(host);
		expect(p.preset).toBe("custom");
		expect(p.banner.enabled).toBe(true);
		// Sub-keys not in override must come from DEFAULT_VISUAL_PROFILE
		expect(p.banner.text).toBe("");
		expect(p.banner.bgColor).toBe("#e06c75");
		expect(p.banner.textColor).toBe("#ffffff");
		// Untouched nested objects also preserve their defaults
		expect(p.border.style).toBe("none");
		expect(p.tint.enabled).toBe(false);
	});

	it("deep-merges partial tint override without losing default tint color", () => {
		const host = makeHost({
			profileJson: JSON.stringify({
				visualProfile: {
					tint: { enabled: true },
				},
			}),
		});
		const p = getVisualProfile(host);
		expect(p.tint.enabled).toBe(true);
		// default tint color preserved
		expect(p.tint.color).toBe("#e06c75");
		expect(p.tint.opacity).toBe(0);
	});
});

describe("resolveBannerTokens", () => {
	it("replaces {host}, {ip}, {user}, {group}", () => {
		const host = makeHost();
		const result = resolveBannerTokens("{host} @ {ip} as {user} in {group}", host);
		expect(result).toBe("prod-server @ 10.0.1.5 as deploy in production");
	});

	it("renders literal {group} when hostGroup is null", () => {
		const host = makeHost({ hostGroup: null });
		const result = resolveBannerTokens("Group: {group}", host);
		expect(result).toBe("Group: {group}");
	});

	it("renders 'localhost' when sshHost is undefined", () => {
		const { sshHost: _, ...rest } = makeHost();
		const host = rest as Host;
		const result = resolveBannerTokens("IP: {ip}", host);
		expect(result).toBe("IP: localhost");
	});
});

describe("clampOpacity", () => {
	it("clamps values to 0-15 range", () => {
		expect(clampOpacity(-5)).toBe(0);
		expect(clampOpacity(0)).toBe(0);
		expect(clampOpacity(7)).toBe(7);
		expect(clampOpacity(15)).toBe(15);
		expect(clampOpacity(20)).toBe(15);
		expect(clampOpacity(100)).toBe(15);
	});
});

describe("isValidHexColor", () => {
	it("validates #rrggbb format", () => {
		expect(isValidHexColor("#ff0000")).toBe(true);
		expect(isValidHexColor("#e5c07b")).toBe(true);
		expect(isValidHexColor("#AABBCC")).toBe(true);
		expect(isValidHexColor("ff0000")).toBe(false);
		expect(isValidHexColor("#fff")).toBe(false);
		expect(isValidHexColor("#gggggg")).toBe(false);
		expect(isValidHexColor("")).toBe(false);
	});
});
