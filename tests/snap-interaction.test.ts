import assert from 'node:assert/strict';
import test from 'node:test';
import type { Shape } from '../src/store/types';
import { rotatedSnapBounds, snapDrawBox, snapDrawStart, snapMoveBox, snapResizeBox, snapTargets } from '../src/editor/canvas/snap-interaction';
import type { SnapBox } from '../src/editor/canvas/shape-snapping';

const box = (x: number, y = 0, w = 100, h = 100): SnapBox => ({ x, y, w, h });
const shape = (id: string, extra: Partial<Shape> = {}): Shape => ({
  id, kind: 'rect', layer: 'blueprint', ...box(0), ...extra,
});

test('moving within a frame still snaps to sibling gaps while displaying frame margins', () => {
  const proposed = box(256, 180, 80, 60);
  const targets = [box(50, 120, 600, 330), box(100, 180, 80, 60), box(400, 180, 80, 60)];
  const result = snapMoveBox(proposed, proposed, targets, 1, { shape: true, grid: false });
  assert.equal(result.dx, -6);
  assert.equal(result.dy, 0);
  assert.deepEqual(result.hints.map((hint) => hint.kind), ['distance', 'distance']);
  assert.deepEqual(result.hints.flatMap((hint) => hint.gaps.map((gap) => gap.distance)), [200, 320, 60, 210]);
});

test('resizing within a frame retains equal-gap snapping without displaying sibling distances', () => {
  const proposed = box(40, 0, 23, 20);
  const targets = [box(-40, -40, 200, 140), box(0, 0, 20, 20), box(80, 0, 20, 20)];
  const result = snapResizeBox(proposed, proposed, 'e', targets, [], 1, { shape: true, grid: false });
  assert.equal(result.box.w, 20);
  assert.deepEqual(result.hints.flatMap((hint) => hint.gaps.map((gap) => gap.distance)), [80, 100, 40, 80]);
  assert.ok(result.hints.every((hint) => hint.kind === 'distance'));
});

test('resize compares candidates against raw geometry instead of accumulating snaps', () => {
  const proposed = box(10, 0, 90);
  // A size correction of +6 must not make the +13 alignment reachable.
  const result = snapResizeBox(proposed, proposed, 'e', [box(113)], [box(400, 400, 96)], 1,
    { shape: true, grid: false });
  assert.deepEqual(result.box, { ...proposed, w: 96 });
  assert.deepEqual(result.guides.vx, []);
});

test('resize chooses the closest size or edge and favors alignment on a tie', () => {
  const proposed = box(100, 100, 100);
  const closerSize = snapResizeBox(proposed, proposed, 'w', [box(96, 400, 100)], [box(500, 500, 98)], 1,
    { shape: true, grid: false });
  assert.equal(closerSize.box.x, 102);
  assert.equal(closerSize.box.w, 98);
  const tie = snapResizeBox(proposed, proposed, 'w', [box(96, 400, 100)], [box(500, 500, 96)], 1,
    { shape: true, grid: false });
  assert.equal(tie.box.x, 96);
  assert.equal(tie.box.w, 104);
  assert.ok(tie.guides.vx.includes(96));
});

test('an exact size or alignment suppresses grid rounding on its owned axis', () => {
  const proposed = box(11, 13, 100, 70);
  const size = snapResizeBox(proposed, proposed, 'e', [], [box(500, 500, 100)], 1,
    { shape: true, grid: true });
  assert.deepEqual(size.box, proposed);
  const edge = snapResizeBox(proposed, proposed, 'e', [box(111, 500)], [], 1,
    { shape: true, grid: true });
  assert.deepEqual(edge.box, proposed);
  assert.deepEqual(edge.guides.vx, [111]);
});

