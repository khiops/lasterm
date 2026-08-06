# Issue #92 — GUI Agent Manager — Ideation Brief

> Status: ideation complete (2026-06-16). Decisions taken: manifest-file-only import
> verification, WS streaming fetch progress, all four capabilities in cut 1.
> Next: `/spec #92`.

## Problem statement

**Problem:** Seeding or refreshing the remote-host agent binaries the hub deploys requires
the `lasterm-hub agent fetch` CLI (#77); the cache state is invisible to the GUI-first
desktop client. Air-gapped transfers have no home in the UI.

**Root cause:** #77 shipped the engine but no addressable *agent-cache-state* API — cache
status is an ephemeral side-effect computed inline by the CLI/deployer. The panel's backbone
is therefore a new **status/inventory endpoint**; its trust boundary is the **import-verify**
path.

**Target users:** desktop-client operators provisioning remote SSH hosts (incl. air-gapped
fleets) without touching a terminal.

**Current alternative:** the CLI (`agent fetch [--all] [--version] [--prune]`) — functional
but non-discoverable and absent from the GUI.

## Proposed solution

A **Settings → Agents** panel (new category in `CategoryNav.vue` + `AgentManagerCategory.vue`)
backed by a thin `registerAgentRoutes()` REST surface over the existing #77 module, with fetch
progress streamed over the existing `/ws` channel. The backend logic (`fetchAgentBinary`,
`parseChecksumManifest`, `pruneAgentBinaryCache`, cache hardening) is reused unchanged except
for one additive observer callback.

**Why this approach:** the backend is done and the GUI already has every required pattern
(Settings category registry, `FormData`+`Bearer` multipart upload via FontPicker/SshKeyPicker/
Wallpaper, `useFileDrop`, toast store, `hubBaseUrl()`). The only net-new pieces are the REST
routes, the Vue panel, the desktop native picker, and a progress callback.

## Key features (all in cut 1)

### 1. List + status — *the backbone*
- `GET /api/agents/targets` → enumerate built targets from `AGENT_TARGET_TRIPLES`
  (`linux-x64`, `linux-arm64`, `windows-x64`) with per-target status `cached(+version)` /
  `missing` / `stale`.
- **New helper** (does not exist today): compute status = cache-contents vs **hub version**
  (`HUB_VERSION`). `stale` ⇔ cached version ≠ hub version.
- **Out of scope (explicit):** remote-agent version detection. Panel status is *cache vs hub
  version only* — no SSH round-trip.

### 2. Fetch (with WS streaming progress)
- `POST /api/agents/fetch` `{ os, arch, version? }` (and a client-side "fetch all built
  targets" that issues one job per target) → returns `{ job_id }` immediately.
- **Backend change (surgical, additive):** add an optional `onProgress` observer callback to
  `fetchAgentBinary` — the chunked read loop already tracks bytes; emit
  `{ downloaded, total?, phase: "download" | "verify" }`. **No control-flow change** — the
  64 MiB cap, idle-timeout, and *cache-manifest-only-after-verify* ordering stay byte-identical.
- **New WS message types** (snake_case on wire): `agent_fetch_progress
  { job_id, os, arch, downloaded, total, phase }`, `agent_fetch_done { job_id, path }`,
  `agent_fetch_error { job_id, code, message }`. Panel renders a real progress bar; terminal
  error surfaces the existing actionable `FetchError` message verbatim.
- Reuses the `agent-verify.ts` store's WS-routing pattern for correlation by `job_id`.

### 3. Prune
- `POST /api/agents/prune` `{ version? }` (default = hub version) → `{ removed }`. Direct
  wrapper over `pruneAgentBinaryCache`. Cheap once List exists.

### 4. Import (air-gapped) — **manifest-file-only verification**
- `POST /api/agents/import` — **multipart**, two files: the **binary** + the official
  **`SHA256SUMS-<version>.txt`**, plus form fields `os`, `arch`, `version`.
- Hub flow = the *exact* fetch-path verification, reused: resolve target →
  `parseChecksumManifest(manifest, expectedBasename)` where
  `expectedBasename = lasterm-agent-{triple}-{version}{ext}` → compute SHA256 of the uploaded
  binary → match → atomic move into the secure cache with `chmod 755`. Reject with the existing
  `CHECKSUM_MISMATCH` / `CHECKSUM_MISSING` codes; the binary **never touches the cache** unless
  verified.
- **Transport decision:** one multipart endpoint for *both* web and desktop. Desktop uses the
  Tauri native picker (`@tauri-apps/plugin-dialog`, new) to choose paths, then reads + POSTs
  multipart — **deliberately not** a path-based "hub reads this local file" endpoint, which
  would hand the authenticated API an arbitrary-local-file-read primitive. Web uses the
  established `<input type=file>` + `useFileDrop` pattern.

## Technical considerations

**Constraints / conventions to honor:**
- All `/api/agents/*` behind `Bearer` auth (daemon mode), like every other `/api` route.
- `@fastify/multipart` already registered (fonts/ssh-keys/wallpapers use it) — import rides the
  same registration; enforce the server-side size cap mirroring the 64 MiB `TOO_LARGE` semantics.
- Wire = snake_case (MessagePack), TS = camelCase; convert at the boundary.
- Panel styling via `--nt-*` CSS vars + `<script setup>` + Pinia; new `useAgentManagerStore()`
  mirrors `settings.ts`'s fetch/auth pattern.

**Suggested file surface** (for `/spec` to refine):
- Hub: `packages/hub/src/api/agents.ts` (routes), status helper near `agent-deployer.ts`,
  `onProgress` param in `agent-fetch.ts`, WS message types in shared.
- Web: `stores/agent-manager.ts`,
  `components/settings/categories/AgentManagerCategory.vue`, an import modal reusing
  `useFileDrop`, `CategoryNav.vue` + `SettingsPanel.vue` wiring.
- Desktop: `agent-picker.ts` (Tauri dialog bridge).

## Risks

| Risk | Mitigation |
|------|------------|
| WS progress couples #92 into the **hardened** fetch module; could regress the cap / idle-timeout / verify ordering | `onProgress` is a pure observer — no branch on its return; cover with existing fetch tests + one new progress-emission test asserting unchanged terminal behavior |
| Import places an **executable into the trusted cache** (bypasses remote TOFU by design) | Route calls the *same* verify+place helper the fetch path uses; test: a mismatched binary is rejected and is *never* present in the cache dir afterward; reject symlinks, require `isCacheDirSecure` |
| Path-based desktop import would expose an arbitrary-local-file-read API primitive | Chosen design is multipart-only for both clients — no "read this path" endpoint |
| 64 MiB binary upload through the browser | Server-side multipart size cap reusing `TOO_LARGE`; client-side pre-check before POST |
| Scope creep into remote-agent-version detection | Explicitly excluded — status is cache-vs-hub-version only |

## Next steps
→ `/spec #92` to turn this into BDD scenarios + a block plan (the import-verify reject path and
the progress-callback non-regression are the two scenarios that most need executable specs).
