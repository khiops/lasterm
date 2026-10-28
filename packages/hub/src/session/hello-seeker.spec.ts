import { encodeFrame, FrameReader, type ProtocolMessage } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { HelloSeeker, MAX_SHELL_PRELUDE_BYTES } from "./hello-seeker.js";

const HELLO = Buffer.from(
	encodeFrame({
		type: "HELLO",
		version: 1,
		agentVersion: "0.14.3",
		capabilities: ["multiplex", "snapshot", "resize"],
		availableShells: ["powershell.exe", "cmd.exe"],
	}),
);
const NEXT = Buffer.from(encodeFrame({ type: "CHANNEL_STATE_END", otherOwnerChannels: 0 }));

/** Push `chunks` in turn; what the seeker said after the last one. */
function seek(seeker: HelloSeeker, ...chunks: Buffer[]) {
	let last = seeker.push(Buffer.alloc(0));
	for (const chunk of chunks) last = seeker.push(chunk);
	return last;
}

/** The frames in what the seeker handed on. */
function frames(bytes: Buffer): ProtocolMessage[] {
	return new FrameReader().push(bytes);
}

describe("HelloSeeker (#749)", () => {
	it("hands on a stream that starts with HELLO as it is", () => {
		const result = seek(new HelloSeeker(), Buffer.concat([HELLO, NEXT]));
		expect(result).toMatchObject({ found: true, prelude: 0 });
		if (!result.found) throw new Error("not found");
		expect(result.frames.equals(Buffer.concat([HELLO, NEXT]))).toBe(true);
	});

	it.each([
		["a banner", Buffer.from("Welcome to the server!\r\n")],
		["escape sequences", Buffer.from("\u001b]0;posh\u0007\u001b[32mok\u001b[0m\r\n")],
		[
			"PowerShell's own timing",
			Buffer.from("Loading personal and system profiles took 6012ms.\r\n"),
		],
		["NUL and high bytes", Buffer.from([0, 0, 0, 0, 0xff, 0xfe, 0x0d, 0x0a, 0, 1])],
		// A whole frame that decodes, but is no HELLO.
		["a frame that is not HELLO", Buffer.from(encodeFrame({ type: "HEARTBEAT", ts: "x" }))],
		// A length prefix that runs into the real frame.
		["a length that runs past it", Buffer.from([0x10, 0, 0, 0, 0x81])],
		["the limit's worth", Buffer.alloc(MAX_SHELL_PRELUDE_BYTES, "x")],
	])("skips %s before HELLO, and only that", (_name, prelude) => {
		const result = seek(new HelloSeeker(), prelude, Buffer.concat([HELLO, NEXT]));
		expect(result).toMatchObject({ found: true, prelude: prelude.length });
		if (!result.found) throw new Error("not found");
		expect(frames(result.frames).map((m) => m.type)).toEqual(["HELLO", "CHANNEL_STATE_END"]);
	});

	it("finds HELLO however the bytes are cut", () => {
		const stream = Buffer.concat([Buffer.from("profile says hi\r\n"), HELLO, NEXT]);
		for (const size of [1, 2, 3, 5, 7, 64]) {
			const seeker = new HelloSeeker();
			let result = seeker.push(Buffer.alloc(0));
			for (let at = 0; at < stream.length && !result.found; at += size) {
				result = seeker.push(stream.subarray(at, at + size));
			}
			expect(result, `in pieces of ${size}`).toMatchObject({ found: true, prelude: 17 });
		}
	});

	it("waits while HELLO may still come", () => {
		const seeker = new HelloSeeker();
		expect(seek(seeker, Buffer.from("profile"), HELLO.subarray(0, HELLO.length - 1))).toEqual({
			found: false,
			given: false,
		});
		expect(seeker.bytes).toBe(7 + HELLO.length - 1);
		expect(seek(seeker, HELLO.subarray(HELLO.length - 1))).toMatchObject({
			found: true,
			prelude: 7,
		});
	});

	it("gives up once HELLO can no longer start within the limit", () => {
		const seeker = new HelloSeeker();
		const text = Buffer.alloc(16 * 1024, "y");
		let result = seeker.push(Buffer.alloc(0));
		let pushed = 0;
		while (!result.found && !("given" in result && result.given)) {
			result = seeker.push(text);
			pushed += text.length;
			expect(pushed, "never gave up").toBeLessThan(1024 * 1024);
		}
		expect(result).toEqual({ found: false, given: true });
		expect(seeker.bytes).toBe(pushed);
		expect(pushed).toBeGreaterThan(2 * MAX_SHELL_PRELUDE_BYTES);
	});

	it("does not look for HELLO past the limit", () => {
		const result = seek(
			new HelloSeeker(),
			Buffer.alloc(MAX_SHELL_PRELUDE_BYTES + 1, "z"),
			HELLO,
			Buffer.alloc(MAX_SHELL_PRELUDE_BYTES, "z"),
		);
		expect(result).toEqual({ found: false, given: true });
	});
});
