import { downloadRename } from "@lasterm/shared";
import { useAuthStore } from "../stores/auth.js";
import { useToastStore } from "../stores/toast.js";
import type { DesktopBridge } from "./desktop-uploads.js";
import { hubUnreachable } from "./hub-answer.js";
import { hubFetch } from "./hub-fetch.js";
import { hubBaseUrl } from "./hub-url.js";
import { isTauriRuntime } from "./tauri-runtime.js";

/**
 * Downloading one file of a terminal's host (#840, phase A). The desktop asks
 * where with its native dialog and writes the bytes itself; the page hears how
 * far it got and how it ended, in a toast. A browser hands an ordinary download
 * of a ticketed URL to its own download manager: the URL carries the ticket,
 * never the bearer.
 */

export const PICK_TARGET_COMMAND = "pick_download_target";
export const DOWNLOAD_COMMAND = "download_hub_file_to";
export const CANCEL_COMMAND = "cancel_hub_download";
export const REVEAL_COMMAND = "reveal_downloaded";
export const PROGRESS_EVENT = "download-progress";
export const ENDED_EVENT = "download-ended";

/** What a download needs of the file. */
export interface DownloadFile {
	readonly channelId: string;
	/** The terminal's host: the desktop fetches by host, so closing the terminal breaks nothing. */
	readonly hostId: string | null;
	readonly path: string;
	readonly name: string;
	/** The browser's or desktop's system, for the default name the dialog shows. */
	readonly windows: boolean;
}

/** How a download went, said once it is known. */
export type DownloadStart =
	| { readonly kind: "started" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed"; readonly message: string };

async function tauriBridge(): Promise<DesktopBridge> {
	const [{ invoke }, { listen }] = await Promise.all([
		import("@tauri-apps/api/core"),
		import("@tauri-apps/api/event"),
	]);
	return {
		invoke: (command, args) => invoke(command, args),
		listen: (event, handler) => listen(event, (e) => handler(e.payload)),
	};
}

function contentPath(channelId: string, query: string): string {
	return `/api/channels/${encodeURIComponent(channelId)}/files/content?${query}`;
}

/** "1.2 MB", "340 KB": a size as the progress line says it. */
function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** What the hub's refusal of a download says to the person. */
export function refusalText(code: string | null | undefined, name: string): string {
	switch (code) {
		case "LINK_NOT_FOLLOWED":
			return `${name} is a link; links are not followed`;
		case "NOT_FOUND":
			return `${name} is no longer there, or its name cannot be read back`;
		case "NOT_A_FILE":
			return `${name} is not a file`;
		case "PERMISSION_DENIED":
			return `${name} cannot be read: permission denied`;
		case "HOST_NOT_CONNECTED":
			return `${name} cannot be read: the host is not connected`;
		default:
			return `${name} could not be downloaded`;
	}
}

/** Start downloading `file`: the desktop's dialog and writer, or the browser's download manager. */
export async function downloadHostFile(
	file: DownloadFile,
	bridge?: () => Promise<DesktopBridge>,
): Promise<DownloadStart> {
	if (bridge !== undefined || isTauriRuntime())
		return downloadOnDesktop(file, bridge ?? tauriBridge);
	return downloadInBrowser(file);
}

async function downloadInBrowser(file: DownloadFile): Promise<DownloadStart> {
	const auth = useAuthStore();
	let ticket: string;
	try {
		const response = await hubFetch(
			`${hubBaseUrl()}/api/channels/${encodeURIComponent(file.channelId)}/files/content-ticket`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ path: file.path }),
			},
		);
		const body = (await response.json().catch(() => ({}))) as {
			ticket?: unknown;
			error?: { code?: unknown };
		};
		if (!response.ok || typeof body.ticket !== "string") {
			const code = typeof body.error?.code === "string" ? body.error.code : null;
			return { kind: "failed", message: refusalText(code, file.name) };
		}
		ticket = body.ticket;
	} catch (error) {
		return { kind: "failed", message: hubUnreachable(error) };
	}
	const anchor = document.createElement("a");
	anchor.href = `${hubBaseUrl()}${contentPath(file.channelId, `ticket=${encodeURIComponent(ticket)}`)}`;
	anchor.download = file.name;
	anchor.rel = "noopener";
	anchor.style.display = "none";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	return { kind: "started" };
}

