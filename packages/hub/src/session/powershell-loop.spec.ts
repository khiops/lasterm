import { EventEmitter } from "node:events";
import type { Client as SshClient } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { windowsScript } from "../files/exec-files.js";
import { type MockSshHost, startMockSshHost } from "../files/ssh-host.fixture.js";
import { POWERSHELL_LOOP_DONE, POWERSHELL_LOOP_SCRIPT, PowerShellLoop } from "./powershell-loop.js";
import { windowsReply } from "./ssh-file-transport.js";

/** An exec channel the test answers for the loop's PowerShell. */
class FakeChannel extends EventEmitter {
	readonly stderr = new EventEmitter();
	/** The scripts written to it, decoded. */
	readonly scripts: string[] = [];
	ended = false;
	closed = false;

	write(line: string): boolean {
		expect(line).toMatch(/^[A-Za-z0-9+/]*={0,2}\n$/);
		this.scripts.push(Buffer.from(line, "base64").toString("utf8"));
		return true;
	}

	end(): void {
		this.ended = true;
	}

	close(): void {
		this.closed = true;
		this.emit("close");
	}

	/** What the loop prints for a script: its output, then the line after it. */
	answer(stdout: string, error = ""): void {
		const said = Buffer.from(error, "utf8").toString("base64");
		this.emit("data", Buffer.from(`${stdout}\n${POWERSHELL_LOOP_DONE} ${said}\r\n`, "utf8"));
	}
}

function fakeHost(): { client: SshClient; channels: FakeChannel[]; commands: string[] } {
	const channels: FakeChannel[] = [];
	const commands: string[] = [];
	const client = {
		exec: (command: string, cb: (err: Error | undefined, stream: FakeChannel) => void) => {
			commands.push(command);
			const channel = new FakeChannel();
			channels.push(channel);
			cb(undefined, channel);
		},
	} as unknown as SshClient;
	return { client, channels, commands };
}

/** Until the loop has written `count` scripts to `channel`. */
async function written(
	channel: () => FakeChannel | undefined,
	count: number,
): Promise<FakeChannel> {
	await vi.waitFor(() => expect(channel()?.scripts.length).toBe(count), { interval: 5 });
	return channel() as FakeChannel;
}

