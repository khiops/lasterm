# TLS carries the hub's identity

```yaml
doc-meta:
  story_id: issue-183-tls-identity
  issues: [183, 193, 170]
  status: draft
  adversarial_applied: true
  llm_spec_reviewed: true
  production_audit_applied: true
```

## §1 Scope

A client must be able to verify **which hub** it is talking to before it sends a credential
to it. Today it cannot: the desktop hands its bearer token to whatever answers on the port,
and the same is true of the `X-Lasterm-Owner` header that authorises stopping the hub.

What changes:

- The hub serves **HTTPS on its only listener**, loopback included.
- The certificate is **supplied by the operator** when configured, otherwise **generated** as
  a self-signed leaf, and its SPKI is published in `runtime.json`.
- The desktop's **Rust shell** becomes the HTTP and WebSocket client, pins that SPKI, and
  relays the terminal stream to the webview over Tauri IPC.
- The bearer token's **format and verification are unchanged**. Its **lifetime** changes for browser
  pairings: no token issued through browser pairing outlives the hub run that issued it, because a
  browser cannot verify which hub it is talking to and the hub cannot establish that it did (P8).
  The primary `auth.json` token the desktop uses stays durable, because the desktop pins.

What does not change: no new cryptography, no user login, no second listener, no protocol
above TLS.

**One thing this does add, and an earlier draft wrongly denied it.** That draft said "no new
provisioning". P5 requires the desktop to hold a pin across restarts, so there is new durable
state: where the pin lives, how it is first established, and what the re-pair flow shows the
user. Calling that "no new provisioning" made a real design surface invisible — the pin store
is small, but it is state with a trust decision attached, and it needs specifying rather than
assuming.

**Out of scope.** The configurable bind address and everything that must accompany exposing a
non-loopback interface — rate limits, security headers, WebSocket DoS caps, CORS, the
input-validation review — stay in **#96**. This work makes the loopback listener
authenticated so #96 opens a door that is already authenticated, rather than adding TLS to an
open one. #193 is thereby unblocked, not delivered.

## §2 Reality constraints and scope pivots

Three constraints shaped this design, and two of them killed an earlier one.

### 2.0 Who this defends against, and who it does not

