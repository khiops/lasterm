import { timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import cors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import { DEFAULT_PORT, MAX_WALLPAPER_SIZE } from "@termora/shared";
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
import { touchToken, upsertPrimaryToken, validateTokenRecord } from "./auth.js";
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
import { registerSeaStaticServing } from "./sea-static-server.js";
import { SessionManager } from "./session/session-manager.js";
import { seedShellProfiles } from "./shell-discovery.js";
import type { DatabaseManager } from "./storage/db.js";
import { MetaDAL } from "./storage/meta.js";
import { migrateLegacyShellDefaults } from "./storage/migrate-launch-profiles.js";
import { ThemeManager } from "./theme-manager.js";
import { registerWsRoutes } from "./ws/ws-handler.js";

/**
 * Mutable set of exact CORS origins allowed by the server.
 * Pre-populated with Tauri origins and user-configured origins at server creation.
 * Exact localhost origins (e.g. http://localhost:4100) are added after the server
 * starts and the actual port is known — call addStartupCorsOrigins() after listen.
 */
const _corsAllowedOrigins = new Set<string>();
const PROTECTED_PUBLIC_ASSET_PREFIXES = ["/public/fonts", "/public/sounds", "/public/wallpapers"];

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
export function addStartupCorsOrigins(address: string, requestedPort: number): number {
	const port = new URL(address).port;
	const actualPort = port ? Number(port) : requestedPort;

	// SEC-020: Inject exact localhost origins now that the actual port is known.
	// These replace the former wildcard http://localhost:* and http://127.0.0.1:* patterns.
	addCorsOrigins(`http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`);
	// In non-production environments also allow the Vite dev server origin.
	if (process.env.NODE_ENV !== "production") {
		addCorsOrigins("http://localhost:5173");
	}

	return actualPort;
}

export interface ServerOptions {
	host?: string; // default: "127.0.0.1"
	port?: number; // default: DEFAULT_PORT (4100)
	logger?: boolean; // default: true
	dbManager?: DatabaseManager; // when provided, WS routes are registered
	authToken?: string; // when provided, Bearer auth is enforced on all routes except /api/health
	ownerToken?: string; // shutdown-only owner token from runtime.json
	onShutdown?: () => Promise<void> | void; // called after POST /api/shutdown has replied
	authConfig?: AuthConfig; // override auth config (bypasses config.toml, useful for tests)
	configDir?: string; // override config directory (defaults to getConfigDir())
	corsOrigins?: string[]; // override CORS allowlist (bypasses config.toml, useful for tests)
	skipShellDiscovery?: boolean; // disable auto-shell-seeding (useful for tests)
	hubLogger?: HubLogger; // global hub log sink
	loggerRegistry?: LoggerRegistry; // per-channel log registry
	logsDir?: string; // base logs directory (e.g. ~/.local/state/termora/logs)
}

export async function createServer(options?: ServerOptions): Promise<FastifyInstance> {
	const server = Fastify({
		logger: options?.logger ?? true,
	});

	// Helmet — sets security-related HTTP response headers
	await server.register(fastifyHelmet, {
		contentSecurityPolicy: {
			directives: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'", "'unsafe-inline'"],
				connectSrc: ["'self'", "ws:", "wss:"],
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
			"X-Termora-Owner",
			"X-Termora-Client",
			"X-Termora-Client-Id",
		],
		credentials: true,
	});

	server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		const pathname = new URL(request.url, "http://localhost").pathname;
		if (request.method !== "POST" || pathname !== "/api/shutdown") return;

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
			upsertPrimaryToken(db, primaryToken);
		}

		server.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
			// CORS preflight is handled by @fastify/cors — skip auth.
			if (request.method === "OPTIONS") return;

			// Parse pathname from the raw URL to avoid query-string or path-traversal bypasses.
			const pathname = new URL(request.url, "http://localhost").pathname;

			// Unauthenticated endpoints — exact pathname match
			if (pathname === "/api/health") return;
			if (pathname === "/api/pair/verify") return;
			if (request.method === "POST" && pathname === "/api/shutdown") return;

			// WebSocket auth is handled at the message level (AUTH → AUTH_OK/AUTH_FAIL),
			// not at the HTTP upgrade level.
			if (pathname === "/ws" || pathname.startsWith("/ws/")) return;

			// Static assets (index.html, JS bundles, etc.) do not require auth —
			// the UI itself handles the pairing/auth flow on first load.
			if (!pathname.startsWith("/api/")) return;

			const authHeader = request.headers.authorization;
			if (!authHeader) {
				server.log.warn({ url: pathname }, "auth: missing Authorization header");
				return reply.code(401).send({
					error: "AUTH_REQUIRED",
					message: "Authorization header required",
				});
			}

			const [scheme, token] = authHeader.split(" ");
			if (scheme !== "Bearer" || !token) {
				server.log.warn({ url: pathname }, "auth: malformed Authorization header");
				return reply.code(401).send({
					error: "AUTH_REQUIRED",
					message: "Authorization header must be: Bearer <token>",
				});
			}

			if (db) {
				// DB-backed validation: checks expiry and revocation status
				const record = validateTokenRecord(db, token);
				if (!record) {
					server.log.warn({ url: pathname }, "auth: invalid, expired, or revoked token");
					return reply.code(401).send({
						error: "AUTH_INVALID",
						message: "Invalid, expired, or revoked token",
					});
				}
				// Sliding-window expiry refresh + last_used_at update (best-effort, non-blocking)
				try {
					touchToken(db, record.id, ttlDays);
				} catch (err) {
					server.log.warn({ err, tokenId: record.id }, "touchToken failed");
				}
				server.log.debug({ url: pathname, tokenId: record.id }, "auth: accepted");
			} else {
				// DB is required for token validation — fail closed to prevent
				// skipping expiry/revocation checks.
				server.log.warn({ url: pathname }, "auth: database unavailable");
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
		);
		const activeSessionManager = sessionManager;
		if (options?.authToken) {
			activeSessionManager.setPrimaryToken(options.authToken);
		}
		const metaDal = activeSessionManager.getMetaDal();
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
			void seedShellProfiles(metaDal).then((result) => {
				if (result.profilesCreated > 0) {
					server.log.info(
						{
							profilesCreated: result.profilesCreated,
							shells: result.profiles.map((p) => p.shell),
						},
						"auto-detected and created launch profiles for available shells",
					);
				}
			});
		}

		await activeSessionManager.startup();

		registerAgentRoutes(server, {
			...agentRouteDeps,
			broadcastAgentFetchMessage: (message) => {
				activeSessionManager.broadcastToAllClients(message);
			},
		});

		await registerWsRoutes(
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
		registerThemeRoutes(server, themeManager);
		if (options.authToken) {
			registerPairRoutes(server, {
				authConfig: authConfig,
				db: options.dbManager.meta,
				metaDal,
				...(options.hubLogger && { hubLogger: options.hubLogger }),
			});
			registerTokenRoutes(server, { db: options.dbManager.meta });
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
			request.headers["x-termora-client-id"] ?? request.headers["x-termora-client"],
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
	const candidate = getHeaderValue(request.headers["x-termora-owner"]);
	if (ownerToken === undefined || candidate === undefined) return false;

	const expected = Buffer.from(ownerToken);
	const actual = Buffer.from(candidate);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendOwnerTokenRequired(reply: FastifyReply): FastifyReply {
	return reply.code(401).send({
		error: "OWNER_TOKEN_REQUIRED",
		message: "Valid X-Termora-Owner header required",
	});
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
	options?: ServerOptions,
): Promise<string> {
	const host = options?.host ?? "127.0.0.1";
	const basePort = options?.port ?? DEFAULT_PORT;
	const maxPort = basePort + 99; // zero_conf: try up to 100 ports

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
