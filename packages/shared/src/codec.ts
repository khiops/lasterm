// MessagePack encode/decode + snake_case ↔ camelCase conversion
//
// Wire format (MessagePack): snake_case keys
// TypeScript interfaces: camelCase keys
// Uint8Array fields pass through unconverted.

import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import type { ProtocolMessage } from "./protocol.js";
import { isPlainObject } from "./utils.js";

// ---------------------------------------------------------------------------
// Key conversion helpers
// ---------------------------------------------------------------------------

/** Convert a single camelCase key to snake_case. */
function camelToSnake(key: string): string {
	return key.replace(/([A-Z])/g, (match) => `_${match.toLowerCase()}`);
}

/** Convert a single snake_case key to camelCase. */
function snakeToCamel(key: string): string {
	return key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

/** Recursively convert all object keys from camelCase to snake_case. */
/** Keys whose values are maps with user-defined keys (not protocol fields). */
const RAW_VALUE_KEYS = new Set(["env"]);

export function toSnakeCase(value: unknown, rawValue = false): unknown {
	if (value instanceof Uint8Array) return value;
	if (Array.isArray(value)) return value.map((v) => toSnakeCase(v, false));
	if (isPlainObject(value)) {
		if (rawValue) return value; // preserve user-defined keys as-is
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const snakeKey = camelToSnake(k);
			out[snakeKey] = toSnakeCase(v, RAW_VALUE_KEYS.has(snakeKey));
		}
		return out;
	}
	return value;
}

/** Recursively convert all object keys from snake_case to camelCase. */
export function toCamelCase(value: unknown, rawValue = false): unknown {
	if (value instanceof Uint8Array) return value;
	if (Array.isArray(value)) return value.map((v) => toCamelCase(v, false));
	if (isPlainObject(value)) {
		if (rawValue) return value; // preserve user-defined keys as-is
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const camelKey = snakeToCamel(k);
			out[camelKey] = toCamelCase(v, RAW_VALUE_KEYS.has(k));
		}
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Encode a protocol message to MessagePack bytes.
 * Converts camelCase TypeScript fields → snake_case wire format.
 */
export function encodeMessage(message: ProtocolMessage): Uint8Array<ArrayBuffer> {
	const wireObject = toSnakeCase(message);
	return msgpackEncode(wireObject, { useBigInt64: false });
}

/**
 * Decode MessagePack bytes to a protocol message.
 * Converts snake_case wire format → camelCase TypeScript fields.
 *
 * The `type` field on the wire is expected to be an uppercase string
 * (e.g. "SPAWN_OK") and is NOT converted by snake→camel — it matches
 * the discriminant in the TypeScript union types exactly.
 */
export function decodeMessage(data: Uint8Array): ProtocolMessage {
	const raw = msgpackDecode(data, { useBigInt64: false });
	const converted = toCamelCase(raw) as Record<string, unknown>;

	// The `type` discriminant uses UPPER_SNAKE_CASE on the wire and in TypeScript —
	// snake→camel would corrupt it (e.g. "SPAWN_OK" → "spawnOk").
	// We restore it from the raw decoded object before the camelCase pass corrupted it.
	// Actually, our snakeToCamel only converts _lowercase letters, so "SPAWN_OK"
	// does NOT get transformed (the _ is followed by 'O', uppercase, not matched).
	// Verify: SPAWN_OK → snakeToCamel replaces /_([a-z])/ only → stays "SPAWN_OK" ✓

	return converted as unknown as ProtocolMessage;
}
