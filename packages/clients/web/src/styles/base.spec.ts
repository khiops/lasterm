/**
 * base.css is the list of the `--nt-*` variables: it gives each one its value before a theme is
 * applied, and applyTheme overwrites them. A variable named anywhere else and declared nowhere
 * resolves to its fallback in every theme, as `--nt-sidebar-bg` did for every toast (#830).
 *
 * base.css is applied here as the app applies it (main.ts imports it), and what it gives is read
 * from the cascade. Its scrollbar rules are drawn only by a browser: base.browser.spec.ts.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import "./base.css";
import { useThemeStore } from "../stores/theme.js";
import BASE from "./base.css?raw";

const SOURCES: Record<string, string> = {
	...import.meta.glob<string>("../**/*.vue", { query: "?raw", import: "default", eager: true }),
	"./base.css": BASE,
};

const DECLARED = new Set([...BASE.matchAll(/^\s*(--nt-[\w-]+)\s*:/gm)].map((m) => m[1] ?? ""));

describe("base.css (#830)", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("style");
	});

	it("declares every --nt-* variable the web client names", () => {
		expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
		const undeclared: string[] = [];
		for (const [file, source] of Object.entries(SOURCES)) {
			for (const [, name] of source.matchAll(/var\(\s*(--nt-[\w-]+)/g)) {
				if (name && !DECLARED.has(name)) undeclared.push(`${file}: ${name}`);
			}
		}
		expect(undeclared).toEqual([]);
	});

	// Before a theme is applied, and wherever a theme leaves a variable out, the page draws with
	// what base.css gives it.
	it("gives every variable a theme sets a value before any theme is applied", () => {
		const root = document.documentElement;
		const unset: string[] = [];
		for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
			setActivePinia(createPinia());
			useThemeStore().applyTheme(theme);
			const set: string[] = [];
			for (let i = 0; i < root.style.length; i++) {
				if (root.style.item(i).startsWith("--nt-")) set.push(root.style.item(i));
			}
			expect(set.length, name).toBeGreaterThan(40);
			root.removeAttribute("style");
			for (const property of set) {
				if (getComputedStyle(root).getPropertyValue(property).trim() === "") {
					unset.push(`${name}: ${property}`);
				}
			}
		}
		expect(unset).toEqual([]);
	});
});
