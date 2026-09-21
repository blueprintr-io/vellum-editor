#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertCompleteLicenseNotices(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error('Dependency license inventory is empty or invalid.');
  const missing = inventory.filter((entry) => !Array.isArray(entry.noticeFiles) || entry.noticeFiles.length === 0);
  if (missing.length) {
    throw new Error(`Publication requires verified license notices for: ${missing.map((entry) => `${entry.name}@${entry.version}`).join(', ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertCompleteLicenseNotices(JSON.parse(await readFile(process.argv[2] ?? 'dist/DEPENDENCY-LICENSES.json', 'utf8')));
  console.log('Dependency license notice inventory is complete.');
}
