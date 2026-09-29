import type { Host } from "@lasterm/shared";
import type { HostStatus } from "../stores/hosts.js";
import { formatConnectionString } from "../utils/host-display.js";
import type { HostSection } from "./useHostGroups.js";

/**
 * The empty pane's host picker and the palette's host rows (#625), as data:
 * which hosts, in which order, under which heading, and what each row says.
 * No store and no Vue here, so every rule has a test of its own.
 */

/** Hosts under one heading, in the order the rail shows them. */
export interface RailSection {
	id: string;
	name: string;
	hosts: Host[];
}

/**
 * The rail's order: the local host first, then each group in its order, then
 * the hosts in none, under "Ungrouped". Sections with no host are left out.
 */
export function railSections(
	localHost: Host | null,
	sections: readonly HostSection[],
): RailSection[] {
	const out: RailSection[] = [];
	if (localHost !== null) out.push({ id: "local", name: "Local", hosts: [localHost] });
	for (const section of sections) {
		if (section.hosts.length === 0) continue;
		out.push(
			section.type === "group"
				? { id: `group:${section.id}`, name: section.name, hosts: section.hosts }
				: { id: "ungrouped", name: "Ungrouped", hosts: section.hosts },
		);
	}
	return out;
}

/**
 * Where the local host is. "Local" is relative to the hub, not to the client
 * looking at it: a paired client may be on another machine altogether.
 */
export const LOCAL_ADDRESS = "the hub's machine";

/** The host a jump spec names: `user@host:port`, or the last hop of a chain. */
function jumpSpecHost(spec: string): string {
	const hops = spec.split(",");
	const last = (hops[hops.length - 1] ?? spec).trim();
	const at = last.lastIndexOf("@");
	const rest = at === -1 ? last : last.slice(at + 1);
	if (rest.startsWith("[")) {
		const end = rest.indexOf("]");
		return end === -1 ? rest : rest.slice(1, end);
	}
	const colon = rest.indexOf(":");
	return colon === -1 ? rest : rest.slice(0, colon);
}

/** The host a connection goes through, by the name the user knows it by. */
function jumpName(host: Host, hosts: readonly Host[]): string | null {
	if (host.sshProxyHostId) {
		const jump = hosts.find((h) => h.id === host.sshProxyHostId);
		if (jump !== undefined) return jump.label;
	}
	if (host.sshProxySpec) {
		const name = jumpSpecHost(host.sshProxySpec);
		if (name !== "") return name;
	}
	return null;
}

/** A host's address as a row shows it: `user@host`, and "via <jump>" when it has one. */
export function hostAddress(host: Host, hosts: readonly Host[]): string {
	if (host.type === "local") return LOCAL_ADDRESS;
	const base = formatConnectionString(host);
	const jump = jumpName(host, hosts);
	if (jump === null) return base;
	return base === "" ? `via ${jump}` : `${base} via ${jump}`;
}

/** A host's status, in words. */
export function statusWord(status: HostStatus): string {
	switch (status) {
		case "live":
			return "Live";
		case "reconnecting":
			return "Reconnecting";
		case "offline":
			return "Offline";
		case "error":
			return "Error";
		case "disconnected":
			return "Disconnected";
	}
}

/** How a row's right-hand word is coloured. */
export type RowTone = "accent" | "live" | "warn" | "error" | "muted";

export interface RowAction {
	text: string;
	tone: RowTone;
}

/** The status word, coloured as the rail's dot is. */
export function statusAction(status: HostStatus): RowAction {
	switch (status) {
		case "live":
			return { text: "Live", tone: "live" };
		case "reconnecting":
			return { text: "Reconnecting", tone: "warn" };
		case "offline":
			return { text: "Offline", tone: "muted" };
		case "error":
			return { text: "Error", tone: "error" };
		case "disconnected":
			return { text: "Disconnected", tone: "muted" };
	}
}

/** What a picker row says on its right, and on a second line when it has one. */
export interface HostRowView {
	action: RowAction;
	note: string | null;
}

/**
 * What a host's row in the empty pane says.
 *
 * What is under way comes first: a terminal on its way ("Connecting…"), then
 * the reason the last attempt from this pane failed. Then this tab's host
 * offers a new terminal, and every other host says its status, as the verb
 * that opening it would be for a host that is not connected.
 */
export function hostRowView(row: {
	label: string;
	status: HostStatus;
	/** This tab's host, the first row. */
	current: boolean;
	/** A terminal on it is on its way to this pane. */
	opening: boolean;
	/** Why the last attempt from this pane failed, or null. */
	failure: string | null;
}): HostRowView {
	if (row.opening) {
		return {
			action: { text: "Connecting…", tone: "warn" },
			note: `The terminal opens here once ${row.label} answers. Esc cancels.`,
		};
	}
	if (row.failure !== null) {
		return { action: { text: "Error · retry", tone: "error" }, note: row.failure };
	}
	if (row.current) return { action: { text: "New terminal", tone: "accent" }, note: null };
	switch (row.status) {
		case "offline":
			return { action: { text: "Connect", tone: "accent" }, note: null };
		// Offline on purpose (#648): said, and connected like any other.
		case "disconnected":
			return { action: { text: "Disconnected · connect", tone: "accent" }, note: null };
		case "error":
			return { action: { text: "Error · retry", tone: "error" }, note: null };
		default:
			return { action: statusAction(row.status), note: null };
	}
}

