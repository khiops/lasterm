/**
 * An agent older than this hub is replaced once it holds none of this hub's
 * terminals (#805).
 *
 * Nothing else ends one. A local daemon has no idle exit, and a remote one
 * exits on its own only while no hub is connected, which a hub that reaches it
 * never allows. After an update, the previous agent kept serving every new
 * terminal, local ones included, until Quit completely.
 *
 * Replacing an agent ends what it holds: a PTY belongs to the process that
 * opened it. So this waits until this hub holds nothing there, and asks the
 * daemon without `force`: one where other hubs hold terminals refuses, and is
 * kept (#127). A daemon newer than this hub, or as new, is never touched: two
 * hubs of different versions can share the local one.
 */
import { HUB_VERSION } from "../build-version.js";
import type { AgentConnection } from "./agent-connection.js";
import { type DaemonStopOutcome, requestDaemonStop } from "./daemon-stop.js";
import type { SharedSessionContext } from "./session-context.js";

/** A version as semver orders it; null for what is not one. */
interface Semver {
	readonly core: readonly [number, number, number];
	readonly prerelease: readonly string[];
}

const SEMVER =
	/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version: string): Semver | null {
	const match = SEMVER.exec(version.trim());
	if (match === null) return null;
	const [, major, minor, patch, prerelease] = match;
	return {
		core: [Number(major), Number(minor), Number(patch)],
		prerelease: prerelease === undefined ? [] : prerelease.split("."),
	};
}

