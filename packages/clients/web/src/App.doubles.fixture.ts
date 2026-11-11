/**
 * Test-only: what an App spec stands in for (#936). The hub, as its socket and its REST API,
 * which a test answers and reads; and xterm with its addons, which need a canvas.
 *
 * Nothing here imports the app: a spec's `vi.mock` factories load this module, and the app's
 * modules load those mocks.
 */
import { DEFAULT_APPEARANCE, DEFAULT_PROFILE } from "@lasterm/shared";

/** A frame on the hub's socket. */
export type Frame = { type: string } & Record<string, unknown>;

/** A REST call the window made. */
export interface RestCall {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
}

/** A host as `GET /api/hosts` lists it. */
export interface HostRow {
	id: string;
	label: string;
	type: "local" | "ssh";
	host_group_id?: string | null;
	sort_order?: number;
	/** An SSH host the hub holds a live session to, as it says once the window authenticates. */
	connected?: boolean;
}

/** A terminal as `GET /api/channels` lists it. */
export interface ChannelRow {
	id: string;
	hostId: string;
	status: "live" | "dead";
	title?: string;
	/**
	 * What the hub answers its ATTACH, when not what its status says: "ended" for a terminal the
	 * list still says runs, "none" for no answer at all.
	 */
	attach?: "ok" | "ended" | "none";
	/**
	 * The client holding its write lock. The hub grants it to the first window that attaches:
	 * this one (`CLIENT_HERE`) unless another is named.
	 */
	writer?: string;
}

/** The client id the hub gives the window under test. */
export const CLIENT_HERE = "client-here";

/** A host group as `GET /api/host-groups` lists it. */
export interface HostGroupRow {
	id: string;
	name: string;
}

/** What the hub answers to one request, by "METHOD /path": a refusal, or an answer it holds back. */
export type Answer = () => Response | Promise<Response>;

type Listener = (msg: Frame) => void;

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const AT = "2026-11-01T00:00:00.000Z";

/**
 * The hub a window talks to. Its socket authenticates, answers each ATTACH as its list says
 * (ATTACH_OK for a live terminal, CHANNEL_DEAD for an ended one), and keeps every frame the
 * window sends; its REST API serves the lists it holds and keeps every call.
 */
export class FakeHub {
	readonly sent: Frame[] = [];
	readonly rest: RestCall[] = [];
	hosts: HostRow[] = [];
	hostGroups: HostGroupRow[] = [];
	channels: ChannelRow[] = [];
	ui: Record<string, unknown> = { onChannelDead: "readonly" };
	/** Each host's own terminal settings, as `PATCH /api/hosts/:id` writes them. */
	readonly hostProfiles = new Map<string, Record<string, unknown>>();
	/** Answers a test sets for a request, by "METHOD /path". */
	readonly answers = new Map<string, Answer>();
	/** Whether it answers a SPAWN at once; when not, the window waits on it. */
	answersSpawns = true;
	private readonly listeners = new Map<string, Listener[]>();
	private connected = false;

	readonly socket = {
		connect: async (): Promise<void> => {
			this.connected = true;
		},
		send: (msg: Frame): void => {
			this.sent.push(msg);
			this.answerFrame(msg);
		},
		on: (type: string, cb: Listener): (() => void) => {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
			return () =>
				this.listeners.set(
					type,
					(this.listeners.get(type) ?? []).filter((c) => c !== cb),
				);
		},
		onReconnect: (): (() => void) => () => {},
		onDisconnect: (): (() => void) => () => {},
		close: (): void => {
			this.connected = false;
		},
		get isConnected(): boolean {
			return hub().connected;
		},
	};

	/** A frame from the hub. */
	hear(msg: Frame): void {
		for (const cb of [...(this.listeners.get(msg.type) ?? [])]) cb(msg);
	}

	/** The frames of one type the window sent. */
	frames(type: string): Frame[] {
		return this.sent.filter((m) => m.type === type);
	}

