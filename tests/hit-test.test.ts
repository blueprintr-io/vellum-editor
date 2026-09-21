import assert from 'node:assert/strict';
import test from 'node:test';

import type { Shape } from '../src/store/types';
import {
  EDGE_SNAP_BAND,
  fromShapeLocal,
  pointInShape,
  pointInShapeCenterZone,
  pointInShapeEdgeBand,
  pointNearShape,
  rotatePoint,
  shapeRotation,
  toShapeLocal,
} from '../src/editor/canvas/projection';
import { nearestSmartAnchor } from '../src/editor/canvas/smart-anchors';
import { shapeAnchorWorldPoint } from '../src/editor/canvas/routing';
// `cellAtPoint` (Shape.tsx) applies the same `toShapeLocal` step; it isn't
// imported here because Shape.tsx pulls React + browser-only deps into the
// node runner. Its rotated behaviour is covered by the toShapeLocal cases.

/** Minimal shape fixture - only the fields the hit-test math reads. */
function shape(partial: Partial<Shape> & Pick<Shape, 'id' | 'kind'>): Shape {
  return {
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    layer: 'blueprint',
    ...partial,
  } as Shape;
}

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

/* A wide, short rect rotated 90° about its centre. Its bbox is x 100..300,
 * y 150..200 (centre 200,175); rotated it VISUALLY occupies x 175..225,
 * y 75..275 - a tall, thin bar. The reported bug: hover / click still used
 * the un-rotated wide bbox, so the mouseover area didn't follow the shape. */
const bar = shape({
  id: 'bar',
  kind: 'rect',
  x: 100,
  y: 150,
  w: 200,
  h: 50,
  rotation: 90,
});

test('rotatePoint follows the SVG rotate(deg cx cy) convention', () => {
  // +90° (clockwise on screen, y-down) takes a point to the RIGHT of the
  // centre to a point BELOW it.
  const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
  close(p.x, 0);
  close(p.y, 10);
  // Zero rotation is the identity object, not a copy.
  const q = { x: 3, y: 4 };
  assert.equal(rotatePoint(q, { x: 0, y: 0 }, 0), q);
});

test('toShapeLocal / fromShapeLocal round-trip about the bbox centre', () => {
  const world = { x: 190, y: 90 };
  const local = toShapeLocal(world, bar);
  const back = fromShapeLocal(local, bar);
  close(back.x, world.x);
  close(back.y, world.y);
  // Un-rotated shape: identity.
  const flat = shape({ id: 'flat', kind: 'rect' });
  assert.equal(toShapeLocal(world, flat), world);
});

test('shapeRotation ignores rotation on kinds that never render rotated', () => {
  // Groups are the only opt-out: their members are independent shapes, so
  // spinning the frame's <g> would leave the contents behind.
  assert.equal(shapeRotation(shape({ id: 'g', kind: 'group', rotation: 45 })), 0);
  assert.equal(shapeRotation(shape({ id: 'r', kind: 'rect', rotation: 45 })), 45);
  // A pen stroke renders inside the same rotated <g> as every other body.
  assert.equal(
    shapeRotation(shape({ id: 'f', kind: 'freehand', rotation: 45 })),
    45,
  );
  assert.equal(shapeRotation(shape({ id: 'n', kind: 'rect', rotation: NaN })), 0);
});

test('pointInShape hits the ROTATED footprint, not the stored bbox', () => {
  // Inside the visual bar (tall & thin), outside the stored bbox.
  assert.equal(pointInShape({ x: 200, y: 90 }, bar), true);
  assert.equal(pointInShape({ x: 200, y: 260 }, bar), true);
  // Inside the stored (wide) bbox, but visually empty canvas now.
  assert.equal(pointInShape({ x: 110, y: 175 }, bar), false);
  assert.equal(pointInShape({ x: 290, y: 175 }, bar), false);
  // Just outside the visual bar's side edges.
  assert.equal(pointInShape({ x: 174, y: 175 }, bar), false);
  assert.equal(pointInShape({ x: 226, y: 175 }, bar), false);
  // Centre is always inside.
  assert.equal(pointInShape({ x: 200, y: 175 }, bar), true);
});

test('pointInShape at an oblique angle', () => {
  // 100×100 square at origin rotated 45° - its visual footprint is a
  // diamond with vertices ~70.7 from the centre along the axes.
  const sq = shape({ id: 'sq', kind: 'rect', x: 0, y: 0, w: 100, h: 100, rotation: 45 });
  // The stored bbox corner (0,0) is now OUTSIDE (the diamond's edge passes
  // ~20.7 units inside of it along the diagonal).
  assert.equal(pointInShape({ x: 2, y: 2 }, sq), false);
  // The point 65 units straight up from the centre is inside the diamond
  // (vertex at ~70.7) but OUTSIDE the stored bbox (top edge at y=0).
  assert.equal(pointInShape({ x: 50, y: -15 }, sq), true);
  assert.equal(pointInShape({ x: 50, y: -21 }, sq), false);
});

