import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, Shape } from '../src/store/types';
import {
  CONTAINER_CHILD_Z_LIFT,
  effectiveZMap,
  nextZ,
  orderByZ,
  reorderZ,
} from '../src/editor/canvas/z-order';

/** Minimal shape fixture - only the fields the z-order math reads. */
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

function conn(partial: Partial<Connector> & Pick<Connector, 'id'>): Connector {
  return {
    from: { x: 0, y: 0 },
    to: { x: 10, y: 10 },
    routing: 'straight',
    ...partial,
  } as Connector;
}

/** Bottom-to-top ids, the way the canvas would paint them. */
const paintOrder = (shapes: Shape[], connectors: Connector[] = []) =>
  orderByZ(shapes, connectors, effectiveZMap(shapes, connectors)).map(
    (it) => it.item.id,
  );

const zOf = (items: Array<{ id: string; z?: number }>) =>
  Object.fromEntries(items.map((s) => [s.id, s.z]));

/* The scenario from the bug report: an outsider O, a container C drawn
 * later (so it out-ranks O), and a member K whose raw z is BELOW O. */
const O = shape({ id: 'O', z: 50 });
const C = shape({ id: 'C', kind: 'container', z: 100 });
const K = shape({ id: 'K', z: 5, parent: 'C' });

test('effectiveZMap lifts a container member above its frame', () => {
  const eff = effectiveZMap([O, C, K], []);
  assert.equal(eff.get('O'), 50);
  assert.equal(eff.get('C'), 100);
  assert.equal(eff.get('K'), 100 + CONTAINER_CHILD_Z_LIFT);
});

test('effectiveZMap keeps a member that already out-ranks its frame', () => {
  const eff = effectiveZMap([C, shape({ id: 'K', z: 250, parent: 'C' })], []);
  assert.equal(eff.get('K'), 250);
});

test('effectiveZMap chains through nested containers', () => {
  const inner = shape({ id: 'inner', kind: 'container', z: 1, parent: 'C' });
  const leaf = shape({ id: 'leaf', z: 2, parent: 'inner' });
  const eff = effectiveZMap([C, inner, leaf], []);
  assert.equal(eff.get('inner'), 100.5);
  assert.equal(eff.get('leaf'), 101);
});

test('effectiveZMap: groups impose no floor, containers lift connectors too', () => {
  const g = shape({ id: 'g', kind: 'group', z: 90 });
  const member = shape({ id: 'm', z: 3, parent: 'g' });
  const line = conn({ id: 'line', z: 7, parent: 'C' });
  const eff = effectiveZMap([C, g, member], [line]);
  assert.equal(eff.get('m'), 3);
  assert.equal(eff.get('line'), 100.5);
});

test('effectiveZMap survives a parent cycle', () => {
  const a = shape({ id: 'a', kind: 'container', z: 1, parent: 'b' });
  const b = shape({ id: 'b', kind: 'container', z: 2, parent: 'a' });
  const eff = effectiveZMap([a, b], []);
  assert.ok(Number.isFinite(eff.get('a')));
  assert.ok(Number.isFinite(eff.get('b')));
});

test('orderByZ paints the member above the outsider it out-ranks only effectively', () => {
  assert.deepEqual(paintOrder([O, C, K]), ['O', 'C', 'K']);
});

test('orderByZ ties: shapes before connectors, then array order', () => {
  const a = shape({ id: 'a', z: 1 });
  const b = shape({ id: 'b', z: 1 });
  const l = conn({ id: 'l', z: 1 });
  assert.deepEqual(paintOrder([b, a], [l]), ['b', 'a', 'l']);
});

test('nextZ clears the effective top, not just the raw one', () => {
  // K's effective z is 100.5 - a new item at 101 would TIE with a lifted
  // nested leaf at 101; floor(max eff) + 1 is always strictly above.
  assert.equal(nextZ([O, C, K], []), 101);
  const inner = shape({ id: 'inner', kind: 'container', z: 1, parent: 'C' });
  const leaf = shape({ id: 'leaf', z: 2, parent: 'inner' });
  assert.equal(nextZ([C, inner, leaf], []), 102);
});

const run = (
  shapes: Shape[],
  selectedIds: string[],
  op: Parameters<typeof reorderZ>[1],
  connectors: Connector[] = [],
  layerMode: 'notes' | 'both' | 'blueprint' = 'both',
) => reorderZ({ shapes, connectors, selectedIds, layerMode }, op);

test('sendToBack on a container takes its members with it', () => {
  // Bug: only the frame moved, K (raw 60) stayed floating above O.
  const K60 = shape({ id: 'K', z: 60, parent: 'C' });
  const next = run([O, C, K60], ['C'], 'back');
  assert.ok(next);
  assert.deepEqual(paintOrder(next.shapes), ['C', 'K', 'O']);
  assert.deepEqual(zOf(next.shapes), { O: 3, C: 1, K: 2 });
});

