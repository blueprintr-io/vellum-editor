#!/usr/bin/env node
// Copy the reviewed working tree without Git objects or ignored workspace data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicPath } from './check-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || destination === root || destination.startsWith(`${root}/`)) {
  throw new Error('Pass an archive destination outside this repository.');
}
const staging = await mkdtemp(join(tmpdir(), 'vellum-source-'));
try {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const manifest = [];
  const omitted = [];
  for (const path of [...new Set(paths)].sort()) {
    if (/^(?:\.claude|\.codex|\.agents)\//.test(path)) {
      omitted.push({ path, reason: 'Local agent configuration is excluded from source distribution.' });
      continue;
    }
    assertPublicPath(path);
    if (path.startsWith('public/icons/') || path.startsWith('dist/') || path.startsWith('src-tauri/target/')) {
      throw new Error(`Generated or vendor content in source list: ${path}`);
    }
    const source = join(root, path);
    let stat;
    try { stat = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`Source snapshot requires regular files: ${path}`);
    const content = await readFile(source);
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await writeFile(join(staging, path), content, { mode: stat.mode });
    manifest.push({ path, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  await writeFile(join(staging, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(staging, 'SOURCE-OMISSIONS.json'), JSON.stringify(omitted, null, 2) + '\n');
  await mkdir(dirname(destination), { recursive: true });
  try { await lstat(destination); throw new Error(`Destination already exists: ${destination}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  execFileSync('tar', ['-czf', destination, '-C', staging, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const entries = execFileSync('tar', ['-tzf', destination], { encoding: 'utf8' }).split('\n')
    .map((entry) => entry.replace(/^\.\//, '')).filter((entry) => entry && !entry.endsWith('/'));
  entries.forEach(assertPublicPath);
  const expected = new Set([...manifest.map((entry) => entry.path), 'SOURCE-MANIFEST.json', 'SOURCE-OMISSIONS.json']);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) {
    throw new Error('Archive contents differ from the reviewed source manifest');
  }
  const extracted = join(staging, 'verify-archive');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', destination, '-C', extracted]);
  for (const entry of manifest) {
    const content = await readFile(join(extracted, entry.path));
    if (content.length !== entry.size || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      throw new Error(`Archived bytes differ from the source manifest: ${entry.path}`);
    }
  }
  const digest = createHash('sha256').update(await readFile(destination)).digest('hex');
  await writeFile(`${destination}.sha256`, `${digest}  ${destination.split('/').at(-1)}\n`);
  console.log(`Reviewed ${entries.length} history-free source entries: ${destination}\nSHA-256: ${digest}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
