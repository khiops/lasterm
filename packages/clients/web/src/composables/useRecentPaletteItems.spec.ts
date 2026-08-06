import { beforeEach, describe, expect, it, vi } from "vitest";

// Provide localStorage stub for Node.js test environment
const storage = new Map<string, string>();
const localStorageMock: Storage = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => {
		storage.set(key, value);
	},
	removeItem: (key: string) => {
		storage.delete(key);
	},
	clear: () => {
		storage.clear();
	},
	get length() {
		return storage.size;
	},
	key: (index: number) => [...storage.keys()][index] ?? null,
};
vi.stubGlobal("localStorage", localStorageMock);

// Import AFTER stubbing localStorage
const { useRecentPaletteItems } = await import("./useRecentPaletteItems.js");

describe("useRecentPaletteItems", () => {
	beforeEach(() => {
		storage.clear();
		// Reset the module singleton by clearing through the composable API
		const { clearRecent } = useRecentPaletteItems();
		clearRecent();
	});

	it("starts with empty recent list after clear", () => {
		const { recentIds } = useRecentPaletteItems();
		expect(recentIds.value).toEqual([]);
	});

	it("pushRecent adds item to front", () => {
		const { recentIds, pushRecent } = useRecentPaletteItems();
		pushRecent("host:h1");
		pushRecent("host:h2");
		expect(recentIds.value[0]).toBe("host:h2");
		expect(recentIds.value[1]).toBe("host:h1");
	});

	it("SC-24: deduplicates by moving existing item to front", () => {
		const { recentIds, pushRecent } = useRecentPaletteItems();
		pushRecent("host:h1");
		pushRecent("host:h2");
		pushRecent("host:h1"); // already in list → moves to front
		expect(recentIds.value).toEqual(["host:h1", "host:h2"]);
	});

	it("limits to 8 items (INV-07)", () => {
		const { recentIds, pushRecent } = useRecentPaletteItems();
		for (let i = 0; i < 10; i++) {
			pushRecent(`host:h${i}`);
		}
		expect(recentIds.value).toHaveLength(8);
	});

	it("most-recently-used item is always first", () => {
		const { recentIds, pushRecent } = useRecentPaletteItems();
		pushRecent("host:h1");
		pushRecent("host:h2");
		pushRecent("host:h3");
		expect(recentIds.value[0]).toBe("host:h3");
	});

	it("clearRecent empties the list", () => {
		const { recentIds, pushRecent, clearRecent } = useRecentPaletteItems();
		pushRecent("host:h1");
		pushRecent("host:h2");
		clearRecent();
		expect(recentIds.value).toEqual([]);
	});

	it("persists to localStorage on pushRecent", () => {
		const { pushRecent } = useRecentPaletteItems();
		pushRecent("host:h1");
		const stored = JSON.parse(localStorage.getItem("lasterm:palette-recent") ?? "[]") as string[];
		expect(stored).toContain("host:h1");
	});

	it("SC-25: handles localStorage getItem failure gracefully", () => {
		vi.spyOn(localStorageMock, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		vi.spyOn(localStorageMock, "setItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});

		const { pushRecent, recentIds } = useRecentPaletteItems();
		// Should not throw
		expect(() => pushRecent("host:h1")).not.toThrow();
		// In-memory ref is updated even if localStorage fails
		expect(recentIds.value).toContain("host:h1");

		vi.restoreAllMocks();
	});

	it("SC-25: handles malformed localStorage JSON gracefully", () => {
		localStorage.setItem("lasterm:palette-recent", "not-valid-json{{");
		const { recentIds } = useRecentPaletteItems();
		// Should not throw, returns empty
		expect(Array.isArray(recentIds.value)).toBe(true);
	});
});