test('grid fallback snaps only moving edges, follows zoom, and preserves fixed edges', () => {
  const proposed = box(11, 13, 118, 70);
  const east = snapResizeBox(proposed, proposed, 'e', [], [], 2, { shape: false, grid: true });
  assert.deepEqual(east.box, { ...proposed, w: 121 }); // right edge 132, step 12
  const northWest = snapResizeBox(proposed, proposed, 'nw', [], [], 1, { shape: false, grid: true });
  assert.deepEqual(northWest.box, { x: 0, y: 24, w: 129, h: 59 });
  assert.equal(northWest.box.x + northWest.box.w, proposed.x + proposed.w);
  assert.equal(northWest.box.y + northWest.box.h, proposed.y + proposed.h);
  const tiny = box(23, 0, 2, 100);
  assert.deepEqual(snapResizeBox(tiny, tiny, 'e', [], [], 1, { shape: false, grid: true }).box, tiny);
});

test('closer alignment beats a spacing candidate and feedback describes the final box', () => {
  const proposed = box(150, 0, 96);
  const neighbours = [box(0), box(300), box(247, 500)];
  const result = snapResizeBox(proposed, proposed, 'e', neighbours, [], 1, { shape: true, grid: true });
  assert.equal(result.box.w, 97);
  assert.ok(result.guides.vx.includes(247));
  const horizontal = result.hints.filter((hint) => hint.axis === 'horizontal');
  assert.deepEqual(horizontal.flatMap((hint) => hint.gaps.map((gap) => gap.distance)), [50, 53]);
  assert.ok(horizontal.every((hint) => hint.kind === 'distance'));
});

test('resize spacing completes an equal-gap sandwich and beats a farther grid', () => {
  const proposed = box(150, 0, 96);
  const result = snapResizeBox(proposed, proposed, 'e', [box(0), box(300)], [], 1,
    { shape: true, grid: true });
  assert.deepEqual(result.box, { ...proposed, w: 100 });
  const horizontal = result.hints.filter((hint) => hint.axis === 'horizontal');
  assert.deepEqual(horizontal.flatMap((hint) => hint.gaps.map((gap) => gap.distance)), [50, 50]);
  assert.equal(horizontal[0].kind, 'equal');
});

test('a closer sibling size beats equal spacing without painting stale equal gaps', () => {
  const proposed = box(150, 0, 96);
  const result = snapResizeBox(proposed, proposed, 'e', [box(0), box(300)], [box(500, 500, 98)], 1,
    { shape: true, grid: true });
  assert.equal(result.box.w, 98);
  assert.ok(result.hints.every((hint) => hint.kind !== 'equal'));
});

test('turning snaps off leaves geometry unchanged and suppresses guides and distances', () => {
  const proposed = box(11, 13, 100, 70);
  const result = snapResizeBox(proposed, proposed, 'se', [box(111, 83)], [box(500, 500, 100, 70)], 1,
    { shape: false, grid: false });
  assert.deepEqual(result, { box: proposed, guides: { vx: [], hy: [] }, hints: [] });
});

test('local-frame resize can match sizes without snapping to world edges or grid', () => {
  const proposed = box(11, 13, 103, 70);
  const result = snapResizeBox(proposed, proposed, 'e', [box(116, 13)], [box(500, 500, 100)], 1,
    { shape: true, grid: true, align: false });
  assert.deepEqual(result.box, { ...proposed, w: 100 });
  assert.deepEqual(result.guides, { vx: [], hy: [] });
  assert.deepEqual(result.hints, []);
});

test('targets exclude invisible geometry and all descendants of moving frames', () => {
  const frame = shape('frame', { kind: 'group' });
  const child = shape('child', { kind: 'group', parent: frame.id });
  const grandchild = shape('grandchild', { parent: child.id });
  const hidden = shape('hidden', { layer: 'notes' });
  const peer = shape('peer');
  const all = [frame, child, grandchild, hidden, peer];
  const targets = snapTargets([frame, child, grandchild, peer], all, new Set([frame.id]));
  assert.deepEqual(targets.map((target) => target.id), ['peer']);
});

