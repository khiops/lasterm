/**
 * What an environment editor shows: the variables this scope sets, and the
 * ones it only inherits.
 *
 * The cascade merges these key by key — global, then host, then channel — so a
 * scope's own map is rarely the whole story. Showing the inherited ones beside
 * it is what makes the editor readable: the effective environment is what the
 * terminal gets, not what this one scope happens to hold.
 */

/** One row of the editor, in the order the user will read them. */
export interface EnvironmentEntry {
	name: string;
	value: string;
}

/** Whatever the layer holds, as pairs this editor can show. */
export function toEntries(map: unknown): EnvironmentEntry[] {
	if (map === null || typeof map !== "object") return [];
	return Object.entries(map as Record<string, unknown>)
		.filter(([name, value]) => name !== "" && typeof value === "string")
		.map(([name, value]) => ({ name, value: value as string }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The rows back into a map, dropping the unnamed ones an empty row leaves.
 *
 * A name written twice keeps the last value: the editor shows what the map
 * will hold, and a map holds a name once.
 */
export function toMap(entries: EnvironmentEntry[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const entry of entries) {
		const name = entry.name.trim();
		if (name === "") continue;
		map[name] = entry.value;
	}
	return map;
}

/**
 * What the terminals of this scope will be given that this scope did not set.
 *
 * A name this scope sets is shown in the editor itself, with the value that
 * wins; what is left is what the scopes above it contribute.
 */
export function inheritedEntries(resolved: unknown, own: unknown): EnvironmentEntry[] {
	const ownMap = toMap(toEntries(own));
	return toEntries(resolved).filter((entry) => !(entry.name in ownMap));
}
