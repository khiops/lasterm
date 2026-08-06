import type {
	AgentFetchDoneMessage,
	AgentFetchErrorMessage,
	AgentFetchProgressMessage,
	AgentFetchProgressPhase,
	HostArch,
	HostOs,
} from "@lasterm/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { hubBaseUrl } from "../utils/hub-url.js";
import { useAuthStore } from "./auth.js";

export type AgentTargetStatus =
	| "bundled"
	| "error"
	| "cached"
	| "stale"
	| "missing"
	| "untrusted"
	| "unsupported";

export interface AgentTarget {
	os: HostOs;
	arch: HostArch;
	triple: string | null;
	status: AgentTargetStatus;
	version?: string;
	expectedVersion?: string;
	size?: number;
	mtime?: string;
}

export interface AgentFetchJob {
	jobId: string;
	os: HostOs;
	arch: HostArch;
	downloaded: number;
	total?: number;
	phase: AgentFetchProgressPhase;
}

export interface AgentFetchTerminalError {
	jobId: string;
	code: string;
	message: string;
}

export interface AgentImportInput {
	binary: File;
	manifest: File;
	os: HostOs;
	arch: HostArch;
	version: string;
	attested: boolean;
}

export interface AgentImportResult {
	code?: string;
	message?: string;
	verified?: boolean;
	path?: string;
	version?: string;
}

interface AgentTargetWire {
	os: HostOs;
	arch: HostArch;
	triple: string | null;
	status: AgentTargetStatus;
	version?: string;
	expected_version?: string;
	size?: number;
	mtime?: string;
}

interface AgentTargetsResponseWire {
	hub_version?: string;
	targets?: AgentTargetWire[];
}

interface AgentFetchSnapshotWire {
	downloaded?: number;
	total?: number;
	phase?: AgentFetchProgressPhase;
}

interface AgentErrorWire {
	code?: string;
	message?: string;
}

type AgentFetchTerminalMessage = AgentFetchDoneMessage | AgentFetchErrorMessage;

interface BufferedAgentFetchTerminal {
	readonly message: AgentFetchTerminalMessage;
	readonly receivedAt: number;
}

const AGENT_FETCH_TERMINAL_BUFFER_TTL_MS = 30_000;
const AGENT_FETCH_TERMINAL_BUFFER_MAX = 32;

export function agentTargetKey(os: HostOs, arch: HostArch): string {
	return `${os}:${arch}`;
}

function authHeaders(): Record<string, string> {
	const token = useAuthStore().token;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

function requireAuthHeaders(): Record<string, string> {
	const headers = authHeaders();
	if (!headers.Authorization) {
		throw new Error("Authentication token missing");
	}
	return headers;
}

function normalizeTarget(raw: AgentTargetWire): AgentTarget {
	const target: AgentTarget = {
		os: raw.os,
		arch: raw.arch,
		triple: raw.triple,
		status: raw.status,
	};
	if (raw.version !== undefined) target.version = raw.version;
	if (raw.expected_version !== undefined) target.expectedVersion = raw.expected_version;
	if (raw.size !== undefined) target.size = raw.size;
	if (raw.mtime !== undefined) target.mtime = raw.mtime;
	return target;
}

function messageFromUnknown(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function readResponseBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		try {
			return await response.text();
		} catch {
			return null;
		}
	}
}

async function responseErrorMessage(response: Response): Promise<string> {
	const body = await readResponseBody(response);
	const error = unwrapAgentError(body);
	if (error.code && error.message) return `${error.code}: ${error.message}`;
	if (error.message) return error.message;
	if (typeof body === "string" && body.length > 0) return body;
	const message = asRecord(body).message;
	if (typeof message === "string" && message.length > 0) return message;
	return `${response.status} ${response.statusText}`.trim();
}

function unwrapAgentError(body: unknown): AgentErrorWire {
	const record = asRecord(body);
	const nested = asRecord(record.error);
	const result: AgentErrorWire = {};
	if (typeof nested.code === "string") result.code = nested.code;
	else if (typeof record.code === "string") result.code = record.code;
	if (typeof nested.message === "string") result.message = nested.message;
	else if (typeof record.message === "string") result.message = record.message;
	return result;
}

function normalizeImportResult(body: unknown): AgentImportResult {
	const record = asRecord(body);
	const error = unwrapAgentError(body);
	const result: AgentImportResult = {};
	if (error.code !== undefined) result.code = error.code;
	if (error.message !== undefined) result.message = error.message;
	if (typeof record.verified === "boolean") result.verified = record.verified;
	if (typeof record.path === "string") result.path = record.path;
	if (typeof record.version === "string") result.version = record.version;
	return result;
}

