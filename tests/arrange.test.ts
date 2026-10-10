import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangeTargets, DEFAULT_ARRANGE_GAP, normalizeArrangeGap, planArrange, type ArrangeCommand } from '../src/store/arrange';
import type { Connector, DiagramState, Shape } from '../src/store/types';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
  },
});
const { useEditor } = await import('../src/store/editor');
const state = () => useEditor.getState();
const shape = (id: string) => state().diagram.shapes.find((item) => item.id === id)!;
const rect = (id: string, extra: Partial<Shape> = {}): Shape => ({
  id, kind: 'rect', x: 0, y: 0, w: 100, h: 60, layer: 'blueprint', ...extra,
});
const line = (id: string, extra: Partial<Connector> = {}): Connector => ({
  id, from: { x: 50, y: 30 }, to: { x: 80, y: 80 }, routing: 'straight', ...extra,
});
function fresh(shapes: Shape[], connectors: Connector[] = [], selectedIds = shapes.map((s) => s.id)) {
  const diagram: DiagramState = { version: '1.0', meta: {}, shapes, connectors, annotations: [] };
  state().loadDiagram(diagram, null);
  useEditor.setState({ readOnly: false, layerMode: 'both' });
  state().setSelected(selectedIds);
}
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test('arrangement roots preserve selection order, skip hidden/owned geometry and omit selected descendants', () => {
  const shapes = [
    rect('parent', { kind: 'container' }), rect('child', { parent: 'parent' }),
    rect('first'), rect('hidden', { layer: 'notes' }), rect('rack-part', { rackUnit: { u: 1 } }),
  ];
  assert.deepEqual(arrangeTargets(shapes,
    ['missing', 'child', 'first', 'parent', 'hidden', 'rack-part', 'first'], 'blueprint')
    .map((item) => item.id), ['first', 'parent']);
});

test('all six alignment actions use the selection extent and retain object sizes', () => {
  const a = rect('a', { x: 10, y: 20, w: 50, h: 30 });
  const b = rect('b', { x: 140, y: 100, w: 80, h: 50 });
  const cases: [ArrangeCommand, number, number, number, number][] = [
    ['align-left', 10, 20, 10, 100], ['align-center', 90, 20, 75, 100],
    ['align-right', 170, 20, 140, 100], ['align-top', 10, 20, 140, 20],
    ['align-middle', 10, 70, 140, 60], ['align-bottom', 10, 120, 140, 100],
  ];
  for (const [command, ax, ay, bx, by] of cases) {
    fresh([a, b]);
    const original = structuredClone(state().diagram);
    state().arrangeSelection(command);
    assert.deepEqual([shape('a').x, shape('a').y, shape('b').x, shape('b').y], [ax, ay, bx, by]);
    assert.deepEqual([shape('a').w, shape('a').h, shape('b').w, shape('b').h], [50, 30, 80, 50]);
    assert.equal(state().past.length, 1);
    const arranged = structuredClone(state().diagram);
    state().undo();
    assert.deepEqual(state().diagram, original);
    state().redo();
    assert.deepEqual(state().diagram, arranged);
  }
});

test('rotated shapes align their rendered outer bounds', () => {
  fresh([rect('a', { x: 0, w: 80, h: 40, rotation: 90 }), rect('b', { x: 200 })]);
  state().arrangeSelection('align-left');
  close(shape('b').x, 20);
  close(shape('a').x, 0);
});

test('row layout packs a scattered selection with a fixed gap in stable spatial order', () => {
  fresh([
    rect('a', { x: 40, y: 100, w: 80, h: 40 }),
    rect('b', { x: 300, y: 20, w: 120, h: 80 }),
    rect('c', { x: 600, y: 200, w: 60, h: 60 }),
  ], [], ['c', 'a', 'b']);
  const before = structuredClone(state().diagram);
  state().arrangeSelection('layout-row');
  assert.deepEqual(state().diagram.shapes.map((s) => [s.x, s.y, s.w, s.h]), [
    [40, 120, 80, 40], [144, 100, 120, 80], [288, 110, 60, 60],
  ]);
  assert.equal(shape('b').x - shape('a').x - shape('a').w, DEFAULT_ARRANGE_GAP);
  assert.equal(shape('c').x - shape('b').x - shape('b').w, DEFAULT_ARRANGE_GAP);
  assert.equal(state().past.length, 1);
  const laidOut = state().diagram;
  state().arrangeSelection('layout-row');
  assert.equal(state().diagram, laidOut, 'repeating the same layout is a no-op');
  assert.equal(state().past.length, 1);
  state().undo();
  assert.deepEqual(state().diagram, before);
  state().redo();
  assert.deepEqual(state().diagram, laidOut);
  assert.deepEqual(state().selectedIds, ['c', 'a', 'b']);
});

