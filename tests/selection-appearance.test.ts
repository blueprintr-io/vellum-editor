import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connector, Shape } from '../src/store/types';
import { selectionAppearance, selectionLayer } from '../src/editor/chrome/inspector/selection-appearance';

const shape = (id: string, patch: Partial<Shape> = {}): Shape => ({
  id, kind: 'rect', x: 0, y: 0, w: 120, h: 80, layer: 'blueprint', ...patch,
});
const connector = (id: string, patch: Partial<Connector> = {}): Connector => ({
  id, from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, routing: 'straight', layer: 'blueprint', ...patch,
});
const read = (shapes: Shape[], connectors: Connector[] = [], ids = [...shapes, ...connectors].map((item) => item.id)) =>
  selectionAppearance({ shapes, connectors }, ids);

test('reports actual mixed colours while equivalent implicit and explicit defaults agree', () => {
  const value = read([
    shape('a', { fill: 'var(--fill-red)' }),
    shape('b', { fill: 'var(--fill-blue)', strokeWidth: 1.25, opacity: 1 }),
  ]);
  assert.equal(value.count, 2);
  assert.equal(value.types, '2 rectangles');
  assert.deepEqual(value.fill, { mixed: true, value: undefined, allDefault: false });
  assert.deepEqual(value.strokeWidth, { mixed: false, value: 1.25, allDefault: false });
  assert.deepEqual(value.opacity, { mixed: false, value: 1, allDefault: false });
});

test('normalizes legacy palette colours before comparing', () => {
  const value = read([shape('a', { fill: '#fee2e2' }), shape('b', { fill: 'var(--fill-red)' })]);
  assert.equal(value.fill?.mixed, false);
  assert.equal(value.fill?.value, 'var(--fill-red)');
});

test('different renderer defaults remain mixed without baking in overrides', () => {
  const value = read([shape('box'), shape('frame', { kind: 'container' })]);
  for (const property of ['stroke', 'strokeWidth', 'strokeStyle', 'fill', 'fillOpacity'] as const) {
    assert.deepEqual(value[property], { mixed: true, value: undefined, allDefault: true }, property);
  }
  assert.equal(value.opacity?.value, 1);
});

test('Notes and Blueprint expose their different default text appearance', () => {
  const value = read([shape('a'), shape('b', { layer: 'notes' })]);
  assert.equal(value.fontSize?.mixed, true);
  assert.equal(value.fontFamily?.mixed, true);
  assert.equal(value.textColor?.mixed, true);
  const uniform = read([shape('a'), shape('b', { layer: 'notes', fontSize: 13, fontFamily: 'var(--font-body)' })]);
  assert.equal(uniform.fontSize?.value, 13);
  assert.equal(uniform.fontSize?.mixed, false);
});

test('native notation uses 1.5px strokes and body-font defaults even on Notes', () => {
  const value = read([shape('a'), shape('b', { layer: 'notes', notation: { type: 'flow-process' } })]);
  assert.equal(value.strokeWidth?.mixed, true);
  assert.equal(value.fontSize?.value, 13);
  assert.equal(value.fontFamily?.value, 'var(--font-body)');
});

test('shape/connector selections offer common styles, without shape-only fields', () => {
  const value = read([shape('a')], [connector('line', { style: 'dashed' })]);
  assert.equal(value.types, '1 rectangle · 1 connector');
  assert.equal(value.stroke?.value, 'var(--ink)');
  assert.equal(value.strokeStyle?.mixed, true);
  assert.equal(value.fill, undefined);
  assert.equal(value.fontSize, undefined);
  assert.equal(value.textColor, undefined);
  assert.equal(value.allowNoStroke, false);
});

test('animated connector style reflects its dashed rendering', () => {
  const value = read([], [connector('a', { animated: true }), connector('b', { style: 'dashed' })]);
  assert.equal(value.strokeStyle?.mixed, false);
  assert.equal(value.strokeStyle?.value, 'dashed');
});

test('bare images and notes do not offer ineffective fill/outline controls', () => {
  for (const kind of ['image', 'note'] as const) {
    const value = read([shape('a'), shape('b', { kind, fill: 'red', stroke: 'blue' })]);
    assert.equal(value.fill, undefined, kind);
    assert.equal(value.stroke, undefined, kind);
    assert.equal(value.strokeWidth, undefined, kind);
    assert.equal(value.opacity?.value, 1, kind);
  }
  const framed = read([shape('a'), shape('b', { kind: 'image', frame: 'circle' })]);
  assert.equal(framed.fill?.value, 'var(--paper)');
  assert.equal(framed.strokeWidth?.value, 1.25);
});

