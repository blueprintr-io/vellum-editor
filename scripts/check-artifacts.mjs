#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forbidden = /(^|\/)(?:\.env(?:\..*)?|CLAUDE_MEMORY\.md|SOURCE-AVAILABLE-[^/]*|node_modules|\.git|\.claude|\.codex|\.agents|raw-icons|vellum-iconpacks)(\/|$)|(^|\/)(?:public\/)?icons\/[^/]*\/(?:[^/]*\/)*[^/]*\.svg$|\.(?:pem|key)$/i;

export function assertPublicPath(path) {
  if (path.startsWith('/') || path.split('/').includes('..') || forbidden.test(path)) {
    throw new Error(`Private or vendor file in generated release artifact: ${path}`);
  }
}

export async function checkDist(directory) {
  const files = [];
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      assertPublicPath(relative);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in distribution: ${relative}`);
      if (entry.isDirectory()) await visit(join(dir, entry.name), `${relative}/`);
      else {
        files.push(relative);
        if (!/^(?:index\.html|THIRD-PARTY-NOTICES\.txt|DEPENDENCY-LICENSES\.json|assets\/[^/]+\.(?:js|css|woff2?|ttf|png|svg))$/.test(relative)) {
          throw new Error(`Unexpected distribution file requires review: ${relative}`);
        }
        if (/\.(?:js|html)$/.test(relative) && (await readFile(join(dir, entry.name), 'utf8')).includes('__VELLUM_TEST__')) {
          throw new Error(`Test interface found in production output: ${relative}`);
        }
      }
    }
  }
  await visit(directory);
  if (!files.includes('index.html')) throw new Error('Distribution is missing index.html');
  return files;
}

async function main() {
  const files = await checkDist(join(root, 'dist'));
  const staging = await mkdtemp(join(tmpdir(), 'vellum-artifacts-'));
  try {
    const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', '--workspaces=false', '--ignore-scripts', '--json', '--pack-destination', staging],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
        env: { ...process.env, npm_config_cache: join(staging, 'npm-cache') } });
    const [pack] = JSON.parse(output);
    const entries = execFileSync('tar', ['-tzf', join(staging, pack.filename)], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    entries.forEach(assertPublicPath);
    console.log(`Reviewed generated dist (${files.length} files) and npm archive (${entries.length} entries, ${pack.size} bytes).`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