describe("a PowerShell loop, as the hub drives it", () => {
	it("starts one PowerShell, and sends it each script in turn as a Base64 line", async () => {
		const host = fakeHost();
		const loop = new PowerShellLoop(host.client);
		const first = loop.run("script one", 1000);
		const second = loop.run("script two ü", 1000);
		const channel = await written(() => host.channels[0], 1);
		expect(host.commands).toEqual([
			`powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(POWERSHELL_LOOP_SCRIPT, "utf16le").toString("base64")}`,
		]);
		// The second waits for the first's answer.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(channel.scripts).toEqual(["script one"]);
		// What it prints comes in pieces, after what the shell printed first.
		channel.emit("data", Buffer.from("profile noise\nlasterm-reply-4d9b1f\nOK\n"));
		channel.answer("1");
		expect(await first).toEqual({
			stdout: "profile noise\nlasterm-reply-4d9b1f\nOK\n1\n",
			stderr: "",
			exitCode: 0,
		});
		await written(() => channel, 2);
		expect(channel.scripts[1]).toBe("script two ü");
		channel.answer("lasterm-reply-4d9b1f\nOK");
		expect(windowsReply((await second).stdout)).toBe("OK");
		expect(host.channels).toHaveLength(1);
	});

	it("says the error that stopped a script as its stderr, with exit 1, and goes on", async () => {
		const host = fakeHost();
		const loop = new PowerShellLoop(host.client);
		const failed = loop.run("throws", 1000);
		const channel = await written(() => host.channels[0], 1);
		channel.answer("", "Le fichier « C:\\x » est introuvable.");
		expect(await failed).toEqual({
			stdout: "\n",
			stderr: "Le fichier « C:\\x » est introuvable.",
			exitCode: 1,
		});
		const next = loop.run("next", 1000);
		await written(() => channel, 2);
		channel.answer("lasterm-reply-4d9b1f\nOK");
		expect((await next).exitCode).toBe(0);
	});

	it("closes a PowerShell that gives no answer in time, and starts another for the next script", async () => {
		const host = fakeHost();
		const loop = new PowerShellLoop(host.client);
		const first = loop.run("quick", 1000);
		const stuck = await written(() => host.channels[0], 1);
		stuck.answer("ok");
		await first;
		await expect(loop.run("hangs", 30)).rejects.toThrow(/no answer in 0.03 s/);
		expect(stuck.closed).toBe(true);
		const next = loop.run("after", 1000);
		const fresh = await written(() => host.channels[1], 1);
		fresh.answer("ok");
		expect((await next).exitCode).toBe(0);
	});

	it("answers a script whose channel closed with no exit code, and the next starts another", async () => {
		const host = fakeHost();
		const loop = new PowerShellLoop(host.client);
		const cut = loop.run("cut", 1000);
		const channel = await written(() => host.channels[0], 1);
		channel.emit("data", Buffer.from("half"));
		channel.emit("close");
		expect(await cut).toEqual({ stdout: "half", stderr: "", exitCode: null });
		const next = loop.run("next", 1000);
		(await written(() => host.channels[1], 1)).answer("ok");
		expect((await next).exitCode).toBe(0);
	});

	it("lets its PowerShell go once released and answered, or after a while without a script", async () => {
		const host = fakeHost();
		const loop = new PowerShellLoop(host.client, 60_000);
		const pending = loop.run("one", 1000);
		const channel = await written(() => host.channels[0], 1);
		loop.release();
		expect(channel.ended).toBe(false);
		channel.answer("ok");
		await pending;
		await vi.waitFor(() => expect(channel.ended).toBe(true), { interval: 5 });
		// Asked again after: another, let go as soon as it is idle.
		const later = loop.run("two", 1000);
		const again = await written(() => host.channels[1], 1);
		again.answer("ok");
		await later;
		await vi.waitFor(() => expect(again.ended).toBe(true), { interval: 5 });

		const idle = new PowerShellLoop(host.client, 30);
		const quick = idle.run("three", 1000);
		const resting = await written(() => host.channels[2], 1);
		resting.answer("ok");
		await quick;
		expect(resting.ended).toBe(false);
		await vi.waitFor(() => expect(resting.ended).toBe(true), { interval: 5 });
	});
});

/** Whether a process of this machine is running; never a signal to a group. */
function running(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// The loop itself, in Windows PowerShell under cmd.exe, as Win32-OpenSSH runs it.
describe.runIf(process.platform === "win32")("a PowerShell loop on a Windows host", () => {
	let host: MockSshHost | null = null;
	afterEach(async () => {
		await host?.close();
		host = null;
	});

	it("runs each script as in a PowerShell of its own, in one PowerShell that ends when let go", async () => {
		host = await startMockSshHost({ sftp: false, shell: "cmd" });
		const loop = new PowerShellLoop(host.client);
		const [first, second, third, fourth] = await Promise.all([
			loop.run(windowsScript(null, "$x='kept'", "Ans ('OK'+[char]10+$PID)"), 10_000),
			// What the first set is not seen; what a statement yields is not printed.
			loop.run(
				windowsScript(null, "[IO.Directory]::GetCurrentDirectory()", "Ans ('OK'+[char]10+$x+'.')"),
				10_000,
			),
			// What stopped a script is said.
			loop.run(windowsScript(null, "[IO.File]::Move('C:\\nope-865\\a','C:\\nope-865\\b')"), 10_000),
			// `exit` ends the script alone.
			loop.run(windowsScript(null, "Ans 'OK'", "[Console]::Out.Write('not reached')"), 10_000),
		]);
		const pid = Number(windowsReply(first.stdout)?.split(/\r?\n/)[1]);
		expect(running(pid)).toBe(true);
		expect(first.exitCode).toBe(0);
		expect(windowsReply(second.stdout)?.split(/\r?\n/)).toEqual(["OK", "."]);
		expect(third).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/nope-865/) });
		expect(windowsReply(third.stdout)).toBeNull();
		expect(fourth.stdout).not.toContain("not reached");
		expect(windowsReply(fourth.stdout)).toBe("OK");
		expect(host.server.execCommands).toHaveLength(1);

		loop.release();
		await vi.waitFor(() => expect(running(pid)).toBe(false), { timeout: 10_000, interval: 50 });
	});
});
