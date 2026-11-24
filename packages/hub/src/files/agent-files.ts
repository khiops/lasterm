/**
 * A host's files through its own agent (#1201): FILES_LIST and FILES_STAT, which give each entry
 * its mode or Windows attributes, its owner and its group. The hub's own ways to the files
 * (`FileBackend`) stay behind it: an agent that does not say `files`, is gone, fails without a
 * verdict, or does not answer within the request's budget, leaves the request to them.
 *
 * Nothing here logs: a path, a name, an owner or a group is the user's, at any level.
 */
import { generateId, type ProtocolMessage } from "@lasterm/shared";
import {
	FileAccessError,
	type FileBackend,
	type FileEntry,
	type FileErrorCode,
	type FileKind,
	type LinkKind,
	REASONS,
} from "./host-files.js";
import { baseNameOf, type PathStyle } from "./host-paths.js";

/** The capability an agent says when it answers FILES_LIST and FILES_STAT. */
export const FILES_CAPABILITY = "files";

/**
 * How long one request of a client (a listing, a stat) waits for the agent, all its agent requests
 * together: the desktop's REST client gives up after 25 s, and the hub's own way must still have
 * time to answer.
 */
export const AGENT_FILES_BUDGET_MS = 15_000;

/** What this module reads of an agent connection (`AgentConnection`). */
export interface AgentFilesPort {
	readonly connected: boolean;
	readonly helloMessage?: { readonly capabilities?: readonly string[] } | undefined;
	send(message: ProtocolMessage): void;
	on(event: "message", listener: (message: ProtocolMessage) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	off(event: "message", listener: (message: ProtocolMessage) => void): unknown;
	off(event: "close", listener: () => void): unknown;
}

/** Whether `agent` answers the file requests. */
export function speaksFiles(agent: AgentFilesPort): boolean {
	return agent.connected && agent.helloMessage?.capabilities?.includes(FILES_CAPABILITY) === true;
}

/** The time one client request may spend on the agent, and whether the agent already failed it. */
export class AgentBudget {
	private readonly deadline: number;
	failed = false;

	constructor(ms: number) {
		this.deadline = Date.now() + ms;
	}

