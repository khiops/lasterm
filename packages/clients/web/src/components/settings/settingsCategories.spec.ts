import { describe, expect, it } from "vitest";
import { getVisibleSettingsCategories } from "./settingsCategories.js";
import { settingsSchema } from "./settingsSchema.js";

describe("settings reachable where they apply", () => {
	// A setting offered at a scope is only settable there if its category is
	// shown at that scope: Scrollbar Markers, cascaded, lives under Search (#614).
	for (const def of settingsSchema) {
		for (const scope of def.scopes) {
			it(`${def.section}.${def.key} is under a category shown at ${scope} scope`, () => {
				const shown = getVisibleSettingsCategories(scope, true).map((cat) => cat.id);
				expect(shown).toContain(def.category);
			});
		}
	}
});

describe("settings category visibility", () => {
	it("hides the desktop category outside Tauri", () => {
		const categories = getVisibleSettingsCategories("global", false);

		expect(categories.map((cat) => cat.id)).not.toContain("desktop");
	});

	it("shows the desktop category in Tauri", () => {
		const categories = getVisibleSettingsCategories("global", true);

		expect(categories.map((cat) => cat.id)).toContain("desktop");
	});

	it("hides global-only desktop settings for host and channel scopes", () => {
		expect(getVisibleSettingsCategories("host", true).map((cat) => cat.id)).not.toContain(
			"desktop",
		);
		expect(getVisibleSettingsCategories("channel", true).map((cat) => cat.id)).not.toContain(
			"desktop",
		);
	});
});
