import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	AGENT_FETCH_IDLE_TIMEOUT_MS,
	AGENT_FETCH_MANIFEST_MAX_BYTES,
	AGENT_FETCH_MAX_BYTES,
	AGENT_FETCH_TOTAL_TIMEOUT_MS,
	createUniqueTempPath,
	diskError,
	ensureCacheDir,
	FetchError,
	type ResolvedTarget,
	removeFileIfPresent,
	resolveTarget,
	validateAgentVersion,
	verifyAndPlace,
} from "./agent-cache.js";

export type { FetchErrorCode, ResolvedTarget } from "./agent-cache.js";
export {
	AGENT_FETCH_IDLE_TIMEOUT_MS,
	AGENT_FETCH_MANIFEST_MAX_BYTES,
	AGENT_FETCH_MAX_BYTES,
	AGENT_FETCH_TOTAL_TIMEOUT_MS,
	AGENT_TARGET_TRIPLES,
	assertSecureCacheDir,
	FetchError,
	isCacheDirSecure,
	isTrustedCacheBinary,
	parseChecksumManifest,
	pruneAgentBinaryCache,
	resolveTarget,
	validateAgentVersion,
	verifyAndPlace,
} from "./agent-cache.js";

export type AgentFetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type FetchAgentBinaryProgress = {
	readonly downloaded: number;
	readonly total?: number;
	readonly phase: "download" | "verify";
};

export type FetchAgentBinaryOptions = {
	readonly os: string;
	readonly arch: string;
	readonly version: string;
	readonly cacheDir: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: AgentFetchImpl;
	readonly onProgress?: (progress: FetchAgentBinaryProgress) => void;
};

type AssetResponse = {
	readonly response: Response;
	readonly assetName: string;
	readonly assetUrl: string;
	readonly request: TimedRequest;
};

interface FetchTarget {
	readonly path: string;
	readonly noun: string;
	readonly executable: boolean;
}

const DEFAULT_BASE_URL = "https://github.com/khiops/lasterm";
const LEGACY_VERSION_CUTOFF = "0.4.0";

const FETCH_HEADERS = {
	"accept-encoding": "identity",
	"user-agent": "lasterm-hub-agent-fetch",
} as const;

export async function fetchAgentBinary(options: FetchAgentBinaryOptions): Promise<string> {
	validateAgentVersion(options.version);

	const target = resolveTarget(options.os, options.arch);
	if (!target) {
		throw new FetchError(
			"UNSUPPORTED_TARGET",
			`No Lasterm agent release is built for ${options.os}/${options.arch}. Build the agent locally for that target or choose one of the built targets in AGENT_TARGET_TRIPLES, then place the binary in ${options.cacheDir}.`,
		);
	}

	const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
	const fetchImpl = options.fetchImpl ?? defaultFetchImpl();
	const finalName = getCacheFileName(options.os, options.arch, options.version, target.ext);
	const finalPath = join(options.cacheDir, finalName);
	const fetchTarget: FetchTarget = {
		path: finalPath,
		noun: "agent binary",
		executable: true,
	};
	const versionedAssetName = getVersionedAssetName(target.triple, options.version, target.ext);
	const versionedAssetUrl = buildReleaseAssetUrl(baseUrl, options.version, versionedAssetName);
	const tagUrl = buildReleaseTagUrl(baseUrl, options.version);

	ensureCacheDir(options.cacheDir);

	const asset = await openAssetResponse({
		baseUrl,
		version: options.version,
		target,
		fetchImpl,
		fetchTarget,
		versionedAssetName,
		versionedAssetUrl,
		tagUrl,
	});
	const tempPath = createUniqueTempPath(finalPath);

	try {
		const progress = await writeResponseToTemp(
			asset.response,
			asset.request,
			asset.assetUrl,
			tempPath,
			fetchTarget,
			options.onProgress,
		);
		emitFetchProgress(options.onProgress, { ...progress, phase: "verify" });
		return await verifyChecksumAndPlace({
			cacheDir: options.cacheDir,
			version: options.version,
			baseUrl,
			fetchImpl,
			tempPath,
			assetName: asset.assetName,
			assetUrl: asset.assetUrl,
			finalPath,
		});
	} catch (error) {
		asset.request.abort();
		removeFileIfPresent(tempPath);
		if (error instanceof FetchError) throw error;
		if (isErrno(error, "ENOSPC")) throw diskError(options.cacheDir, finalPath, error);
		throw networkError(asset.assetUrl, fetchTarget, error);
	} finally {
		asset.request.clear();
	}
}