	/** The REST calls with this method and path. */
	calls(method: string, path: string): RestCall[] {
		return this.rest.filter((c) => c.method === method && c.path === path);
	}

	private answerFrame(msg: Frame): void {
		if (msg.type === "AUTH") {
			queueMicrotask(() => {
				this.hear({ type: "AUTH_OK", clientId: CLIENT_HERE, echoesSpawnRequestId: true });
				for (const host of this.hosts) {
					if (host.connected === true) {
						this.hear({ type: "SESSION_STATE", hostId: host.id, status: "active" });
					}
				}
			});
			return;
		}
		if (msg.type === "SPAWN") {
			if (!this.answersSpawns) return;
			// A new terminal, live on the host asked, as the hub makes one.
			const channelId = (msg.reuseChannelId as string | undefined) ?? `NEW${this.sent.length}`;
			const hostId = msg.hostId as string;
			this.channels = [
				...this.channels.filter((c) => c.id !== channelId),
				{ id: channelId, hostId, status: "live", title: channelId },
			];
			queueMicrotask(() =>
				this.hear({ type: "SPAWN_OK", channelId, hostId, requestId: msg.requestId }),
			);
			return;
		}
		if (msg.type !== "ATTACH") return;
		const channelId = msg.channelId as string;
		const row = this.channels.find((c) => c.id === channelId);
		if (row === undefined) return;
		const answer = row.attach ?? (row.status === "dead" ? "ended" : "ok");
		if (answer === "none") return;
		queueMicrotask(() => {
			if (answer === "ended") {
				this.hear({
					type: "ERROR",
					code: "CHANNEL_DEAD",
					message: "This terminal has ended.",
					channelId,
				});
				return;
			}
			this.hear({
				type: "ATTACH_OK",
				channelId,
				snapshot: { serialized: "", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
				tail: [],
				writeLockHolder: row.writer ?? CLIENT_HERE,
				cached: false,
				cols: 80,
				rows: 24,
			});
			// The lock, granted to the first window attached or held by another.
			this.hear({ type: "WRITE_LOCK", channelId, holder: row.writer ?? CLIENT_HERE });
		});
	}

	/** `fetch`, as the window calls it: relative URLs on the hub. */
	readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input), "http://hub.test");
		const method = (init?.method ?? "GET").toUpperCase();
		const body =
			typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
		this.rest.push({ method, path: url.pathname, query: url.searchParams, body });
		const answer = this.answers.get(`${method} ${url.pathname}`);
		if (answer !== undefined) return answer();
		return this.serve(method, url.pathname, url.searchParams, body);
	};

	private serve(method: string, path: string, query: URLSearchParams, body: unknown): Response {
		const parts = path.split("/").filter((p) => p !== "");
		if (method === "GET" && path === "/api/assets/token") return json({ token: "asset-token" });
		if (method === "GET" && path === "/api/hosts") return json(this.hosts.map(hostListing));
		if (method === "GET" && path === "/api/host-groups") {
			return json(
				this.hostGroups.map((g, i) => ({
					id: g.id,
					name: g.name,
					sort_order: i,
					created_at: AT,
					updated_at: AT,
				})),
			);
		}
		if (method === "GET" && path === "/api/channels") {
			const hostId = query.get("host_id");
			return json(
				this.channels.filter((c) => hostId === null || c.hostId === hostId).map(channelListing),
			);
		}
		if (method === "DELETE" && parts[1] === "channels" && parts.length === 3) {
			this.channels = this.channels.filter((c) => c.id !== parts[2]);
			return json({ ok: true });
		}
		if (method === "GET" && path === "/api/config/ui") return json(this.ui);
		if (method === "PUT" && path === "/api/config/ui") {
			const values = (body ?? {}) as Record<string, Record<string, unknown>>;
			for (const [section, value] of Object.entries(values)) {
				this.ui = {
					...this.ui,
					[section]: { ...((this.ui[section] as object | undefined) ?? {}), ...value },
				};
			}
			return json(this.ui);
		}
		if (method === "GET" && path === "/api/config/cascade") {
			const hostId = query.get("host_id");
			const own = hostId === null ? undefined : this.hostProfiles.get(hostId);
			return json({
				appearance: DEFAULT_APPEARANCE,
				terminal: {
					resolved: { ...DEFAULT_PROFILE, ...(own ?? {}) },
					host: own ?? null,
					channel: null,
				},
			});
		}
		if (method === "PATCH" && parts[1] === "hosts" && parts[3] === "profile") {
			const id = parts[2] as string;
			const profile = (body as { profile?: Record<string, unknown> } | undefined)?.profile ?? {};
			const own = { ...(this.hostProfiles.get(id) ?? {}) };
			for (const [key, value] of Object.entries(profile)) {
				if (value === null) delete own[key];
				else own[key] = value;
			}
			this.hostProfiles.set(id, own);
			return json({ profile: own });
		}
		if (method === "POST" && path === "/api/host-groups") {
			const name = (body as { name?: string } | undefined)?.name ?? "";
			const group = { id: `G-${this.hostGroups.length + 1}`, name };
			this.hostGroups = [...this.hostGroups, group];
			return json({ id: group.id, name, sort_order: 0, created_at: AT, updated_at: AT }, 201);
		}
		if (parts[1] === "host-groups" && parts.length === 3 && method === "PUT") {
			const name = (body as { name?: string } | undefined)?.name ?? "";
			this.hostGroups = this.hostGroups.map((g) => (g.id === parts[2] ? { ...g, name } : g));
			return json({ id: parts[2], name, sort_order: 0, created_at: AT, updated_at: AT });
		}
		if (parts[1] === "host-groups" && parts.length === 3 && method === "DELETE") {
			this.hostGroups = this.hostGroups.filter((g) => g.id !== parts[2]);
			return json({ ok: true });
		}
		if (method === "GET" && path === "/api/transfers") return json({ transfers: [] });
		if (method === "GET") {
			if (
				path === "/api/fonts" ||
				path === "/api/fonts/system" ||
				path === "/api/themes" ||
				path === "/api/launch-profiles" ||
				path === "/api/groups" ||
				(parts[1] === "hosts" && parts[3] === "profiles")
			) {
				return json([]);
			}
		}
		return json({});
	}
}

