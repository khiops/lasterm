/**
 * Test-only: an agent connection that speaks the file requests (#1201), for the specs that drive
 * the hub's listings through a host's agent. It records what it is sent and answers through the
 * function it is given, with frames as the codec decodes them (camelCase).
 */
import { EventEmitter } from "node:events";
import type { ProtocolMessage } from "@lasterm/shared";
import type { AgentFilesPort } from "./agent-files.js";

export type Answer = (message: ProtocolMessage, agent: FakeFilesAgent) => void;

export class FakeFilesAgent extends EventEmitter implements AgentFilesPort {
	connected = true;
	readonly helloMessage: { capabilities: string[] };
	readonly asked: ProtocolMessage[] = [];

	constructor(
		private readonly answer: Answer = () => {},
		capabilities: string[] = ["files"],
	) {
		super();
		this.helloMessage = { capabilities };
	}

	send(message: ProtocolMessage): void {
		this.asked.push(message);
		setTimeout(() => this.answer(message, this), 0);
	}

	reply(frame: Record<string, unknown>): void {
		this.emit("message", frame as unknown as ProtocolMessage);
	}
}

export function idOf(message: ProtocolMessage): string {
	return (message as { requestId: string }).requestId;
}

export function pathOf(message: ProtocolMessage): string {
	return (message as { path: string }).path;
}

/** An entry as an agent sends it, decoded. */
export function sent(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name,
		kind: "file",
		size: 1,
		mtimeMs: null,
		mode: 0o100644,
		attributes: null,
		owner: "alice",
		group: "staff",
		...extra,
	};
}

/** Answer every request with these frames, its `requestId` filled in. */
export function answering(...frames: Record<string, unknown>[]): Answer {
	return (message, agent) => {
		for (const frame of frames) agent.reply({ ...frame, requestId: idOf(message) });
	};
}
