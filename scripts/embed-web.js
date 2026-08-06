#!/usr/bin/env node
/**
 * embed-web.js
 *
 * Copies the web client's build output (packages/clients/web/dist/)
 * into packages/hub/static/ so that the hub can serve it as static files.
 *
 * Usage: node scripts/embed-web.js
 * Invoked by: pnpm build:embed (root package.json)
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const src = join(root, 'packages', 'clients', 'web', 'dist');
const dest = join(root, 'packages', 'hub', 'static');

if (!existsSync(src)) {
	console.error(`[embed-web] Source not found: ${src}`);
	console.error('[embed-web] Run: pnpm -F @lasterm/web build');
	process.exit(1);
}

// Clean previous embedding
if (existsSync(dest)) {
	rmSync(dest, { recursive: true });
}
mkdirSync(dest, { recursive: true });

cpSync(src, dest, { recursive: true });
console.log(`[embed-web] Copied ${src} → ${dest}`);