/** "2 terminals", or nothing for a host with none. */
export function terminalCountText(count: number): string {
	if (count <= 0) return "";
	return count === 1 ? "1 terminal" : `${count} terminals`;
}

/**
 * The terminals each host has running, as far as this window knows: every
 * channel it has a host for, less those it knows to have ended.
 */
export function countTerminals(
	channelHost: ReadonlyMap<string, string>,
	alive: (channelId: string) => boolean,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const [channelId, hostId] of channelHost) {
		if (!alive(channelId)) continue;
		counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
	}
	return counts;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/** The words of a search, lowercased. */
export function queryTerms(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word is found in one of the fields: "prod web" finds web-1 in Prod. */
export function matchesTerms(
	terms: readonly string[],
	fields: ReadonlyArray<string | null | undefined>,
): boolean {
	if (terms.length === 0) return true;
	const haystack = fields
		.filter((f): f is string => typeof f === "string" && f !== "")
		.join("\n")
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

// ─── The picker's list ───────────────────────────────────────────────────────

/** A detached terminal of this tab's host, as the picker offers it. */
export interface PickerTerminal {
	channelId: string;
	title: string;
}

export type PickerOption =
	| {
			kind: "host";
			id: string;
			host: Host;
			/** This tab's host, offered first as "New terminal". */
			current: boolean;
	  }
	| { kind: "terminal"; id: string; channelId: string; title: string; hostLabel: string }
	| {
			kind: "add";
			id: string;
			/** What was searched for, when nothing matched it. */
			name: string | null;
	  };

export interface PickerSection {
	id: string;
	title: string;
	options: PickerOption[];
}

export interface PickerList {
	sections: PickerSection[];
	/** "Add a host…", last; none while there is no remote host (the invitation says it). */
	add: Extract<PickerOption, { kind: "add" }> | null;
	/** Every option in the order shown: what ↑ and ↓ walk through. */
	options: PickerOption[];
	/** Something was searched for and nothing matched. */
	noMatch: boolean;
	/** Only the local host exists: the picker invites to add one. */
	noRemoteHost: boolean;
}

export const THIS_TAB_SECTION = "This tab's host";

export interface PickerInput {
	query: string;
	/** The host of this tab, or null when there is none in view. */
	currentHost: Host | null;
	/** Its terminals that no pane shows. */
	detached: readonly PickerTerminal[];
	/** Every host, in the rail's order. */
	rail: readonly RailSection[];
	address: (host: Host) => string;
}

/**
 * The empty pane's list: this tab's host and its detached terminals first,
 * then every other host under its rail heading, then "Add a host…".
 *
 * A host matches on its label, its address and its group; a terminal on its
 * title and on its host's. The first row is this tab's host even when another
 * row would match better: it is what the pane is most likely for.
 */
export function buildPickerList(input: PickerInput): PickerList {
	const terms = queryTerms(input.query);
	const groupOf = new Map<string, string>();
	for (const section of input.rail) {
		for (const host of section.hosts) groupOf.set(host.id, section.name);
	}
	const hostFields = (host: Host): Array<string | undefined> => [
		host.label,
		input.address(host),
		groupOf.get(host.id),
	];
	const hostMatches = (host: Host): boolean => matchesTerms(terms, hostFields(host));

	const sections: PickerSection[] = [];
	const current = input.currentHost;
	if (current !== null) {
		const options: PickerOption[] = [];
		if (hostMatches(current)) {
			options.push({ kind: "host", id: `current:${current.id}`, host: current, current: true });
		}
		for (const terminal of input.detached) {
			if (!matchesTerms(terms, [terminal.title, ...hostFields(current)])) continue;
			options.push({
				kind: "terminal",
				id: `terminal:${terminal.channelId}`,
				channelId: terminal.channelId,
				title: terminal.title,
				hostLabel: current.label,
			});
		}
		if (options.length > 0) sections.push({ id: "current", title: THIS_TAB_SECTION, options });
	}

	for (const section of input.rail) {
		const options: PickerOption[] = section.hosts
			.filter((host) => host.id !== current?.id && hostMatches(host))
			.map((host) => ({ kind: "host", id: `host:${host.id}`, host, current: false }));
		if (options.length > 0) sections.push({ id: section.id, title: section.name, options });
	}

	const shown = sections.flatMap((section) => section.options);
	const noMatch = terms.length > 0 && shown.length === 0;
	const noRemoteHost = !input.rail.some((section) =>
		section.hosts.some((host) => host.type !== "local"),
	);
	const add: PickerList["add"] = noRemoteHost
		? null
		: { kind: "add", id: "add", name: noMatch ? input.query.trim() : null };
	return {
		sections,
		add,
		options: add === null ? shown : [...shown, add],
		noMatch,
		noRemoteHost,
	};
}

/** What "Add a host…" says: named after the search when nothing matched it. */
export function addHostText(name: string | null): string {
	return name === null ? "Add a host…" : `Add a host named "${name}"…`;
}

/** The highlighted row after ↑ or ↓: it stops at either end. */
export function moveHighlight(index: number, delta: 1 | -1, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(index + delta, 0), count - 1);
}

/** Esc clears the search first; with nothing searched, it cancels a terminal on its way. */
export function escapeAction(query: string, opening: boolean): "clear" | "cancel" | "none" {
	if (query !== "") return "clear";
	return opening ? "cancel" : "none";
}
