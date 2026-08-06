---
doc-meta:
  status: draft
  story: AGENT-FETCH
  issue: 77
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
---

# AGENT-FETCH — Populate the agent binary cache from GitHub Releases + version-aware deploys (#77)

## §1 Scope

Connecting a remote SSH host requires the agent binary for that host's os/arch in the hub's
binary cache (`~/.local/state/lasterm/binaries/`). Today nothing populates it and the cache
naming (`lasterm-agent-<os>-<arch>`) differs from release asset naming
(`lasterm-agent-<triple>`), so first contact with a new architecture dead-ends in
`AGENT_NOT_AVAILABLE`.

In scope:
- **Auto-fetch on deploy**: when the deployer misses a binary, download the matching release
  asset, place it in the cache, continue the deploy.
- **Explicit command**: `lasterm-hub agent fetch <os-arch>|--all` to pre-populate or force-refresh.
- **Version-aware naming on BOTH surfaces** (user decision): release assets gain a version
  suffix; cache filenames gain a version suffix; the deployer resolves the version matching
  the hub.
- **Staleness policy**: the hub deploys agents of ITS OWN version (`HUB_VERSION`); a cached
  binary of another version triggers a re-fetch of the right one. At session establishment the
  existing `HELLO.agentVersion` is compared; mismatch right after a fresh deploy is an error,
  mismatch on a pre-existing remote agent is a warning.
- Out of scope: hub self-update, desktop updater, download of hub binaries, signed
  checksums/GitHub artifact attestations (follow-up — see §2 trust note), doc writing for
  the go-public transition (analysis only, separate deliverable).

## §2 Reality constraints & scope pivots

- **Auth pivot (user, 2026-06-11)**: instead of GitHub-token plumbing for the private repo,
  the project prepares to FLIP THE REPO PUBLIC (separate readiness analysis delivered with
  this spec). This spec assumes **unauthenticated downloads from public releases**. Transition
  state (repo still private): fetch fails with an actionable error naming the manual gesture
  (download URL + target cache path + rename) — no token configuration is built.
- **"Version in BOTH filename surfaces" (user decision)** — release assets AND cache files.
  Code constraint: release.yml's hub/desktop jobs download agent sidecars by glob; §3.5
  REPLACES those globs with exact versioned names (glob ambiguity bites once two assets match).
