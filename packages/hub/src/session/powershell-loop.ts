import { StringDecoder } from "node:string_decoder";
import type { ClientChannel, Client as SshClient } from "ssh2";
import { SHELL_START_CEILING_MS, shellStartAllowance } from "./ssh-exec.js";
import { encodedPowerShell } from "./ssh-file-transport.js";

/**
 * What the loop prints after each script, then Base64 of what stopped it. Like
 * `WINDOWS_REPLY_MARKER`, it holds a `-`, which no answer does.
 */
export const POWERSHELL_LOOP_DONE = "lasterm-done-5e0c27";

/** How long a loop may wait for its next script before its PowerShell is let go. */
const IDLE_MS = 30_000;

/**
 * The PowerShell that runs, one after another, the scripts that arrive on its
 * stdin, one line each of Base64 of their UTF-8 text, until its stdin ends.
 * Each runs in a runspace of its own, as in a PowerShell of its own: nothing
 * one sets is seen by the next, its `exit` ends it alone, and what it writes to
 * `[Console]::Out` goes out as it would. After each, a line of
 * `POWERSHELL_LOOP_DONE` and Base64 of the error that stopped it, empty when
 * none did. A runspace costs some 25 ms, a PowerShell a second or more (#865).
 */
export const POWERSHELL_LOOP_SCRIPT = [
	"$ErrorActionPreference='Stop'",
	"$r=[IO.StreamReader]::new([Console]::OpenStandardInput())",
	[
		"while(($l=$r.ReadLine()) -ne $null){",
		"if($l -eq ''){continue};",
		"$e='';$c=$null;$s=[runspacefactory]::CreateRunspace();",
		"try{$s.Open();$c=[powershell]::Create();$c.Runspace=$s;[void]$c.AddScript([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l))).Invoke()}",
		"catch{$e=$_.Exception.GetBaseException().Message}",
		"finally{if($c){$c.Dispose()};$s.Dispose()};",
		`[Console]::Out.Write([char]10+'${POWERSHELL_LOOP_DONE} '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($e))+[char]10)`,
		"}",
	].join(""),
].join(";");

/**
 * How a script ended, as an SSH command of its own would say it: what it
 * printed, its error as stderr and exit 1 when one stopped it, and a null exit
 * when its PowerShell ended or the channel closed before it was done.
 */