test('column layout centers across the selection, anchors its top and accepts two shapes', () => {
  fresh([rect('bottom', { x: 400, y: 250, w: 80, h: 40 }),
    rect('top', { x: 40, y: 30, w: 120, h: 80 })]);
  state().arrangeSelection('layout-column', { gap: 18.5 });
  assert.deepEqual([shape('top').x, shape('top').y, shape('bottom').x, shape('bottom').y], [200, 30, 220, 128.5]);
  assert.equal(shape('bottom').y - shape('top').y - shape('top').h, 18.5);
  assert.deepEqual([shape('top').w, shape('top').h, shape('bottom').w, shape('bottom').h], [120, 80, 80, 40]);
  const laidOut = state().diagram;
  state().arrangeSelection('layout-column', { gap: 18.5 });
  assert.equal(state().diagram, laidOut);
  assert.equal(state().past.length, 1);
});

test('layout measures rotated outer boxes rather than unrotated dimensions', () => {
  fresh([rect('rotated', { x: 0, y: 100, w: 80, h: 40, rotation: 90 }),
    rect('plain', { x: 200, y: 0, w: 50, h: 30 })]);
  state().arrangeSelection('layout-row', { gap: 12 });
  // Rotated box starts at x=20 and measures 40×80, so the next starts at72.
  close(shape('rotated').x, 0);
  close(shape('plain').x, 72);
  close(shape('rotated').y + shape('rotated').h / 2, 80);
  close(shape('plain').y + shape('plain').h / 2, 80);
  assert.deepEqual([shape('rotated').w, shape('rotated').h, shape('rotated').rotation], [80, 40, 90]);
  const first = state().diagram;
  state().arrangeSelection('layout-row', { gap: 12 });
  assert.equal(state().diagram, first);
});

test('layout breaks equal primary positions by cross-axis position, independent of selection order', () => {
  const fixtures = [rect('lower', { x: 20, y: 200, w: 60 }), rect('upper', { x: 20, y: 50, w: 40 })];
  for (const ids of [['lower', 'upper'], ['upper', 'lower']]) {
    fresh(fixtures, [], ids);
    state().arrangeSelection('layout-row', { gap: 0 });
    assert.equal(shape('upper').x, 20);
    assert.equal(shape('lower').x, 60);
  }
});

test('switching between row and column preserves reading order across different sizes and rotation', () => {
  const originals = [
    rect('a', { x: 30, y: 200, w: 180, h: 40 }),
    rect('b', { x: 400, y: 50, w: 60, h: 200, rotation: 90 }),
    rect('c', { x: 740, y: 300, w: 100, h: 120 }),
  ];
  fresh(originals, [], ['c', 'b', 'a']);
  const outerBox = (s: Shape) => {
    const radians = (s.rotation ?? 0) * Math.PI / 180;
    const w = Math.abs(Math.cos(radians)) * s.w + Math.abs(Math.sin(radians)) * s.h;
    const h = Math.abs(Math.sin(radians)) * s.w + Math.abs(Math.cos(radians)) * s.h;
    return { id: s.id, x: s.x + (s.w - w) / 2, y: s.y + (s.h - h) / 2, w, h };
  };
  const boxes = () => state().diagram.shapes.map(outerBox);
  state().arrangeSelection('layout-row', { gap: 16 });
  const row = boxes();
  assert.deepEqual([...row].sort((a, b) => a.x - b.x).map((s) => s.id), ['a', 'b', 'c']);
  // These outer tops sort by height as c,b,a; the visible row still reads a,b,c.
  assert.deepEqual([...row].sort((a, b) => a.y - b.y).map((s) => s.id), ['c', 'b', 'a']);
  state().arrangeSelection('layout-column', { gap: 16 });
  const column = boxes();
  assert.deepEqual([...column].sort((a, b) => a.y - b.y).map((s) => s.id), ['a', 'b', 'c']);
  close(column[0].y, Math.min(...row.map((s) => s.y)));
  close(column[1].y - column[0].y - column[0].h, 16);
  close(column[2].y - column[1].y - column[1].h, 16);
  state().arrangeSelection('layout-row', { gap: 16 });
  const returned = boxes();
  assert.deepEqual([...returned].sort((a, b) => a.x - b.x).map((s) => s.id), ['a', 'b', 'c']);
  close(returned[0].x, Math.min(...column.map((s) => s.x)));
  close(returned[1].x - returned[0].x - returned[0].w, 16);
  close(returned[2].x - returned[1].x - returned[1].w, 16);
  for (const original of originals) {
    assert.deepEqual([shape(original.id).w, shape(original.id).h, shape(original.id).rotation], [original.w, original.h, original.rotation]);
  }
  const unchanged = state().diagram;
  state().arrangeSelection('layout-row', { gap: 16 });
  assert.equal(state().diagram, unchanged);
  assert.equal(state().past.length, 3);
});

