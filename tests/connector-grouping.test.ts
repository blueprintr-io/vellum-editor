import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, DiagramState, Shape } from '../src/store/types';

/** Connectors as first-class GROUP MEMBERS.
 *
 *  A line can be parented to a frame two different ways, and the two rules
 *  pull in opposite directions:
 *
 *    - a CONTAINER parent is derived from geometry and re-derived on every
 *      commit (drag the line out of the box, it leaves the box);
 *    - a GROUP parent is user intent and must survive every reconcile, or
 *      the membership the user just asked for evaporates on the next
 *      gesture.
 *
 *  These tests pin that split, plus the frame geometry and the copy/delete
 *  contracts that follow from it.
 *
 *  Same Node harness as history.test.ts: the recovery adapter stores
 *  preferences through localStorage and Node's stub throws, so a Map-backed
 *  one goes in before the store import. */
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  },
});
const { useEditor } = await import('../src/store/editor');

const st = () => useEditor.getState();
const shape = (id: string) => st().diagram.shapes.find((s) => s.id === id);
const conn = (id: string) => st().diagram.connectors.find((c) => c.id === id);
const groupFrame = () => st().diagram.shapes.find((s) => s.kind === 'group');

function rect(id: string, extra: Partial<Shape> = {}): Shape {
  return {
    id,
    kind: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 60,
    layer: 'blueprint',
    ...extra,
  } as Shape;
}