function normalizeBaseUrl(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new FetchError(
			"NETWORK",
			`Invalid Lasterm release base URL "${baseUrl}". Use an https:// GitHub repository URL or manually place the agent binary in the cache.`,
		);
	}
	if (parsed.protocol !== "https:") {
		throw new FetchError(
			"NETWORK",
			`Refusing non-HTTPS Lasterm release base URL "${baseUrl}". Use an https:// URL or manually place the agent binary in the cache.`,
		);
	}
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.origin}${pathname}`;
}

function defaultFetchImpl(): AgentFetchImpl {
	if (typeof globalThis.fetch !== "function") {
		return async () => {
			throw new FetchError(
				"NETWORK",
				"This runtime has no global fetch, so the agent binary cannot be downloaded. Every supported Node provides it, so something in this process removed or replaced it; otherwise, download the agent binary manually into the cache.",
			);
		};
	}
	return (url, init) => globalThis.fetch(url, init);
}

// Accept only a COMPLETE 200 OK asset response. A 2xx-but-not-200 (e.g. 206
// Partial Content) or a Content-Range response would cache a truncated executable —
// and for legacy versions, where the checksum is optional, that truncation would go
// undetected. Reject such responses before any bytes are written.
async function rejectPartialResponse(
	response: Response,
	request: TimedRequest,
	url: string,
): Promise<void> {
	if (!response.ok) return; // non-2xx is handled by the HTTP error mapping
	if (response.status === 200 && !response.headers.has("content-range")) return;
	await closeResponse(response);
	request.clear();
	throw new FetchError(
		"NETWORK",
		`Refusing a partial response (HTTP ${response.status}) for ${url}; a truncated agent binary must never be cached. Retry the fetch.`,
	);
}

async function openAssetResponse(args: {
	readonly baseUrl: string;
	readonly version: string;
	readonly target: ResolvedTarget;
	readonly fetchImpl: AgentFetchImpl;
	readonly fetchTarget: FetchTarget;
	readonly versionedAssetName: string;
	readonly versionedAssetUrl: string;
	readonly tagUrl: string;
}): Promise<AssetResponse> {
	const versioned = await fetchResponse(args.versionedAssetUrl, args.fetchImpl, args.fetchTarget);
	await rejectPartialResponse(versioned.response, versioned.request, args.versionedAssetUrl);
	if (versioned.response.ok) {
		return {
			response: versioned.response,
			request: versioned.request,
			assetName: args.versionedAssetName,
			assetUrl: args.versionedAssetUrl,
		};
	}

	// Any 404 is retried under the former basename, on no version condition at all.
	// A condition would have to name the first version released after the rename —
	// a number that does not exist yet when this ships — and reusing
	// `isLegacyVersion` for it is worse than wrong: that predicate also decides
	// whether a MISSING CHECKSUM is tolerated, so widening it to fix a naming
	// question would quietly relax verification for every release it newly covered.
	// Observing the 404 instead costs one request on a path that is already failing,
	// and retires itself once nothing fetches a pre-rename release.
	if (versioned.response.status === 404) {
		await closeResponse(versioned.response);
		versioned.request.clear();
		const legacyAssetName = getLegacyAssetName(args.target.triple, args.version, args.target.ext);
		const legacyAssetUrl = buildReleaseAssetUrl(args.baseUrl, args.version, legacyAssetName);
		const legacy = await fetchResponse(legacyAssetUrl, args.fetchImpl, args.fetchTarget);
		await rejectPartialResponse(legacy.response, legacy.request, legacyAssetUrl);
		if (legacy.response.ok) {
			return {
				response: legacy.response,
				request: legacy.request,
				assetName: legacyAssetName,
				assetUrl: legacyAssetUrl,
			};
		}
		// Neither name is there. What the operator needs to hear about is the asset
		// this build asks for, not the historical one that was also tried, so the
		// retry must not hijack the diagnosis — unless it failed some other way,
		// which is its own news and gets reported as itself.
		return await throwHttpError({
			response: legacy.response,
			request: legacy.request,
			tagUrl: args.tagUrl,
			fetchImpl: args.fetchImpl,
			fetchTarget: args.fetchTarget,
			...(legacy.response.status === 404
				? { url: args.versionedAssetUrl, assetName: args.versionedAssetName }
				: { url: legacyAssetUrl, assetName: legacyAssetName }),
		});
	}

	return await throwHttpError({
		response: versioned.response,
		request: versioned.request,
		url: args.versionedAssetUrl,
		tagUrl: args.tagUrl,
		fetchImpl: args.fetchImpl,
		fetchTarget: args.fetchTarget,
		assetName: args.versionedAssetName,
	});
}

async function throwHttpError(args: {
	readonly response: Response;
	readonly request: TimedRequest;
	readonly url: string;
	readonly tagUrl: string;
	readonly fetchImpl: AgentFetchImpl;
	readonly fetchTarget: FetchTarget;
	readonly assetName: string;
}): Promise<never> {
	const { response, request } = args;
	try {
		if (isRateLimited(response)) throw rateLimitedError(args.url, args.fetchTarget, response);
		if (response.status === 401 || response.status === 403) {
			throw privateOrForbiddenError(args.url, args.fetchTarget);
		}
		if (response.status === 404) {
			const tag = await fetchResponse(args.tagUrl, args.fetchImpl, args.fetchTarget);
			try {
				if (tag.response.ok) {
					throw new FetchError(
						"RELEASE_INCOMPLETE",
						`Release ${args.tagUrl} exists, but ${args.assetName} is missing. Wait for the release build to finish or upload ${args.assetName} to ${args.url}, then rerun the agent fetch.`,
					);
				}
				if (isRateLimited(tag.response)) {
					throw rateLimitedError(args.tagUrl, args.fetchTarget, tag.response);
				}
				if (tag.response.status === 401 || tag.response.status === 403) {
					throw privateOrForbiddenError(args.url, args.fetchTarget);
				}
				if (tag.response.status === 404) {
					throw new FetchError(
						"NOT_FOUND",
						`No Lasterm release tag exists at ${args.tagUrl}. Publish v${versionFromTagUrl(args.tagUrl)} or rerun lasterm-hub agent fetch --version <x.y.z> for an existing release.`,
					);
				}
				throw networkStatusError(args.tagUrl, args.fetchTarget, tag.response);
			} finally {
				await closeResponse(tag.response);
				tag.request.clear();
			}
		}
		throw networkStatusError(args.url, args.fetchTarget, response);
	} finally {
		await closeResponse(response);
		request.clear();
	}
}

async function verifyChecksumAndPlace(args: {
	readonly cacheDir: string;
	readonly version: string;
	readonly baseUrl: string;
	readonly fetchImpl: AgentFetchImpl;
	readonly tempPath: string;
	readonly assetName: string;
	readonly assetUrl: string;
	readonly finalPath: string;
}): Promise<string> {
	const manifest = await getChecksumManifest(args);
	if (manifest === null) {
		handleMissingChecksum(args.version, args.assetName, args.assetUrl, args.finalPath);
		return verifyAndPlace(
			args.tempPath,
			args.assetName,
			checksumManifestForTemp(args.tempPath, args.assetName),
			args.cacheDir,
			{ force: true },
		);
	}

	try {
		const finalPath = verifyAndPlace(args.tempPath, args.assetName, manifest.text, args.cacheDir, {
			force: true,
		});
		// Cache the manifest only AFTER it has verified the binary. A transiently bad
		// or incomplete manifest (e.g. published mid-release-build) is never persisted,
		// so a corrected release is picked up on the next attempt instead of failing
		// forever from a poisoned cache.
		if (!manifest.fromCache) writeManifestCache(manifest.manifestPath, manifest.text);
		return finalPath;
	} catch (error) {
		if (
			error instanceof FetchError &&
			error.code === "CHECKSUM_MISSING" &&
			isLegacyVersion(args.version)
		) {
			handleMissingChecksum(args.version, args.assetName, args.assetUrl, args.finalPath);
			return verifyAndPlace(
				args.tempPath,
				args.assetName,
				checksumManifestForTemp(args.tempPath, args.assetName),
				args.cacheDir,
				{ force: true },
			);
		}
		if (error instanceof FetchError && error.code === "CHECKSUM_MISSING") {
			handleMissingChecksum(args.version, args.assetName, args.assetUrl, args.finalPath);
		}
		if (
			error instanceof FetchError &&
			error.code === "CHECKSUM_MISMATCH" &&
			error.message.startsWith(`Checksum mismatch for ${args.assetName}.`)
		) {
			throw new FetchError(
				"CHECKSUM_MISMATCH",
				`Checksum mismatch for ${args.assetName}. Delete the partial download, rerun the agent fetch, or manually download ${args.assetUrl}, verify SHA256SUMS, and rename it to ${args.finalPath}.`,
			);
		}
		throw error;
	}
}

function checksumManifestForTemp(tempPath: string, assetName: string): string {
	return `${createHash("sha256").update(readFileSync(tempPath)).digest("hex")}  ${assetName}\n`;
}

async function getChecksumManifest(args: {
	readonly cacheDir: string;
	readonly version: string;
	readonly baseUrl: string;
	readonly fetchImpl: AgentFetchImpl;
}): Promise<{ text: string; manifestPath: string; fromCache: boolean } | null> {
	const manifestName = getChecksumManifestName(args.version);
	const manifestPath = join(args.cacheDir, manifestName);

	const cached = readCachedManifest(manifestPath);
	if (cached !== null) return { text: cached, manifestPath, fromCache: true };

	const manifestUrl = `${args.baseUrl}/releases/download/v${args.version}/${manifestName}`;
	const fetchTarget: FetchTarget = {
		path: manifestPath,
		noun: "checksum manifest",
		executable: false,
	};
	const fetched = await fetchResponse(manifestUrl, args.fetchImpl, fetchTarget);
	try {
		if (fetched.response.status === 404) return null;
		if (isRateLimited(fetched.response)) {
			throw rateLimitedError(manifestUrl, fetchTarget, fetched.response);
		}
		if (fetched.response.status === 401 || fetched.response.status === 403) {
			throw privateOrForbiddenError(manifestUrl, fetchTarget);
		}
		if (!fetched.response.ok) throw networkStatusError(manifestUrl, fetchTarget, fetched.response);

		const body = await readResponseBytes(
			fetched.response,
			fetched.request,
			manifestUrl,
			fetchTarget,
			AGENT_FETCH_MANIFEST_MAX_BYTES,
		);
		const text = body.toString("utf8");
		return { text, manifestPath, fromCache: false };
	} finally {
		await closeResponse(fetched.response);
		fetched.request.clear();
	}
}

function handleMissingChecksum(
	version: string,
	assetName: string,
	assetUrl: string,
	finalPath: string,
): void {
	if (isLegacyVersion(version)) {
		console.warn(
			`No SHA256SUMS-${version}.txt entry for ${assetName}; proceeding only because ${version} predates versioned Lasterm agent checksums. Manually verify ${assetUrl} before trusting ${finalPath}.`,
		);
		return;
	}
	throw new FetchError(
		"CHECKSUM_MISSING",
		`Missing SHA256SUMS-${version}.txt entry for ${assetName}. Publish SHA256SUMS-${version}.txt next to ${assetUrl}, or manually download, verify, chmod 755, and rename the binary to ${finalPath}.`,
	);
}

async function fetchResponse(
	url: string,
	fetchImpl: AgentFetchImpl,
	target: FetchTarget,
): Promise<{ response: Response; request: TimedRequest }> {
	const request = new TimedRequest(url, target);
	try {
		const fetchPromise = fetchImpl(url, {
			headers: FETCH_HEADERS,
			redirect: "follow",
			signal: request.signal,
		});
		void fetchPromise.catch(() => undefined);
		const response = await request.race(fetchPromise);
		// `redirect: "follow"` could land on an http:// URL; the HTTPS check on
		// baseUrl does not cover redirect targets. response.url is the final URL
		// after redirects ("" for injected test responses, which we leave alone).
		if (response.url && !response.url.startsWith("https:")) {
			await closeResponse(response);
			request.clear();
			throw new FetchError(
				"NETWORK",
				target.executable
					? `Refusing insecure redirect to ${response.url} while downloading ${url}. The release host must stay on HTTPS; retry, or manually verify and place the agent binary at ${target.path}.`
					: `Refusing insecure redirect to ${response.url} while downloading ${url}. The release host must stay on HTTPS; retry, or manually verify and place the ${target.noun} at ${target.path}.`,
			);
		}
		return { response, request };
	} catch (error) {
		request.clear();
		if (error instanceof FetchError) throw error;
		throw networkError(url, target, error);
	}
}

class TimedRequest {
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private readonly totalPromise: Promise<FetchError>;
	private totalTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly url: string,
		private readonly target: FetchTarget,
	) {
		this.signal = this.controller.signal;
		this.totalPromise = new Promise((resolve) => {
			this.totalTimer = setTimeout(() => {
				this.controller.abort();
				resolve(
					new FetchError(
						"NETWORK",
						this.target.executable
							? `Timed out after ${AGENT_FETCH_TOTAL_TIMEOUT_MS}ms while downloading ${this.url}. Retry on a better connection or manually place the agent binary in the cache; Node fetch does not honor proxy environment variables here.`
							: `Timed out after ${AGENT_FETCH_TOTAL_TIMEOUT_MS}ms while downloading ${this.url}. Retry on a better connection or manually place the ${this.target.noun} at ${this.target.path}; Node fetch does not honor proxy environment variables here.`,
					),
				);
			}, AGENT_FETCH_TOTAL_TIMEOUT_MS);
		});
	}

	async race<T>(operation: Promise<T>): Promise<T> {
		const result = await Promise.race([operation, this.totalPromise]);
		if (result instanceof FetchError) throw result;
		return result;
	}

	abort(): void {
		this.controller.abort();
	}

	clear(): void {
		if (this.totalTimer !== null) clearTimeout(this.totalTimer);
	}
}

async function writeResponseToTemp(
	response: Response,
	request: TimedRequest,
	url: string,
	tempPath: string,
	target: FetchTarget,
	onProgress?: (progress: FetchAgentBinaryProgress) => void,
): Promise<Omit<FetchAgentBinaryProgress, "phase">> {
	const finalPath = target.path;
	assertIdentityResponse(response, url, target);
	const body = response.body;
	if (!body) throw networkError(url, target, new Error("response body was empty"));

	const total = contentLengthBytes(response);
	let fd: number | null = null;
	let written = 0;
	try {
		// O_EXCL guarantees this path did not exist and is created here as a fresh
		// regular file (open fails otherwise) — that is the symlink / pre-existing
		// file guard; no separate lstat check is needed.
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

		const reader = body.getReader();
		try {
			for (;;) {
				const read = await readChunkWithTimeout(reader, request, url, target);
				if (read.done) break;
				const chunk = read.value;
				if (!chunk) continue;
				if (written + chunk.byteLength > AGENT_FETCH_MAX_BYTES) {
					request.abort();
					throw new FetchError(
						"TOO_LARGE",
						`Downloaded ${basename(finalPath)} exceeds the 64 MiB Lasterm agent limit. Delete the bad release asset at ${url} and upload the correct binary, or manually place a valid binary at ${finalPath}.`,
					);
				}
				// writeSync may write fewer bytes than requested; loop until the
				// whole chunk lands so byte accounting matches what hit disk.
				let chunkOffset = 0;
				while (chunkOffset < chunk.byteLength) {
					chunkOffset += writeSync(fd, chunk, chunkOffset, chunk.byteLength - chunkOffset);
				}
				written += chunk.byteLength;
				emitFetchProgress(onProgress, {
					downloaded: written,
					...(total !== undefined && { total }),
					phase: "download",
				});
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	} catch (error) {
		if (isErrno(error, "ENOSPC")) throw diskError(tempPath, finalPath, error);
		throw error;
	} finally {
		if (fd !== null) closeSync(fd);
	}
	return { downloaded: written, ...(total !== undefined && { total }) };
}

function contentLengthBytes(response: Response): number | undefined {
	const raw = response.headers.get("content-length");
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return undefined;
	return parsed;
}

function emitFetchProgress(
	onProgress: ((progress: FetchAgentBinaryProgress) => void) | undefined,
	progress: FetchAgentBinaryProgress,
): void {
	onProgress?.(progress);
}

async function readResponseBytes(
	response: Response,
	request: TimedRequest,
	url: string,
	target: FetchTarget,
	maxBytes: number,
): Promise<Buffer> {
	assertIdentityResponse(response, url, target);
	const body = response.body;
	if (!body) return Buffer.alloc(0);

	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	let bytes = 0;
	try {
		for (;;) {
			const read = await readChunkWithTimeout(reader, request, url, target);
			if (read.done) break;
			const chunk = read.value;
			if (!chunk) continue;
			if (bytes + chunk.byteLength > maxBytes) {
				request.abort();
				throw new FetchError(
					"TOO_LARGE",
					target.executable
						? `Downloaded ${target.noun} from ${url} is too large. Publish a compact SHA256SUMS file or manually verify and place the binary at ${target.path}.`
						: `Downloaded ${target.noun} from ${url} is too large. Publish a compact SHA256SUMS file or manually verify and place the ${target.noun} at ${target.path}.`,
				);
			}
			chunks.push(chunk);
			bytes += chunk.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		bytes,
	);
}

async function readChunkWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	request: TimedRequest,
	url: string,
	target: FetchTarget,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	const idlePromise = new Promise<FetchError>((resolve) => {
		idleTimer = setTimeout(() => {
			request.abort();
			resolve(
				new FetchError(
					"NETWORK",
					target.executable
						? `Download from ${url} stalled for ${AGENT_FETCH_IDLE_TIMEOUT_MS}ms. Retry the agent fetch or manually download the binary and rename it to ${target.path}.`
						: `Download from ${url} stalled for ${AGENT_FETCH_IDLE_TIMEOUT_MS}ms. Retry the agent fetch or manually download the ${target.noun} and place it at ${target.path}.`,
				),
			);
		}, AGENT_FETCH_IDLE_TIMEOUT_MS);
	});
	try {
		const result = await Promise.race([request.race(reader.read()), idlePromise]);
		if (result instanceof FetchError) throw result;
		return result;
	} finally {
		if (idleTimer !== null) clearTimeout(idleTimer);
	}
}

function assertIdentityResponse(response: Response, url: string, target: FetchTarget): void {
	const encoding = response.headers.get("content-encoding");
	if (encoding && encoding.toLowerCase() !== "identity") {
		throw new FetchError(
			"NETWORK",
			target.executable
				? `Refusing compressed response (${encoding}) from ${url}. Re-upload the raw agent binary or manually download and rename it to ${target.path}.`
				: `Refusing compressed response (${encoding}) from ${url}. Re-upload the raw ${target.noun} or manually download and place it at ${target.path}.`,
		);
	}
}

// Read a previously-cached checksum manifest, but only trust a regular file we
// wrote: never follow a symlink (an attacker-planted link would substitute an
// arbitrary checksum source) or read a special/oversize file. Anything
// suspicious returns null so the caller re-fetches from origin.
function readCachedManifest(manifestPath: string): string | null {
	try {
		const info = lstatSync(manifestPath);
		if (!info.isFile() || info.size > AGENT_FETCH_MANIFEST_MAX_BYTES) return null;
		return readFileSync(manifestPath, "utf8");
	} catch {
		return null;
	}
}

function writeManifestCache(manifestPath: string, text: string): void {
	const tempPath = `${manifestPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		writeFileSync(tempPath, text, { flag: "wx", mode: 0o600 });
		renameSync(tempPath, manifestPath);
	} catch (error) {
		removeFileIfPresent(tempPath);
		if (isErrno(error, "EEXIST")) return;
		throw error;
	}
}

