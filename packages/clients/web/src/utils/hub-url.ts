/**
 * Returns the base URL for hub API/WS calls.
 * In Tauri desktop, the hub runs as a separate sidecar on a dynamic port
 * (resolved at startup via runtime.json). Call initHubPort() once at app
 * startup to cache the port before any API calls are made.
 * In web mode (dev or hub-served), relative URLs work via proxy or same-origin.
 */

import { readonly, ref } from "vue";

let _cachedPort: number | null = null;
let _assetToken: string | null = null;
const _hubPortReady = ref(false);
const _assetTokenReady = ref(false);
const ASSET_TOKEN_QUERY_PARAM = "asset_token";

export const hubPortReady = readonly(_hubPortReady);
export const assetTokenReady = readonly(_assetTokenReady);

export function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The hub's port, resolved once by the desktop shell and cached here.
 *
 * There is no default. A default here would be a second copy of a decision the
 * shell already made — and the wrong copy: guessing 4100 when the real port is
 * unknown is how a client comes to send its bearer token to whatever holds that
 * port. Outside the desktop runtime there is no port to resolve at all, since the
 * page is served by the hub and every URL stays relative.
 */
async function getHubPort(): Promise<number> {
	if (_cachedPort !== null) return _cachedPort;
	if (!isTauriRuntime()) {
		throw new Error("the hub port is only resolvable inside the desktop runtime");
	}
	const { invoke } = await import("@tauri-apps/api/core");
	const port = await invoke<number>("get_hub_port");
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`the desktop shell reported an unusable hub port: ${port}`);
	}
	_cachedPort = port;
	return _cachedPort;
}

/**
 * The resolved port, or a failure naming what was skipped.
 *
 * Every caller of the two URL builders below runs after `initHubPort`, so an
 * unresolved port is a missing await rather than a state to paper over. Saying so
 * is the difference between a caller that gets fixed and a token sent to a port
 * nobody chose.
 */
function requireResolvedPort(): number {
	if (_cachedPort === null) {
		throw new Error("hub port used before initHubPort() resolved it");
	}
	return _cachedPort;
}

// The literal address, never the name: the hub binds `127.0.0.1`, and `localhost`
// can resolve to `::1` first. Another local process may hold `::1:<port>` while our
// hub owns `127.0.0.1:<port>`, and this client would then send its bearer token
// there. `localOrigin` below keeps the name because it serves the browser case,
// where the origin is the page's own and no port of ours is involved.
export function hubBaseUrl(): string {
	if (isTauriRuntime()) {
		return `http://127.0.0.1:${requireResolvedPort()}`;
	}
	return "";
}

export function hubWsUrl(): string {
	if (isTauriRuntime()) {
		return `ws://127.0.0.1:${requireResolvedPort()}`;
	}
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}`;
}

/**
 * Call once at app startup. In the desktop runtime this caches the port the shell
 * resolved; in a browser there is no port to resolve, and readiness means exactly
 * that — nothing is pending. Reporting "not ready" there would stall every consumer
 * watching `hubPortReady` for a value that is never coming.
 */
export async function initHubPort(): Promise<void> {
	if (isTauriRuntime()) {
		await getHubPort();
	}
	_hubPortReady.value = true;
}

export async function initAssetToken(authToken: string | null): Promise<void> {
	const response = await fetch(`${hubBaseUrl()}/api/assets/token`, {
		...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
	});
	if (!response.ok) {
		throw new Error(`Failed to load asset token: ${response.status}`);
	}
	const body = (await response.json()) as { assetToken?: string; token?: string };
	const token = body.assetToken ?? body.token ?? null;
	if (!token) throw new Error("Asset token response missing token");
	_assetToken = token;
	_assetTokenReady.value = true;
}

export function clearAssetToken(): void {
	_assetToken = null;
	_assetTokenReady.value = false;
}

export function setAssetTokenForTests(token: string | null): void {
	_assetToken = token;
	_assetTokenReady.value = token !== null;
}

/**
 * Stands in for the desktop shell's resolution, so a test can exercise the URL
 * builders. There is no production path that sets the port without asking the
 * shell, which is the property the builders' failure protects.
 */
export function setHubPortForTests(port: number | null): void {
	_cachedPort = port;
	_hubPortReady.value = port !== null;
}

function localOrigin(): string {
	if (typeof window !== "undefined" && window.location?.origin) {
		return window.location.origin;
	}
	return "http://localhost";
}

export function publicAssetUrl(
	pathOrUrl: string,
	extraParams?: Record<string, number | string | null | undefined>,
): string {
	const isAbsolute = /^[a-z][a-z\d+\-.]*:\/\//i.test(pathOrUrl);
	const hubBase = hubBaseUrl();
	const base = isAbsolute ? undefined : hubBase || localOrigin();
	const url = new URL(pathOrUrl, base);

	if (_assetToken) {
		url.searchParams.set(ASSET_TOKEN_QUERY_PARAM, _assetToken);
	}
	if (extraParams) {
		for (const [key, value] of Object.entries(extraParams)) {
			if (value === null || value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
	}

	if (isAbsolute) return url.toString();
	return `${hubBase}${url.pathname}${url.search}${url.hash}`;
}

export function namedPublicAssetUrl(
	kind: "fonts" | "sounds" | "wallpapers",
	filename: string,
	extraParams?: Record<string, number | string | null | undefined>,
): string {
	return publicAssetUrl(`/public/${kind}/${encodeURIComponent(filename)}`, extraParams);
}
