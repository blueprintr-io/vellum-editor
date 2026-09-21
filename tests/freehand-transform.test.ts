import assert from 'node:assert/strict';
import test from 'node:test';

import type { Shape } from '../src/store/types';
import {
  GROUP_FRAME_PAD,
  mirrorFreehandPoints,
  mirrorTransform,
  normalizeRect,
  planBoxEdit,
  rebaseFreehandPoints,
  scaleFreehandPoints,
  shapeMirror,
  shapeRotation,
  shapeSupportsMirror,
  shapeSupportsRotation,
} from '../src/editor/canvas/projection';

/** A pen stroke as the pen tool commits it: bbox padded by 4 on every side,
 *  points stored relative to (x, y). */
function stroke(partial: Partial<Shape> & Pick<Shape, 'id'>): Shape {
  return {
    kind: 'freehand',
    x: 0,
    y: 0,
    w: 108,
    h: 58,
    layer: 'blueprint',
    points: [
      { x: 4, y: 4 },
      { x: 54, y: 54 },
      { x: 104, y: 4 },
    ],
    ...partial,
  } as Shape;
}

test('scaling the box scales the stroke by the same factors', () => {
  const s = stroke({ id: 'p' });
  const next = scaleFreehandPoints(s.points!, s, { w: 216, h: 29 });
  assert.deepEqual(next, [
    { x: 8, y: 2 },
    { x: 108, y: 27 },
    { x: 208, y: 2 },
  ]);
});

test('a zero start extent leaves that axis alone instead of producing NaN', () => {
  // A dead-straight horizontal stroke has no height to stretch.
  const flat = stroke({
    id: 'flat',
    w: 100,
    h: 0,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
  });
  const next = scaleFreehandPoints(flat.points!, flat, { w: 200, h: 40 });
  assert.deepEqual(next, [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ]);
});

test('dragging a handle past the opposite edge mirrors the stroke', () => {
  const s = stroke({ id: 'p' });
  const next = scaleFreehandPoints(s.points!, s, { w: -108, h: 58 });
  assert.deepEqual(next, [
    { x: -4, y: 4 },
    { x: -54, y: 54 },
    { x: -104, y: 4 },
  ]);
});

test('normalising a flipped box re-bases the points onto the new origin', () => {
  const s = stroke({ id: 'p', x: 200, y: 100 });
  // Mid-drag: the user pulled the E handle 108px left of the W edge.
  const live = { x: s.x, y: s.y, w: -108, h: 58 };
  const points = scaleFreehandPoints(s.points!, s, live);
  const worldBefore = points.map((p) => ({ x: live.x + p.x, y: live.y + p.y }));

  const norm = normalizeRect(live);
  const rebased = rebaseFreehandPoints(points, live, norm);
  const worldAfter = rebased.map((p) => ({ x: norm.x + p.x, y: norm.y + p.y }));

  // The commit tidies the rect without moving a single pixel of ink, and the
  // mirror the user dragged into survives.
  assert.deepEqual(worldAfter, worldBefore);
  assert.equal(norm.w, 108);
  assert.ok(rebased.every((p) => p.x >= 0 && p.x <= norm.w));
});

test('rebasing is identity when the origin did not move', () => {
  const s = stroke({ id: 'p' });
  const same = rebaseFreehandPoints(s.points!, s, s);
  assert.deepEqual(same, s.points);
});

test('flip mirrors the stroke inside its own box', () => {
  const s = stroke({ id: 'p' });
  assert.deepEqual(mirrorFreehandPoints(s.points!, s, 'horizontal'), [
    { x: 104, y: 4 },
    { x: 54, y: 54 },
    { x: 4, y: 4 },
  ]);
  assert.deepEqual(mirrorFreehandPoints(s.points!, s, 'vertical'), [
    { x: 4, y: 54 },
    { x: 54, y: 4 },
    { x: 104, y: 54 },
  ]);
});

test('flipping twice on the same axis is the identity', () => {
  const s = stroke({ id: 'p' });
  const once = mirrorFreehandPoints(s.points!, s, 'horizontal');
  assert.deepEqual(mirrorFreehandPoints(once, s, 'horizontal'), s.points);
});

test('a typed width in the inspector stretches the stroke too', () => {
  const s = stroke({ id: 'p' });
  const res = planBoxEdit(s, { w: 216 }, [s]);
  const patch = res.patches.find((p) => p.id === 'p')!.patch;
  assert.equal(patch.w, 216);
  assert.deepEqual(patch.points, [
    { x: 8, y: 4 },
    { x: 108, y: 54 },
    { x: 208, y: 4 },
  ]);
});

test('a typed move leaves the stroke alone - points are origin-relative', () => {
  const s = stroke({ id: 'p' });
  const res = planBoxEdit(s, { x: 500 }, [s]);
  const patch = res.patches.find((p) => p.id === 'p')!.patch;
  assert.equal(patch.x, 500);
  assert.equal(patch.points, undefined);
});

