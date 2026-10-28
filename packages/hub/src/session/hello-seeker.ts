import { decodeMessage } from "@lasterm/shared";

/**
 * How many bytes the remote shell may print before a stdio agent's HELLO
 * (#749). A banner, a prompt module's escape sequences, PowerShell's own
 * "Loading personal and system profiles took …" fit many times over.
 */
export const MAX_SHELL_PRELUDE_BYTES = 64 * 1024;

/** The largest HELLO frame looked for: one is a few hundred bytes. */
const MAX_HELLO_FRAME_BYTES = 64 * 1024;

const LENGTH_PREFIX_BYTES = 4;

/** What a `HelloSeeker` made of the bytes so far. */
export type HelloSeek =
	/** HELLO's frame starts `prelude` bytes in; `frames` is the stream from there on. */
	| { readonly found: true; readonly prelude: number; readonly frames: Buffer }
	/** Not yet, and it may still come. */
	| { readonly found: false; readonly given: false }
	/** Not within `MAX_SHELL_PRELUDE_BYTES`: the stream is given up. */
	| { readonly found: false; readonly given: true };

/**
 * Where a stdio agent's frames start in what the remote sent first (#749).
 *
 * The agent runs as the command of the account's shell, and that shell may
 * print before it does: a PowerShell `DefaultShell` runs the account's profile
 * first, since sshd passes no `-NoProfile`, and cmd.exe runs its AutoRun. The
 * agent's first frame is its HELLO, so the stream is taken from the first place
 * a whole HELLO frame decodes, and what came before is the shell's, skipped,
 * up to `MAX_SHELL_PRELUDE_BYTES`. Only the start is searched: once HELLO is
 * found, every byte goes to the frame reader, as strict as it ever was.
 */
export class HelloSeeker {
	private buffer: Buffer = Buffer.alloc(0);

	/** The bytes taken so far, none of which starts a HELLO frame yet. */
	get bytes(): number {
		return this.buffer.length;
	}

	push(chunk: Buffer): HelloSeek {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const start = findHelloFrame(this.buffer);
		if (start !== -1) {
			return { found: true, prelude: start, frames: this.buffer.subarray(start) };
		}
		// Every place HELLO could start within the limit holds no whole HELLO
		// frame, and never will: whatever comes next lies past them.
		const given =
			this.buffer.length > MAX_SHELL_PRELUDE_BYTES + LENGTH_PREFIX_BYTES + MAX_HELLO_FRAME_BYTES;
		return { found: false, given };
	}
}

/**
 * Where the first whole HELLO frame in `buffer` starts, within
 * `MAX_SHELL_PRELUDE_BYTES` of its start; -1 when there is none yet. A place
 * whose length prefix runs past what arrived is skipped, not waited for: the
 * real frame is found once it has all arrived, and junk that only looks like
 * the start of a long frame holds nothing up.
 */
function findHelloFrame(buffer: Buffer): number {
	const last = Math.min(MAX_SHELL_PRELUDE_BYTES, buffer.length - LENGTH_PREFIX_BYTES - 1);
	for (let start = 0; start <= last; start++) {
		const length = buffer.readUInt32LE(start);
		if (length === 0 || length > MAX_HELLO_FRAME_BYTES) continue;
		const end = start + LENGTH_PREFIX_BYTES + length;
		if (end > buffer.length) continue;
		if (isHello(buffer.subarray(start + LENGTH_PREFIX_BYTES, end))) return start;
	}
	return -1;
}

function isHello(payload: Buffer): boolean {
	try {
		const message: unknown = decodeMessage(new Uint8Array(payload));
		return (
			typeof message === "object" &&
			message !== null &&
			(message as { type?: unknown }).type === "HELLO"
		);
	} catch {
		return false;
	}
}
