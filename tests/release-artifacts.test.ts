import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicPath, checkDist } from '../scripts/check-artifacts.mjs';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { assertCompleteLicenseNotices } from '../scripts/check-license-notices.mjs';

test('publication rejects dependencies without verified license notice text', () => {
  assert.doesNotThrow(() => assertCompleteLicenseNotices([{ name: 'example', version: '1.0.0', noticeFiles: ['LICENSE'] }]));
  assert.throws(() => assertCompleteLicenseNotices([{ name: 'example', version: '1.0.0', noticeFiles: [] }]), /example@1\.0\.0/);
  assert.throws(() => assertCompleteLicenseNotices([]), /empty or invalid/);
});

test('generated release artifacts reject private files, vendor packs, and test interfaces', async () => {
  for (const path of ['package/.env.local', 'package/CLAUDE_MEMORY.md', 'icons/aws/ec2.svg', '../secret', 'server.key']) {
    assert.throws(() => assertPublicPath(path));
  }
  assert.doesNotThrow(() => assertPublicPath('package/src/icons/attribution.ts'));
  const dir = await mkdtemp(join(tmpdir(), 'vellum-dist-test-'));
  try {
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<html></html>');
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log("app")');
    assert.equal((await checkDist(dir)).length, 2);
    await writeFile(join(dir, 'assets', 'app.js'), 'window.__VELLUM_TEST__ = {}');
    await assert.rejects(checkDist(dir), /Test interface/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('release assets remain drafts until every platform gate and mirror verification pass', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const build = workflow.jobs.build;
  assert.equal(build.needs, 'preflight');
  const action = build.steps.find((step: any) => step.uses?.startsWith('tauri-apps/tauri-action@'));
  assert.equal(action.with.releaseDraft, true);
  const preflight = workflow.jobs.preflight.steps.map((step: any) => step.run ?? '').join('\n');
  assert.match(preflight, /npm run test:e2e/);
  assert.match(preflight, /cargo audit .*--deny unsound/);
  const promote = workflow.jobs['publish-downloads'];
  assert.deepEqual(promote.needs, ['preflight', 'build']);
  const publish = promote.steps.findIndex((step: any) => step.run?.includes('--draft=false'));
  const verify = promote.steps.findIndex((step: any) => step.name === 'Verify published channel, provenance, and installer bytes');
  assert.ok(publish > verify && verify >= 0);
});
