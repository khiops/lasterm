import type { Host } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import {
	addHostText,
	buildPickerList,
	countTerminals,
	escapeAction,
	hostAddress,
	hostRowView,
	LOCAL_ADDRESS,
	matchesTerms,
	moveHighlight,
	type PickerInput,
	queryTerms,
	type RailSection,
	railSections,
	statusAction,
	statusWord,
	THIS_TAB_SECTION,
	terminalCountText,
} from "./hostPicker.js";
import type { HostSection } from "./useHostGroups.js";

function host(id: string, label: string, overrides: Partial<Host> = {}): Host {
	return {
		id,
		label,
		type: "ssh",
		sshHost: `${label}.lan`,
		sshPort: 22,
		sshUser: "deploy",
		iconType: "auto",
		trustRemoteHints: "apply",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const local = host("local", "local", { type: "local", sshUser: null });
const pi = host("pi", "pi");
const nas = host("nas", "nas");
const web1 = host("web-1", "web-1", { sshHost: "10.0.1.11" });
const web2 = host("web-2", "web-2", { sshHost: "10.0.1.12" });
const vps = host("vps", "vps-paris", { sshUser: "root", sshHost: "vps.example.net" });

/** The sample rail: local, Home (pi, nas), Prod (web-1, web-2), then vps ungrouped. */
const rail: RailSection[] = [
	{ id: "local", name: "Local", hosts: [local] },
	{ id: "group:home", name: "Home", hosts: [pi, nas] },
	{ id: "group:prod", name: "Prod", hosts: [web1, web2] },
	{ id: "ungrouped", name: "Ungrouped", hosts: [vps] },
];

const allHosts = [local, pi, nas, web1, web2, vps];

function input(overrides: Partial<PickerInput> = {}): PickerInput {
	return {
		query: "",
		currentHost: web1,
		detached: [
			{ channelId: "ch-mig", title: "migrations" },
			{ channelId: "ch-tail", title: "tail -f access.log" },
		],
		rail,
		address: (h) => hostAddress(h, allHosts),
		...overrides,
	};
}

function optionIds(list: ReturnType<typeof buildPickerList>): string[] {
	return list.options.map((o) => o.id);
}

describe("railSections", () => {
	it("puts the local host first and Ungrouped last, groups in the rail's order", () => {
		const sections: HostSection[] = [
			{ type: "group", id: "home", name: "Home", hosts: [pi, nas], collapsed: false },
			{ type: "group", id: "prod", name: "Prod", hosts: [web1], collapsed: true },
			{ type: "ungrouped", hosts: [vps] },
		];
		const out = railSections(local, sections);
		expect(out.map((s) => s.name)).toEqual(["Local", "Home", "Prod", "Ungrouped"]);
		// A group folded in the rail still lists its hosts: the picker offers every host.
		expect(out[2]?.hosts.map((h) => h.id)).toEqual(["web-1"]);
	});

	it("leaves out a group with no host, and a missing local host", () => {
		const out = railSections(null, [
			{ type: "group", id: "empty", name: "Empty", hosts: [], collapsed: false },
			{ type: "ungrouped", hosts: [vps] },
		]);
		expect(out.map((s) => s.id)).toEqual(["ungrouped"]);
	});
});

describe("hostAddress", () => {
	it("is user@host, with the port when it is not 22", () => {
		expect(hostAddress(pi, allHosts)).toBe("deploy@pi.lan");
		expect(hostAddress(host("x", "x", { sshPort: 2222 }), allHosts)).toBe("deploy@x.lan:2222");
	});

	it("names the jump host by its label when it is one of the hosts", () => {
		const gpu = host("gpu", "gpu-box", { sshUser: "ml", sshHost: "gpu.lan", sshProxyHostId: "pi" });
		expect(hostAddress(gpu, allHosts)).toBe("ml@gpu.lan via pi");
	});

	it("names a jump given as a spec by its host, the last hop of a chain", () => {
		const a = host("a", "a", { sshProxySpec: "admin@bastion.example.com:2222" });
		expect(hostAddress(a, allHosts)).toBe("deploy@a.lan via bastion.example.com");
		const b = host("b", "b", { sshProxySpec: "first.example,jump@[fd00::1]:22" });
		expect(hostAddress(b, allHosts)).toBe("deploy@b.lan via fd00::1");
	});

	it("says where the local host is relative to the hub, not to this client", () => {
		expect(hostAddress(local, allHosts)).toBe(LOCAL_ADDRESS);
	});
});

describe("status words", () => {
	it("says each status in words, coloured as the rail's dot", () => {
		expect(statusWord("live")).toBe("Live");
		expect(statusWord("reconnecting")).toBe("Reconnecting");
		expect(statusWord("offline")).toBe("Offline");
		expect(statusWord("error")).toBe("Error");
		expect(statusAction("live").tone).toBe("live");
		expect(statusAction("reconnecting").tone).toBe("warn");
		expect(statusAction("error").tone).toBe("error");
	});

	// Offline on purpose, and said apart from a host never connected (#648).
	it("says a host its user disconnected is disconnected, quietly", () => {
		expect(statusWord("disconnected")).toBe("Disconnected");
		expect(statusAction("disconnected")).toEqual({ text: "Disconnected", tone: "muted" });
	});
});

describe("hostRowView", () => {
	const base = {
		label: "nas",
		status: "offline" as const,
		current: false,
		opening: false,
		failure: null,
	};

	it("offers to connect an offline host, and says the status of the others", () => {
		expect(hostRowView(base).action).toEqual({ text: "Connect", tone: "accent" });
		expect(hostRowView({ ...base, status: "live" }).action.text).toBe("Live");
		expect(hostRowView({ ...base, status: "reconnecting" }).action.text).toBe("Reconnecting");
		expect(hostRowView({ ...base, status: "error" }).action).toEqual({
			text: "Error · retry",
			tone: "error",
		});
	});

	it("offers to connect a host its user disconnected, and says so (#648)", () => {
		expect(hostRowView({ ...base, status: "disconnected" }).action).toEqual({
			text: "Disconnected · connect",
			tone: "accent",
		});
	});

	it("offers a new terminal on this tab's host", () => {
		expect(hostRowView({ ...base, current: true }).action).toEqual({
			text: "New terminal",
			tone: "accent",
		});
	});

	it("says a terminal is on its way, and that Esc cancels it, before anything else", () => {
		const view = hostRowView({ ...base, current: true, opening: true, failure: "old" });
		expect(view.action).toEqual({ text: "Connecting…", tone: "warn" });
		expect(view.note).toBe("The terminal opens here once nas answers. Esc cancels.");
	});

	it("gives the reason of a failed attempt on a second line", () => {
		const view = hostRowView({ ...base, failure: "Permission denied (publickey)." });
		expect(view.action.text).toBe("Error · retry");
		expect(view.note).toBe("Permission denied (publickey).");
	});
});

describe("countTerminals", () => {
	it("counts each host's terminals that are still running", () => {
		const map = new Map([
			["a", "pi"],
			["b", "pi"],
			["c", "nas"],
			["dead", "pi"],
		]);
		const counts = countTerminals(map, (id) => id !== "dead");
		expect(counts.get("pi")).toBe(2);
		expect(counts.get("nas")).toBe(1);
		expect(terminalCountText(2)).toBe("2 terminals");
		expect(terminalCountText(1)).toBe("1 terminal");
		expect(terminalCountText(0)).toBe("");
	});
});

describe("search", () => {
	it("needs every word, in any of the fields", () => {
		const terms = queryTerms("  Prod  WEB ");
		expect(terms).toEqual(["prod", "web"]);
		expect(matchesTerms(terms, ["web-1", "deploy@10.0.1.11", "Prod"])).toBe(true);
		expect(matchesTerms(terms, ["pi", "deploy@pi.lan", "Home"])).toBe(false);
		expect(matchesTerms([], ["anything"])).toBe(true);
	});
});

describe("buildPickerList", () => {
	it("offers this tab's host first, then its detached terminals, then every other host as the rail lists them", () => {
		const list = buildPickerList(input());
		expect(list.sections.map((s) => s.title)).toEqual([
			THIS_TAB_SECTION,
			"Local",
			"Home",
			"Prod",
			"Ungrouped",
		]);
		expect(optionIds(list)).toEqual([
			"current:web-1",
			"terminal:ch-mig",
			"terminal:ch-tail",
			"host:local",
			"host:pi",
			"host:nas",
			// web-1 is this tab's host, offered once, at the top.
			"host:web-2",
			"host:vps",
			"add",
		]);
		const first = list.options[0];
		expect(first?.kind === "host" && first.current).toBe(true);
		expect(list.add?.name).toBeNull();
		expect(list.noMatch).toBe(false);
	});

	it("has no section of its own without a host in view", () => {
		const list = buildPickerList(input({ currentHost: null, detached: [] }));
		expect(list.sections[0]?.title).toBe("Local");
		expect(optionIds(list)).toContain("host:web-1");
	});

	it("filters hosts by label, address and group", () => {
		expect(optionIds(buildPickerList(input({ query: "nas" })))).toEqual(["host:nas", "add"]);
		expect(optionIds(buildPickerList(input({ query: "10.0.1.12" })))).toEqual([
			"host:web-2",
			"add",
		]);
		expect(optionIds(buildPickerList(input({ query: "home" })))).toEqual([
			"host:pi",
			"host:nas",
			"add",
		]);
		expect(optionIds(buildPickerList(input({ query: "root@vps" })))).toEqual(["host:vps", "add"]);
	});

	it("finds a detached terminal by its title, and all of them by their host", () => {
		expect(optionIds(buildPickerList(input({ query: "migr" })))).toEqual([
			"terminal:ch-mig",
			"add",
		]);
		const byHost = buildPickerList(input({ query: "web-1" }));
		expect(optionIds(byHost)).toEqual([
			"current:web-1",
			"terminal:ch-mig",
			"terminal:ch-tail",
			"add",
		]);
		expect(byHost.sections.map((s) => s.title)).toEqual([THIS_TAB_SECTION]);
	});

	it("says nothing matched, and offers to add a host by that name", () => {
		const list = buildPickerList(input({ query: " stag " }));
		expect(list.sections).toEqual([]);
		expect(list.noMatch).toBe(true);
		expect(list.add?.name).toBe("stag");
		expect(addHostText(list.add?.name ?? null)).toBe('Add a host named "stag"…');
		// Enter still does something: the add row is the one lit.
		expect(optionIds(list)).toEqual(["add"]);
		expect(addHostText(null)).toBe("Add a host…");
	});

	it("invites to add a host while there is none but the local one", () => {
		const list = buildPickerList(
			input({
				currentHost: local,
				detached: [],
				rail: [{ id: "local", name: "Local", hosts: [local] }],
			}),
		);
		expect(list.noRemoteHost).toBe(true);
		expect(list.add).toBeNull();
		expect(optionIds(list)).toEqual(["current:local"]);
	});
});

describe("keys", () => {
	it("moves the highlight within the list, and stops at either end", () => {
		expect(moveHighlight(0, 1, 3)).toBe(1);
		expect(moveHighlight(2, 1, 3)).toBe(2);
		expect(moveHighlight(0, -1, 3)).toBe(0);
		expect(moveHighlight(0, 1, 0)).toBe(0);
	});

	it("clears the search with Esc first, then cancels a terminal on its way", () => {
		expect(escapeAction("nas", true)).toBe("clear");
		expect(escapeAction("", true)).toBe("cancel");
		expect(escapeAction("", false)).toBe("none");
	});
});