test('layout gap clamps finite inputs and safely defaults absent or non-finite values', () => {
  for (const [requested, expected] of [[undefined, 24], [NaN, 24], [Infinity, 24], [-Infinity, 24], [-3, 0], [900, 500], [7.25, 7.25]] as const) {
    assert.equal(normalizeArrangeGap(requested), expected);
    fresh([rect('a', { w: 60 }), rect('b', { x: 300, w: 40 })]);
    state().arrangeSelection('layout-row', { gap: requested });
    assert.equal(shape('b').x - shape('a').x - shape('a').w, expected);
  }
});

test('layout moves group descendants and internal connector geometry once without resizing', () => {
  fresh([
    rect('reference', { x: 0, y: 0, w: 100, h: 100 }),
    rect('group', { kind: 'group', x: 300, y: 200, w: 124, h: 124 }),
    rect('member', { parent: 'group', x: 312, y: 212, w: 100, h: 100 }),
  ], [
    line('inside', { parent: 'group', from: { x: 332, y: 232 }, to: { shape: 'member', anchor: 'right' }, waypoints: [{ x: 352, y: 242 }] }),
    line('external', { from: { shape: 'reference', anchor: 'right' }, to: { shape: 'member', anchor: 'left' }, waypoints: [{ x: 200, y: 120 }] }),
  ], ['member', 'group', 'reference']);
  const before = structuredClone(state().diagram);
  state().arrangeSelection('layout-row', { gap: 20 });
  assert.deepEqual([shape('group').x, shape('group').y, shape('group').w, shape('group').h], [120, 100, 124, 124]);
  assert.deepEqual([shape('member').x, shape('member').y, shape('member').w, shape('member').h], [132, 112, 100, 100]);
  assert.deepEqual(state().diagram.connectors[0].from, { x: 152, y: 132 });
  assert.deepEqual(state().diagram.connectors[0].waypoints, [{ x: 172, y: 142 }]);
  assert.deepEqual(state().diagram.connectors[0].to, { shape: 'member', anchor: 'right' });
  assert.deepEqual(state().diagram.connectors[1].waypoints, [{ x: 200, y: 120 }]);
  assert.equal(state().past.length, 1);
  state().undo();
  assert.deepEqual(state().diagram, before);
});

test('layout respects visible roots, insufficient selections and read-only state', () => {
  fresh([rect('a'), rect('b', { x: 300 }), rect('hidden', { x: -900, layer: 'notes' })]);
  useEditor.setState({ layerMode: 'blueprint', readOnly: true });
  const before = state().diagram;
  state().arrangeSelection('layout-row');
  assert.equal(state().diagram, before);
  assert.equal(state().past.length, 0);
  useEditor.setState({ readOnly: false });
  state().setSelected(['a', 'hidden']);
  state().arrangeSelection('layout-column');
  assert.equal(state().diagram, before);
  state().setSelected(['hidden', 'b', 'a']);
  state().arrangeSelection('layout-row');
  assert.equal(shape('a').x, 0);
  assert.equal(shape('b').x, 124);
  assert.deepEqual(shape('hidden'), before.shapes[2]);
  assert.equal(state().past.length, 1);
});

test('distribution gives unequal-sized objects equal edge gaps and keeps outer objects fixed', () => {
  const shapes = [rect('a', { x: 0, w: 60 }), rect('b', { x: 90, w: 40 }),
    rect('c', { x: 350, w: 80 }), rect('d', { x: 500, w: 100 })];
  fresh(shapes, [], ['c', 'a', 'd', 'b']);
  state().arrangeSelection('distribute-horizontal');
  const gaps = ['a', 'b', 'c'].map((id, i) => shape(['b', 'c', 'd'][i]).x - shape(id).x - shape(id).w);
  gaps.forEach((gap) => close(gap, 320 / 3));
  assert.equal(shape('a').x, 0);
  assert.equal(shape('d').x, 500);
  assert.equal(state().past.length, 1);
  const history = state().past.length;
  state().arrangeSelection('distribute-horizontal');
  assert.equal(state().past.length, history, 'already distributed is a no-op');
});

