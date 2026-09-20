import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	findKnownHostKeys,
	fingerprintOf,
	judgeAgainstKnownHosts,
	type KnownHostsSource,
	knownHostsNames,
} from "./known-hosts.js";

/** A key blob is opaque to this parser: any bytes will do, base64 in the file. */
function key(seed: string): { blob: Buffer; encoded: string; fingerprint: string } {
	const blob = Buffer.from(`ssh-ed25519-${seed}`);
	return { blob, encoded: blob.toString("base64"), fingerprint: fingerprintOf(blob) };
}

function file(contents: string): KnownHostsSource[] {
	return [{ file: "/home/someone/.ssh/known_hosts", contents }];
}

function hashedName(name: string): string {
	const salt = randomBytes(20);
	const hash = createHmac("sha1", salt).update(name).digest();
	return `|1|${salt.toString("base64")}|${hash.toString("base64")}`;
}

describe("fingerprintOf", () => {
	// `ssh -v` prints SHA256:94Lb…w6nY, and a comparison against a padded
	// …w6nY= fails on a key that is the same one.
	it("spells a fingerprint the way ssh prints it, without padding", () => {
		expect(fingerprintOf(Buffer.from("anything"))).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
		expect(fingerprintOf(Buffer.from("anything"))).not.toContain("=");
	});
});

describe("knownHostsNames", () => {
	it("writes a host on another port the way the file does", () => {
		expect(knownHostsNames("rpi", 22)).toEqual(["rpi"]);
		expect(knownHostsNames("rpi", 2222)).toEqual(["[rpi]:2222"]);
	});
});

describe("findKnownHostKeys", () => {
	it("finds the key written against a plain name", () => {
		const k = key("plain");
		const found = findKnownHostKeys("rpi", 22, file(`rpi ssh-ed25519 ${k.encoded} comment\n`));

		expect(found).toEqual([
			{
				fingerprint: k.fingerprint,
				file: "/home/someone/.ssh/known_hosts",
				line: 1,
				revoked: false,
			},
		]);
	});

	// HashKnownHosts is the default on many distributions; a parser that only
	// compares plain text finds nothing there, which reads as "unknown host".
	it("finds the key written against a hashed name", () => {
		const k = key("hashed");
		const found = findKnownHostKeys(
			"rpi",
			22,
			file(`${hashedName("rpi")} ssh-ed25519 ${k.encoded}\n`),
		);

		expect(found.map((match) => match.fingerprint)).toEqual([k.fingerprint]);
	});

	it("does not take another host's hashed line for this one", () => {
		const k = key("elsewhere");
		const found = findKnownHostKeys(
			"rpi",
			22,
			file(`${hashedName("other-host")} ssh-ed25519 ${k.encoded}\n`),
		);

		expect(found).toEqual([]);
	});

	it("matches a host on another port only under its bracketed name", () => {
		const k = key("ported");
		const contents = `[rpi]:2222 ssh-ed25519 ${k.encoded}\n`;

		expect(findKnownHostKeys("rpi", 2222, file(contents))).toHaveLength(1);
		expect(findKnownHostKeys("rpi", 22, file(contents))).toEqual([]);
	});

	it("reads the comma-separated names and the wildcards of one line", () => {
		const k = key("many");
		const contents = `alpha,beta.example.com,10.0.*.1 ssh-rsa ${k.encoded}\n`;

		expect(findKnownHostKeys("beta.example.com", 22, file(contents))).toHaveLength(1);
		expect(findKnownHostKeys("10.0.7.1", 22, file(contents))).toHaveLength(1);
		expect(findKnownHostKeys("gamma", 22, file(contents))).toEqual([]);
	});

	it("honours a negated pattern, which is about every host but that one", () => {
		const k = key("negated");
		const contents = `*.example.com,!secret.example.com ssh-rsa ${k.encoded}\n`;

		expect(findKnownHostKeys("ok.example.com", 22, file(contents))).toHaveLength(1);
		expect(findKnownHostKeys("secret.example.com", 22, file(contents))).toEqual([]);
	});

	it("keeps a revocation, and skips a CA it cannot check", () => {
		const revoked = key("revoked");
		const ca = key("ca");
		const found = findKnownHostKeys(
			"rpi",
			22,
			file(
				`@revoked rpi ssh-ed25519 ${revoked.encoded}\n@cert-authority rpi ssh-rsa ${ca.encoded}\n`,
			),
		);

		expect(found).toEqual([
			{
				fingerprint: revoked.fingerprint,
				file: "/home/someone/.ssh/known_hosts",
				line: 1,
				revoked: true,
			},
		]);
	});

	it("steps over comments, blank lines and truncated ones", () => {
		const k = key("resilient");
		const found = findKnownHostKeys(
			"rpi",
			22,
			file(`# a comment\n\nrpi ssh-ed25519\nrpi ssh-ed25519 ${k.encoded}\n`),
		);

		expect(found.map((match) => match.line)).toEqual([4]);
	});

	it("reports the line the way ssh -v does", () => {
		const other = key("other");
		const k = key("tenth");
		const contents = `${Array.from({ length: 9 }, () => `other ssh-rsa ${other.encoded}`).join("\n")}\nrpi ssh-ed25519 ${k.encoded}\n`;

		expect(findKnownHostKeys("rpi", 22, file(contents))[0]?.line).toBe(10);
	});
});

describe("judgeAgainstKnownHosts", () => {
	const trusted = key("trusted");
	const stale = key("stale");

	it("recognises the key this machine already trusts", () => {
		expect(
			judgeAgainstKnownHosts(trusted.fingerprint, [
				{ fingerprint: trusted.fingerprint, file: "f", line: 3, revoked: false },
			]),
		).toEqual({ kind: "trusted", file: "f", line: 3 });
	});

	it("compares regardless of how the fingerprint was padded", () => {
		expect(
			judgeAgainstKnownHosts(`${trusted.fingerprint}=`, [
				{ fingerprint: trusted.fingerprint, file: "f", line: 1, revoked: false },
			]).kind,
		).toBe("trusted");
	});

	// The one verdict that must not be overridden by another line calling the
	// same key fine.
	it("answers revoked first, whatever else the file says", () => {
		expect(
			judgeAgainstKnownHosts(trusted.fingerprint, [
				{ fingerprint: trusted.fingerprint, file: "f", line: 8, revoked: false },
				{ fingerprint: trusted.fingerprint, file: "f", line: 9, revoked: true },
			]),
		).toEqual({ kind: "revoked", file: "f", line: 9 });
	});

	// Known host, different key: the case the loud warning exists for.
	it("separates a host it does not know from one whose key changed", () => {
		expect(
			judgeAgainstKnownHosts(trusted.fingerprint, [
				{ fingerprint: stale.fingerprint, file: "f", line: 2, revoked: false },
			]),
		).toEqual({ kind: "other-key", file: "f", line: 2 });
		expect(judgeAgainstKnownHosts(trusted.fingerprint, [])).toEqual({ kind: "unknown" });
	});
});
