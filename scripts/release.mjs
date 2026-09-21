#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  assertVersionsSynchronized,
  compareSemver,
} from './version-sync.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REPO_URL = 'https://github.com/blueprintr-io/vellum-editor';

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function shInherit(cmd) {
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function bump(version, kind) {
  const parts = version.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    fail(`current version "${version}" is not plain semver - fix it manually first`);
  }
  const [major, minor, patch] = parts;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'major') return `${major + 1}.0.0`;
  throw new Error(`unknown bump kind: ${kind}`);
}

const rl = createInterface({ input, output });

try {
  // --- Sanity checks ---
  const status = sh('git status --porcelain');
  if (status) {
    console.error('✗ Working tree is dirty. Commit or stash other changes first:\n');
    console.error(status + '\n');
    process.exit(1);
  }

  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'main') {
    fail(`You are on "${branch}", not main. Switch with: git switch main`);
  }

  // Make sure local main is up to date with remote - avoids tagging a stale commit
  sh('git fetch origin main');
  const local = sh('git rev-parse main');
  const remote = sh('git rev-parse origin/main');
  if (local !== remote) {
    fail(`Local main is out of sync with origin/main. Pull first: git pull --ff-only`);
  }

  // --- Pick a monotonic tag version ---
  const current = assertVersionsSynchronized();
  const releaseTags = sh('git ls-remote --tags --refs origin refs/tags/v*')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1]?.replace('refs/tags/v', ''))
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version));
  const newestRemote = releaseTags.sort(compareSemver).at(-1);
  const liveResponse = await fetch('https://downloads.blueprintr.io/core/updater.json', {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!liveResponse.ok) {
    fail(`Could not read the live Core channel (${liveResponse.status})`);
  }
  const liveVersion = String((await liveResponse.json()).version ?? '');
  // Sorting validates every floor as plain semver through compareSemver.
  const floor = [current, newestRemote, liveVersion]
    .filter(Boolean)
    .sort(compareSemver)
    .at(-1);

  console.log(`\nSource version metadata: ${current}`);
  console.log(`Live channel: ${liveVersion}`);
  console.log(`Release floor: ${floor}\n`);
  console.log('Bump type:');
  console.log(`  1) patch  (${floor} → ${bump(floor, 'patch')})  - bug fixes`);
  console.log(`  2) minor  (${floor} → ${bump(floor, 'minor')})  - new features`);
  console.log(`  3) major  (${floor} → ${bump(floor, 'major')})  - breaking changes`);
  console.log('  c) cancel');

  const choice = (await rl.question('\nChoose [1/2/3/c]: ')).trim().toLowerCase();
  const kindMap = { 1: 'patch', 2: 'minor', 3: 'major' };
  const kind = kindMap[choice];
  if (!kind) {
    console.log('Cancelled.');
    process.exit(0);
  }

  const next = bump(floor, kind);
  const tag = `v${next}`;

  // A stale local version must never create a lower release than an existing
  // remote tag. `version-sync` prevents surface drift; this protects the
  // channel's monotonicity when a developer has an old clone.
  if (newestRemote && compareSemver(next, newestRemote) <= 0) {
    fail(`Next version ${next} must be newer than remote release ${newestRemote}`);
  }
  if (compareSemver(next, liveVersion) <= 0) {
    fail(`Next version ${next} must be newer than live release ${liveVersion}`);
  }

  // Tag conflict?
  let tagExists = false;
  try {
    sh(`git rev-parse --verify --quiet refs/tags/${tag}`);
    tagExists = true;
  } catch {}
  if (tagExists) fail(`Tag ${tag} already exists locally. Delete with: git tag -d ${tag}`);

  // Remote tag conflict?
  const remoteTags = sh(`git ls-remote --tags origin refs/tags/${tag}`);
  if (remoteTags) fail(`Tag ${tag} already exists on origin. Pick a different version.`);

  // --- Confirm ---
  console.log(`\nSelected: ${kind} → ${next}`);
  console.log('This will:');
  console.log(`  • tag the current main source commit as ${tag}`);
  console.log(`  • push only that tag → triggers the CI build`);
  console.log(`  • inject ${next} into all version surfaces in disposable CI checkouts`);

  const confirm = (await rl.question('\nProceed? [y/N]: ')).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('Cancelled.');
    process.exit(0);
  }

  // --- Tag the feature/source commit directly; CI injects the tag version. ---
  shInherit(`git tag -a ${tag} -m "Release ${tag}"`);

  console.log('\n✓ Tagged current main. Pushing...\n');

  try {
    shInherit(`git push origin ${tag}`);
  } catch {
    console.error('\n✗ Push failed. Your local tag is intact.');
    console.error(`  Retry with: git push origin ${tag}`);
    console.error(`  To cancel locally: git tag -d ${tag}`);
    process.exit(1);
  }

  console.log(`\n✓ Released ${tag}.\n`);
  console.log(`  CI build:  ${REPO_URL}/actions`);
  console.log(`  Release:   ${REPO_URL}/releases/tag/${tag}`);
  console.log(`  (release page populates as CI finishes - usually 25–40 min)\n`);
} finally {
  rl.close();
}
