import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

type RelayRequest = {
	method: string;
	path: string;
	headers: [string, string][];
	body: null;
};

type RelayHead = {
	id: number;
	status: number;
	statusText: string;
	headers: [string, string][];
};

const UPLOAD_CHUNK_BYTES = 256 * 1024;
const RELAY_FRAME_HEADER_BYTES = 17;
const RELAY_DATA_FRAME = 0;
const RELAY_END_FRAME = 1;
const RELAY_ERROR_FRAME = 2;

type RelayFrame = {
	id: number;
	sequence: number;
	kind: number;
	payload: ArrayBuffer;
};

/** The subset of fetch options the desktop relay implements in both runtimes. */
export type HubFetchInit = Pick<RequestInit, "method" | "headers" | "body">;

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
export function hubFetch(input: string | URL, init?: HubFetchInit): Promise<Response> {
	if (!isDesktopRelayRuntime()) return fetch(input, init);
	if (!isDesktopHubUrl(input)) {
		return Promise.reject(new HubRelayTransportError("desktop hub requests must target 127.0.0.1"));
	}
	return relayHubFetch(input, init);
}

async function relayHubFetch(input: string | URL, init?: HubFetchInit): Promise<Response> {
	const request = new Request(input, init);
	const relayRequest: RelayRequest = {
		method: request.method,
		path: relayPath(request.url),
		headers: [...request.headers.entries()],
		body: null,
	};

	return request.body === null
		? relayRequestToResponse(relayRequest)
		: relayUploadToResponse(relayRequest, request.body);
}

function isDesktopHubUrl(input: string | URL): boolean {
	return new URL(input.toString(), window.location.href).hostname === "127.0.0.1";
}

function isDesktopRelayRuntime(): boolean {
	if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
	const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
		.__TAURI_INTERNALS__;
	return typeof internals?.invoke === "function";
}

function relayPath(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.hostname !== "127.0.0.1") {
		throw new HubRelayTransportError("desktop hub requests must target the local hub");
	}
	return `${parsed.pathname}${parsed.search}`;
}

async function relayRequestToResponse(request: RelayRequest): Promise<Response> {
	const { Channel, invoke } = await import("@tauri-apps/api/core");
	const stream = responseStream(
		new Channel<ArrayBuffer>((frame) => {
			stream.receive(frame);
		}),
	);

	try {
		const head = await invoke<RelayHead>("relay_hub_request", {
			request,
			response: stream.channel,
		});
		stream.setResponseId(head.id);
		stream.drain();
		return relayResponse(request.method, head, stream.body);
	} catch (error) {
		throw relayTransportError(error);
	}
}

async function relayUploadToResponse(
	request: RelayRequest,
	body: ReadableStream<Uint8Array>,
): Promise<Response> {
	const { Channel, invoke } = await import("@tauri-apps/api/core");

	let uploadId: number | null = null;
	try {
		uploadId = await invoke<number>("relay_hub_upload_start", { request });
		await sendRequestChunks(uploadId, body, invoke);

		const stream = responseStream(
			new Channel<ArrayBuffer>((frame) => {
				stream.receive(frame);
			}),
		);
		const head = await invoke<RelayHead>("relay_hub_upload_finish", {
			uploadId,
			response: stream.channel,
		});
		uploadId = null;
		stream.setResponseId(head.id);
		stream.drain();
		return relayResponse(request.method, head, stream.body);
	} catch (error) {
		throw relayTransportError(error);
	} finally {
		if (uploadId !== null) {
			// `finish` transfers and removes the slot. Every other outcome must
			// explicitly release the map entry and close the body's sender.
			try {
				await invoke("relay_hub_upload_cancel", { uploadId });
			} catch (cancelError) {
				const message = `hub relay cancellation failed: ${String(cancelError)}`;
				console.error(message);
			}
		}
	}
}

