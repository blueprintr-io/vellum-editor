import assert from 'node:assert/strict';
import test from 'node:test';

import { toggleMarqueeSelection } from '../src/editor/canvas/projection';

test('an additive marquee deselects what it captured that was already selected', () => {
  const result = toggleMarqueeSelection(['a', 'b', 'c'], ['a', 'b']);
  assert.deepEqual(result.selection, ['c']);
  assert.deepEqual(result.dropped, ['a', 'b']);
  assert.deepEqual(result.added, []);
});

test('an additive marquee adds unselected captures and keeps the existing order', () => {
  const result = toggleMarqueeSelection(['c', 'a'], ['b', 'a', 'line']);
  assert.deepEqual(result.selection, ['c', 'b', 'line']);
  assert.deepEqual(result.added, ['b', 'line']);
  assert.deepEqual(result.dropped, ['a']);
});

test('an additive marquee that captures nothing leaves the selection alone', () => {
  assert.deepEqual(toggleMarqueeSelection(['a'], []).selection, ['a']);
  assert.deepEqual(toggleMarqueeSelection([], ['a', 'a']).selection, ['a']);
});
