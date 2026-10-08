import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import { evaluate } from '../scripts/check-npm-advisories.mjs';

const braces = {
  name: 'braces',
  severity: 'high',
  title: 'braces stack exhaustion',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
};
const report = (vulnerabilities: Record<string, unknown>) => ({
  vulnerabilities,
  metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } },
});
const buildTooling = report({
  braces: { via: [braces] },
  micromatch: { via: ['braces'] },
});
const clean = report({});
const allowlist = {
  advisories: [{ id: 'GHSA-vfj7-8cjw-p6xm', packages: ['braces'], expires: '2026-12-07' }],
};

test('a reviewed build-tool advisory passes until its expiry date', () => {
  const run = (today: string) => evaluate({ runtimeReport: clean, fullReport: buildTooling, allowlist, today });
  assert.deepEqual(run('2026-12-07').problems, []);
  assert.match(run('2026-12-08').problems.join('\n'), /expired on 2026-12-07/);
});

test('an advisory missing from the allow-list fails', () => {
  const { problems } = evaluate({ runtimeReport: clean, fullReport: buildTooling, allowlist: { advisories: [] }, today: '2026-10-08' });
  assert.match(problems.join('\n'), /GHSA-vfj7-8cjw-p6xm .* is not in the reviewed allow-list/);
});

test('an allow-listed advisory that reaches a shipped dependency still fails', () => {
  const { problems } = evaluate({ runtimeReport: buildTooling, fullReport: buildTooling, allowlist, today: '2026-10-08' });
  assert.match(problems.join('\n'), /reaches a shipped dependency/);
});

test('a shipped vulnerability without an advisory record fails', () => {
  const runtimeReport = { vulnerabilities: { left: { via: ['right'] } }, metadata: { vulnerabilities: { total: 1 } } };
  const { problems } = evaluate({ runtimeReport, fullReport: clean, allowlist, today: '2026-10-08' });
  assert.match(problems.join('\n'), /without an advisory record/);
});

test('an allow-list entry does not stretch to a package it does not name', () => {
  const spread = report({ braces: { via: [braces] }, other: { via: [{ ...braces, name: 'other' }] } });
  const { problems } = evaluate({ runtimeReport: clean, fullReport: spread, allowlist, today: '2026-10-08' });
  assert.match(problems.join('\n'), /now affects other/);
});

test('entries npm audit no longer reports are flagged for removal', () => {
  const { problems, unused } = evaluate({ runtimeReport: clean, fullReport: clean, allowlist, today: '2026-10-08' });
  assert.deepEqual(problems, []);
  assert.deepEqual(unused, ['GHSA-vfj7-8cjw-p6xm']);
});

test('CI and the release preflight both run the advisory gate', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const advisories = ci.jobs.advisories.steps.map((step: any) => step.run ?? '').join('\n');
  assert.match(advisories, /node scripts\/check-npm-advisories\.mjs/);
  const release = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const preflight = release.jobs.preflight.steps.map((step: any) => step.run ?? '').join('\n');
  assert.match(preflight, /node scripts\/check-npm-advisories\.mjs/);
  assert.doesNotMatch(advisories + preflight, /npm audit --audit-level/);
});

test('every allow-list entry is reviewed, dated and bounded', async () => {
  const list = JSON.parse(await readFile(new URL('../.github/npm-advisory-allowlist.json', import.meta.url), 'utf8'));
  for (const entry of list.advisories) {
    assert.match(entry.id, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    assert.ok(entry.packages.length > 0 && entry.reason.length > 40, entry.id);
    assert.match(entry.reviewed, /^\d{4}-\d{2}-\d{2}$/);
    const days = (Date.parse(entry.expires) - Date.parse(entry.reviewed)) / 86_400_000;
    assert.ok(days > 0 && days <= 90, `${entry.id} must expire within 90 days of its review`);
  }
});
