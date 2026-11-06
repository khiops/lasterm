/**
 * "Upload files…" and "Upload folder…" (#837): the File System Access pickers where the browser
 * has them (`showOpenFilePicker({ multiple: true })`, `showDirectoryPicker()`), whose handles a
 * resume can read again after a restart; an `<input type=file>` elsewhere (Firefox, Safari),
 * whose files nothing keeps. A picker waits for the person, so it is not bounded; a cancel gives
 * nothing.
 */
import {
	type DirectoryHandleLike,
	type FileHandleLike,
	rootFromDirectoryHandle,
	rootsFromFileHandles,
	rootsFromInputFiles,
	type UploadRoot,
} from "./upload-walk.js";

interface PickerWindow {
	showOpenFilePicker?: (options: { multiple: boolean }) => Promise<FileHandleLike[]>;
	showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<DirectoryHandleLike>;
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Files from an `<input type=file>`, `webkitdirectory` for a folder; empty when cancelled. */
function inputFiles(folder: boolean): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		if (folder) input.setAttribute("webkitdirectory", "");
		input.style.display = "none";
		const finish = (files: File[]) => {
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
		input.addEventListener("cancel", () => finish([]), { once: true });
		document.body.append(input);
		input.click();
	});
}

/** "Upload files…": the files picked, each a root with its handle where the browser gives one. */
export async function pickFiles(
	win: PickerWindow = window as unknown as PickerWindow,
): Promise<UploadRoot[]> {
	if (typeof win.showOpenFilePicker === "function") {
		try {
			return rootsFromFileHandles(await win.showOpenFilePicker({ multiple: true }));
		} catch (error) {
			if (isAbort(error)) return [];
			throw error;
		}
	}
	return rootsFromInputFiles(await inputFiles(false));
}

/** "Upload folder…": the folder picked, one handle for its whole tree where the browser gives one. */
export async function pickFolder(
	win: PickerWindow = window as unknown as PickerWindow,
): Promise<UploadRoot[]> {
	if (typeof win.showDirectoryPicker === "function") {
		try {
			return [rootFromDirectoryHandle(await win.showDirectoryPicker({ mode: "read" }))];
		} catch (error) {
			if (isAbort(error)) return [];
			throw error;
		}
	}
	return rootsFromInputFiles(await inputFiles(true));
}