- **HELLO already carries `agentVersion`** (`crates/lasterm-agent/src/handler.rs`,
  `env!("CARGO_PKG_VERSION")`); since the release-please extra-files fix (#64/#68) hub and
  agent versions bump in lockstep. "Same version as hub" is a string equality, not a
  compatibility matrix — §3.5 adds a workflow guard asserting that lockstep at build time.
- **Dev builds are NOT release builds — and version shape cannot tell them apart**: in dev,
  `HUB_VERSION` resolves the package.json version (currently `0.3.4`), a perfectly valid
  semver. The dev guard is therefore anchored on **`detectSea()`** (already exported by
  `packages/hub/src/sea-addon-loader.ts`): auto-fetch runs ONLY in SEA builds; source runs
  (tsx/node) keep today's build-it-locally error. The §3.0 semver gate remains for URL input
  safety, not as a dev detector. Explicit `agent fetch` works in both modes (operator intent).
- v0.3.4 and earlier assets use UNVERSIONED names. The legacy fallback (§3.2) is gated on
  `version < 0.4.0` by SEMVER COMPARE — never on "file happens to be absent", which would be a
  silent verification-downgrade vector.
- **Checksum honesty**: `SHA256SUMS-<v>.txt` is served from the SAME origin as the binaries.
  It protects against corruption/truncation/wrong-asset — NOT malicious substitution. The
  authenticity boundary remains the existing deployer trust gate
  (`AGENT_BINARY_REJECTED`/`UNTRUSTED` + per-host verification), which runs UNCHANGED on
  fetched binaries. Signed checksums / artifact attestations are a tracked follow-up, not v1.

## §3 Design

### §3.0 Version input gate

Every version entering the fetch path (auto: `HUB_VERSION`; manual: `--version`) is validated
against strict semver `^\d+\.\d+\.\d+$` BEFORE any URL construction. `0.0.0` and non-matching
values ⇒ `FetchError("BAD_VERSION")` (auto path: deployer skips fetch and falls through to the
existing not-available error). Rationale: `LASTERM_VERSION` env flows into a network URL and
must be treated as untrusted input.

### §3.1 Naming & mapping

| Surface | Format | Example (0.4.0, RPi) |
|---|---|---|
| Release asset | `lasterm-agent-<triple>-<version><ext>` | `lasterm-agent-aarch64-unknown-linux-gnu-0.4.0` |
| Cache file | `lasterm-agent-<os>-<arch>-<version><ext>` | `lasterm-agent-linux-arm64-0.4.0` |

os-arch → triple mapping (ONE exported table, in the new `agent-fetch.ts`):

| os | arch | triple | built? |
|---|---|---|---|
| linux | x64 | x86_64-unknown-linux-gnu | yes |
| linux | arm64 | aarch64-unknown-linux-gnu | yes |
| windows | x64 | x86_64-pc-windows-msvc | yes (.exe) |
| windows | arm64 | — | no → `UNSUPPORTED_TARGET` |
| darwin | * | — | disabled → `UNSUPPORTED_TARGET` |

### §3.2 Fetch module (`packages/hub/src/session/agent-fetch.ts`, new)

`fetchAgentBinary({ os, arch, version, cacheDir, baseUrl?, fetchImpl? })`:

1. Validate version (§3.0); resolve triple (unknown → `UNSUPPORTED_TARGET`).
2. **HTTPS-only**: reject non-`https://` baseUrl (tests inject `fetchImpl`, never http URLs).
3. Download `<base>/releases/download/v<version>/lasterm-agent-<triple>-<version><ext>` with
   redirect-following. Timeouts: total AND idle/stall (a slow-drip stream must abort).
   Node fetch does NOT honor proxy env vars — documented v1 limitation (`NETWORK` error text
   mentions it).
4. HTTP error mapping (distinct, actionable): asset 404 while `GET /releases/tags/v<version>`
   succeeds ⇒ `RELEASE_INCOMPLETE` ("release exists, <triple> asset missing — release build in
   progress or failed"); both 404 ⇒ `NOT_FOUND`; 403 with rate-limit headers
   (`X-RateLimit-Remaining: 0` / `Retry-After`) ⇒ `RATE_LIMITED` (message carries the wait);
   other 403/401 ⇒ `PRIVATE_OR_FORBIDDEN` (message = the manual gesture: URL, cache path,
   rename). Legacy fallback: ONLY when `version < 0.4.0` (semver), retry the unversioned asset
   name.
5. Stream to a **unique** temp file in the cache dir (`<final>.<pid>.<rand>.tmp`, `O_EXCL`,
   `lstat`-guarded against symlinks). NOTE: `getBinaryCacheDir()` is a pure path resolver —
   nothing creates the directory today; `fetchAgentBinary` OWNS the
   `mkdirSync(dir, { recursive: true, mode: 0o700 })`. Cap = 64 MiB on BYTES WRITTEN
   (abort mid-stream; never trust Content-Length; no transparent decompression). `ENOSPC` ⇒
   `FetchError("DISK")` + temp cleanup. Concurrent fetchers of the same target each use their
   own temp; each verifies its own temp; last atomic rename wins (both copies identical —
   double network work accepted in v1).
6. Checksum: download `SHA256SUMS-<version>.txt` (cached on disk per version to spare the
   unauthenticated rate-limit budget of 60 requests/hour/IP), parse with a PURE function
   (exact basename match, reject duplicate lines and path prefixes, normalize hex case,
   tolerate CRLF), verify the TEMP file BEFORE chmod/rename. Mismatch ⇒
   `FetchError("CHECKSUM_MISMATCH")`, temp removed. Missing sums file: `version < 0.4.0` ⇒
   warn + proceed (legacy); `>= 0.4.0` ⇒ hard `CHECKSUM_MISSING` error (downgrade-proof).
7. `chmod 755` the temp BEFORE the atomic rename to the final cache name.

`FetchError` (lives in `agent-fetch.ts`, hub-local — not protocol) codes:
`BAD_VERSION | UNSUPPORTED_TARGET | NOT_FOUND | RELEASE_INCOMPLETE | RATE_LIMITED |
PRIVATE_OR_FORBIDDEN | NETWORK | TOO_LARGE | DISK | CHECKSUM_MISMATCH | CHECKSUM_MISSING`.
Every message is actionable (what to run / where to put what file).

### §3.3 Deployer integration (`agent-deployer.ts`)

Lookup becomes `lasterm-agent-<os>-<arch>-<HUB_VERSION><ext>`. Miss ⇒ IF `detectSea()` AND
`HUB_VERSION` passes §3.0 → `fetchAgentBinary(version = HUB_VERSION)`; ELSE (source run) →
current `AGENT_NOT_AVAILABLE` error unchanged. `FetchError` ⇒
`DeployError("AGENT_NOT_AVAILABLE", <fetch message>)` (actionable text reaches the UI).
Stale versions stay in cache (debuggable); `agent fetch --prune` deletes non-current versions.

**Trust-gate honesty** (matches production, not the earlier draft wording): the TOFU
prompt/verification path (`AGENT_BINARY_REJECTED`/`UNTRUSTED`) fires ONLY when an agent binary
is found ALREADY PRESENT on the remote; uploads from the hub's own cache bypass it by design
(provenance = the hub's verified cache). For fetched binaries that provenance is established
by §3.2 (HTTPS, checksum, 0700 cache, atomic placement) — the spec adds NO new prompt on the
upload path.

Post-deploy HELLO check — **net-new code** (production only `console.warn`s on version
mismatch in `agent-connection-manager.ts` today): after `deployAgentIfNeeded` resolved
`deployed: true` and before the session transitions to connected, `hello.agentVersion !==
HUB_VERSION` ⇒ new structured `AGENT_VERSION_MISMATCH` error + session abort. When THIS
session did not deploy (pre-existing remote agent), keep the warning-only behavior — EXCEPT
when the remote agent's SHA matched our trusted hub-version cache binary (the remote IS our
binary, so a version mismatch means the cache is wrong): that is also fatal. A genuinely
foreign agent (different hash) stays warning-only.

### §3.4 CLI (`cli.ts`)

`agent fetch <os-arch>|--all [--version <v>] [--prune]` following the `host <sub>` parseArgs
pattern (command `agent-fetch`). Net-new parsing surface: `ParsedArgs` gains
`version?: string`, `all?: boolean`, `prune?: boolean`; `parseArgs` gains
`flagValue("--version", args)` plus the two booleans (`--version` is absent from the current
flag list — adding it must not collide with any future `-V` printing concern). Default
version = `HUB_VERSION` (validated §3.0). `--all`
attempts EVERY built target (no early abort), prints one status line per target (cache path or
error message), exits non-zero if ANY failed. Already-cached ⇒ "already cached" no-op line.
On today's private repo the command prints the `PRIVATE_OR_FORBIDDEN` manual gesture per target.

### §3.5 Release workflow (`release.yml`)

Every item below is **net-new** (no current anchor): today's upload loop produces unversioned
basenames with no `VERSION` variable, `publish-release` only deletes the web tarballs and
flips the draft, and draft reuse keeps assets verbatim.

1. Agent upload step: basename `lasterm-agent-${TRIPLE}-${VERSION}${ext}` (`VERSION="${TAG_NAME#v}"`).
2. **Version-consistency guard** (new step in create-release, after checkout): assert
   `${TAG_NAME#v}` == root package.json `.version` == `crates/lasterm-agent/Cargo.toml`
   package version; fail loudly otherwise (protects the HELLO lockstep assumption).
3. **SHA256SUMS: computed ONLY in `publish-release`** (the single serialized job) — download
   all `lasterm-agent-*-${VERSION}*` assets, verify COMPLETENESS against the matrix's enabled
   agent targets (fail if any expected triple is missing), write `SHA256SUMS-${VERSION}.txt`,
   upload it, THEN flip the draft public. Matrix jobs never touch the sums file — a shared
   file written from parallel jobs is a lost-update hazard by construction.
4. Hub/desktop sidecar downloads: replace globs with EXACT versioned asset names
   (`lasterm-agent-${TRIPLE}-${VERSION}${ext}`); fail if the download doesn't yield exactly
   one file; rename at copy time to the fixed unversioned sidecar names Tauri expects.
5. Draft-reuse hygiene: when reusing a draft, DELETE any legacy `lasterm-agent-${TRIPLE}` /
   `lasterm-hub-${TRIPLE}` (unversioned) assets left by older runs, so stale binaries can
   never be silently bundled or published alongside versioned ones.

## §4 BDD scenarios (annotated with their test seam)

1. **Cold RPi connect (auto-fetch)** — fetch+cache half: unit (injected `fetchImpl`, temp
   cache dir); SSH+deploy half: existing mock-SSH deployer spec with injected fetcher; full
   network path: deferred to the next real release (documented in PR).
2. **Explicit prefetch** — `agent fetch linux-arm64` populates then no-ops on rerun. Unit
   (injected fetch) + CLI parseArgs spec.
3. **Stale cache** — cache holds only an older version; deploy fetches the hub's version, the
   old file survives until `--prune`. Unit.
4. **Unsupported target** — windows-arm64 ⇒ `UNSUPPORTED_TARGET`, zero network calls. Pure unit.
5. **Private/offline** — injected 403 ⇒ `PRIVATE_OR_FORBIDDEN` message contains URL + cache
   path + rename; cache contains no partial file. Unit.
6. **Checksum mismatch** — injected corrupted body ⇒ `CHECKSUM_MISMATCH`, temp removed. Unit.
7. **Legacy tag fallback** — `--version 0.3.4` ⇒ unversioned asset name fetched, cached
   versioned, warning for missing sums; `--version 0.4.1` with missing sums ⇒
   `CHECKSUM_MISSING`. Unit.
8. **Old remote agent (no deploy this session)** — HELLO with an older `agentVersion` under a
   newer hub ⇒ warning logged, session proceeds; same mismatch right after an in-session
   deploy ⇒ `AGENT_VERSION_MISMATCH` abort. Seam: `agent-connection-manager.spec.ts` (where
   the HELLO handler and today's warn-only check live), using the existing UDS
   `net.createServer` harness pattern — NOT a full ssh2.Server stack.
9. **Source run (dev)** — `detectSea()` false ⇒ deployer never fetches regardless of
   `HUB_VERSION`; existing error unchanged. Unit (injected sea-detector).
10. **Concurrent double-fetch** — two parallel `fetchAgentBinary` calls for the same target:
    both succeed, exactly one final file, no interleaved corruption. Unit (real FS, two
    concurrent invocations).

## §5 Implementation blocks (vertical slices)

- **B1** `agent-fetch.ts`: mapping table, version gate, fetch flow (temp/atomic/cap/timeouts),
  SHA256SUMS pure parser, `FetchError` + all codes — with the full unit battery (scenarios
  2-7, 9-10 seams).
- **B2** Deployer integration: versioned lookup, guarded auto-fetch, HELLO version check +
  `AGENT_VERSION_MISMATCH` — deployer spec extended (scenario 1 deploy-half, 8).
- **B3** CLI `agent fetch` (`--all` / `--version` / `--prune`) + parseArgs/cmd specs.
- **B4** release.yml: versioned asset names, version-consistency guard, publish-release
  SHA256SUMS (completeness-checked), exact-name sidecar downloads + rename-at-copy,
  draft-reuse legacy-asset cleanup. actionlint; live proof at the next release.

## §6 Test requirements

Vitest colocated; real FS temp dirs; network ONLY via injected `fetchImpl` (no module mocks —
deps are parameters). SHA256SUMS parser: table-driven pure tests (missing line, duplicates,
CRLF, hex case, path prefixes). Deployer security tests (binary trust) must pass unchanged.
80/80 + no-mock conventions. release.yml: actionlint + next-release live proof.

## §7 Hardening review ledger

Findings from the adversarial pass, all folded into the design above:

| Sev | Finding | Resolution |
|-----|---------|------------|
| S | Same-origin checksum file over-claims authenticity | §2 honesty note; deployer trust gate = the authenticity boundary; HTTPS-only (§3.2.2) |
| S | Missing-checksum tolerance = silent verification downgrade | Semver-gated legacy only; `CHECKSUM_MISSING` hard error ≥0.4.0 (§3.2.6) |
| S | Shared temp filename corrupts concurrent fetches | Unique temp per writer, own-temp verify, last-rename-wins (§3.2.5); scenario 10 |
| S | Dev build `0.0.0` auto-fetches a nonexistent release | §3.0 gate + §3.3 dev guard; scenario 9 |
| S | Cross-runner checksum aggregation left undecided (parallel writers = lost updates) | DECIDED: publish-release computes, completeness-checked, before publish (§3.5.3) |
| M | TOCTOU / symlink / cache-dir permissions unspecified | O_EXCL unique temp, lstat, 0700 dir, verify→chmod→rename order (§3.2.5/7) |
| M | Size cap bypassable via Content-Encoding | Cap on bytes written, mid-stream abort (§3.2.5) |
| M | Unauthenticated GitHub rate limit (60/h/IP) unhandled | `RATE_LIMITED` code + on-disk sums cache (§3.2.4/6) |
| M | Stall timeout / disk-full / proxy behavior unaddressed | Idle+total timeouts, `DISK` code, proxy non-support documented (§3.2.3/5) |
| M | `LASTERM_VERSION` env flows unvalidated into the URL | §3.0 strict semver gate, `BAD_VERSION` |
| M | Hub released while agent asset build failed ⇒ misleading error | `RELEASE_INCOMPLETE` distinct case (§3.2.4) |
| M | Sidecar download glob can match multiple assets | Exact versioned names, exactly-one assertion, rename-at-copy (§3.5.4) |
| M | `--all` partial-failure semantics and error-type home undefined | §3.4 attempt-all + per-target lines; `FetchError` in agent-fetch.ts |
| M | BDD scenarios conflated seams (not unit-testable as written) | §4 re-annotated per seam; mock ssh2 Server named for scenario 8 |
| L | Checksum manifest parser edge cases untested | §6 table-driven pure parser tests |

## §8 External consensus review ledger

Independent second-family review; high agreement with §7. Net-new findings, all folded:

| Sev | Finding | Resolution |
|-----|---------|------------|
| M | Stale unversioned assets survive draft reuse ⇒ silent stale bundling | §3.5.5 legacy-asset deletion on draft reuse |
| M | No build-time guard that tag, package.json and Cargo.toml versions agree | §3.5.2 version-consistency guard |
| S | Checksum manifest parsing rules unspecified | §3.2.6 + §6 (exact basename, duplicates, hex case, path prefixes) |
| S | Tampering indistinguishable from network failure in error taxonomy | Distinct `CHECKSUM_MISMATCH` code (§3.2) |
| L | Signed attestations as the real long-term trust anchor | Out of scope v1, noted in §1/§2 as tracked follow-up |