let nextDownload = 1;

async function downloadOnDesktop(
	file: DownloadFile,
	bridgeOf: () => Promise<DesktopBridge>,
): Promise<DownloadStart> {
	if (file.hostId === null) {
		return { kind: "failed", message: refusalText("HOST_NOT_CONNECTED", file.name) };
	}
	const name = file.windows ? downloadRename(file.name) : file.name;
	let bridge: DesktopBridge;
	let target: { outcome: "cancelled" } | { outcome: "chosen"; root_id: string; name: string };
	try {
		bridge = await bridgeOf();
		target = (await bridge.invoke(PICK_TARGET_COMMAND, { name })) as typeof target;
	} catch (error) {
		return {
			kind: "failed",
			message: `The save dialog could not be shown: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (target.outcome !== "chosen") return { kind: "cancelled" };
	const downloadId = `d${Date.now().toString(36)}${nextDownload++}`;
	const itemId = "1";
	const toasts = useToastStore();
	let cancelled = false;
	const cancel = () => {
		cancelled = true;
		void bridge.invoke(CANCEL_COMMAND, { downloadId, itemId }).catch(() => {});
	};
	const toast = toasts.show("info", `Downloading ${target.name}`, null, {
		label: "Cancel",
		run: cancel,
	});
	const mine = (payload: unknown): payload is Record<string, unknown> =>
		(payload as { download_id?: unknown } | null)?.download_id === downloadId;
	const unlisten: Array<() => void> = [];
	const stop = () => {
		for (const off of unlisten.splice(0)) off();
	};
	unlisten.push(
		await bridge.listen(PROGRESS_EVENT, (payload) => {
			if (!mine(payload)) return;
			const written = Number(payload.written);
			const total = typeof payload.total === "number" ? payload.total : null;
			toasts.update(
				toast,
				total !== null && total > 0
					? `Downloading ${target.name} · ${Math.floor((written / total) * 100)} %`
					: `Downloading ${target.name} · ${sizeText(written)}`,
			);
		}),
	);
	unlisten.push(
		await bridge.listen(ENDED_EVENT, (payload) => {
			if (!mine(payload)) return;
			stop();
			toasts.dismiss(toast);
			if (payload.outcome === "done") {
				const saved = typeof payload.final_name === "string" ? payload.final_name : target.name;
				const left =
					typeof payload.kept_partial === "string"
						? ` (its partial ${payload.kept_partial} could not be removed)`
						: "";
				toasts.show("info", `Saved ${saved}${left}`, 8000, {
					label: "Show in folder",
					run: () => {
						void bridge
							.invoke(REVEAL_COMMAND, { rootId: target.root_id, relPath: saved })
							.catch(() => {});
					},
				});
			} else if (payload.outcome === "failed") {
				const code = typeof payload.code === "string" ? payload.code : null;
				const message =
					code !== null
						? refusalText(code, target.name)
						: typeof payload.error === "string"
							? payload.error
							: refusalText(null, target.name);
				toasts.show("error", message, 10000);
			}
		}),
	);
	if (cancelled) {
		stop();
		toasts.dismiss(toast);
		return { kind: "cancelled" };
	}
	const port = Number(new URL(hubBaseUrl(), window.location.href).port || 443);
	try {
		await bridge.invoke(DOWNLOAD_COMMAND, {
			request: {
				download_id: downloadId,
				item_id: itemId,
				root_id: target.root_id,
				rel_path: target.name,
				host_id: file.hostId,
				path: file.path,
				port,
			},
		});
	} catch (error) {
		stop();
		toasts.dismiss(toast);
		return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
	}
	// A Cancel before the shell held the job found nothing to stop: ask again now.
	if (cancelled) cancel();
	return { kind: "started" };
}