test('vertical distribution is independent of selection order and horizontal position', () => {
  fresh([rect('a', { x: 20, y: 0, h: 20 }), rect('b', { x: 40, y: 50, h: 40 }),
    rect('c', { x: 60, y: 200, h: 60 })], [], ['c', 'b', 'a']);
  state().arrangeSelection('distribute-vertical');
  assert.equal(shape('b').y, 90);
  assert.equal(shape('b').x, 40);
  assert.equal(shape('a').y, 0);
  assert.equal(shape('c').y, 200);
});

test('a frame and selected descendants translate once, including internal connector bends and floating endpoints', () => {
  fresh([
    rect('reference', { y: 0 }),
    rect('frame', { kind: 'container', x: 200, y: 200, w: 200, h: 200 }),
    rect('inner', { kind: 'container', parent: 'frame', x: 220, y: 230, w: 140, h: 130 }),
    rect('a', { parent: 'inner', x: 240, y: 250, w: 20, h: 20 }),
    rect('b', { parent: 'inner', x: 300, y: 310, w: 20, h: 20 }),
  ], [
    line('inside', { parent: 'inner', from: { shape: 'a', anchor: 'right' }, to: { shape: 'b', anchor: 'left' }, waypoints: [{ x: 280, y: 270 }] }),
    line('loose', { parent: 'inner', from: { x: 260, y: 280 }, to: { x: 290, y: 280 } }),
    line('external', { from: { shape: 'reference', anchor: 'right' }, to: { shape: 'a', anchor: 'left' }, waypoints: [{ x: 160, y: 120 }] }),
  ], ['reference', 'frame', 'inner', 'a', 'b']);
  state().arrangeSelection('align-top');
  assert.equal(shape('frame').y, 0);
  assert.equal(shape('inner').y, 30);
  assert.equal(shape('a').y, 50);
  assert.deepEqual(state().diagram.connectors[0].waypoints, [{ x: 280, y: 70 }]);
  assert.deepEqual(state().diagram.connectors[1].from, { x: 260, y: 80 });
  assert.deepEqual(state().diagram.connectors[1].to, { x: 290, y: 80 });
  assert.deepEqual(state().diagram.connectors[2].waypoints, [{ x: 160, y: 120 }]);
  assert.equal(state().past.length, 1);
});

test('group translation stays rigid when connectors extend beyond its shape members', () => {
  fresh([
    rect('reference', { x: 0 }),
    rect('group', { kind: 'group', x: 188, y: 188, w: 224, h: 124 }),
    rect('member', { parent: 'group', x: 200, y: 200, w: 50, h: 50 }),
  ], [line('tail', { parent: 'group', from: { x: 250, y: 225 }, to: { x: 400, y: 300 } })], ['reference', 'group', 'member']);
  state().arrangeSelection('align-left');
  assert.equal(shape('group').x, 0);
  assert.equal(shape('member').x, 12);
  assert.equal(shape('member').w, 50);
  assert.deepEqual(state().diagram.connectors[0].to, { x: 212, y: 300 });
});

test('matching size uses the first eligible root and respects aspect, text and container constraints', () => {
  fresh([
    rect('reference', { w: 160, h: 100 }),
    rect('icon', { kind: 'icon', w: 80, h: 40, iconConstraints: { lockAspect: true, lockColors: true, lockRotation: true } }),
    rect('text', { kind: 'text', x: 300, w: 80, h: 20, autoSize: true, label: 'Label' }),
    rect('container', { kind: 'container', x: 500, w: 300, h: 250 }),
    rect('child', { parent: 'container', x: 700, y: 20, w: 70, h: 150 }),
  ], [], ['missing', 'reference', 'icon', 'text', 'container']);
  state().arrangeSelection('match-size');
  assert.equal(shape('reference').w, 160);
  assert.equal(shape('icon').w, 160);
  assert.equal(shape('icon').h, 80);
  assert.equal(shape('text').w, 160);
  assert.equal(shape('text').autoSize, false);
  assert.equal(shape('text').minH, 100);
  assert.equal(shape('container').w, 270, 'container still contains its child');
  assert.equal(shape('container').h, 170);
  assert.equal(shape('child').x, 700);
  assert.equal(state().past.length, 1);
});

