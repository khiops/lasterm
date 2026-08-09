import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

const UPLOAD_CHUNK_BYTES = 256 * 1024;
const textEncoder = new TextEncoder();

type RelayRequest = {
	method: string;
	path: string;
	headers: [string, string][];
	body: string | null;
};

type RelayHead = {
	id: number;
	status: number;
	statusText: string;
	headers: [string, string][];
};

type RelayStreamError = { error: string };

/** A failed pinned-shell request, never an HTTP response with a synthetic status. */
export class HubRelayTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HubRelayTransportError";
	}
}

/**
 * The only REST transport for hub calls.
 *
 * Browsers retain ordinary fetch semantics. In a desktop webview the command
 * sends the request from Rust, which is the process holding the hub SPKI pin.
 */
export function hubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	if (!isDesktopRelayRuntime()) return fetch(input, init);
	if (!isDesktopHubUrl(input)) {
		return Promise.reject(new HubRelayTransportError("desktop hub requests must target 127.0.0.1"));
	}
	return relayHubFetch(input, init);
}

async function relayHubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = new Request(input, init);
	const relayRequest: RelayRequest = {
		method: request.method,
		path: relayPath(request.url),
		headers: [...request.headers.entries()],
		body: null,
	};

	if (request.body === null) return relayRequestToResponse(relayRequest);
	if (init?.body instanceof FormData) return relayUploadToResponse(relayRequest, init.body);

	relayRequest.body = await request.text();
	return relayRequestToResponse(relayRequest);
}

function isDesktopHubUrl(input: RequestInfo | URL): boolean {
	const value = input instanceof Request ? input.url : input.toString();
	return new URL(value, window.location.href).hostname === "127.0.0.1";
}

function isDesktopRelayRuntime(): boolean {
	if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
	const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
		.__TAURI_INTERNALS__;
	return typeof internals?.invoke === "function";
}

function relayPath(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
		throw new HubRelayTransportError("desktop hub requests must target the local hub");
	}
	return `${parsed.pathname}${parsed.search}`;
}

async function relayRequestToResponse(request: RelayRequest): Promise<Response> {
	const { Channel, invoke } = await import("@tauri-apps/api/core");
	let responseId: number | null = null;
	const stream = responseStream(
		new Channel<ArrayBuffer | RelayStreamError>((frame) => {
			stream.receive(frame);
		}),
		() => responseId,
	);

	try {
		const head = await invoke<RelayHead>("relay_hub_request", {
			request,
			response: stream.channel,
		});
		responseId = head.id;
		stream.drain();
		return relayResponse(head, stream.body);
	} catch (error) {
		throw relayTransportError(error);
	}
}

async function relayUploadToResponse(request: RelayRequest, formData: FormData): Promise<Response> {
	const { Channel, invoke } = await import("@tauri-apps/api/core");
	const boundary = multipartBoundary();
	request.headers = request.headers.filter(([name]) => name.toLowerCase() !== "content-type");
	request.headers.push(["content-type", `multipart/form-data; boundary=${boundary}`]);

	let uploadId: number;
	try {
		uploadId = await invoke<number>("relay_hub_upload_start", { request });
		await sendMultipartChunks(uploadId, formData, boundary, invoke);
	} catch (error) {
		throw relayTransportError(error);
	}

	let responseId: number | null = null;
	const stream = responseStream(
		new Channel<ArrayBuffer | RelayStreamError>((frame) => {
			stream.receive(frame);
		}),
		() => responseId,
	);
	try {
		const head = await invoke<RelayHead>("relay_hub_upload_finish", {
			uploadId,
			response: stream.channel,
		});
		responseId = head.id;
		stream.drain();
		return relayResponse(head, stream.body);
	} catch (error) {
		throw relayTransportError(error);
	}
}