function getCacheFileName(os: string, arch: string, version: string, ext: "" | ".exe"): string {
	return `lasterm-agent-${os}-${arch}-${version}${ext}`;
}

function getVersionedAssetName(triple: string, version: string, ext: "" | ".exe"): string {
	return `lasterm-agent-${triple}-${version}${ext}`;
}

/**
 * The basename an already-published release actually carries, for a version that
 * predates the rename.
 *
 * `termora` here is not a product name — it is what is on GitHub. Every release up
 * to the rename published assets under it, so asking for the current name would
 * request a file that has never existed. Two shapes, because the versioned naming
 * arrived at 0.4.0 and the releases below it are still unversioned.
 */
function getLegacyAssetName(triple: string, version: string, ext: "" | ".exe"): string {
	return isLegacyVersion(version)
		? `termora-agent-${triple}${ext}`
		: `termora-agent-${triple}-${version}${ext}`;
}

function getChecksumManifestName(version: string): string {
	return `SHA256SUMS-${version}.txt`;
}

function buildReleaseAssetUrl(baseUrl: string, version: string, assetName: string): string {
	return `${baseUrl}/releases/download/v${version}/${assetName}`;
}

function buildReleaseTagUrl(baseUrl: string, version: string): string {
	return `${baseUrl}/releases/tags/v${version}`;
}