test('matching width and height only leaves the other ordinary dimension unchanged', () => {
  for (const command of ['match-width', 'match-height'] as const) {
    fresh([rect('reference', { w: 160, h: 90 }), rect('target', { w: 40, h: 20 })]);
    state().arrangeSelection(command);
    assert.deepEqual([shape('target').w, shape('target').h], command === 'match-width' ? [160, 20] : [40, 90]);
  }
});

test('group matching scales members and connector geometry in one transaction', () => {
  fresh([
    rect('reference', { w: 224, h: 124 }),
    rect('group', { kind: 'group', x: 300, y: 0, w: 124, h: 124 }),
    rect('member', { parent: 'group', x: 312, y: 12, w: 100, h: 100 }),
  ], [line('inside', { parent: 'group', from: { x: 332, y: 32 }, to: { shape: 'member', anchor: 'right' }, waypoints: [{ x: 352, y: 42 }] })], ['reference', 'group']);
  state().arrangeSelection('match-width');
  assert.equal(shape('member').w, 200);
  assert.equal(shape('member').h, 100);
  assert.equal(shape('group').w, 224);
  assert.deepEqual(state().diagram.connectors[0].from, { x: 352, y: 32 });
  assert.deepEqual(state().diagram.connectors[0].waypoints, [{ x: 392, y: 42 }]);
  assert.deepEqual(state().diagram.connectors[0].to, { shape: 'member', anchor: 'right' });
  assert.equal(state().past.length, 1);
  state().undo();
  assert.equal(shape('member').w, 100);
  assert.deepEqual(state().diagram.connectors[0].waypoints, [{ x: 352, y: 42 }]);
});

test('connector-only groups resize their actual members', () => {
  fresh([rect('reference', { w: 224 }), rect('group', { kind: 'group', x: 300, y: 0, w: 124, h: 84 })],
    [line('only', { parent: 'group', from: { x: 312, y: 12 }, to: { x: 412, y: 72 } })]);
  state().arrangeSelection('match-width');
  assert.equal(shape('group').w, 224);
  assert.deepEqual(state().diagram.connectors[0].to, { x: 512, y: 72 });
});

test('groups with aspect-locked members scale uniformly and repeated matching does not oscillate', () => {
  fresh([rect('reference', { w: 224, h: 224 }),
    rect('group', { kind: 'group', x: 300, y: 0, w: 124, h: 74 }),
    rect('icon', { kind: 'icon', parent: 'group', x: 312, y: 12, w: 100, h: 50,
      iconConstraints: { lockAspect: true, lockColors: true, lockRotation: true } }),
  ], [], ['reference', 'group']);
  state().arrangeSelection('match-size');
  assert.equal(shape('group').w, 224);
  assert.equal(shape('group').h, 124);
  assert.equal(shape('icon').w / shape('icon').h, 2);
  const first = state().diagram;
  state().arrangeSelection('match-size');
  assert.equal(state().diagram, first);
  assert.equal(state().past.length, 1);
});

test('repeating a constrained group resize does not record advisory frame changes', () => {
  fresh([rect('reference', { w: 124, h: 34 }),
    rect('group', { kind: 'group', x: 300, y: 0, w: 124, h: 124 }),
    rect('text', { kind: 'text', parent: 'group', x: 312, y: 12, w: 100, h: 100,
      autoSize: false, fontSize: 24, label: 'Text remains taller than the requested height' }),
  ], [], ['reference', 'group']);
  state().arrangeSelection('match-size');
  assert.equal(shape('text').minH, 10);
  assert.equal(shape('group').h, 124, 'group follows actual child height');
  const first = state().diagram;
  for (let i = 0; i < 3; i++) state().arrangeSelection('match-size');
  assert.equal(state().diagram, first);
  assert.equal(state().past.length, 1);
});

test('insufficient, hidden, already-matched and read-only selections do not record edits', () => {
  fresh([rect('a'), rect('b', { x: 200 }), rect('hidden', { x: 400, layer: 'notes' })]);
  useEditor.setState({ layerMode: 'blueprint' });
  const original = state().diagram;
  state().arrangeSelection('match-size');
  state().arrangeSelection('align-top');
  state().arrangeSelection('distribute-horizontal');
  assert.equal(state().diagram, original);
  assert.equal(state().past.length, 0);
  useEditor.setState({ readOnly: true });
  state().arrangeSelection('align-left');
  assert.equal(state().diagram, original);
  assert.equal(state().past.length, 0);
  assert.equal(planArrange(original.shapes, original.connectors, ['a'], 'align-left').patches.length, 0);
});
