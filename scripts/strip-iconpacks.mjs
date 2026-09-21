#!/usr/bin/env node
// Manual cleanup for local icon-pack builds. Removes public/icons and
// dist/icons. Public and desktop builds instead stage reviewed assets through
// build-public.mjs, leaving local packs unchanged.

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const EDITOR_ROOT = join(__filename, '..', '..');
const PUBLIC_ICONS = join(EDITOR_ROOT, 'public', 'icons');
const DIST_ICONS = join(EDITOR_ROOT, 'dist', 'icons');

for (const dir of [PUBLIC_ICONS, DIST_ICONS]) {
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
    console.log(`[strip-iconpacks] removed ${dir}`);
  }
}