function normalizeFetchSnapshot(value: unknown): AgentFetchSnapshotWire | undefined {
	const record = asRecord(value);
	const snapshot: AgentFetchSnapshotWire = {};
	if (typeof record.downloaded === "number") snapshot.downloaded = record.downloaded;
	if (typeof record.total === "number") snapshot.total = record.total;
	if (record.phase === "download" || record.phase === "verify") snapshot.phase = record.phase;
	return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export const useAgentManagerStore = defineStore("agentManager", () => {
	const hubVersion = ref<string | null>(null);
	const targets = ref<AgentTarget[]>([]);
	const loading = ref(false);
	const lastError = ref<string | null>(null);
	const lastFetchError = ref<AgentFetchTerminalError | null>(null);
	const jobsById = ref<Record<string, AgentFetchJob>>({});
	const targetJobIds = ref<Record<string, string>>({});
	const bufferedFetchTerminals = new Map<string, BufferedAgentFetchTerminal>();

	const inFlightCount = computed(() => Object.keys(jobsById.value).length);

	function setJob(job: AgentFetchJob): void {
		jobsById.value = { ...jobsById.value, [job.jobId]: job };
		targetJobIds.value = {
			...targetJobIds.value,
			[agentTargetKey(job.os, job.arch)]: job.jobId,
		};
	}

	function removeJob(jobId: string): void {
		const job = jobsById.value[jobId];
		if (!job) return;

		const nextJobs = { ...jobsById.value };
		delete nextJobs[jobId];
		jobsById.value = nextJobs;

		const key = agentTargetKey(job.os, job.arch);
		if (targetJobIds.value[key] === jobId) {
			const nextTargetJobs = { ...targetJobIds.value };
			delete nextTargetJobs[key];
			targetJobIds.value = nextTargetJobs;
		}
	}

	function progressFor(os: HostOs, arch: HostArch): AgentFetchJob | null {
		const jobId = targetJobIds.value[agentTargetKey(os, arch)];
		return jobId ? (jobsById.value[jobId] ?? null) : null;
	}

	function isTargetInFlight(os: HostOs, arch: HostArch): boolean {
		return progressFor(os, arch) !== null;
	}

	function pruneBufferedFetchTerminals(now = Date.now()): void {
		for (const [jobId, entry] of bufferedFetchTerminals) {
			if (now - entry.receivedAt > AGENT_FETCH_TERMINAL_BUFFER_TTL_MS) {
				bufferedFetchTerminals.delete(jobId);
			}
		}

		while (bufferedFetchTerminals.size > AGENT_FETCH_TERMINAL_BUFFER_MAX) {
			const oldestJobId = bufferedFetchTerminals.keys().next().value;
			if (oldestJobId === undefined) return;
			bufferedFetchTerminals.delete(oldestJobId);
		}
	}

	function bufferFetchTerminal(message: AgentFetchTerminalMessage): void {
		const now = Date.now();
		pruneBufferedFetchTerminals(now);
		bufferedFetchTerminals.delete(message.jobId);
		bufferedFetchTerminals.set(message.jobId, { message, receivedAt: now });
		pruneBufferedFetchTerminals(now);
	}

	function applyFetchTerminal(message: AgentFetchTerminalMessage): void {
		if (message.type === "AGENT_FETCH_ERROR") {
			lastFetchError.value = {
				jobId: message.jobId,
				code: message.code,
				message: message.message,
			};
		}
		removeJob(message.jobId);
		void loadTargets();
	}

	function replayBufferedFetchTerminal(jobId: string): void {
		pruneBufferedFetchTerminals();
		const entry = bufferedFetchTerminals.get(jobId);
		if (!entry) return;

		bufferedFetchTerminals.delete(jobId);
		applyFetchTerminal(entry.message);
	}

	async function loadTargets(): Promise<void> {
		const headers = authHeaders();
		if (!headers.Authorization) return;

		loading.value = true;
		try {
			const response = await fetch(`${hubBaseUrl()}/api/agents/targets`, { headers });
			if (!response.ok) {
				throw new Error(`Failed to load agent targets: ${await responseErrorMessage(response)}`);
			}
			const body = (await response.json()) as AgentTargetsResponseWire;
			hubVersion.value = body.hub_version ?? null;
			targets.value = (body.targets ?? []).map(normalizeTarget);
			lastError.value = null;
		} catch (error) {
			lastError.value = messageFromUnknown(error);
			throw error;
		} finally {
			loading.value = false;
		}
	}

	function recordAcceptedFetch(
		os: HostOs,
		arch: HostArch,
		jobId: string,
		snapshot?: AgentFetchSnapshotWire,
	): void {
		const job: AgentFetchJob = {
			jobId,
			os,
			arch,
			downloaded: snapshot?.downloaded ?? 0,
			phase: snapshot?.phase ?? "download",
		};
		if (snapshot?.total !== undefined) job.total = snapshot.total;
		setJob(job);
		replayBufferedFetchTerminal(jobId);
	}

	async function fetchTarget(
		os: HostOs,
		arch: HostArch,
		version?: string,
	): Promise<{ status: "already_cached" } | { status: "accepted"; jobId: string }> {
		const body: { os: HostOs; arch: HostArch; version?: string } = { os, arch };
		if (version !== undefined) body.version = version;

		const response = await fetch(`${hubBaseUrl()}/api/agents/fetch`, {
			method: "POST",
			headers: {
				...requireAuthHeaders(),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch agent target: ${await responseErrorMessage(response)}`);
		}

		const responseBody = asRecord(await response.json());
		if (response.status === 200 && responseBody.status === "already_cached") {
			await loadTargets();
			return { status: "already_cached" };
		}

		if (response.status === 202 && typeof responseBody.job_id === "string") {
			recordAcceptedFetch(
				os,
				arch,
				responseBody.job_id,
				normalizeFetchSnapshot(responseBody.snapshot),
			);
			return { status: "accepted", jobId: responseBody.job_id };
		}

		throw new Error(`Unexpected agent fetch response: ${response.status}`);
	}

	async function fetchAllMissing(): Promise<
		({ status: "already_cached" } | { status: "accepted"; jobId: string })[]
	> {
		const candidates = targets.value.filter(
			(target) =>
				target.triple !== null &&
				(target.status === "missing" ||
					target.status === "stale" ||
					target.status === "untrusted") &&
				!isTargetInFlight(target.os, target.arch),
		);

		const settled = await Promise.allSettled(
			candidates.map((target) => fetchTarget(target.os, target.arch)),
		);
		const rejected = settled.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejected) throw rejected.reason;
		return settled.map(
			(result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof fetchTarget>>>).value,
		);
	}

	async function pruneStale(): Promise<number> {
		const response = await fetch(`${hubBaseUrl()}/api/agents/prune`, {
			method: "POST",
			headers: {
				...requireAuthHeaders(),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({}),
		});

		if (!response.ok) {
			throw new Error(`Failed to prune stale agents: ${await responseErrorMessage(response)}`);
		}
		const body = (await response.json()) as { removed?: number };
		await loadTargets();
		return body.removed ?? 0;
	}

	async function importAgent(input: AgentImportInput): Promise<AgentImportResult> {
		const form = new FormData();
		form.append("os", input.os);
		form.append("arch", input.arch);
		form.append("version", input.version);
		form.append("attested", input.attested ? "true" : "false");
		form.append("binary", input.binary);
		form.append("manifest", input.manifest);

		const response = await fetch(`${hubBaseUrl()}/api/agents/import`, {
			method: "POST",
			headers: requireAuthHeaders(),
			body: form,
		});

		const result = normalizeImportResult(await readResponseBody(response));
		if (response.ok) {
			if (result.verified === undefined) result.verified = true;
			await loadTargets();
			return result;
		}
		return result;
	}

	function handleAgentFetchProgress(message: AgentFetchProgressMessage): void {
		const current = jobsById.value[message.jobId];
		if (!current) return;

		const next: AgentFetchJob = {
			...current,
			os: message.os,
			arch: message.arch,
			downloaded: message.downloaded,
			phase: message.phase,
		};
		if (message.total !== undefined) next.total = message.total;
		setJob(next);
	}

	function handleAgentFetchDone(message: AgentFetchDoneMessage): void {
		if (!jobsById.value[message.jobId]) {
			bufferFetchTerminal(message);
			void loadTargets();
			return;
		}
		applyFetchTerminal(message);
	}

	function handleAgentFetchError(message: AgentFetchErrorMessage): void {
		if (!jobsById.value[message.jobId]) {
			bufferFetchTerminal(message);
			void loadTargets();
			return;
		}
		applyFetchTerminal(message);
	}

	function clearLastFetchError(): void {
		lastFetchError.value = null;
	}

	return {
		hubVersion,
		targets,
		loading,
		lastError,
		lastFetchError,
		jobsById,
		targetJobIds,
		inFlightCount,
		loadTargets,
		fetchTarget,
		fetchAllMissing,
		pruneStale,
		importAgent,
		progressFor,
		isTargetInFlight,
		handleAgentFetchProgress,
		handleAgentFetchDone,
		handleAgentFetchError,
		clearLastFetchError,
	};
});
