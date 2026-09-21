import assert from 'node:assert/strict';
import test from 'node:test';

import type { Shape } from '../src/store/types';
import {
  CONTAINER_ICON_PAD,
  GROUP_FRAME_PAD,
  MIN_BOX_SIZE,
  planBoxEdit,
} from '../src/editor/canvas/projection';

/** Minimal fixture - planBoxEdit only reads geometry, kind and parentage. */
function shape(partial: Partial<Shape> & Pick<Shape, 'id'>): Shape {
  return {
    kind: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    layer: 'blueprint',
    ...partial,
  } as Shape;
}

function patchFor(
  res: ReturnType<typeof planBoxEdit>,
  id: string,
): Partial<Shape> {
  const hit = res.patches.find((p) => p.id === id);
  assert.ok(hit, `expected a patch for ${id}`);
  return hit.patch;
}

test('a plain shape takes the typed box verbatim', () => {
  const r = shape({ id: 'r' });
  const res = planBoxEdit(r, { w: 240, h: 120 }, [r]);
  assert.deepEqual(patchFor(res, 'r'), { x: 0, y: 0, w: 240, h: 120 });
  assert.equal(res.dx, 0);
  assert.equal(res.dy, 0);
});

test('omitted axes are left alone', () => {
  const r = shape({ id: 'r', x: 10, y: 20, w: 30, h: 40 });
  const res = planBoxEdit(r, { x: 99 }, [r]);
  assert.deepEqual(patchFor(res, 'r'), { x: 99, y: 20, w: 30, h: 40 });
  assert.equal(res.dx, 89);
  // A pure move is rigid, so the caller carries connector waypoints with it.
  assert.deepEqual([...res.translated], ['r']);
});

test('a no-op edit produces no patches', () => {
  const r = shape({ id: 'r', x: 5, y: 5, w: 50, h: 50 });
  assert.equal(planBoxEdit(r, { x: 5, y: 5, w: 50, h: 50 }, [r]).patches.length, 0);
  assert.equal(planBoxEdit(r, {}, [r]).patches.length, 0);
});

test('zero and negative sizes clamp instead of collapsing the shape', () => {
  const r = shape({ id: 'r' });
  assert.equal(patchFor(planBoxEdit(r, { w: 0 }, [r]), 'r').w, MIN_BOX_SIZE);
  assert.equal(patchFor(planBoxEdit(r, { h: -40 }, [r]), 'r').h, MIN_BOX_SIZE);
});

test('a licence-locked icon scales both axes from whichever one was typed', () => {
  const icon = shape({
    id: 'i',
    kind: 'icon',
    w: 80,
    h: 40,
    iconConstraints: { lockColors: true, lockAspect: true, lockRotation: true },
  });
  const p = patchFor(planBoxEdit(icon, { w: 160 }, [icon]), 'i');
  assert.equal(p.w, 160);
  assert.equal(p.h, 80);
  // …and from the other direction too.
  const q = patchFor(planBoxEdit(icon, { h: 10 }, [icon]), 'i');
  assert.equal(q.w, 20);
  assert.equal(q.h, 10);
});

test('an unlocked icon resizes on one axis', () => {
  const icon = shape({
    id: 'i',
    kind: 'icon',
    w: 80,
    h: 40,
    iconConstraints: { lockColors: true, lockAspect: false, lockRotation: false },
  });
  const p = patchFor(planBoxEdit(icon, { w: 160 }, [icon]), 'i');
  assert.equal(p.w, 160);
  assert.equal(p.h, 40);
});

test('a text box takes wrap width and a height FLOOR, never a literal h', () => {
  const t = shape({ id: 't', kind: 'text', w: 100, h: 20, autoSize: true });
  const p = patchFor(planBoxEdit(t, { w: 300 }, [t]), 't');
  assert.equal(p.w, 300);
  assert.equal(p.autoSize, false, 'a typed width engages wrap mode');
  const q = patchFor(planBoxEdit(t, { h: 90 }, [t]), 't');
  assert.equal(q.minH, 90);
  assert.equal(q.h, undefined, 'h is an auto-fit output - writing it would be reverted');
});

