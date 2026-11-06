/**
 * base.css is the list of the `--nt-*` variables: it gives each one its value before a theme is
 * applied, and applyTheme overwrites them. A variable named anywhere else and declared nowhere
 * resolves to its fallback in every theme, as `--nt-sidebar-bg` did for every toast (#830).
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import { useThemeStore } from "../stores/theme.js";
import BASE from "./base.css?raw";

const SOURCES: Record<string, string> = {
	...import.meta.glob<string>("../**/*.vue", { query: "?raw", import: "default", eager: true }),
	"./base.css": BASE,
};

const DECLARED = new Set([...BASE.matchAll(/^\s*(--nt-[\w-]+)\s*:/gm)].map((m) => m[1] ?? ""));

describe("base.css (#830)", () => {
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

	it("declares every variable a theme sets", () => {
		const root = document.documentElement.style;
		for (const theme of Object.values(BUNDLED_THEMES)) {
			document.documentElement.removeAttribute("style");
			setActivePinia(createPinia());
			useThemeStore().applyTheme(theme);
			for (let i = 0; i < root.length; i++) {
				const name = root.item(i);
				if (name.startsWith("--nt-")) expect(DECLARED.has(name), name).toBe(true);
			}
		}
	});
});