	remaining(): number {
		return Math.max(0, this.deadline - Date.now());
	}
}

type Outcome =
	| { readonly kind: "entries"; readonly entries: FileEntry[] }
	| { readonly kind: "verdict"; readonly error: FileAccessError }
	| { readonly kind: "failed" };

interface Pending {
	frame(message: ProtocolMessage): void;
	closed(): void;
}

/** The requests in flight on a connection, behind its one `message` and one `close` listener. */
interface Registry {
	readonly pending: Map<string, Pending>;
	readonly onMessage: (message: ProtocolMessage) => void;
	readonly onClose: () => void;
}

const registries = new WeakMap<AgentFilesPort, Registry>();

function register(agent: AgentFilesPort, requestId: string, pending: Pending): () => void {
	let registry = registries.get(agent);
	if (registry === undefined) {
		const map = new Map<string, Pending>();
		const created: Registry = {
			pending: map,
			onMessage: (message) => {
				const id = (message as { requestId?: unknown }).requestId;
				if (typeof id === "string") map.get(id)?.frame(message);
			},
			onClose: () => {
				for (const each of [...map.values()]) each.closed();
			},
		};
		agent.on("message", created.onMessage);
		agent.on("close", created.onClose);
		registries.set(agent, created);
		registry = created;
	}
	registry.pending.set(requestId, pending);
	const own = registry;
	return () => {
		own.pending.delete(requestId);
		if (own.pending.size === 0 && registries.get(agent) === own) {
			agent.off("message", own.onMessage);
			agent.off("close", own.onClose);
			registries.delete(agent);
		}
	};
}

/** The codes of a FILES_ERR that settle a request: asking another way would say the same. */
const VERDICTS: ReadonlySet<FileErrorCode> = new Set<FileErrorCode>([
	"NOT_FOUND",
	"NOT_A_DIRECTORY",
	"PERMISSION_DENIED",
]);

const KINDS: ReadonlySet<string> = new Set<FileKind>(["file", "directory", "symlink", "other"]);
const LINK_KINDS: ReadonlySet<string> = new Set<LinkKind>([
	"file",
	"directory",
	"other",
	"missing",
]);

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** An entry as the agent sent it, or null when it has no name or no kind this hub knows. */
export function entryOfAgent(raw: unknown): FileEntry | null {
	if (raw === null || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.name !== "string" || typeof value.kind !== "string" || !KINDS.has(value.kind)) {
		return null;
	}
	const mtimeMs = numberOrNull(value.mtimeMs);
	const date = mtimeMs === null ? null : new Date(mtimeMs);
	const linkKind = value.linkKind;
	return {
		name: value.name,
		kind: value.kind as FileKind,
		size: numberOrNull(value.size),
		mtime: date === null || Number.isNaN(date.getTime()) ? null : date.toISOString(),
		mode: numberOrNull(value.mode),
		attributes: numberOrNull(value.attributes),
		owner: textOrNull(value.owner),
		group: textOrNull(value.group),
		...(typeof value.linkTarget === "string" ? { linkTarget: value.linkTarget } : {}),
		...(typeof linkKind === "string" && LINK_KINDS.has(linkKind)
			? { linkKind: linkKind as LinkKind }
			: {}),
	};
}

/**
 * Ask the agent `message` (a FILES_LIST or a FILES_STAT) and gather its answer: the entries, a
 * verdict, or a failure without one (the agent gone, silent past the budget, an answer that does
 * not read), which marks the budget failed.
 */
function ask(
	agent: AgentFilesPort,
	message:
		| { type: "FILES_LIST"; path: string; hidden: boolean }
		| { type: "FILES_STAT"; path: string },
	what: string,
	budget: AgentBudget,
): Promise<Outcome> {
	const remaining = budget.remaining();
	if (budget.failed || remaining === 0 || !agent.connected) {
		budget.failed = true;
		return Promise.resolve({ kind: "failed" });
	}
	const requestId = generateId();
	const stat = message.type === "FILES_STAT";
	return new Promise<Outcome>((resolve) => {
		const gathered: FileEntry[] = [];
		let settled = false;
		const finish = (outcome: Outcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unregister();
			if (outcome.kind === "failed") budget.failed = true;
			resolve(outcome);
		};
		const unregister = register(agent, requestId, {
			frame: (frame) => {
				if (frame.type === "FILES_ERR") {
					const code = (frame as { code?: unknown }).code;
					if (typeof code !== "string") return finish({ kind: "failed" });
					if (VERDICTS.has(code as FileErrorCode)) {
						const reason = REASONS[code as keyof typeof REASONS];
						return finish({
							kind: "verdict",
							error: new FileAccessError(code as FileErrorCode, `${what}: ${reason}`),
						});
					}
					return finish({ kind: "failed" });
				}
				if (frame.type !== "FILES_ENTRIES") return;
				const { entries, done } = frame as { entries?: unknown; done?: unknown };
				if (!Array.isArray(entries) || typeof done !== "boolean") {
					return finish({ kind: "failed" });
				}
				for (const raw of entries) {
					const entry = entryOfAgent(raw);
					if (entry !== null) gathered.push(entry);
				}
				if (stat) {
					// A stat is one frame of one entry that reads.
					const whole = done && entries.length === 1 && gathered.length === 1;
					return finish(whole ? { kind: "entries", entries: gathered } : { kind: "failed" });
				}
				if (done) finish({ kind: "entries", entries: gathered });
			},
			closed: () => finish({ kind: "failed" }),
		});
		const timer = setTimeout(() => finish({ kind: "failed" }), remaining);
		try {
			agent.send({ ...message, requestId } as ProtocolMessage);
		} catch {
			finish({ kind: "failed" });
		}
	});
}

/**
 * A host's files, listed and stat'ed through its agent first, the hub's own way after it; the
 * rest (home, free space, new folder, environment) the hub's own way only. One per client request:
 * its agent requests share `budget`, and once the agent failed one without a verdict, the others
 * go the hub's own way at once.
 */
export class AgentFirstFiles implements FileBackend {
	constructor(
		private readonly agent: AgentFilesPort,
		private readonly backend: FileBackend,
		private readonly style: PathStyle,
		private readonly budget: AgentBudget,
	) {}

	home(): Promise<string> {
		return this.backend.home();
	}

	async list(dir: string, hidden: boolean): Promise<FileEntry[]> {
		const outcome = await ask(
			this.agent,
			{ type: "FILES_LIST", path: dir, hidden },
			"The folder could not be listed",
			this.budget,
		);
		if (outcome.kind === "entries") return outcome.entries;
		if (outcome.kind === "verdict") throw outcome.error;
		return this.backend.list(dir, hidden);
	}

	async stat(path: string): Promise<FileEntry> {
		const outcome = await ask(
			this.agent,
			{ type: "FILES_STAT", path },
			"The path could not be read",
			this.budget,
		);
		if (outcome.kind === "verdict") throw outcome.error;
		const [entry] = outcome.kind === "entries" ? outcome.entries : [];
		if (entry === undefined) return this.backend.stat(path);
		return { ...entry, name: baseNameOf(path, this.style) };
	}

	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		return this.backend.freeSpace(dir);
	}

	mkdir(path: string): Promise<void> {
		return this.backend.mkdir(path);
	}

	env(names: readonly string[]): Promise<ReadonlyMap<string, string>> {
		return this.backend.env(names);
	}
}
