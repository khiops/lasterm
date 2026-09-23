import type { Server as HttpsServer } from "node:https";
import * as path from "node:path";
import cors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import { MAX_WALLPAPER_SIZE } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { registerAgentRoutes } from "./api/agents.js";
import { registerChannelRoutes } from "./api/channels.js";
import { registerConfigRoutes } from "./api/config.js";
import { registerFontRoutes } from "./api/fonts.js";
import { registerGroupRoutes } from "./api/groups.js";
import { registerHostGroupRoutes } from "./api/host-groups.js";
import { registerHostRoutes } from "./api/hosts.js";
import { registerLaunchProfileRoutes } from "./api/launch-profiles.js";
import { registerLogRoutes } from "./api/logs.js";
import { registerPairRoutes } from "./api/pair.js";
import { registerSessionRoutes } from "./api/sessions.js";
import { registerSshKeyRoutes } from "./api/ssh-keys.js";
import { registerThemeRoutes } from "./api/themes.js";
import { registerTokenRoutes } from "./api/tokens.js";
import { registerWallpaperRoutes } from "./api/wallpapers.js";
import { getBootAssetToken, requestHasValidAssetToken } from "./asset-token.js";
import {
	hashToken,
	listTokens,
	PRIMARY_TOKEN_ID,
	reportTokenStore,
	tokensEqual,
	touchTokenBestEffort,
	upsertPrimaryToken,
	validateTokenRecord,
} from "./auth.js";
import { BUILD_HASH, HUB_VERSION } from "./build-version.js";
import { getConfigDir, getStateDir } from "./cli.js";
import type { AuthConfig } from "./config.js";
import {
	ConfigResolver,
	corsOriginsToRegexps,
	loadAuthConfig,
	loadCorsOrigins,
	loadGcConfig,
	matchCorsOrigin,
} from "./config.js";
import type { HubLogger } from "./logging/hub-logger.js";
import type { LoggerRegistry } from "./logging/index.js";
import {
	HubLogController,
	type ServerLogOptions,
	serverLoggerOptions,
} from "./logging/request-log.js";
import { SecurityLog } from "./logging/security-log.js";
import { registerSeaStaticServing } from "./sea-static-server.js";
import { SessionManager } from "./session/session-manager.js";
import { seedShellProfiles } from "./shell-discovery.js";
import type { QuitResult } from "./shutdown.js";
import type { DatabaseManager } from "./storage/db.js";
import { MetaDAL } from "./storage/meta.js";
import { migrateLegacyShellDefaults } from "./storage/migrate-launch-profiles.js";
import { ThemeManager } from "./theme-manager.js";
import { registerWsRoutes } from "./ws/ws-handler.js";

declare module "fastify" {
	interface FastifyInstance {
		/**
		 * The security events of SECURITY.md § 7.1. Decorated by createServer, so
		 * every route and hook records through the same log without being handed it.
		 */
		security: SecurityLog;
	}
}

/**
 * Mutable set of exact CORS origins allowed by the server.
 * Pre-populated with Tauri origins and user-configured origins at server creation.
 * Exact localhost origins (e.g. http://localhost:4100) are added after the server
 * starts and the actual port is known — call addStartupCorsOrigins() after listen.
 */
const _corsAllowedOrigins = new Set<string>();
const PROTECTED_PUBLIC_ASSET_PREFIXES = [
	"/public/fonts",
	"/public/system-fonts",
	"/public/sounds",
	"/public/wallpapers",
];

