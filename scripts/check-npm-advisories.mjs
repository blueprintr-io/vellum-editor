#!/usr/bin/env node
// npm advisory gate for CI and releases.
//
// Shipped dependencies (everything `npm audit --omit=dev` sees) must have no
// advisory at any severity. Build tooling may carry only the advisories in
// .github/npm-advisory-allowlist.json: each entry names the packages it covers,
// says why it cannot reach the shipped app, and stops working on its expiry
// date so it is reviewed again rather than forgotten.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Advisories in an `npm audit --json` report, keyed by GHSA id. */
export function advisories(report) {
  const found = new Map();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A string names another vulnerable package; the advisory itself is
      // reported on that package, so it is collected there.
      if (typeof via !== 'object' || via === null) continue;
      const id = String(via.url ?? '').split('/').pop() || `npm-${via.source}`;
      const entry = found.get(id) ?? { severity: via.severity, title: via.title, packages: new Set() };
      entry.packages.add(via.name ?? name);
      found.set(id, entry);
    }
  }
  return found;
}

export function evaluate({ runtimeReport, fullReport, allowlist, today }) {
  const problems = [];
  const runtime = advisories(runtimeReport);
  for (const [id, advisory] of runtime) {
    problems.push(`${id} (${advisory.severity}) reaches a shipped dependency (${[...advisory.packages].join(', ')}): ${advisory.title}`);
  }
  if (runtime.size === 0 && (runtimeReport.metadata?.vulnerabilities?.total ?? 0) > 0) {
    problems.push('npm audit reports a vulnerable shipped dependency without an advisory record');
  }
  const allowed = new Map((allowlist.advisories ?? []).map((entry) => [entry.id, entry]));
  const full = advisories(fullReport);
  for (const [id, advisory] of full) {
    if (runtime.has(id)) continue;
    const entry = allowed.get(id);
    const packages = [...advisory.packages];
    if (!entry) {
      problems.push(`${id} (${advisory.severity}) in ${packages.join(', ')} is not in the reviewed allow-list: ${advisory.title}`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '') || entry.expires < today) {
      problems.push(`${id}: the allow-list entry expired on ${entry.expires}; review it again`);
    }
    for (const name of packages) {
      if (!(entry.packages ?? []).includes(name)) problems.push(`${id} now affects ${name}, which its allow-list entry does not name`);
    }
  }
  const unused = [...allowed.keys()].filter((id) => !full.has(id));
  return { problems, unused };
}

function audit(args) {
  const result = spawnSync('npm', ['audit', '--json', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit ${args.join(' ')} returned no report (exit ${result.status}): ${result.stderr.slice(0, 500)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowlist = JSON.parse(await readFile(join(root, '.github/npm-advisory-allowlist.json'), 'utf8'));
  const { problems, unused } = evaluate({
    runtimeReport: audit(['--omit=dev']),
    fullReport: audit([]),
    allowlist,
    today: new Date().toISOString().slice(0, 10),
  });
  for (const id of unused) console.log(`note: ${id} is allow-listed but no longer reported; remove its entry`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log('npm advisories: shipped dependencies clean; build tooling within the reviewed allow-list');
}