test('un-rotated shapes keep the exact AABB behaviour', () => {
  const r = shape({ id: 'r', kind: 'rect', x: 10, y: 20, w: 30, h: 40 });
  assert.equal(pointInShape({ x: 10, y: 20 }, r), true);
  assert.equal(pointInShape({ x: 40, y: 60 }, r), true);
  assert.equal(pointInShape({ x: 9.999, y: 30 }, r), false);
  assert.equal(pointInShape({ x: 25, y: 60.001 }, r), false);
});

test('groups never rotate - a stray rotation is ignored by the hit-test', () => {
  const g = shape({ id: 'g', kind: 'group', x: 100, y: 150, w: 200, h: 50, rotation: 90 });
  // Same geometry as `bar` but a group: the un-rotated bbox is the hit zone.
  assert.equal(pointInShape({ x: 110, y: 175 }, g), true);
  assert.equal(pointInShape({ x: 200, y: 90 }, g), false);
});

test('pointNearShape measures the band from the rotated edges', () => {
  // 10 units left of the visual bar's left edge (x=175) → within a 14 band.
  assert.equal(pointNearShape({ x: 165, y: 175 }, bar, 14), true);
  assert.equal(pointNearShape({ x: 160, y: 175 }, bar, 14), false);
  // 10 units above the visual top (y=75) → within band; the same point is
  // 65 units from the stored bbox, which would have failed before.
  assert.equal(pointNearShape({ x: 200, y: 65 }, bar, 14), true);
  // Deep inside the stored bbox but 40+ units from the visual bar → out.
  assert.equal(pointNearShape({ x: 110, y: 175 }, bar, 14), false);
});

test('edge band and centre zone rotate with the shape', () => {
  // Visual bar spans x 175..225 (50 wide) and y 75..275 (200 tall). Its
  // LOCAL long axis is x, so the edge band near a visual short end (top,
  // y≈75) is the local LEFT band.
  assert.equal(pointInShapeEdgeBand({ x: 200, y: 80 }, bar, EDGE_SNAP_BAND), true);
  // Visual centre-line, well away from every edge → not edge band…
  assert.equal(pointInShapeEdgeBand({ x: 200, y: 175 }, bar, EDGE_SNAP_BAND), false);
  // …but the centre zone (bbox-aligned, so it rotates too) catches it.
  assert.equal(pointInShapeCenterZone({ x: 200, y: 175 }, bar, EDGE_SNAP_BAND), true);
  // Centre-zone half-extents: local x → 200*0.18 = 36, local y →
  // max(10, 50*0.18) = 10 (fits inside the 14-unit edge band, so the zone
  // exists). Rotated 90° the 36 runs VERTICALLY in world (y 139..211) and
  // the 10 runs horizontally (x 190..210).
  assert.equal(pointInShapeCenterZone({ x: 200, y: 215 }, bar, EDGE_SNAP_BAND), false);
  assert.equal(pointInShapeCenterZone({ x: 211, y: 175 }, bar, EDGE_SNAP_BAND), false);
  assert.equal(pointInShapeCenterZone({ x: 209, y: 175 }, bar, EDGE_SNAP_BAND), true);
});

test('shapeAnchorWorldPoint orbits the anchor about the bbox centre', () => {
  // Local right-mid of `bar` is (300, 175); after +90° it sits at the
  // visual BOTTOM (200, 275).
  const [x, y] = shapeAnchorWorldPoint(bar, [1, 0.5]);
  close(x, 200);
  close(y, 275);
  // Un-rotated: same as the local point.
  const flat = shape({ id: 'flat', kind: 'rect', x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(shapeAnchorWorldPoint(flat, [1, 0.5]), [100, 25]);
});

test('nearestSmartAnchor searches in the rotated frame and returns world coords', () => {
  // Cursor just below the visual bottom end of the bar → nearest dot is
  // the local right-mid, which the user sees at (200, 275).
  const hit = nearestSmartAnchor(bar, { x: 202, y: 280 }, false);
  assert.ok(hit);
  assert.deepEqual(hit.anchor, [1, 0.5]);
  close(hit.x, 200);
  close(hit.y, 275);
  // The same cursor is nowhere near the un-rotated right-mid (300, 175);
  // a maxDist tight enough to exclude that still captures the visual dot.
  const tight = nearestSmartAnchor(bar, { x: 202, y: 280 }, false, 8, 10);
  assert.ok(tight);
  assert.deepEqual(tight.anchor, [1, 0.5]);
});

test('a rotated table maps world points onto the local row/col grid', () => {
  // The un-rotation `cellAtPoint` performs before scanning row/col edges:
  // 200×100 table at origin rotated 90° → visually x 50..150, y -50..150.
  // Local col 1 (x 100..200) rotates to the visual BOTTOM half (y 50..150)
  // and local row 0 (y 0..50) to the visual RIGHT half (x 100..150), so
  // the visual bottom-right lands in local (col 1, row 0).
  const table = shape({
    id: 't',
    kind: 'table',
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    rotation: 90,
  });
  const local = toShapeLocal({ x: 125, y: 125 }, table);
  close(local.x, 175); // col 1 (100..200)
  close(local.y, 25); //  row 0 (0..50)
  const local2 = toShapeLocal({ x: 75, y: -25 }, table);
  close(local2.x, 25); //  col 0
  close(local2.y, 75); //  row 1
});
