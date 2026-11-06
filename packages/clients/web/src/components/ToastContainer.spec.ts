import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import BASE from "../styles/base.css?raw";
import SOURCE from "./ToastContainer.vue?raw";

// ─── A toast reads in every theme (#830) ─────────────────────────────────────
//
// Toasts named `--nt-sidebar-bg`, which nothing defines, for a dark fallback
// ground, and each level's rule then replaced that ground with a 12% tint of
// its colour: whatever lay behind showed through, in every theme. They now take
// the exit card's ground and text, and mark their level in its border and its
// icon. Checked here, from the component's own rules, for every bundled theme,
// light and dark.

/** WCAG 2.1 SC 1.4.11, for what is not text: a border. */
const NON_TEXT_CONTRAST = 3;

const LEVELS = ["error", "warning", "info"] as const;

const style = SOURCE.slice(SOURCE.indexOf("<style")).replace(/\r\n/g, "\n");

/** The declarations of the rule for exactly `selector`. */
function declarations(selector: string): Map<string, string> {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
	const rule = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`).exec(style);
	if (!rule?.[1]) throw new Error(`no rule for ${selector}`);
	const out = new Map<string, string>();
	for (const line of rule[1].split(";")) {
		const [prop, ...value] = line.split(":");
		if (prop && value.length > 0) out.set(prop.trim(), value.join(":").trim());
	}
	return out;
}

/** The colour an expression the rules use stands for, once a theme is applied. */
function resolve(expr: string): [number, number, number] {
	const root = document.documentElement.style;
	const v = /^var\((--nt-[\w-]+)\)$/.exec(expr);
	if (v?.[1]) {
		const hex = root.getPropertyValue(v[1]).trim();
		if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`${v[1]} is ${hex}, not a solid colour`);
		return hexToRgb(hex).split(", ").map(Number) as [number, number, number];
	}
	const triple = /^rgb\(var\((--nt-[\w-]+-rgb)\)\)$/.exec(expr);
	if (triple?.[1]) {
		return root.getPropertyValue(triple[1]).split(",").map(Number) as [number, number, number];
	}
	throw new Error(`cannot check the contrast of ${expr}`);
}

/** The variables base.css declares: what exists before a theme is applied. */
const DECLARED = new Set([...BASE.matchAll(/^\s*(--nt-[\w-]+)\s*:/gm)].map((m) => m[1] ?? ""));

/** The variables the component names. */
const NAMED = [...new Set([...SOURCE.matchAll(/var\(\s*(--nt-[\w-]+)/g)].map((m) => m[1] ?? ""))];

function apply(theme: (typeof BUNDLED_THEMES)[string]): void {
	document.documentElement.removeAttribute("style");
	setActivePinia(createPinia());
	useThemeStore().applyTheme(theme);
}

describe("ToastContainer theme (#830)", () => {
	it("names only variables base.css declares", () => {
		expect(NAMED.length).toBeGreaterThan(0);
		for (const name of NAMED) {
			expect(DECLARED.has(name), `${name} is declared nowhere`).toBe(true);
		}
	});

	it("names only variables each theme sets", () => {
		for (const [themeName, theme] of Object.entries(BUNDLED_THEMES)) {
			apply(theme);
			const root = document.documentElement.style;
			for (const name of NAMED) {
				expect(root.getPropertyValue(name), `${name} in ${themeName}`).not.toBe("");
			}
		}
	});

	it("draws a toast on the theme's opaque ground, in its text, under its shadow", () => {
		const item = declarations(".toast-item");
		expect(item.get("background")).toBe("rgb(var(--nt-bg-rgb))");
		expect(item.get("color")).toBe("var(--nt-text-strong)");
		expect(item.get("box-shadow")).toBe("var(--nt-shadow)");
		expect(item.has("opacity")).toBe(false);
	});

	it("marks a level in its border and its icon, never with a fill", () => {
		for (const level of LEVELS) {
			const rule = declarations(`.toast-item--${level}`);
			expect(rule.get("border-color")).toBe(`var(--nt-status-${level})`);
			expect(rule.has("background")).toBe(false);
			expect(rule.has("color")).toBe(false);
			expect(rule.has("opacity")).toBe(false);
			expect(declarations(`.toast-item--${level} .toast-icon`).get("color")).toBe(
				`var(--nt-status-${level})`,
			);
		}
	});

	// A dimmed or tinted close button would take it below what it was checked for.
	it("keeps the close button at the toast's own colours", () => {
		const close = declarations(".toast-close");
		expect(close.get("color")).toBe("inherit");
		expect(close.has("opacity")).toBe(false);
		const hover = declarations(".toast-close:hover");
		for (const prop of ["color", "background", "opacity"]) {
			expect(hover.has(prop), `.toast-close:hover sets ${prop}`).toBe(false);
		}
	});

	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		it(`reads in ${name}`, () => {
			apply(theme);
			const item = declarations(".toast-item");
			const ground = resolve(item.get("background") ?? "");
			const text = contrastRatio(resolve(item.get("color") ?? ""), ground);
			expect(text, `text: ${text.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
			for (const level of LEVELS) {
				const border = resolve(declarations(`.toast-item--${level}`).get("border-color") ?? "");
				const icon = resolve(declarations(`.toast-item--${level} .toast-icon`).get("color") ?? "");
				const borderRatio = contrastRatio(border, ground);
				const iconRatio = contrastRatio(icon, ground);
				expect(borderRatio, `${level} border: ${borderRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
					NON_TEXT_CONTRAST,
				);
				expect(iconRatio, `${level} icon: ${iconRatio.toFixed(2)}`).toBeGreaterThanOrEqual(
					TEXT_CONTRAST_AA,
				);
			}
		});
	}
});
