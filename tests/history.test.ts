import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, DiagramState, Shape } from '../src/store/types';

/** The undo/redo contract, stated once:
 *
 *   - one user action = one history entry - an inspector edit, a canvas
 *     gesture, a slider scrub, an inline text session;
 *   - an edit that changes nothing records nothing;
 *   - undo puts back what was selected before the edit; redo puts back
 *     what was selected when undo was pressed;
 *   - a live gesture whose pointerup forgot to commit still ends up as its
 *     OWN step (sealed by the next atomic edit or by Cmd+Z), never folded
 *     into somebody else's - the failure mode behind "one Cmd+Z threw away
 *     two edits" and "the bend/resize/typing wasn't undoable at all".
 *
 *  These run against the actual store in Node. the recovery adapter
 *  stores preferences through localStorage, and Node ships a stub global
 *  that throws on setItem, so a Map-backed one goes in before the import. */
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

function text(id: string, label: string): Shape {
  return {
    id,
    kind: 'text',
    x: 0,
    y: 200,
    w: 120,
    h: 24,
    layer: 'blueprint',
    label,
  } as Shape;
}

function floatingLine(id: string): Connector {
  return {
    id,
    kind: 'line',
    from: { x: 300, y: 300 },
    to: { x: 400, y: 300 },
    layer: 'blueprint',
  } as Connector;
}

/** Load a two-rect document: history, selection and any pending live
 *  state are wiped by loadDiagram, so every test starts clean. */
function fresh(
  shapes: Shape[] = [rect('a'), rect('b')],
  connectors: Connector[] = [],
) {
  const d = {
    version: '1.0',
    meta: { title: 'history' },
    shapes,
    connectors,
    annotations: [],
  } as unknown as DiagramState;
  st().loadDiagram(d, null);
}

const shape = (id: string) => st().diagram.shapes.find((s) => s.id === id);
const conn = (id: string) => st().diagram.connectors.find((c) => c.id === id);
const sorted = (ids: readonly string[]) => [...ids].sort();

test('an inspector edit is one step; undo restores the value AND the selection, redo re-applies both', () => {
  fresh();
  st().setSelected('a');
  st().updateSelection({ cornerRadius: 12 });
  assert.equal(st().past.length, 1);
  assert.equal(shape('a')!.cornerRadius, 12);

  st().undo();
  assert.equal(shape('a')!.cornerRadius, undefined);
  assert.deepEqual(st().selectedIds, ['a'], 'the inspector must stay on the shape');
  assert.equal(st().future.length, 1);

  st().redo();
  assert.equal(shape('a')!.cornerRadius, 12);
  assert.deepEqual(st().selectedIds, ['a']);
  assert.equal(st().past.length, 1);
  assert.equal(st().future.length, 0);
});

test('an edit that changes nothing records nothing', () => {
  fresh([rect('a'), rect('b')], [floatingLine('k')]);
  st().updateShape('a', { x: 0 });
  st().updateShape('a', { fill: undefined });
  st().updateShape('nope', { x: 5 });
  st().updateConnector('k', { strokeWidth: undefined });
  st().setSelected('a');
  st().updateSelection({ x: 0 });
  st().setSelected(['a', 'b']);
  st().updateSelection({ fill: undefined });
  assert.equal(st().past.length, 0, 'no-op patches must not leave "Cmd+Z did nothing" entries');
  st().updateSelection({ fill: '#ff0000' });
  assert.equal(st().past.length, 1, 'a real change still records');
});

test('a history batch seals a burst of atomic edits as ONE step (slider scrub)', () => {
  fresh();
  st().setSelected('a');
  st().beginHistoryBatch();
  for (let r = 1; r <= 20; r++) st().updateSelection({ cornerRadius: r });
  st().endHistoryBatch();
  assert.equal(st().past.length, 1);
  assert.equal(shape('a')!.cornerRadius, 20);

  st().undo();
  assert.equal(shape('a')!.cornerRadius, undefined, 'one undo takes back the whole scrub');
  assert.deepEqual(st().selectedIds, ['a']);
  st().redo();
  assert.equal(shape('a')!.cornerRadius, 20);
});

test('a batch that changes nothing records nothing; nested brackets seal once', () => {
  fresh();
  st().setSelected('a');
  st().beginHistoryBatch();
  st().updateSelection({ x: 0 });
  st().endHistoryBatch();
  assert.equal(st().past.length, 0);

  st().beginHistoryBatch();
  st().beginHistoryBatch();
  st().updateSelection({ x: 10 });
  st().endHistoryBatch();
  st().updateSelection({ x: 20 });
  assert.equal(st().past.length, 0, 'still inside the outer bracket');
  st().endHistoryBatch();
  assert.equal(st().past.length, 1);
  st().undo();
  assert.equal(shape('a')!.x, 0);
});

