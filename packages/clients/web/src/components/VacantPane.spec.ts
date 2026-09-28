import { describe, expect, it } from "vitest";
import PALETTE from "./CommandPalette.vue?raw";
import PANE_LAYOUT from "./PaneLayout.vue?raw";
import SOURCE from "./VacantPane.vue?raw";

// The empty pane's picker (#625) is exercised through `useHostPicker` and
// `hostPicker`; these hold what no store test reaches: the markup a screen
// reader and a keyboard rely on, and the road from a chosen host up to App.vue
// (App.spec.ts takes it from there).

describe("VacantPane picker", () => {
	it("is a search box driving a list of options, the lit one named to assistive tech", () => {
		expect(SOURCE).toMatch(/<label :for="inputId"[^>]*>Search hosts and terminals<\/label>/);
		expect(SOURCE).toContain('role="combobox"');
		expect(SOURCE).toContain(':aria-activedescendant="activeDomId"');
		expect(SOURCE).toContain('role="listbox"');
		expect(SOURCE).toContain('role="option"');
		expect(SOURCE).toContain('@keydown="picker.onKeydown"');
	});

	it("takes the focus when it appears", () => {
		expect(SOURCE).toMatch(/onMounted\([\s\S]*?inputRef\.value\?\.focus\(/);
	});

	it("keeps the focus in the search when a row is clicked, so Esc still reaches it", () => {
		const options = SOURCE.match(/role="option"[\s\S]*?@click=/g) ?? [];
		expect(options.length).toBeGreaterThanOrEqual(3);
		for (const option of options) expect(option).toContain("@mousedown.prevent");
	});

	it("closes the pane with a quiet button, not a red one", () => {
		expect(SOURCE).toMatch(
			/<button type="button" class="picker-close"[^>]*>\s*Close pane\s*<\/button>/,
		);
		expect(SOURCE).not.toContain("--nt-danger");
	});

	it("draws host rows with the shared row, and colours only from the theme", () => {
		expect(SOURCE).toContain("<HostPickRow");
		expect(PALETTE).toContain("<HostPickRow");
		const styles = SOURCE.slice(SOURCE.indexOf("<style"));
		expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(styles).not.toMatch(/rgba?\(\s*\d/);
	});

	it("hands the chosen host up with the pane, and the add-host form", () => {
		expect(SOURCE).toContain('emit("new-terminal", props.vacantId, hostId)');
		expect(PANE_LAYOUT).toContain(
			"@new-terminal=\"(vId: string, hId: string) => emit('new-terminal-vacant', vId, hId)\"",
		);
		expect(PANE_LAYOUT.match(/@add-host="emit\('add-host'\)"/g)).toHaveLength(3);
	});
});

describe("CommandPalette host rows (#625)", () => {
	it("passes Shift on, which only switches to a host", () => {
		expect(PALETTE).toContain("palette.executeSelected({ switchOnly: e.shiftKey })");
		expect(PALETTE).toContain("palette.execute(row.item, { switchOnly: e.shiftKey })");
	});
});
