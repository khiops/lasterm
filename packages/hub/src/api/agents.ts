import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentFetchDoneMessage,
	AgentFetchErrorMessage,
	AgentFetchProgressMessage,
} from "@lasterm/shared";
import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { touchToken, validateTokenRecord } from "../auth.js";
import { HUB_VERSION } from "../build-version.js";
import {
	AGENT_FETCH_MANIFEST_MAX_BYTES,
	AGENT_FETCH_MAX_BYTES,
	createUniqueTempPath,
	ensureCacheDir,
	FetchError,
	pruneAgentBinaryCache,
	type ResolvedTarget,
	removeFileIfPresent,
	resolveTarget,
	validateAgentVersion,
	verifyAndPlace,
} from "../session/agent-cache.js";
import { getBinaryCacheDir as defaultGetBinaryCacheDir } from "../session/agent-deployer.js";
import { type AgentFetchImpl, fetchAgentBinary } from "../session/agent-fetch.js";
import {
	type AgentTargetArch,
	type AgentTargetOs,
	type AgentVersionReader,
	type ComputeTargetStatusOptions,
	computeTargetStatus,
	getHubPlatform,
} from "../session/agent-status.js";

export interface AgentRoutesDeps extends AgentMutationOriginGuardOptions {
	readonly authToken?: string | null;
	readonly db?: Database.Database | null;
	readonly tokenTtlDays?: number;
	readonly getBinaryCacheDir?: () => string | Promise<string>;
	readonly hubVersion?: string;
	readonly versionReader?: AgentVersionReader;
	readonly resolveAgentBinaryPath?: () => string | null;
	readonly hubPlatform?: ComputeTargetStatusOptions["hubPlatform"];
	readonly fetchImpl?: AgentFetchImpl;
	readonly broadcastAgentFetchMessage?: (message: AgentFetchMessage) => void;
}

export interface AgentMutationOriginGuardOptions {
	readonly allowedOrigins?: Iterable<string> | (() => Iterable<string>);
	readonly isOriginAllowed?: (origin: string) => boolean;
}

type AgentPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type AgentFetchMessage =
	| AgentFetchProgressMessage
	| AgentFetchDoneMessage
	| AgentFetchErrorMessage;

type AgentFetchPhase = AgentFetchProgressMessage["phase"];

interface AgentFetchSnapshot {
	os: AgentTargetOs;
	arch: AgentTargetArch;
	downloaded: number;
	total?: number;
	phase: AgentFetchPhase;
}

interface AgentFetchJob {
	readonly id: string;
	readonly targetKey: string;
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly version: string;
	readonly cacheDir: string;
	snapshot: AgentFetchSnapshot;
}

interface AgentFetchRequestBody {
	readonly os?: unknown;
	readonly arch?: unknown;
	readonly version?: unknown;
}

interface AgentPruneRequestBody {
	readonly version?: unknown;
}

interface AgentImportFields {
	os?: string;
	arch?: string;
	version?: string;
	attested?: string;
	force?: string;
}

interface AgentImportValidation {
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly version: string;
	readonly target: ResolvedTarget;
	readonly force: boolean;
}

interface MultipartFilePart {
	readonly type: "file";
	readonly fieldname: string;
	readonly file: AsyncIterable<Buffer | string> & {
		readonly truncated?: boolean;
		destroy?: (error?: Error) => void;
	};
}

interface MultipartFieldPart {
	readonly type: "field";
	readonly fieldname: string;
	readonly value: unknown;
	readonly valueTruncated?: boolean;
}

type MultipartPart = MultipartFilePart | MultipartFieldPart;

const AGENT_FETCH_GLOBAL_CONCURRENCY = 2;
const AGENT_IMPORT_FIELD_MAX_BYTES = 256;
const AGENT_IMPORT_MAX_FIELDS = 5;
const AGENT_IMPORT_MAX_FILES = 2;
const AGENT_IMPORT_MAX_PARTS = AGENT_IMPORT_MAX_FIELDS + AGENT_IMPORT_MAX_FILES;
const AGENT_IMPORT_MAX_PAYLOAD_BYTES =
	AGENT_FETCH_MAX_BYTES + AGENT_FETCH_MANIFEST_MAX_BYTES + AGENT_IMPORT_FIELD_MAX_BYTES * 5;
const AGENT_IMPORT_ALLOWED_FIELDS = new Set(["os", "arch", "version", "attested", "force"]);

