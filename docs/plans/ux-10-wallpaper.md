<!-- doc-meta: { status: canonical, story_id: WALLPAPER, adversarial_applied: true, llm_reviewed: true } -->

# UX-10 — Terminal Wallpaper

## Overview

Configurable background image per terminal pane. Wallpapers cascade through the
existing 4-layer config system: defaults → config.toml → host profile → channel
profile. Upload images to `~/.config/lasterm/wallpapers/`, served by the hub.
Blur and dim controls keep text readable.

## User Stories

- **US-1**: As a user, I upload a wallpaper image and see it behind my terminal text.
- **US-2**: As a user, I set a wallpaper globally and all terminals show it.
- **US-3**: As a user, I override the wallpaper per host (e.g., production = red tint,
  staging = blue tint).
- **US-4**: As a user, I override the wallpaper per channel for a specific session.
- **US-5**: As a user, I adjust blur and dim so terminal text stays readable.
- **US-6**: As a user, I reset a host/channel wallpaper override to inherit from the
  parent scope.

## Technical Design

### 1. Shared Types

Add wallpaper fields to `TerminalProfile` in `packages/shared/src/config.ts`:

```typescript
export interface TerminalProfile {
  // ... existing fields ...
  wallpaper?: string;      // filename relative to wallpapers dir, empty = none
  wallpaperBlur?: number;  // 0-20 (px), default 0
  wallpaperDim?: number;   // 0-100 (%), default 0
}
```

Update `DEFAULT_PROFILE` with `wallpaper: ""`, `wallpaperBlur: 0`, `wallpaperDim: 0`.

Named constants in `packages/shared/src/config.ts`:
```typescript
export const MAX_WALLPAPER_BLUR = 20;      // px
export const MAX_WALLPAPER_SIZE = 10 * 1024 * 1024; // 10 MB
export const WALLPAPER_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
```

These fields cascade automatically through `deepMerge()` in
`ConfigResolver.resolve()` (4-layer cascade: defaults → config.toml → host → channel).

Config.toml section `[terminal]` already supports arbitrary snake_case keys
converted via `snakeToCamel`. New keys: `wallpaper`, `wallpaper_blur`, `wallpaper_dim`.

### 2. Hub — Wallpaper Serving

Same pattern as font serving:

- **Directory**: `~/.config/lasterm/wallpapers/` (created on startup if missing)
- **Static serving**: `@fastify/static` with prefix `/public/wallpapers/`,
  `decorateReply: false`
- **Scan endpoint**: `GET /api/wallpapers` — no auth — returns `{ wallpapers: string[] }`
  (list of filenames)
- **Upload endpoint**: `POST /api/wallpapers` — auth required — multipart/form-data
  (via `@fastify/multipart`), single file field `image`. Validates extension
  (jpg, jpeg, png, webp, gif, avif). Max size 10 MB. Returns `{ filename: string }`.
- **Delete endpoint**: `DELETE /api/wallpapers/:filename` — auth required. Returns
  `{ ok: true }`.

Registration in `server.ts` alongside `registerUserFonts()`.
Auth bypass in `server.ts` hook for `GET /api/wallpapers` (same as `/api/fonts`).

**Dependency**: Add `@fastify/multipart` to hub `package.json` (via `catalog:`).

#### Security hardening

