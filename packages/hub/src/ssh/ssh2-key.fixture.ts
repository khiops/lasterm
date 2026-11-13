import { utils } from "ssh2";

const ATTEMPTS = 20;

/**
 * Test-only: an ED25519 key pair from ssh2's generator that ssh2 can read back.
 *
 * About one key in 300 that ssh2 1.17.0 generates is malformed, plain or
 * encrypted: `utils.parseKey` and `ssh-keygen` both reject it (#973). Its
 * keygen.js drops the leading zero bytes of the 32-byte public key, so a key
 * whose first byte is 0 (one in 256) comes out short. A spec
 * that builds its keys at module level then fails as a whole file. So keep
 * generating until the key parses with its own passphrase; twenty malformed
 * keys in a row would be a broken ssh2, which this reports.
 */
export function generateEd25519KeyPair(options?: utils.KeyPairOptions): utils.KeyPairReturn {
	const passphrase = options && "passphrase" in options ? options.passphrase : undefined;
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const pair = utils.generateKeyPairSync("ed25519", options);
		if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
	}
	throw new Error(`ssh2 produced no parseable ED25519 key in ${ATTEMPTS} attempts`);
}
