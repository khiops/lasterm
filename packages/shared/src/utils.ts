// Utility helpers for lasterm packages
import { ulid } from "ulid";

/**
 * Generate a new ULID-based ID (sortable, URL-safe, no UUID).
 */
export function generateId(): string {
	return ulid();
}

/**
 * Returns true if val is a plain object (not null, not array, not Uint8Array).
 * Used by both codec and config merge logic.
 */
export function isPlainObject(val: unknown): val is Record<string, unknown> {
	return (
		typeof val === "object" && val !== null && !Array.isArray(val) && !(val instanceof Uint8Array)
	);
}
