import { createHash } from "node:crypto";

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