async function sendRequestChunks(
	uploadId: number,
	body: ReadableStream<Uint8Array>,
	invoke: <T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>,
): Promise<void> {
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value.byteLength === 0) continue;
			for (let offset = 0; offset < value.byteLength; offset += UPLOAD_CHUNK_BYTES) {
				// Allocate only this IPC frame: some browser streams yield views onto a
				// larger backing buffer, which must not cross the boundary wholesale.
				const payload = new Uint8Array(value.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
				await invoke("relay_hub_upload_chunk", payload.buffer, {
					headers: { "X-Lasterm-Upload-Id": String(uploadId) },
				});
			}
		}
	} catch (error) {
		await reader
			.cancel(error)
			.catch((cancelError) =>
				console.error(`hub relay request stream cancellation failed: ${String(cancelError)}`),
			);
		throw error;
	}
}

function responseStream(channel: { onmessage: ((message: ArrayBuffer) => void) | null }): {
	channel: typeof channel;
	body: ReadableStream<Uint8Array>;
	receive: (frame: ArrayBuffer) => void;
	setResponseId: (id: number) => void;
	drain: () => void;
} {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let pending: RelayFrame | undefined;
	let finished = false;
	let responseId: number | null = null;
	let cancelAttempted = false;

	const cancelRelay = () => {
		if (cancelAttempted || responseId === null) return;
		cancelAttempted = true;
		void import("@tauri-apps/api/core").then(({ invoke }) =>
			invoke("relay_hub_response_cancel", { responseId }).catch((error) =>
				console.error(`hub relay response cancellation failed: ${String(error)}`),
			),
		);
	};
	const fail = (message: string) => {
		if (finished) return;
		finished = true;
		cancelRelay();
		controller?.error(new HubRelayTransportError(message));
	};

	const acknowledge = (frame: RelayFrame) => {
		void import("@tauri-apps/api/core")
			.then(({ invoke }) =>
				invoke("relay_hub_response_ack", { responseId: frame.id, sequence: frame.sequence }),
			)
			.catch((error) => fail(`hub relay acknowledgement failed: ${String(error)}`));
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
		if (frame.kind === RELAY_DATA_FRAME) {
			controller.enqueue(new Uint8Array(frame.payload));
			acknowledge(frame);
			return;
		}
		if (frame.kind === RELAY_END_FRAME) {
			finished = true;
			controller.close();
			return;
		}
		if (frame.kind === RELAY_ERROR_FRAME) {
			finished = true;
			controller.error(new HubRelayTransportError(new TextDecoder().decode(frame.payload)));
			return;
		}
		fail("hub relay sent an unknown response frame");
	};
	const receive = (frame: ArrayBuffer) => {
		let decoded: RelayFrame;
		try {
			decoded = decodeRelayFrame(frame);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
			return;
		}
		if (responseId !== null && responseId !== decoded.id) {
			fail("hub relay response frame belongs to another relay");
			return;
		}
		responseId ??= decoded.id;
		pending = decoded;
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
				cancelRelay();
			},
		}),
		receive,
		setResponseId(id) {
			if (responseId !== null && responseId !== id) {
				fail("hub relay response head belongs to another relay");
				return;
			}
			responseId = id;
		},
		drain,
	};
}

function decodeRelayFrame(frame: ArrayBuffer): RelayFrame {
	if (frame.byteLength < RELAY_FRAME_HEADER_BYTES) {
		throw new HubRelayTransportError("hub relay sent a truncated response frame");
	}
	const view = new DataView(frame);
	const id = Number(view.getBigUint64(0, true));
	const sequence = Number(view.getBigUint64(8, true));
	if (!Number.isSafeInteger(id) || !Number.isSafeInteger(sequence) || id < 1 || sequence < 1) {
		throw new HubRelayTransportError("hub relay sent an invalid response frame identity");
	}
	return {
		id,
		sequence,
		kind: view.getUint8(16),
		payload: frame.slice(RELAY_FRAME_HEADER_BYTES),
	};
}

function relayResponse(
	method: string,
	head: RelayHead,
	body: ReadableStream<Uint8Array>,
): Response {
	// Keep this exact Fetch null-body set aligned with packages/hub/src/cli.ts.
	const responseBody =
		method === "HEAD" || head.status === 204 || head.status === 205 || head.status === 304
			? null
			: body;
	return new Response(responseBody, {
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