function isProtectedPublicAssetPath(pathname: string): boolean {
	return PROTECTED_PUBLIC_ASSET_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/**
 * Add one or more exact origin strings to the CORS allowlist.
 * Safe to call multiple times; duplicates are ignored.
 * Call this after startServer() returns the actual port to add exact localhost origins.
 */
export function addCorsOrigins(...origins: string[]): void {
	for (const o of origins) {
		_corsAllowedOrigins.add(o);
	}
}

/**
 * Add startup-only loopback origins once the server has bound.
 *
 * Returns the actual port from the listen address, which may differ from the
 * requested port due to zero_conf auto-increment on EADDRINUSE.
 */
export function addStartupCorsOrigins(address: string, requestedPort?: number): number {
	const port = new URL(address).port;
	const actualPort = port ? Number(port) : (requestedPort ?? 0);

	// SEC-020: Inject exact localhost origins now that the actual port is known.
	// These replace the former wildcard http://localhost:* and http://127.0.0.1:* patterns.
	addCorsOrigins(`https://localhost:${actualPort}`, `https://127.0.0.1:${actualPort}`);
	// In non-production environments also allow the Vite dev server origin.
	if (process.env.NODE_ENV !== "production") {
		addCorsOrigins("http://localhost:5173");
	}

	return actualPort;
}

interface ServerBaseOptions {
	host?: string; // default: "127.0.0.1"
	port?: number; // absent: let the operating system assign an unused port
	/**
	 * Fastify's own log. Default `true`: standard output from INFO, which the
	 * desktop keeps as `hub.log`. A spec passes a level and a destination to read
	 * back what a hub run writes there.
	 */
	logger?: boolean | ServerLogOptions;
	dbManager?: DatabaseManager; // when provided, WS routes are registered
	authToken?: string; // when provided, Bearer auth is enforced on all routes except /api/health
	ownerToken?: string; // shutdown-only owner token from runtime.json
	onShutdown?: () => Promise<void> | void; // called after POST /api/shutdown has replied
	/** Called by owner-token POST /api/quit while its response remains open. */
	authConfig?: AuthConfig; // override auth config (bypasses config.toml, useful for tests)
	configDir?: string; // override config directory (defaults to getConfigDir())
	corsOrigins?: string[]; // override CORS allowlist (bypasses config.toml, useful for tests)
	skipShellDiscovery?: boolean; // disable auto-shell-seeding (useful for tests)
	hubLogger?: HubLogger; // global hub log sink
	/**
	 * Where security events are recorded. startHub always passes one writing to
	 * `logs/hub.jsonl`; a server built without one records them through Fastify's
	 * own logger instead, so no way of constructing a server drops them.
	 */
	securityLog?: SecurityLog;
	loggerRegistry?: LoggerRegistry; // per-channel log registry
	logsDir?: string; // base logs directory (e.g. ~/.local/state/lasterm/logs)
}

/** The response and teardown halves of quit are one capability, never independent hooks. */
type ServerQuitOptions =
	| (ServerBaseOptions & {
			ownerToken: string;
			onQuit: (sessionManager: SessionManager | null) => Promise<QuitResult>;
			onQuitDelivered: () => Promise<void> | void;
	  })
	| (Omit<ServerBaseOptions, "ownerToken"> & {
			ownerToken?: never;
			onQuit?: never;
			onQuitDelivered?: never;
	  });

/** Certificate and key are intentionally impossible to omit or supply independently. */
type ServerTlsOptions = { tls: { cert: string; key: string } };

export type ServerOptions = ServerQuitOptions & ServerTlsOptions;

/** The only options consumed after a server has already been created. */
export interface StartServerOptions {
	host?: string;
	port?: number;
}

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
	const server = Fastify<HttpsServer>({
		logger: serverLoggerOptions(options.logger ?? true),
		// Fastify's per-request lines, held to the levels CLAUDE.md allows (#512).
		logController: new HubLogController(),
		https: options.tls,
	}) as unknown as FastifyInstance;
	server.decorate(
		"security",
		options.securityLog ?? new SecurityLog((msg, fields) => server.log.info(fields, msg)),
	);

	// Helmet — sets security-related HTTP response headers
	await server.register(fastifyHelmet, {
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				// 'self' covers the same-origin WebSocket; ws: and wss: would allow any host (#210).
				connectSrc: ["'self'"],
				imgSrc: ["'self'", "data:", "blob:"],
				fontSrc: ["'self'", "data:"],
				workerSrc: ["'self'", "blob:"],
			},
		},
		crossOriginEmbedderPolicy: false,
	});

	server.addHook("onSend", async (request, reply, payload) => {
		const pathname = new URL(request.url, "http://localhost").pathname;
		if (pathname.startsWith("/public/") && requestHasValidAssetToken(request)) {
			reply.header("Cross-Origin-Resource-Policy", "cross-origin");
		}
		return payload;
	});

	server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		const pathname = new URL(request.url, "http://localhost").pathname;
		if (!isProtectedPublicAssetPath(pathname)) return;
		if (requestHasValidAssetToken(request)) return;

		return reply.code(403).send({
			error: {
				code: "ASSET_TOKEN_REQUIRED",
				message: "Valid asset token required",
			},
		});
	});

	// CORS — required for Tauri desktop (webview origin differs from hub)
	// and for remote hub access from web clients on other domains.
	// Origins are validated against:
	//   1. _corsAllowedOrigins — exact strings (Tauri + localhost:actualPort injected after listen)
	//   2. compiledCorsRegexps — regexp patterns from user config.toml [server] cors_origins
	// SEC-020: No wildcard localhost origins in defaults. Exact port origins are injected
	//          by addStartupCorsOrigins() after startServer() returns the actual port.
	const configDir = options?.configDir ?? getConfigDir();
	// SEC-027: load auth config once and reuse across all call sites
	const authConfig =
		options?.authConfig !== undefined ? options.authConfig : loadAuthConfig(configDir);

	// Determine origin patterns for this server instance.
	// When corsOrigins is overridden (tests), use that list exclusively.
	// Otherwise, load from config.toml — user patterns may include wildcards.
	const corsPatterns =
		options?.corsOrigins !== undefined ? options.corsOrigins : loadCorsOrigins(configDir);

	// Repopulate the module-level Set. Hub is a singleton — one server per process.
	_corsAllowedOrigins.clear();
	// Wildcard patterns go to regex matching; exact strings go into the Set for O(1) lookup.
	const wildcardPatterns: string[] = [];
	for (const o of corsPatterns) {
		if (o.includes("*")) {
			wildcardPatterns.push(o);
		} else {
			_corsAllowedOrigins.add(o);
		}
	}
	const compiledCorsRegexps = corsOriginsToRegexps(wildcardPatterns);
	const isCorsOriginAllowed = (origin: string): boolean =>
		_corsAllowedOrigins.has(origin) || matchCorsOrigin(origin, compiledCorsRegexps);

	await server.register(cors, {
		origin: (origin, cb) => {
			// No origin header (same-origin or non-browser): deny CORS headers
			if (!origin) return cb(null, false);
			// Exact match first (O(1)), then wildcard regexp matching.
			cb(null, isCorsOriginAllowed(origin));
		},
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowedHeaders: [
			"Content-Type",
			"Authorization",
			"X-Lasterm-Owner",
			"X-Lasterm-Client",
			"X-Lasterm-Client-Id",
		],
		credentials: true,
	});

	server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		const pathname = new URL(request.url, "http://localhost").pathname;
		if (request.method !== "POST" || (pathname !== "/api/shutdown" && pathname !== "/api/quit"))
			return;

		if (!hasValidShutdownOwnerToken(request, options?.ownerToken)) {
			return sendOwnerTokenRequired(reply);
		}

		if (!isLoopbackAddress(request.ip)) {
			return sendLoopbackRequired(reply);
		}
	});

	// Auth enforcement — applied before route matching
	if (options?.authToken) {
		const primaryToken = options.authToken;
		const db = options.dbManager?.meta ?? null;
		const resolvedAuthConfig = authConfig;
		const ttlDays = resolvedAuthConfig.tokenTtlDays;

		// When a DB is available, seed the primary token record so all validation
		// goes through the DB path (expiry + revocation checks).
		if (db) {
			// The recorded primary token differs from auth.json's only when that file
			// was replaced between two runs: the manual rotation of SECURITY.md § 2.1,
			// or a substitution nobody asked for, which is the case worth a record.
			const previous = listTokens(db).find((record) => record.id === PRIMARY_TOKEN_ID);
			upsertPrimaryToken(db, primaryToken);
			if (previous && previous.tokenHash !== hashToken(primaryToken)) {
				server.security.tokenRotated({ tokenId: PRIMARY_TOKEN_ID });
			}
			// Nothing revokes the primary row any more, so a revoked one was left by a
			// version before #515 or a hand edit, and the upsert has just cleared it.
			// Undoing a revocation is recorded, never silent.
			if (previous?.revokedAt) {
				server.security.tokenReinstated({
					tokenId: PRIMARY_TOKEN_ID,
					revokedAt: previous.revokedAt,
				});
			}
		}

		// Every REST request carries the bearer, so a record of each success would
		// bury everything else in the log. The first one from each credential and
		// address in a hub run is what says who used a token, and from where.
		const restCredentialsSeen = new Set<string>();

		server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
			// CORS preflight is handled by @fastify/cors — skip auth.
			if (request.method === "OPTIONS") return;

			// Parse pathname from the raw URL to avoid query-string or path-traversal bypasses.
			const pathname = new URL(request.url, "http://localhost").pathname;

			// Unauthenticated endpoints — exact pathname match
			if (pathname === "/api/health") return;
			if (pathname === "/api/pair/verify") return;
			if (request.method === "POST" && (pathname === "/api/shutdown" || pathname === "/api/quit"))
				return;

			// WebSocket auth is handled at the message level (AUTH → AUTH_OK/AUTH_FAIL),
			// not at the HTTP upgrade level.
			if (pathname === "/ws" || pathname.startsWith("/ws/")) return;

			// Static assets (index.html, JS bundles, etc.) do not require auth —
			// the UI itself handles the pairing/auth flow on first load.
			if (!pathname.startsWith("/api/")) return;

			const authHeader = request.headers.authorization;
			if (!authHeader) {
				server.log.warn({ url: pathname }, "auth: missing Authorization header");
				server.security.authFailed({ via: "rest", sourceIp: request.ip, reason: "missing_header" });
				return reply.code(401).send({
					error: "AUTH_REQUIRED",
					message: "Authorization header required",
				});
			}

			const [scheme, token] = authHeader.split(" ");
			if (scheme !== "Bearer" || !token) {
				server.log.warn({ url: pathname }, "auth: malformed Authorization header");
				server.security.authFailed({
					via: "rest",
					sourceIp: request.ip,
					reason: "malformed_header",
				});
				return reply.code(401).send({
					error: "AUTH_REQUIRED",
					message: "Authorization header must be: Bearer <token>",
				});
			}

			if (db) {
				// DB-backed validation: checks expiry and revocation status
				const validation = validateTokenRecord(db, token);
				reportTokenStore(db, validation, server.log);
				if (validation.status === "unavailable") {
					// Still a refusal, but not a verdict on the credential: a 401 here
					// told a client holding a good token to discard it. The outage is
					// logged once by reportTokenStore, not on every request it refuses,
					// and not in the security log: nobody failed to authenticate, and a
					// failure per refused request would read as an attack from every
					// client at once.
					return reply.code(503).send({
						error: "AUTH_UNAVAILABLE",
						message: "The hub cannot check credentials right now",
					});
				}
				if (validation.status === "invalid") {
					server.log.warn(
						{ url: pathname, reason: validation.reason },
						"auth: invalid, expired, or revoked token",
					);
					server.security.authFailed({
						via: "rest",
						sourceIp: request.ip,
						reason: "invalid_token",
						tokenStatus: validation.reason,
					});
					return reply.code(401).send({
						error: "AUTH_INVALID",
						message: "Invalid, expired, or revoked token",
					});
				}
				const { record } = validation;
				// Sliding-window expiry refresh + last_used_at update (best-effort, non-blocking)
				touchTokenBestEffort(db, record.id, ttlDays, server.log);
				server.log.debug({ url: pathname, tokenId: record.id }, "auth: accepted");
				const credentialAndAddress = `${record.id} ${request.ip}`;
				if (!restCredentialsSeen.has(credentialAndAddress)) {
					restCredentialsSeen.add(credentialAndAddress);
					server.security.authSucceeded({ via: "rest", sourceIp: request.ip, tokenId: record.id });
				}
			} else {
				// DB is required for token validation — fail closed to prevent
				// skipping expiry/revocation checks.
				server.log.warn({ url: pathname }, "auth: database unavailable");
				server.security.authFailed({
					via: "rest",
					sourceIp: request.ip,
					reason: "database_unavailable",
				});
				return reply.code(500).send({
					error: "SERVER_ERROR",
					message: "Database unavailable",
				});
			}
		});
	}

	// Health endpoint — unauthenticated, always available for debugging
	server.get("/api/health", async () => {
		return { status: "ok", version: HUB_VERSION, build: BUILD_HASH };
	});

	server.get("/api/assets/token", async () => {
		const token = getBootAssetToken();
		return { assetToken: token, token };
	});

	const fastifyMultipart = (await import("@fastify/multipart")).default;
	await server.register(fastifyMultipart, { limits: { fileSize: MAX_WALLPAPER_SIZE } });

	const agentRouteDeps = {
		authToken: options?.authToken ?? null,
		db: options?.dbManager?.meta ?? null,
		tokenTtlDays: authConfig.tokenTtlDays,
		isOriginAllowed: isCorsOriginAllowed,
	};
	if (!options?.dbManager) {
		registerAgentRoutes(server, agentRouteDeps);
	}

	// Register WebSocket support and routes when a dbManager is provided
	let sessionManager: SessionManager | null = null;
	if (options?.dbManager) {
		await server.register(websocket);

		// Load config from config.toml before creating SessionManager
		const gcConfig = loadGcConfig(configDir);

		// Build configResolver before SessionManager so it can be injected for title resolution
		const metaDalForConfig = new MetaDAL(options.dbManager.meta);
		const configResolver = new ConfigResolver(metaDalForConfig);
		configResolver.loadFromFile(configDir);

		// Build a shared LoggerRegistry if not provided (shared across SessionManager + agents)
		const loggerRegistry: LoggerRegistry = options.loggerRegistry ?? new Map();

		sessionManager = new SessionManager(
			options.dbManager,
			gcConfig,
			configResolver.agentConfig,
			configResolver,
			options.hubLogger,
			loggerRegistry,
			options.logsDir,
			server.security,
		);
		const activeSessionManager = sessionManager;
		if (options?.authToken) {
			activeSessionManager.setPrimaryToken(options.authToken);
		}
		const metaDal = new MetaDAL(options.dbManager.meta);
		metaDal.migrateHostGroupData();
		migrateLegacyShellDefaults(metaDal, configResolver);

		// First-run: ensure the built-in "local" host exists
		const wasNew = !metaDal.getHostByLabel("local");
		await activeSessionManager.ensureLocalHost();
		if (wasNew) {
			server.log.info("Created default local host");
		}

		// First-run: auto-detect and seed launch profiles from available shells.
		// Runs async after startup so it never blocks the server from accepting connections.
		// seedShellProfiles is idempotent — safe to call on every startup.
		// Skipped when skipShellDiscovery is set (e.g. in tests).
		if (!options?.skipShellDiscovery) {
			void seedShellProfiles(metaDal)
				.then((result) => {
					if (result.profilesCreated > 0) {
						server.log.info(
							{
								profilesCreated: result.profilesCreated,
								shells: result.profiles.map((p) => p.shell),
							},
							"auto-detected and created launch profiles for available shells",
						);
					}
				})
				// The probes now outlast the moment they were started in: a hub
				// stopped meanwhile has closed the database they write to.
				.catch((err: unknown) => {
					server.log.warn({ err }, "shell discovery did not complete");
				});
		}

		await activeSessionManager.startup();

		registerAgentRoutes(server, {
			...agentRouteDeps,
			broadcastAgentFetchMessage: (message) => {
				activeSessionManager.broadcastToAllClients(message);
			},
		});

		const wsRoutes = await registerWsRoutes(
			server,
			activeSessionManager,
			options.authToken,
			options.authToken ? (options.dbManager.meta ?? null) : null,
			options.authToken ? authConfig.tokenTtlDays : undefined,
		);
		registerHostRoutes(server, metaDal);
		registerHostGroupRoutes(server, metaDal);
		registerLaunchProfileRoutes(server, metaDal);
		registerSessionRoutes(server, metaDal, activeSessionManager);
		registerChannelRoutes(
			server,
			metaDal,
			activeSessionManager,
			activeSessionManager.getSpoolDal(),
		);
		registerGroupRoutes(server, metaDal);
		registerConfigRoutes(server, metaDal, configResolver, activeSessionManager);
		registerFontRoutes(server, configDir);
		registerWallpaperRoutes(server, configDir);
		registerSshKeyRoutes(server);
		const themeManager = new ThemeManager(configDir);
		await themeManager.init();
		registerThemeRoutes(server, themeManager, (message) => {
			activeSessionManager.broadcastToAllClients(message);
		});
		if (options.authToken) {
			registerPairRoutes(server, {
				authConfig: authConfig,
				db: options.dbManager.meta,
				metaDal,
				...(options.hubLogger && { hubLogger: options.hubLogger }),
			});
			registerTokenRoutes(server, {
				db: options.dbManager.meta,
				onRevoked: (tokenId) => wsRoutes.closeSocketsForToken(tokenId),
			});
		}
		await registerUserFonts(server, configDir);
		await registerUserSounds(server, configDir);
		await registerUserWallpapers(server, configDir);
		const logsDir = options.logsDir ?? path.join(getStateDir(), "logs");
		await registerLogRoutes(server, logsDir);
		server.addHook("onClose", async () => {
			await activeSessionManager.shutdown();
		});
	}

	server.post("/api/shutdown", (request, reply) => {
		if (!hasValidShutdownOwnerToken(request, options?.ownerToken)) {
			sendOwnerTokenRequired(reply);
			return;
		}
		if (!isLoopbackAddress(request.ip)) {
			sendLoopbackRequired(reply);
			return;
		}

		const url = new URL(request.url, "http://localhost");
		const force = url.searchParams.get("force") === "1";
		const callerClientId = getHeaderValue(
			request.headers["x-lasterm-client-id"] ?? request.headers["x-lasterm-client"],
		);
		const others = sessionManager?.getOthersCount(callerClientId) ?? 0;

		if (others > 0 && !force) {
			reply.code(409).send({ others });
			return;
		}

		reply.code(200).send({ ok: true });
		setImmediate(() => {
			Promise.resolve(options?.onShutdown?.()).catch((err) => {
				server.log.error({ err }, "shutdown request failed after response");
			});
		});
	});

	server.post("/api/quit", async (request, reply) => {
		if (!hasValidShutdownOwnerToken(request, options?.ownerToken)) {
			sendOwnerTokenRequired(reply);
			return;
		}
		if (!isLoopbackAddress(request.ip)) {
			sendLoopbackRequired(reply);
			return;
		}
		if (!options?.onQuit) return sendQuitUnavailable(reply);

		const url = new URL(request.url, "http://localhost");
		const force = url.searchParams.get("force") === "1";
		const callerClientId = getHeaderValue(
			request.headers["x-lasterm-client-id"] ?? request.headers["x-lasterm-client"],
		);
		// The guard is about STARTING a quit. Once one has begun, the terminals this
		// would have protected are already ending, and refusing would tell a caller
		// the quit was declined while the hub is in fact dying. An in-flight quit is
		// joined instead, which is what it did before this guard existed.
		const alreadyQuitting = sessionManager?.isQuitting() ?? false;
		const others = alreadyQuitting ? 0 : (sessionManager?.getOthersCount(callerClientId) ?? 0);
		if (others > 0 && !force) {
			return reply.code(409).send({
				others,
				message: `Quit would end terminals for ${others} other connected client(s); this count is a snapshot.`,
			});
		}

		const result = await options.onQuit(sessionManager);
		// Nothing was begun, so there is no teardown to hand over.
		if (result.unavailable) return sendQuitUnavailable(reply);
		reply.code(result.ok ? 200 : 503).send({
			ok: result.ok,
			message: result.ok ? "Local agent stopped; hub is shutting down" : result.message,
			// This records the request-scoped override, not proof of a human confirmation or an audit.
			...(force ? { override: true } : {}),
			...(result.stdout ? { stdout: result.stdout } : {}),
			...(result.stderr ? { stderr: result.stderr } : {}),
		});
		// Keep the request alive through the stopper, then allow Fastify to flush it
		// before the same coordinator tears the hub down.
		setImmediate(() => {
			Promise.resolve(options.onQuitDelivered?.()).catch((err) => {
				server.log.error({ err }, "quit request failed after response");
			});
		});
	});

	// Serve the embedded web client.
	// Priority: disk static/ directory → SEA embedded manifest → dev mode (no serving).
	await registerStaticIfExists(server);
	// When running as a SEA binary there is no static/ on disk — fall back to
	// the in-memory manifest embedded in the SEA blob.
	await registerSeaStaticServing(server);

	return server;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function hasValidShutdownOwnerToken(
	request: FastifyRequest,
	ownerToken: string | undefined,
): boolean {
	const candidate = getHeaderValue(request.headers["x-lasterm-owner"]);
	if (ownerToken === undefined || candidate === undefined) return false;
	return tokensEqual(candidate, ownerToken);
}

