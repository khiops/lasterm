import { describe, expect, it } from "vitest";
import { listenFromPort, resolveStartPort } from "./start-port.js";

describe("resolveStartPort", () => {
	it("prefers the flag over the environment", () => {
		expect(resolveStartPort(4300, "4200")).toBe(4300);
	});

	it("uses LASTERM_PORT when no flag is given", () => {
		// Mutation caught: `lasterm start` read only the flag and bound elsewhere (#175).
		expect(resolveStartPort(undefined, "4200")).toBe(4200);
	});

	it("leaves the choice to the operating system when neither is set", () => {
		expect(resolveStartPort(undefined, undefined)).toBeUndefined();
		expect(resolveStartPort(undefined, "")).toBeUndefined();
	});

	it("refuses a port that is not an integer in range, naming where it came from", () => {
		expect(() => resolveStartPort(undefined, "http")).toThrow("Invalid LASTERM_PORT: http");
		expect(() => resolveStartPort(undefined, "70000")).toThrow("Invalid LASTERM_PORT: 70000");
		expect(() => resolveStartPort(Number.NaN, undefined)).toThrow("Invalid --port: NaN");
		expect(() => resolveStartPort(0, "4200")).toThrow("Invalid --port: 0");
	});
});

/** An error as `listen` gives it, with its errno code. */
function listenError(code: string, port: number): NodeJS.ErrnoException {
	return Object.assign(new Error(`listen ${code}: 127.0.0.1:${port}`), { code });
}

/**
 * A `listen` that answers each port from `answers`: an errno code fails it,
 * anything else lets it listen. A port it has no answer for listens. It records
 * every port it was asked for.
 */
function fakeListen(answers: Record<number, string>) {
	const asked: number[] = [];
	const listen = async (port: number): Promise<string> => {
		asked.push(port);
		const code = answers[port];
		if (code !== undefined) throw listenError(code, port);
		return `https://127.0.0.1:${port}`;
	};
	return { asked, listen };
}

/** Every port from `first` to `last`, answering `code`. */
function range(first: number, last: number, code: string): Record<number, string> {
	const answers: Record<number, string> = {};
	for (let port = first; port <= last; port++) answers[port] = code;
	return answers;
}

describe("listenFromPort", () => {
	it("listens on the port asked for when it is free", async () => {
		const { asked, listen } = fakeListen({});
		await expect(listenFromPort(4100, listen, "win32")).resolves.toEqual({
			address: "https://127.0.0.1:4100",
			port: 4100,
		});
		expect(asked).toEqual([4100]);
	});

	it("moves past a taken port, as it always has", async () => {
		const { asked, listen } = fakeListen(range(4100, 4101, "EADDRINUSE"));
		await expect(listenFromPort(4100, listen, "linux")).resolves.toMatchObject({ port: 4102 });
		expect(asked).toEqual([4100, 4101, 4102]);
	});

	// #573: Windows answers EACCES for the ranges Hyper-V, WSL and Docker
	// reserve. Mutation caught: only EADDRINUSE moved up, and the hub failed to start.
	it("moves past a port Windows refuses, as past a taken one", async () => {
		const { asked, listen } = fakeListen({ 64289: "EACCES", 64290: "EADDRINUSE" });
		await expect(listenFromPort(64289, listen, "win32")).resolves.toMatchObject({
			port: 64291,
		});
		expect(asked).toEqual([64289, 64290, 64291]);
	});

	it("moves past a refused port from 1024 on POSIX, where a policy reserves it", async () => {
		const { listen } = fakeListen({ 4100: "EACCES" });
		await expect(listenFromPort(4100, listen, "linux")).resolves.toMatchObject({ port: 4101 });
	});

	it("does not move a privileged port on POSIX, and says why", async () => {
		// Walking up from 1000 could only end at 1024 or above: another port than
		// the one asked for, chosen without a word.
		const { asked, listen } = fakeListen(range(1, 1023, "EACCES"));
		const start = listenFromPort(1000, listen, "linux");
		await expect(start).rejects.toThrow(
			"Port 1000 is privileged and this process may not bind it (EACCES)",
		);
		await expect(start).rejects.toMatchObject({ cause: { code: "EACCES" } });
		expect(asked).toEqual([1000]);
	});

	it("moves past a refused port below 1024 on Windows, where none is privileged", async () => {
		const { listen } = fakeListen({ 80: "EACCES" });
		await expect(listenFromPort(80, listen, "win32")).resolves.toMatchObject({ port: 81 });
	});

	it("names the window, what refused it and where to look when every port is refused", async () => {
		const { asked, listen } = fakeListen({
			...range(49722, 49821, "EACCES"),
			49722: "EADDRINUSE",
		});
		const start = listenFromPort(49722, listen, "win32");
		await expect(start).rejects.toThrow(
			"No port free from 49722 to 49821 (1 in use, 99 refused by the system). " +
				"Windows refuses the port ranges it reserves; " +
				"`netsh interface ipv4 show excludedportrange protocol=tcp` lists them. " +
				"Ask for another port, or for none and let the system choose one.",
		);
		await expect(start).rejects.toMatchObject({ cause: { code: "EACCES" } });
		expect(asked).toHaveLength(100);
	});

	it("names the window when every port is taken", async () => {
		const { listen } = fakeListen(range(4100, 4199, "EADDRINUSE"));
		await expect(listenFromPort(4100, listen, "linux")).rejects.toThrow(
			"No port free from 4100 to 4199 (100 in use). Ask for another port",
		);
	});

	it("never asks past 65535", async () => {
		const { asked, listen } = fakeListen(range(65530, 65535, "EADDRINUSE"));
		await expect(listenFromPort(65530, listen, "win32")).rejects.toThrow(
			"No port free from 65530 to 65535 (6 in use)",
		);
		expect(asked.at(-1)).toBe(65535);
	});

	it("ends the start on any other error, as it came", async () => {
		const { asked, listen } = fakeListen({ 4100: "EADDRNOTAVAIL" });
		await expect(listenFromPort(4100, listen, "win32")).rejects.toMatchObject({
			code: "EADDRNOTAVAIL",
		});
		expect(asked).toEqual([4100]);
	});
});