function hostListing(host: HostRow): Record<string, unknown> {
	return {
		id: host.id,
		type: host.type,
		label: host.label,
		icon_type: "letter",
		...(host.type === "ssh" && { ssh_host: `${host.label}.example`, ssh_port: 22 }),
		trust_remote_hints: "deny",
		host_group_id: host.host_group_id ?? null,
		sort_order: host.sort_order ?? 0,
		os: null,
		arch: null,
		created_at: AT,
		updated_at: AT,
	};
}

function channelListing(channel: ChannelRow): Record<string, unknown> {
	return {
		id: channel.id,
		host_id: channel.hostId,
		session_id: `S-${channel.hostId}`,
		cols: 80,
		rows: 24,
		status: channel.status,
		created_at: AT,
		updated_at: AT,
		display_title: channel.title ?? channel.id.slice(-4),
		...(channel.status === "dead" && { exit_code: 1 }),
	};
}

let current: FakeHub | null = null;

/** A new hub for the next window. */
export function startHub(): FakeHub {
	current = new FakeHub();
	return current;
}

/** The hub of the window under test. */
export function hub(): FakeHub {
	if (current === null) throw new Error("no hub: call startHub() first");
	return current;
}

/** Stands in for `services/ws-client.js`: the window's socket is the hub's. */
export const wsClientModule = { createWsClient: () => hub().socket };

/**
/** The arrows' final letters in xterm's sequences. */
const ARROWS: Readonly<Record<string, string>> = {
	ArrowUp: "A",
	ArrowDown: "B",
	ArrowRight: "C",
	ArrowLeft: "D",
};