test('bringToFront on a container keeps the frame behind its members', () => {
  const above = shape({ id: 'O', z: 150 });
  assert.deepEqual(paintOrder([C, K, above]), ['C', 'K', 'O']);
  const next = run([C, K, above], ['C'], 'front');
  assert.ok(next);
  assert.deepEqual(paintOrder(next.shapes), ['O', 'C', 'K']);
  // Frame + members already on top: a no-op, not a z rewrite.
  assert.equal(run([O, C, K], ['C'], 'front'), null);
});

test('front/back carry connectors a container owns', () => {
  const line = conn({ id: 'line', z: 70, parent: 'C' });
  const free = conn({ id: 'free', z: 200 });
  const next = run([O, C, K], ['C'], 'back', [line, free]);
  assert.ok(next);
  assert.deepEqual(paintOrder(next.shapes, next.connectors), [
    'C',
    'K',
    'line',
    'O',
    'free',
  ]);
});

test('bringForward on an outsider steps between a frame and its members', () => {
  // One visible step at a time: O clears the frame first, the member next.
  const step1 = run([O, C, K], ['O'], 'forward');
  assert.ok(step1);
  assert.deepEqual(paintOrder(step1.shapes), ['C', 'O', 'K']);
  const step2 = run(step1.shapes, ['O'], 'forward');
  assert.ok(step2);
  assert.deepEqual(paintOrder(step2.shapes), ['C', 'K', 'O']);
  // Already on top - a no-op, not a spurious history entry.
  assert.equal(run(step2.shapes, ['O'], 'forward'), null);
});

test('sendBackward on a member stops at its own container', () => {
  // K sits directly above C: there is nothing to sink below.
  assert.equal(run([O, C, K], ['K'], 'backward'), null);
  // With an outsider wedged between frame and member, K can drop below it.
  const wedged = [
    shape({ id: 'C', kind: 'container', z: 1 }),
    shape({ id: 'O', z: 2 }),
    shape({ id: 'K', z: 3, parent: 'C' }),
  ];
  const next = run(wedged, ['K'], 'backward');
  assert.ok(next);
  assert.deepEqual(paintOrder(next.shapes), ['C', 'K', 'O']);
});

test('sendToBack on a member parks it just above its container', () => {
  const X = shape({ id: 'X', z: 200 });
  const K300 = shape({ id: 'K', z: 300, parent: 'C' });
  assert.deepEqual(paintOrder([O, C, X, K300]), ['O', 'C', 'X', 'K']);
  const next = run([O, C, X, K300], ['K'], 'back');
  assert.ok(next);
  // Raw z is below the frame but the effective order keeps K above it -
  // "as far back as a member can go" is directly above its container.
  assert.deepEqual(paintOrder(next.shapes), ['O', 'C', 'K', 'X']);
  // Already directly above its container: nothing visible would change,
  // so the store gets a no-op instead of a compaction + history entry.
  assert.equal(run([O, C, K300], ['K'], 'back'), null);
});

test('forward/backward skip items on a hidden layer', () => {
  const hidden = shape({ id: 'H', z: 75, layer: 'notes' });
  // In a Blueprint-only view the Notes rect between O and C is invisible;
  // stepping O forward must clear C, not just the hidden H.
  const next = run([O, hidden, C, K], ['O'], 'forward', [], 'blueprint');
  assert.ok(next);
  assert.deepEqual(paintOrder(next.shapes), ['H', 'C', 'O', 'K']);
  // Nothing visible above the selection: no-op even though H is there.
  const top = shape({ id: 'T', z: 500 });
  const hiddenTop = shape({ id: 'HT', z: 600, layer: 'notes' });
  assert.equal(run([O, top, hiddenTop], ['T'], 'forward', [], 'blueprint'), null);
});

test('reorderZ compacts to 1..N and leaves untouched items referentially equal', () => {
  const next = run([O, C, K], ['O'], 'forward');
  assert.ok(next);
  assert.deepEqual(
    [...next.shapes].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((s) => s.z),
    [1, 2, 3],
  );
  // Every z changed here, so every object is new - but the arrays keep
  // their original order.
  assert.deepEqual(next.shapes.map((s) => s.id), ['O', 'C', 'K']);
  // A second call that changes only one item keeps the rest identical.
  const again = run(next.shapes, ['O'], 'forward');
  assert.ok(again);
  assert.equal(again.shapes[1], next.shapes[1]); // C untouched
});

test('reorderZ expands nested groups inside a selected frame', () => {
  const g = shape({ id: 'g', kind: 'group', z: 10, parent: 'C' });
  const gm = shape({ id: 'gm', z: 11, parent: 'g' });
  const next = run([O, C, K, g, gm], ['C'], 'back');
  assert.ok(next);
  const order = paintOrder(next.shapes);
  assert.equal(order.indexOf('O'), order.length - 1);
  assert.ok(order.indexOf('gm') < order.indexOf('O'));
});

test('reorderZ: empty or stale selection is a no-op', () => {
  assert.equal(run([O, C, K], [], 'front'), null);
  assert.equal(run([O, C, K], ['nope'], 'front'), null);
});