async function sendMultipartChunks(
	uploadId: number,
	formData: FormData,
	boundary: string,
	invoke: <T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>,
): Promise<void> {
	for (const [name, value] of formData.entries()) {
		if (value instanceof File) {
			await sendMultipartBytes(
				uploadId,
				textEncoder.encode(
					`--${boundary}\r\nContent-Disposition: form-data; name="${quoteMultipart(name)}"; filename="${quoteMultipart(value.name)}"\r\nContent-Type: ${value.type || "application/octet-stream"}\r\n\r\n`,
				),
				invoke,
			);
			for (let offset = 0; offset < value.size; offset += UPLOAD_CHUNK_BYTES) {
				const chunk = await value.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer();
				await sendMultipartBytes(uploadId, new Uint8Array(chunk), invoke);
			}
			await sendMultipartBytes(uploadId, textEncoder.encode("\r\n"), invoke);
		} else {
			await sendMultipartBytes(
				uploadId,
				textEncoder.encode(
					`--${boundary}\r\nContent-Disposition: form-data; name="${quoteMultipart(name)}"\r\n\r\n${value}\r\n`,
				),
				invoke,
			);
		}
	}
	await sendMultipartBytes(uploadId, textEncoder.encode(`--${boundary}--\r\n`), invoke);
}

function multipartBoundary(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return `----lasterm-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function quoteMultipart(value: string): string {
	return value.replace(/[\r\n"]/g, (character) =>
		character === '"' ? "%22" : character === "\r" ? "%0D" : "%0A",
	);
}

async function sendMultipartBytes(
	uploadId: number,
	bytes: Uint8Array,
	invoke: <T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>,
): Promise<void> {
	for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
		const chunk = bytes.slice(offset, offset + UPLOAD_CHUNK_BYTES);
		await invoke("relay_hub_upload_chunk", chunk.buffer, {
			headers: { "X-Lasterm-Upload-Id": String(uploadId) },
		});
	}
}

function responseStream(
	channel: { onmessage: ((message: ArrayBuffer | RelayStreamError) => void) | null },
	responseId: () => number | null,
): {
	channel: typeof channel;
	body: ReadableStream<Uint8Array>;
	receive: (frame: ArrayBuffer | RelayStreamError) => void;
	drain: () => void;
} {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let pending: ArrayBuffer | RelayStreamError | undefined;
	let finished = false;

	const acknowledge = (cancel = false) => {
		const id = responseId();
		if (id === null) return;
		void import("@tauri-apps/api/core").then(({ invoke }) =>
			invoke("relay_hub_response_ack", { responseId: id, cancel }).catch(() => undefined),
		);
	};
	const drain = () => {
		if (
			controller === undefined ||
			pending === undefined ||
			finished ||
			controller.desiredSize === 0
		) {
			return;
		}
		const frame = pending;
		pending = undefined;
		if (frame instanceof ArrayBuffer) {
			if (frame.byteLength === 0) {
				finished = true;
				controller.close();
				return;
			}
			controller.enqueue(new Uint8Array(frame));
			acknowledge();
			return;
		}
		finished = true;
		controller.error(new HubRelayTransportError(frame.error));
	};
	const receive = (frame: ArrayBuffer | RelayStreamError) => {
		pending = frame;
		drain();
	};
	channel.onmessage = receive;

	return {
		channel,
		body: new ReadableStream<Uint8Array>({
			start(nextController) {
				controller = nextController;
				drain();
			},
			pull() {
				drain();
			},
			cancel() {
				finished = true;
				acknowledge(true);
			},
		}),
		receive,
		drain,
	};
}

function relayResponse(head: RelayHead, body: ReadableStream<Uint8Array>): Response {
	return new Response(head.status === 204 || head.status === 304 ? null : body, {
		status: head.status,
		statusText: head.statusText,
		headers: head.headers,
	});
}

function relayTransportError(error: unknown): HubRelayTransportError {
	return new HubRelayTransportError(
		`hub relay failed: ${error instanceof Error ? error.message : String(error)}`,
	);
}
