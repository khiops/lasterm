/** Whether this code is running inside the desktop webview rather than a browser. */
export function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
