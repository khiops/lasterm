/**
 * What the environment editor shows, and how an edit becomes the changes a
 * scope stores (#576).
 *
 * A scope stores only its changes to the environment its terminals start
 * with: a value sets a variable, `null` removes it. Never a snapshot of the
 * result — a variable that appears on the host later still reaches new
 * terminals unless a scope removed it, and nothing is copied from the host
 * into the hub's database except what the user typed. So "customized" is
 * something shown, not stored: the agent's variables for the mode, then the
 * outer scopes' changes, then this scope's.
 */

/** A scope's changes: a value sets the variable, `null` removes it. */
export type EnvChanges = Record<string, string | null>;

/** Where what a row shows comes from, before this scope changes anything. */
export type EnvSource = "agent" | "global" | "host";

/** The changes an outer scope makes, outermost first. */
export interface OuterChanges {
	scope: "global" | "host";
	changes: EnvChanges;
}

/**
 * One variable as the editor shows it:
 * - `inherited`: what a terminal gets from the agent or an outer scope,
 *   unchanged here;
 * - `changed`: this scope sets a value for a variable the terminal would
 *   otherwise get;
 * - `added`: this scope sets a variable the terminal would not otherwise get;
 * - `removed`: this scope removes it;
 * - `removed-above`: an outer scope removes it, and this one says nothing.
 */
export interface EnvironmentRow {
	name: string;
	/** What the terminal gets; for a removal, what it would have got. */
	value: string;
	state: "inherited" | "changed" | "added" | "removed" | "removed-above";
	/** Where the value, or the removal, comes from when this scope says nothing. */
	from: EnvSource | null;
	/** For `changed`: the value this scope replaces. */
	before?: string;
}

export interface ChangeCounts {
	removed: number;
	changed: number;
	added: number;
}

/**
 * A scope's changes as stored, keeping only what a variable can be: a string,
 * or `null` for a removal, under a name that is not empty. `profile_json` is
 * data, and an editor that throws on it is one nobody can use to fix it.
 */
export function readChanges(map: unknown): EnvChanges {
	if (map === null || typeof map !== "object" || Array.isArray(map)) return {};
	const changes: EnvChanges = {};
	for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
		if (name.trim() === "") continue;
		if (typeof value === "string" || value === null) changes[name] = value;
	}
	return changes;
}

/** The key a name is known by: on Windows, `Path` and `PATH` are one variable. */
function keyOf(name: string, ignoreCase: boolean): string {
	return ignoreCase ? name.toUpperCase() : name;
}

/** The name this map holds for the same variable, whatever its case where case does not count. */
function heldName(map: EnvChanges, name: string, ignoreCase: boolean): string[] {
	const key = keyOf(name, ignoreCase);
	return Object.keys(map).filter((held) => keyOf(held, ignoreCase) === key);
}

interface Entry {
	name: string;
	value: string;
	from: EnvSource;
}

/**
 * Every variable the editor has something to say about, in the order they
 * are read.
 *
 * `base` is what the agent reports for the mode, before any profile; `null`
 * when there is none to ask — the global scope, or a host that cannot be
 * reached — and the rows are then the scopes' changes alone.
 */
