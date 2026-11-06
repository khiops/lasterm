// biome-ignore-all lint/suspicious/noTemplateCurlyInString: test data holds a literal ${HOME}, which the agent expands, not JavaScript
import { describe, expect, it } from "vitest";
import {
	DEFAULT_LAYOUT_CONFIG,
	DEFAULT_PROFILE,
	LAYOUT_CONFIG_KEYS,
	TERMINAL_PROFILE_KEYS,
	UI_CONFIG_SECTIONS,
	UI_SECTION_KEYS,
} from "./config.js";
import {
	DEFAULT_EXPERIMENTAL_CONFIG,
	DEFAULT_TRANSFER_CONFIG,
	EXPERIMENTAL_CONFIG_KEYS,
	HOST_ONLY_PROFILE_KEYS,
	isFileTransferEnabled,
	isTransferPanelWidth,
	TRANSFER_CONFIG_KEYS,
	TRANSFER_CONFIG_VALIDATORS,
	TRANSFER_PROFILE_KEYS,
	TRANSFER_PROFILE_VALIDATORS,
} from "./file-transfer.js";

// ─── The keys, their defaults and their whitelists ───────────────────────────

describe("file transfer's keys", () => {
	it("are terminal-profile keys, with the defaults of #835", () => {
		for (const key of TRANSFER_PROFILE_KEYS) expect(TERMINAL_PROFILE_KEYS).toContain(key);
		expect(DEFAULT_PROFILE).toMatchObject({
			transferDrop: "upload",
			transferConfirmDrop: true,
			transferOnConflict: "ask",
			transferFollowCwd: true,
			transferFallbackDir: "",
			transferVerify: true,
		});
	});

	it("keep the fallback folder and the check for the host, never one terminal", () => {
		expect([...HOST_ONLY_PROFILE_KEYS].sort()).toEqual(["transferFallbackDir", "transferVerify"]);
	});

	it("have a [transfer] section of their own, global, with its defaults", () => {
		expect(UI_CONFIG_SECTIONS).toContain("transfer");
		expect(UI_SECTION_KEYS.transfer).toEqual(TRANSFER_CONFIG_KEYS);
		expect(DEFAULT_TRANSFER_CONFIG).toEqual({
			panelSide: "right",
			openOnDrag: true,
			maxConcurrent: 2,
			showHidden: false,
		});
	});

	it("keep the files panel's width in [layout], 300 px by default", () => {
		expect(LAYOUT_CONFIG_KEYS).toContain("transferPanelWidth");
		expect(DEFAULT_LAYOUT_CONFIG.transferPanelWidth).toBe(300);
	});

	it("wait behind [experimental] file_transfer, off by default", () => {
		expect(UI_CONFIG_SECTIONS).toContain("experimental");
		expect(UI_SECTION_KEYS.experimental).toEqual(EXPERIMENTAL_CONFIG_KEYS);
		expect(DEFAULT_EXPERIMENTAL_CONFIG).toEqual({ fileTransfer: false });
	});
});

// ─── TRANSFER_PROFILE_VALIDATORS ─────────────────────────────────────────────

describe("TRANSFER_PROFILE_VALIDATORS", () => {
	type Case = [
		key: keyof typeof TRANSFER_PROFILE_VALIDATORS,
		verdict: "accepts" | "refuses",
		value: unknown,
	];
	const cases: Case[] = [
		["transferDrop", "accepts", "upload"],
		["transferDrop", "accepts", "off"],
		["transferDrop", "refuses", "download"],
		["transferDrop", "refuses", true],
		["transferConfirmDrop", "accepts", true],
		["transferConfirmDrop", "accepts", false],
		["transferConfirmDrop", "refuses", "true"],
		["transferOnConflict", "accepts", "ask"],
		["transferOnConflict", "accepts", "replace"],
		["transferOnConflict", "accepts", "keep_both"],
		["transferOnConflict", "accepts", "skip"],
		["transferOnConflict", "refuses", "keepBoth"],
		["transferOnConflict", "refuses", "overwrite"],
		["transferFollowCwd", "accepts", false],
		["transferFollowCwd", "refuses", 1],
		["transferFallbackDir", "accepts", ""],
		["transferFallbackDir", "accepts", "/srv/drop"],
		["transferFallbackDir", "accepts", "${HOME}/inbox"],
		["transferFallbackDir", "accepts", "C:\\Users\\me\\Downloads"],
		["transferFallbackDir", "accepts", "x".repeat(1024)],
		["transferFallbackDir", "refuses", "x".repeat(1025)],
		["transferFallbackDir", "refuses", "/srv/\0drop"],
		["transferFallbackDir", "refuses", 42],
		["transferVerify", "accepts", true],
		["transferVerify", "refuses", "no"],
	];

	it.each(cases)("%s %s %j", (key, verdict, value) => {
		expect(TRANSFER_PROFILE_VALIDATORS[key](value)).toBe(verdict === "accepts");
	});

	it("has a rule for every key", () => {
		expect(Object.keys(TRANSFER_PROFILE_VALIDATORS).sort()).toEqual(
			[...TRANSFER_PROFILE_KEYS].sort(),
		);
	});
});

// ─── TRANSFER_CONFIG_VALIDATORS and the panel's width ────────────────────────

describe("TRANSFER_CONFIG_VALIDATORS", () => {
	type Case = [
		key: keyof typeof TRANSFER_CONFIG_VALIDATORS,
		verdict: "accepts" | "refuses",
		value: unknown,
	];
	const cases: Case[] = [
		["panelSide", "accepts", "right"],
		["panelSide", "accepts", "left"],
		["panelSide", "refuses", "bottom"],
		["openOnDrag", "accepts", false],
		["openOnDrag", "refuses", "false"],
		["maxConcurrent", "accepts", 1],
		["maxConcurrent", "accepts", 3],
		["maxConcurrent", "refuses", 0],
		["maxConcurrent", "refuses", 4],
		["maxConcurrent", "refuses", 1.5],
		["maxConcurrent", "refuses", "2"],
		["showHidden", "accepts", true],
		["showHidden", "refuses", null],
	];

	it.each(cases)("%s %s %j", (key, verdict, value) => {
		expect(TRANSFER_CONFIG_VALIDATORS[key](value)).toBe(verdict === "accepts");
	});

	it("has a rule for every key", () => {
		expect(Object.keys(TRANSFER_CONFIG_VALIDATORS).sort()).toEqual(
			[...TRANSFER_CONFIG_KEYS].sort(),
		);
	});
});

describe("isTransferPanelWidth", () => {
	it.each([240, 300, 520])("accepts %j", (width) => {
		expect(isTransferPanelWidth(width)).toBe(true);
	});

	it.each([239, 521, 300.5, "300", 0])("refuses %j", (width) => {
		expect(isTransferPanelWidth(width)).toBe(false);
	});
});

// ─── The switch ──────────────────────────────────────────────────────────────

describe("isFileTransferEnabled", () => {
	it("is on only when the UI config says true", () => {
		expect(isFileTransferEnabled({ experimental: { fileTransfer: true } })).toBe(true);
	});

	it("is off by default, and for anything short of true", () => {
		expect(isFileTransferEnabled(undefined)).toBe(false);
		expect(isFileTransferEnabled(null)).toBe(false);
		expect(isFileTransferEnabled({})).toBe(false);
		expect(isFileTransferEnabled({ experimental: DEFAULT_EXPERIMENTAL_CONFIG })).toBe(false);
		expect(isFileTransferEnabled({ experimental: {} })).toBe(false);
	});
});
