#!/usr/bin/env node
// Build release assets using tracked public files, without modifying optional
// local icon packs or copying ignored workspace files into the distribution.
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { generateNotices } from './dependency-notices.mjs';
import { assertPublicPath } from './check-artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staging = await mkdtemp(join(tmpdir(), 'vellum-public-'));
try {
  let files;
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (resolve(gitRoot) !== root) throw new Error('This source snapshot has no repository of its own.');
    files = execFileSync('git', ['ls-files', '-z', 'public'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\0').filter(Boolean);
  } catch {
    // History-free source snapshots record the reviewed source list. Do not
    // discover public files by scanning a possibly private workspace directory.
    const manifest = JSON.parse(await readFile(join(root, 'SOURCE-MANIFEST.json'), 'utf8'));
    files = manifest.map((entry) => entry.path).filter((path) => path.startsWith('public/'));
  }
  for (const file of files) {
    assertPublicPath(file);
    if (file.includes('..') || file.includes('\\') || !file.startsWith('public/')) {
      throw new Error(`Invalid public source path: ${file}`);
    }
    if (file.startsWith('public/icons/')) throw new Error(`Vendor icon pack in release inputs: ${file}`);
    if (!(await lstat(join(root, file))).isFile()) throw new Error(`Public asset must be a regular file: ${file}`);
    const destination = join(staging, file.slice('public/'.length));
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, file), destination, { dereference: false });
  }
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'typecheck', '--workspaces=false'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  await build({ root, publicDir: staging, mode: 'production' });
  await generateNotices(join(root, 'dist'), { desktop: process.argv.includes('--desktop') });
} finally {
  await rm(staging, { recursive: true, force: true });
}
