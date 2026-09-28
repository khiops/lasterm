# Lasterm icon

- `lasterm-icon.svg` is the icon: a violet tile, the prompt `>` cut out in the indigo ground, and the mint block cursor that blinks on the website.
- `lasterm-icon-small.svg` is the same drawing for 16 to 24 px, with a heavier prompt and a larger cursor. The full drawing gets too thin at those sizes.

The colours are those of the website's design system: `#7c6fef` (prompt), `#151832` (ground) and `#9ddeb4` (cursor).

## Generated files

`pnpm icons` renders every file below from the two drawings (`scripts/generate-icons.ts`). The outputs are committed, so run it again after changing a drawing.

| Where | What |
|---|---|
| `packages/clients/desktop/src-tauri/icons/` | The desktop bundles: `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `icon.png` (512), `icon.ico` (16 to 256), `icon.icns` |
| `packages/clients/desktop/msix/Assets/` | The MSIX logos, one file per scale (`scale-100` to `scale-400`), and `Square44x44Logo` per target size, plated and `altform-unplated`. `pack-msix.ps1` indexes them into `resources.pri`. |
| `packaging/brand/store/` | The Microsoft Store listing: app tile icon (300), 1:1 box art (1080, 2160), 2:3 poster art (720×1080, 1440×2160) |
| `packages/clients/web/public/` | The web client: `favicon.svg`, `icons/icon-32/192/512.png`, and a maskable 512 |
| `packaging/brand/site/` | The website: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, and PWA icons, maskable included |

The maskable and apple-touch icons put the glyph on a violet square that fills the image, inside the maskable safe zone. The Store art sets the tile on the indigo ground.
