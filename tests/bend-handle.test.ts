import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BEND_HANDLE_END_CLEARANCE_PX,
  BEND_HANDLE_LABEL_GAP_PX,
  bendHandlePoint,
  labelBoxAt,
  type LabelBox,
  type Pt,
} from '../src/editor/canvas/connector-label';

/** Zoom 1 - the placement math is world-space, and the callers pre-divide
 *  these by zoom, so testing at 1 exercises the same arithmetic. */
const opts = {
  endClearance: BEND_HANDLE_END_CLEARANCE_PX,
  gap: BEND_HANDLE_LABEL_GAP_PX,
};

/** True when `p` lies inside the label rect - the thing placement exists to
 *  prevent. */
function insideLabel(p: Pt, box: LabelBox): boolean {
  return (
    p.x >= box.cx - box.halfW &&
    p.x <= box.cx + box.halfW &&
    p.y >= box.cy - box.halfH &&
    p.y <= box.cy + box.halfH
  );
}

test('an unlabelled segment keeps its handle at the midpoint', () => {
  const h = bendHandlePoint({ x: 0, y: 0 }, { x: 200, y: 0 }, null, opts);
  assert.deepEqual(h, { x: 100, y: 0 });
});

test('a label parked on the midpoint pushes the handle clear of its rect', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  // Default label position: dead centre of the segment, which is exactly
  // where the handle would otherwise sit.
  const box = labelBoxAt('validates', 200, 0);
  const h = bendHandlePoint(a, b, box, opts);
  assert.ok(h, 'a 400-long segment has room for a handle');
  assert.ok(!insideLabel(h, box), 'handle escaped the label rect');
  // Clear by the full gap, not just kissing the edge.
  assert.ok(
    Math.abs(h.x - box.cx) >= box.halfW + opts.gap - 1e-6,
    `handle at ${h.x} clears ${box.halfW + opts.gap} from centre ${box.cx}`,
  );
  // And it picked the nearer side rather than wandering to an end.
  assert.ok(h.x > box.cx, 'slid to one side, staying on the segment');
});

test('the handle stays clear of the segment ends, where other handles live', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 120, y: 0 };
  const box = labelBoxAt('a fairly long label here', 60, 0);
  const h = bendHandlePoint(a, b, box, opts);
  if (h) {
    assert.ok(
      h.x >= BEND_HANDLE_END_CLEARANCE_PX - 1e-6 &&
        h.x <= 120 - BEND_HANDLE_END_CLEARANCE_PX + 1e-6,
      `handle at ${h.x} respects the end clearance window`,
    );
  }
});

test('a segment too short to clear both ends shows no handle at all', () => {
  // 20 long, 14 of clearance needed at each end - nowhere legal to sit.
  const h = bendHandlePoint({ x: 0, y: 0 }, { x: 20, y: 0 }, null, opts);
  assert.equal(h, null);
});

test('a label swallowing the whole segment leaves the handle at the midpoint', () => {
  // Long label, short line: no clear spot exists on either side. The handle
  // holds the middle and wins the hit-test there; the label keeps the rest,
  // and deselecting the connector gives it back whole.
  const a = { x: 0, y: 0 };
  const b = { x: 60, y: 0 };
  const box = labelBoxAt('this label is much wider than the line', 30, 0);
  const h = bendHandlePoint(a, b, box, opts);
  assert.deepEqual(h, { x: 30, y: 0 });
});

test('a label the segment misses entirely is ignored', () => {
  // Label belongs to this connector but sits on a different segment - the
  // rect is nowhere near this one, so the midpoint stands.
  const box = labelBoxAt('elsewhere', 200, 500);
  const h = bendHandlePoint({ x: 0, y: 0 }, { x: 200, y: 0 }, box, opts);
  assert.deepEqual(h, { x: 100, y: 0 });
});

test('placement works on a diagonal, not just axis-aligned runs', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 300, y: 300 };
  const box = labelBoxAt('curved', 150, 150);
  const h = bendHandlePoint(a, b, box, opts);
  assert.ok(h, 'diagonal segment has room');
  assert.ok(!insideLabel(h, box), 'handle escaped the label rect');
  // Still ON the segment - the handle slides along the line, never off it.
  assert.ok(Math.abs(h.x - h.y) < 1e-6, `(${h.x}, ${h.y}) is on y = x`);
});

test('a vertical segment is clipped correctly (zero dx slab)', () => {
  const a = { x: 50, y: 0 };
  const b = { x: 50, y: 400 };
  const box = labelBoxAt('validates', 50, 200);
  const h = bendHandlePoint(a, b, box, opts);
  assert.ok(h, 'vertical segment has room');
  assert.ok(!insideLabel(h, box), 'handle escaped the label rect');
  assert.equal(h.x, 50, 'stayed on the vertical run');
  assert.ok(
    Math.abs(h.y - box.cy) >= box.halfH + opts.gap - 1e-6,
    `handle at y=${h.y} clears the rect's ${box.halfH} half-height plus gap`,
  );
});

test('a degenerate zero-length segment shows no handle', () => {
  const h = bendHandlePoint({ x: 10, y: 10 }, { x: 10, y: 10 }, null, opts);
  assert.equal(h, null);
});

test('the label box matches the rect Connector.tsx paints', () => {
  // 7px/char advance + 6px side padding, 18 tall. Locked down because three
  // call sites derive from it and a silent drift would desync hit and paint.
  const box = labelBoxAt('abcd', 100, 50);
  assert.deepEqual(box, { cx: 100, cy: 50, halfW: 4 * 3.5 + 6, halfH: 9 });
});