test('targets exclude auto-fitting group ancestors but retain stable container parents', () => {
  const container = shape('container', { kind: 'container' });
  const outer = shape('outer', { kind: 'group', parent: container.id });
  const inner = shape('inner', { kind: 'group', parent: outer.id });
  const child = shape('child', { parent: inner.id });
  const sibling = shape('sibling', { parent: inner.id });
  const peer = shape('peer');
  const all = [container, outer, inner, child, sibling, peer];
  const targets = snapTargets(all, all, new Set([child.id]));
  assert.deepEqual(targets.map((target) => target.id), ['container', 'sibling', 'peer']);
});

test('target ancestor traversal tolerates broken and cyclic parent links', () => {
  const a = shape('a', { kind: 'group', parent: 'b' });
  const b = shape('b', { kind: 'group', parent: 'a' });
  const moving = shape('moving', { parent: 'a' });
  const orphan = shape('orphan', { parent: 'missing' });
  const all = [a, b, moving, orphan];
  assert.deepEqual(snapTargets(all, all, new Set(['moving'])).map((target) => target.id), ['orphan']);
});

test('draw start prioritizes nearby shape references over the grid on each axis', () => {
  const point = { x: 107, y: 313 };
  assert.deepEqual(snapDrawStart(point, [box(100)], 1, { shape: true, grid: true }), { x: 100, y: 312 });
  assert.deepEqual(snapDrawStart(point, [box(100)], 1, { shape: false, grid: true }), { x: 96, y: 312 });
  assert.deepEqual(snapDrawStart(point, [box(100)], 1, { shape: false, grid: false }), point);
});

test('draw snapping preserves the starting corner in every drawing direction', () => {
  const start = { x: 103, y: 107 };
  for (const [cursor, expected] of [
    [{ x: 199, y: 203 }, { x: 103, y: 107, w: 97, h: 93 }],
    [{ x: 7, y: 203 }, { x: 10, y: 107, w: 93, h: 93 }],
    [{ x: 199, y: 13 }, { x: 103, y: 10, w: 97, h: 97 }],
    [{ x: 7, y: 13 }, { x: 10, y: 10, w: 93, h: 97 }],
  ] as const) {
    const result = snapDrawBox(start, cursor, [box(10, 10, 190, 190)], 1,
      { shape: true, grid: false, square: false });
    assert.deepEqual(result.box, expected);
  }
});

test('square drawing preserves its constraint and tiny clicks do not grow from snapping', () => {
  const start = { x: 103, y: 107 };
  const square = snapDrawBox(start, { x: 199, y: 203 }, [box(10, 10, 190, 190)], 1,
    { shape: true, grid: true, square: true });
  assert.deepEqual(square.box, { x: 103, y: 107, w: 96, h: 96 });
  const click = snapDrawBox(start, { x: 104, y: 108 }, [box(10, 10, 190, 190)], 1,
    { shape: true, grid: true, square: false });
  assert.deepEqual(click.box, { x: 103, y: 107, w: 1, h: 1 });
});

test('rotated visual bounds rotate an offset glyph around the owning shape center', () => {
  const owner = { ...box(0, 0, 100, 60), rotation: 90 };
  const glyph = box(10, 5, 40, 20);
  const bounds = rotatedSnapBounds(glyph, owner);
  // Glyph center (30, 15) rotates around owner center (50, 30) to (65, 10).
  for (const [actual, expected] of [[bounds.x, 55], [bounds.y, -10], [bounds.w, 20], [bounds.h, 40]]) {
    assert.ok(Math.abs(actual - expected) < 1e-7);
  }
  assert.deepEqual(rotatedSnapBounds(glyph, { ...owner, rotation: 0 }), glyph);
});

