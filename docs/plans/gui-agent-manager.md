---
doc-meta:
  status: draft
  scope: hub+web
  type: specification
  target_project: /mnt/disk/dev/lasterm/lasterm
  created: 2026-06-16
  updated: 2026-06-17
  complexity: COMPLEX
  time-budget: 14h
  issue: 92
  brief: docs/briefs/issue-92-gui-agent-manager.md
  adversarial_applied: true
  llm_validated: codex-xhigh
---

# Specification: GUI Agent Manager (list / fetch / prune / import)

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | hub + web (+ desktop picker, + a version-read in the agent crate, + a #77 cache-API extraction, + mirror CLI commands) |
| Complexity | COMPLEX |
| Time budget | ~14h |
| Implementation slices | 5 |
| BDD scenarios | 29 |
| Risk level | MEDIUM-HIGH (import places an executable into a deploy-trusted cache; verification is integrity, **not** provenance) |
| Data migration | None (on-disk cache only) |

## Prior-art check (Gate 5)
- `@tauri-apps/plugin-dialog`: ⚠️ no dedicated prior-art entry — not required. Sibling of the adopted Tauri v2 family (`@tauri-apps/api` `^2`, `plugin-shell` `^2.2.1`, `plugin-updater` `^2`). Only `open()` + `app.getVersion()`. Pin to `^2`.
- All other surfaces reuse the existing stack — Fastify + `@fastify/multipart`, MessagePack `/ws`, Vue 3 + Pinia. No new external dependency.

## 1. Problem Statement

Seeding/refreshing the remote-host agent binaries the hub deploys requires the `lasterm-hub agent fetch` CLI (#77); the cache state is invisible in the GUI-first desktop client, and air-gapped transfers have no GUI home. #77 shipped the engine but no addressable agent-cache-state API. This spec adds a thin REST + WS surface over the existing module, a Settings → Agents panel, and a desktop/hub/agent version diagnostic.

## 2. User Stories

```
AS A desktop operator provisioning remote SSH hosts
I WANT to see which agent targets are cached / missing / stale / unsupported in the GUI,
       and my own platform's bundled agent with its version
SO THAT I know what will actually deploy without dropping to the CLI, and I can confirm my install is intact
ACCEPTANCE: the panel lists all six os/arch targets with a status badge that reflects deploy-trust, plus a version
```

```
AS A desktop operator
I WANT to fetch (or fetch-all) agent binaries with visible progress and prune stale ones from the panel
SO THAT I can pre-populate the cache before connecting, and reclaim space
ACCEPTANCE: a fetch shows live progress, surfaces the actionable FetchError on failure (routing me to import, not manual placement), and prune reports how many entries it removed
```

```
AS AN operator of an air-gapped hub
I WANT to import a manually-transferred agent binary that is integrity-verified against its official SHA256SUMS, with an explicit provenance attestation, before it enters the trusted cache
SO THAT I get at least integrity verification (which the existing manual CLI placement does not give) without the GUI pretending this proves authenticity
ACCEPTANCE: import with a matching SHA256SUMS + attestation succeeds; mismatch/forged/oversized is rejected and the binary never lands in the cache; the UI states plainly integrity ≠ provenance
```

```
AS AN operator
I WANT the panel to show the desktop / hub / agent version triplet and flag a mismatch
SO THAT I can detect a broken or partially-updated install at a glance
ACCEPTANCE: the panel reads hub version (REST), bundled-agent version (--version), desktop version (Tauri), warns on disagreement, points to the update path (#94) — diagnostic only
```

## 3. Business Rules

### 3.1 Invariants
- INV-01: An imported binary is placed in the cache ONLY after its computed SHA256 matches the entry for `lasterm-agent-<triple>-<version><ext>` in the supplied `SHA256SUMS-<version>.txt`.
- INV-02: Every cache write requires `isCacheDirSecure(cacheDir)` (0700, user-owned, non-symlink); an insecure cache dir fails the write closed.
- INV-03: Remote-target status is computed as cache-contents-vs-hub-version ONLY — no remote SSH round-trip, no remote-host agent version detection.
- INV-04: Only built targets (`AGENT_TARGET_TRIPLES` with a non-null triple → `linux-x64`, `linux-arm64`, `windows-x64`) are fetchable/importable. Non-built targets are read-only and reject with `UNSUPPORTED_TARGET`. The hub's OWN platform target rejects fetch/import/prune with `BUNDLED_TARGET` (it is served by the bundled agent, never the cache).
- INV-05: All `/api/agents/*` routes require valid `Bearer` auth **unconditionally** (not only in daemon mode). In addition, mutation routes (`fetch`/`prune`/`import`) reject browser requests whose `Origin`/`Host` is not in the approved set at the route level — defense-in-depth against DNS-rebinding/CSRF that does not rely on global CORS config staying strict. The token is never available cross-origin.
- INV-06: A placed binary is `chmod 755` and written via atomic temp→final move (reuse of the fetch-path placement).
- INV-07: The hub's OWN platform target shows status `bundled` — presence via `resolveAgentBinaryPath`, version via `lasterm-agent --version`. Absent binary → `error`; present but version unreadable → `error` ("version unreadable").
- INV-08: Per-target status ∈ `{ bundled, error, cached, stale, missing, untrusted, unsupported }`, derived per §4.5.
- INV-09 (network-agnostic): the panel addresses the hub via `hubBaseUrl()` and assumes nothing about the bind address — loopback, SSH tunnel, or future hardened non-local interface behave identically. The current loopback-only bind is an existing-state constraint; hardened non-local exposure is a separate track (§10, #96).
- INV-10 (canonical version validation): a single exported `validateAgentVersion()` — strict semver AND rejecting the `0.0.0` fallback (matching the backend) — is reused by fetch/import/prune/status. Untrusted `os`/`arch` validate via `resolveTarget` (the whitelist) BEFORE any cache path is constructed (anti path-traversal).
- INV-11 (multipart bounds): import accepts EXACTLY two file parts (`binary` ≤ 64 MiB, `manifest` ≤ 1 MiB) plus the named fields, with explicit caps on field count, field size, total parts, and total body size; the binary is streamed to a temp file (never fully buffered); slow-upload/abort/client-disconnect unlink the temp file; surplus/missing parts reject.
- INV-12 (concurrency — atomic placement, in-process dedup, cross-process safety): the **hub and a concurrently-run CLI share one cache** (`getBinaryCacheDir()` is user/machine-level), so concurrency is cross-process, not just in-process. The module's atomic temp→final move guarantees **no corruption across processes**. Fetch job dedup (one in-flight per target; a duplicate returns the running `job_id` + snapshot) and the global concurrency cap are in-process (hub). The "import does not overwrite a trusted current binary without `force`" rule (ERR-07) is a check-before-rename: authoritative in-process, best-effort across processes (a narrow CLI-vs-hub TOCTOU window, acceptable for a single-user local cache; a strict inter-process lockfile is optional hardening, deferred). `GET /api/agents/targets` is the AUTHORITATIVE cache state; `agent_fetch_*` WS messages are best-effort progress (broadcast, correlated by `job_id`; unknown job_ids ignored, reconcile via `/targets`, e.g. after reconnect).
- INV-13 (no duplication): the route layer reuses the extracted cache-API helpers and named constants (§Slice 1); it never re-defines size caps, timeouts, target resolution, manifest parsing, placement, or prune.
- INV-14 (attestation is friction, not a boundary): the import route requires an explicit `attested: true`; the UI requires the operator to confirm trusted-source provenance before POST. This is **audit/UX friction with zero cryptographic value** — a caller with the Bearer token, GUI XSS, or a mistaken operator can still submit a self-consistent malicious pair. It makes the operator-verified model explicit, nothing more (§4.7).
- INV-15 (status reflects deploy-trust): a cache entry is counted toward `cached`/`stale` ONLY if it passes the deployer's own checks (`isCacheDirSecure` + `isTrustedCacheBinary` — regular file, correct owner, non-symlink). A present-but-untrusted entry (symlink/dir/wrong-owner) is status `untrusted`, never `cached`. The panel must not report deployable when the deployer would reject.
- INV-16 (deterministic semver selection): when multiple trusted versions exist for one target, the current (== hub version) wins → `cached`; otherwise the newest by NUMERIC semver comparison → `stale` (e.g. `2.10.0` > `2.9.0`). Never string ordering.

### 3.2 Preconditions
- PRE-01: Fetch requires outbound connectivity to GitHub Releases. No connectivity → terminal `agent_fetch_error` whose UI copy routes to import (not manual placement).
- PRE-02: Import requires BOTH files, the `os`/`arch`/`version` fields, and `attested: true`.

### 3.3 Effects
- EFF-01: Successful fetch/import places a verified binary at `lasterm-agent-<os>-<arch>-<version><ext>` (under the placement lock).
- EFF-02: Prune removes all `lasterm-agent-*` entries whose version ≠ the requested version (default = hub version, validated) and returns the count.
- EFF-03: Fetch emits `agent_fetch_progress` over `/ws` keyed by `job_id`, terminating with `agent_fetch_done` or `agent_fetch_error`; an already-current target returns `200 { status: "already_cached" }` with no job.

### 3.4 Error Handling
- ERR-01: Import SHA256 ≠ manifest entry → 422 `CHECKSUM_MISMATCH`; not placed.
- ERR-02: Manifest lacks the expected basename entry → 422 `CHECKSUM_MISSING`.
- ERR-03: Unsupported/non-built target → 400 `UNSUPPORTED_TARGET`; the hub's own platform → 400 `BUNDLED_TARGET`; malformed version (incl. `0.0.0`) → 400 `BAD_VERSION`. All before any path is built / network call.
- ERR-04: Missing/invalid `Bearer` → 401; disallowed `Origin`/`Host` on a mutation route → 403; import without `attested: true` → 400.
- ERR-05: Body over the 64 MiB cap, or surplus/missing multipart parts → 413/400; temp file unlinked.
- ERR-06: Insecure cache dir → 409 `INSECURE_CACHE_DIR` (operator-fixable policy failure, distinct from a real I/O error which stays `DISK`/500); fail-closed, nothing placed.
- ERR-07: Import targeting an existing trusted current binary without `force` → 409 `ALREADY_CURRENT` (no silent overwrite of a fetch-verified binary).

## 4. Technical Design

### 4.1 Architecture Decision
Thin REST + WS surface over the #77 module, with a small **extracted, exported cache API** (Slice 1) because the needed helpers (`resolveTarget`, version validation, manifest parse, temp-verify-place, `pruneAgentBinaryCache`, size/timeout constants) are currently private to `agent-fetch.ts` or local to `cli.ts`. New backend pieces: `computeTargetStatus()` (deploy-trust-aware, §4.5), the additive `onProgress` observer in `fetchAgentBinary`, the placement lock (INV-12), and the import route.

**Import — ship now, operator-verified.** Manifest-only verification reuses the exact fetch-path verifier. The import is shipped in cut 1 because it is strictly better than the manual CLI placement that already exists (SPEC §3.5 "manually placed = operator-verified", which verifies nothing): the GUI adds integrity verification + an explicit attestation. Full provenance (signed `SHA256SUMS`) is tracked in #96/#86 (§4.7, §10).

**Import transport — multipart, both clients.** One `POST /api/agents/import` (multipart). Web: `<input type=file>` + `useFileDrop`. Desktop: Tauri `open()` → reads → multipart. No path-based endpoint (arbitrary-local-file-read + breaks across an SSH tunnel).

**Scope boundary — diagnose, do not update** (§10).

**CLI parity.** The cache API (Slice 1) is consumed by BOTH the hub routes and the CLI. On top of the existing `agent fetch [--all] [--version] [--prune]`, the CLI gains `agent status` (mirror of `computeTargetStatus`) and `agent import` (mirror of `verifyAndPlace`, requiring an explicit `--attest`), so a headless hub (§5 row E, no GUI) gets the same verified import + deploy-trust status the panel offers. Both surfaces call the same shared functions — no CLI⇄GUI divergence in trust-critical logic. **The CLI calls the shared library IN-PROCESS (direct, exactly like today's `agent fetch`); it does NOT go through the REST API and does NOT require a running hub daemon or auth.** REST/WS (hub) and the CLI are two adapters over the one `agent-cache` library. The `onProgress` observer serves both: the hub feeds it to `agent_fetch_progress` (WS), the CLI renders it as a terminal progress bar. A CLI write while the hub runs is the cross-process case INV-12 already covers.

### 4.2 Data Model Changes
| Entity | Change | Migration |
|--------|--------|-----------|
| (none) | On-disk binary cache only | No |

### 4.3 API Contract
| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/agents/targets` | GET | — (Bearer) | `200 { hub_version, targets: [{ os, arch, triple, status, version?, expected_version, size?, mtime? }] }` |
| `/api/agents/fetch` | POST | `{ os, arch, version? }` (Bearer, Origin-checked) | `202 { job_id, snapshot }` (new/in-flight) \| `200 { status:"already_cached" }` |
| `/api/agents/prune` | POST | `{ version? }` (Bearer, Origin-checked) | `200 { removed }` |
| `/api/agents/import` | POST | multipart: `binary`, `manifest`, fields `os`,`arch`,`version`,`attested`,`force?` (Bearer, Origin-checked) | `200 { path, version, verified:true }` \| `4xx { code, message }` |

A duplicate fetch for an in-flight target returns the running `job_id` + `snapshot` (current phase/bytes) so a late/reconnecting client can resync without a separate jobs endpoint (a full `GET /api/agents/jobs` is deferred, §10). WS messages (snake_case wire): `agent_fetch_progress { job_id, os, arch, downloaded, total, phase }`, `agent_fetch_done { job_id, path }`, `agent_fetch_error { job_id, code, message }`.

### 4.4 Data Flow
```
 panel ─ GET /targets ─▶ computeTargetStatus() ─▶ scan cacheDir × AGENT_TARGET_TRIPLES, keep deploy-trusted only
       ◀ 200 {hub_version, targets[]} ◀──────────  + resolveAgentBinaryPath + memoized(success) `agent --version`
 panel ─ POST /fetch ──▶ [placement lock; dedup/target] startJob ─▶ fetchAgentBinary({onProgress})
       ◀ 202 {job_id,snapshot} | 200 already_cached      │ chunk bytes (download→verify)
   /ws ◀ agent_fetch_progress|done|error  (best-effort; /targets authoritative)
 panel ─ POST /import (multipart,attested) ─▶ validate(resolveTarget+validateAgentVersion) ─▶ [lock] verifyAndPlace
       ◀ 200 {path} | 4xx {code}
```

### 4.5 Target status model
```
if T == hostPlatform(hub):
    resolveAgentBinaryPath() found? (versionReader ok? "bundled"(version) : "error"/unreadable) : "error"
else remote:
    triple == null → "unsupported"
    else built:
        entries = cache files matching lasterm-agent-<os>-<arch>-*, kept ONLY if isCacheDirSecure(dir) && isTrustedCacheBinary(file)
        a matching name that exists but fails the trust check → "untrusted"
        trusted entries: validateAgentVersion each; current(==hub) → "cached"; else newest-by-numeric-semver → "stale"; none → "missing"
```
`bundled` derives from *T == hub platform AND co-located binary present*, independent of the `built` flag. Exactly one `bundled`/`error` row; the rest `cached`/`stale`/`missing`/`untrusted`/`unsupported`.

### 4.6 Version triplet diagnostic
Surfaces **hub** (`/api/health` / `targets.hub_version`), **bundled agent** (`lasterm-agent --version`, clap, memoized on SUCCESS only — failures stay retryable), **desktop** (Tauri `app.getVersion()`; N/A in the browser PWA). A mismatch raises a non-blocking warning pointing to the update path (#94). Diagnostic only.

### 4.7 Import trust model — integrity vs provenance (honest)
Manifest-only verification proves the uploaded binary is **intact** (matches the operator-supplied SHA256SUMS); it does **not** prove **provenance** — the binary and its manifest share one operator-controlled channel, so a self-consistent *(malicious binary + matching SHA256SUMS)* pair passes, and a stolen Bearer token or GUI XSS is a residual vector. The fetch path avoids this because its manifest comes from GitHub Releases over HTTPS. Import deliberately accepts the weaker **operator-verified** model of SPEC §3.5.

Decision (operator-confirmed): **ship the import in cut 1.** Rationale: it is strictly safer than the manual CLI placement that already exists (which verifies nothing), it adds integrity + an explicit attestation, and the UI states plainly that this is integrity, not authenticity. The same verified path is now offered in the CLI as `agent import` (§4.1), so a raw unverified `mv` is no longer the only CLI option. The attestation (`attested: true`, INV-14) is audit/UX friction with no cryptographic value. Full provenance closure = **signing the `SHA256SUMS`** (minisign/cosign/GPG + a hub-shipped public key, the same capability as the updater key) — tracked in #96 (with #86), deferred out of #92 (§10).

## 5. Usage Scenarios & Combinatorial Coverage

Bounding invariants: GUI ⇒ local hub (INV-09); CLI ≡ GUI on the same cache (only import differs — the CLI alternative is unverified manual placement); the hub platform is bundled, never cached; only 3 built targets are fetchable; status reflects deploy-trust (INV-15).

| Group | Scenario | Surface | Path | BDD |
|-------|----------|---------|------|-----|
| A local | hub-platform bundled agent | bundled | `bundled`/`error` | SC-15, SC-19 |
| A | fetch/import/prune the hub platform | GUI | 400 `BUNDLED_TARGET` | SC-24 |
| B online | missing remote built → fetch | CLI/GUI | `missing`→fetch | SC-05 |
| B | already current → no-op | CLI/GUI | `200 already_cached` | SC-17 |
| B | concurrent duplicate fetch | GUI | single job + snapshot | SC-20 |
| B | stale (incl. 2.10 vs 2.9 selection) → fetch+prune | CLI/GUI | numeric semver | SC-03/SC-26/SC-08 |
| B | non-built fetch | CLI/GUI | `UNSUPPORTED_TARGET` | SC-06 |
| B | fetch fails | CLI/GUI | FetchError → import (not manual) | SC-07 |
| B | present-but-untrusted cache entry | — | `untrusted`, not `cached` | SC-23 |
| C air-gap | import + matching SHA256SUMS + attestation | GUI | verified, placed | SC-10 |
| C | mismatch/missing-entry/oversized/insecure-dir/bad-target-version/no-attestation/overwrite-current | GUI | rejected, never cached | SC-11/12/13/14/18/22/27 |
| C | manual CLI placement | CLI | unverified (GUI import improves on it) | — |
| D deploy | upload-from-cache / AGENT_NOT_AVAILABLE / TOFU | session | — | out of scope |
| E surface | headless hub: status + verified import in CLI | CLI | parity via the shared API | SC-28/SC-29 |
| auth | unauth / disallowed Origin | — | 401 / 403 | SC-21/SC-25 |
| triplet | desktop/hub/agent mismatch | GUI | diagnostic only | SC-16 |

## 6. Acceptance Criteria (BDD)

### List + status + version
```gherkin
@priority:high @type:nominal
Scenario: SC-01 Targets endpoint reports accurate per-target status
  Given the cache holds a trusted lasterm-agent-linux-arm64-<hubVersion> and the hub platform is linux-x64
  When an authorized client GETs /api/agents/targets
  Then linux-x64 is "bundled", linux-arm64 "cached", windows-x64 "missing", darwin-* and windows-arm64 "unsupported"
```
```gherkin
@priority:medium @type:edge
Scenario: SC-02 Empty cache lists built remote targets as missing
  Given an empty secure cache dir and hub platform linux-x64
  Then linux-arm64 and windows-x64 are "missing" and linux-x64 is "bundled"
```
```gherkin
@priority:medium @type:edge
Scenario: SC-03 Older cached version is reported stale
  Given a trusted lasterm-agent-windows-x64-<olderVersion> and hub version <hubVersion>
  Then windows-x64 is "stale" with version=<olderVersion>, expected_version=<hubVersion>
```
```gherkin
@priority:high @type:security
Scenario: SC-04 Unauthorized status request is rejected
  Given no valid Bearer token
  Then GET /api/agents/targets responds 401 and discloses no cache contents
```
```gherkin
@priority:high @type:security
Scenario: SC-23 A present-but-untrusted cache entry is not reported as cached
  Given a lasterm-agent-linux-arm64-<hubVersion> that is a symlink (or wrong-owner / not a regular file)
  When an authorized client GETs /api/agents/targets
  Then linux-arm64 status is "untrusted" (never "cached"), matching what the deployer would reject
```
```gherkin
@priority:medium @type:edge
Scenario: SC-26 Stale selection uses numeric semver, not string order
  Given trusted lasterm-agent-linux-arm64-2.9.0 and -2.10.0, neither equal to hub version
  Then linux-arm64 is "stale" with version=2.10.0 (numeric semver, not "2.9.0" by string order)
```
```gherkin
@priority:high @type:nominal
Scenario: SC-15 The hub platform shows bundled with its version
  Given hub platform linux-x64 with a co-located agent that reports a version
  Then linux-x64 is "bundled" with version from `lasterm-agent --version`
```
```gherkin
@priority:high @type:edge
Scenario: SC-19 Bundled binary absent or version unreadable is an error
  Given the co-located agent is absent, or present but `--version` fails/times out
  Then linux-x64 status is "error" (with a "version unreadable" note in the present-but-unreadable case)
```
```gherkin
@priority:medium @type:nominal
Scenario: SC-16 Version-triplet mismatch is flagged, no update triggered
  Given hub reports <hubVersion> and the bundled agent a different version
  Then the panel shows a non-blocking mismatch warning pointing to the update path and offers no update action
```

### Fetch + prune
```gherkin
@priority:high @type:nominal
Scenario: SC-05 Fetch streams progress and caches the binary
  Given linux-arm64 missing and an injected fetchImpl serving the asset + SHA256SUMS
  When an authorized client POSTs /api/agents/fetch {os:"linux",arch:"arm64"}
  Then 202 { job_id, snapshot }, ≥1 agent_fetch_progress, a terminal agent_fetch_done, and /targets later shows "cached"
```
```gherkin
@priority:high @type:error
Scenario: SC-06 Fetch of an unsupported target is rejected before any network call
  When POST /api/agents/fetch {os:"darwin",arch:"arm64"}
  Then 400 UNSUPPORTED_TARGET, no outbound fetch
```
```gherkin
@priority:high @type:error
Scenario: SC-07 Fetch failure surfaces FetchError and routes to import, not manual placement
  Given an injected fetchImpl simulating no connectivity
  Then a terminal agent_fetch_error carries the verbatim NETWORK message
  And the panel routes the operator to the verified import flow (it does not surface manual chmod/rename/place instructions as the action)
```
```gherkin
@priority:medium @type:nominal
Scenario: SC-08 Prune removes non-current versions and keeps the current one
  Given trusted lasterm-agent-linux-arm64-<old> and -<hubVersion>
  Then POST /api/agents/prune {} returns { removed: 1 } and only the <hubVersion> entry remains
```
```gherkin
@priority:medium @type:nominal
Scenario: SC-17 Fetch of an already-current target is a no-op
  Given a trusted lasterm-agent-linux-arm64-<hubVersion>
  When POST /api/agents/fetch {os:"linux",arch:"arm64"}
  Then 200 { status:"already_cached" }, no download, no job
```
```gherkin
@priority:high @type:edge
Scenario: SC-20 Concurrent duplicate fetches collapse to one job
  Given linux-arm64 missing
  When two authorized clients POST fetch for linux-arm64 nearly simultaneously
  Then only one download runs, exactly one binary is placed, and the second call returns the same job_id + snapshot
```
```gherkin
@priority:high @type:nominal
Scenario: SC-09 onProgress does not alter fetch terminal behavior (non-regression)
  Given a fetch driven once without and once with an onProgress observer, same injected asset
  Then both place a byte-identical binary at the same path; cap, idle-timeout, and checksum-after-verify ordering unchanged
```

### Import (manifest-only + attestation + lock)
```gherkin
@priority:high @type:nominal
Scenario: SC-10 Import with matching SHA256SUMS and attestation is verified and cached
  Given hub platform linux-x64, a windows-x64 v<version> binary, and a matching SHA256SUMS-<version>.txt
  When POST /api/agents/import (binary+manifest, os:windows/arch:x64/version, attested:true)
  Then 200 { verified:true } and the binary is at the canonical cache path, mode 755
```
```gherkin
@priority:high @type:security
Scenario: SC-11 Mismatched-hash import is rejected and never cached
  Given a binary whose SHA256 does not match its SHA256SUMS entry
  Then POST /api/agents/import (attested:true) → 422 CHECKSUM_MISMATCH and no lasterm-agent-* for that target/version exists afterward
```
```gherkin
@priority:high @type:error
Scenario: SC-12 Import whose manifest lacks the expected entry is rejected
  Given a SHA256SUMS-<version>.txt with no line for the expected basename
  Then 422 CHECKSUM_MISSING, nothing placed
```
```gherkin
@priority:medium @type:edge
Scenario: SC-13 Oversized / surplus-part import is rejected and the temp file is cleaned up
  Given a binary part over 64 MiB, or more than the two expected file parts
  Then 413/400, nothing placed, and no orphan temp file remains (binary streamed to temp, never fully buffered)
```
```gherkin
@priority:high @type:security
Scenario: SC-14 Import into an insecure cache dir fails closed with a distinct code
  Given the cache dir is a symlink or has loose permissions that cannot be tightened
  Then 409 INSECURE_CACHE_DIR (not 500 DISK), nothing placed
```
```gherkin
@priority:high @type:security
Scenario: SC-18 Malformed target/version is rejected before any path is built
  Given os/arch outside the whitelist, or version failing validateAgentVersion (incl. "0.0.0" or "../../etc")
  Then 400 (UNSUPPORTED_TARGET/BAD_VERSION), no filesystem path constructed, nothing placed
```
```gherkin
@priority:high @type:security
Scenario: SC-22 Import without an explicit attestation is rejected
  Given a valid binary + matching manifest but attested absent/false
  Then 400, nothing placed
```
```gherkin
@priority:high @type:security
Scenario: SC-27 Import does not silently overwrite a trusted current binary
  Given a trusted lasterm-agent-windows-x64-<hubVersion> already present (e.g. from a verified fetch)
  When an import for windows-x64 <hubVersion> is submitted without force
  Then 409 ALREADY_CURRENT and the existing fetch-verified binary is unchanged
```

### Authorization & isolation
```gherkin
@priority:high @type:security
Scenario: SC-21 Agent routes require auth even without --daemon
  Given a hub started without --daemon
  Then any unauthenticated /api/agents/* call → 401, no cache read or write
```
```gherkin
@priority:high @type:security
Scenario: SC-24 Fetch/import/prune against the hub platform is rejected
  Given hub platform linux-x64
  When a mutation targets os:linux/arch:x64
  Then 400 BUNDLED_TARGET, nothing placed
```
```gherkin
@priority:high @type:security
Scenario: SC-25 Mutation routes reject a disallowed Origin
  Given a browser request to POST /api/agents/import with an Origin not in the approved set (and a no-Origin CLI request)
  Then the browser request → 403 (the no-Origin CLI request, with valid Bearer, is allowed)
```

### CLI parity
```gherkin
@priority:medium @type:nominal
Scenario: SC-28 CLI `agent status` mirrors the panel status
  Given a cache state and hub platform as in SC-01
  When the operator runs `lasterm-hub agent status`
  Then it prints the same per-target statuses computeTargetStatus produces for /api/agents/targets
       (bundled / cached / stale / missing / untrusted / unsupported), via the shared API
```
```gherkin
@priority:high @type:security
Scenario: SC-29 CLI `agent import` verifies like the route
  Given a binary + SHA256SUMS for a remote built target and an explicit --attest
  When the operator runs `lasterm-hub agent import` with a mismatched binary
  Then it reuses verifyAndPlace, fails with the same CHECKSUM_MISMATCH semantics, and places nothing
  And a matching binary with --attest is verified and cached
```

**Coverage matrix:**
| SC | Nominal | Edge | Error | Security |
|----|---------|------|-------|----------|
| 01 | ✓ | | | |
| 02 | | ✓ | | |
| 03 | | ✓ | | |
| 04 | | | | ✓ |
| 05 | ✓ | | | |
| 06 | | | ✓ | |
| 07 | | | ✓ | |
| 08 | ✓ | | | |
| 09 | ✓ | | | |
| 10 | ✓ | | | |
| 11 | | | | ✓ |
| 12 | | | ✓ | |
| 13 | | ✓ | | |
| 14 | | | | ✓ |
| 15 | ✓ | | | |
| 16 | ✓ | | | |
| 17 | ✓ | | | |
| 18 | | | | ✓ |
| 19 | | ✓ | | |
| 20 | | ✓ | | |
| 21 | | | | ✓ |
| 22 | | | | ✓ |
| 23 | | | | ✓ |
| 24 | | | | ✓ |
| 25 | | | | ✓ |
| 26 | | ✓ | | |
| 27 | | | | ✓ |
| 28 | ✓ | | | |
| 29 | | | | ✓ |

## 7. Implementation Plan

Vertical slices, ordered by dependency; later slices reference earlier ones by name.

### Safe cache API extraction (from #77)
**Order:** 1 of 5 · **Complexity:** M · **Depends on:** nothing
Extract and EXPORT from `agent-fetch.ts` / `cli.ts` a small, tested cache API the routes reuse (INV-13): `validateAgentVersion()` (rejects `0.0.0`), `resolveTarget()`, `parseChecksumManifest()`, a `verifyAndPlace(tempPath, expectedBasename, manifest, cacheDir, { force })` carved from the fetch path (atomic, `chmod 755`, `isCacheDirSecure`/`isTrustedCacheBinary`, placement lock), `pruneAgentBinaryCache()` (moved out of `cli.ts`), and the size/timeout constants. CLI keeps using them unchanged.
**Files:** `packages/hub/src/session/agent-fetch.ts`, a new `agent-cache.ts`, `packages/hub/src/cli.ts` (rewire).
**Exit:** existing #77 tests green; the API is importable; no behavior change to the CLI.

### List + status + version triplet + panel skeleton
**Order:** 2 of 5 · **Complexity:** L · **Depends on:** the cache-API slice
**Files:** `packages/hub/src/api/agents.ts` (`registerAgentRoutes` + `GET /targets` + unconditional Bearer + Origin/Host guard, INV-05); `packages/hub/src/session/agent-status.ts` (`computeTargetStatus` per §4.5, deploy-trust filtering INV-15, numeric semver INV-16, injectable+success-memoized `versionReader`); `server.ts` (register); web `stores/agent-manager.ts`; `components/settings/categories/AgentManagerCategory.vue` (table + triplet); `CategoryNav.vue` + `SettingsPanel.vue`; `packages/hub/src/cli.ts` (`agent status` mirroring `computeTargetStatus`).
**Exit:** SC-01..04, SC-15, SC-16, SC-19, SC-21, SC-23, SC-26, SC-28.

### Fetch with WS streaming progress
**Order:** 3 of 5 · **Complexity:** L · **Depends on:** the List+status slice
**Files:** `agent-fetch.ts` (additive `onProgress`); `packages/shared` WS types + `docs/PROTOCOL.md`; `api/agents.ts` (`POST /fetch`: validate INV-10, reject `BUNDLED_TARGET`, dedup + snapshot + global cap INV-12, `200 already_cached` vs `202`); web store + panel (progress, fetch-all bounded, disable-while-in-flight, error→import guidance INV-… SC-07).
**Exit:** SC-05, SC-06, SC-07, SC-09, SC-17, SC-20, SC-24.

### Prune
**Order:** 4 of 5 · **Complexity:** S · **Depends on:** the List+status slice
**Files:** `api/agents.ts` (`POST /prune`, validate version, placement lock); web store + panel (button + confirm + refresh).
**Exit:** SC-08.

### Import (manifest-only verify + attestation + lock)
**Order:** 5 of 5 · **Complexity:** L · **Depends on:** the List+status + cache-API slices; desktop picker depends on the web modal
**Files:** `api/agents.ts` (`POST /import` multipart: bounds INV-11, validate INV-10, `attested` INV-14, `BUNDLED_TARGET` reject, `verifyAndPlace` under lock with `force`/`ALREADY_CURRENT` INV-12, `INSECURE_CACHE_DIR`); web `AgentImportModal.vue` (two-file picker, attestation + integrity-not-provenance copy); desktop `agent-picker.ts` (Tauri `open()` → multipart); `packages/hub/src/cli.ts` (`agent import` reusing `verifyAndPlace`, requiring `--attest`).
**Exit:** SC-10, SC-11, SC-12, SC-13, SC-14, SC-18, SC-22, SC-25, SC-27, SC-29.

## 8. Test Strategy

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~16 | `validateAgentVersion` (incl. `0.0.0`), `computeTargetStatus` (all statuses incl. `untrusted` via a planted symlink, numeric semver via 2.9/2.10), version-triplet mismatch, basename derivation, placement-lock serialization |
| Integration | ~20 | Each route on a real Fastify instance + per-test temp cache dir; stub agent for `--version`; fetch via injected `fetchImpl`; concurrent fetch dedup + snapshot; import reject paths leave cache clean + no orphan temp; `BUNDLED_TARGET`; missing-attestation; `ALREADY_CURRENT`; auth 401 (non-daemon); Origin 403; CLI `agent status`/`agent import` parity with the routes |
| E2E | ~2 | Panel via Chrome DevTools MCP: list+triplet render; import-reject keeps the panel honest |

**No mocks of external systems:** GitHub fetch via the module's `fetchImpl` seam; cache ops on real temp dirs; bundled-row exec uses a real stub binary printing a version.

## 9. Risks & Mitigations

| Risk | Impact | Prob | Mitigation |
|------|--------|------|------------|
| Import accepts a malicious binary with a self-consistent forged SHA256SUMS (integrity ≠ provenance) | H | M | §4.7 honest model + attestation (audit only) + UI copy; still safer than the existing unverified manual placement; provenance closure (signed SHA256SUMS) → #96/#86 |
| GUI panel reports `cached` for an entry the deployer rejects | H | M | INV-15 deploy-trust filtering; status `untrusted`; SC-23 |
| Weak import overwrites a fetch-verified current binary | H | L | INV-12 placement lock + `ALREADY_CURRENT` (no overwrite without force); SC-27 |
| Agent routes unauthenticated / DNS-rebinding | H | L | INV-05 unconditional Bearer + route-level Origin/Host; SC-21/SC-25 |
| Path-traversal / `0.0.0` via form fields | H | L | INV-10 `validateAgentVersion` + `resolveTarget` before any path; SC-18 |
| WS progress change regresses the hardened fetch | H | L | `onProgress` pure observer; SC-09 |
| Concurrent fetch/import/prune race | M | M | INV-12 per-target/version lock; SC-20/SC-27 |
| 64 MiB buffered in memory / orphan temp on abort | M | M | INV-11 stream-to-temp + unlink on every non-success path; SC-13 |
| Reuse of "private" #77 helpers not feasible | M | M | Slice 1 extracts/exports a tested cache API before the routes need it |
| Bundled-row `--version` hangs / pins a transient failure | M | L | Guarded exec + timeout → `error`; memoize SUCCESS only; SC-19 |

## 10. Out of Scope & Follow-ups

- **Update process** (bundled agent / hub SEA / desktop); this panel only diagnoses drift. Tracked: #94.
- **Decouple the bundled agent from the desktop release** (`externalBin` lockstep vs runtime self-update). Tracked: #95.
- **Hub network exposure + OWASP hardening**, plus **provenance-verified import via a signed `SHA256SUMS`** (the real closure of the §4.7 integrity-vs-provenance gap; same signing capability as the updater key #86) and **import rate-limiting / disk-quota**. #92 is already network-agnostic (INV-09). Tracked: #96 (with #86).
- **`GET /api/agents/jobs`** full job registry (the in-flight snapshot in the dedup fetch response covers the cut-1 reconnect need). Deferred.

## 11. Definition of Done

- [ ] All five slices implemented as vertical slices; the cache-API extraction keeps existing #77/CLI tests green.
- [ ] All 29 BDD scenarios have passing tests (unit + integration; 2 e2e).
- [ ] CLI `agent status` + `agent import` (requiring `--attest`) added, mirroring the routes through the shared cache API.
- [ ] All tests pass; biome lint + tsc typecheck clean; Rust unaffected (agent `--version` already present).
- [ ] `docs/PROTOCOL.md` updated with the new WS message types and `/api/agents/*` routes.
- [ ] Pre-PR cross-engine correctness check (codex + copilot) green on the cumulative diff.
- [ ] SPEC.md §3.5 unchanged (manifest-only is a permitted subset); no doc drift.
- [ ] `/review` clean (no blocking findings).
- [ ] Rollback: revert routes + UI + the additive `onProgress` param + the cache-API extraction — no data migration.