test('a live gesture is one step and undo hands the selection back', () => {
  fresh();
  st().setSelected(['a', 'b']);
  for (let i = 1; i <= 10; i++) st().updateShapeLive('a', { x: i * 10 });
  st().commitHistory();
  assert.equal(st().past.length, 1);
  assert.equal(shape('a')!.x, 100);
  st().undo();
  assert.equal(shape('a')!.x, 0);
  assert.deepEqual(sorted(st().selectedIds), ['a', 'b']);
});

test('an un-sealed live edit becomes its OWN step when the next atomic edit lands', () => {
  fresh();
  st().updateShapeLive('a', { x: 50 }); // a gesture whose pointerup forgot to commit
  st().updateShape('b', { x: 70 });
  assert.equal(st().past.length, 2, 'two actions, two entries - never folded into one');
  st().undo();
  assert.equal(shape('b')!.x, 0, 'first undo reverts only the atomic edit');
  assert.equal(shape('a')!.x, 50, 'the leaked gesture survives the first undo');
  st().undo();
  assert.equal(shape('a')!.x, 0);
});

test('Cmd+Z seals an un-sealed live edit and reverts THAT, not the action before it', () => {
  fresh();
  st().updateShape('b', { x: 70 });
  st().updateShapeLive('a', { x: 50 });
  st().undo();
  assert.equal(shape('a')!.x, 0, 'the live edit is what gets undone');
  assert.equal(shape('b')!.x, 70, 'the earlier atomic edit is untouched');
  assert.equal(st().past.length, 1);
  st().redo();
  assert.equal(shape('a')!.x, 50);
});

test('cancelHistory rewinds a live gesture and records nothing', () => {
  fresh();
  st().updateShapeLive('a', { x: 50 });
  st().updateShapeLive('a', { x: 80 });
  st().cancelHistory();
  assert.equal(shape('a')!.x, 0);
  assert.equal(st().past.length, 0);
  assert.equal(st().future.length, 0);
});

test('abandoning a fresh text shape unwinds its creation instead of stacking a delete', () => {
  fresh();
  st().addShape(text('t', ''));
  assert.equal(st().past.length, 1);
  st().updateShapeLive('t', { label: 'hel' });
  st().updateShapeLive('t', { label: '' });
  st().discardEmptyTextShape('t');
  assert.equal(shape('t'), undefined);
  assert.equal(st().past.length, 0, 'the creation entry is gone too');
});

test('emptying a pre-existing text records one step that restores its text', () => {
  fresh([rect('a'), text('t', 'hello')]);
  st().updateShapeLive('t', { label: 'hel' });
  st().updateShapeLive('t', { label: '' });
  st().discardEmptyTextShape('t');
  assert.equal(shape('t'), undefined);
  assert.equal(st().past.length, 1);
  st().undo();
  assert.equal(shape('t')!.label, 'hello');
});

test('undoing a delete hands the shapes back selected; undoing an add restores the prior selection', () => {
  fresh();
  st().setSelected(['a', 'b']);
  st().deleteSelection();
  assert.equal(st().diagram.shapes.length, 0);
  st().undo();
  assert.equal(st().diagram.shapes.length, 2);
  assert.deepEqual(sorted(st().selectedIds), ['a', 'b']);

  st().setSelected('a');
  st().addShape(rect('c'));
  assert.deepEqual(st().selectedIds, ['c']);
  st().undo();
  assert.equal(shape('c'), undefined);
  assert.deepEqual(st().selectedIds, ['a']);
});

test('a restored selection is pruned to ids that still exist', () => {
  fresh();
  useEditor.setState({
    past: [
      { kind: 'diagram', diagram: st().diagram, selectedIds: ['ghost', 'a'] },
    ],
  });
  st().updateShape('a', { x: 5 });
  st().undo();
  st().undo();
  assert.deepEqual(st().selectedIds, ['a']);
});

test('a document load forgets pending live state and any open batch', () => {
  fresh();
  st().beginHistoryBatch();
  st().updateShapeLive('a', { x: 9 });
  fresh(); // load: nothing from the previous document may leak forward
  st().updateShape('a', { x: 1 });
  assert.equal(st().past.length, 1, 'the batch depth reset - snapshots record again');
  const entry = st().past[0];
  assert.equal(entry.kind, 'diagram');
  assert.equal(
    (entry as { diagram: DiagramState }).diagram.shapes.find((s) => s.id === 'a')!.x,
    0,
    'the entry is the freshly loaded document, not the stale live state',
  );
  st().undo();
  assert.equal(shape('a')!.x, 0);
});

test('arrow-key nudges still coalesce into one step', () => {
  fresh();
  st().setSelected('a');
  st().nudgeSelection(1, 0);
  st().nudgeSelection(1, 0);
  st().nudgeSelection(0, 1);
  assert.equal(st().past.length, 1);
  st().undo();
  assert.equal(shape('a')!.x, 0);
  assert.equal(shape('a')!.y, 0);
});
