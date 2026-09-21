#!/usr/bin/env node
// Copy `vellum-iconpacks/dist/icons/` → `vellum/public/icons/` so the editor's
// Vite build picks up the bundled vendor packs. No-op when the sibling
// `vellum-iconpacks` workspace is missing (a source-only checkout).

import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const EDITOR_ROOT = join(__filename, '..', '..');
const REPO_ROOT = join(EDITOR_ROOT, '..');
const ICONPACKS_DIST = join(REPO_ROOT, 'vellum-iconpacks', 'dist', 'icons');
const PUBLIC_ICONS = join(EDITOR_ROOT, 'public', 'icons');

async function main() {
  if (!existsSync(ICONPACKS_DIST)) {
    console.log('[sync-iconpacks] vellum-iconpacks/dist/icons not found - skipping.');
    return;
  }
  if (existsSync(PUBLIC_ICONS)) {
    await rm(PUBLIC_ICONS, { recursive: true, force: true });
  }
  await mkdir(PUBLIC_ICONS, { recursive: true });
  await cp(ICONPACKS_DIST, PUBLIC_ICONS, { recursive: true });
  console.log(`[sync-iconpacks] copied ${ICONPACKS_DIST} → ${PUBLIC_ICONS}`);
}

main().catch((err) => {
  console.error('[sync-iconpacks] failed:', err);
  process.exit(1);
});
