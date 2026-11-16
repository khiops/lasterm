import type {
	ErrorMessage,
	PasteAckMessage,
	PasteCancelMessage,
	PasteClosedMessage,
	PasteMessage,
	ProtocolMessage,
} from "@lasterm/shared";
import type { AgentConnection } from "./agent-connection.js";
import { agentStreamsPaste } from "./input-modes.js";

/** One paste the hub relays, from the window that sent it to the agent that takes it. */
interface RelayedPaste {
	channelId: string;
	clientId: string;
	/** The id the window gave it: its own counter. */
	clientPasteId: number;
	/** The id the agent knows it by: this hub's, never reused while it runs. */
	agentPasteId: number;
	/** The agent the paste went to; an answer from another is not about it. */
	agent: AgentConnection;
	/** Its last chunk's `seq`, once relayed: that chunk's PASTE_ACK is the final answer. */
	lastSeq?: number;
}

/** What the relay reads of the hub's session state. */
export interface PasteRelayContext {
	channels: { get(channelId: string): { hostId: string } | undefined };
	agents: { get(hostId: string): AgentConnection | undefined };
	clients: { get(clientId: string): { send(msg: ProtocolMessage): void } | undefined };
	getWriteLockHolder: ((channelId: string) => string | null) | null;
}

/**
 * Pastes on their way from a window to an agent (#1014).
 *
 * The hub keeps no paste queue: it relays each chunk as it comes and each
 * answer back, and keeps only who owns each terminal's open paste. It gives
 * every paste its own id toward the agent, so that an answer is never taken
 * for another window's paste, or for a later page's, whatever ids the windows
 * chose. It cancels a paste whose window leaves or loses the terminal's write
 * lock, and tells the window when the agent that took it is gone.
 */
export class PasteRelay {
	private nextAgentPasteId = 1;
	private readonly byChannel = new Map<string, RelayedPaste>();
	private readonly byAgentId = new Map<number, RelayedPaste>();

	constructor(private readonly ctx: PasteRelayContext) {}

	/**
	 * A PASTE from the window `clientId`, which holds the terminal's write lock
	 * and whose fields are valid (the WS handler checked both).
	 */
	relay(clientId: string, msg: PasteMessage): void {
		const channel = this.ctx.channels.get(msg.channelId);
		const agent = channel ? this.ctx.agents.get(channel.hostId) : undefined;
		const current = this.byChannel.get(msg.channelId);
		if (msg.seq === 0) {
			if (current?.clientId === clientId) {
				// One paste at a time per window, until its final answer: its own
				// second one would close the first and lose its tail.
				this.toClient(clientId, {
					type: "ERROR",
					code: "INVALID_INPUT",
					message: "A paste is still being sent to this terminal",
					channelId: msg.channelId,
				} satisfies ErrorMessage);
				return;
			}
			if (current) this.cancel(current);
			if (!channel || !agent) {
				this.closedToClient(clientId, msg.channelId, msg.pasteId, "agent_lost");
				return;
			}
			if (!agentStreamsPaste(this.ctx.agents, channel.hostId)) {
				this.closedToClient(clientId, msg.channelId, msg.pasteId, "unsupported");
				return;
			}
			const paste: RelayedPaste = {
				channelId: msg.channelId,
				clientId,
				clientPasteId: msg.pasteId,
				agentPasteId: this.nextAgentPasteId++,
				agent,
			};
			this.byChannel.set(msg.channelId, paste);
			this.byAgentId.set(paste.agentPasteId, paste);
			this.forward(paste, msg);
			return;
		}
		// A later chunk: only of this window's registered paste. One still in
		// flight after the hub cleared it is dropped; its window is told already.
		if (!current || current.clientId !== clientId || current.clientPasteId !== msg.pasteId) {
			return;
		}
		if (agent !== current.agent) {
			this.lose(current);
			return;
		}
		this.forward(current, msg);
	}

	/** A PASTE_CANCEL from the window that owns the paste. */
	cancelFromClient(clientId: string, msg: PasteCancelMessage): void {
		const current = this.byChannel.get(msg.channelId);
		if (current?.clientId === clientId && current.clientPasteId === msg.pasteId) {
			// The window has stopped already: the agent's close is not relayed.
			this.cancel(current);
		}
	}

	/** A PASTE_ACK or PASTE_CLOSED from `agent`, for its owner only. */
	fromAgent(agent: AgentConnection, msg: PasteAckMessage | PasteClosedMessage): void {
		const paste = this.byAgentId.get(msg.pasteId);
		if (!paste || paste.agent !== agent || paste.channelId !== msg.channelId) return;
		if (msg.type === "PASTE_ACK") {
			if (paste.lastSeq === msg.seq) this.forget(paste);
			this.toClient(paste.clientId, { ...msg, pasteId: paste.clientPasteId });
			return;
		}
		this.forget(paste);
		this.toClient(paste.clientId, { ...msg, pasteId: paste.clientPasteId });
	}

	/** The window `clientId` left: its pastes stop. */
	clientGone(clientId: string): void {
		for (const paste of [...this.byChannel.values()]) {
			if (paste.clientId === clientId) this.cancel(paste);
		}
	}

	/** `channelId`'s write lock changed hands: a paste its owner no longer holds stops. */
	lockChanged(channelId: string): void {
		const paste = this.byChannel.get(channelId);
		if (!paste) return;
		const holder = this.ctx.getWriteLockHolder?.(channelId) ?? null;
		if (holder !== paste.clientId) this.cancel(paste);
	}

	/** `agent` closed, current or replaced: the pastes it took end for their windows. */
	agentGone(agent: AgentConnection): void {
		for (const paste of [...this.byChannel.values()]) {
			if (paste.agent === agent) this.lose(paste);
		}
	}

	private forward(paste: RelayedPaste, msg: PasteMessage): void {
		if (msg.last) paste.lastSeq = msg.seq;
		try {
			paste.agent.send({ ...msg, pasteId: paste.agentPasteId } satisfies PasteMessage);
		} catch {
			this.lose(paste);
		}
	}

	/** Stop `paste` at its agent, and forget it. */
	private cancel(paste: RelayedPaste): void {
		this.forget(paste);
		try {
			paste.agent.send({
				type: "PASTE_CANCEL",
				channelId: paste.channelId,
				pasteId: paste.agentPasteId,
			} satisfies PasteCancelMessage);
		} catch {
			// The agent is gone: its terminals' pastes went with its connection.
		}
	}

	/** The agent that took `paste` is gone: tell its window. */
	private lose(paste: RelayedPaste): void {
		this.forget(paste);
		this.closedToClient(paste.clientId, paste.channelId, paste.clientPasteId, "agent_lost");
	}

	private forget(paste: RelayedPaste): void {
		if (this.byChannel.get(paste.channelId) === paste) this.byChannel.delete(paste.channelId);
		this.byAgentId.delete(paste.agentPasteId);
	}

	private closedToClient(
		clientId: string,
		channelId: string,
		pasteId: number,
		reason: "unsupported" | "agent_lost",
	): void {
		this.toClient(clientId, {
			type: "PASTE_CLOSED",
			channelId,
			pasteId,
			reason,
		} satisfies PasteClosedMessage);
	}

	private toClient(clientId: string, msg: ProtocolMessage): void {
		this.ctx.clients.get(clientId)?.send(msg);
	}
}