function isLegacyVersion(version: string): boolean {
	return compareSemver(version, LEGACY_VERSION_CUTOFF) < 0;
}

function compareSemver(left: string, right: string): number {
	const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
	const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
	for (let index = 0; index < 3; index++) {
		const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function isRateLimited(response: Response): boolean {
	if (response.status === 429) return true;
	// The header heuristics only disambiguate GitHub's unauthenticated rate-limit
	// status (403). Applying them to other statuses (e.g. a 404 carrying a stray
	// retry-after) would mask NOT_FOUND / RELEASE_INCOMPLETE.
	if (response.status !== 403) return false;
	return (
		response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
	);
}

function rateLimitedError(url: string, target: FetchTarget, response: Response): FetchError {
	const retryAfter = response.headers.get("retry-after");
	const reset = response.headers.get("x-ratelimit-reset");
	let wait = " Retry after the limit resets.";
	if (retryAfter) {
		// retry-after is delta-seconds or an HTTP-date; surface it verbatim.
		wait = ` Wait ${retryAfter} (retry-after), then retry.`;
	} else if (reset && /^\d+$/.test(reset)) {
		// x-ratelimit-reset is Unix epoch seconds; render a human wall-clock time.
		wait = ` Wait until ${new Date(Number(reset) * 1000).toISOString()}, then retry.`;
	}
	return new FetchError(
		"RATE_LIMITED",
		target.executable
			? `Rate limited while downloading ${url}.${wait} To bypass the unauthenticated GitHub limit, manually download the asset, chmod 755 it, and rename it to ${target.path}.`
			: `Rate limited while downloading ${url}.${wait} To bypass the unauthenticated GitHub limit, manually download the ${target.noun} and place it at ${target.path}.`,
	);
}

function privateOrForbiddenError(url: string, target: FetchTarget): FetchError {
	return new FetchError(
		"PRIVATE_OR_FORBIDDEN",
		target.executable
			? `Lasterm could not download ${url}. The release may still be private or forbidden. Manually download that URL in a browser, save it in the cache as ${target.path}.download, chmod 755 it, then rename it to ${target.path}.`
			: `Lasterm could not download ${url}. The release may still be private or forbidden. Manually download the ${target.noun} in a browser, save it in the cache as ${target.path}.download, then rename it to ${target.path}.`,
	);
}

function networkStatusError(url: string, target: FetchTarget, response: Response): FetchError {
	return new FetchError(
		"NETWORK",
		target.executable
			? `Unexpected HTTP ${response.status} while downloading ${url}. Retry the agent fetch, or manually download the asset and rename it to ${target.path}; Node fetch does not honor proxy environment variables here.`
			: `Unexpected HTTP ${response.status} while downloading ${url}. Retry the agent fetch, or manually download the ${target.noun} and place it at ${target.path}; Node fetch does not honor proxy environment variables here.`,
	);
}

function networkError(url: string, target: FetchTarget, error: unknown): FetchError {
	const detail = error instanceof Error ? error.message : String(error);
	return new FetchError(
		"NETWORK",
		target.executable
			? `Network error while downloading ${url}: ${detail}. Retry the agent fetch, or manually download the asset and rename it to ${target.path}; Node fetch does not honor proxy environment variables here.`
			: `Network error while downloading ${url}: ${detail}. Retry the agent fetch, or manually download the ${target.noun} and place it at ${target.path}; Node fetch does not honor proxy environment variables here.`,
	);
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function versionFromTagUrl(tagUrl: string): string {
	const marker = "/releases/tags/v";
	const index = tagUrl.lastIndexOf(marker);
	return index === -1 ? "<version>" : tagUrl.slice(index + marker.length);
}

async function closeResponse(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}