**Three actors, and the third is the one this document kept omitting.** `127.0.0.1` is the default when
the desktop launches the hub locally; it is not the architecture. The hub must be able to listen on any
interface so a client — desktop or browser — can reach it, which is why pairing exists at all (#96 owns the
configurable bind address, #193 the network half of identity). So the binding must never be cited as a
security property, and a threat model that lists only local actors is incomplete.

| Attacker | Already has | This design |
|---|---|---|
| a **different OS user** on the machine | cannot read `auth.json` (0600) or `runtime.json` | **closes** the theft: they can bind a free port but cannot produce the pinned key |
| a process of the **same user** | can read `auth.json` directly, so it already holds the primary token | **changes nothing.** Marginal privilege is zero |
| a **network attacker**, once the hub binds a non-loopback interface | sees every byte on the wire and can answer in the hub's place | **this is why TLS is a precondition rather than an improvement.** A page served over plain HTTP from a non-loopback address is not a secure context, so `crypto.subtle` is unavailable and no application-layer scheme can even execute |

State this before anything else, because a reader who takes "local attacker" as one class will judge the
design against a threat it cannot address and cannot be made to address: a token file readable by its owner
is readable by that owner's processes. The port-squatting attack is interesting precisely because it needs
neither of those files.

**And a consequence for every severity argument in this document.** Reasoning that treats the current
loopback binding as a limit on an attacker's reach is invalid, because that binding is a default rather than
a property. It was used exactly that way while triaging #203 — "exfiltrating the token buys a remote
attacker nothing, since the hub is local" — and the conclusion drawn from it does not survive the correction:
with a network-facing hub, a stolen bearer token is remotely usable, so an unenforced webview boundary is
worse than that triage concluded, not better.

### 2.1 The application cannot authenticate the server

An earlier specification (1126 lines, abandoned deliberately, kept out of the repository)
built a per-request mutual proof-of-possession scheme at the application layer: keys derived
from `runtime.json`, MACs over request transcripts, the hub counter-proving on the response.
It survived six review passes and then failed on one sentence:

> A client delivered by the server cannot authenticate the server at the application layer.
> The verifier was handed to it by the thing it would verify.

The browser receives its JavaScript from the hub. An imposter on the port serves its own
JavaScript, which then performs whatever proof the imposter likes. Only a mechanism acting
**before** the application is delivered can decide who the server is, and that is the
transport.

So: **the transport authenticates the server, and the application only authorises the
client.** Everything the abandoned design contained — HKDF, MACs, transcripts, freshness
windows, seen-sets, `/api/identity`, the `Lasterm-Stop` header, the asset capability, the
conversion of 25 call sites — disappears.

### 2.2 The webview cannot be a TLS client to a self-signed hub

Measured on this host, not assumed. Under WebKitGTK (the engine `wry` uses on Linux),
navigation to a self-signed loopback certificate fails with `LOAD_FAILED_TLS`, and `wss://`
from a trusted origin is refused while the identical code path over plain `ws://` connects.
Tauri exposes no hook to change this: zero occurrences of `ServerCertificate`,
`ClientCertificate`, `allow_tls_certificate` or `tls_error` in the pinned `tauri 2.11.1` and
`wry 0.55.1` sources; upstream `tauri#12331`, `wry#1171`, `tauri#4039`, `tauri#5535` are the
open requests.

This is why the desktop's Rust side becomes the client. It is not an optimisation.

### 2.3 The IPC boundary can carry a terminal

Also measured. Keystroke round trip through Tauri IPC, WebKitGTK headless under Xvfb: p50
0.224 ms, p95 0.412 ms, p99 0.537 ms, against a 5 ms budget. Output direction: 48 MiB/s at
512 B frames, 130 at 4 KiB, 193 at 64 KiB, 318 at 256 KiB, base64 decode included. Every
batch was verified complete by reading the page's own byte counter — the first run of that
bench reported three refusals from a server that had crashed on a missing module, and only
the plain-HTTP control revealed it.

## §2.4 What this branch delivers, and what it does not

Written after the cumulative gate refused the branch for claiming more than the code does. Six properties
had reached no dispatched brief: a slice table assigned every one, then the cuts moved — a split, a merge,
and a slice assumed done by a spike — and the obligations did not travel.
`~/.claude/scripts/spec-coverage.sh` now maps each property against the prompts actually dispatched, and the
gate carries the same list into its prompt.

| Property | State |
|---|---|
| P1 no plaintext credential endpoint | delivered |
| P2 certificate and key inseparable | delivered |
| P3 generated leaf, never a CA | delivered |
| P3b the published identity is never ahead of the running one | delivered |
| P3c the first pin comes from an anchor | **delivered, with a narrower filesystem guarantee than this section originally claimed.** The hub's announcement carries its SPKI on the child's pipe, and a pin is now written only after a credential-free TLS handshake proves the hub holds the announced key — so a corrupt record can no longer pin anything. The record's own protection is checked at its immediate parent, and its ancestors are checked for symlinks only: ownership and write permission on higher ancestors are **not** verified, and each check is by pathname rather than by the descriptor later opened. **#202** |
| P3c-visibility | **deferred, #201.** A mismatch shows a startup failure naming `--reset-hub-pin`; there is no first-pin window, no once/always/no prompt, and no hub-side fingerprint command |
| P4 the pin survives a re-issue over the same key | delivered |
| P5 a mismatch is terminal | delivered |
| P6 accepted solely on the pin | **delivered, and now the same on both clients.** Every client — the desktop's Rust shell, the CLI, the development proxy, the spawn probe — accepts when the peer proves possession of the pinned key, and refuses otherwise. Chain, expiry, hostname and trust roots take no part. Until #206 the Node clients applied the pin *after* Node's own certificate validation, so an expired certificate over the pinned key refused there and connected on the desktop |
| P7 no hub traffic originates in the webview | delivered and enforced in the packaged build. The webview's only connection sources are Tauri's IPC, it cannot navigate off the application origin or open a window, and an end-to-end suite drives the packaged application and observes eight renderer routes reach a sentinel server not at all — the same suite turns red and records six arrivals when the policy is removed. A development build served from an external Vite server is outside that guarantee. Assets cross the relay as blob URLs; their caching and revocation lifecycle stays in **#194** |
| P8 no browser pairing outlives the hub run | delivered |
| P8-authority | delivered |
| P9 the relay cannot buffer without bound | **delivered in both directions, with one honest limit.** Responses stream under a single outstanding credit per relay; requests, multipart included, cross in 256 KiB pieces, and no body crosses as an expanded numeric array — refused at the native contract rather than only in the page. Eight relays may be in flight, four of them uploads, and a request past that is refused rather than queued. Every wait ends, the caller's included: a response settles on its own inactivity timer, so it does not depend on the producer being able to send a terminal frame, and an upload that is abandoned fails its request instead of finishing it empty. **The limit:** what this bounds is the relay's own buffering. A producer handing the stream one enormous chunk keeps that chunk alive while it is transmitted, because Web Streams give a consumer no way to bound a producer's chunk size |
| P10 the operator can replace the key | **deferred, #199.** Nothing can replace the key today, and nothing warns of expiry |
| P11 permission checks where files are opened | **partly delivered.** `runtime.json` is checked because its contents decide who the client trusts. `auth.json`, the certificate, the key's re-read, and the whole Windows story are **deferred, #200** |
| P12 the default port is not guessable | delivered |

**The one thing a reader should carry from this table:** the transport authenticates the hub and the desktop
detects a substitution, which is what the work existed for. The defences *around* that — rotating a leaked
key, refusing a group-readable token file, showing the user a fingerprint — are named, tracked, and not here.

## §3 Properties

Each property is stated as what must hold. The mechanism that achieves it is a suggestion in
the notes; a different mechanism holding the same property is acceptable.

### P1 — No network endpoint accepts a credential in plaintext

The hub exposes no endpoint, on any interface including loopback, that can receive a bearer
token or the owner header over an unencrypted connection, and no configuration can produce
one.

*Why not a plaintext loopback door for browsers:* a second door is a door. Any local process
that finds it gets the unauthenticated behaviour this work exists to remove.

*Note (mechanism, not the property):* one `.listen()` serving TLS satisfies this. TLS is
declared where the Fastify instance is constructed (`packages/hub/src/server.ts:128`), not at
`startServer` (`server.ts:582`). The zero-conf port scan (`server.ts:576-590`) is unaffected.
An earlier draft stated "there is exactly one `.listen()`" as the property; that is a count of
call sites, which a second credential-accepting endpoint can satisfy while violating what
matters.

### P2 — A certificate without its key cannot be expressed

Operator-supplied certificate and key are a single unit in configuration. A configuration
naming one without the other must fail to load, with a message naming what is missing.

*Note:* `ServerOptions` already carries this shape — it pairs `ownerToken` with `onQuit` and
`onQuitDelivered` in a union whose other arm forbids all three (`server.ts` `ServerOptions`).
Mirror it. A validation function that a caller may forget is the shape this repository has
been bitten by; the union makes the omission fail to compile.

### P3 — Absent an operator certificate, the hub generates a leaf, never a CA

The generated certificate is a self-signed **leaf** valid for the names the hub answers on. Its
private key stays confidential and non-replaceable to the extent P11 can establish, and a hub that
cannot establish it refuses to start rather than generating into a location it cannot defend.

*What is actually built:* the key **and** the leaf over it are generated once and kept, in
`hub-tls-key.pem` and `hub-tls-generated-cert.pem`. A restart serves the same bytes. A new leaf is
signed only when the stored one cannot serve, **decided when the hub starts and not again while it
runs** (#199) — absent, unreadable, for another key, expired or within
seven days of it, dated in the future after a clock moved backwards, or failing the profile a
generated leaf must have: one self-signed certificate for this key, not a CA, carrying the loopback
address and a TLS server's usages. That profile is judged rather than the bytes, so a later version
does not reissue everywhere because a serial differs. The cache is separate from `hub-tls-cert.pem`,
which is a copy of whatever certificate is in effect and may be an operator's.

*What the substitution actually buys an attacker, since an earlier draft got this wrong.* That draft
said a substituted key means "the pin the client holds then matches the attacker". It does not: a
different key has a different SPKI, so an existing pin **mismatches** and P5 refuses. The danger is
narrower and earlier — a key substituted **before the first pin** is the key the client pins, which
is P3c's concern. So the reason to protect the key's directory is to protect the first-pin anchor,
not to protect a pin that already exists.

*How far "non-replaceable" reaches, stated rather than implied.* P11 defines the enforcement, and it
differs by platform: on Unix, ownership, mode and the containing directory are checked; on Windows,
only redirection is checked and the directory's ACL is not. So on Windows this property holds **by
the platform's default ACL** rather than by verification, and a hand-modified ACL granting another
standard user write access to `%LOCALAPPDATA%` is undetected. That residual is named in P11 with the
reason it is accepted. An absolute claim here would have been the more comfortable sentence and the
false one.

*Why leaf and not CA:* a certificate a user may add to an OS trust store must authorise only
itself. `mkcert`'s own README states that its root key "gives complete power to intercept
secure requests from your machine" — that warning is about a CA. A leaf trusted for one
loopback name authorises that certificate for that name and nothing else.

**Generated by Rust, in a native addon the hub loads.** The hub is TypeScript and Node has no X.509
*issuance* API — `crypto.X509Certificate` parses, `Certificate` is legacy SPKAC — so generation needs
either a JavaScript library or a native one. It goes to Rust, using `rcgen`, for one reason that
outweighs the others: the desktop verifies with `rustls-webpki`, and a generator from the same project
means the SPKI bytes on both ends come from one ASN.1 lineage. With a JavaScript generator, the two ends
agreeing is an assumption that has to be tested rather than a property of the choice.

Supporting, not decisive: `rcgen`, `yasna` and `pem` conform to the existing `cargo-deny` allowlist with
no exception, and the hub already loads a Rust addon (`lasterm_hub_lock.node` via `hub-lock.ts:13`, with
`sea-addon-loader.ts` shipping `.node` assets inside the single executable), so the shape is proven
rather than new. Shelling out to `openssl` was rejected: it reintroduces an external binary requirement
on the platform least likely to have one, in a product whose whole packaging premise is that it needs no
external runtime. A power user who prefers `openssl` is already served — P2 lets them supply the
certificate, so that path needs no code.

*Cost to accept:* a **new** crate rather than an addition to `lasterm-hub-lock`, because a crate named
for locking that also mints certificates is what a later reader trips over. That means one more
per-platform addon build in CI and one more entry in `SEA_ADDON_ASSETS`
(`sea-addon-loader.ts:33`, today a one-element list).

*The concrete encoding mistake to avoid, since a first implementation reliably makes it:* the SAN must
carry an **`iPAddress`** entry holding the four network-order bytes of `127.0.0.1`, not a `dNSName`, and
not a `CN=127.0.0.1` that modern clients ignore (RFC 5280 §4.2.1.6). Add `::1` only if the hub will bind
IPv6. Encode `basicConstraints` critical with `CA=false`, plus leaf `keyUsage` and the `serverAuth` EKU.

**SETTLED — nothing rotates the key except the operator, and the pinned client ignores expiry.** An
earlier revision said "generated once and kept", full stop. That is wrong, and the operator caught
it: a key with no replacement path is a key that stays valid after it leaks, which the same revision
had already written down as an accepted consequence without providing the operation that would end
it. See P10 for rotation.

Leaving expiry open was separately a contradiction with P6: "decided by the pin and by nothing else"
already requires accepting an expired certificate whose SPKI matches, so the two sentences could not
both stand.

The verification predicate for a pinned client is therefore exactly: **the presented certificate's
SPKI equals the pinned SPKI.** Not the expiry, not the name, not a chain.

Why that is the right predicate rather than a shortcut: expiry bounds the damage of a compromised
key in a PKI where revocation is slow and the verifier trusts an issuer. A pinning client trusts
the key itself, so an expired certificate over the pinned key is exactly as trustworthy today as it
was yesterday, and enforcing expiry converts a wrong clock into an outage while buying nothing. It
also removes the renewal path entirely: the key is created once, kept, and never regenerated, so no
restart invalidates a pin.

The consequence, and it is why P10 exists: nothing in the system ends a leaked key's validity. Only
an operator action can.

**Validity: 825 days. Near-expiry warning: 30 days before.** Both are decided here rather than left
open, because P10's reminder is untestable without them.

825 is the largest value with no known platform refusing it: Safari and macOS have historically
rejected certificates valid for more than 825 days, and that limit applies to self-signed leaves too.
A certificate a browser refuses outright is worse than one it warns about, so the ceiling is the
number to take. The pinned desktop client ignores validity entirely (the predicate is SPKI equality),
so this figure affects only what a browser displays.

Revisit it on evidence that a target platform refuses 825, not on preference.

### P3b — The published identity is never ahead of the running one

A client that reads the hub's record and connects either **successfully authenticates a server
presenting the published SPKI, or sends no credential**.

*Why the property is about what is sent, and not about what is reached:* two earlier drafts got this
wrong in two different ways, and both were about the verb.

"Reaches the hub that wrote it" is false under this design's own lifecycle. P4 keeps the key across
re-issues and P3 keeps it across restarts, so hub A can publish `(port P, SPKI K)`, die, and hub B
can start on P with K. A reader then reaches B, which is neither A nor nothing, and that is the
correct outcome. The property is about the **key**, because the key is what the client can check.
Nothing here identifies a hub *run*, and nothing needs to: P8's mechanism does not consult run
identity (see P8-authority).

"Reaches a server presenting the published SPKI, or nothing" is also false, more subtly. When a
squatter holds the port, the client necessarily **reaches** a TLS peer presenting a different SPKI —
that is how it learns to refuse. What must hold is that the handshake does not complete and no
credential leaves the client. A property that talks about what is reached forbids the very step that
detects the attack.

Two consequences, both testable by injecting a crash:

- **Ordering.** The record naming the port and the SPKI becomes readable only once the TLS
  server holding that key is bound and serving. A reader therefore cannot obtain an endpoint
  before the identity that answers on it exists. Publication is atomic, so no reader ever sees
  a record carrying a port without its SPKI, or a new port beside an old SPKI.

  *Half of this already exists.* `persistRuntime()` (`packages/hub/src/cli.ts:105-123`) writes the
  record through `openSync(tempPath, "wx", 0o600)`, an explicit `fchmodSync(fd, 0o600)` against the
  umask, and an atomic rename. So atomic publication and the 0600 mode are not new work — the
  `RuntimeInfo` shape (`cli.ts:77-84`) already carries `pid`, `port`, `started_at` and optional
  `instanceId` and `ownerToken`. What this property adds is the **SPKI field** and the **ordering
  guarantee**: today nothing binds the write to the listener being up.
- **After a crash.** A record left by a dead hub names a port any local process may bind. A
  client that reaches such a squatter must fail on the pin **before sending any credential** —
  not fail after, not warn, and not fall back. A stale, truncated or unreadable record fails
  closed: it authorises no connection at all.

*Why this is its own property:* P1 and P5 hold individually while the gap between them stays
open. The window is the interval between a port existing and its identity being knowable, and
no property about a single endpoint or a single mismatch closes it.

### P3c — The first pin comes from an anchor where one exists, and remote has none

P3b protects **continuity** — a client that already holds a pin detects a substitution. It says
nothing about where the first pin came from, and an attacker who wins the *initial* race publishes
its own SPKI, serves the matching certificate, and is pinned. Atomic publication makes a forged
record internally consistent, not trustworthy.

Where an anchor exists, the first pin comes from it and never from a channel a third party can write.
Where none exists, that is stated rather than papered over. Three cases:

- **A hub this client launched.** The SPKI arrives from the child process itself, over the pipe the
  parent created — the same channel that already carries the announced port. A process the client
  did not spawn cannot write another process's stdout, so no race exists to win.
- **A hub this client is attaching to** (the case #183 exists for). The anchor is that
  `runtime.json` is 0600 in the user's state directory, so a **different** OS user can neither read
  nor write it, and a same-user attacker is out of scope by §2.0. This makes P3's
  directory-integrity requirement apply to the **record** as well as the key: if any directory on
  the path to `runtime.json` is writable by another party, the record authorises no pin.

- **A hub on another machine** (#193's case). **There is no anchor, and this is a stated exception to
  the sentence above rather than a case it covers.** No channel reaches a remote hub that a network
  attacker cannot also reach, so the peer that answers is the one that supplies the pin. This is
  trust-on-first-use, it is what `ssh` does, and it is the accepted position for that deployment.

  The exception is bounded by exactly one thing: a fingerprint the user can obtain **out of band**,
  from the hub's own host, and compare. That is why the hub-side fingerprint command is not a
  convenience — it is the only mitigation this case has, and without it the remote prompt is
  unmitigated TOFU.

**And the display is not the check.** Showing the user two SPKIs to compare is consent, not
verification — neither string has provenance the user can evaluate. What makes a *local* first pin
safe is the anchor, never the comparison. What makes a *remote* one better than nothing is the
comparison, which is why the two cases get different treatment in P3c-visibility.

#### P3c-visibility — the first pin is visible locally and confirmed remotely

> **Not delivered, and not a binding property of what has shipped.** This section and its regression
> rows describe **#201**. What exists is narrower: a first pin is recorded without asking, after a
> live hub has proved it holds the announced key, and a mismatch is a terminal startup failure naming
> `--reset-hub-pin`. No fingerprint is shown, no once/always/no prompt exists, no re-pair interface
> exists, and a matching pin logs nothing. The remote half additionally waits on a non-loopback
> bind (#96).

**What decides whether the user is asked: is this identity already pinned.** Not the address, not the
launch. The model is `ssh`'s host-key prompt, and the property that makes that prompt work is that it
is **rare** — it fires on a first contact or on a changed key, and never again. A dialog on every
launch is what manufactures the reflex; a dialog on a new identity is what creates the memory.

The **address** decides something different: whether an anchor exists, and therefore whether the
dialog asks a question or reports a decision already made.

| State | Loopback | Any other address |
|---|---|---|
| no pin stored | window showing the fingerprint, an **OK** to acknowledge; the anchor (P3c) already decided it, so there is nothing to refuse | prompt with the fingerprint and three answers, as `ssh` has: **once** (connect, do not store), **always** (store the pin), **no** |
| pin matches | nothing. Connect. An `INFO` line records the fingerprint | same |
| pin does not match | refuse, and offer an explicit re-pair showing both identities (P5) | same. This is `ssh`'s changed-host-key failure, and it is a failure, not a question |

The **once** answer matters for the remote case: connecting one time without committing a pin is a
real need, and storing a pin the user did not intend is how a wrong identity becomes permanent.

The fingerprint stays visible passively — a status indicator or an about panel — so a user who wants
to check can, without being asked every time. Confidence available on demand rather than pushed.

**The remote confirmation needs something to compare against, or it is consent wearing verification's
clothes.** A fingerprint shown alone tells the user nothing — they have never seen the right one. So
the hub must be able to print its own fingerprint locally, on its own host, in the same format the
client displays. Then a user who cares can compare across a channel the attacker does not control,
and a user who does not is no worse off than today. Without that command the remote dialog is
theatre, and this is the one part of the operator's decision that needed adding rather than
recording.

*Scope:* **none of this section is delivered.** It describes what #201 will build, and the table above
records it as deferred; read the two together and the table wins. What exists today is narrower: a
first pin is recorded without asking, after a live hub has proved it holds the announced key, and a
mismatch is a terminal startup failure naming `--reset-hub-pin`. No fingerprint is displayed, no
once/always/no prompt exists, no re-pair interface exists, and a matching pin logs nothing. The remote
half additionally waits on a non-loopback bind (#96) and lands with #193.

*Display format:* a raw base64 SPKI digest is not comparable by eye. Whatever form is chosen must be
identical on both ends and readable aloud, since comparing over the phone is the realistic
out-of-band channel.

### P4 — The pin survives a renewal with the same key

Whatever pins the hub's identity pins the **SPKI**, not a leaf-certificate fingerprint, so
re-issuing with the same key leaves existing pins valid.

*Where this applies:* both cases. The operator whose certificate is renewed by their CA over the same
key keeps every client's pin. The generated case reuses one leaf across restarts and signs a new one
only when the stored one cannot serve, so P4 is what makes that renewal invisible to a pinning client
when it happens — roughly every 818 days, or after a clock anomaly or corruption. What follows
describes the operator case, where the only
thing that changes a generated key is P10's rotation, which changes the SPKI **on purpose** and
therefore invalidates pins by design. The two are not in tension: P4 says a new certificate over an
old key preserves pins, P10 says a new key breaks them.

### P5 — A pin mismatch is terminal for that connection

On mismatch the client does not connect, does not offer to continue, and does not fall back
to an unpinned connection. The only way forward is an explicit re-pair that displays both
identities — the one pinned and the one presented — so the user compares rather than
consents.

### P6 — The desktop accepts a hub solely on the configured pin

Whether the desktop connects is decided by the pin and by nothing else. Concretely, the predicate
is SPKI equality and nothing more (P3): not expiry, not the name, not a chain, not a clock. Adding,
removing or corrupting any OS trust store changes no desktop outcome, in either direction: a hub
whose certificate is in the store but does not match the pin is refused, and a hub that matches the
pin is accepted with an empty store. A wrong system clock changes no outcome either.

*Why stated over outcomes:* "never consults a trust store" describes code. It is also weaker
than intended — a client could consult a store, ignore the answer, and satisfy the sentence
while a later refactor makes the answer load-bearing. The reason to want this is a
per-platform problem the desktop must not inherit: Windows CurrentUser and the macOS keychain
are per-user and need no elevation, while Linux has no per-user store WebKitGTK honours, so
the equivalent is the system store and needs root.

### P7 — No hub traffic originates in the webview

No connection to the hub is initiated by code running in the webview. The terminal stream, the
REST calls and the shutdown request all cross the IPC boundary, and a webview-originated
request is observable as a defect rather than a style question.

*Why not "only through Rust":* that names the implementation. What must hold is the absence of
webview-originated traffic, which a test can decide by observing what the webview attempts.

*Consequence to apply, not to discover later:* the CSP in `createServer`
(`server.ts:~135`) currently allows `connectSrc: ["'self'", "ws:", "wss:"]`. Under P7 the
desktop needs none of it. Whether it can be tightened depends on the browser client, which
still connects directly — say which, with the reason, rather than leaving the directive as
it is because it works.

### P8 — A durable credential is held only by a client that can verify the recipient

A client keeps a credential across the death of the hub that issued it **only if** that client
can establish which hub it is talking to before presenting it. A client that cannot must hold a
credential that stops being useful when that hub stops running.

This one rule decides all three deployments, instead of three special cases:

| Client | Verifies by | Credential |
|---|---|---|
| desktop | SPKI pin (P4, P5) | durable — read from `auth.json` by Rust, never in a browser origin |
| any browser | nothing the hub can establish | does not outlive the hub run that issued it |

**Why no certificate improves the browser row.** `localStorage` is keyed by
**origin**, not by certificate: the origin is `https://127.0.0.1:<port>` whatever certificate is
presented. So a browser pairs, its token is stored, the hub dies, another OS user binds the
port and serves its own certificate, the victim accepts the warning, and the attacker's
JavaScript reads the token at the victim's origin. This is §2.1 in the place §2.1 always
applied — the browser's code comes from the hub, so it cannot verify the hub.

The mechanism that would remove the click-through is HSTS, and it is unavailable here by
specification. RFC 6797 §8.1.1: "If the substring matching the host production from the
Request-URI … syntactically matches the IP-literal or IPv4address productions … then the UA
**MUST NOT** note this host as a Known HSTS Host." On a hostname it is available and decisive —
§8.4 requires the UA to "terminate the connection if there are **any** errors", and §12.1 gives
the user "no user recourse". On a hostname that protection is real. On `127.0.0.1` it does not
exist, and no public CA issues certificates for `127.0.0.1` either (CA/Browser Forum, since
October 2016).

**No browser pairing yields a durable token, and there is no condition under which one does.**

Two earlier drafts tried to carve out a safe browser case. Both failed, for the same reason.

- *"The split follows the issuance path."* It decides nothing: every browser token, safe deployment
  or not, comes through the same pairing.
- *"Durable when the hub presented an operator-supplied certificate matching the requested host."*
  Server-observable, and still insufficient. That the hub **presented** a certificate says nothing
  about whether the browser **accepted it on a chain** — an operator may supply a self-signed or
  expired leaf and the condition still holds. The hub cannot establish browser-verifiability: it
  would have to validate a chain against the browser's root store, which it does not have, and
  Chrome additionally requires Certificate Transparency SCTs that a valid chain does not imply.
  HSTS is worse, because the hub can send the header and never observe that the UA noted it.

So the rule is unconditional, which is what makes it decidable: a token issued through browser
pairing does not outlive the hub run. `auth.ts:21` exports `PRIMARY_TOKEN_ID = "primary"`, so the
`auth.json` token the desktop uses is already distinguishable from every other row in
`auth_tokens`, and that sentinel is the whole allowlist. No new column, no mark, no condition.

**Why a pairing token is still needed at all.** TLS authenticates the *server* to the client; it does
not authenticate the client to the server. Without a bearer token any local process could drive the
hub — open terminals, run commands as the user. And a browser cannot read `auth.json`, which is a
file on disk, so the pairing ceremony exists precisely to place a credential in a client that has no
filesystem. Only the token's lifetime changes here.

*The next idea, and why it fails:* an `HttpOnly` cookie would stop the attacker's JavaScript from
**reading** the credential. It does not help, because the browser sends the cookie to the origin
automatically and the attacker holds the origin — it arrives on the first request the page makes,
unread. No cookie attribute binds a credential to a certificate.

**The cost, and why it lands well.** A browser user re-pairs once per hub **run**. A deployed remote
hub runs for weeks, so that is once per weeks. The hub that restarts constantly is the
desktop-launched one on loopback, which was never durable under any version of this rule.

**A constraint #193 inherits, recorded here so it is not discovered there.** A *desktop* attaching to
a **remote** hub also pairs, because it cannot read another machine's `auth.json`. That client
**pins**, so by P8's own rule its credential should be durable — and the sweep predicate above kills
it, forcing a re-pair on every restart of the remote hub. The rule is correct for this work's scope
(loopback, where the desktop uses `auth.json` and never pairs) and insufficient for #193.

The hub cannot tell a pinning desktop from a browser at pairing time, which is finding 7's wall in a
new place. What would cross it is observable at the TLS layer rather than above it: a **client
certificate**, making the handshake mutual. That is new provisioning and it is out of scope here, but
it is the candidate answer for #193 and the reason to reconsider client certificates at that point —
not as a replacement for this design, as the thing that lets a remote client hold a durable
credential.

**What it gives up:** a self-hoster with a real certificate gets no credit for having one. That is a
real loss, and it is preferred to a condition the hub cannot check. A durable token issued on an
unverifiable premise is the original vulnerability with extra steps.

**Mechanism note — a startup sweep, not an instance identifier.** The obvious reading of "does
not outlive the hub run" is a new instance id on each token, compared against the running hub's
id. Reject that: it adds an authority ("which instance is running") whose unreadable, stale and
partial outcomes all have to be defined, and every one of them is a way to accept a token that
should have died. The existing schema needs none of it. `auth_tokens` already carries
`revoked_at` and `expires_at`, and `auth.ts:229-230` documents that validity requires
`revoked_at IS NULL` and an unexpired row. So the hub invalidates **once, at startup**, every row
whose id is not `PRIMARY_TOKEN_ID`, and the request path is completely unchanged.

*The predicate is an allowlist of exactly one id, not a denylist.* Everything it does not positively
recognise is swept, so a row written by a future version is swept rather than kept. A denylist would
keep it, and keeping an unrecognised credential is the failure this whole property exists to remove.

*Detail to settle, because reusing a column changes what the operator sees:* whether the sweep
writes `revoked_at` or gets its own column. `revoked_at` conflates "the operator revoked this"
with "the hub restarted", which makes a token list lie about what happened and loses the
distinction in any audit. A separate column is a smaller change than the instance id it
replaces.

**Cost, stated plainly:** a browser client re-pairs once per hub run. On a desktop-launched hub
that is once per application launch. The desktop client is unaffected, since it pins.

#### P8-authority — what permits accepting, and what permits rejecting

P8 makes a token stop being accepted, which is a revocation, and a revocation decision needs its
authorities enumerated with their failure variants. The startup-sweep mechanism is chosen partly
because this table is short — the instance-identifier alternative makes it long, and every extra
row is a way to accept a token that should be dead.

| Authority | Outcome | Decision |
|---|---|---|
| `auth_tokens` row for the presented hash | present, not revoked, not expired | **accept** |
| | absent | reject |
| | present, swept or revoked | reject |
| | present, expired | reject |
| meta.db | unreadable, locked, or the query throws | **reject** — the hub cannot establish validity, and ignorance authorises nothing |
| the schema | `auth_tokens` or its `revoked_at` column is absent, or a migration has not run | **the hub must not be serving.** The sweep cannot run, so it cannot establish that last run's tokens are gone |
| the row's id | equal to `PRIMARY_TOKEN_ID` | keep it through the sweep |
| | anything else, including a value this version does not recognise | sweep it |
| a hub-run identifier | *no such authority exists* | the sweep leaves nothing to ask. This row is here because two rejected designs needed one, and every failure outcome of theirs was a way to accept a token that should have died |
| a durable mark, a certificate property, a client claim | *no such authority exists* | there is no durability condition to evaluate (P8), so there is no authority to consult and no failure mode to define |
| the startup sweep | committed before the listener accepts a connection | this is what makes acceptance meaningful |
| | failed, or not yet run | **the hub must not be serving.** A failed sweep is a startup failure, not a warning: serving after it fails accepts every token from the previous run, which is precisely the state P8 removes |

The only positive evidence for accepting is a row that is present and valid **in a database the
hub could read**, in a process whose sweep has already committed. Every other outcome rejects.
Note what is absent from this table: no authority is consulted about which hub instance is
running, because the sweep leaves nothing to ask.

**Ordering, joined with P3b.** The startup sequence is: acquire the key and certificate → sweep
the non-primary tokens → bind the TLS listener → publish the record naming the port and SPKI.
Each step is only reachable when the previous one committed. A crash at any point leaves either
no record, or a record whose hub is serving with the sweep done.

### P12 — The default listening port is not guessable

Absent an explicit port, the hub binds one the operating system assigns. An explicit port, from the
precedence #175 documents, still overrides it.

**What this buys, and it is the reason it is worth the disruption.** P3c protects the first pin with an
anchor, but a client that must *find* the hub at a known port gives an attacker somewhere to wait: bind
4100 before the hub, and a client consulting that port pins the squatter. An unguessable port removes the
place to wait. The operating system will not hand out a port already bound, so an attacker holding N
ports simply makes the hub take one of the others.

For a hub the desktop launched this composes with P3c's pipe: port and SPKI arrive together over a
channel no third party can write, and nothing on disk is consulted at all. For a hub the client attaches
to, the anchor remains `runtime.json` at 0600 and this property adds nothing — the two cases are
protected by different things and both are covered.

*What it costs, stated because a reader will hit all four.*

| Affected | Consequence |
|---|---|
| the browser path | no memorable URL. The port must be read from `lasterm status`, the pairing output, or the desktop UI. A user who wants a stable URL sets a port explicitly, which is what the override is for |
| `zero_conf` | the 4100→4199 scan (`server.ts:576-590`) exists to survive a taken port and becomes pointless — an OS-assigned port does not collide. It stays meaningful only when an explicit port is given |
| documentation | every place naming 4100 as the default describes an override, not the default. `docs/SPEC.md` and the pairing instructions both do |
| firewall rules | a fixed rule needs an explicit port. That is the professional-user case and the override serves it |

### P10 — The operator can replace the key, and no schedule can

**None of this section is delivered.** It describes what #199 will build, and the table above records
it as deferred; read the two together and the table wins. Today no command replaces the hub's key,
nothing logs a rotation, and nothing warns that a certificate is near expiry — replacing the key means
stopping the hub and deleting its file, which is unsupported and re-pairs every client silently.
`--reset-hub-pin` is unrelated: it clears a desktop's trust record, and does not touch the hub.

What follows is the design that section will follow.

An operator action replaces the hub's key and certificate. After it, every client holding the old
pin refuses to connect and must establish a new pin through P3c's anchor. The operator-supplied case
already has this for free — replace the files, restart — so the generated case must offer the
equivalent as a named operation rather than leaving the operator to guess which file to delete.

**Nothing else may rotate it.** Not expiry, not a schedule, not a version upgrade, not first run
after an update. This is the constraint that makes the rest work: on a pinned system, routine
rotation means routine re-pairing, and a user who re-pairs routinely learns to accept whatever is
put in front of them. Pinning's whole value is that a mismatch is rare enough to be alarming. A
rotation that happens on its own converts the alarm into a chore.

So rotation is loud and manual: the command states that every paired client must re-pair, and it
logs the old and new fingerprints so an operator can tell a rotation they performed from one they
did not.

**The system may remind, but never act.** When the certificate is expired or near expiry, the hub
says so — a startup log line, and a signal a management UI can surface — and names the rotation
command. That is a notification, and it produces no new key and no new pin, so it does not train the
reflex an automatic rotation would. The line between "remind the operator" and "rotate for them" is
the whole point: the first is safe at any frequency, the second is what pinning cannot tolerate.
This is what the operator asked for and it costs nothing to hold: reminding is passive.

*Why this was missing:* the previous revision said the key is "generated once and kept" and, in the
same section, accepted that "a leaked key stays valid" — a consequence with no operation behind it.
A stated exposure whose remedy does not exist is a defect, not a trade-off.

### P11 — A file whose permissions we rely on is checked where it is opened, and refuses

Every file this design's security depends on — `auth.json`, `runtime.json`, the private key, the pin
store — is opened through one function that verifies ownership and permissions and **refuses** on
anything unexpected, with a message naming the file and the command that fixes it. Both binaries
enforce it, the hub and the desktop.

Refusing is the point. A warning that lets the process continue is how a wrong mode survives to the
moment it matters.

**Two facts from the repository change what this costs.**

- `checkPermissions` (`packages/hub/src/auth.ts:59`) already **throws** on world-readable and
  already prints the fixing command. It only **warns** on group-readable, and it **returns
  immediately on Windows** (`if (process.platform === "win32") return;`). So the POSIX half exists
  and needs one outcome changed; Windows has no enforcement at all, and that is where the work is.
- `crates/lasterm-process-lock/src/lib.rs:44,64,77` already opens a file symlink-safely on both
  platforms — `O_NOFOLLOW` on Unix, `FILE_FLAG_OPEN_REPARSE_POINT` plus a reparse-tag check on
  Windows, with comments explaining why. Mirror that; do not invent it.

**What "expected" means, per platform. The two platforms need different checks, and Windows needs
fewer than it first appears.**

| | Unix | Windows |
|---|---|---|
| the file's permissions | owned by the running uid, no group or other bits — **checked** | **not checked.** See below |
| the containing directory | not writable by group or other — **checked** | not checked, same reason |
| the path is not redirected | opened `O_NOFOLLOW`, so a symlink planted by another party fails instead of redirecting — **checked** | `FILE_FLAG_OPEN_REPARSE_POINT` plus a reparse-tag check — **checked**, and the code already exists |

**Why no ACL check on Windows, and what that costs.** `%LOCALAPPDATA%` carries a default ACL granting
Full Control to the owning user, SYSTEM and Administrators, so another standard user cannot read it.
Administrators can, which is the same position `root` holds against a 0600 file on Unix, and §2.0
already places that attacker out of scope. Reading and evaluating a DACL from Node needs a native call
or shelling out to `icacls`, so the cost is real while the marginal privilege it denies is small.

**The residual, stated because it is a real gap and not a rounding error.** P3's non-replaceability
then holds on Windows **by the platform's default** rather than by verification. An ACL modified by
hand, by an installer, or by a roaming-profile configuration to grant another standard user write
access is **undetected**, and that is exactly the substitution P3 cares about, on the one platform
where nothing checks. A cheap partial exists and is worth taking rather than nothing: verify the
resolved path lies under the current user's profile root, which catches a redirect to a shared
location and costs one comparison. It does not catch a hostile ACL on the correct path.

If this residual is later judged unacceptable, the fix is a DACL check and the trigger to revisit is
evidence that hand-modified ACLs occur in practice — not discomfort with the asymmetry, which is
documented here precisely so a later reader does not "fix" it blind.

**Why the reparse check is not optional on Windows.** It defends a different property. Windows
supports directory junctions and symlinks, so a link planted at an expected path **redirects the
open** regardless of how sound the ACL on the intended target is. Confidentiality and non-redirection
are separate concerns, and only one of them is covered by a default ACL.

*The early `return` on `win32` in `checkPermissions` is therefore correct for the permission half and
wrong as a whole*, because it also skips the redirection half. Replace it with the reparse-safe open
rather than with a DACL reader.

**Migration consequence, to state in the release notes rather than discover in an issue:** turning
the group-readable warning into a refusal means a hub whose `auth.json` is 0640 stops starting. The
message already tells the user to run `chmod 600`, so the fix is one command, but the first start
after the upgrade is the moment it happens.

### P9 — The relay cannot buffer without bound

Output the webview is not consuming must not accumulate without a limit in the shell. Every relayed
stream has a byte or message cap, and reaching it has **one** outcome, chosen here rather than left
to the implementer:

| Direction | Cap reached | Why this outcome |
|---|---|---|
| hub → webview (terminal output) | the relay **stops draining** its socket, so the receive window closes and the pressure reaches the hub | lossless, and it reproduces exactly what the direct WebSocket did for free. The hub already spools output, so a stall costs latency and never content |
| webview → hub (input) | the channel **disconnects** | keystroke volume cannot reach a sane cap in normal use, so reaching it means something is malfunctioning, and stalling input would hide it |
| REST bodies, either way | there is no cap because there is no buffer: the relay **streams** and never holds a whole body | a cap on a buffered body is a memory limit dressed as a policy |

Silently growing memory is not an option, and neither is silently dropping frames.

*Why this is a new property and not an existing one:* today the terminal stream is a direct
WebSocket, so when the page stops reading, TCP's receive window closes and the backpressure reaches
the hub for free. Putting a Rust relay in the middle breaks that chain — the relay's own socket
keeps draining while the webview, backgrounded or busy, stops consuming events. §2.3 measures 318
MiB/s through the boundary, which is exactly how fast an unbounded queue would grow.

The same rule applies to the REST relay in the other direction. A relay that buffers a whole
multipart upload to hand it across the boundary turns **four** existing streaming routes into memory
proportional to the file: `/api/agents/import` (**64 MiB**, and two files at once), `/api/fonts` and
`/api/wallpapers` (10 MB each), `/api/ssh-keys` (100 KB). The agent binary is the one that decides the
design — a 64 MiB buffer held across the boundary is not an edge case, it is the documented cap.

### P8-rejected — two answers that were considered and do not hold

Recorded because each is the obvious next proposal, and both waste a round if re-proposed.

**"Document the residual and keep the standing credential."** The cheapest answer: state that
only the desktop verifies, and that a browser trusts a dialog. It is honest and it leaves the
theft in place. Rejected because the theft is removable at the cost of one re-pair per hub run,
and a documented hole that a small change would close is a hole, not a residual.

**"Pair per certificate, so a new certificate needs a new pairing."** Closes nothing. The
attacker serves the page, so the attacker's JavaScript reads `localStorage` whatever the pairing
was bound to. The binding would have to be enforced by the server, and the server is the
attacker. What must lose its value is the stored token, not the ceremony that produced it.

TLS on its own still leaves the browser path better than today, where the same theft happens
with no warning at all. Better is not verified, and P8 is what makes the difference decidable.

## §4 Transport swap — measured surface

Every line below carries its evidence. Two claims from the first investigation were wrong in
ways that would have shaped this design, and both are corrected here.

### 4.1 The desktop already bundles its own interface

`tauri.conf.json:8` sets `frontendDist: "../../web/dist"`. The desktop webview loads the UI
from the application bundle, not from the hub. So the desktop's UI delivery is **unaffected**
by removing the plaintext listener.

This also bounds §2.1: "a client delivered by the server cannot authenticate the server"
applies to the **browser** client, whose JavaScript does come from the hub. The desktop's
code is bundled and shipped with the application. P7 exists because the webview cannot
complete a TLS handshake against a self-signed certificate (§2.2), not because of delivery.

### 4.2 What the webview calls, and how much of it there is

| Surface | Location | Shape |
|---|---|---|
| WebSocket URL builder | `web/src/utils/hub-url.ts:74-80` | `ws://127.0.0.1:<port>` under Tauri; in a browser it follows the page — `wss:` when `window.location.protocol === "https:"`, else `ws:` (`:78-79`) |
| REST base URL | `web/src/utils/hub-url.ts:67-72` | `http://127.0.0.1:<port>` under Tauri, `""` in a browser |
| REST call sites | across `web/src` | **76** uses of `hubBaseUrl()` outside tests — 72 of them plain, 4 streaming uploads (§4.4) |
| WS client | `web/src/services/ws-client.ts` | `IWsClient` at lines 13-21: `connect(url)`, `send`, `on`, `onReconnect`, `onDisconnect`, `close`, `readonly isConnected` |
| its sole **constructor** | `web/src/stores/session.ts:22` | the only `new WsClient()`; appends `/ws`, resolves the port via `get_hub_port` (`hub-url.ts:39`) |
| its other **consumers** | six modules, injected via `setWsClient(client: IWsClient)` | `host-verify.ts:35`, `auth-prompt.ts:48`, `useActivityTracker.ts`, `useTerminal.ts:21`, `writelock.ts:27`, `agent-verify.ts:24` |

The WS client depends on `WebSocket`, `binaryType = "arraybuffer"`, the four handlers, and
`setTimeout` for a backoff of 1, 2, 4, 8, 15, 30 s with no cap.

**`IWsClient` is the seam, and it has seven consumers rather than one.** An earlier draft called
`session.ts` the only caller. It is the only place that *constructs* the client; six further modules
receive it through `setWsClient` and call its methods. That widens what an IPC-backed implementation
must satisfy, and it strengthens the argument at the same time — an interface six unrelated modules
already depend on is a real seam rather than an artefact of one call site.

The two URL builders are the other seam, and they are already the single place each transport
decision is made, which is why 76 REST call sites are not 76 edits — and why 72 of them need no design
decision at all (§4.4).

*One thing the browser path does for free:* `hubWsUrl()` already derives its scheme from the page, so
a browser reaching an HTTPS hub upgrades to `wss` with no change. Only the Tauri branch hard-codes a
scheme.

### 4.3 The desktop's HTTP client cannot currently speak TLS

`Cargo.toml:24` declares `reqwest = { version = "0.12", features = ["blocking"],
default-features = false }`. In the resolved `Cargo.lock`, **reqwest 0.12.28 has 26
dependencies and none of them is a TLS backend**. Its single use today is consistent with
that: `request_hub_quit()` (`lib.rs:1705-1784`) posts to `http://127.0.0.1:<port>/api/quit`,
and it is the only HTTP request the shell makes.

`rustls 0.23.37` **is** already in the graph, but through **reqwest 0.13.2** (31
dependencies, including `rustls`, `hyper-rustls`, `tokio-rustls`,
`rustls-platform-verifier`) and `tauri-plugin-updater` — not through the 0.12 the desktop
crate declares. A read that does not separate the two versions concludes the opposite; two
successive probes did.

**SETTLED by a spike with a runtime assertion.** Keep reqwest 0.12; consolidation on 0.13 is not
required. The configuration that works:

```toml
reqwest = { version = "0.12", features = ["blocking", "rustls-tls-manual-roots"], default-features = false }
rustls  = { version = "0.23", default-features = false, features = ["ring", "std", "tls12"] }
```

Manual roots is the right feature because pinning wants **no** trust anchors.

**The rustls requirement must resolve to the same version reqwest uses, and a caret does that.**
`use_preconfigured_tls` takes `impl Any` and **downcasts at runtime**
(`reqwest-0.12.28/src/blocking/client.rs:1068` → `async_impl/client.rs:2156`), so a `ClientConfig`
built against a semver-incompatible rustls is a different type: it compiles cleanly and fails when the
request runs. That is why a `cargo check` could not have answered this and the spike had to issue a
real TLS request.

*An exact `=0.23.37` pin was tried first and is wrong.* Cargo already unifies semver-compatible
versions, so `"0.23"` resolves to one rustls 0.23.37 shared with `hyper-rustls` across reqwest 0.12
and 0.13 — verified by `cargo tree -i rustls`, with the three tests still passing. The exact pin bought
nothing and **blocked patch updates to a TLS library**, which is the wrong trade on the one dependency
where security fixes matter most. Only a rustls 0.24 while reqwest still requires 0.23 would make the
requirement bind, and the caret handles that correctly by staying on 0.23.

Verified rather than reported: three tests in `src/tls_identity.rs` pass — a matching SPKI completes a
blocking TLS request, a different SPKI fails at the handshake with no HTTP bytes sent, and an expired
certificate naming `wrong-hostname.invalid` still connects when its SPKI matches. Suite 46 → 49.
Mutating the SPKI comparison to `true` turns the second test RED and leaves the other two green, so
the discriminating lock is that one and the three are not redundant.

**The SPKI is read with `rustls-webpki`, not a second parser.** The spike first reached for
`x509-parser 0.16`, which would have added seven crates (`asn1-rs`, `der-parser`, `oid-registry`,
`nom`, `rusticata-macros`, `data-encoding`, `lazy_static`) to the **production** build, in the trust
path, reading a certificate supplied by the peer.

`rustls-webpki 0.103.13` is already in the graph, is written by the rustls authors, and already parses
certificates there. The path is fully public, checked in the vendored source:
`EndEntityCert::try_from(&CertificateDer)` (`end_entity.rs:63`) → `Deref` to `Cert`
(`end_entity.rs:172`, `cert.rs:30`) → `Cert::subject_public_key_info()` (`cert.rs:234`), documented as
the RFC 5280-compliant SPKI. So `x509-parser` is removed.

*Two things a reader should carry from that.* A malformed certificate must map
`EndEntityCert::try_from`'s error to `CertificateError::BadEncoding` rather than panicking, since the
input comes from the peer. And whatever computes the pinned value must produce it the same way the
verifier reads it — the pin is bytes, and two parsers agreeing is an assumption, not a given.

*Not a cost, checked because the lock diff looks alarming:* the change adds 26 lock entries including
`quinn`, `quinn-proto` and `quinn-udp`. `cargo tree -i quinn` prints nothing for the host and nothing
for `--target all`, so QUIC is in no build graph — those are lock entries for a feature combination
nothing enables.

*Cost already paid:* rustls pulls `ring`, and `ring` is what prevents cross-compiling this
crate for `x86_64-pc-windows-msvc` on a Linux host. Since rustls is already in the graph,
enabling it for reqwest adds no new instance of that problem. Lint the Windows target with
`--target x86_64-pc-windows-gnu` as the repository already does.

### 4.4 Per-module change type

| Module | Change |
|---|---|
| `hub/src/server.ts:128` (Fastify construction) | additive — TLS options |
| `hub` config + `ServerOptions` | additive — the cert/key pair as one unit (P2) |
| `web/src/utils/hub-url.ts` | rewrite of two small builders; signatures unchanged |
| `web/src/services/ws-client.ts` | rewrite behind `IWsClient`; the interface holds |
| `web/src/stores/session.ts` | no change if the seam holds — verify, do not assume |
| `desktop src-tauri` | new: an HTTP relay command and a streaming channel. The ten existing `#[tauri::command]`s use no `ipc::Channel`, but `acknowledge_desktop_close` (`lib.rs:2122-2140`) already emits `desktop-close-expired` from a spawned thread — a one-shot event rather than a stream, and the precedent for pushing to the webview |
| `hub/src/sea-static-server.ts` | no change — the desktop does not load its UI from here (4.1) |

**Established by inventory, and the answer is narrow.** **72** call sites are a mechanical relay —
method, headers, a JSON or text body in, a JSON or text body out — and **4** depend on something a
request/response message pair does not reproduce. All four are the same behaviour: a streaming request
body, `FormData` carrying a `File`.

| Call site | Route | Payload | Server cap |
|---|---|---|---|
| `web/src/stores/agent-manager.ts:417` | `/api/agents/import` | two `File`s: binary plus manifest | **64 MiB**, enforced by its own multipart instance (`api/agents.ts:436-439`) |
| `web/src/components/settings/FontPicker.vue:107` | `/api/fonts` | one `File` | 10 MB |
| `web/src/components/settings/categories/wallpaperUpload.ts:42` | `/api/wallpapers` | one `File` | 10 MB |
| `web/src/components/SshKeyPicker.vue:196` | `/api/ssh-keys` | one `File` | 100 KB |

The agent binary is the large one, not the font or the wallpaper. The hub registers a **separate**
`@fastify/multipart` instance for `api/agents.ts` precisely because the global registration
(`server.ts:335`) caps at 10 MB — so a relay that buffers holds up to 64 MiB, and both files at once for
that route.

**What the inventory found none of, which is what makes the relay tractable:** no `AbortSignal`, no code
reading `res.body` as a stream, no `res.headers` read directly, no `res.redirected` or
`redirect: "manual"`, and no function returning a `Response` for a caller to consume later. P9's
streaming requirement therefore has exactly four call sites to satisfy, and 72 need no design decision.

**No site depends on being same-origin.** Zero `credentials:`, zero `document.cookie`, zero
`withCredentials`; every call carries `Authorization: Bearer`. Moving the request's origin into Rust
costs nothing here. The only relative-URL behaviour lives inside `hubBaseUrl()` itself, which returns
`""` in browser mode so the path resolves against the page — the helper's documented behaviour, not a
call site bypassing it.

*A count corrected:* an earlier draft said 77 sites, taken from the first investigation. A careful
enumeration finds **76** — of 80 `fetch(` matches, one is a local function declaration named `fetch`
(`web/src/composables/useLogs.ts:73`) and three are comments mentioning it.

**Sequencing:** the hub-side work (P1, P2, P3, P3b, P10, P11, P12) never depended on this. The relay
(P7, P9) now has its contract.

## §5 Test requirements

Named by the property each test defends, because a test named after a mechanism dies with
that mechanism.

Rows for **P3c-visibility** and **P10** describe tests for behaviour that does not exist. They belong
to #201 and #199, and are kept here so those issues inherit the locks rather than reinventing them.
Every other row is asserted today.

| Property | The test asserts | Kills the mutation |
|---|---|---|
| P1 | no endpoint accepts a token or the owner header over plaintext | a config or default that yields `http` |
| P2 | a config with cert-and-no-key fails to load, naming the key | a validator that warns and continues |
| P3 | the certificate is not a CA; a hostile mode on an ancestor directory yields a refusal to start, not a generated key | `basicConstraints: CA:TRUE`; generating into a world-writable path |
| P3b | with the hub killed and its record intact, a squatter on that port yields a pin failure **and zero bytes of credential sent** | sending the token then validating; a warn-and-continue; a truncated record treated as absent |
| P3b | a reader never observes a record with a port and no SPKI | non-atomic publication (write-then-append) |
| P4 | a re-issued certificate over the same key satisfies an existing pin | pinning the leaf fingerprint |
| P5 | a mismatched SPKI yields no connection and no fallback | any continue-anyway path |
| P6 | with an empty trust store a pinned hub is accepted; with the certificate installed but the pin different it is refused | consulting the store for the decision |
| P7 | the webview attempts no connection to the hub | a leftover direct `WebSocket` or `fetch` |
| P8 | a pairing-issued token is rejected after a restart, and the primary `auth.json` token is still accepted | sweeping both, or neither; excluding by anything other than `PRIMARY_TOKEN_ID` |
| P8 | no request, header or configuration causes a browser pairing to survive a restart | any durability condition at all — a client flag, a certificate property, a config key |
| P8-authority | a hub whose startup sweep fails does not accept a connection | logging the failure and serving anyway |
| P8-authority | an unreadable meta.db rejects, never accepts | a `catch` that falls through to accept |
| P9 | with the webview not consuming, the relay's memory stays bounded and the hub observes backpressure | draining into an unbounded queue |
| P9 | an upload crosses the relay without its body being held whole | buffering the body to hand it across |
| P10 | after the operator rotates, a client holding the old pin refuses; nothing else in the system ever rotates | a scheduled or expiry-driven rotation; a rotation on version upgrade |
| P11 | a group-readable `auth.json` refuses to start, naming the file and the fix | warning and continuing |
| P11 | a symlink planted at any of the four paths fails the open instead of redirecting it | an open without `O_NOFOLLOW` / `FILE_FLAG_OPEN_REPARSE_POINT` |
| P11 | the check runs on Windows | an early `return` on `win32` |
| P3c | for a hub the client launched, the pinned SPKI is the one the child announced on its own pipe | reading the SPKI from `runtime.json` for a hub we spawned, which a third party could have written |
| P3c | when `runtime.json` fails the P11 check, no pin is established and no credential is sent | establishing the pin and reporting the permission problem afterwards |
| P3c-visibility | with a pin already stored and matching, no dialog appears at all; an `INFO` line records the fingerprint | a dialog on every launch, which is what turns the prompt into a reflex |
| P3c-visibility | with no pin stored, a non-loopback address offers **once** without storing a pin | treating "once" as "always", so an unintended identity becomes permanent |
| P3c-visibility | a non-loopback address requires explicit confirmation, and the hub can print the same fingerprint on its own host | a remote pin established silently; a fingerprint with no local counterpart to compare |

Every regression lock is RED→GREEN proven: break the property, watch the named test fail,
restore, watch it pass. A lock never observed failing is a hypothesis.

## §6 Adversarial findings ledger

Five perspectives plus the authority-table review duty. Six findings, all six real, all folded in.
The pass read the revision before the startup-sweep mechanism existed, so its authority-table
finding is answered partly by P8-authority as already written and partly by rows this round added.

| # | Class | Finding | Resolution |
|---|---|---|---|
| 1 | M | "A local attacker" is two threat classes. A same-user process already reads `auth.json`, so against it the marginal privilege of this design is zero. | **Fixed** — §2.0 states both classes and which one is addressed. |
| 2 | M | P3b's claim "the hub that wrote it" is false under this design's own lifecycle: A publishes `(P, K)`, dies, B starts on P with K, and a reader reaches B. | **Fixed** — P3b now promises a server presenting the published SPKI. The key is what a client can check. |
| 3 | M | P6 ("the pin and nothing else") contradicted P3 leaving expiry open — the first already requires accepting an expired matching certificate. | **Fixed and settled.** The predicate is SPKI equality alone; the key is generated once and kept, so no restart invalidates a pin. |
| 4 | S | P3b authenticates continuity, not the **first** pin. An attacker winning the initial race publishes its own SPKI and is pinned; atomicity only makes the forgery consistent. | **Fixed** — new P3c names the anchor per case: the child's own pipe for a hub we launched, and 0600 plus directory integrity on `runtime.json` for one we attach to. Also records that displaying two SPKIs is consent, not verification. |
| 5 | M | §2.3 measures throughput, not bounded behaviour. A Rust relay draining the hub while the webview stops consuming replaces TCP backpressure with an unbounded queue. | **Fixed** — new P9 requires caps and one stated overflow outcome per direction, and names the four upload routes. |
| 6 | S | "The split follows the issuance path" cannot decide the two browser rows — both are pairing-issued — and the hub cannot observe HSTS. | **Superseded by finding 7.** This round replaced the rule with a server-observable condition (an operator certificate matching the requested host); round three showed that condition insufficient too and deleted the durable-browser case entirely. The current rule is unconditional. |

What this pass caught that the first one did not: finding 4. The first review accepted the pin as
given and attacked what happens after; this one asked where the first pin comes from, which is the
question trust-on-first-use always has to answer.

### Round three — re-check of the amendments

Four findings, all real. Two of them were defects in round two's own fixes, which is the signal to
delete rather than layer.

| # | Class | Finding | Resolution |
|---|---|---|---|
| 7 | M | Round two's durable-browser predicate ("operator certificate matching the requested host") is **still** insufficient: that the hub presented a certificate says nothing about the browser accepting it on a chain, and the hub cannot validate against the browser's root store or guarantee Chrome's CT requirement. | **Deleted the case.** No browser pairing yields a durable token, under any condition. The rule became unconditional, the allowlist became one sentinel id, and the durable-mark column, its schema rows and its failure modes all disappeared with it. |
| 8 | M | Round two's new discriminator contradicted its own regression lock: §5 still tested "the split is decided by issuance path", the rule P8 had just rejected. A passing test would have preserved the unsafe design. | **Fixed.** The lock now asserts that *no* condition makes a browser pairing survive a restart. |
| 9 | M | P9 was orphaned: it demanded a cap and an outcome "per direction" and chose neither, and had no test row while §5 claimed to cover every property. | **Fixed.** One outcome per direction is now chosen and justified in a table, and P9 has two locks. |
| 10 | S | P3b was *still* overstated. With a squatter on the port the client necessarily **reaches** a peer with a different SPKI — that is how it detects the attack. | **Fixed.** The property is now about what is **sent**: it either authenticates a server presenting the published SPKI, or sends no credential. Third wording, and the first one that does not forbid the detection step. |

### Code-grounding audit

Sixteen claims confronted against the source. Eleven CONFIRMED, five MISMATCH, one GAP as expected.
Every mismatch was in a claim taken from an earlier read-only investigation rather than verified
directly, which is the calibration worth keeping: that report was wrong on **seven** of the sixteen
things it was checked on.

| Claim | Verdict | Correction |
|---|---|---|
| `ws-client.ts` is 172 lines | MISMATCH (171) | line count removed from the spec — a number that rots on the first edit and carries no requirement |
| `session.ts` is the ws-client's only caller | MISMATCH | sole **constructor**; six more modules consume `IWsClient` via `setWsClient`. Widens the swap's surface and strengthens the seam argument |
| ~59 `hubBaseUrl()` call sites | MISMATCH twice | The audit corrected 59 to **77**; a later careful enumeration found **76**. Of 80 `fetch(` matches, one is a local function declaration named `fetch` (`useLogs.ts:73`) and three are comments. Three different numbers for one count, and only the third was arrived at by stating the method |
| three upload routes | MISMATCH | **four** — `/api/ssh-keys` was missing, and it is a `request.file()` route like the others |
| no tauri command emits incrementally | MISMATCH | `acknowledge_desktop_close` emits `desktop-close-expired` from a spawned thread. No `ipc::Channel`, but a push precedent exists |
| a TLS certificate or key is configured anywhere in the hub | GAP, as expected | nothing to build on and nothing to duplicate. The only `https` in the hub is `open-browser.ts:18` and the release fetch in `agent-fetch.ts` |

Confirmations that changed the work rather than merely passing:

- **`persistRuntime()` already publishes atomically at 0600** (`cli.ts:105-123`: `openSync(…, "wx", 0o600)`,
  `fchmodSync`, atomic rename). P3b's atomicity requirement is existing behaviour; what is new is the
  SPKI field and the ordering guarantee. `RuntimeInfo` (`cli.ts:77-84`) already carries an optional
  `instanceId`.
- **`validateTokenRecord` (`auth.ts:234-246`)** is the function implementing the validity rule, so
  P8's sweep reaches the request path through code that already exists.
- **`checkPermissions` is called from `initAuth()` (`auth.ts:89`)**, so P11 has a hook on the startup
  path rather than needing one.
- The `auth_tokens` columns come from `migrations/meta/014-auth-tokens.sql:5-13`, so a new column for
  P8 means a new migration.

*Audit caveat, recorded because it cost real tokens:* every astix tool failed during this audit —
project 397 was registered with `root_path=/mnt/disk/dev/khiops`, the multi-repo umbrella, which is
not a git repository. The audit fell back to native reads throughout. Re-registered as project 398
against `/mnt/disk/dev/khiops/lasterm`.

### Whole-document coherence pass

Four cross-document findings, all real, all folded. This pass looked for relations between distant
sections rather than defects per dimension, which is what the four earlier local passes structurally
could not do.

| # | Class | Finding | Resolution |
|---|---|---|---|
| 11 | S | P3c claimed the first pin is "never taken from a channel a third party can write", while P3c-visibility introduced a remote case with "no anchor" where the presented peer supplies the pin. The universal claim was false. | **Fixed.** P3c now enumerates three cases and names remote as a stated exception: trust-on-first-use, what `ssh` does, bounded by one thing only — an out-of-band fingerprint. That promotes the hub-side fingerprint command from a convenience to the case's only mitigation. |
| 12 | S | P3 required refusal when a party can write the key's directory; P11 then exempted Windows from directory checks. A non-default writable ACL permitted exactly the substitution P3 forbade, and the default ACL is a rationale for a normal install rather than enforcement. | **Fixed by bounding the claim, not by weakening it silently.** P3 now says non-replaceability holds only as far as P11 establishes, and P11 states the Windows residual with the evidence that would justify closing it. Added a cheap partial: verify the resolved path lies under the user's profile root. |
| 13 | M | P3c-visibility carried two tables about the same decision — one requiring "No button" on loopback, one requiring an "OK to acknowledge". One was stale. | **Fixed.** One table. The stale table was the pre-`ssh`-model version, left behind by the revision that replaced it. |
| 14 | M | P3's rationale described an attack the design already defeats — "the pin the client holds then matches the attacker", when a substituted key has a different SPKI and P5 refuses. | **Fixed.** The rationale is now about the first-pin anchor, which is the narrower and real danger. |

Decidability items from the same pass, all now settled: certificate validity is 825 days with a
30-day near-expiry warning (P10's reminder was untestable without them); the reqwest TLS line has a
decision procedure rather than an open question; and the relay's `fetch`-semantics inventory is marked
as gating the relay half only, so the hub-side work can start.

### Operator decisions on the hardened spec

Four decisions from the operator, plus one clarification request. Recorded because three changed the
design and one closed a gap no pass had found.

| Decision | Effect |
|---|---|
| The key must be replaceable, at least by the operator, for a revoked or compromised key | **New P10.** The text said "generated once and kept" while separately accepting that a leaked key stays valid — an exposure with no remedy behind it. Added one constraint the operator did not ask for and the design needs: nothing but an operator action may rotate, because automatic rotation on a pinned system trains the click-through reflex pinning exists to prevent |
| The desktop should show, at launch, that it is connecting to the local hub and accepting its certificate; accept automatically on loopback with an `INFO` log; a hub at any other address must display the characteristics and ask, in the shape of `ssh`'s host-key prompt (yes / no / always accept) | **New P3c-visibility.** The `ssh` reference settled a disagreement in the operator's favour: an intermediate draft said the window must carry no button, on the grounds that a prompt answered "yes" every launch manufactures the click-through reflex. What actually makes `ssh`'s prompt safe is that it is **rare** — first contact or changed key, never again. So the trigger is whether the identity is already pinned, not the launch, and a button on a rare dialog is fine. Added: **once** as a third answer, since connecting one time without committing a pin is a real need; and a hub-side command printing the same fingerprint, or the user has nothing to compare against and the confirmation is consent in verification's clothes |
| Every file whose permissions we rely on must fail closed with an explicit message | **New P11.** Two repository facts changed its shape: `auth.ts:59` already throws on world-readable and already prints the fix, but only warns on group-readable and **returns immediately on Windows** — so the work is Windows, not POSIX. And `lasterm-process-lock` (`lib.rs:44,64,77`) already opens symlink-safely on both platforms, so that is mirrored rather than invented |
| The relay's backpressure choices | Accepted as written |

The lesson from the third pass, recorded because it is the pattern and not the incident: two of its
four findings were defects in the second pass's own fixes. Findings 7 and 8 both came from a carve-out invented to
keep a capability the design could not support. Deleting the carve-out removed a column, a schema
migration, four authority rows and two failure modes. **Three rounds is the declared budget and it
is spent.** Remaining work goes to step 14 and the operator, not to a fourth review.

## §7 Cross-family spec review ledger

One pass, four findings, all four real. Verified against the document and the code rather than
accepted on authority.

| # | Class | Finding | Resolution |
|---|---|---|---|
| 1 | S | The browser path still leaks the credential: `localStorage` is keyed by origin, not by certificate, so a squatter the user waves through reads the stored token. "A client verifies before sending a credential" and the old P8 cannot both be true. | **Fixed, after the operator asked whether an operator certificate was simpler.** P8 is now one rule — a durable credential is held only by a client that can verify the recipient — which decides all three deployments. The two rejected answers are kept as P8-rejected so they are not re-proposed. §1's "the bearer token is unchanged" was corrected: its lifetime changes on one issuance path. |
| 2 | S | The identity lifecycle was unspecified at the crash boundary — when the published SPKI becomes authoritative, whether publication is atomic, how a stale or partial record fails. | **Fixed.** New P3b states the ordering and the after-crash behaviour as one property, with crash-injection tests. |
| 3 | M | All three deliberately-open decisions block implementation, and one *settled* claim was false: "no new provisioning", while P5 requires a durable pin store, a display format and a comparison procedure. | **Fixed.** §1 now names the pin store as new state. Expiry and the reqwest line are marked as blocking rather than merely open; the fetch inventory blocks only the relay. |
| 4 | M | P1, P6, P7 prescribed implementation and P3 was untestable as written. | **Fixed.** All four restated over outcomes, each keeping a note on why the mechanism sentence was weaker. |

What the pass got right that a same-family read would likely have missed: finding 1 required
knowing that the browser storage partition ignores the certificate, which is exactly the fact
that makes the tidy version of this design wrong.

## §8 Tracking

Four documents currently state, with authority, things this design contradicts. Each must be
rewritten before the PR, because an authoritative-looking stale document is how a dead design gets
implemented by whoever reads it next.

| Document | What it asserts | Why it must change |
|---|---|---|
| issue #183 | "Loopback will never have TLS", plus the per-request proof-of-possession as the direction | Both are the abandoned design |
| issue #193 | cites `docs/plans/issue-183-hub-identity.md` as the specification | That file was abandoned and is not in this repository |
| `docs/SECURITY.md` | describes the transport as plaintext loopback, and instructs a second device to open `http://<hub-ip>:4100` | Contradicts P1 outright. Already tracked as self-contradictory in #192, and this design changes the answer rather than resolving the old contradiction |
| `docs/SPEC.md` | documents the hub as binding `127.0.0.1` over HTTP | The port and binding stay, the scheme does not |

Three properties this branch does not deliver are now tracked: **#199** key rotation and the expiry
reminder, **#200** the remaining permission and redirection checks, **#201** the pin-mismatch interface and
the hub-side fingerprint command. #194 keeps the asset blob lifecycle.

`docs/decisions.md` gains this story's decisions: the transport-carries-identity principle, the
SPKI-only pinning predicate with the key generated once, the unconditional browser-token rule, and
the startup sweep chosen over an instance identifier.
