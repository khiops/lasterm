import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResizable } from "./useResizable.js";

function fireMouseEvent(type: string, clientX: number): void {
	const event = new MouseEvent(type, { clientX, bubbles: true });
	document.dispatchEvent(event);
}

describe("useResizable", () => {
	beforeEach(() => {
		// Reset body styles
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
	});

	afterEach(() => {
		// Clean up any stray listeners by firing mouseup
		fireMouseEvent("mouseup", 0);
	});

	it("initializes with given width and not collapsed", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		expect(r.width.value).toBe(200);
		expect(r.collapsed.value).toBe(false);
	});

	it("expands width on drag right", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 250);
		expect(r.width.value).toBe(250);
		fireMouseEvent("mouseup", 250);
	});

	it("shrinks width on drag left", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 160);
		expect(r.width.value).toBe(160);
		fireMouseEvent("mouseup", 160);
	});

	it("clamps to minWidth", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 50); // 200 + (50 - 200) = 50, clamped to 140
		expect(r.width.value).toBe(140);
		fireMouseEvent("mouseup", 50);
	});

	it("clamps to maxWidth", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 700); // 200 + (700 - 200) = 700, clamped to 400
		expect(r.width.value).toBe(400);
		fireMouseEvent("mouseup", 700);
	});

	it("reads a maxWidth given as a function at each move", () => {
		let max = 400;
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: () => max });
		r.onMouseDown(new MouseEvent("mousedown", { clientX: 200, bubbles: true }));
		fireMouseEvent("mousemove", 700);
		expect(r.width.value).toBe(400);
		max = 600;
		fireMouseEvent("mousemove", 700);
		expect(r.width.value).toBe(600);
		fireMouseEvent("mouseup", 700);
	});

	it("starts a drag from the width it shows, when the one it holds is over the maximum", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: () => 300 });
		r.width.value = 900;
		r.onMouseDown(new MouseEvent("mousedown", { clientX: 200, bubbles: true }));
		fireMouseEvent("mousemove", 190); // 300 - 10
		expect(r.width.value).toBe(290);
		fireMouseEvent("mouseup", 190);
	});

	it("collapses when below collapseThreshold", () => {
		const r = useResizable({
			initialWidth: 200,
			minWidth: 140,
			maxWidth: 400,
			collapseThreshold: 80,
		});
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 60); // newWidth = 200 + (60 - 200) = 60 < 80 → collapse
		expect(r.collapsed.value).toBe(true);
		expect(r.width.value).toBe(0);
		fireMouseEvent("mouseup", 60);
	});

	it("un-collapses when dragged back above threshold", () => {
		const r = useResizable({
			initialWidth: 200,
			minWidth: 140,
			maxWidth: 400,
			collapseThreshold: 80,
		});
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 60); // collapse
		expect(r.collapsed.value).toBe(true);
		fireMouseEvent("mouseup", 60);

		// New drag from current startWidth = initialWidth (200) since collapsed
		const e2 = new MouseEvent("mousedown", { clientX: 60, bubbles: true });
		r.onMouseDown(e2);
		fireMouseEvent("mousemove", 220); // startWidth=200, delta=160 → 360 > 80 → un-collapse
		expect(r.collapsed.value).toBe(false);
		expect(r.width.value).toBe(360);
		fireMouseEvent("mouseup", 220);
	});

	it("calls onResizeEnd with final width on mouseup", () => {
		const onResizeEnd = vi.fn();
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400, onResizeEnd });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 300);
		fireMouseEvent("mouseup", 300);
		expect(onResizeEnd).toHaveBeenCalledOnce();
		expect(onResizeEnd).toHaveBeenCalledWith(300);
	});

	it("sets body userSelect and cursor during drag, clears after", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		expect(document.body.style.userSelect).toBe("none");
		expect(document.body.style.cursor).toBe("col-resize");
		fireMouseEvent("mouseup", 200);
		expect(document.body.style.userSelect).toBe("");
		expect(document.body.style.cursor).toBe("");
	});

	it("reset restores initialWidth and collapsed=false", () => {
		const r = useResizable({
			initialWidth: 200,
			minWidth: 140,
			maxWidth: 400,
			collapseThreshold: 80,
		});
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 60);
		fireMouseEvent("mouseup", 60);
		expect(r.collapsed.value).toBe(true);

		r.reset();
		expect(r.width.value).toBe(200);
		expect(r.collapsed.value).toBe(false);
	});

	it("does not process moves after mouseup (listeners removed)", () => {
		const r = useResizable({ initialWidth: 200, minWidth: 140, maxWidth: 400 });
		const e = new MouseEvent("mousedown", { clientX: 200, bubbles: true });
		r.onMouseDown(e);
		fireMouseEvent("mousemove", 300);
		expect(r.width.value).toBe(300);
		fireMouseEvent("mouseup", 300);
		fireMouseEvent("mousemove", 350); // should be ignored
		expect(r.width.value).toBe(300);
	});
});
