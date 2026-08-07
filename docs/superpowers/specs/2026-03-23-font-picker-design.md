# Font Picker — Design Spec

## Problem

The font family setting is a plain text input where users must type the exact OpenType family name. This led to a bug where the filename (`FiraCodeNerdFont-Regular`) was saved instead of the family name (`FiraCode Nerd Font`), breaking terminal rendering. Users have no way to discover available fonts, preview them, or upload new ones.

## Solution

Replace the text input with a modal font picker that shows installed fonts with live preview, supports drag & drop upload, and allows font deletion.

## Scope

The picker works at all 3 levels of the config cascade: global, per-host, per-channel. Fonts are stored centrally in `~/.config/lasterm/fonts/` (no system font detection).

## API

### Existing

- `GET /api/fonts` — returns `FontFamily[]` (no auth, no changes needed)

### New endpoints

#### `POST /api/fonts`

Upload a single font file. Multipart form data.

- **Field**: `file` (single font file — client calls once per file for multi-upload)
- **Accepted extensions**: `.ttf`, `.otf`, `.woff`, `.woff2`
- **Validation**:
  - MIME check via `fileTypeFromBuffer()` from `file-type` package (already a hub dependency, same pattern as wallpapers.ts). Allowed MIME set: `font/sfnt`, `font/otf`, `font/woff`, `font/woff2`, `application/font-woff`, `application/font-woff2`
  - Size check: `buffer.byteLength > MAX_FONT_SIZE (10 MB)` in handler (not plugin config — `@fastify/multipart` is already registered globally in server.ts with wallpaper limits)
  - Reject duplicates: same filename already exists (case-insensitive on Windows, case-sensitive on Linux)
- **Behavior**: writes file to `~/.config/lasterm/fonts/`, returns updated `FontFamily[]` (via `scanFonts()`)
- **Auth**: required — POST does not match the existing GET-only bypass in server.ts L168
- **Errors**: 400 (bad format/size), 409 (duplicate filename)

#### `DELETE /api/fonts/:family`

Delete all files belonging to a font family.

- **Param**: `family` — URL-encoded family name (e.g., `FiraCode%20Nerd%20Font`)
- **Behavior**: resolve family to files via `scanFonts()` — never construct file paths from the `:family` param directly. Apply `resolve(filePath).startsWith(resolve(fontsDir))` containment check on each file before `unlink()`. Same pattern as `registerWallpaperRoutes` (wallpapers.ts). Returns 204.
- **Guard**: none server-side. If the deleted family was the active font, the **client** detects this (compares deleted family with current setting) and resets to default via `updateSetting()`. Keeps the API stateless.
- **Auth**: required — protected by existing Bearer token onRequest hook
- **Errors**: 404 (family not found)

## Components

### FontPicker.vue (new)

Modal component. Teleport to body. Same dialog pattern as `HostModal.vue`.

**Props**:
- `modelValue: string | undefined` — current font family name
- `show: boolean` — visibility

**Emits**:
- `update:modelValue(family: string)` — on font selection
- `close` — on dismiss

**Structure**:
```
<Teleport to="body">
  <div class="dialog-overlay">         ← click.self → close
    <div class="font-picker-dialog">   ← 480px max-width
      <header>
        "Font Selection" + count badge
        "+ Add font" button + close ✕
      </header>
      <div class="font-picker-list">   ← max-height: 360px, overflow-y: auto, themed scrollbar
        <FontCard v-for />
        (empty state if no fonts: "No fonts installed. Drop files here or click + Add font")
      </div>
      <footer>
        "Drop .ttf, .otf, .woff2 files anywhere to add"
      </footer>
      <div v-if="isDragging" class="font-picker-drop-overlay">
        Drop zone overlay (full modal surface)
      </div>
    </div>
  </div>
</Teleport>
```

**Behavior**:
- On mount: uses `configStore.fonts` (already loaded at app init)
- Selection: click card → emit `update:modelValue(family)` → close
- Upload: drop or file input → sequential `POST /api/fonts` per file → `configStore.loadFonts()` → list refreshes, `injectFontFaces()` re-runs
- Delete: card emits delete → `DELETE /api/fonts/:family` → if deleted family === modelValue, emit `update:modelValue(undefined)` to reset to default → reload fonts
- Drag state: `useFontDrop` composable manages `isDragging` ref

### FontCard.vue (new)

Single font card in the list.

**Props**:
- `family: FontFamily` — font data (family name + files array)
- `selected: boolean` — highlight state
- `previewText: string` — default: `$ ls -la ~/.config 0123456789`

**Emits**:
- `select` — card clicked
- `delete` — delete confirmed

**Structure**:
- Row 1: font name (rendered in its own font) + weight count + delete icon
- Row 2: preview text (rendered in its own font, smaller, muted)
- Selected state: blue border + subtle background change
- Delete flow: click 🗑 → card switches to inline confirm ("Delete?" + Confirm/Cancel buttons) → confirm emits `delete`

**Font rendering**: each card applies `font-family: "${family.family}"` inline. The fonts are already loaded via `injectFontFaces()` so canvas and DOM both have access.

### useFontDrop composable (new)

```typescript
function useFontDrop(onFiles: (files: File[]) => void): {
  isDragging: Ref<boolean>;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}
```

Filters dropped files by accepted extensions. Manages `isDragging` state with dragenter/dragleave counter (handles nested elements).

### Settings integration

**settingsSchema.ts**: change `fontFamily` type from `'text'` to `'font'`. Update the `SettingDefinition.type` union to include `| 'font'`.

**SettingControl.vue**: add `font` case — renders a trigger button showing the current font name (or "Default" if unset). Click opens `FontPicker`. On selection, calls `updateSetting()` — same debounce, same cascade, same API routing as all other settings.

**configStore**: expose `loadFonts()` in the store's public return object (currently private). The FontPicker needs to call it after upload/delete to refresh the font list and re-inject `@font-face` rules.

## File structure

```
packages/clients/web/src/
  components/
    settings/
      FontPicker.vue          ← new
      FontCard.vue             ← new
  composables/
    useFontDrop.ts             ← new
packages/hub/src/
  api/
    fonts.ts                   ← add POST + DELETE routes
```

## Error handling

| Scenario | Behavior |
|----------|----------|
| Upload bad format | Toast error "Invalid font file: expected .ttf, .otf, .woff, or .woff2" |
| Upload too large | Toast error "Font file too large (max 10 MB)" |
| Upload MIME mismatch | Toast error "Invalid font file format" |
| Delete active font | Client resets to default font stack via updateSetting(), toast info |
| Network error on upload/delete | Toast error, modal stays open |
| No fonts installed | Empty state in list: "No fonts installed. Drop font files here or click + Add font" |

## Out of scope

- System font detection
- Font preview customization (custom preview text)
- Font file renaming/management beyond add/delete
- Per-font size or style configuration
- Search/filter in font list (font counts are typically small)
