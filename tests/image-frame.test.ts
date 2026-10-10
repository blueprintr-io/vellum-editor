import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiagramState, Shape } from '../src/store/types';
import { parseDiagram } from '../src/store/schema';
import { autoAnchor, shapeAnchorPoint } from '../src/editor/canvas/routing';
import { smartAnchorPoints } from '../src/editor/canvas/smart-anchors';
import { resolvePrismStroke, shapeSupportsPrismStroke } from '../src/editor/canvas/prism';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, String(value)); },
    removeItem: (key: string) => { mem.delete(key); },
    clear: () => mem.clear(),
    key: (index: number) => [...mem.keys()][index] ?? null,
    get length() { return mem.size; },
  },
});
const { useEditor } = await import('../src/store/editor');
const st = () => useEditor.getState();
const shape = (id: string) => st().diagram.shapes.find((s) => s.id === id)!;
const image = (id: string, extra: Partial<Shape> = {}): Shape => ({
  id, kind: 'image', x: 20, y: 40, w: 160, h: 80, layer: 'blueprint',
  src: 'data:image/png;base64,cGl4ZWxz', imageFilter: 'sepia', imageTint: '#123456',
  ...extra,
});
const diagram = (shapes: Shape[]): DiagramState => ({
  version: '1.0', meta: { title: 'Image frames' }, shapes, connectors: [], annotations: [],
});
function fresh(shapes: Shape[]) { st().loadDiagram(diagram(shapes), null); }
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test('frames each image and icon in a mixed selection in one undo step', () => {
  const original = [
    image('wide'), image('tall', { x: 300, w: 60, h: 120 }),
    image('icon', { kind: 'icon', x: 500, w: 60, h: 60 }),
    image('rect', { kind: 'rect', x: 700 }),
  ];
  fresh(original);
  const before = structuredClone(st().diagram.shapes);
  st().setSelected(original.map((s) => s.id));
  st().encapsulateSelection('circle');

  assert.equal(st().past.length, 1);
  for (const id of ['wide', 'tall', 'icon']) {
    const old = before.find((s) => s.id === id)!;
    const framed = shape(id);
    assert.equal(framed.frame, 'circle');
    assert.equal(framed.w, Math.max(old.w, old.h));
    assert.equal(framed.h, framed.w);
    assert.equal(framed.x + framed.w / 2, old.x + old.w / 2);
    assert.equal(framed.y + framed.h / 2, old.y + old.h / 2);
    assert.equal(framed.src, old.src);
    assert.equal(framed.imageFilter, old.imageFilter);
    assert.equal(framed.imageTint, old.imageTint);
  }
  assert.equal(shape('wide').frameAspectRatio, 2);
  assert.equal(shape('tall').frameAspectRatio, 0.5);
  assert.equal(shape('icon').frameAspectRatio, undefined);
  assert.deepEqual(shape('rect'), before[3]);
  const framed = structuredClone(st().diagram.shapes);
  st().undo();
  assert.deepEqual(st().diagram.shapes, before);
  st().redo();
  assert.deepEqual(st().diagram.shapes, framed);
  assert.deepEqual(st().selectedIds, original.map((s) => s.id));
});

test('switching and resizing a frame preserves image proportions for removal', () => {
  for (const [w, h] of [[160, 80], [60, 120]]) {
    fresh([image('picture', { w, h })]);
    st().setSelected('picture');
    st().encapsulateSelection('circle');
    st().encapsulateSelection('square');
    assert.equal(shape('picture').frameAspectRatio, w / h);
    st().updateShape('picture', { x: 10, y: 30, w: 240, h: 240 });
    st().encapsulateSelection(null);
    const bare = shape('picture');
    assert.equal(bare.frame, undefined);
    assert.equal(bare.frameAspectRatio, undefined);
    close(bare.w / bare.h, w / h);
    assert.equal(Math.max(bare.w, bare.h), 240);
    assert.equal(bare.x + bare.w / 2, 130);
    assert.equal(bare.y + bare.h / 2, 150);
    st().undo();
    assert.equal(shape('picture').frame, 'square');
    assert.equal(shape('picture').frameAspectRatio, w / h);
  }
});

test('selecting the active frame or removing no frame does not add history', () => {
  fresh([image('picture')]);
  st().setSelected('picture');
  st().encapsulateSelection(null);
  assert.equal(st().past.length, 0);
  st().encapsulateSelection('square');
  st().encapsulateSelection('square');
  assert.equal(st().past.length, 1);
});

test('degenerate imported image dimensions do not create invalid frames', () => {
  for (const [w, h] of [[0, 80], [160, 0], [-160, 80], [160, -80]]) {
    fresh([image('picture', { w, h })]);
    st().setSelected('picture');
    st().encapsulateSelection('circle');
    assert.equal(shape('picture').frame, undefined);
    assert.equal(shape('picture').frameAspectRatio, undefined);
    assert.equal(st().past.length, 0);
  }
});

test('mixed selection style edits paint image frames and preserve bare-image behavior', () => {
  fresh([image('framed', { frame: 'circle', frameAspectRatio: 2 }), image('bare')]);
  st().setSelected(['framed', 'bare']);
  const patch: Partial<Shape> = {
    fill: '#ffffff', stroke: '#123456', strokeWidth: 3, strokeStyle: 'dotted',
    strokeGradient: { palette: 'vellum', speed: 'normal', pulse: false },
  };
  st().updateSelection(patch);
  for (const key of Object.keys(patch) as (keyof Shape)[]) {
    assert.deepEqual(shape('framed')[key], patch[key]);
  }
  assert.equal(shape('bare').fill, undefined);
  assert.equal(shape('bare').stroke, undefined);
  assert.equal(shape('bare').strokeGradient, undefined);
  assert.equal(shapeSupportsPrismStroke(shape('framed')), true);
  assert.deepEqual(resolvePrismStroke(shape('framed')), patch.strokeGradient);
  assert.equal(shapeSupportsPrismStroke(shape('bare')), false);
  st().undo();
  assert.equal(shape('framed').stroke, undefined);
  assert.equal(shape('framed').imageFilter, 'sepia');
});

test('circle image connectors and smart anchors land on the frame perimeter', () => {
  const circle = image('picture', { x: 0, y: 0, w: 100, h: 100, frame: 'circle' });
  const diagonal = shapeAnchorPoint(circle, autoAnchor(circle, { x: 200, y: 200 }));
  close(diagonal[0], 50 + 50 / Math.sqrt(2));
  close(diagonal[1], 50 + 50 / Math.sqrt(2));
  for (const point of smartAnchorPoints(circle, true, 16)) {
    close(Math.hypot(point.x - 50, point.y - 50), 50);
  }
  assert.deepEqual(shapeAnchorPoint({ ...circle, frame: 'square' }, [1, 1]), [100, 100]);
  assert.deepEqual(shapeAnchorPoint({ ...circle, frame: undefined }, [1, 1]), [100, 100]);
});

test('frame proportions survive file parsing and invalid ratios fall back safely', () => {
  const source = diagram([image('picture', { frame: 'square', frameAspectRatio: 2 })]);
  assert.equal(parseDiagram(JSON.parse(JSON.stringify(source))).shapes[0].frameAspectRatio, 2);
  for (const bad of [0, -1, Infinity, NaN]) {
    assert.equal(parseDiagram(diagram([image('picture', { frame: 'circle', frameAspectRatio: bad })])).shapes[0].frameAspectRatio, undefined);
  }
});
