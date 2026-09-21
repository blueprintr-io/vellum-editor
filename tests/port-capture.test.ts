import assert from 'node:assert/strict';
import test from 'node:test';

import type { Shape } from '../src/store/types';
import {
  capturePortNear,
  portCaptureDistFor,
  PORT_CAPTURE_MIN_PX,
  PORT_CAPTURE_PX,
  PORT_TIE_SLACK_PX,
} from '../src/editor/canvas/smart-anchors';

/** Minimal shape fixture - only the fields the anchor math reads. */
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

/** The call sites resolve `wantsExtra` per shape; these tests exercise the
 *  always-present fixed 8, which is what the reported bug was about. */
const opts = {
  captureDist: PORT_CAPTURE_PX,
  tieSlack: PORT_TIE_SLACK_PX,
  wantsExtra: () => false,
};

const outer = shape({ id: 'outer', kind: 'container', x: 0, y: 0, w: 400, h: 300 });

test('captures a nested shape port from just outside its own bbox', () => {
  // The reported bug: the child's left-mid port is at (100, 130), so the
  // natural aim point sits a few px OUTSIDE the child and INSIDE the
  // container. Containment resolution handed that to the container; anchor
  // proximity has to hand it to the child.
  const inner = shape({
    id: 'inner',
    kind: 'rect',
    x: 100,
    y: 100,
    w: 120,
    h: 60,
    parent: 'outer',
  });

  const hit = capturePortNear({ x: 95, y: 130 }, [outer, inner], opts);

  assert.equal(hit?.shape.id, 'inner');
  assert.deepEqual(hit?.anchor, [0, 0.5]);
  assert.deepEqual({ x: hit?.x, y: hit?.y }, { x: 100, y: 130 });
});

test('declines when no port is close enough, leaving containment to decide', () => {
  // Cursor deep in the container's body, far from every anchor on both
  // shapes. Returning null here is what preserves the existing "drag into
  // a shape and it binds" behaviour - the caller falls back to shapeUnder.
  const inner = shape({
    id: 'inner',
    kind: 'rect',
    x: 100,
    y: 100,
    w: 120,
    h: 60,
    parent: 'outer',
  });

  assert.equal(capturePortNear({ x: 300, y: 200 }, [outer, inner], opts), null);
});

test('a flush-mounted child wins the tie against its container', () => {
  // Child pinned to the container's top-left, so the two corner anchors are
  // the same point and raw distance can't separate them. The user aiming at
  // that corner means the child.
  const inner = shape({
    id: 'inner',
    kind: 'rect',
    x: 0,
    y: 0,
    w: 120,
    h: 60,
    parent: 'outer',
  });

  const hit = capturePortNear({ x: 2, y: 2 }, [outer, inner], opts);

  assert.equal(hit?.shape.id, 'inner');
  assert.deepEqual(hit?.anchor, [0, 0]);
});

test("the container's own ports stay reachable outside the tie slack", () => {
  // Container left-mid (0, 150); child's left-mid 10px away at (10, 150).
  // 10 > PORT_TIE_SLACK_PX, so this is not a tie - nearest wins, and the
  // user gets the container port they aimed at.
  const inner = shape({
    id: 'inner',
    kind: 'rect',
    x: 10,
    y: 120,
    w: 120,
    h: 60,
    parent: 'outer',
  });

  const hit = capturePortNear({ x: 0, y: 150 }, [outer, inner], opts);

  assert.equal(hit?.shape.id, 'outer');
  assert.deepEqual(hit?.anchor, [0, 0.5]);
});

test('prefers the smaller shape when two siblings tie', () => {
  const big = shape({ id: 'big', kind: 'rect', x: 0, y: 0, w: 200, h: 200 });
  const small = shape({ id: 'small', kind: 'rect', x: 0, y: 0, w: 60, h: 60 });

  const hit = capturePortNear({ x: 1, y: 1 }, [big, small], opts);

  assert.equal(hit?.shape.id, 'small');
});

test('skips groups and freehand, which render no ports of their own', () => {
  const group = shape({ id: 'group', kind: 'group', x: 0, y: 0, w: 200, h: 200 });
  const scribble = shape({
    id: 'scribble',
    kind: 'freehand',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
  });

  assert.equal(capturePortNear({ x: 2, y: 2 }, [group, scribble], opts), null);
});

test('honours the candidate filter', () => {
  const a = shape({ id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 100 });
  const b = shape({ id: 'b', kind: 'rect', x: 4, y: 0, w: 100, h: 100 });

  const hit = capturePortNear({ x: 1, y: 1 }, [a, b], {
    ...opts,
    filter: (s) => s.id === 'b',
  });

  assert.equal(hit?.shape.id, 'b');
});

