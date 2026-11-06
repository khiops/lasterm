/**
 * The hub's routes for a terminal's host files (#832, PROTOCOL.md § 6, Host Files), as the files
 * panel asks them (#836): a folder's listing, the folder it opens at, and a new folder. Answers
 * come back as values, never thrown: the panel shows each failure where it happened.
 */
import { useAuthStore } from "../stores/auth.js";
import type { FileEntryView } from "./files-panel.js";
import { hubUnreachable } from "./hub-answer.js";
import { hubFetch } from "./hub-fetch.js";
import { hubBaseUrl } from "./hub-url.js";

/** A folder's listing, as the panel reads it. */
export interface FileListingView {
	readonly path: string;
	readonly entries: readonly FileEntryView[];
	/** How many more entries the folder holds than the hub sent. */
	readonly truncated: number;
	/** Only for a listing asked without a path: which folder the hub opened at. */
	readonly start?: "fallback" | "home";
	/** With `start: "home"`, when a fallback folder is set but cannot be opened: why. */
	readonly fallbackProblem?: string;
}

/** What a request answered: its value, or why not, with the hub's code when it gave one. */
export type FilesAnswer<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** The code of an answer that never reached the hub. */
export const HUB_UNREACHABLE = "HUB_UNREACHABLE";

function channelUrl(channelId: string, route: string): string {
	return `${hubBaseUrl()}/api/channels/${encodeURIComponent(channelId)}${route}`;
}

async function refusal(response: Response): Promise<{ ok: false; code: string; message: string }> {
	try {
		const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
		const code = typeof body.error?.code === "string" ? body.error.code : `HTTP_${response.status}`;
		const message =
			typeof body.error?.message === "string"
				? body.error.message
				: `The hub answered ${response.status}`;
		return { ok: false, code, message };
	} catch {
		return {
			ok: false,
			code: `HTTP_${response.status}`,
			message: `The hub answered ${response.status}`,
		};
	}
}

function entryOf(raw: Record<string, unknown>): FileEntryView | null {
	const { name, kind, size, mtime } = raw;
	if (typeof name !== "string") return null;
	if (kind !== "file" && kind !== "directory" && kind !== "symlink" && kind !== "other")
		return null;
	const linkKind = raw.link_kind;
	return {
		name,
		kind,
		size: typeof size === "number" ? size : null,
		mtime: typeof mtime === "string" ? mtime : null,
		...(typeof raw.link_target === "string" ? { linkTarget: raw.link_target } : {}),
		...(linkKind === "file" ||
		linkKind === "directory" ||
		linkKind === "other" ||
		linkKind === "missing"
			? { linkKind }
			: {}),
	};
}

/**
 * The entries of the folder `path` on the terminal's host, hidden ones too when `hidden`; without
 * a path, the folder the panel opens at when the terminal's own is unknown: its host's fallback
 * folder, its variables expanded there, else the home (#836).
 */
export async function listHostFiles(
	channelId: string,
	path: string | undefined,
	hidden: boolean,
): Promise<FilesAnswer<FileListingView>> {
	const query = new URLSearchParams();
	if (path !== undefined) query.set("path", path);
	if (hidden) query.set("hidden", "1");
	const qs = query.toString();
	try {
		const response = await hubFetch(channelUrl(channelId, `/files${qs ? `?${qs}` : ""}`), {
			headers: { Authorization: `Bearer ${useAuthStore().token}` },
		});
		if (!response.ok) return refusal(response);
		const body = (await response.json()) as Record<string, unknown>;
		const entries = Array.isArray(body.entries)
			? body.entries
					.map((entry) => entryOf((entry ?? {}) as Record<string, unknown>))
					.filter((entry): entry is FileEntryView => entry !== null)
			: [];
		return {
			ok: true,
			value: {
				path: typeof body.path === "string" ? body.path : (path ?? ""),
				entries,
				truncated: typeof body.truncated === "number" ? body.truncated : 0,
				...(body.start === "fallback" || body.start === "home" ? { start: body.start } : {}),
				...(typeof body.fallback_problem === "string"
					? { fallbackProblem: body.fallback_problem }
					: {}),
			},
		};
	} catch (error) {
		return { ok: false, code: HUB_UNREACHABLE, message: hubUnreachable(error) };
	}
}

/**
 * Create the folder `path` on the terminal's host. Only the window holding the terminal's write
 * lock may: the request names this window, as its socket's AUTH_OK did (`X-Lasterm-Client-Id`).
 */
export async function createHostFolder(
	channelId: string,
	path: string,
): Promise<FilesAnswer<{ path: string }>> {
	const auth = useAuthStore();
	try {
		const response = await hubFetch(channelUrl(channelId, "/folders"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${auth.token}`,
				"Content-Type": "application/json",
				...(auth.clientId !== null ? { "X-Lasterm-Client-Id": auth.clientId } : {}),
			},
			body: JSON.stringify({ path }),
		});
		if (!response.ok) return refusal(response);
		const body = (await response.json()) as { path?: unknown };
		return { ok: true, value: { path: typeof body.path === "string" ? body.path : path } };
	} catch (error) {
		return { ok: false, code: HUB_UNREACHABLE, message: hubUnreachable(error) };
	}
}