test('moving a group carries its members', () => {
  const g = shape({ id: 'g', kind: 'group', x: 0, y: 0, w: 124, h: 124 });
  const a = shape({ id: 'a', parent: 'g', x: 12, y: 12 });
  const res = planBoxEdit(g, { x: 100 }, [g, a]);
  assert.deepEqual(patchFor(res, 'a'), { x: 112, y: 12, w: 100, h: 100 });
  assert.ok(res.translated.has('a'));
});

test('resizing a group scales its members onto the requested frame', () => {
  // One 100×100 member ⇒ frame is 124×124 (12px pad each side).
  const g = shape({ id: 'g', kind: 'group', x: 0, y: 0, w: 124, h: 124 });
  const a = shape({ id: 'a', parent: 'g', x: 12, y: 12, w: 100, h: 100 });
  const res = planBoxEdit(g, { w: 224 }, [g, a]);
  const p = patchFor(res, 'a');
  // Member scaled so the store's own recalculation (members bbox + pad)
  // lands back on exactly the width that was typed.
  assert.equal(p.w, 200);
  assert.equal(p.x, GROUP_FRAME_PAD);
  assert.equal(p.x! + p.w! + GROUP_FRAME_PAD, 224);
  assert.equal(p.h, 100, 'the untyped axis is untouched');
  assert.equal(res.translated.size, 0, 'a resize is not a rigid move');
});

test('a group with no members behaves like a plain shape', () => {
  const g = shape({ id: 'g', kind: 'group', w: 50, h: 50 });
  assert.deepEqual(patchFor(planBoxEdit(g, { w: 80 }, [g]), 'g'), {
    x: 0,
    y: 0,
    w: 80,
    h: 50,
  });
});

test('moving a container carries its children; resizing it does not', () => {
  const c = shape({ id: 'c', kind: 'container', x: 0, y: 0, w: 200, h: 200 });
  const kid = shape({ id: 'k', parent: 'c', x: 40, y: 40, w: 50, h: 50 });
  const moved = planBoxEdit(c, { x: 30 }, [c, kid]);
  assert.deepEqual(patchFor(moved, 'k'), { x: 70, y: 40 });

  const resized = planBoxEdit(c, { w: 400 }, [c, kid]);
  assert.equal(
    resized.patches.find((p) => p.id === 'k'),
    undefined,
    'children stay put under a resize',
  );
  assert.equal(patchFor(resized, 'c').w, 400);
});

test('a container can never be resized to crop a child', () => {
  const c = shape({ id: 'c', kind: 'container', x: 0, y: 0, w: 200, h: 200 });
  const kid = shape({ id: 'k', parent: 'c', x: 40, y: 40, w: 100, h: 100 });
  // Asking for 60 wide would clip the child at x+w = 140.
  const p = patchFor(planBoxEdit(c, { w: 60 }, [c, kid]), 'c');
  assert.equal(p.w, 140);
});

test("a container's anchor icon rides the frame instead of being translated twice", () => {
  const c = shape({
    id: 'c',
    kind: 'container',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    anchorId: 'ico',
    iconAnchor: 'top-left',
  });
  const ico = shape({ id: 'ico', kind: 'icon', parent: 'c', x: 8, y: 8, w: 24, h: 24 });
  const res = planBoxEdit(c, { x: 100 }, [c, ico]);
  const p = patchFor(res, 'ico');
  // One patch for the anchor, and it is re-seated in the frame's iconAnchor
  // cell rather than translated - the same rule the resize drag follows, so
  // a nudged-out-of-place anchor snaps back to its corner.
  assert.equal(res.patches.filter((q) => q.id === 'ico').length, 1);
  assert.equal(p.x, 100 + CONTAINER_ICON_PAD);
  assert.equal(p.y, CONTAINER_ICON_PAD);
});

test('nested descendants come along', () => {
  const outer = shape({ id: 'o', kind: 'container', x: 0, y: 0, w: 300, h: 300 });
  const inner = shape({ id: 'i', kind: 'container', parent: 'o', x: 20, y: 20, w: 100, h: 100 });
  const leaf = shape({ id: 'l', parent: 'i', x: 30, y: 30, w: 10, h: 10 });
  const res = planBoxEdit(outer, { y: 50 }, [outer, inner, leaf]);
  assert.deepEqual(patchFor(res, 'i'), { x: 20, y: 70 });
  assert.deepEqual(patchFor(res, 'l'), { x: 30, y: 80 });
});