/** A line with both ends floating - the kind a user drags around on its own. */
function line(
  id: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Connector {
  return { id, kind: 'line', from, to, layer: 'blueprint' } as Connector;
}

function fresh(shapes: Shape[], connectors: Connector[] = []) {
  st().loadDiagram(
    {
      version: '1.0',
      meta: { title: 'connector-grouping' },
      shapes,
      connectors,
      annotations: [],
    } as unknown as DiagramState,
    null,
  );
}

test('a shape plus lines is a groupable selection', () => {
  fresh(
    [rect('a', { x: 0, y: 0 })],
    [
      line('c1', { x: 200, y: 10 }, { x: 300, y: 10 }),
      line('c2', { x: 200, y: 40 }, { x: 300, y: 40 }),
    ],
  );
  st().setSelected(['a', 'c1', 'c2']);
  st().groupSelection();

  const g = groupFrame();
  assert.ok(g, 'one shape + two lines has to be enough to form a group');
  assert.equal(shape('a')!.parent, g!.id);
  assert.equal(conn('c1')!.parent, g!.id);
  assert.equal(conn('c2')!.parent, g!.id);
  assert.deepEqual(st().selectedIds, [g!.id]);
});

test('lines alone are a groupable selection', () => {
  fresh(
    [],
    [
      line('c1', { x: 0, y: 0 }, { x: 100, y: 0 }),
      line('c2', { x: 0, y: 50 }, { x: 100, y: 50 }),
    ],
  );
  st().setSelected(['c1', 'c2']);
  st().groupSelection();

  const g = groupFrame();
  assert.ok(g, 'a group of nothing but lines is still a group');
  assert.equal(conn('c1')!.parent, g!.id);
  assert.equal(conn('c2')!.parent, g!.id);
});

test('a single line is not a group', () => {
  fresh([], [line('c1', { x: 0, y: 0 }, { x: 100, y: 0 })]);
  st().setSelected(['c1']);
  st().groupSelection();
  assert.equal(groupFrame(), undefined);
  assert.equal(conn('c1')!.parent, undefined);
});

test('the frame encloses its line members, not just its shapes', () => {
  fresh(
    [rect('a', { x: 0, y: 0, w: 100, h: 60 })],
    [line('c1', { x: 200, y: 10 }, { x: 300, y: 120 })],
  );
  st().setSelected(['a', 'c1']);
  st().groupSelection();

  const g = groupFrame()!;
  // Union is (0,0)…(300,120) padded by GROUP_FRAME_PAD = 12.
  assert.equal(g.x, -12);
  assert.equal(g.y, -12);
  assert.equal(g.w, 324);
  assert.equal(g.h, 144);
});

test('the frame keeps tracking its line members after they move', () => {
  fresh([], [line('c1', { x: 0, y: 0 }, { x: 100, y: 0 })]);
  st().setSelected(['c1']);
  // Two members needed to form the group; add a second line and group both.
  st().addConnector(line('c2', { x: 0, y: 40 }, { x: 100, y: 40 }));
  st().setSelected(['c1', 'c2']);
  st().groupSelection();
  const gid = groupFrame()!.id;

  st().updateConnector('c1', { from: { x: 0, y: -60 }, to: { x: 100, y: -60 } });
  const g = shape(gid)!;
  assert.equal(g.y, -72, 'the derived frame has to follow the line it owns');
  assert.equal(g.h, 40 + 60 + 24);
});

test('group membership survives the connector-parent reconcile', () => {
  // The reconcile pass re-derives CONTAINER parents from geometry on every
  // commit. A line stamped into a group sits outside every container, so a
  // reconcile that treated group parents the same way would strip it.
  fresh(
    [rect('a')],
    [
      line('c1', { x: 200, y: 10 }, { x: 300, y: 10 }),
      line('c2', { x: 200, y: 40 }, { x: 300, y: 40 }),
    ],
  );
  st().setSelected(['c1', 'c2']);
  st().groupSelection();
  const gid = groupFrame()!.id;

  st().setSelected(['a']);
  st().nudgeSelection(10, 0);
  st().commitHistory();
  assert.equal(conn('c1')!.parent, gid, 'the line must still be in its group');
  assert.equal(conn('c2')!.parent, gid);
});

test('a grouped line is not stolen by a container it is dropped into', () => {
  fresh(
    [rect('box', { kind: 'container', x: 0, y: 0, w: 500, h: 500 } as Partial<Shape>)],
    [
      line('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
      line('c2', { x: 100, y: 140 }, { x: 200, y: 140 }),
    ],
  );
  st().setSelected(['c1', 'c2']);
  st().groupSelection();
  const gid = groupFrame()!.id;
  st().commitHistory();
  assert.equal(conn('c1')!.parent, gid);
  assert.equal(conn('c2')!.parent, gid);
});

test('an ungrouped line goes back to geometric container adoption', () => {
  fresh(
    [rect('box', { kind: 'container', x: 0, y: 0, w: 500, h: 500 } as Partial<Shape>)],
    [
      line('c1', { x: 100, y: 100 }, { x: 200, y: 100 }),
      line('c2', { x: 100, y: 140 }, { x: 200, y: 140 }),
    ],
  );
  st().setSelected(['c1', 'c2']);
  st().groupSelection();
  const gid = groupFrame()!.id;

  st().setSelected([gid]);
  st().ungroupSelection();

  assert.equal(groupFrame(), undefined, 'the frame is gone');
  assert.equal(
    conn('c1')!.parent,
    'box',
    'freed lines fall back to the container they sit in',
  );
  assert.deepEqual(
    [...st().selectedIds].sort(),
    ['c1', 'c2'],
    'ungroup leaves the freed members selected',
  );
});

test('deleting the group takes its lines with it', () => {
  fresh(
    [rect('a')],
    [
      line('c1', { x: 200, y: 10 }, { x: 300, y: 10 }),
      line('c2', { x: 200, y: 40 }, { x: 300, y: 40 }),
    ],
  );
  st().setSelected(['a', 'c1', 'c2']);
  st().groupSelection();
  st().deleteSelection();

  assert.equal(st().diagram.shapes.length, 0);
  assert.equal(st().diagram.connectors.length, 0);
});

test('duplicating the group clones its lines and re-points their parent', () => {
  fresh(
    [rect('a')],
    [line('c1', { x: 200, y: 10 }, { x: 300, y: 10 })],
  );
  st().setSelected(['a', 'c1']);
  st().groupSelection();
  const gid = groupFrame()!.id;

  st().duplicateSelection();
  const clones = st().diagram.shapes.filter((s) => s.kind === 'group');
  assert.equal(clones.length, 2);
  const cloneId = clones.find((g) => g.id !== gid)!.id;
  const clonedLine = st().diagram.connectors.find((c) => c.id !== 'c1');
  assert.ok(clonedLine, 'the line has to come along with its group');
  assert.equal(clonedLine!.parent, cloneId, 'and belong to the CLONE');
  assert.equal(conn('c1')!.parent, gid, 'the original stays put');
});

test('a group of lines takes its own layer, not the active one', () => {
  fresh(
    [],
    [
      { ...line('c1', { x: 0, y: 0 }, { x: 100, y: 0 }), layer: 'notes' } as Connector,
      { ...line('c2', { x: 0, y: 40 }, { x: 100, y: 40 }), layer: 'notes' } as Connector,
    ],
  );
  st().setActiveLayer('blueprint');
  st().setSelected(['c1', 'c2']);
  st().groupSelection();
  assert.equal(
    groupFrame()!.layer,
    'notes',
    'a Blueprint frame around Notes lines would be invisible in a Notes view',
  );
});
