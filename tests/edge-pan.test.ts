import assert from 'node:assert/strict';
import test from 'node:test';
import { edgePanDelta } from '../src/editor/canvas/edge-pan';

const bounds = { left: 120, top: 40, width: 800, height: 600 };

test('the safe canvas interior does not scroll', () => {
  assert.deepEqual(edgePanDelta({ x: 500, y: 300 }, bounds, 16), { x: 0, y: 0 });
  assert.deepEqual(edgePanDelta({ x: 168, y: 88 }, bounds, 16), { x: 0, y: 0 });
});

test('all edges and corners reveal content in the pointer direction', () => {
  assert.deepEqual(edgePanDelta({ x: 120, y: 40 }, bounds, 16), { x: 9.6, y: 9.6 });
  assert.deepEqual(edgePanDelta({ x: 920, y: 640 }, bounds, 16), { x: -9.6, y: -9.6 });
  assert.deepEqual(edgePanDelta({ x: 908, y: 300 }, bounds, 16), { x: -5.4, y: 0 });
});

test('speed eases near the edge and is independent of refresh rate', () => {
  const halfway = edgePanDelta({ x: 144, y: 300 }, bounds, 16).x;
  assert.equal(halfway, 2.4);
  assert.equal(edgePanDelta({ x: 144, y: 300 }, bounds, 32).x, halfway * 2);
  assert.equal(edgePanDelta({ x: 144, y: 300 }, bounds, 8).x, halfway / 2);
});

test('captured pointers outside the canvas and long stalls cannot cause jumps', () => {
  assert.deepEqual(edgePanDelta({ x: 2000, y: -100 }, bounds, 1000), { x: -19.2, y: 19.2 });
  assert.deepEqual(edgePanDelta({ x: 120, y: 40 }, bounds, -10), { x: 0, y: 0 });
});

test('tiny and empty viewports retain a safe interior', () => {
  assert.deepEqual(edgePanDelta({ x: 20, y: 20 }, { left: 0, top: 0, width: 40, height: 40 }, 16), { x: 0, y: 0 });
  assert.deepEqual(edgePanDelta({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 }, 16), { x: 0, y: 0 });
});