export function registerAgentRoutes(server: FastifyInstance, deps: AgentRoutesDeps = {}): void {
	const requireBearer = createAgentBearerAuthGuard(deps);
	const requireMutationOrigin = createAgentMutationOriginGuard(deps);
	const jobsByTarget = new Map<string, AgentFetchJob>();
	const queuedJobs: AgentFetchJob[] = [];
	let runningJobs = 0;

	server.get(
		"/api/agents/targets",
		{ preHandler: requireBearer },
		async (_request: FastifyRequest, reply: FastifyReply) => {
			try {
				const cacheDir = deps.getBinaryCacheDir ? await deps.getBinaryCacheDir() : undefined;
				const status = await computeTargetStatus({
					...(cacheDir !== undefined && { cacheDir }),
					...(deps.hubVersion !== undefined && { hubVersion: deps.hubVersion }),
					...(deps.versionReader !== undefined && { versionReader: deps.versionReader }),
					...(deps.resolveAgentBinaryPath !== undefined && {
						resolveAgentBinaryPath: deps.resolveAgentBinaryPath,
					}),
					...(deps.hubPlatform !== undefined && { hubPlatform: deps.hubPlatform }),
				});
				return reply.code(200).send(status);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return reply.code(500).send({
					error: {
						code: "AGENT_STATUS_ERROR",
						message,
					},
				});
			}
		},
	);

	server.post<{ Body: AgentPruneRequestBody }>(
		"/api/agents/prune",
		{ preHandler: [requireBearer, requireMutationOrigin] },
		async (request, reply) => {
			const versionValue =
				request.body?.version === undefined
					? (deps.hubVersion ?? HUB_VERSION)
					: request.body.version;
			const version = typeof versionValue === "string" ? versionValue : String(versionValue);
			try {
				validateAgentVersion(version);
			} catch (error) {
				if (error instanceof FetchError) {
					return sendError(reply, 400, error.code, error.message);
				}
				throw error;
			}

			const cacheDir = await resolveBinaryCacheDir(deps);
			const removed = pruneAgentBinaryCache(cacheDir, version);
			return reply.code(200).send({ removed });
		},
	);

	server.post(
		"/api/agents/import",
		{
			preHandler: [requireBearer, requireMutationOrigin],
			config: {
				multipartOptions: agentImportMultipartLimits(),
			},
			bodyLimit: AGENT_IMPORT_MAX_PAYLOAD_BYTES + 16 * 1024,
		},
		async (request, reply) => {
			let tempPath: string | null = null;
			let success = false;
			const cleanupTemp = () => {
				if (!success && tempPath) removeFileIfPresent(tempPath);
			};
			request.raw.once("aborted", cleanupTemp);

			try {
				const result = await readAgentImportMultipart(request, deps, (path) => {
					tempPath = path;
				});
				const placed = verifyAndPlace(
					result.tempPath,
					result.expectedBasename,
					result.manifestContent,
					result.cacheDir,
					{ force: result.force },
				);
				success = true;
				return reply.code(200).send({
					path: placed,
					version: result.version,
					verified: true,
				});
			} catch (error) {
				if (error instanceof RouteError) {
					return sendError(reply, error.statusCode, error.code, error.message);
				}
				if (error instanceof FetchError) {
					const mapped = mapAgentImportFetchError(error);
					return sendError(reply, mapped.statusCode, mapped.code, error.message);
				}
				const multipart = mapMultipartError(error);
				if (multipart)
					return sendError(reply, multipart.statusCode, multipart.code, multipart.message);
				const message = error instanceof Error ? error.message : String(error);
				return sendError(reply, 500, "DISK", message);
			} finally {
				request.raw.off("aborted", cleanupTemp);
				cleanupTemp();
			}
		},
	);

	server.post<{ Body: AgentFetchRequestBody }>(
		"/api/agents/fetch",
		{ preHandler: [requireBearer, requireMutationOrigin] },
		async (request, reply) => {
			const body = request.body;
			const os = typeof body?.os === "string" ? body.os : "";
			const arch = typeof body?.arch === "string" ? body.arch : "";
			const target = resolveTarget(os, arch);
			if (!target) {
				return sendError(
					reply,
					400,
					"UNSUPPORTED_TARGET",
					`No Lasterm agent release is built for ${os}/${arch}.`,
				);
			}

			const versionValue =
				body?.version === undefined ? (deps.hubVersion ?? HUB_VERSION) : body.version;
			const version = typeof versionValue === "string" ? versionValue : String(versionValue);

			try {
				validateAgentVersion(version);
			} catch (error) {
				if (error instanceof FetchError) {
					return sendError(reply, 400, error.code, error.message);
				}
				throw error;
			}

			const targetOs = os as AgentTargetOs;
			const targetArch = arch as AgentTargetArch;
			const hubPlatform =
				deps.hubPlatform === undefined
					? getHubPlatform(process.platform, process.arch)
					: deps.hubPlatform;
			if (hubPlatform?.os === targetOs && hubPlatform.arch === targetArch) {
				return sendError(
					reply,
					400,
					"BUNDLED_TARGET",
					`The hub platform target ${targetOs}/${targetArch} is served by the bundled agent and is not fetched into the cache.`,
				);
			}

			const targetKey = agentFetchTargetKey(targetOs, targetArch, version);
			const existingJob = jobsByTarget.get(targetKey);
			if (existingJob) {
				return reply.code(202).send({
					job_id: existingJob.id,
					snapshot: snapshotToWire(existingJob.snapshot),
				});
			}

			const cacheDir = await resolveBinaryCacheDir(deps);
			if (
				await isTargetCached({
					cacheDir,
					version,
					os: targetOs,
					arch: targetArch,
					deps,
					hubPlatform,
				})
			) {
				return reply.code(200).send({ status: "already_cached" });
			}

			const job: AgentFetchJob = {
				id: generateId(),
				targetKey,
				os: targetOs,
				arch: targetArch,
				version,
				cacheDir,
				snapshot: {
					os: targetOs,
					arch: targetArch,
					downloaded: 0,
					phase: "download",
				},
			};
			jobsByTarget.set(targetKey, job);
			queuedJobs.push(job);

			reply.raw.once("finish", () => {
				setImmediate(drainFetchQueue);
			});
			return reply.code(202).send({
				job_id: job.id,
				snapshot: snapshotToWire(job.snapshot),
			});
		},
	);

	function drainFetchQueue(): void {
		while (runningJobs < AGENT_FETCH_GLOBAL_CONCURRENCY) {
			const job = queuedJobs.shift();
			if (!job) return;
			runningJobs++;
			void runFetchJob(job).finally(() => {
				runningJobs--;
				jobsByTarget.delete(job.targetKey);
				drainFetchQueue();
			});
		}
	}

	async function runFetchJob(job: AgentFetchJob): Promise<void> {
		try {
			const path = await fetchAgentBinary({
				os: job.os,
				arch: job.arch,
				version: job.version,
				cacheDir: job.cacheDir,
				...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
				onProgress: (progress) => {
					job.snapshot = {
						os: job.os,
						arch: job.arch,
						downloaded: progress.downloaded,
						...(progress.total !== undefined && { total: progress.total }),
						phase: progress.phase,
					};
					broadcastAgentFetch({
						type: "AGENT_FETCH_PROGRESS",
						jobId: job.id,
						os: job.os,
						arch: job.arch,
						downloaded: progress.downloaded,
						...(progress.total !== undefined && { total: progress.total }),
						phase: progress.phase,
					});
				},
			});
			broadcastAgentFetch({ type: "AGENT_FETCH_DONE", jobId: job.id, path });
		} catch (error) {
			if (error instanceof FetchError) {
				broadcastAgentFetch({
					type: "AGENT_FETCH_ERROR",
					jobId: job.id,
					code: error.code,
					message: error.message,
				});
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			broadcastAgentFetch({
				type: "AGENT_FETCH_ERROR",
				jobId: job.id,
				code: "FETCH_FAILED",
				message,
			});
		}
	}

	function broadcastAgentFetch(message: AgentFetchMessage): void {
		try {
			deps.broadcastAgentFetchMessage?.(message);
		} catch (error) {
			server.log.warn({ err: error }, "agent-fetch: broadcast failed");
		}
	}
}

class RouteError extends Error {
	readonly statusCode: number;
	readonly code: string;

	constructor(statusCode: number, code: string, message: string) {
		super(message);
		this.name = "RouteError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

function agentImportMultipartLimits(): {
	readonly limits: {
		readonly fieldSize: number;
		readonly fields: number;
		readonly fileSize: number;
		readonly files: number;
		readonly parts: number;
		readonly headerPairs: number;
	};
} {
	return {
		limits: {
			fieldSize: AGENT_IMPORT_FIELD_MAX_BYTES,
			fields: AGENT_IMPORT_MAX_FIELDS,
			fileSize: AGENT_FETCH_MAX_BYTES,
			files: AGENT_IMPORT_MAX_FILES + 1,
			parts: AGENT_IMPORT_MAX_PARTS + 1,
			headerPairs: 32,
		},
	};
}

async function readAgentImportMultipart(
	request: FastifyRequest,
	deps: AgentRoutesDeps,
	setTempPath: (path: string) => void,
): Promise<{
	readonly tempPath: string;
	readonly expectedBasename: string;
	readonly manifestContent: string;
	readonly cacheDir: string;
	readonly version: string;
	readonly force: boolean;
}> {
	if (!request.isMultipart()) {
		throw new RouteError(400, "BAD_MULTIPART", "Expected multipart/form-data.");
	}

	const fields: AgentImportFields = {};
	let validation: AgentImportValidation | null = null;
	let cacheDir: string | null = null;
	let tempPath: string | null = null;
	let manifestContent: string | null = null;
	let totalPayloadBytes = 0;
	let fileCount = 0;
	let fieldCount = 0;
	let sawBinary = false;
	let sawManifest = false;

	const parts = request.parts(agentImportMultipartLimits()) as AsyncIterable<MultipartPart>;
	for await (const part of parts) {
		if (part.type === "field") {
			fieldCount++;
			if (fieldCount > AGENT_IMPORT_MAX_FIELDS) {
				throw new RouteError(400, "BAD_MULTIPART", "Too many import fields.");
			}
			totalPayloadBytes += recordImportField(fields, part);
			if (totalPayloadBytes > AGENT_IMPORT_MAX_PAYLOAD_BYTES) {
				throw new RouteError(413, "TOO_LARGE", "Agent import payload exceeds the size limit.");
			}
			continue;
		}

		fileCount++;
		if (fileCount > AGENT_IMPORT_MAX_FILES) {
			await drainFilePart(part);
			throw new RouteError(
				400,
				"BAD_MULTIPART",
				"Agent import expects exactly two file parts: binary and manifest.",
			);
		}

		if (part.fieldname === "manifest") {
			if (sawManifest) {
				await drainFilePart(part);
				throw new RouteError(400, "BAD_MULTIPART", "Duplicate manifest file part.");
			}
			const read = await readManifestPart(part);
			manifestContent = read.content;
			totalPayloadBytes += read.bytes;
			sawManifest = true;
		} else if (part.fieldname === "binary") {
			if (sawBinary) {
				await drainFilePart(part);
				throw new RouteError(400, "BAD_MULTIPART", "Duplicate binary file part.");
			}
			let binaryTempPath: string;
			try {
				cacheDir = await resolveBinaryCacheDir(deps);
				ensureCacheDir(cacheDir);
				binaryTempPath = createUniqueTempPath(join(cacheDir, "lasterm-agent-import"));
				tempPath = binaryTempPath;
				setTempPath(binaryTempPath);
			} catch (error) {
				await drainFilePart(part);
				throw error;
			}
			const written = await writeBinaryPartToTemp(part, binaryTempPath);
			totalPayloadBytes += written;
			sawBinary = true;
		} else {
			await drainFilePart(part);
			throw new RouteError(400, "BAD_MULTIPART", `Unexpected file part "${part.fieldname}".`);
		}

		if (totalPayloadBytes > AGENT_IMPORT_MAX_PAYLOAD_BYTES) {
			throw new RouteError(413, "TOO_LARGE", "Agent import payload exceeds the size limit.");
		}
	}

	if (fileCount !== AGENT_IMPORT_MAX_FILES || !sawBinary || !sawManifest) {
		throw new RouteError(
			400,
			"BAD_MULTIPART",
			"Agent import expects exactly two file parts: binary and manifest.",
		);
	}

	validation ??= validateAgentImportFields(fields, deps);
	if (!tempPath || manifestContent === null || !cacheDir) {
		throw new RouteError(400, "BAD_MULTIPART", "Agent import is missing required parts.");
	}
	const expectedBasename = releaseAssetBasename(validation.target, validation.version);

	return {
		tempPath,
		expectedBasename,
		manifestContent,
		cacheDir,
		version: validation.version,
		force: validation.force,
	};
}

function recordImportField(fields: AgentImportFields, part: MultipartFieldPart): number {
	if (!AGENT_IMPORT_ALLOWED_FIELDS.has(part.fieldname)) {
		throw new RouteError(400, "BAD_MULTIPART", `Unexpected import field "${part.fieldname}".`);
	}
	if (part.valueTruncated) {
		throw new RouteError(400, "BAD_MULTIPART", `Import field "${part.fieldname}" is too large.`);
	}
	if (Object.hasOwn(fields, part.fieldname)) {
		throw new RouteError(400, "BAD_MULTIPART", `Duplicate import field "${part.fieldname}".`);
	}
	const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
	fields[part.fieldname as keyof AgentImportFields] = value;
	return Buffer.byteLength(value);
}

function validateAgentImportFields(
	fields: AgentImportFields,
	deps: AgentRoutesDeps,
): AgentImportValidation {
	const os = fields.os ?? "";
	const arch = fields.arch ?? "";
	const target = resolveTarget(os, arch);
	if (!target) {
		throw new RouteError(
			400,
			"UNSUPPORTED_TARGET",
			`No Lasterm agent release is built for ${os}/${arch}.`,
		);
	}

	const version = fields.version ?? "";
	try {
		validateAgentVersion(version);
	} catch (error) {
		if (error instanceof FetchError) {
			throw new RouteError(400, error.code, error.message);
		}
		throw error;
	}

	if (fields.attested !== "true") {
		throw new RouteError(400, "ATTESTATION_REQUIRED", "Agent import requires attested: true.");
	}

	const targetOs = os as AgentTargetOs;
	const targetArch = arch as AgentTargetArch;
	const hubPlatform =
		deps.hubPlatform === undefined
			? getHubPlatform(process.platform, process.arch)
			: deps.hubPlatform;
	if (hubPlatform?.os === targetOs && hubPlatform.arch === targetArch) {
		throw new RouteError(
			400,
			"BUNDLED_TARGET",
			`The hub platform target ${targetOs}/${targetArch} is served by the bundled agent and is not imported into the cache.`,
		);
	}

	return {
		os: targetOs,
		arch: targetArch,
		version,
		target,
		force: fields.force === "true",
	};
}

function releaseAssetBasename(target: ResolvedTarget, version: string): string {
	return `lasterm-agent-${target.triple}-${version}${target.ext}`;
}

async function readManifestPart(
	part: MultipartFilePart,
): Promise<{ readonly content: string; readonly bytes: number }> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const rawChunk of part.file) {
		const chunk = toBuffer(rawChunk);
		bytes += chunk.byteLength;
		if (bytes > AGENT_FETCH_MANIFEST_MAX_BYTES) {
			part.file.destroy?.();
			throw new RouteError(
				413,
				"TOO_LARGE",
				`Checksum manifest exceeds the ${AGENT_FETCH_MANIFEST_MAX_BYTES} byte limit.`,
			);
		}
		chunks.push(chunk);
	}
	if (part.file.truncated) {
		throw new RouteError(
			413,
			"TOO_LARGE",
			`Checksum manifest exceeds the ${AGENT_FETCH_MANIFEST_MAX_BYTES} byte limit.`,
		);
	}
	return { content: Buffer.concat(chunks, bytes).toString("utf8"), bytes };
}

async function writeBinaryPartToTemp(part: MultipartFilePart, tempPath: string): Promise<number> {
	let fd: number | null = null;
	let written = 0;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		for await (const rawChunk of part.file) {
			const chunk = toBuffer(rawChunk);
			if (written + chunk.byteLength > AGENT_FETCH_MAX_BYTES) {
				part.file.destroy?.();
				throw new RouteError(
					413,
					"TOO_LARGE",
					"Uploaded agent binary exceeds the 64 MiB Lasterm agent limit.",
				);
			}
			let chunkOffset = 0;
			while (chunkOffset < chunk.byteLength) {
				chunkOffset += writeSync(fd, chunk, chunkOffset, chunk.byteLength - chunkOffset);
			}
			written += chunk.byteLength;
		}
		if (part.file.truncated) {
			throw new RouteError(
				413,
				"TOO_LARGE",
				"Uploaded agent binary exceeds the 64 MiB Lasterm agent limit.",
			);
		}
		return written;
	} catch (error) {
		removeFileIfPresent(tempPath);
		throw error;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

async function drainFilePart(part: MultipartFilePart): Promise<void> {
	for await (const _chunk of part.file) {
		// Drain so the multipart parser can finish before the route responds.
	}
}

function toBuffer(chunk: Buffer | string): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function mapAgentImportFetchError(error: FetchError): {
	readonly statusCode: number;
	readonly code: string;
} {
	if (error.policyCode === "INSECURE_CACHE_DIR") {
		return { statusCode: 409, code: "INSECURE_CACHE_DIR" };
	}
	if (error.code === "CHECKSUM_MISMATCH" || error.code === "CHECKSUM_MISSING") {
		return { statusCode: 422, code: error.code };
	}
	if (error.code === "ALREADY_CURRENT") {
		return { statusCode: 409, code: error.code };
	}
	if (error.code === "TOO_LARGE") {
		return { statusCode: 413, code: error.code };
	}
	if (error.code === "BAD_VERSION" || error.code === "UNSUPPORTED_TARGET") {
		return { statusCode: 400, code: error.code };
	}
	return { statusCode: 500, code: "DISK" };
}

function mapMultipartError(
	error: unknown,
): { readonly statusCode: number; readonly code: string; readonly message: string } | null {
	if (!(error instanceof Error)) return null;
	const code = "code" in error ? String(error.code) : "";
	if (code === "FST_REQ_FILE_TOO_LARGE") {
		return { statusCode: 413, code: "TOO_LARGE", message: error.message };
	}
	if (code.startsWith("FST_")) {
		return { statusCode: 400, code: "BAD_MULTIPART", message: error.message };
	}
	return null;
}

async function resolveBinaryCacheDir(deps: AgentRoutesDeps): Promise<string> {
	return deps.getBinaryCacheDir ? await deps.getBinaryCacheDir() : defaultGetBinaryCacheDir();
}

async function isTargetCached(args: {
	readonly cacheDir: string;
	readonly version: string;
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly deps: AgentRoutesDeps;
	readonly hubPlatform: ComputeTargetStatusOptions["hubPlatform"];
}): Promise<boolean> {
	const status = await computeTargetStatus({
		cacheDir: args.cacheDir,
		hubVersion: args.version,
		...(args.deps.versionReader !== undefined && { versionReader: args.deps.versionReader }),
		...(args.deps.resolveAgentBinaryPath !== undefined && {
			resolveAgentBinaryPath: args.deps.resolveAgentBinaryPath,
		}),
		...(args.hubPlatform !== undefined && { hubPlatform: args.hubPlatform }),
	});
	const row = status.targets.find((target) => target.os === args.os && target.arch === args.arch);
	return row?.status === "cached";
}

function snapshotToWire(snapshot: AgentFetchSnapshot): {
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly downloaded: number;
	readonly total?: number;
	readonly phase: AgentFetchPhase;
} {
	return {
		os: snapshot.os,
		arch: snapshot.arch,
		downloaded: snapshot.downloaded,
		...(snapshot.total !== undefined && { total: snapshot.total }),
		phase: snapshot.phase,
	};
}

function agentFetchTargetKey(os: AgentTargetOs, arch: AgentTargetArch, version: string): string {
	return `${os}/${arch}/${version}`;
}

export function createAgentMutationOriginGuard(
	opts: AgentMutationOriginGuardOptions,
): AgentPreHandler {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		const origin = request.headers.origin;
		if (!origin) return;

		const originAllowed = opts.isOriginAllowed
			? opts.isOriginAllowed(origin)
			: new Set(readAllowList(opts.allowedOrigins)).has(origin);
		if (!originAllowed) return sendError(reply, 403, "ORIGIN_FORBIDDEN", "Origin is not allowed");
	};
}

function createAgentBearerAuthGuard(deps: AgentRoutesDeps): AgentPreHandler {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			return sendError(reply, 401, "AUTH_REQUIRED", "Authorization header required");
		}

		const [scheme, token, extra] = authHeader.split(" ");
		if (scheme !== "Bearer" || !token || extra !== undefined) {
			return sendError(reply, 401, "AUTH_REQUIRED", "Authorization header must be: Bearer <token>");
		}

		if (isValidAgentBearer(token, deps)) return;
		return sendError(reply, 401, "AUTH_INVALID", "Invalid, expired, or revoked token");
	};
}

function isValidAgentBearer(token: string, deps: AgentRoutesDeps): boolean {
	if (deps.db) {
		const record = validateTokenRecord(deps.db, token);
		if (record) {
			if (deps.tokenTtlDays !== undefined) touchToken(deps.db, record.id, deps.tokenTtlDays);
			return true;
		}
	}
	return deps.authToken !== undefined && deps.authToken !== null && token === deps.authToken;
}

function readAllowList(list: Iterable<string> | (() => Iterable<string>) | undefined): string[] {
	if (!list) return [];
	return Array.from(typeof list === "function" ? list() : list);
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): void {
	reply.code(statusCode).send({ error: { code, message } });
}
