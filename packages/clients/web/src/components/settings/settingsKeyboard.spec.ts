/**
 * Settings from the keyboard alone, over every category (#637): nothing is left that only the
 * mouse can use. The components that needed more than markup have their own specs (SettingControl,
 * ThemeCard, FontCard, FontPicker, ProfilesSettings, AgentImportModal); these read the rest.
 */
import { describe, expect, it } from "vitest";
import WALLPAPER from "./categories/WallpaperCategory.vue?raw";
import HOST_OVERRIDES from "./HostOverridesTable.vue?raw";
import THEME_EDITOR from "./ThemeEditor.vue?raw";

/** Every component of Settings, as source. */
const SOURCES = import.meta.glob<string>(["./*.vue", "./categories/*.vue"], {
	query: "?raw",
	import: "default",
	eager: true,
});

/** The opening tags of `source`, with their attributes, even when they run over several lines. */
function openingTags(source: string): string[] {
	const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? "";
	const tags: string[] = [];
	const tag = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
	for (let match = tag.exec(template); match !== null; match = tag.exec(template)) {
		tags.push(match[0]);
	}
	return tags;
}

describe("Settings from the keyboard", () => {
	it("reads every component of Settings", () => {
		expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
	});

	// A div or a span that acts on a click is out of the keyboard's reach. A backdrop's
	// `@click.self` is not a control: Esc does what it does.
	it("has no click handler on an element the keyboard cannot reach", () => {
		const offenders: string[] = [];
		for (const [file, source] of Object.entries(SOURCES)) {
			for (const tag of openingTags(source)) {
				const name = /^<([\w-]+)/.exec(tag)?.[1] ?? "";
				if (!/^(div|span|li|ul|td|tr|p|img|section|article|header|footer|nav|label)$/.test(name)) {
					continue;
				}
				const clicks = /@(click|dblclick|mousedown)(?!\.self)[.\w]*=/.test(tag);
				const reachable =
					/\btabindex=|\brole="(button|switch|option|tab|radio|checkbox|menuitem)"/.test(tag);
				if (clicks && !reachable) offenders.push(`${file}: ${tag.replace(/\s+/g, " ")}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("says which wallpaper is chosen, and names and shows each one's delete button", () => {
		expect(WALLPAPER).toContain(':aria-pressed="currentWallpaper === wp"');
		expect(WALLPAPER).toMatch(/:aria-label="`Delete wallpaper \$\{wp\}`"/);
		expect(WALLPAPER).toMatch(
			/\.wallpaper-thumb-wrapper:hover \.wallpaper-delete,\s*\.wallpaper-thumb-wrapper:focus-within \.wallpaper-delete\s*\{[^}]*opacity:\s*1/,
		);
	});

	it("says which of Dark and Light a theme being edited is", () => {
		expect(THEME_EDITOR).toContain(":aria-pressed=\"draft.type === 'dark'\"");
		expect(THEME_EDITOR).toContain(":aria-pressed=\"draft.type === 'light'\"");
		expect(THEME_EDITOR).toContain('role="group" aria-labelledby="te-type-label"');
	});

	it("names each host's override", () => {
		expect(HOST_OVERRIDES).toMatch(/:aria-label="`Override for \$\{host\.label\}`"/);
	});
});