function sendOwnerTokenRequired(reply: FastifyReply): FastifyReply {
	return reply.code(401).send({
		error: "OWNER_TOKEN_REQUIRED",
		message: "Valid X-Lasterm-Owner header required",
	});
}

/**
 * A hub with no quit to run: no quit lifecycle, or no sessions and so no agent
 * to stop. It answers 501, not 503. A 503 is the stopper's own failure, after
 * which the hub tears down, and the CLI and the desktop both wait for that
 * teardown. Nothing here begins one (#523).
 */
function sendQuitUnavailable(reply: FastifyReply): FastifyReply {
	return reply
		.code(501)
		.send({ ok: false, error: "QUIT_UNAVAILABLE", message: "Quit is unavailable" });
}

function sendLoopbackRequired(reply: FastifyReply): FastifyReply {
	return reply.code(403).send({
		error: "LOOPBACK_REQUIRED",
		message: "Shutdown is only accepted from loopback clients",
	});
}

function isLoopbackAddress(ip: string): boolean {
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

export async function startServer(
	server: FastifyInstance,
	options?: StartServerOptions,
): Promise<string> {
	const host = options?.host ?? "127.0.0.1";
	if (options?.port === undefined) {
		return server.listen({ host, port: 0 });
	}

	const basePort = options.port;
	const maxPort = basePort + 99; // explicit-port zero_conf: try up to 100 ports

	for (let port = basePort; port <= maxPort; port++) {
		try {
			const address = await server.listen({ host, port });
			if (port !== basePort) {
				server.log.info({ basePort, port }, "hub: port unavailable, using zero_conf port");
			}
			return address;
		} catch (err: unknown) {
			const isAddrInUse =
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "EADDRINUSE";
			if (!isAddrInUse || port === maxPort) {
				throw err;
			}
		}
	}
	throw new Error(`No available port in range ${basePort}-${maxPort}`);
}

// ─── Static file helper ────────────────────────────────────────────────────────

/**
 * Register @fastify/static to serve the embedded web client from the
 * `static/` directory adjacent to this module.
 *
 * Graceful degradation: if the directory does not exist (i.e. during
 * development, where Vite serves the UI on a separate port), we simply
 * skip registration without throwing.
 */

/**
 * Register a second @fastify/static instance to serve user-provided fonts
 * from the config directory's `fonts/` subdirectory.
 *
 * The fonts directory is created on startup (mkdir -p) so users can just
 * drop .woff2 files in there.
 */
async function registerUserFonts(server: FastifyInstance, configDir: string): Promise<void> {
	const { mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const fontsDir = join(configDir, "fonts");
	mkdirSync(fontsDir, { recursive: true });

	const fastifyStatic = (await import("@fastify/static")).default;
	await server.register(fastifyStatic, {
		root: fontsDir,
		prefix: "/public/fonts/",
		decorateReply: false, // required for multiple @fastify/static plugins
	});

	server.log.info({ fontsDir }, "serving user fonts from config dir");
}

/**
 * Register a @fastify/static instance to serve user-provided sound files
 * from the config directory's `sounds/` subdirectory.
 *
 * The sounds directory is created on startup (mkdir -p) so users can just
 * drop audio files in there for custom bell sounds.
 */
async function registerUserSounds(server: FastifyInstance, configDir: string): Promise<void> {
	const { mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const soundsDir = join(configDir, "sounds");
	mkdirSync(soundsDir, { recursive: true });

	const fastifyStatic = (await import("@fastify/static")).default;
	await server.register(fastifyStatic, {
		root: soundsDir,
		prefix: "/public/sounds/",
		decorateReply: false, // required for multiple @fastify/static plugins
	});

	server.log.info({ soundsDir }, "serving user sounds from config dir");
}

/**
 * Register a @fastify/static instance to serve wallpaper images
 * from the config directory's `wallpapers/` subdirectory.
 */
async function registerUserWallpapers(server: FastifyInstance, configDir: string): Promise<void> {
	const { mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const wallpapersDir = join(configDir, "wallpapers");
	mkdirSync(wallpapersDir, { recursive: true });

	const fastifyStatic = (await import("@fastify/static")).default;
	await server.register(fastifyStatic, {
		root: wallpapersDir,
		prefix: "/public/wallpapers/",
		decorateReply: false,
		setHeaders: (reply) => {
			reply.header("X-Content-Type-Options", "nosniff");
		},
	});

	server.log.info({ wallpapersDir }, "serving user wallpapers from config dir");
}

async function registerStaticIfExists(server: FastifyInstance): Promise<void> {
	const { existsSync } = await import("node:fs");
	const { join, dirname } = await import("node:path");
	const { fileURLToPath } = await import("node:url");

	// Resolve static/ relative to this source file:
	// - In the compiled dist/ tree: dist/server.js → ../../static/ (i.e. package root/static/)
	// - In source under src/: src/server.ts → ../../static/ (same result)
	const thisFile = fileURLToPath(import.meta.url);
	const staticDir = join(dirname(thisFile), "..", "static");

	if (!existsSync(staticDir)) {
		server.log.debug(
			{ staticDir },
			"static dir not found — skipping static file serving (dev mode)",
		);
		return;
	}

	// Lazy import so @fastify/static is not loaded when the dir is absent
	const fastifyStatic = (await import("@fastify/static")).default;
	await server.register(fastifyStatic, {
		root: staticDir,
		prefix: "/",
		// SPA fallback: serve index.html for any path not matching a real file
		// so that Vue Router client-side routes work after a hard refresh.
		wildcard: false,
	});

	server.log.info({ staticDir }, "serving web UI from static dir");
}
