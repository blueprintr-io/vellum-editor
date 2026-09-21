import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, Shape } from '../src/store/types';
import {
  connectorLayer,
  connectorVisibleInMode,
  shapeVisibleInMode,
  visibleItemIds,
} from '../src/store/layers';
import {
  expandAllDescendants,
  expandGroupDescendants,
  isDescendantOf,
  shapeIndex,
} from '../src/store/hierarchy';

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

test('connectorLayer defaults legacy connectors to Blueprint', () => {
  assert.equal(connectorLayer(conn({ id: 'a' })), 'blueprint');
  assert.equal(connectorLayer(conn({ id: 'b', layer: 'notes' })), 'notes');
});

test('shapeVisibleInMode', () => {
  const n = shape({ id: 'n', layer: 'notes' });
  assert.equal(shapeVisibleInMode(n, 'both'), true);
  assert.equal(shapeVisibleInMode(n, 'notes'), true);
  assert.equal(shapeVisibleInMode(n, 'blueprint'), false);
});

test('connectorVisibleInMode needs its layer AND its bound shapes visible', () => {
  const vis = new Set(['a']);
  const bound = conn({ id: 'c', from: { shape: 'a', anchor: 'auto' }, to: { shape: 'b', anchor: 'auto' } });
  assert.equal(connectorVisibleInMode(bound, 'both', vis), false); // b hidden
  assert.equal(connectorVisibleInMode(bound, 'both', new Set(['a', 'b'])), true);
  const notesLine = conn({ id: 'n', layer: 'notes' });
  assert.equal(connectorVisibleInMode(notesLine, 'blueprint', vis), false);
  assert.equal(connectorVisibleInMode(notesLine, 'notes', vis), true);
});

test('visibleItemIds composes both rules', () => {
  const shapes = [
    shape({ id: 'b1' }),
    shape({ id: 'n1', layer: 'notes' }),
  ];
  const conns = [
    conn({ id: 'cb', from: { shape: 'b1', anchor: 'auto' }, to: { x: 1, y: 1 } }),
    conn({ id: 'cn', layer: 'notes' }),
    conn({ id: 'cx', from: { shape: 'n1', anchor: 'auto' }, to: { x: 1, y: 1 } }),
  ];
  assert.deepEqual([...visibleItemIds(shapes, conns, 'blueprint')], ['b1', 'cb']);
  assert.deepEqual([...visibleItemIds(shapes, conns, 'notes')], ['n1', 'cn']);
  assert.deepEqual([...visibleItemIds(shapes, conns, 'both')].sort(), ['b1', 'cb', 'cn', 'cx', 'n1']);
});

const tree = [
  shape({ id: 'C', kind: 'container' }),
  shape({ id: 'g', kind: 'group', parent: 'C' }),
  shape({ id: 'gm', parent: 'g' }),
  shape({ id: 'k', parent: 'C' }),
  shape({ id: 'loose' }),
];

test('expandAllDescendants walks groups and containers', () => {
  assert.deepEqual([...expandAllDescendants(['C'], tree)].sort(), ['C', 'g', 'gm', 'k']);
  assert.deepEqual([...expandAllDescendants(['g'], tree)].sort(), ['g', 'gm']);
  // Seeds that aren't shapes (connector ids) survive untouched.
  assert.deepEqual([...expandAllDescendants(['line-1'], tree)], ['line-1']);
});

test('expandGroupDescendants stops at container boundaries', () => {
  assert.deepEqual([...expandGroupDescendants(['C'], tree)], ['C']);
  assert.deepEqual([...expandGroupDescendants(['g'], tree)].sort(), ['g', 'gm']);
});

test('isDescendantOf walks the chain and tolerates cycles', () => {
  const byId = shapeIndex(tree);
  assert.equal(isDescendantOf('gm', 'C', byId), true);
  assert.equal(isDescendantOf('C', 'gm', byId), false);
  assert.equal(isDescendantOf('loose', 'C', byId), false);
  const cyc = shapeIndex([
    shape({ id: 'a', parent: 'b' }),
    shape({ id: 'b', parent: 'a' }),
  ]);
  assert.equal(isDescendantOf('a', 'zzz', cyc), false);
});
