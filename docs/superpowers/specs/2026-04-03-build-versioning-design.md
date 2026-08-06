---
doc-meta:
  status: draft
  scope: all
  type: specification
  story_id: BUILD-VERSION
---

# BUILD-VERSION: Build Versioning & About Modal

## Context

lasterm uses unified versioning (single version across all monorepo packages, bumped by Release Please). The CI already injects `LASTERM_BUILD_HASH` (7-char git SHA) into hub and web builds. However:

- `/api/health` returns only `{ status, build }` — no version
- No version/build display in the UI
- Agent HELLO doesn't report its Cargo version for hub↔agent compatibility checks

## Decision: Unified Versioning

All packages share one version number. Rationale:
- Packages are tightly coupled by MessagePack protocol
- `shared` has no external consumers
- `web` is embedded in hub
- Agent is deployed alongside hub — version mismatch = protocol risk
- Release Please already configured as single component

## Bloc 1: API & Protocol Versioning

### 1a. `/api/health` enriched

Current:
```json
{ "status": "ok", "build": "abc1234" }
```

Target:
```json
{ "status": "ok", "version": "0.1.0", "build": "abc1234" }
```

Implementation:
- Read version from `package.json` at build time (esbuild `define` or static import)
- Expose as `HUB_VERSION` constant alongside existing `BUILD_HASH`
- No new dependencies

### 1b. Agent version in HELLO

Current HELLO payload (Rust agent):
```rust
HelloPayload { os, arch, shells, ... }
```

Target: add `version` field (from `Cargo.toml` via `env!("CARGO_PKG_VERSION")`).

Hub can log version mismatch warnings (non-blocking — just a log line).

### 1c. Shared version constant

Add `VERSION` export to `@lasterm/shared` so both hub and web can import it.
Source: read from root `package.json` at build time.

## Bloc 2: About Modal

### Content

| Field | Source |
|-------|--------|
| Version | `VERSION` from shared |
| Build | `BUILD_HASH` (7-char SHA) |
| Website | https://o2csi.com |
| Repository | https://github.com/khiops/lasterm |
| Issues | https://github.com/khiops/lasterm/issues |
| License | MIT (from package.json) |

### UI

- Modal triggered from settings panel (bottom section) or sidebar footer
- Clean, minimal layout — logo/name at top, fields below
- Copy-to-clipboard on version+build line (for bug reports)
- Links open in new tab (web) or system browser (desktop/Tauri)

### Access Points

1. Settings panel → "About" section at bottom
2. Optional: sidebar footer with version text (clickable → opens modal)

## Files to Modify

### Bloc 1
- `packages/shared/src/version.ts` — new, exports VERSION + BUILD_HASH
- `packages/hub/src/build-version.ts` — import VERSION from shared, add to health
- `packages/hub/src/server.ts` — return version in /api/health
- `crates/lasterm-agent/src/protocol.rs` — add version to HelloPayload
- `crates/lasterm-agent/src/handler.rs` — include version in HELLO
- `packages/hub/src/agents/base-agent.ts` — log agent version from HELLO

### Bloc 2
- `packages/clients/web/src/components/AboutModal.vue` — new component
- `packages/clients/web/src/components/settings/GeneralSection.vue` — About button
- `packages/clients/web/src/components/SidebarFooter.vue` — version text (if sidebar footer exists)

## Out of Scope

- Version negotiation / protocol version handshake (future)
- Auto-update notifications
- Changelog display in About modal
- Title bar version display (user preference: About modal instead)

## Exit Criteria

- `/api/health` returns `version` field matching package.json
- Agent HELLO includes Cargo version
- Hub logs warning if agent version != hub version
- About modal displays version, build, URLs, license
- About modal accessible from settings panel
- All existing tests pass + new tests for version fields
