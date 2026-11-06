import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useConfigStore } from "../stores/config.js";
import { useToastStore } from "../stores/toast.js";
import { type UploadTarget, useTransfersStore } from "../stores/transfers.js";
import { useWriteLockStore } from "../stores/writelock.js";
import {
	carriesFiles,
	type DropDecision,
	type DropTarget,
	dropDecision,
	dropRole,
} from "../utils/upload-drop.js";
import { type DropItemLike, readDrop } from "../utils/upload-walk.js";

/** Where a drop target sends what it takes. */
export interface UploadDropSpec {
	readonly kind: DropTarget;
	/** The terminal it is for; null for a pane still spawning. */
	readonly channelId: string | null;
	/** The pane it is, for a terminal target; its overlay and its confirmation show there. */
	readonly paneId: string | null;
	/** The folder, for the panel's list or a folder row; a terminal's is read when the drag comes. */
	readonly dir: string | null;
	/** A folder row's name, for what its highlight says. */
	readonly folder: string | null;
}

/**
 * A drop target for uploads (#837): a terminal pane's wrapper (PaneLayout.vue), the files
 * panel's list, a folder row. Each handler says whether it took the event: `dragover` and `drop`
 * are prevented only for a drag it takes, so that the cursor tells the truth, a refused one gets
 * `dropEffect = "none"`, and anything else is left to the page (pane moves, links, and the
 * guard of `utils/file-drop-guard.ts`, which refuses what nothing takes).
 *
 * The drop is read inside the drop event (`readDrop`): handles and entries are asked for there,
 * before any await.
 */
