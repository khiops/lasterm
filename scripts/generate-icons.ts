/**
 * Renders every icon file from the two drawings in packaging/brand:
 * lasterm-icon.svg, and lasterm-icon-small.svg for 16 to 24 px, where the full
 * drawing's prompt gets too thin. Run `pnpm icons` after changing either one;
 * the outputs are committed.
 *
 * - The desktop app: packages/clients/desktop/src-tauri/icons
 * - The MSIX: packages/clients/desktop/msix/Assets, with scale and targetsize
 *   variants that pack-msix.ps1 indexes into resources.pri
 * - The Store listing: packaging/brand/store
 * - The web client: packages/clients/web/public
 * - The website: packaging/brand/site
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { icnsFile, icoFile } from "./icon-containers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(root, "packaging", "brand");
const masterSvg = readFileSync(join(brand, "lasterm-icon.svg"), "utf8");
const smallSvg = readFileSync(join(brand, "lasterm-icon-small.svg"), "utf8");

/** The drawing, without its <svg> element, title and comments: to nest it in a composition. */
function innerOf(svg: string): string {
	return svg
		.replace(/^[\s\S]*?<svg[^>]*>/, "")
		.replace(/<\/svg>\s*$/, "")
		.replace(/<title>[\s\S]*?<\/title>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
}

/** The prompt and the cursor alone, without the tile. */
const glyph = innerOf(masterSvg).replace(/<rect[^>]*fill="#7c6fef"[^>]*\/>/, "");
const INDIGO = "#151832";
const VIOLET = "#7c6fef";

function render(svg: string, width: number): Uint8Array {
	const png = new Resvg(svg, {
		fitTo: { mode: "width", value: width },
		font: { loadSystemFonts: false },
	})
		.render()
		.asPng();
	return new Uint8Array(png);
}

/** The icon at `size` px: the small drawing up to 24 px, the full one above. */
function icon(size: number): Uint8Array {
	return render(size <= 24 ? smallSvg : masterSvg, size);
}

/** The icon centred on a transparent `width`×`height` canvas, `share` of its shorter side. */
function padded(width: number, height: number, share: number): Uint8Array {
	const side = Math.round(Math.min(width, height) * share);
	const source = side <= 24 ? smallSvg : masterSvg;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
		<svg x="${(width - side) / 2}" y="${(height - side) / 2}" width="${side}" height="${side}" viewBox="0 0 256 256">${innerOf(source)}</svg>
	</svg>`;
	return render(svg, width);
}

/** The glyph on a violet square that fills the image: maskable PWA icons and the apple-touch icon. */
function fullBleed(size: number): Uint8Array {
	// The glyph's centre is (129, 128); at 0.85 it stays inside the maskable safe circle (radius 40 %).
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
		<rect width="256" height="256" fill="${VIOLET}"/>
		<g transform="translate(128 128) scale(0.85) translate(-129 -128)">${glyph}</g>
	</svg>`;
	return render(svg, size);
}

/** The tile on the indigo ground: Store box art and poster art. */
function onGround(width: number, height: number, share: number, centreY = 0.5): Uint8Array {
	const side = Math.round(width * share);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
		<rect width="${width}" height="${height}" fill="${INDIGO}"/>
		<svg x="${(width - side) / 2}" y="${height * centreY - side / 2}" width="${side}" height="${side}" viewBox="0 0 256 256">${innerOf(masterSvg)}</svg>
	</svg>`;
	return render(svg, width);
}

const written: string[] = [];
function write(path: string, data: Uint8Array | string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
	written.push(path.slice(root.length + 1).replaceAll("\\", "/"));
}

// ── Desktop app (tauri.conf.json bundle.icon, and icon.png for the window) ──
const tauriIcons = join(root, "packages", "clients", "desktop", "src-tauri", "icons");
for (const [name, size] of [
	["32x32.png", 32],
	["64x64.png", 64],
	["128x128.png", 128],
	["128x128@2x.png", 256],
	["icon.png", 512],
] as const) {
	write(join(tauriIcons, name), icon(size));
}
write(join(tauriIcons, "icon.ico"), icoFile([16, 20, 24, 32, 40, 48, 64, 256].map(icon)));
write(join(tauriIcons, "icon.icns"), icnsFile([128, 256, 512, 1024].map(icon)));

// ── MSIX assets: one file per scale or target size, resolved through resources.pri ──
const msixAssets = join(root, "packages", "clients", "desktop", "msix", "Assets");
rmSync(msixAssets, { recursive: true, force: true });
const SCALES = [100, 125, 150, 200, 400] as const;
const at = (base: number, scale: number) => Math.round((base * scale) / 100);
for (const scale of SCALES) {
	write(join(msixAssets, `StoreLogo.scale-${scale}.png`), icon(at(50, scale)));
	write(join(msixAssets, `Square44x44Logo.scale-${scale}.png`), icon(at(44, scale)));
	write(
		join(msixAssets, `Square71x71Logo.scale-${scale}.png`),
		padded(at(71, scale), at(71, scale), 0.5),
	);
	write(
		join(msixAssets, `Square150x150Logo.scale-${scale}.png`),
		padded(at(150, scale), at(150, scale), 0.5),
	);
	write(
		join(msixAssets, `Wide310x150Logo.scale-${scale}.png`),
		padded(at(310, scale), at(150, scale), 0.5),
	);
	write(
		join(msixAssets, `Square310x310Logo.scale-${scale}.png`),
		padded(at(310, scale), at(310, scale), 0.5),
	);
}
// The taskbar, Start and Alt+Tab draw these as they are; without the unplated
// ones, Windows sets the icon on a plate of the accent colour.
for (const size of [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]) {
	const png = icon(size);
	write(join(msixAssets, `Square44x44Logo.targetsize-${size}.png`), png);
	write(join(msixAssets, `Square44x44Logo.targetsize-${size}_altform-unplated.png`), png);
}

// ── Microsoft Store listing (Partner Center › Store listing › Store logos) ──
const store = join(brand, "store");
write(join(store, "app-tile-icon-300.png"), icon(300));
write(join(store, "box-art-1080.png"), onGround(1080, 1080, 0.5));
write(join(store, "box-art-2160.png"), onGround(2160, 2160, 0.5));
write(join(store, "poster-art-720x1080.png"), onGround(720, 1080, 0.56, 0.45));
write(join(store, "poster-art-1440x2160.png"), onGround(1440, 2160, 0.56, 0.45));

// ── Web client (served by the hub) ──
const webPublic = join(root, "packages", "clients", "web", "public");
write(join(webPublic, "favicon.svg"), masterSvg);
write(join(webPublic, "icons", "icon-32.png"), icon(32));
write(join(webPublic, "icons", "icon-192.png"), icon(192));
write(join(webPublic, "icons", "icon-512.png"), icon(512));
write(join(webPublic, "icons", "icon-maskable-512.png"), fullBleed(512));

// ── Website ──
const site = join(brand, "site");
write(join(site, "favicon.svg"), masterSvg);
write(join(site, "favicon.ico"), icoFile([16, 32, 48].map(icon)));
write(join(site, "apple-touch-icon.png"), fullBleed(180));
write(join(site, "icon-192.png"), icon(192));
write(join(site, "icon-512.png"), icon(512));
write(join(site, "icon-maskable-512.png"), fullBleed(512));

console.log(`${written.length} files written:`);
for (const path of written) console.log(`  ${path}`);