test('scales with the capture radius it is given', () => {
  const rect = shape({ id: 'rect', kind: 'rect', x: 0, y: 0, w: 100, h: 100 });

  // 20px from the nearest corner: out of range at the default radius, in
  // range once the caller widens it (which is how zoom is applied - the
  // call sites pass PORT_CAPTURE_PX / zoom).
  assert.equal(capturePortNear({ x: -20, y: 0 }, [rect], opts), null);
  assert.equal(
    capturePortNear({ x: -20, y: 0 }, [rect], { ...opts, captureDist: 30 })
      ?.shape.id,
    'rect',
  );
});

test('captures the port where a ROTATED shape actually draws it', () => {
  // 200×50 bar rotated 90° about its centre (200, 175): its local right-mid
  // port (300, 175) is rendered at the visual BOTTOM, (200, 275). The cursor
  // aims a few px below that dot - 100+ px from where the un-rotated math
  // used to place the port, and outside the un-rotated bbox band entirely.
  const bar = shape({
    id: 'bar',
    kind: 'rect',
    x: 100,
    y: 150,
    w: 200,
    h: 50,
    rotation: 90,
  });

  const hit = capturePortNear({ x: 202, y: 280 }, [bar], opts);

  assert.equal(hit?.shape.id, 'bar');
  assert.deepEqual(hit?.anchor, [1, 0.5]);
  // Reported position and distance are WORLD-space, i.e. the visible dot.
  assert.ok(Math.abs((hit?.x ?? 0) - 200) < 1e-9);
  assert.ok(Math.abs((hit?.y ?? 0) - 275) < 1e-9);
  assert.ok(Math.abs((hit?.dist ?? 0) - Math.hypot(2, 5)) < 1e-9);

  // And the un-rotated position of that same port is now empty space.
  assert.equal(capturePortNear({ x: 302, y: 175 }, [bar], opts), null);
});

/* --- Per-shape capture clamp -------------------------------------------
 *
 * The flat radius scales badly downward: anchors ring the perimeter, so on
 * a small shape every pixel is within PORT_CAPTURE_PX of SOME anchor. Once
 * that shape was selected there was no body left to grab - every press
 * started a connector instead of a drag, and the second press of a
 * double-click drew a line instead of opening the label editor.
 *
 * `minCaptureDist` opts into the clamp; the connector-drag paths leave it
 * off and keep the full radius on every shape. */

test('portCaptureDistFor leaves normal-sized shapes at the full radius', () => {
  // 130×64 service tile: 0.22 × 64 = 14.08, so the clamp doesn't bite.
  assert.equal(portCaptureDistFor({ w: 130, h: 64 }, 14, 7), 14);
  assert.equal(portCaptureDistFor({ w: 400, h: 300 }, 14, 7), 14);
});

test('portCaptureDistFor narrows on small shapes but never below the floor', () => {
  // 44×44 icon → 0.22 × 44 = 9.68.
  assert.ok(Math.abs(portCaptureDistFor({ w: 44, h: 44 }, 14, 7) - 9.68) < 1e-9);
  // 16×16 sliver → 3.52, floored to 7 so the port stays hittable at all.
  assert.equal(portCaptureDistFor({ w: 16, h: 16 }, 14, 7), 7);
  // The floor never EXCEEDS the caller's radius - zoomed way out, a 4px
  // request must not be widened back to 7.
  assert.equal(portCaptureDistFor({ w: 16, h: 16 }, 4, 7), 4);
});

test('the clamp gives a small shape a grabbable interior', () => {
  const icon = shape({ id: 'icon', kind: 'icon', x: 0, y: 0, w: 44, h: 44 });
  const clamped = { ...opts, minCaptureDist: PORT_CAPTURE_MIN_PX };

  // 12px in from the left edge, vertically centred: 12 away from the
  // left-mid port. Inside the flat 14px radius…
  assert.equal(capturePortNear({ x: 12, y: 22 }, [icon], opts)?.shape.id, 'icon');
  // …and outside the clamped 9.68, so the press falls through to drag.
  assert.equal(capturePortNear({ x: 12, y: 22 }, [icon], clamped), null);

  // The dot itself still captures - this is about the body, not the port.
  assert.equal(
    capturePortNear({ x: 2, y: 22 }, [icon], clamped)?.shape.id,
    'icon',
  );
});

test('the clamp is opt-in - connector drags keep the full radius', () => {
  const icon = shape({ id: 'icon', kind: 'icon', x: 0, y: 0, w: 44, h: 44 });
  // Same point as above with the clamp left off (what portUnder passes on
  // the drag paths): still captures, so dropping an endpoint onto a small
  // icon is no harder than before.
  assert.equal(capturePortNear({ x: 12, y: 22 }, [icon], opts)?.shape.id, 'icon');
});
