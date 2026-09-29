import { describe, expect, it } from "vitest";
import {
	type HostConnectionFacts,
	terminalsEndedByDisconnect,
	terminalsEndedByReconnect,
	terminalsOutliveConnection,
} from "./host-connection.js";

const STDIO_UP = { connected: true, usedRemoteDaemon: false } as const;
const DAEMON_UP = { connected: true, usedRemoteDaemon: true } as const;
const DOWN = { connected: false, usedRemoteDaemon: false } as const;

function facts(fields: Partial<HostConnectionFacts>): HostConnectionFacts {
	return { agent: undefined, hostKeepsDaemon: false, liveTerminals: 3, ...fields };
}

describe("terminalsOutliveConnection (#648)", () => {
	it("goes by the connection that is up: a daemon keeps them, stdio does not", () => {
		expect(terminalsOutliveConnection(facts({ agent: DAEMON_UP }))).toBe(true);
		expect(terminalsOutliveConnection(facts({ agent: STDIO_UP }))).toBe(false);
	});

	it("believes that connection over the host's setting, which may have changed since", () => {
		expect(terminalsOutliveConnection(facts({ agent: STDIO_UP, hostKeepsDaemon: true }))).toBe(
			false,
		);
		expect(terminalsOutliveConnection(facts({ agent: DAEMON_UP, hostKeepsDaemon: false }))).toBe(
			true,
		);
	});

	it("goes by the setting when no connection is up", () => {
		expect(terminalsOutliveConnection(facts({ hostKeepsDaemon: true }))).toBe(true);
		expect(terminalsOutliveConnection(facts({ agent: DOWN, hostKeepsDaemon: true }))).toBe(true);
		expect(terminalsOutliveConnection(facts({ agent: DOWN }))).toBe(false);
	});
});

describe("terminalsEndedByDisconnect (#648)", () => {
	it("ends none that a daemon holds", () => {
		expect(terminalsEndedByDisconnect(facts({ agent: DAEMON_UP }))).toBe(0);
		expect(terminalsEndedByDisconnect(facts({ hostKeepsDaemon: true }))).toBe(0);
	});

	it("ends every one a connection on stdio runs", () => {
		expect(terminalsEndedByDisconnect(facts({ agent: STDIO_UP }))).toBe(3);
	});

	it("ends those a lost stdio link was going to start again", () => {
		expect(terminalsEndedByDisconnect(facts({ agent: DOWN }))).toBe(3);
		expect(terminalsEndedByDisconnect(facts({}))).toBe(3);
	});

	it("ends nothing where there is nothing", () => {
		expect(terminalsEndedByDisconnect(facts({ agent: STDIO_UP, liveTerminals: 0 }))).toBe(0);
	});
});

describe("terminalsEndedByReconnect (#648)", () => {
	it("ends those of a stdio connection it closes first", () => {
		expect(terminalsEndedByReconnect(facts({ agent: STDIO_UP }))).toBe(3);
	});

	it("ends none that a daemon holds", () => {
		expect(terminalsEndedByReconnect(facts({ agent: DAEMON_UP }))).toBe(0);
	});

	it("ends none when no connection is up: there is nothing to close", () => {
		expect(terminalsEndedByReconnect(facts({}))).toBe(0);
		expect(terminalsEndedByReconnect(facts({ agent: DOWN }))).toBe(0);
	});
});
