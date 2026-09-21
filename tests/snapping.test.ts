import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gridSnapStep,
  snapPointToGrid,
  snapTranslationToGrid,
} from '../src/editor/canvas/snapping';

test('the snap step follows the grid subdivisions drawn as you zoom in', () => {
  assert.equal(gridSnapStep(0.5), 24);
  assert.equal(gridSnapStep(1), 24);
  assert.equal(gridSnapStep(1.99), 24);
  assert.equal(gridSnapStep(2), 12);
  assert.equal(gridSnapStep(3.5), 12);
  assert.equal(gridSnapStep(4), 6);
  assert.equal(gridSnapStep(8), 6);
  assert.deepEqual(snapPointToGrid({ x: 131, y: 125 }, gridSnapStep(2)), {
    x: 132,
    y: 120,
  });
});

test('snaps a translated shape by its top-left anchor', () => {
  const delta = snapTranslationToGrid(
    { x: 11, y: 13 },
    { x: 17, y: 16 },
  );

  assert.deepEqual(delta, { x: 13, y: 11 });
  assert.deepEqual(
    { x: 11 + delta.x, y: 13 + delta.y },
    { x: 24, y: 24 },
  );
});

test('lets a higher-priority shape snap own one axis', () => {
  const delta = snapTranslationToGrid(
    { x: 11, y: 13 },
    { x: 17, y: 16 },
    { x: false, y: true },
  );

  assert.deepEqual(delta, { x: 17, y: 11 });
});

test('leaves a free-place translation unchanged', () => {
  const delta = snapTranslationToGrid(
    { x: 11, y: 13 },
    { x: 17, y: 16 },
    { x: false, y: false },
  );

  assert.deepEqual(delta, { x: 17, y: 16 });
});

test('snaps a line translation by its semantic from endpoint', () => {
  const from = { x: 11, y: 13 };
  const to = { x: 55, y: 41 };
  const waypoint = { x: 30, y: 20 };
  const delta = snapTranslationToGrid(from, { x: 17, y: 16 });

  assert.deepEqual(delta, { x: 13, y: 11 });
  assert.deepEqual(
    snapPointToGrid({ x: from.x + delta.x, y: from.y + delta.y }),
    { x: 24, y: 24 },
  );
  assert.deepEqual(
    { x: to.x + delta.x, y: to.y + delta.y },
    { x: 68, y: 52 },
  );
  assert.deepEqual(
    { x: waypoint.x + delta.x, y: waypoint.y + delta.y },
    { x: 43, y: 31 },
  );
});

test('preserves an axis lock while snapping the moving axis', () => {
  const horizontal = snapTranslationToGrid(
    { x: 11, y: 13 },
    { x: 17, y: 0 },
    { x: true, y: false },
  );
  const vertical = snapTranslationToGrid(
    { x: 11, y: 13 },
    { x: 0, y: 16 },
    { x: false, y: true },
  );
  const shallowHorizontal = snapTranslationToGrid(
    { x: 23, y: 13 },
    { x: 4, y: 0 },
    { x: true, y: false },
  );

  assert.deepEqual(horizontal, { x: 13, y: 0 });
  assert.deepEqual(vertical, { x: 0, y: 11 });
  assert.deepEqual(shallowHorizontal, { x: 1, y: 0 });
});

test('snaps negative world coordinates consistently', () => {
  assert.deepEqual(snapPointToGrid({ x: -25, y: -47 }), {
    x: -24,
    y: -48,
  });
});
