type ProbeResult = {
	detail: string;
	outcome: "indeterminate" | "reached" | "refused";
	route: string;
};
type RecordedRequest = { kind: string; method: string; path: string };
type WindowDocument = { origin: string };
declare const browser: {
	executeAsync<T>(
		script: (baseUrl: string, token: string, route: string, done: (result: T) => void) => void,
		baseUrl: string,
		token: string,
		route: string,
	): Promise<T>;
	getWindowHandles(): Promise<string[]>;
};
declare function describe(name: string, body: () => void): void;
declare function it(name: string, body: () => Promise<void>): void;

const sentinel = process.env.LASTERM_E2E_SENTINEL_URL;
if (!sentinel) throw new Error("Desktop boundary E2E sentinel URL was not supplied by the runner");
const sentinelUrl = sentinel;

const sentinelSettleMs = 250;

function expect(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function isPackagedOrigin(origin: string): boolean {
	return origin === "tauri://localhost" || origin === "http://tauri.localhost";
}

async function sentinelRequests(token: string): Promise<RecordedRequest[]> {
	const records = (await fetch(`${sentinelUrl}/__records`).then((response) =>
		response.json(),
	)) as RecordedRequest[];
	return records.filter((request) => request.path.includes(token));
}

async function runProbe(route: string): Promise<{ result: ProbeResult; token: string }> {
	const token = `boundary-token=${crypto.randomUUID()}`;
	try {
		const result = await browser.executeAsync<ProbeResult>(
			(baseUrl, tokenQuery, probeRoute, done) => {
				const url = `${baseUrl}/${probeRoute}?${tokenQuery}`;
				let settled = false;
				const finish = (outcome: ProbeResult["outcome"], detail: string) => {
					if (settled) return;
					settled = true;
					done({ detail, outcome, route: probeRoute });
				};
				const insecureOperationMessage = (error: unknown): string | undefined => {
					const message = error instanceof Error ? error.message : String(error);
					return /operation is insecure/i.test(message) ? message : undefined;
				};
				const refusedSynchronously = (operation: string, error: unknown) => {
					const message = insecureOperationMessage(error);
					if (message) {
						finish("refused", `${operation} threw synchronously: ${message}`);
					} else {
						finish("indeterminate", `${operation} threw unexpectedly: ${String(error)}`);
					}
				};
				window.setTimeout(
					() =>
						finish(
							"indeterminate",
							"route neither refused nor reached the sentinel before timeout",
						),
					1_000,
				);

				try {
					switch (probeRoute) {
						case "fetch":
							fetch(url).then(
								() => finish("reached", "fetch resolved"),
								() => finish("refused", "fetch rejected"),
							);
							break;
						case "xhr": {
							const request = new XMLHttpRequest();
							request.onload = () => finish("reached", `XHR loaded with ${request.status}`);
							request.onerror = () => finish("refused", "XHR error event");
							request.ontimeout = () => finish("refused", "XHR timeout");
							request.open("GET", url);
							request.send();
							break;
						}
						case "websocket": {
							try {
								const socket = new WebSocket(url.replace("http:", "ws:"));
								socket.onopen = () => {
									socket.close();
									finish("reached", "WebSocket opened");
								};
								socket.onerror = () => finish("refused", "WebSocket error event");
							} catch (error) {
								refusedSynchronously("WebSocket", error);
							}
							break;
						}
						case "event-source": {
							try {
								const source = new EventSource(url);
								source.onopen = () => {
									source.close();
									finish("reached", "EventSource opened");
								};
								source.onerror = () => {
									source.close();
									finish("refused", "EventSource error event");
								};
							} catch (error) {
								refusedSynchronously("EventSource", error);
							}
							break;
						}
						case "beacon": {
							const queued = navigator.sendBeacon(url, "boundary");
							finish(queued ? "reached" : "refused", `sendBeacon returned ${queued}`);
							break;
						}
						case "image": {
							const image = new Image();
							image.onload = () => finish("reached", "image loaded");
							image.onerror = () => finish("refused", "image error event");
							image.src = url;
							break;
						}
						case "window-open": {
							const popup = window.open(url, "_blank");
							window.setTimeout(
								() =>
									finish(
										popup === null ? "refused" : "reached",
										popup === null
											? "window.open returned null"
											: "window.open returned a browsing context",
									),
								250,
							);
							break;
						}
						case "form": {
							const before = location.href;
							const form = document.createElement("form");
							form.action = url;
							form.method = "GET";
							document.body.append(form);
							form.requestSubmit();
							window.setTimeout(
								() =>
									finish(
										location.href === before ? "refused" : "reached",
										location.href === before
											? "form remained at the packaged origin"
											: "form left the packaged origin",
									),
								250,
							);
							break;
						}
						default:
							finish("indeterminate", `unknown route ${probeRoute}`);
					}
				} catch (error) {
					refusedSynchronously(probeRoute, error);
				}
			},
			sentinelUrl,
			token,
			route,
		);
		return { result, token };
	} catch (error) {
		// A leaking form navigation can destroy this renderer script. The token's
		// sentinel record below still turns that abort into an explicit leak.
		return {
			result: {
				detail: `WebDriver script aborted: ${String(error)}`,
				outcome: "indeterminate",
				route,
			},
			token,
		};
	}
}

async function expectRouteRefused(route: string): Promise<void> {
	const { result, token } = await runProbe(route);
	// sendBeacon can return true before WebKit applies CSP. Give the local
	// sentinel a bounded chance to observe the actual network effect before
	// treating its record as the route's evidence of record.
	await new Promise((resolve) => setTimeout(resolve, sentinelSettleMs));
	const observed = await sentinelRequests(token);
	expect(
		observed.length === 0,
		`renderer boundary leak: ${route} reached the sentinel: ${JSON.stringify(observed)}`,
	);
	expect(
		result.outcome !== "indeterminate",
		`${route} probe was indeterminate and the sentinel saw no request: ${result.detail}`,
	);
	// A route-specific sentinel record is decisive. For example, WebKit may say
	// sendBeacon was queued even though CSP drops it; silence remains unsafe.
}

describe("packaged webview boundary", () => {
	it("loads the packaged application document before checking the boundary", async () => {
		const page = await browser.executeAsync<WindowDocument>(
			(_baseUrl, _token, _route, done) => done({ origin: location.origin }),
			"",
			"",
			"",
		);
		expect(
			isPackagedOrigin(page.origin),
			`main webview did not load the packaged application origin: ${page.origin}`,
		);
	});

	it("refuses fetch to the reachable sentinel", async () => expectRouteRefused("fetch"));
	it("refuses XMLHttpRequest to the reachable sentinel", async () => expectRouteRefused("xhr"));
	it("refuses WebSocket to the reachable sentinel", async () => expectRouteRefused("websocket"));
	it("refuses EventSource to the reachable sentinel", async () =>
		expectRouteRefused("event-source"));
	it("refuses navigator.sendBeacon to the reachable sentinel", async () =>
		expectRouteRefused("beacon"));
	it("refuses image loading from the reachable sentinel", async () => expectRouteRefused("image"));

	it("refuses opening a native browsing context at the reachable sentinel", async () => {
		const before = await browser.getWindowHandles();
		await expectRouteRefused("window-open");
		const after = await browser.getWindowHandles();
		expect(
			after.length === before.length,
			`renderer boundary leak: window.open created a native browsing context (${before.length} -> ${after.length})`,
		);
	});

	// Keep this last: a faulty form navigation can replace the document and abort
	// precisely this script, but cannot obscure the earlier boundary observations.
	it("refuses form navigation to the reachable sentinel", async () => expectRouteRefused("form"));

	// Do not assert native X11 mapping here. On both Xvfb and a network X server,
	// this transparent, decorationless window lacks the needed ARGB visual and is
	// never realised even before this suite; the renderer boundary cannot own it.
});