export interface LoopResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/** One PowerShell on the host, and the script it is running. */
class LoopShell {
	ended = false;
	private out = "";
	private err = "";
	private exitCode: number | null = null;
	private pending: {
		resolve: (result: LoopResult) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	private readonly decoder = new StringDecoder("utf8");

	constructor(private readonly stream: ClientChannel) {
		stream.on("data", (chunk: Buffer) => {
			this.out += this.decoder.write(chunk);
			this.answer();
		});
		stream.stderr.on("data", (chunk: Buffer) => {
			this.err += chunk.toString("utf8");
		});
		stream.on("exit", (code: unknown) => {
			if (typeof code === "number") this.exitCode = code;
		});
		// What ended it is said by the close that always follows.
		stream.on("error", () => {});
		stream.on("close", () => {
			this.ended = true;
			this.settle({ stdout: this.out, stderr: this.err, exitCode: this.exitCode });
		});
	}

	ask(script: string, boundMs: number): Promise<LoopResult> {
		return new Promise((resolve, reject) => {
			if (this.ended) {
				resolve({ stdout: "", stderr: "", exitCode: null });
				return;
			}
			const timer = setTimeout(() => {
				this.pending = null;
				reject(new Error(`the host's PowerShell gave no answer in ${boundMs / 1000} s`));
			}, boundMs);
			this.pending = { resolve, reject, timer };
			this.out = "";
			this.err = "";
			this.stream.write(`${Buffer.from(script, "utf8").toString("base64")}\n`);
		});
	}

	/** Its stdin ended: the loop finishes, and its PowerShell exits. */
	end(): void {
		this.ended = true;
		try {
			this.stream.end();
		} catch {
			// The connection is gone, and the channel with it.
		}
	}

	close(): void {
		this.ended = true;
		try {
			this.stream.close();
		} catch {
			// The connection is gone, and the channel with it.
		}
	}

	/** What the script printed, once the loop's line after it is whole. */
	private answer(): void {
		const at = this.out.indexOf(POWERSHELL_LOOP_DONE);
		if (at === -1) return;
		const end = this.out.indexOf("\n", at);
		if (end === -1) return;
		const said = Buffer.from(
			this.out.slice(at + POWERSHELL_LOOP_DONE.length, end).trim(),
			"base64",
		).toString("utf8");
		const result = {
			stdout: this.out.slice(0, at),
			stderr: `${this.err}${said}`,
			exitCode: said === "" ? 0 : 1,
		};
		this.out = this.out.slice(end + 1);
		this.err = "";
		this.settle(result);
	}

	private settle(result: LoopResult): void {
		const pending = this.pending;
		if (pending === null) return;
		this.pending = null;
		clearTimeout(pending.timer);
		pending.resolve(result);
	}
}

function openShell(client: SshClient): Promise<LoopShell> {
	return new Promise((resolve, reject) => {
		try {
			client.exec(encodedPowerShell(POWERSHELL_LOOP_SCRIPT), (err, stream) => {
				if (err) reject(err);
				else resolve(new LoopShell(stream));
			});
		} catch (error) {
			reject(error);
		}
	});
}

/**
 * The scripts of one upload to a Windows host, run in turn by one PowerShell
 * on its SSH connection rather than each by a PowerShell of its own (#865):
 * starting one costs a second or more, the script itself a few milliseconds.
 * The PowerShell starts with the first script, and is let go when the owner
 * releases it or after `idleMs` without a script; the next script starts
 * another. One that gives no answer in time is closed, and the next script
 * runs in a new one. Each script reaches it as Base64 of its text, as data.
 */
export class PowerShellLoop {
	private shell: LoopShell | null = null;
	private tail: Promise<void> = Promise.resolve();
	private waiting = 0;
	private released = false;
	private idle: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly client: SshClient,
		private readonly idleMs: number = IDLE_MS,
	) {}

	/**
	 * Run `script`, after those asked before it. `timeoutMs` bounds its answer;
	 * the script that starts the PowerShell also gets the shell's start-up, as
	 * `sshExec` gives a command.
	 */
	run(script: string, timeoutMs: number): Promise<LoopResult> {
		this.waiting++;
		clearTimeout(this.idle);
		const turn = this.tail.then(() => this.send(script, timeoutMs));
		const settled = turn.then(
			() => {},
			() => {},
		);
		this.tail = settled;
		void settled.then(() => {
			this.waiting--;
			if (this.waiting === 0) this.rest();
		});
		return turn;
	}

	/** Let the PowerShell go once what was asked is answered; a later script starts another. */
	release(): void {
		this.released = true;
		if (this.waiting === 0) this.stop();
	}

	private async send(script: string, timeoutMs: number): Promise<LoopResult> {
		let shell = this.shell;
		let boundMs = timeoutMs;
		if (shell === null || shell.ended) {
			shell = await openShell(this.client);
			this.shell = shell;
			boundMs += shellStartAllowance(this.client) ?? SHELL_START_CEILING_MS;
		}
		try {
			return await shell.ask(script, boundMs);
		} catch (error) {
			// It may still be running that script: the next one gets a new PowerShell.
			shell.close();
			if (this.shell === shell) this.shell = null;
			throw error;
		}
	}

	private rest(): void {
		if (this.released) {
			this.stop();
			return;
		}
		this.idle = setTimeout(() => this.stop(), this.idleMs);
		this.idle.unref();
	}

	private stop(): void {
		clearTimeout(this.idle);
		this.shell?.end();
		this.shell = null;
	}
}
