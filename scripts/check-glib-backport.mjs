#!/usr/bin/env node
// Cargo audit does not inspect path dependencies. Verify this exact backport
// before accepting the advisory report for the remaining registry packages.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'src-tauri/vendor/glib');
const hashes = JSON.parse(await readFile(join(root, 'src-tauri/vendor/glib.sha256.json'), 'utf8'));
async function visit(path, prefix = '') {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await visit(join(path, entry.name), relative + '/');
    else {
      if (!entry.isFile()) throw new Error(`Unexpected vendored entry: ${relative}`);
      const actual = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex');
      if (hashes[relative] !== actual) throw new Error(`Unreviewed glib source: ${relative}`);
      delete hashes[relative];
    }
  }
}
await visit(directory);
if (Object.keys(hashes).length) throw new Error('Vendored glib source is incomplete');
const lock = await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8');
const entries = lock.split('[[package]]').filter((entry) => /^\s*name = "glib"$/m.test(entry));
if (entries.length !== 1 || !entries[0].includes('version = "0.18.5"') || /^source = /m.test(entries[0])) {
  throw new Error('Cargo.lock must resolve only the reviewed path dependency for glib');
}
const manifest = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
if (!manifest.includes('[patch.crates-io]\n') || !manifest.includes('glib = { path = "vendor/glib" }')) {
  throw new Error('Missing glib backport override');
}
console.log('Verified exact glib 0.18.5 source with the RUSTSEC-2024-0429 backport.');