export function environmentRows(
	base: Record<string, string> | null,
	outer: readonly OuterChanges[],
	own: EnvChanges,
	ignoreCase: boolean,
): EnvironmentRow[] {
	const present = new Map<string, Entry>();
	const removedAbove = new Map<string, Entry>();

	for (const [name, value] of Object.entries(base ?? {})) {
		present.set(keyOf(name, ignoreCase), { name, value, from: "agent" });
	}
	for (const { scope, changes } of outer) {
		for (const [name, value] of Object.entries(changes)) {
			const key = keyOf(name, ignoreCase);
			const held = present.get(key) ?? removedAbove.get(key);
			if (value === null) {
				present.delete(key);
				removedAbove.set(key, { name: held?.name ?? name, value: held?.value ?? "", from: scope });
			} else {
				removedAbove.delete(key);
				present.set(key, { name: held?.name ?? name, value, from: scope });
			}
		}
	}

	const rows: EnvironmentRow[] = [];
	const ownByKey = new Map<string, { name: string; value: string | null }>();
	for (const [name, value] of Object.entries(own)) {
		ownByKey.set(keyOf(name, ignoreCase), { name, value });
	}

	for (const [key, entry] of present) {
		const change = ownByKey.get(key);
		ownByKey.delete(key);
		if (change === undefined) {
			rows.push({ name: entry.name, value: entry.value, state: "inherited", from: entry.from });
		} else if (change.value === null) {
			rows.push({ name: entry.name, value: entry.value, state: "removed", from: entry.from });
		} else {
			rows.push({
				name: entry.name,
				value: change.value,
				state: "changed",
				from: entry.from,
				before: entry.value,
			});
		}
	}
	for (const [key, entry] of removedAbove) {
		const change = ownByKey.get(key);
		ownByKey.delete(key);
		if (change === undefined) {
			rows.push({ name: entry.name, value: entry.value, state: "removed-above", from: entry.from });
		} else if (change.value === null) {
			rows.push({ name: entry.name, value: entry.value, state: "removed", from: entry.from });
		} else {
			rows.push({ name: change.name, value: change.value, state: "added", from: null });
		}
	}
	for (const { name, value } of ownByKey.values()) {
		rows.push(
			value === null
				? { name, value: "", state: "removed", from: null }
				: { name, value, state: "added", from: null },
		);
	}

	return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** How many variables this scope removes, changes and adds. */
export function changeCounts(rows: readonly EnvironmentRow[]): ChangeCounts {
	const counts: ChangeCounts = { removed: 0, changed: 0, added: 0 };
	for (const row of rows) {
		if (row.state === "removed") counts.removed++;
		else if (row.state === "changed") counts.changed++;
		else if (row.state === "added") counts.added++;
	}
	return counts;
}

/** "2 removed · 1 changed", or nothing when this scope changes nothing. */
export function describeCounts(counts: ChangeCounts): string {
	const parts: string[] = [];
	if (counts.removed > 0) parts.push(`${counts.removed} removed`);
	if (counts.changed > 0) parts.push(`${counts.changed} changed`);
	if (counts.added > 0) parts.push(`${counts.added} added`);
	return parts.join(" · ");
}

/** What the mode select says: the mode, and whether this scope changes it. */
export function modeLabel(mode: "inherit" | "minimal", customized: boolean): string {
	const name = mode === "minimal" ? "Minimal" : "Inherited";
	return customized ? `${name} (customized)` : name;
}

/** This scope's changes with `name` set to `value`. */
export function setVariable(
	own: EnvChanges,
	name: string,
	value: string,
	ignoreCase: boolean,
): EnvChanges {
	const trimmed = name.trim();
	if (trimmed === "") return own;
	const next = { ...own };
	for (const held of heldName(next, trimmed, ignoreCase)) delete next[held];
	next[trimmed] = value;
	return next;
}

/** This scope's changes with `name` removed from what its terminals start with. */
export function removeVariable(own: EnvChanges, name: string, ignoreCase: boolean): EnvChanges {
	const trimmed = name.trim();
	if (trimmed === "") return own;
	const next = { ...own };
	for (const held of heldName(next, trimmed, ignoreCase)) delete next[held];
	next[trimmed] = null;
	return next;
}

/** This scope's changes without any about `name`: the variable is as the outer scopes leave it. */
export function restoreVariable(own: EnvChanges, name: string, ignoreCase: boolean): EnvChanges {
	const next = { ...own };
	for (const held of heldName(next, name, ignoreCase)) delete next[held];
	return next;
}

/** This scope's changes with an added variable renamed, keeping its value. */
export function renameVariable(
	own: EnvChanges,
	from: string,
	to: string,
	value: string,
	ignoreCase: boolean,
): EnvChanges {
	return setVariable(restoreVariable(own, from, ignoreCase), to, value, ignoreCase);
}

/** The changes as the scope stores them: nothing at all when there are none. */
export function toStored(own: EnvChanges): EnvChanges | null {
	return Object.keys(own).length === 0 ? null : own;
}
