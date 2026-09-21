import assert from 'node:assert/strict';
import test from 'node:test';

import type { Shape } from '../src/store/types';
import { groupRootOfParent, pickShapeAt } from '../src/editor/canvas/pick';
import { effectiveZMap } from '../src/editor/canvas/z-order';

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

/** Resolve a click the way Canvas's `shapeUnder` does. */
const pick = (
  p: { x: number; y: number },
  shapes: Shape[],
  opts?: Parameters<typeof pickShapeAt>[3],
) => pickShapeAt(p, shapes, effectiveZMap(shapes, []), opts)?.id ?? null;

/* The reported bug: a container dropped inside a big plain rectangle was
 * unselectable. Frames are hit-tested last (so a child sitting on a frame
 * body wins the click), which used to hand EVERY click inside the
 * rectangle to the rectangle - even with the container brought to front. */
const bigRect = shape({ id: 'rect', kind: 'rect', x: 0, y: 0, w: 400, h: 400, z: 1 });
const innerContainer = shape({
  id: 'box',
  kind: 'container',
  x: 100,
  y: 100,
  w: 150,
  h: 150,
  z: 2,
});
const inside = { x: 175, y: 175 };

test('container inside a rectangle wins the click when it is in front', () => {
  assert.equal(pick(inside, [bigRect, innerContainer]), 'box');
  // Array order must not matter - z does.
  assert.equal(pick(inside, [innerContainer, bigRect]), 'box');
});

test('a rectangle in FRONT of the container still wins - paint order rules', () => {
  const front = { ...bigRect, z: 5 };
  assert.equal(pick(inside, [front, innerContainer]), 'rect');
});

test('clicking the rectangle outside the container still selects it', () => {
  assert.equal(pick({ x: 40, y: 40 }, [bigRect, innerContainer]), 'rect');
});

test("a container's own children stay selectable over the frame", () => {
  // Raw z below the frame - the effective-z lift is what puts a member on
  // top of its container, and the block must not undo that.
  const child = shape({ id: 'kid', x: 120, y: 120, w: 40, h: 40, z: 0, parent: 'box' });
  assert.equal(pick({ x: 140, y: 140 }, [bigRect, innerContainer, child]), 'kid');
});

test('a member nested in a group inside the container is still reachable', () => {
  const grp = shape({ id: 'g', kind: 'group', x: 110, y: 110, w: 60, h: 60, z: 0, parent: 'box' });
  const member = shape({ id: 'm', x: 120, y: 120, w: 40, h: 40, z: 0, parent: 'g' });
  // Resolves up to the group (clicking a member selects its group).
  assert.equal(pick({ x: 140, y: 140 }, [bigRect, innerContainer, grp, member]), 'g');
  // Alt-click pierces to the member itself.
  assert.equal(
    pick({ x: 140, y: 140 }, [bigRect, innerContainer, grp, member], { bypassGroup: true }),
    'm',
  );
});

test('nested containers resolve to the inner one', () => {
  const outer = shape({ id: 'outer', kind: 'container', x: 0, y: 0, w: 400, h: 400, z: 1 });
  const inner = shape({ id: 'inner', kind: 'container', x: 100, y: 100, w: 150, h: 150, z: 2, parent: 'outer' });
  assert.equal(pick(inside, [outer, inner]), 'inner');
  assert.equal(pick({ x: 40, y: 40 }, [outer, inner]), 'outer');
});

test('group frames never block a shape underneath them', () => {
  // Groups paint at the very back (outside the z pass), so a high z on the
  // group must not steal a click from a plain shape it overlaps.
  const grp = shape({ id: 'g', kind: 'group', x: 0, y: 0, w: 400, h: 400, z: 99 });
  const loose = shape({ id: 'loose', x: 150, y: 150, w: 50, h: 50, z: 1 });
  assert.equal(pick({ x: 175, y: 175 }, [grp, loose]), 'loose');
});

test('empty canvas point resolves to nothing', () => {
  assert.equal(pick({ x: 900, y: 900 }, [bigRect, innerContainer]), null);
});

test('focused group body is transparent; its members resolve directly', () => {
  const grp = shape({ id: 'g', kind: 'group', x: 0, y: 0, w: 200, h: 200, z: 1 });
  const member = shape({ id: 'm', x: 10, y: 10, w: 30, h: 30, z: 2, parent: 'g' });
  assert.equal(pick({ x: 20, y: 20 }, [grp, member]), 'g');
  assert.equal(pick({ x: 20, y: 20 }, [grp, member], { focusedGroupId: 'g' }), 'm');
  // Empty interior of the focused group → nothing (caller exits focus).
  assert.equal(pick({ x: 150, y: 150 }, [grp, member], { focusedGroupId: 'g' }), null);
});

/* Connectors are group members too, but they don't live in the shape
 * z-order, so a click on one is resolved through `groupRootOfParent`
 * instead of `pickShapeAt`. The rule has to match what a click on a grouped
 * SHAPE does, or a grouped line would behave like a loose one. */
test('a grouped line resolves to its group; a container child does not', () => {
  const grp = shape({ id: 'g', kind: 'group', x: 0, y: 0, w: 200, h: 200 });
  const box = shape({ id: 'box', kind: 'container', x: 0, y: 0, w: 200, h: 200 });
  const shapes = [grp, box];
  assert.equal(groupRootOfParent('g', shapes)?.id, 'g');
  assert.equal(groupRootOfParent('box', shapes), null, 'container children stay their own item');
  assert.equal(groupRootOfParent(undefined, shapes), null);
  assert.equal(groupRootOfParent('gone', shapes), null, 'a dead parent id resolves to the line');
});

test('a grouped line climbs to the OUTERMOST group, and stops at a container', () => {
  const outer = shape({ id: 'outer', kind: 'group', x: 0, y: 0, w: 400, h: 400 });
  const inner = shape({ id: 'inner', kind: 'group', x: 0, y: 0, w: 200, h: 200, parent: 'outer' });
  assert.equal(groupRootOfParent('inner', [outer, inner])?.id, 'outer');

  const box = shape({ id: 'box', kind: 'container', x: 0, y: 0, w: 400, h: 400 });
  const nested = shape({ id: 'nested', kind: 'group', x: 0, y: 0, w: 200, h: 200, parent: 'box' });
  assert.equal(
    groupRootOfParent('nested', [box, nested])?.id,
    'nested',
    'the walk terminates at the container, exactly as it does for shapes',
  );
});

test('Alt-pierce and focus mode both hand the click back to the line', () => {
  const grp = shape({ id: 'g', kind: 'group', x: 0, y: 0, w: 200, h: 200 });
  assert.equal(groupRootOfParent('g', [grp], { bypassGroup: true }), null);
  assert.equal(groupRootOfParent('g', [grp], { focusedGroupId: 'g' }), null);
  // A DIFFERENT group being focused doesn't change this one.
  assert.equal(groupRootOfParent('g', [grp], { focusedGroupId: 'other' })?.id, 'g');
});

test('a group hidden by the layer pill cannot swallow a click on a visible line', () => {
  // `shapes` is the layer-filtered set, so a hidden group simply isn't there.
  assert.equal(groupRootOfParent('g', []), null);
});