export function useUploadDrop(spec: () => UploadDropSpec): {
	decide: (event: DragEvent) => DropDecision;
	onDragEnter: (event: DragEvent) => boolean;
	onDragOver: (event: DragEvent) => boolean;
	onDragLeave: (event: DragEvent) => void;
	onDrop: (event: DragEvent) => boolean;
} {
	const transfers = useTransfersStore();
	const configStore = useConfigStore();
	const channelsStore = useChannelsStore();
	const writeLockStore = useWriteLockStore();
	const authStore = useAuthStore();

	/** The destination for this drag, read once when it comes over the target. */
	let destination: Promise<{ dir: string; origin: UploadTarget["origin"] } | null> | null = null;
	let resolved: { dir: string; origin: UploadTarget["origin"] } | null = null;
	let destinationFor: string | null = null;
	let decided: DropDecision = { kind: "ignore" };

	function decide(event: DragEvent): DropDecision {
		const s = spec();
		const channelId = s.channelId;
		const settings = channelId === null ? null : transfers.settingsFor(channelId);
		return dropDecision({
			target: s.kind,
			carriesFiles: carriesFiles(event.dataTransfer?.types),
			enabled: configStore.fileTransferEnabled,
			channelId:
				channelId !== null && channelsStore.channelHostMap.has(channelId) ? channelId : null,
			role: dropRole(
				channelId === null ? null : writeLockStore.locks.get(channelId)?.holder,
				authStore.clientId,
			),
			transferDrop: settings?.drop ?? "upload",
			ended:
				settings?.ended === true ||
				(channelId !== null && channelsStore.statusOf(channelId) === "dead"),
		});
	}

	function readDestination(): void {
		const s = spec();
		// A folder row of the panel's list under the pointer now, or none: another destination.
		if (destination !== null && destinationFor === s.folder) return;
		destinationFor = s.folder;
		resolved = null;
		if (s.dir !== null) {
			resolved = { dir: s.dir, origin: s.kind === "folder" ? "folder" : "panel" };
			destination = Promise.resolve(resolved);
			return;
		}
		if (s.channelId === null) return;
		destination = transfers.terminalDestination(s.channelId).then((found) => {
			resolved = found;
			showHover(decided, null);
			return found;
		});
	}

	function showHover(decision: DropDecision, count: number | null): void {
		const s = spec();
		if (decision.kind === "ignore" || s.channelId === null) return;
		const before = transfers.dropHover;
		transfers.setDropHover({
			paneId: s.paneId,
			channelId: s.channelId,
			place: s.kind === "terminal" ? "pane" : "panel",
			folder: s.folder,
			decision,
			count: count ?? before?.count ?? null,
			dir: resolved?.dir ?? null,
			origin:
				resolved?.origin ??
				(s.kind === "terminal" ? "terminal" : s.kind === "folder" ? "folder" : "panel"),
		});
	}

	function itemCount(event: DragEvent): number | null {
		const items = event.dataTransfer?.items;
		return items === undefined
			? null
			: Array.from(items).filter((item) => item.kind === "file").length;
	}

	function mine(): boolean {
		const hover = transfers.dropHover;
		const s = spec();
		return (
			hover !== null &&
			hover.paneId === s.paneId &&
			hover.folder === s.folder &&
			hover.channelId === s.channelId
		);
	}

	/** The hover is this target's, whichever of its folder rows it was over. */
	function ours(): boolean {
		const hover = transfers.dropHover;
		const s = spec();
		const place = s.kind === "terminal" ? "pane" : "panel";
		return (
			hover !== null &&
			hover.paneId === s.paneId &&
			hover.place === place &&
			hover.channelId === s.channelId
		);
	}

	function onDragEnter(event: DragEvent): boolean {
		decided = decide(event);
		if (decided.kind === "ignore") return false;
		if (decided.kind === "take") {
			event.preventDefault();
			readDestination();
		}
		showHover(decided, itemCount(event));
		return true;
	}

	function onDragOver(event: DragEvent): boolean {
		decided = decide(event);
		if (decided.kind === "ignore") return false;
		if (event.dataTransfer)
			event.dataTransfer.dropEffect = decided.kind === "take" ? "copy" : "none";
		if (decided.kind === "take") {
			event.preventDefault();
			readDestination();
		}
		if (!mine()) showHover(decided, itemCount(event));
		return true;
	}

	function onDragLeave(event: DragEvent): void {
		const element = event.currentTarget as HTMLElement | null;
		const related = event.relatedTarget as Node | null;
		if (element !== null && related !== null && element.contains(related)) return;
		// A drag let go here without a drop: a refused one offers what would allow it.
		if (element !== null && decided.kind === "refuse" && related === null) {
			const rect = element.getBoundingClientRect();
			const inside =
				event.clientX >= rect.left &&
				event.clientX <= rect.right &&
				event.clientY >= rect.top &&
				event.clientY <= rect.bottom;
			const s = spec();
			if (inside && s.channelId !== null)
				transfers.noteRefusal(s.paneId, s.channelId, decided.reason);
		}
		if (ours()) transfers.setDropHover(null);
		destination = null;
		resolved = null;
		decided = { kind: "ignore" };
	}

	function onDrop(event: DragEvent): boolean {
		const decision = decide(event);
		if (decision.kind === "ignore") return false;
		event.preventDefault();
		if (ours()) transfers.setDropHover(null);
		const s = spec();
		const channelId = s.channelId;
		if (decision.kind === "refuse") {
			if (channelId !== null) transfers.noteRefusal(s.paneId, channelId, decision.reason);
			return true;
		}
		const items = event.dataTransfer?.items;
		if (items === undefined || channelId === null) return true;
		// Inside the event: each item's handle and entry are asked for before any await.
		const roots = readDrop(items as unknown as ArrayLike<DropItemLike>);
		readDestination();
		const where = destination;
		destination = null;
		resolved = null;
		decided = { kind: "ignore" };
		void (async () => {
			const found = await where;
			const hostId = channelsStore.channelHostMap.get(channelId);
			if (found === null || found === undefined || hostId === undefined) {
				useToastStore().show(
					"error",
					"Nothing was uploaded: the folder to upload to could not be read on this terminal's host",
					8_000,
				);
				return;
			}
			const settings = transfers.settingsFor(channelId);
			await transfers.begin(
				{
					channelId,
					hostId,
					dir: found.dir,
					origin: found.origin,
					place: s.kind === "terminal" ? "pane" : "panel",
					paneId: s.paneId,
					onConflict: settings.onConflict,
					confirm: settings.confirmDrop,
				},
				await roots,
			);
		})();
		return true;
	}

	return { decide, onDragEnter, onDragOver, onDragLeave, onDrop };
}
