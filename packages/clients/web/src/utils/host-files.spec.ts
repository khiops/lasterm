/**
 * The hub's files routes as the panel asks them (#832, #836): what a listing's entries become in
 * the client, through `listHostFiles` and the hub's answer.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("./hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));
vi.mock("./hub-url.js", () => ({ hubBaseUrl: () => "https://127.0.0.1:4100" }));

import { listHostFiles } from "./host-files.js";

const CHANNEL = "01ARZ3NDEKTSV4RRFFQ69G5FAA";

function answers(body: unknown): void {
	mocks.hubFetch.mockResolvedValue(
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

beforeEach(() => {
	setActivePinia(createPinia());
	mocks.hubFetch.mockReset();
});

describe("listHostFiles", () => {
	it("reads each entry's mode, null when the hub sends none", async () => {
		answers({
			path: "/home/pi",
			entries: [
				{ name: "src", kind: "directory", size: null, mtime: null, mode: 16877 },
				// What a hub without permissions answers: no mode at all.
				{ name: "notes.md", kind: "file", size: 10, mtime: null },
			],
			truncated: 0,
		});

		const answer = await listHostFiles(CHANNEL, "/home/pi", false);
		expect(answer).toEqual({
			ok: true,
			value: {
				path: "/home/pi",
				entries: [
					{
						name: "src",
						kind: "directory",
						size: null,
						mtime: null,
						mode: 16877,
						attributes: null,
						owner: null,
						group: null,
					},
					{
						name: "notes.md",
						kind: "file",
						size: 10,
						mtime: null,
						mode: null,
						attributes: null,
						owner: null,
						group: null,
					},
				],
				truncated: 0,
			},
		});
	});

	it("reads each entry's owner, group and attributes, null when the hub sends none", async () => {
		answers({
			path: "C:\\x",
			entries: [
				{
					name: "boot.ini",
					kind: "file",
					size: 1,
					mtime: null,
					mode: null,
					attributes: 33,
					owner: "o",
					group: "g",
				},
				// What a hub that lists without the agent answers: none of the three.
				{ name: "old.txt", kind: "file", size: 1, mtime: null, mode: null },
				{
					name: "odd.txt",
					kind: "file",
					size: 1,
					mtime: null,
					mode: null,
					attributes: "33",
					owner: 7,
					group: false,
				},
			],
			truncated: 0,
		});
		const answer = await listHostFiles(CHANNEL, "C:\\x", false);
		if (!answer.ok) throw new Error(answer.message);
		expect(
			answer.value.entries.map(({ name, attributes, owner, group }) => ({
				name,
				attributes,
				owner,
				group,
			})),
		).toEqual([
			{ name: "boot.ini", attributes: 33, owner: "o", group: "g" },
			{ name: "old.txt", attributes: null, owner: null, group: null },
			{ name: "odd.txt", attributes: null, owner: null, group: null },
		]);
	});
});
