#!/usr/bin/env node

/**
 * Keep every Vellum Core version surface in lock-step.
 *
 * Tauri reads tauri.conf.json, Cargo embeds Cargo.toml/Cargo.lock, and the
 * release helper historically read package.json. Letting those drift can cut
 * an apparent downgrade even when the desktop binary itself has a newer
 * version. This script is the single reader/writer used locally and in CI.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const paths = {
  packageJson: resolve(root, 'package.json'),
  packageLock: resolve(root, 'package-lock.json'),
  tauri: resolve(root, 'src-tauri/tauri.conf.json'),
  cargoToml: resolve(root, 'src-tauri/Cargo.toml'),
  cargoLock: resolve(root, 'src-tauri/Cargo.lock'),
};

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(value, label = 'version') {
  const match = SEMVER_RE.exec(value);
  if (!match) {
    throw new Error(`${label} must be plain X.Y.Z semver, got ${JSON.stringify(value)}`);
  }
  return match.slice(1).map(Number);
}

export function compareSemver(left, right) {
  const a = parseSemver(left, 'left version');
  const b = parseSemver(right, 'right version');
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function nextReleaseVersion(current, floor) {
  const comparison = compareSemver(current, floor);
  if (comparison > 0) return current;
  const [major, minor, patch] = parseSemver(floor);
  return `${major}.${minor}.${patch + 1}`;
}

function matchOrThrow(content, expression, label) {
  const match = expression.exec(content);
  if (!match) throw new Error(`Could not read ${label}`);
  return match[1];
}

export function readVersionSurfaces() {
  const packageJson = JSON.parse(readFileSync(paths.packageJson, 'utf8'));
  const packageLock = JSON.parse(readFileSync(paths.packageLock, 'utf8'));
  const cargoToml = readFileSync(paths.cargoToml, 'utf8');
  const cargoLock = readFileSync(paths.cargoLock, 'utf8');
  const tauri = JSON.parse(readFileSync(paths.tauri, 'utf8'));

  return {
    'package.json': packageJson.version,
    'package-lock.json': packageLock.version,
    'package-lock.json root package': packageLock.packages?.['']?.version,
    'src-tauri/tauri.conf.json': tauri.version,
    'src-tauri/Cargo.toml': matchOrThrow(
      cargoToml,
      /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m,
      'src-tauri/Cargo.toml [package] version',
    ),
    'src-tauri/Cargo.lock': matchOrThrow(
      cargoLock,
      /\[\[package\]\]\r?\nname = "vellum-desktop"\r?\nversion = "([^"]+)"/,
      'vellum-desktop version in src-tauri/Cargo.lock',
    ),
  };
}

export function assertVersionsSynchronized(expected) {
  const surfaces = readVersionSurfaces();
  const entries = Object.entries(surfaces);
  const canonical = entries[0][1];
  parseSemver(canonical, entries[0][0]);

  const mismatches = entries.filter(([, value]) => value !== canonical);
  if (mismatches.length > 0) {
    const detail = entries.map(([label, value]) => `  ${label}: ${value}`).join('\n');
    throw new Error(`Version surfaces are out of sync:\n${detail}`);
  }
  if (expected != null && canonical !== expected) {
    throw new Error(`Synchronized version is ${canonical}, expected ${expected}`);
  }
  return canonical;
}

function replaceOrThrow(content, expression, replacement, label) {
  if (!expression.test(content)) throw new Error(`Could not update ${label}`);
  return content.replace(expression, replacement);
}

export function setVersion(version) {
  parseSemver(version);

  const packageJson = JSON.parse(readFileSync(paths.packageJson, 'utf8'));
  packageJson.version = version;

  const packageLock = JSON.parse(readFileSync(paths.packageLock, 'utf8'));
  if (!packageLock.packages?.['']) {
    throw new Error('package-lock.json has no root package entry');
  }
  packageLock.version = version;
  packageLock.packages[''].version = version;

  const tauri = JSON.parse(readFileSync(paths.tauri, 'utf8'));
  tauri.version = version;

  const cargoToml = readFileSync(paths.cargoToml, 'utf8');
  const nextCargoToml = replaceOrThrow(
    cargoToml,
    /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(".*$)/m,
    `$1${version}$2`,
    'src-tauri/Cargo.toml [package] version',
  );

  const cargoLock = readFileSync(paths.cargoLock, 'utf8');
  const nextCargoLock = replaceOrThrow(
    cargoLock,
    /(\[\[package\]\]\r?\nname = "vellum-desktop"\r?\nversion = ")[^"]+(")/,
    `$1${version}$2`,
    'vellum-desktop version in src-tauri/Cargo.lock',
  );

  // Validate every input before the first write so a malformed lock/config
  // file cannot leave only some version surfaces updated.
  writeFileSync(paths.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(paths.packageLock, `${JSON.stringify(packageLock, null, 2)}\n`);
  writeFileSync(paths.tauri, `${JSON.stringify(tauri, null, 2)}\n`);
  writeFileSync(paths.cargoToml, nextCargoToml);
  writeFileSync(paths.cargoLock, nextCargoLock);

  return assertVersionsSynchronized(version);
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const set = optionValue(args, '--set');
  const expected = optionValue(args, '--expected');
  const newerThan = optionValue(args, '--assert-newer-than');
  const candidate = optionValue(args, '--candidate');
  const nextAfter = optionValue(args, '--next-after');
  const currentOnly = args.includes('--current');

  if (candidate && !newerThan) {
    throw new Error('--candidate requires --assert-newer-than');
  }

  const actionCount = [set, newerThan, nextAfter, currentOnly ? 'yes' : undefined].filter(
    Boolean,
  ).length;
  if (actionCount > 1) {
    throw new Error('Use only one of --set, --assert-newer-than, --next-after, or --current');
  }

  const current = set ? setVersion(set) : assertVersionsSynchronized(expected);
  if (newerThan) {
    parseSemver(newerThan, '--assert-newer-than');
    const release = candidate ?? current;
    parseSemver(release, '--candidate');
    if (compareSemver(release, newerThan) <= 0) {
      throw new Error(`${release} must be newer than ${newerThan}`);
    }
    console.log(release);
    return;
  }
  if (nextAfter) {
    console.log(nextReleaseVersion(current, nextAfter));
    return;
  }
  if (currentOnly) {
    console.log(current);
    return;
  }
  console.log(`Version sync OK: ${current}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[version-sync] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
