import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSearchHistory } from "./useSearchHistory.js";

// ─── Mock localStorage ──────────────────────────────────────────────────────

const storage = new Map<string, string>();

const localStorageMock = {
	getItem: vi.fn((key: string) => storage.get(key) ?? null),
	setItem: vi.fn((key: string, value: string) => {
		storage.set(key, value);
	}),
	removeItem: vi.fn((key: string) => {
		storage.delete(key);
	}),
};

Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useSearchHistory", () => {
	beforeEach(() => {
		storage.clear();
		vi.clearAllMocks();
	});

	it("starts with empty history when localStorage is empty", () => {
		const { history } = useSearchHistory();
		expect(history.value).toEqual([]);
	});

	it("adds an entry to empty history", () => {
		const { history, add } = useSearchHistory();
		add("hello", false);
		expect(history.value).toEqual([{ query: "hello", regex: false }]);
	});

	it("maintains MRU order (newest first)", () => {
		const { history, add } = useSearchHistory();
		add("first", false);
		add("second", false);
		add("third", false);
		expect(history.value[0]?.query).toBe("third");
		expect(history.value[1]?.query).toBe("second");
		expect(history.value[2]?.query).toBe("first");
	});

	it("deduplicates: same query+regex moves to top without duplicates", () => {
		const { history, add } = useSearchHistory();
		add("alpha", false);
		add("beta", false);
		add("alpha", false);
		expect(history.value).toHaveLength(2);
		expect(history.value[0]).toEqual({ query: "alpha", regex: false });
		expect(history.value[1]).toEqual({ query: "beta", regex: false });
	});

	it("treats same query with different regex state as distinct entries", () => {
		const { history, add } = useSearchHistory();
		add("pattern", false);
		add("pattern", true);
		expect(history.value).toHaveLength(2);
		expect(history.value[0]).toEqual({ query: "pattern", regex: true });
		expect(history.value[1]).toEqual({ query: "pattern", regex: false });
	});

	it("caps at maxSize (default 20)", () => {
		const { history, add } = useSearchHistory();
		for (let i = 0; i < 25; i++) {
			add(`query-${i}`, false);
		}
		expect(history.value).toHaveLength(20);
		expect(history.value[0]?.query).toBe("query-24");
	});

	it("caps at custom maxSize", () => {
		const { history, add } = useSearchHistory(5);
		for (let i = 0; i < 10; i++) {
			add(`q-${i}`, false);
		}
		expect(history.value).toHaveLength(5);
		expect(history.value[0]?.query).toBe("q-9");
		expect(history.value[4]?.query).toBe("q-5");
	});

	it("ignores empty query", () => {
		const { history, add } = useSearchHistory();
		add("", false);
		expect(history.value).toHaveLength(0);
	});

	it("ignores whitespace-only query", () => {
		const { history, add } = useSearchHistory();
		add("   ", false);
		expect(history.value).toHaveLength(0);
	});

	it("preserves regex badge state", () => {
		const { history, add } = useSearchHistory();
		add("foo.*bar", true);
		expect(history.value[0]).toEqual({ query: "foo.*bar", regex: true });
	});

	it("clear() removes all entries and localStorage key", () => {
		const { history, add, clear } = useSearchHistory();
		add("one", false);
		add("two", true);
		clear();
		expect(history.value).toEqual([]);
		expect(localStorageMock.removeItem).toHaveBeenCalledWith("lasterm:search-history");
	});

	it("loads from localStorage on init", () => {
		const entries = [
			{ query: "saved", regex: false },
			{ query: "another", regex: true },
		];
		storage.set("lasterm:search-history", JSON.stringify(entries));

		const { history } = useSearchHistory();
		expect(history.value).toEqual(entries);
	});

	it("returns empty array for invalid localStorage data", () => {
		storage.set("lasterm:search-history", "not-valid-json{{{");

		const { history } = useSearchHistory();
		expect(history.value).toEqual([]);
	});

	it("persists to localStorage on add", () => {
		const { add } = useSearchHistory();
		add("persist-me", false);
		expect(localStorageMock.setItem).toHaveBeenCalledWith(
			"lasterm:search-history",
			expect.any(String),
		);
		const stored = JSON.parse(storage.get("lasterm:search-history") ?? "[]");
		expect(stored).toEqual([{ query: "persist-me", regex: false }]);
	});
});
