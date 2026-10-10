import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeAlignSnap,
  computeAlignmentGuides,
  computeResizeAlignSnap,
  computeResizeSizeSnap,
  preferSpacingSnap,
  type SnapRect,
} from '../src/editor/canvas/alignment-snapping';

const box = (x: number, y = 0, w = 100, h = 100): SnapRect => ({ x, y, w, h });

test('translation aligns edges and centers and includes the threshold boundary', () => {
  const snapped = computeAlignSnap(box(108, 300), [box(100)], 8);
  assert.equal(snapped.dx, -8);
  assert.equal(snapped.dy, 0);
  assert.deepEqual(snapped.vx, [100, 150, 200]);
  assert.deepEqual(snapped.hy, []);
  assert.equal(computeAlignSnap(box(108.01, 300), [box(100)], 8).dx, 0);
});

test('the same eight screen pixel threshold works at different zoom levels', () => {
  for (const zoom of [0.5, 1, 2, 4]) {
    const reference = box(1000);
    const snapped = computeAlignSnap(box(1000 + 7 / zoom, 300), [reference], 8 / zoom);
    assert.equal(snapped.dx, -7 / zoom);
    assert.equal(computeAlignSnap(box(1000 + 9 / zoom, 300), [reference], 8 / zoom).dx, 0);
  }
});

test('equal-distance ties prefer edges to edges over an edge to a center', () => {
  const bbox = box(100, 300, 40);
  const edge = box(98, 0, 160);
  const center = box(52, 0, 100); // center at 102, close to the drag's left edge
  for (const others of [[edge, center], [center, edge]]) {
    assert.equal(computeAlignSnap(bbox, others, 8).dx, -2);
  }
});

test('a closer reference wins even when its reference kind differs', () => {
  const bbox = box(100, 300, 40);
  const edge = box(98, 0, 160);
  const center = box(51, 0, 100);
  assert.equal(computeAlignSnap(bbox, [edge, center], 8).dx, 1);
});

test('equal alignments prefer a nearby row and then a stable coordinate', () => {
  const bbox = box(100, 100, 40, 40);
  const near = box(98, 100, 160, 40);
  const far = box(102, 1000, 160, 40);
  for (const others of [[near, far], [far, near]]) {
    assert.equal(computeAlignSnap(bbox, others, 8).dx, -2);
  }
  const right = { ...far, y: near.y };
  assert.deepEqual(computeAlignSnap(bbox, [near, right], 8), computeAlignSnap(bbox, [right, near], 8));
  assert.equal(computeAlignSnap(bbox, [right, near], 8).dx, -2);
});

test('guides describe actual final coordinates, not half-pixel near misses', () => {
  assert.deepEqual(computeAlignmentGuides(box(100), [box(100.25)]).vx, []);
  const epsilon = computeAlignmentGuides(box(0.1, 0, 0.2), [box(0.3)]);
  assert.deepEqual(epsilon.vx, [0.3]);
  assert.deepEqual(computeAlignmentGuides(box(100), [box(100), box(100)]).vx, [100, 150, 200]);
});

test('closer and exact alignment cannot be stolen by a farther spacing snap', () => {
  assert.equal(preferSpacingSnap(0, true, 4, true), false);
  assert.equal(preferSpacingSnap(2, true, -6, true), false);
  assert.equal(preferSpacingSnap(6, true, -2, true), true);
  assert.equal(preferSpacingSnap(-2, true, 2, true), true);
  assert.equal(preferSpacingSnap(0, false, 4, true), true);
  assert.equal(preferSpacingSnap(0, true, 0, false), false);
});

test('resize snaps only the dragged edges and keeps the opposite edges fixed', () => {
  const original = box(100, 200, 96, 76);
  const target = box(200, 300, 100, 100);
  const east = computeResizeAlignSnap(original, 'e', [target], 8);
  assert.deepEqual(east, { ...original, w: 100, vx: [200], hy: [] });
  const northWest = computeResizeAlignSnap(box(104, 204, 96, 96), 'nw', [box(100, 200)], 8);
  assert.equal(northWest.x, 100);
  assert.equal(northWest.y, 200);
  assert.equal(northWest.x + northWest.w, 200);
  assert.equal(northWest.y + northWest.h, 300);
});

test('resize rejects closer alignment targets that collapse or invert the shape', () => {
  const bbox = box(100, 0, 3, 100);
  const result = computeResizeAlignSnap(bbox, 'e', [box(99, 0, 0.5), box(108)], 8);
  assert.equal(result.x, 100);
  assert.equal(result.w, 8);
  assert.deepEqual(result.vx, [108]);
  const collapsed = computeResizeAlignSnap(box(100, 0, 2), 'e', [box(100, 0, 0)], 8);
  assert.equal(collapsed.w, 2);
  assert.deepEqual(collapsed.vx, []);
});

test('resize uses deterministic nearest candidates including the exact threshold', () => {
  const bbox = box(100, 100, 100, 100);
  const near = box(208, 100, 80, 100);
  const far = box(192, 1000, 80, 100);
  for (const others of [[near, far], [far, near]]) {
    const result = computeResizeAlignSnap(bbox, 'e', others, 8);
    assert.equal(result.w, 108);
    assert.deepEqual(result.vx, [208]);
  }
});

test('an exact sibling size owns its axis even when it needs no correction', () => {
  const next = box(11, 13, 100, 70);
  const result = computeResizeSizeSnap(next, next, 'e', [box(400, 500, 100, 70)], 8);
  assert.deepEqual(result, { ...next, firedX: true, firedY: false });
});

test('sibling sizes preserve fractional dimensions and the opposite corner', () => {
  const start = box(10, 20, 100, 80);
  const next = box(6, 18, 104, 82);
  const result = computeResizeSizeSnap(next, start, 'nw', [box(1000, 1000, 100.25, 80.75)], 8);
  assert.equal(result.w, 100.25);
  assert.equal(result.h, 80.75);
  assert.equal(result.x + result.w, start.x + start.w);
  assert.equal(result.y + result.h, start.y + start.h);
  assert.equal(result.firedX, true);
  assert.equal(result.firedY, true);
});

test('size snaps choose the nearest valid size deterministically without rounding', () => {
  const next = box(0, 0, 100, 70);
  const a = box(200, 200, 98.25, 70);
  const b = box(200, 200, 101.75, 70);
  assert.equal(computeResizeSizeSnap(next, next, 'e', [a, b], 8).w, 98.25);
  assert.equal(computeResizeSizeSnap(next, next, 'e', [b, a], 8).w, 98.25);
  assert.equal(computeResizeSizeSnap(next, next, 'e', [box(200, 200, 108)], 8).w, 108);
  const tiny = box(0, 0, 0.3, 100);
  assert.equal(computeResizeSizeSnap(tiny, tiny, 'e', [box(200, 200, 0)], 8).firedX, false);
});

test('resizing through the fixed edge keeps signed size and anchor semantics', () => {
  const start = box(100, 100, 100, 100);
  const next = box(100, 100, -103, 100);
  const snapped = computeResizeSizeSnap(next, start, 'e', [box(300)], 8);
  assert.equal(snapped.x, 100);
  assert.equal(snapped.w, -100);
  assert.equal(snapped.firedX, true);
});
