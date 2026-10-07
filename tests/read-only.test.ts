import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiagramState } from '../src/store/types';

/* A host sets `readOnly` to show a diagram nobody may change. The keymap
 * declines editing chords (tests/e2e/read-only.spec.ts drives those);
 * deleteSelection refuses in the store as well, because Cut, the command
 * palette and the context menu all reach it without going through the
 * keymap. */

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => mem.set(k, v),
    removeItem: (k: string) => mem.delete(k),
  },
});
const { useEditor } = await import('../src/store/editor');
const st = () => useEditor.getState();

const seed = (readOnly: boolean) => {
  const diagram: DiagramState = {
    version: '1.0',
    meta: {},
    shapes: [
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 60, layer: 'blueprint' },
      { id: 'b', kind: 'rect', x: 200, y: 0, w: 100, h: 60, layer: 'blueprint' },
    ],
    connectors: [
      {
        id: 'c',
        from: { shape: 'a', anchor: 'right' },
        to: { shape: 'b', anchor: 'left' },
        routing: 'straight',
      },
    ],
    annotations: [],
  };
  st().loadDiagram(diagram, null);
  // One recorded edit, so the history has something a stray entry would
  // land on top of.
  st().updateShape('a', { label: 'kept' });
  st().setSelected(['a', 'c']);
  useEditor.setState({ readOnly });
};

test('deleteSelection refuses on a read-only canvas: nothing removed, no history entry', () => {
  seed(true);
  const before = st().diagram;
  const past = st().past.length;
  st().deleteSelection();
  // Same object: the action returned before writing anything at all.
  assert.equal(st().diagram, before);
  assert.equal(st().past.length, past);
  assert.deepEqual(st().selectedIds, ['a', 'c']);
});

test('cutSelection on a read-only canvas leaves the diagram and history alone', () => {
  seed(true);
  const before = st().diagram;
  const past = st().past.length;
  st().cutSelection();
  assert.equal(st().diagram, before);
  assert.equal(st().past.length, past);
});

test('the same delete goes through once the host lifts readOnly', () => {
  seed(false);
  const past = st().past.length;
  st().deleteSelection();
  assert.deepEqual(st().diagram.shapes.map((s) => s.id), ['b']);
  assert.deepEqual(st().diagram.connectors, []);
  assert.equal(st().past.length, past + 1);
  assert.deepEqual(st().selectedIds, []);
});