test('bare icon tint shares stroke controls, while framed icons keep their frame fill', () => {
  const icon = shape('icon', { kind: 'icon', iconSvg: '<svg><path fill="currentColor" /></svg>' });
  const value = read([shape('box'), icon]);
  assert.equal(value.stroke?.value, 'var(--ink)');
  assert.equal(value.strokeIncludesTint, true);
  assert.equal(value.strokeIsTint, false);
  assert.equal(value.fill, undefined);
  assert.equal(value.strokeWidth, undefined);
  assert.equal(value.strokeStyle, undefined);
  const framed = read([shape('box'), { ...icon, frame: 'square', iconTint: 'red' }]);
  assert.equal(framed.strokeIncludesTint, false);
  assert.equal(framed.fill?.value, 'var(--paper)');
  assert.equal(framed.stroke?.value, 'var(--ink)');
});

test('different untouched multicolour icons do not pretend to share a tint', () => {
  const icons = ['red', 'green'].map((fill, index) => shape(String(index), {
    kind: 'icon', iconSvg: `<svg><path fill="${fill}"/><path fill="blue"/></svg>`,
  }));
  const value = read(icons);
  assert.deepEqual(value.stroke, { mixed: true, value: undefined, allDefault: true });
  assert.equal(value.strokeIsTint, true);
  const tinted = read(icons.map((icon) => ({ ...icon, stroke: '#123456' })));
  assert.equal(tinted.stroke?.value, '#123456');
  assert.equal(tinted.stroke?.mixed, false);
});

test('aggregation follows group fan-out, excludes group frames, and does not expand containers', () => {
  const shapes = [
    shape('group', { kind: 'group' }),
    shape('child', { parent: 'group', opacity: 0.2 }),
    shape('container', { kind: 'container' }),
    shape('nested', { parent: 'container', opacity: 0.7 }),
  ];
  const value = read(shapes, [], ['group', 'container']);
  assert.equal(value.count, 2);
  assert.equal(value.types, '1 group · 1 container');
  assert.equal(value.hasGroups, true);
  assert.equal(value.opacity?.mixed, true);
  assert.equal(value.strokeWidth?.mixed, true);
  const childOnly = read(shapes, [], ['group']);
  assert.equal(childOnly.opacity?.value, 0.2);
  const containerOnly = read(shapes, [], ['container']);
  assert.equal(containerOnly.opacity?.value, 1);
});

test('mixed gradient paint is independent of identical underlying stroke colours', () => {
  const a = shape('a', { stroke: 'var(--ink)', strokeGradient: { palette: 'vellum' } });
  const b = shape('b', { stroke: 'var(--ink)', strokeGradient: { palette: 'stratum' } });
  assert.equal(read([a, b]).stroke?.mixed, true);
  assert.equal(read([a, shape('plain', { stroke: 'var(--ink)' })]).stroke?.mixed, true);
  assert.equal(read([a, { ...b, stroke: 'red', strokeGradient: { palette: 'vellum', speed: 'normal', pulse: false } }]).stroke?.mixed, false);
  assert.equal(read([a, b]).hasGradient, true);
});

test('layer feedback includes the same descendants and connectors as the layer action', () => {
  const shapes = [shape('frame', { kind: 'container' }), shape('inside', { parent: 'frame', layer: 'notes' }), shape('other')];
  const lines = [connector('internal', { parent: 'frame', layer: 'notes' })];
  assert.equal(selectionLayer({ shapes, connectors: lines }, ['frame', 'other'])?.mixed, true);
  shapes[1].layer = 'blueprint';
  assert.equal(selectionLayer({ shapes, connectors: lines }, ['frame', 'other'])?.mixed, true);
  lines[0].layer = 'blueprint';
  assert.equal(selectionLayer({ shapes, connectors: lines }, ['frame', 'other'])?.value, 'blueprint');
  lines.push(connector('between', { from: { shape: 'inside', anchor: 'right' }, to: { shape: 'other', anchor: 'left' }, layer: 'notes' }));
  assert.equal(selectionLayer({ shapes, connectors: lines }, ['frame', 'other'])?.mixed, true);
});