test('translation drops spacing invalidated by a perpendicular alignment', () => {
  const proposed = box(100, 144, 10);
  const targets = [box(95, 0, 6), box(95, 300, 6)];
  const result = snapMoveBox(proposed, proposed, targets, 1, { shape: true, grid: false });
  assert.equal(result.dx, 1);
  assert.equal(result.dy, 0, 'the vertical spacing row no longer overlaps after X alignment');
  assert.deepEqual(result.hints, []);
});

test('translation drops spacing invalidated by perpendicular grid fallback', () => {
  const proposed = box(108, 144);
  const targets = [box(30, 0, 87), box(30, 300, 87)];
  const result = snapMoveBox(proposed, proposed, targets, 1, { shape: true, grid: true });
  assert.equal(result.dx, 12);
  assert.equal(result.dy, 0);
  assert.deepEqual(result.hints, []);
});

test('translation honors frozen axes while retaining supported spacing and real guides', () => {
  const proposed = box(100, 144, 10);
  const targets = [box(95, 0, 6), box(95, 300, 6)];
  const result = snapMoveBox(proposed, proposed, targets, 1, { shape: true, grid: true, lockX: true });
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 6);
  assert.ok(result.hints.some((hint) => hint.axis === 'vertical' && hint.kind === 'equal'));
  const lockedY = snapMoveBox(proposed, proposed, targets, 1, { shape: true, grid: true, lockY: true });
  assert.equal(lockedY.dy, 0);
  assert.deepEqual(lockedY.guides.hy, []);
});

test('translation grid uses raw anchor while alignment uses visible bounds', () => {
  const proposed = box(117, 129, 60, 80);
  const rawAnchor = { x: 107, y: 109 };
  const result = snapMoveBox(proposed, rawAnchor, [], 1, { shape: false, grid: true });
  assert.equal(result.dx, -11);
  assert.equal(result.dy, 11);
});

test('resize drops spacing invalidated by alignment on its perpendicular edge', () => {
  const proposed = box(100, 150, 10, 96);
  const targets = [box(95, 0, 6), box(95, 300, 6)];
  const result = snapResizeBox(proposed, proposed, 'sw', targets, [], 1, { shape: true, grid: false });
  assert.deepEqual(result.box, { x: 101, y: 150, w: 9, h: 96 });
  assert.deepEqual(result.hints, []);
});

test('resize rolls invalidated spacing back to its baseline grid candidate', () => {
  const proposed = box(108, 150, 100, 96);
  const targets = [box(30, 0, 87), box(30, 300, 87)];
  const result = snapResizeBox(proposed, proposed, 'sw', targets, [], 1, { shape: true, grid: true });
  assert.deepEqual(result.box, { x: 120, y: 150, w: 88, h: 90 });
  assert.deepEqual(result.hints, []);
});

test('draw minimum is reflected in preview and removes guides that the floor invalidates', () => {
  const result = snapDrawBox({ x: 0, y: 0 }, { x: 6, y: 20 }, [box(6, 100)], 1,
    { shape: true, grid: false, square: false });
  assert.deepEqual(result.box, { x: 0, y: 0, w: 8, h: 20 });
  assert.deepEqual(result.guides.vx, []);
  const text = snapDrawBox({ x: 0, y: 0 }, { x: 6, y: 20 }, [box(6, 100)], 1,
    { shape: true, grid: false, square: false, minSize: 0 });
  assert.equal(text.box.w, 6);
  assert.deepEqual(text.guides.vx, [6]);
});

test('minimum drawing dimensions preserve the original fixed corner in every direction', () => {
  for (const directionX of [-1, 1]) {
    for (const directionY of [-1, 1]) {
      const result = snapDrawBox({ x: 100, y: 100 }, { x: 100 + 6 * directionX, y: 100 + 5 * directionY }, [], 1,
        { shape: false, grid: false, square: false });
      assert.deepEqual(result.box, {
        x: directionX < 0 ? 92 : 100,
        y: directionY < 0 ? 92 : 100,
        w: 8,
        h: 8,
      });
    }
  }
});