/** semver § 11: numeric identifiers by value, before alphanumeric ones, those in ASCII order. */
function compareIdentifiers(a: string, b: string): number {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) return Number(a) - Number(b);
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareSemver(a: Semver, b: Semver): number {
	for (let i = 0; i < 3; i++) {
		const difference = (a.core[i] ?? 0) - (b.core[i] ?? 0);
		if (difference !== 0) return difference;
	}
	// A pre-release comes before its release.
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return b.prerelease.length - a.prerelease.length;
	}
	const length = Math.max(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < length; i++) {
		const x = a.prerelease[i];
		const y = b.prerelease[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const difference = compareIdentifiers(x, y);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * Whether `running` comes strictly before `expected` in semver order. False
 * when either is not a version: an agent this hub cannot place is not one it
 * knows to be older, and is left alone.
 */
export function isOlderVersion(running: string, expected: string): boolean {
	const a = parseSemver(running);
	const b = parseSemver(expected);
	if (a === null || b === null) return false;
	return compareSemver(a, b) < 0;
}

/** What came of replacing a host's agent. */
export type RetirementOutcome =
	/**
	 * The daemon stopped, and this hub let go of it. On the local host the
	 * agent beside the hub was started in its place, when the host still had a
	 * session for it to serve; elsewhere the next connection starts it.
	 */
	| { readonly kind: "retired" }
	/** Other hubs hold terminals there, and the daemon said so: it is kept. */
	| {
			readonly kind: "refused";
			readonly message: string;
			readonly otherOwnerChannels: number | null;
	  }
	/** The stop was not confirmed, whatever the reason: the agent is kept. */
	| { readonly kind: "unconfirmed"; readonly reason: string };

/** What the retirement needs of the session manager. */
export interface RetirementHost {
	/** Stop reaching the host through `agent`, if it still is the way to. */
	release(hostId: string, agent: AgentConnection): void;
	/** Start the local agent beside the hub for that session. Never rejects. */
	startLocalAgent(hostId: string, sessionId: string): Promise<void>;
}

type StoppableAgent = AgentConnection & {
	closedByHub?: boolean;
	usedRemoteDaemon?: boolean;
};

export class AgentRetirement {
	/** hostId → the retirement under way there. */
	private readonly underWay = new Map<string, Promise<RetirementOutcome>>();
	/** hostId → how many terminal starts are past the point of no return there. */
	private readonly starts = new Map<string, number>();
	/**
	 * hostId → the version last retired there. An agent of that version found
	 * again is not stopped again: what replaced it is no newer, a binary beside
	 * a development hub built from an older tree, and stopping it would only
	 * start it once more.
	 */
	private readonly retiredVersions = new Map<string, string>();

	constructor(
		private readonly ctx: SharedSessionContext,
		private readonly host: RetirementHost,
	) {}

	/**
	 * Whether a retirement is under way on this host. Checked before awaiting
	 * {@link settled}, so that a caller with nothing to wait for goes on in the
	 * same turn, as it did before there was anything to wait for.
	 */
	isUnderWay(hostId: string): boolean {
		return this.underWay.has(hostId);
	}

	/** Resolves once no retirement is under way on this host. */
	async settled(hostId: string): Promise<void> {
		for (let pending = this.underWay.get(hostId); pending; pending = this.underWay.get(hostId)) {
			await pending;
		}
	}

	/**
	 * A terminal is about to start on this host: no retirement begins there
	 * until the returned function is called, which may be called more than
	 * once. Called with nothing awaited since the agent it starts on was
	 * chosen. Its end is also when this hub may have stopped holding anything
	 * there, if the start failed.
	 */
	startOn(hostId: string): () => void {
		this.starts.set(hostId, (this.starts.get(hostId) ?? 0) + 1);
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			const left = (this.starts.get(hostId) ?? 1) - 1;
			if (left > 0) {
				this.starts.set(hostId, left);
				return;
			}
			this.starts.delete(hostId);
			void this.retireIfIdle(hostId);
		};
	}

	/** Whether a terminal is starting on this host. */
	isStarting(hostId: string): boolean {
		return (this.starts.get(hostId) ?? 0) > 0;
	}

	/** Whether an agent of this version was stopped on this host already. */
	wasRetired(hostId: string, version: string): boolean {
		return this.retiredVersions.get(hostId) === version;
	}

	/**
	 * Replace this host's agent if it is older than this hub and this hub
	 * holds nothing there. Returns the retirement under way there, one begun
	 * now, or null when there is nothing to do. Never rejects.
	 */
	retireIfIdle(hostId: string): Promise<RetirementOutcome> | null {
		const underWay = this.underWay.get(hostId);
		if (underWay !== undefined) return underWay;
		const agent = this.ctx.agents.get(hostId);
		if (agent === undefined || !this.qualifies(hostId, agent)) return null;
		return this.begin(hostId, agent, false);
	}

	/**
	 * Stop an agent the hub has just let go of with its session (DELETE
	 * /api/sessions/:id), rather than leave a daemon older than the hub running
	 * with nothing to do. True when it took charge of the connection: it then
	 * closes it whatever the outcome. False when it does not apply, and the
	 * caller closes it as before.
	 */
	retireDetached(hostId: string, agent: AgentConnection): boolean {
		if (this.underWay.has(hostId) || !this.qualifies(hostId, agent)) return false;
		void this.begin(hostId, agent, true);
		return true;
	}

	/**
	 * Every condition but the agent's being the host's: it is when called
	 * through retireIfIdle, and was until a moment ago through retireDetached.
	 */
	private qualifies(hostId: string, agent: StoppableAgent): boolean {
		if (this.ctx.quitState === "QUITTING") return false;
		// Someone is stopping it already: Replace, or Stop keeping an agent here.
		if (this.ctx.stoppingAgents.has(hostId)) return false;
		if (this.isStarting(hostId)) return false;
		if (!agent.connected) return false;
		const running = agent.helloMessage?.agentVersion;
		if (running === undefined || !isOlderVersion(running, HUB_VERSION)) return false;
		if (this.wasRetired(hostId, running)) return false;
		const host = this.ctx.metaDal.getHost(hostId);
		// An agent on stdio is replaced at every connection already, and ends
		// with it: there is no daemon to stop.
		const daemon =
			host?.type === "local" || (host?.type === "ssh" && agent.usedRemoteDaemon === true);
		if (!daemon) return false;
		for (const channel of this.ctx.channels.values()) {
			if (channel.hostId === hostId && channel.status !== "dead") return false;
		}
		return true;
	}

	private begin(
		hostId: string,
		agent: StoppableAgent,
		detached: boolean,
	): Promise<RetirementOutcome> {
		// The fence first, with nothing awaited since the checks: a start that
		// comes now waits for the retirement, and lands on what replaces it.
		this.ctx.stoppingAgents.add(hostId);
		let settle!: (outcome: RetirementOutcome) => void;
		const retirement = new Promise<RetirementOutcome>((resolve) => {
			settle = resolve;
		});
		this.underWay.set(hostId, retirement);
		void this.retire(hostId, agent, detached)
			.catch((error: unknown): RetirementOutcome => {
				this.ctx.hubLogger?.log("warn", "agent-retirement: failed", {
					hostId,
					message: error instanceof Error ? error.message : String(error),
				});
				return { kind: "unconfirmed", reason: "failed" };
			})
			.then((outcome) => {
				// Gone from the map before anyone waiting hears of it, so that what
				// they do next finds no retirement under way.
				if (this.underWay.get(hostId) === retirement) this.underWay.delete(hostId);
				settle(outcome);
			});
		return retirement;
	}

	private async retire(
		hostId: string,
		agent: StoppableAgent,
		detached: boolean,
	): Promise<RetirementOutcome> {
		const running = agent.helloMessage?.agentVersion ?? "";
		this.ctx.hubLogger?.log("info", "agent-retirement: stopping an agent older than this hub", {
			hostId,
			agentVersion: running,
			hubVersion: HUB_VERSION,
		});
		let outcome: RetirementOutcome;
		try {
			const stop = await requestDaemonStop(agent, {
				force: false,
				isHubQuitting: () => this.ctx.quitState === "QUITTING",
				// Let go first, so that the close is read as a stop that was asked
				// for, not as a link that dropped and should be dialled again.
				onStopped: () => {
					agent.closedByHub = true;
					this.host.release(hostId, agent);
				},
			});
			outcome = retirementOutcome(stop);
		} finally {
			this.ctx.stoppingAgents.delete(hostId);
		}

		if (outcome.kind !== "retired") {
			this.ctx.hubLogger?.log("info", "agent-retirement: the agent is kept", {
				hostId,
				agentVersion: running,
				...(outcome.kind === "refused"
					? { otherOwnerChannels: outcome.otherOwnerChannels }
					: { reason: outcome.reason }),
			});
			// Let go of with its session: its connection goes as it would have.
			if (detached) void agent.close();
			return outcome;
		}

		this.retiredVersions.set(hostId, running);
		this.ctx.hubLogger?.log("info", "agent-retirement: the agent stopped", {
			hostId,
			agentVersion: running,
		});
		// The local host is served by the agent beside the hub, started now: it
		// is what the next terminal there needs, and a failure to start it is
		// better found here than by that terminal. A remote host gets the
		// current agent with its next connection, which deploys it: reaching
		// it now could mean asking someone for a passphrase out of nowhere.
		const session = this.ctx.sessions.get(hostId);
		if (
			!detached &&
			session !== undefined &&
			this.ctx.quitState !== "QUITTING" &&
			this.ctx.metaDal.getHost(hostId)?.type === "local"
		) {
			await this.host.startLocalAgent(hostId, session.id);
		}
		return outcome;
	}
}

function retirementOutcome(stop: DaemonStopOutcome): RetirementOutcome {
	switch (stop.kind) {
		case "stopped":
			return { kind: "retired" };
		case "refused":
			return {
				kind: "refused",
				message: stop.message,
				otherOwnerChannels: stop.otherOwnerChannels,
			};
		case "error":
			return { kind: "unconfirmed", reason: `${stop.code}: ${stop.message}` };
		case "unsent":
			return { kind: "unconfirmed", reason: `unsent: ${stop.message}` };
		default:
			return { kind: "unconfirmed", reason: stop.kind };
	}
}