test('resizing a group scales a freehand member’s stroke with it', () => {
  const g: Shape = {
    id: 'g',
    kind: 'group',
    x: 0,
    y: 0,
    w: 108 + GROUP_FRAME_PAD * 2,
    h: 58 + GROUP_FRAME_PAD * 2,
    layer: 'blueprint',
  } as Shape;
  const member = stroke({ id: 'p', parent: 'g', x: GROUP_FRAME_PAD, y: GROUP_FRAME_PAD });
  const res = planBoxEdit(g, { w: g.w * 2 - GROUP_FRAME_PAD * 2 }, [g, member]);
  const patch = res.patches.find((p) => p.id === 'p')!.patch;
  const sx = patch.w! / member.w;
  assert.ok(sx > 1);
  assert.deepEqual(
    patch.points,
    member.points!.map((p) => ({ x: p.x * sx, y: p.y })),
  );
});

test('freehand rotates; only groups opt out', () => {
  assert.equal(shapeSupportsRotation({ kind: 'freehand' }), true);
  assert.equal(shapeSupportsRotation({ kind: 'group' }), false);
  assert.equal(shapeRotation(stroke({ id: 'p', rotation: 30 })), 30);
  assert.equal(
    shapeRotation({ id: 'g', kind: 'group', x: 0, y: 0, w: 1, h: 1, layer: 'blueprint', rotation: 30 } as Shape),
    0,
  );
});

/* ── Mirror ─────────────────────────────────────────────────────────────
 *
 * A bitmap or a chunk of embedded icon markup has no geometry to bake a
 * flip into, so `flipH`/`flipV` are render-time flags. These guard the two
 * things that must stay true of them: the transform reflects the box onto
 * ITSELF (so selection bounds stay unchanged), and kinds that
 * would render text backwards never mirror at all. */

function img(partial: Partial<Shape> = {}): Shape {
  return {
    id: 'i',
    kind: 'image',
    x: 100,
    y: 40,
    w: 200,
    h: 80,
    layer: 'blueprint',
    ...partial,
  } as Shape;
}

/** Apply an SVG `translate(tx ty) scale(sx sy)` string to a point. */
function applyTransform(t: string, p: { x: number; y: number }) {
  const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+) (-?[\d.]+)\)$/.exec(t);
  assert.ok(m, `unparseable transform: ${t}`);
  const [tx, ty, sx, sy] = m.slice(1).map(Number);
  return { x: tx + p.x * sx, y: ty + p.y * sy };
}

test('an unflipped shape gets no transform at all', () => {
  assert.equal(mirrorTransform(img()), undefined);
  assert.equal(mirrorTransform(img({ flipH: false, flipV: false })), undefined);
});

test('the mirror maps the bbox onto itself', () => {
  for (const flags of [{ flipH: true }, { flipV: true }, { flipH: true, flipV: true }]) {
    const s = img(flags);
    const t = mirrorTransform(s)!;
    const corners = [
      { x: s.x, y: s.y },
      { x: s.x + s.w, y: s.y + s.h },
    ].map((c) => applyTransform(t, c));
    for (const c of corners) {
      assert.ok(c.x >= s.x - 1e-9 && c.x <= s.x + s.w + 1e-9, `x ${c.x} escaped the box`);
      assert.ok(c.y >= s.y - 1e-9 && c.y <= s.y + s.h + 1e-9, `y ${c.y} escaped the box`);
    }
    // …and it is a reflection, not a translation: the left edge lands on the
    // right (or the top on the bottom).
    const nw = applyTransform(t, { x: s.x, y: s.y });
    if (flags.flipH) assert.equal(nw.x, s.x + s.w);
    if (flags.flipV) assert.equal(nw.y, s.y + s.h);
  }
});

test('mirroring twice is the identity', () => {
  const s = img({ flipH: true });
  const t = mirrorTransform(s)!;
  const p = { x: 137, y: 63 };
  assert.deepEqual(applyTransform(t, applyTransform(t, p)), p);
});

test('kinds whose body carries text never mirror', () => {
  // A table paints its cell text inside the body; a group has no body; a
  // stroke mirrors through `points` instead, so a flag would double-apply.
  for (const kind of ['table', 'group', 'freehand'] as const) {
    assert.equal(shapeSupportsMirror({ kind }), false);
    assert.deepEqual(shapeMirror({ kind, flipH: true, flipV: true }), {
      h: false,
      v: false,
    });
    assert.equal(mirrorTransform({ ...img({ flipH: true }), kind }), undefined);
  }
  for (const kind of ['image', 'icon', 'rect', 'ellipse', 'note', 'text'] as const) {
    assert.equal(shapeSupportsMirror({ kind }), true);
  }
});
