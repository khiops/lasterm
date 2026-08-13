# TLS test fixtures

These PEM files are deterministic test material kept beside the hub tests. This
directory is used instead of a repository-wide fixture folder because no such
convention exists in `packages/hub/src/`, and keeping the certificates next to
their sole consumer makes their security role explicit.

`test-ca.pem` signs both `pinned.pem` and `other.pem`; the test server presents
`other.pem` with that CA chain while the runtime record pins `pinned.pem`'s
SPKI. This makes a regression that treats a certificate chain or trust anchor
as identity pass TLS but fail the test.

All private keys here are throwaway, public test keys. They are never used by a
released hub or an operator. `expired.pem` is safe to commit for the same
reason: it exists only to prove the key-pinning transport ignores certificate
validity. Its dates are deliberately 2000-01-01 through 2001-01-01 and its
self-signature is valid.

To regenerate the valid CA and leaves, from an empty temporary directory:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out test-ca.pem \
  -subj /CN=lasterm-test-ca -days 3650
for leaf in pinned other; do
  openssl req -newkey rsa:2048 -nodes -keyout "$leaf-key.pem" -out "$leaf.csr" \
    -subj "/CN=lasterm-test-$leaf"
  openssl x509 -req -in "$leaf.csr" -CA test-ca.pem -CAkey ca-key.pem \
    -CAcreateserial -out "$leaf.pem" -days 3650
done
```

Regenerate the expired pair with a scratch Rust binary using the repository's
declared `rcgen = "0.13"` dependency:

```rust
let key = rcgen::KeyPair::generate()?;
let mut params = rcgen::CertificateParams::new(Vec::<String>::new())?;
params.not_before = rcgen::date_time_ymd(2000, 1, 1);
params.not_after = rcgen::date_time_ymd(2001, 1, 1);
let cert = params.self_signed(&key)?;
std::fs::write("expired.pem", cert.pem())?;
std::fs::write("expired-key.pem", key.serialize_pem())?;
```

No OpenSSL or Rust binary is invoked by the test suite; a fresh checkout needs
only Node and the package dependencies to run it.