- **Path traversal**: `path.basename(filename)`, reject if contains `..`, `/`, or `\`.
  On DELETE, resolve path and verify it's within the wallpapers directory.
- **Filename encoding**: `encodeURIComponent()` for URL construction in client.
- **MIME sniffing**: rely on @fastify/static content-type detection.
- **Response headers**: `X-Content-Type-Options: nosniff` on static wallpapers route.

### 3. Web — Rendering (per terminal pane)

Layer stack inside `.terminal-pane` (all absolutely positioned):

```
z-index 0: .wallpaper-bg    — background-image, filter: blur(Xpx), will-change: filter
z-index 1: .wallpaper-dim   — background: rgba(0,0,0, dim/100)
z-index 2: .terminal-container — xterm canvas (allowTransparency: true)
z-index 3: .tint-overlay     — existing host visual tint
```

**Composable**: `useWallpaper(profile: Ref<TerminalProfile>)` returns:
- `wallpaperStyle: ComputedRef<CSSProperties | null>` — background-image URL + cover +
  blur filter
- `dimStyle: ComputedRef<CSSProperties | null>` — rgba overlay

When `profile.wallpaper` is empty → both return null → divs hidden via `v-if`.
When wallpaper is set but blur/dim are 0 → dim div hidden, blur filter omitted.

**Cache-busting**: URL includes `?t=<timestamp>` query param (reactive, updated on
upload/change) to prevent browser caching stale images on filename overwrite.

**Deleted wallpaper handling**: if the image URL returns 404, the div has no visible
background (transparent). No error state needed.

The terminal opacity slider (`--nt-terminal-alpha`) controls xterm canvas transparency,
which lets the wallpaper show through. With `allowTransparency: true` already set.

**Performance**: `will-change: filter` on .wallpaper-bg for GPU compositing when
blur > 0. Browser caches same-URL images across multiple terminal panes.

### 4. Web — Settings UI

Add **Wallpaper** section to `AppearanceCategory.vue` (or new `WallpaperCategory.vue`
if the component gets too large):

- **Wallpaper picker**: grid of thumbnails from `GET /api/wallpapers`. Click to select.
  Active = border highlight.
- **Upload button**: file input accepting image/* types. Client-side size check before
  upload. Calls `POST /api/wallpapers`, then refreshes grid.
- **Remove wallpaper**: button to clear wallpaper (sets `wallpaper: ""`).
- **Blur slider**: 0-20 px (SettingControl type="range")
- **Dim slider**: 0-100 % (SettingControl type="range")
- **Scope override**: uses existing `settingsStore.isOverridden()` / `resetSetting()`
  pattern for "Reset to inherited" button.

Writes via `settingsStore.updateSetting(scope, "terminal", "wallpaper", filename)`.

## BDD Scenarios

### SC-1: Upload and apply wallpaper
```
Given no wallpaper is configured
When I upload "mountains.jpg" via POST /api/wallpapers
Then GET /api/wallpapers returns ["mountains.jpg"]
When I set terminal.wallpaper to "mountains.jpg" at global scope
Then TerminalPane shows background-image pointing to /public/wallpapers/mountains.jpg
And the image uses background-size: cover
```

### SC-2: Cascade — host overrides global
```
Given global wallpaper is "mountains.jpg"
And host "prod" has wallpaper override "warning.png"
When I open a terminal for host "prod"
Then TerminalPane shows "warning.png" (not "mountains.jpg")
When I open a terminal for host "dev" (no override)
Then TerminalPane shows "mountains.jpg" (inherited from global)
```

### SC-3: Cascade — channel overrides host
```
Given host "prod" wallpaper is "warning.png"
And channel X on host "prod" has wallpaper override "custom.jpg"
When I view channel X
Then TerminalPane shows "custom.jpg"
When I reset channel X wallpaper override
Then TerminalPane shows "warning.png" (inherited from host)
```

### SC-4: Blur and dim effects
```
Given wallpaper "mountains.jpg" is applied
When I set wallpaperBlur to 10 and wallpaperDim to 40
Then .wallpaper-bg has filter: blur(10px) and will-change: filter
And .wallpaper-dim has background: rgba(0,0,0,0.4)
And terminal text is readable over the dimmed/blurred image
```

### SC-5: No wallpaper = no overlay divs
```
Given wallpaper is "" (empty, default)
Then .wallpaper-bg div is not rendered (v-if="null")
And .wallpaper-dim div is not rendered
And terminal renders normally with no perf impact
```

### SC-6: Upload validation
```
When I upload a file with extension ".exe"
Then the server returns 400 with "Unsupported file type"
When I upload a 15 MB image
Then the server returns 413 with "File too large"
When I upload a valid 2 MB .jpg
Then the server returns 200 with { filename: "image.jpg" }
```

### SC-7: Delete wallpaper file
```
Given "old.jpg" exists in wallpapers dir
When I DELETE /api/wallpapers/old.jpg
Then the file is removed from disk
And GET /api/wallpapers no longer includes "old.jpg"
When any terminal had wallpaper="old.jpg"
Then the wallpaper div shows no image (file 404 = transparent bg)
```

### SC-8: Path traversal prevention
```
When I POST /api/wallpapers with filename "../../etc/passwd"
Then the server sanitizes to "passwd" and rejects (no valid extension)
When I DELETE /api/wallpapers/..%2F..%2Fetc%2Fpasswd
Then the server returns 400 "Invalid filename"
```

### SC-9: Blur/dim without wallpaper
```
Given wallpaper is "" (no wallpaper set)
When wallpaperBlur is 10 and wallpaperDim is 50
Then no wallpaper divs are rendered (blur/dim ignored without image)
```

## Implementation Blocks

### Block 1: Shared types + Hub infrastructure (vertical slice)
- Add wallpaper fields to `TerminalProfile` interface + `DEFAULT_PROFILE`
- Add named constants (`MAX_WALLPAPER_BLUR`, `MAX_WALLPAPER_SIZE`, `WALLPAPER_EXTENSIONS`)
- Add `@fastify/multipart` dependency (hub `package.json` via `catalog:`)
- Update `TERMINAL_PROFILE_KEYS` whitelist (if exists) with wallpaper fields
- Create wallpapers directory on startup (`server.ts`)
- Register `@fastify/static` for `/public/wallpapers/` (with `X-Content-Type-Options: nosniff`)
- Add auth bypass for `GET /api/wallpapers` in server.ts hook
- `GET /api/wallpapers` endpoint (scan dir, return filenames)
- `POST /api/wallpapers` endpoint (multipart upload, validate type+size, sanitize name)
- `DELETE /api/wallpapers/:filename` endpoint (sanitize, verify within dir)
- Tests: upload, scan, delete, validation (type, size, path traversal)
- **Exit**: `pnpm -F @lasterm/hub test` green, endpoints functional

### Block 2: Hub cascade + Web rendering
- Verify wallpaper fields cascade through `resolve()` (they should via deepMerge)
- Add test for wallpaper cascade (global → host override → channel override)
- `useWallpaper` composable (style computation from resolved profile)
- TerminalPane.vue: add wallpaper-bg + wallpaper-dim divs
- CSS: positioning, cover, blur filter (will-change: filter), dim overlay
- Integration with terminal opacity (xterm canvas alpha)
- **Exit**: `pnpm -F @lasterm/hub test` green, wallpaper renders in dev

### Block 3: Settings UI + polish
- Wallpaper section in Settings (picker grid, upload with client-side size check,
  blur/dim sliders)
- Scope-aware: getValue, updateSetting, isOverridden, resetSetting
- "Reset to inherited" button for host/channel scope
- Delete wallpaper button (calls DELETE endpoint)
- **Exit**: full e2e flow (upload → select → blur/dim → scope override → reset)

## Constraints

- Max upload 10 MB (guard in endpoint + client-side check)
- Path traversal: `path.basename()`, reject `..` / `/` / `\`, verify resolved path
  within wallpapers dir
- No auth for GET /api/wallpapers (same as fonts — public assets)
- Auth required for POST/DELETE (modification)
- Filename collision: overwrite existing (no rename)
- Supported formats: jpg, jpeg, png, webp, gif, avif
- `will-change: filter` on wallpaper-bg for GPU compositing
- Blur/dim values ignored when no wallpaper is set
- Named constants for magic numbers (shared package)

## Deferred Items

- Multi-user wallpaper namespacing (single-user today, add when multi-user lands)
- Rate limiting on upload endpoint (will be global, not per-endpoint)
- Magic-number/MIME validation beyond extension check
- Disk quota enforcement for wallpapers directory
- Image bomb detection (pixel dimension limits)
