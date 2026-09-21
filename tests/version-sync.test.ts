import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareSemver,
  nextReleaseVersion,
  parseSemver,
} from '../scripts/version-sync.mjs';

test('plain semver parsing and ordering are numeric', () => {
  assert.deepEqual(parseSemver('1.7.0'), [1, 7, 0]);
  assert.equal(compareSemver('1.10.0', '1.9.99'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('0.9.9', '1.0.0'), -1);
  assert.throws(() => parseSemver('1.7.0-beta.1'), /plain X\.Y\.Z/);
});

test('release resolution preserves an intentional forward bump', () => {
  assert.equal(nextReleaseVersion('1.7.0', '1.6.0'), '1.7.0');
});

test('release resolution increments patch when source changed at the floor', () => {
  assert.equal(nextReleaseVersion('1.7.0', '1.7.0'), '1.7.1');
});

test('release resolution advances from the floor when source metadata lags', () => {
  assert.equal(nextReleaseVersion('1.6.9', '1.7.0'), '1.7.1');
});
