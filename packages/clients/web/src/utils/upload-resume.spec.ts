/**
 * Reading an upload's files again after a restart (#837): read access asked of every kept root
 * inside the click (never decided from `queryPermission`), and bounded; each file read afresh
 * through its root and compared with the size and `lastModified` kept when it was sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeptItem, KeptUpload } from "./upload-handles.js";
import { askReadAccess, findKeptFiles } from "./upload-resume.js";

const T = "01ARZ3NDEKTSV4RRFFQ69G5FT1";
const WHEN = 1_700_000_000_000;

function domError(name: string): Error {
	return Object.assign(new Error(name), { name });
}

/** A handle whose `requestPermission` answers `answer` (a promise that never settles: null). */
function asking(answer: string | null | Error) {
	const requestPermission = vi.fn(() =>
		answer === null
			? new Promise<string>(() => undefined)
			: answer instanceof Error
				? Promise.reject(answer)
				: Promise.resolve(answer),
	);
	const queryPermission = vi.fn(async () => "prompt");
	return { requestPermission, queryPermission };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("asking read access", () => {
	it("asks every root before anything is awaited, and never asks queryPermission", async () => {
		const a = asking("granted");
		const b = asking("granted");
		const answer = askReadAccess([{ handle: a }, { handle: b }]);
		// Both asked in the same turn as the click: its activation still holds.
		expect(a.requestPermission).toHaveBeenCalledWith({ mode: "read" });
		expect(b.requestPermission).toHaveBeenCalledWith({ mode: "read" });
		expect(await answer).toBe("granted");
		expect(a.queryPermission).not.toHaveBeenCalled();
		expect(b.queryPermission).not.toHaveBeenCalled();
	});

	it("is denied when one root is refused, or its request fails", async () => {
		expect(await askReadAccess([{ handle: asking("granted") }, { handle: asking("denied") }])).toBe(
			"denied",
		);
		expect(await askReadAccess([{ handle: asking(domError("SecurityError")) }])).toBe("denied");
		const throwing = {
			requestPermission: () => {
				throw domError("SecurityError");
			},
		};
		expect(await askReadAccess([{ handle: throwing }])).toBe("denied");
	});

	it("gives up on a request nobody answers, past its bound", async () => {
		vi.useFakeTimers();
		const answer = askReadAccess([{ handle: asking("granted") }, { handle: asking(null) }], 15_000);
		await vi.advanceTimersByTimeAsync(14_999);
		let settled = false;
		void answer.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await answer).toBe("timeout");
	});

	it("says a root without a handle that can be asked cannot be read again", async () => {
		expect(await askReadAccess([])).toBe("unsupported");
		expect(await askReadAccess([{ handle: null }])).toBe("unsupported");
		expect(await askReadAccess([{ handle: { kind: "file" } }])).toBe("unsupported");
	});
});

// ─── Files under a kept folder ───────────────────────────────────────────────

type Tree = { [name: string]: Tree | File | Error | "pending" };

function file(name: string, size: number, lastModified = WHEN): File {
	return new File([new Uint8Array(size)], name, { lastModified });
}

/** A folder handle over `tree`: a File is a file, an Error fails its getFile, "pending" never answers. */
function folder(name: string, tree: Tree) {
	return {
		kind: "directory" as const,
		name,
		getDirectoryHandle: async (child: string) => {
			const node = tree[child];
			if (node === undefined) throw domError("NotFoundError");
			if (node instanceof File || node instanceof Error || node === "pending")
				throw domError("TypeMismatchError");
			return folder(child, node);
		},
		getFileHandle: async (child: string) => {
			const node = tree[child];
			if (node === undefined) throw domError("NotFoundError");
			if (!(node instanceof File) && !(node instanceof Error) && node !== "pending")
				throw domError("TypeMismatchError");
			return {
				kind: "file" as const,
				name: child,
				getFile: () =>
					node === "pending"
						? new Promise<File>(() => undefined)
						: node instanceof Error
							? Promise.reject(node)
							: Promise.resolve(node),
			};
		},
	};
}

function keptItem(itemId: number, relPath: string, size: number, root = 0): KeptItem {
	return {
		transferId: T,
		itemId,
		relPath,
		root,
		pathInRoot: relPath.includes("/") ? relPath.slice(relPath.indexOf("/") + 1) : "",
		size,
		lastModified: WHEN,
	};
}

describe("reading the files again", () => {
	it("finds each file under its root, as sent, changed, gone or unreadable", async () => {
		const photos = folder("photos", {
			"same.jpg": file("same.jpg", 10),
			"grown.jpg": file("grown.jpg", 12),
			"touched.jpg": file("touched.jpg", 10, WHEN + 1_000),
			"locked.jpg": domError("NotReadableError"),
			sub: { "deep.jpg": file("deep.jpg", 5) },
		});
		const notes = {
			kind: "file" as const,
			name: "notes.md",
			getFile: async () => file("notes.md", 3),
		};
		const upload: KeptUpload = {
			transferId: T,
			hostId: "h",
			channelId: "c",
			dir: "/srv",
			savedAt: WHEN,
			roots: [
				{ name: "photos", kind: "directory", handle: photos },
				{ name: "notes.md", kind: "file", handle: notes },
			],
		};
		const items = [
			keptItem(1, "photos/same.jpg", 10),
			keptItem(2, "photos/grown.jpg", 10),
			keptItem(3, "photos/touched.jpg", 10),
			keptItem(4, "photos/gone.jpg", 10),
			keptItem(5, "photos/locked.jpg", 10),
			keptItem(6, "photos/sub/deep.jpg", 5),
			keptItem(7, "photos/gone/deeper.jpg", 5),
			keptItem(8, "notes.md", 3, 1),
		];
		const found = await findKeptFiles({ upload, items }, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(found.same.map((f) => f.itemId)).toEqual([1, 6, 8]);
		expect(found.same.find((f) => f.itemId === 6)?.file.name).toBe("deep.jpg");
		expect(found.changed).toEqual([
			expect.objectContaining({
				itemId: 2,
				relPath: "photos/grown.jpg",
				was: { size: 10, lastModified: WHEN },
			}),
			expect.objectContaining({ itemId: 3, relPath: "photos/touched.jpg" }),
		]);
		expect(found.changed[0]?.file.size).toBe(12);
		expect(found.changed[1]?.file.lastModified).toBe(WHEN + 1_000);
		expect(found.gone).toEqual([4, 7]);
		expect(found.unreadable).toEqual([5]);
		// Nothing was kept of it: only a drop can give it again.
		expect(found.unknown).toEqual([9]);
	});

	it("takes a file that does not answer in time as unreadable", async () => {
		vi.useFakeTimers();
		const upload: KeptUpload = {
			transferId: T,
			hostId: "h",
			channelId: "c",
			dir: "/srv",
			savedAt: WHEN,
			roots: [{ name: "d", kind: "directory", handle: folder("d", { "slow.bin": "pending" }) }],
		};
		const found = findKeptFiles({ upload, items: [keptItem(1, "d/slow.bin", 1)] }, [1], 5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await found).unreadable).toEqual([1]);
	});
});
