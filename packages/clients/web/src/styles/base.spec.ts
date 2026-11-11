/**
 * base.css is the list of the `--nt-*` variables: it gives each one its value before a theme is
 * applied, and applyTheme overwrites them. A variable named anywhere else and declared nowhere
 * resolves to its fallback in every theme, as `--nt-sidebar-bg` did for every toast (#830).
 *
 * A variable named and declared nowhere is the linter's to refuse (Biome's
 * noUndeclaredCustomProperties, over the web client's components and stylesheets). base.css is
 * applied here as the app applies it (main.ts imports it), and what it gives is read from the
 * cascade. Its scrollbar rules are drawn only by a browser: base.browser.spec.ts.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import "./base.css";
import { useThemeStore } from "../stores/theme.js";

describe("base.css (#830)", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("style");
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