/**
 * What xterm sends its program for a key typed, for the keys the window's chords use: a character
 * as typed, ESC before it with Alt, the control character for Ctrl with a letter (or `/`), and
 * the CSI sequences for Tab, F6 and the arrows with their modifiers. Null for a key xterm sends
 * nothing for here, such as Ctrl with a comma, or a modifier alone.
 */
export function xtermInput(event: KeyboardEvent): string | null {
	const mod = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
	const arrow = ARROWS[event.key];
	if (arrow !== undefined) return mod === 1 ? `\u001b[${arrow}` : `\u001b[1;${mod}${arrow}`;
	if (event.key === "F6") return mod === 1 ? "\u001b[17~" : `\u001b[17;${mod}~`;
	if (event.key === "Tab") return event.shiftKey ? "\u001b[Z" : "\t";
	if (event.key === "Enter") return "\r";
	if (event.key === "Escape") return "\u001b";
	if (event.key.length !== 1) return null;
	if (event.ctrlKey && !event.altKey) {
		if (/^[a-z]$/i.test(event.key)) {
			return String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
		}
		return event.key === "/" ? "\u001f" : null;
	}
	return event.altKey ? `\u001b${event.key}` : event.key;
}

/**
 * Stands in for `@xterm/xterm`. It opens as xterm does, a `.xterm` element holding the hidden
 * textarea that takes the keyboard, so that a pane can be focused. Each key typed there goes to
 * the pane's key handler first, as in xterm, and what the handler lets through goes to the
 * terminal's `onData` listeners as xterm would send it (`xtermInput`). Like xterm, it does not
 * look at whether the page took the key (`defaultPrevented`): only the handler keeps a key from
 * the program. It draws nothing.
 */
export const xtermModule = {
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "" };
		element: HTMLElement | undefined;
		textarea: HTMLTextAreaElement | undefined;
		keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
		dataListeners: Array<(data: string) => void> = [];
		buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
		_core = { _renderService: { dimensions: { css: { cell: { width: 9, height: 17 } } } } };
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
		}
		loadAddon(addon: { activate?: (terminal: unknown) => void }): void {
			addon.activate?.(this);
		}
		open(parent: HTMLElement): void {
			const element = document.createElement("div");
			element.className = "xterm";
			const textarea = document.createElement("textarea");
			textarea.className = "xterm-helper-textarea";
			textarea.addEventListener("keydown", (event) => {
				if (this.keyHandler !== null && !this.keyHandler(event)) return;
				const data = xtermInput(event);
				if (data !== null) for (const listener of this.dataListeners) listener(data);
			});
			element.appendChild(textarea);
			parent.appendChild(element);
			this.element = element;
			this.textarea = textarea;
		}
		onData(listener: (data: string) => void) {
			this.dataListeners.push(listener);
			return {
				dispose: () => {
					this.dataListeners = this.dataListeners.filter((l) => l !== listener);
				},
			};
		}
		onResize() {
			return { dispose() {} };
		}
		onTitleChange() {
			return { dispose() {} };
		}
		onBell() {
			return { dispose() {} };
		}
		onScroll() {
			return { dispose() {} };
		}
		attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
			this.keyHandler = handler;
		}
		hasSelection(): boolean {
			return false;
		}
		focus(): void {
			this.textarea?.focus();
		}
		blur(): void {
			this.textarea?.blur();
		}
		scrollToBottom(): void {}
		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
		}
		reset(): void {}
		write(_data: string | Uint8Array, callback?: () => void): void {
			callback?.();
		}
		dispose(): void {
			this.element?.remove();
		}
	},
};

export const fitAddonModule = {
	FitAddon: class {
		activate(): void {}
		fit(): void {}
	},
};

export const unicodeAddonModule = { Unicode11Addon: class {} };

export const searchAddonModule = {
	SearchAddon: class {
		findNext(): boolean {
			return true;
		}
		findPrevious(): boolean {
			return true;
		}
		clearDecorations(): void {}
		clearActiveDecoration(): void {}
		dispose(): void {}
		onDidChangeResults() {
			return { dispose() {} };
		}
	},
};
