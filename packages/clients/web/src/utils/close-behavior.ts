import { isTauriRuntime } from "./hub-url.js";

export const CLOSE_BEHAVIORS = ["ask", "hide", "quit"] as const;

export type CloseBehavior = (typeof CLOSE_BEHAVIORS)[number];
export type CloseAction = "modal" | "hide" | "quit";
export interface CloseBehaviorOption {
	disabled?: boolean;
	label: string;
	value: CloseBehavior;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type WriteCloseBehavior = (behavior: CloseBehavior) => Promise<void>;

interface NativeCloseBehavior {
	behavior: unknown;
}

export function isCloseBehavior(value: unknown): value is CloseBehavior {
	return value === "ask" || value === "hide" || value === "quit";
}

export function normalizeCloseBehavior(value: unknown): CloseBehavior {
	return isCloseBehavior(value) ? value : "ask";
}

export function closeBehaviorOptionsForTray(
	trayAvailable: boolean,
	currentBehavior: CloseBehavior,
): CloseBehaviorOption[] {
	return [
		{ label: "Ask every time", value: "ask" },
		...(trayAvailable
			? [{ label: "Keep running in tray", value: "hide" } as const]
			: currentBehavior === "hide"
				? [
						{
							disabled: true,
							label: "Keep running in tray (unavailable)",
							value: "hide",
						} as const,
					]
				: []),
		{ label: "Quit completely", value: "quit" },
	];
}

async function getTauriInvoke(): Promise<Invoke | null> {
	if (!isTauriRuntime()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke as Invoke;
}

function nativeCloseBehavior(value: NativeCloseBehavior): CloseBehavior {
	return normalizeCloseBehavior(value.behavior);
}

/** Reads the desktop-owned close preference. A failed native read rejects. */
export async function readCloseBehavior(invokeOverride?: Invoke): Promise<CloseBehavior> {
	const invoke = invokeOverride ?? (await getTauriInvoke());
	if (!invoke) return "ask";
	const native = await invoke<NativeCloseBehavior>("get_close_behavior");
	return nativeCloseBehavior(native);
}

/** Writes directly to desktop-owned configuration; browser storage is never updated. */
export async function writeCloseBehavior(
	behavior: CloseBehavior,
	invokeOverride?: Invoke,
): Promise<void> {
	const invoke = invokeOverride ?? (await getTauriInvoke());
	if (!invoke) throw new Error("Close preference is only available in the desktop app.");
	await invoke("set_close_behavior", { behavior });
}

export function closeBehaviorWriteError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Close preference was not saved: ${message}`;
}

/**
 * Keeps a settings control on its persisted value when the native write fails.
 */
export async function saveCloseBehavior(
	previous: CloseBehavior,
	next: CloseBehavior,
	write: WriteCloseBehavior = writeCloseBehavior,
): Promise<{ behavior: CloseBehavior; error: string | null }> {
	try {
		await write(next);
		return { behavior: next, error: null };
	} catch (error) {
		return { behavior: previous, error: closeBehaviorWriteError(error) };
	}
}

export function resolveCloseAction(behavior: unknown): CloseAction {
	switch (normalizeCloseBehavior(behavior)) {
		case "hide":
			return "hide";
		case "quit":
			return "quit";
		case "ask":
			return "modal";
	}
}
