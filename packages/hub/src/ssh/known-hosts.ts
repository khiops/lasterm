/**
 * What OpenSSH already trusts on this machine.
 *
 * A host someone has been reaching from a shell for months is not a host they
 * have never seen, and asking them to verify its key from scratch teaches them
 * to click through the one prompt that must never become a reflex. Reading
 * `known_hosts` lets the app say *why* it believes a key — "your SSH
 * configuration has this exact key on line 10" — and let the person decide once
 * whether that is reason enough.
 *
 * This reads. It never writes: what OpenSSH trusts is OpenSSH's to record, and
 * a trust decision taken here is pinned in this app's own store.
 *
 * The format is the one `sshd(8)` documents:
 *
 *     [marker] host-patterns keytype base64-key [comment]
 *
 * with three details that make a naive reader silently find nothing:
 *
 *   - **Hashed names.** `HashKnownHosts yes` is the default on many
 *     distributions, and turns every name into `|1|salt|hash`, an HMAC-SHA1 of
 *     the name under that salt. A parser that only compares plain text finds
 *     no entry at all on those machines, which reads as "unknown host" rather
 *     than as a missing feature.
 *   - **Ports.** A host on anything but 22 is written `[host]:port`.
 *   - **Markers.** `@revoked` is a key whose owner has withdrawn it: a match
 *     there is the opposite of trust. `@cert-authority` delegates trust to a
 *     CA, which this cannot check, so such a line asserts nothing about the key
 *     in hand.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The files a user's own trust lives in, in the order OpenSSH reads them. */
export const USER_KNOWN_HOSTS_FILES = ["known_hosts", "known_hosts2"] as const;

/** What a `known_hosts` line says about a key. */
export interface KnownHostsMatch {
	/** `SHA256:…`, spelled as OpenSSH spells it — no padding. */
	fingerprint: string;
	/** The file the line is in, as a person would name it. */
	file: string;
	/** The line number, 1-based, as `ssh -v` reports it. */
	line: number;
	/** A key its owner has withdrawn. A match here refuses, it does not trust. */
	revoked: boolean;
}

/** One `known_hosts` file's contents, named for the message a person reads. */
export interface KnownHostsSource {
	file: string;
	contents: string;
}

/**
 * The fingerprint of a key blob, spelled as OpenSSH spells it.
 *
 * Base64 without the padding: `ssh -v` prints `SHA256:94Lb…w6nY`, and a
 * comparison against a padded `…w6nY=` fails on a key that is the same.
 */
export function fingerprintOf(keyBlob: Buffer): string {
	return `SHA256:${createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "")}`;
}

/** The same spelling, for a fingerprint that came from somewhere else. */
export function normalizeFingerprint(fingerprint: string): string {
	return fingerprint.replace(/=+$/, "");
}

/** Whether a host name matches one `known_hosts` pattern. */
function plainPatternMatches(pattern: string, name: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) {
		return pattern.toLowerCase() === name.toLowerCase();
	}
	const expression = pattern
		.split("")
		.map((character) => {
			if (character === "*") return ".*";
			if (character === "?") return ".";
			return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${expression}$`, "i").test(name);
}

/** Whether a hashed `|1|salt|hash` name is this one. */
function hashedNameMatches(pattern: string, name: string): boolean {
	const parts = pattern.split("|");
	// ["", "1", salt, hash]
	if (parts.length !== 4 || parts[1] !== "1") return false;
	const salt = Buffer.from(parts[2] ?? "", "base64");
	const expected = Buffer.from(parts[3] ?? "", "base64");
	if (salt.length === 0 || expected.length === 0) return false;
	const actual = createHmac("sha1", salt).update(name).digest();
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

/**
 * The names a host is written under: bare on port 22, bracketed otherwise.
 *
 * OpenSSH also checks the address it resolved, which this does not have and
 * does not guess: a name is what the person configured.
 */
export function knownHostsNames(host: string, port: number): string[] {
	return port === 22 ? [host] : [`[${host}]:${port}`];
}

function lineMatchesHost(patterns: string, names: string[]): boolean {
	let matched = false;
	for (const raw of patterns.split(",")) {
		const pattern = raw.trim();
		if (!pattern) continue;
		const negated = pattern.startsWith("!");
		const bare = negated ? pattern.slice(1) : pattern;
		const hit = bare.startsWith("|1|")
			? names.some((name) => hashedNameMatches(bare, name))
			: names.some((name) => plainPatternMatches(bare, name));
		// A negation that matches settles the line: it is about every host but
		// this one.
		if (hit && negated) return false;
		if (hit) matched = true;
	}
	return matched;
}

/**
 * Every key these files hold for this host.
 *
 * A host legitimately has several — one per algorithm — so this returns them
 * all and lets the caller compare the one the server actually offered.
 */
export function findKnownHostKeys(
	host: string,
	port: number,
	sources: KnownHostsSource[],
): KnownHostsMatch[] {
	const names = knownHostsNames(host, port);
	const matches: KnownHostsMatch[] = [];

	for (const source of sources) {
		const lines = source.contents.split(/\r?\n/);
		for (const [index, raw] of lines.entries()) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;

			let rest = line;
			let revoked = false;
			if (rest.startsWith("@")) {
				const [marker = "", ...tail] = rest.split(/\s+/);
				// A CA delegates trust to a signature this cannot check, so such a
				// line says nothing about the key in hand.
				if (marker === "@cert-authority") continue;
				revoked = marker === "@revoked";
				if (!revoked) continue;
				rest = tail.join(" ");
			}

			const [patterns, keyType, encodedKey] = rest.split(/\s+/);
			if (!patterns || !keyType || !encodedKey) continue;
			if (!lineMatchesHost(patterns, names)) continue;

			const keyBlob = Buffer.from(encodedKey, "base64");
			if (keyBlob.length === 0) continue;
			matches.push({
				fingerprint: fingerprintOf(keyBlob),
				file: source.file,
				line: index + 1,
				revoked,
			});
		}
	}

	return matches;
}

/** The user's own `known_hosts` files, those that exist. */
export function readUserKnownHosts(home: string = homedir()): KnownHostsSource[] {
	const sources: KnownHostsSource[] = [];
	for (const name of USER_KNOWN_HOSTS_FILES) {
		const file = join(home, ".ssh", name);
		try {
			sources.push({ file, contents: readFileSync(file, "utf8") });
		} catch {
			// A file that is not there is not an error: most machines have one.
		}
	}
	return sources;
}

/** What `known_hosts` says about the key a server just offered. */
export type KnownHostsVerdict =
	| { kind: "trusted"; file: string; line: number }
	| { kind: "revoked"; file: string; line: number }
	/** Known host, other keys — the case a warning exists for. */
	| { kind: "other-key"; file: string; line: number }
	| { kind: "unknown" };

/**
 * Whether the offered key is one this machine already knows.
 *
 * A revocation answers first: it is the one verdict that must not be overridden
 * by another line saying the same key is fine.
 */
export function judgeAgainstKnownHosts(
	offeredFingerprint: string,
	matches: KnownHostsMatch[],
): KnownHostsVerdict {
	const offered = normalizeFingerprint(offeredFingerprint);

	for (const match of matches) {
		if (match.revoked && match.fingerprint === offered) {
			return { kind: "revoked", file: match.file, line: match.line };
		}
	}
	for (const match of matches) {
		if (!match.revoked && match.fingerprint === offered) {
			return { kind: "trusted", file: match.file, line: match.line };
		}
	}
	const other = matches.find((match) => !match.revoked);
	if (other) return { kind: "other-key", file: other.file, line: other.line };
	return { kind: "unknown" };
}
