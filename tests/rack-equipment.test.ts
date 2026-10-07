import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
const svgDom = new JSDOM();
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: svgDom.window.DOMParser });
test.after(() => svgDom.window.close());
import {
  clearRackUnit,
  createRack,
  getRackInterfaces,
  getRackUnits,
  isRackChild,
  rackChildren,
  rackCopyableIds,
  rackHeightPatch,
  rackLayout,
  rackUnitBox,
  rackUnitDevicePatch,
  rackUnitIconPatch,
  rackUnitMaxSpan,
  rackUnitPlacedSpan,
  swapRackUnitPositions,
  syncRacks,
} from '../src/editor/rack/model';
import {
  RACK_DEVICE_SPECS,
  rackDeviceOptions,
  rackDeviceTypeOfSvg,
  rackModuleCount,
  rackUnitDevice,
} from '../src/editor/rack/devices';
import { rackDeviceFace, rackDeviceSvg, rackModuleFace } from '../src/editor/rack/face';
import { rackDeviceBox, rackIconLayout, svgAspect } from '../src/editor/rack/geometry';
import { rackTextLayout, RACK_LABEL_GAP } from '../src/editor/rack/text-layout';
import { RACK_EQUIPMENT } from '../src/editor/rack/catalog';
import { parseIconSvg } from '../src/editor/canvas/icon-svg';
import { resolveEndpointPoint, shapeAnchorWorldPoint } from '../src/editor/canvas/routing';
import { smartAnchorPoints } from '../src/editor/canvas/smart-anchors';
import { pickShapeAt } from '../src/editor/canvas/pick';
import { effectiveZMap } from '../src/editor/canvas/z-order';
import { expandAllDescendants } from '../src/store/hierarchy';
import { visibleItemIds } from '../src/store/layers';
import { diagramToYaml, yamlToDiagram } from '../src/store/persist';
import type { Connector, DiagramState, Shape } from '../src/store/types';

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
const diagram = (shapes: Shape[], connectors: Connector[] = []): DiagramState => ({
  version: '1.0',
  meta: {},
  shapes,
  connectors,
  annotations: [],
});
const reset = (shapes: Shape[] = createRack('rack', 0, 0, 12)) => {
  st().loadDiagram(diagram(shapes), null);
  useEditor.setState({ readOnly: false, layerMode: 'both', activeLayer: 'blueprint' });
};
const unit = (id: string) => st().diagram.shapes.find((s) => s.id === id)!;
const fill = (id: string, type: Parameters<typeof rackUnitDevicePatch>[1]) =>
  st().updateShape(id, rackUnitDevicePatch(unit(id), type));
const near = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const at = (shapes: Shape[], rack = 'rack') =>
  Object.fromEntries(getRackUnits(shapes, rack).map((s) => [s.id, s.rackUnit!.u]));

test('equipment spans several U, covering the slots above it without losing them', () => {
  reset();
  fill('rack-u3', 'server');
  st().updateShape('rack-u4', { meta: { stratumId: 'kept' } });
  assert.equal(st().setRackUnitSpan('rack-u3', 3), true);
  const rack = unit('rack');
  const server = unit('rack-u3');
  assert.deepEqual(
    { x: server.x, y: server.y, w: server.w, h: server.h, rotation: server.rotation },
    rackUnitBox(rack, 3, 3),
  );
  near(server.h, rackLayout(rack).unitH * 3);
  assert.equal(unit('rack-u4').rackUnit!.hidden, true);
  assert.equal(unit('rack-u5').rackUnit!.hidden, true);
  assert.deepEqual(unit('rack-u4').meta, { stratumId: 'kept' });
  assert.equal(getRackUnits(st().diagram.shapes, 'rack').length, 10);
  assert.equal(st().diagram.shapes.filter((s) => !isRackChild(s)).length, 13, 'no slot is created or removed');
  // The status line about stored units is only for units above the height.
  assert.equal(
    getRackUnits(st().diagram.shapes, 'rack', true).filter((s) => s.rackUnit!.u > 12).length,
    0,
  );
  assert.equal(st().setRackUnitSpan('rack-u3', 1), true);
  assert.equal(unit('rack-u4').rackUnit!.hidden, undefined);
  assert.equal(getRackUnits(st().diagram.shapes, 'rack').length, 12);
  st().undo();
  assert.equal(unit('rack-u3').rackUnit!.span, 3);
  st().undo();
  assert.equal(unit('rack-u3').rackUnit!.span, undefined);
});

test('a span grows toward higher U in either numbering', () => {
  const shapes = createRack('rack', 0, 0, 6);
  const bottomUp = shapes[0];
  const topDown = { ...bottomUp, rack: { units: 6, numbering: 'top-down' as const } };
  const l = rackLayout(bottomUp);
  // U1 at the bottom: U2-3 sits above U2's own row.
  near(rackUnitBox(bottomUp, 2, 2).y, rackUnitBox(bottomUp, 3).y);
  near(rackUnitBox(bottomUp, 2, 2).y + 2 * l.unitH, rackUnitBox(bottomUp, 2).y + l.unitH);
  // U1 at the top: U2-3 hangs below U2.
  near(rackUnitBox(topDown, 2, 2).y, rackUnitBox(topDown, 2).y);
});

test('spans stop at equipment, labels, connections and the rack top', () => {
  reset();
  fill('rack-u2', 'switch');
  st().updateShape('rack-u5', { label: 'Reserved' });
  assert.equal(rackUnitMaxSpan(st().diagram.shapes, 'rack-u2'), 3);
  st().addConnector({ id: 'c', from: { shape: 'rack-u4', anchor: 'right' }, to: { x: 500, y: 0 }, routing: 'straight' });
  assert.equal(rackUnitMaxSpan(st().diagram.shapes, 'rack-u2', st().diagram.connectors), 2);
  const depth = st().past.length;
  assert.equal(st().setRackUnitSpan('rack-u2', 3), false);
  assert.equal(st().past.length, depth);
  assert.equal(rackUnitMaxSpan(st().diagram.shapes, 'rack-u11'), 2);
  assert.equal(st().setRackUnitSpan('rack-u11', 3), false);
  useEditor.setState({ readOnly: true });
  assert.equal(st().setRackUnitSpan('rack-u2', 2), false);
});

test('a stored span is cut short rather than hiding equipment, and comes back when room returns', () => {
  let shapes = createRack('rack', 0, 0, 12);
  shapes = shapes.map((s) =>
    s.id === 'rack-u10' ? { ...s, rackUnit: { u: 10, span: 4, device: 'server' as const } }
    : s.id === 'rack-u12' ? { ...s, label: 'Router' }
    : s,
  );
  shapes = syncRacks(shapes);
  assert.equal(rackUnitPlacedSpan(shapes, 'rack-u10'), 2);
  assert.equal(shapes.find((s) => s.id === 'rack-u12')!.rackUnit!.hidden, undefined);
  assert.equal(syncRacks(shapes), shapes, 'normalisation is idempotent');
  // Lowering the rack truncates at the top; restoring the height restores it.
  reset(shapes);
  st().updateShape('rack', rackHeightPatch(unit('rack'), 10));
  assert.equal(rackUnitPlacedSpan(st().diagram.shapes, 'rack-u10'), 1);
  assert.equal(unit('rack-u10').rackUnit!.span, 4);
  st().updateShape('rack-u12', { label: 'U12' });
  st().updateShape('rack', rackHeightPatch(unit('rack'), 14));
  assert.equal(rackUnitPlacedSpan(st().diagram.shapes, 'rack-u10'), 4);
});

test('clearing a tall unit returns it to one empty U and uncovers the slots above', () => {
  reset();
  fill('rack-u1', 'ups');
  st().setRackUnitSpan('rack-u1', 4);
  st().updateShape('rack-u1', { rackUnit: { ...unit('rack-u1').rackUnit!, labelSide: 'left' } });
  st().setSelected('rack-u1');
  st().deleteSelection();
  assert.deepEqual(JSON.parse(JSON.stringify(unit('rack-u1').rackUnit)), { u: 1 });
  assert.equal(unit('rack-u1').iconSvg, undefined);
  assert.equal(getRackUnits(st().diagram.shapes, 'rack').length, 12);
  assert.deepEqual(clearRackUnit({ ...unit('rack-u1'), rackUnit: { u: 1, hidden: true, span: 2 } }).rackUnit, { u: 1, hidden: true });
});

test('a tall unit moves onto free space and slides over its neighbours, in one undo step', () => {
  reset();
  fill('rack-u3', 'server');
  st().setRackUnitSpan('rack-u3', 2);
  fill('rack-u1', 'switch');
  const before = structuredClone(st().diagram);
  const depth = st().past.length;
  // Far move up: its top lands on the target; its covered slot travels
  // with it and the two empty slots it lands on take its old place.
  st().swapRackUnits('rack-u3', 'rack-u8');
  assert.equal(st().past.length, depth + 1);
  assert.deepEqual(
    { server: unit('rack-u3').rackUnit!.u, covered: unit('rack-u4').rackUnit },
    { server: 7, covered: { u: 8, hidden: true } },
  );
  assert.deepEqual([unit('rack-u7').rackUnit!.u, unit('rack-u8').rackUnit!.u], [3, 4]);
  assert.equal(unit('rack-u8').label, 'U4');
  assert.equal(rackUnitPlacedSpan(st().diagram.shapes, 'rack-u3'), 2);
  st().undo();
  // Far move down: its bottom lands on the target.
  st().swapRackUnits('rack-u3', 'rack-u11');
  assert.equal(unit('rack-u3').rackUnit!.u, 10);
  st().swapRackUnits('rack-u3', 'rack-u6');
  assert.equal(unit('rack-u3').rackUnit!.u, 6);
  assert.deepEqual(unit('rack-u4').rackUnit, { u: 7, hidden: true });
  assert.equal(st().past.length, depth + 2);
  st().undo();
  st().undo();
  assert.deepEqual(st().diagram, before);
  // Moving up onto the next U nudges by one: the top edge lands on the target.
  st().swapRackUnits('rack-u3', 'rack-u5');
  assert.equal(unit('rack-u3').rackUnit!.u, 4);
  assert.equal(unit('rack-u5').rackUnit!.u, 3);
  // Moving down onto equipment slides past it; the switch moves above.
  reset();
  fill('rack-u3', 'server');
  st().setRackUnitSpan('rack-u3', 2);
  fill('rack-u2', 'switch');
  st().swapRackUnits('rack-u3', 'rack-u2');
  assert.equal(unit('rack-u3').rackUnit!.u, 2);
  assert.equal(unit('rack-u2').rackUnit!.u, 4);
  assert.equal(rackUnitPlacedSpan(st().diagram.shapes, 'rack-u3'), 2);
  assert.equal(st().diagram.shapes.filter((s) => !isRackChild(s)).length, 13);
});

test('moves never cover equipment or connected slots, or push a third device', () => {
  reset();
  fill('rack-u3', 'server');
  st().setRackUnitSpan('rack-u3', 2);
  fill('rack-u7', 'switch');
  fill('rack-u10', 'ups');
  const check = (source: string, target: string, fits: boolean) => {
    const shapes = st().diagram.shapes;
    const next = swapRackUnitPositions(shapes, source, target, st().diagram.connectors);
    assert.equal(next !== shapes, fits, `${source} -> ${target}`);
  };
  check('rack-u3', 'rack-u6', true); // lands on the empty U5-6
  check('rack-u3', 'rack-u8', false); // U7-8 holds the switch as well
  check('rack-u3', 'rack-u11', false); // U10-11 holds the UPS as well
  check('rack-u3', 'rack-u12', true); // its top lands on the rack's top U
  // A short unit swapped with a tall one must have room for it above.
  fill('rack-u1', 'blank');
  check('rack-u1', 'rack-u3', true);
  st().addConnector({ id: 'c', from: { shape: 'rack-u2', anchor: 'right' }, to: { x: 400, y: 0 }, routing: 'straight' });
  check('rack-u1', 'rack-u3', false);
  useEditor.setState({ diagram: { ...st().diagram, connectors: [] } });
  st().updateShape('rack-u2', { label: 'Cable tray' });
  check('rack-u1', 'rack-u3', false);
  // An equal-height swap always fits.
  check('rack-u7', 'rack-u10', true);
  check('rack-u1', 'rack-u7', true);
});

test('swapping a short unit with a tall one needs room above the short one', () => {
  reset();
  fill('rack-u1', 'server');
  st().setRackUnitSpan('rack-u1', 2);
  fill('rack-u6', 'switch');
  st().swapRackUnits('rack-u6', 'rack-u1');
  assert.deepEqual(at(st().diagram.shapes), { ...at(st().diagram.shapes), 'rack-u6': 1, 'rack-u1': 6 });
  assert.equal(rackUnitPlacedSpan(st().diagram.shapes, 'rack-u1'), 2);
  assert.equal(unit('rack-u2').rackUnit!.hidden, undefined, 'the old covered slot reappears');
  assert.equal(unit('rack-u7').rackUnit!.hidden, true);
});

test('tall equipment moves between racks with its covered slots', () => {
  reset([...createRack('a', 0, 0, 8), ...createRack('b', 400, 0, 8)]);
  fill('a-u2', 'ups');
  st().setRackUnitSpan('a-u2', 3);
  st().swapRackUnits('a-u2', 'b-u7');
  // Lands as high as fits: U6-8 of rack b.
  assert.deepEqual({ parent: unit('a-u2').parent, u: unit('a-u2').rackUnit!.u }, { parent: 'b', u: 6 });
  assert.equal(getRackUnits(st().diagram.shapes, 'a').length, 8);
  assert.equal(getRackUnits(st().diagram.shapes, 'b').length, 6);
  assert.equal(getRackUnits(st().diagram.shapes, 'a', true).length + getRackUnits(st().diagram.shapes, 'b', true).length, 16);
});

test('connection points sit on the equipment or icon, not on the slot around it', () => {
  reset();
  fill('rack-u2', 'server');
  const server = unit('rack-u2');
  const body = rackDeviceBox(server);
  const [, topY] = shapeAnchorWorldPoint(server, 'top');
  near(topY, body.y);
  assert.ok(topY > server.y);
  const icon = '<svg viewBox="0 0 48 24"><rect width="48" height="24"/></svg>';
  st().updateShape('rack-u4', rackUnitIconPatch(unit('rack-u4'), { iconSvg: icon }));
  const u4 = unit('rack-u4');
  const art = rackIconLayout(u4).art;
  const [rx, ry] = shapeAnchorWorldPoint(u4, 'right');
  near(rx, art.x + art.w);
  near(ry, art.y + art.h / 2);
  assert.ok(rx < u4.x + u4.w / 2, 'an icon is drawn on the left of its slot');
  // An empty slot is its own outline.
  const empty = unit('rack-u6');
  assert.deepEqual(shapeAnchorWorldPoint(empty, 'right'), [empty.x + empty.w, empty.y + empty.h / 2]);
});

test('the DOM-free icon layout matches the parsed artwork', () => {
  for (const markup of [
    '<svg viewBox="0 0 24 24"></svg>',
    '<svg viewBox="0,0,64,16"></svg>',
    "<svg width='10' height='40'></svg>",
    '<svg></svg>',
    '<?xml version="1.0"?><!-- c --><svg viewBox="0 0 3 2"></svg>',
  ]) {
    const parsed = parseIconSvg(markup)!;
    const vb = parsed.viewBox?.split(/[ ,]+/).map(Number);
    const expected = vb?.length === 4 ? vb[2] / vb[3] : parsed.width / parsed.height;
    near(svgAspect(markup)!, expected);
  }
  assert.equal(svgAspect('<div></div>'), null);
});

test('existing equipment artwork still draws as equipment, before and after sanitising', () => {
  const legacy = {
    server: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 24"><g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="158" height="22" rx="2"/><circle cx="6" cy="12" r="1.5"/><circle cx="154" cy="12" r="1.5"/><rect x="14" y="5" width="13" height="14" rx="1"/><rect x="31" y="5" width="13" height="14" rx="1"/><rect x="48" y="5" width="13" height="14" rx="1"/><rect x="65" y="5" width="13" height="14" rx="1"/><rect x="82" y="5" width="13" height="14" rx="1"/><rect x="99" y="5" width="13" height="14" rx="1"/><circle cx="140" cy="12" r="4"/><path d="M140 7v5"/></g></svg>',
    blank: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 24"><g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="158" height="22" rx="2"/><circle cx="6" cy="12" r="1.5"/><circle cx="154" cy="12" r="1.5"/></g></svg>',
  };
  for (const [type, svg] of Object.entries(legacy)) {
    assert.equal(rackDeviceTypeOfSvg(svg), type);
    const purified = svg.replace(/<(rect|circle|path)\b([^>]*)\/>/g, '<$1$2></$1>');
    assert.notEqual(purified, svg);
    assert.equal(rackDeviceTypeOfSvg(purified), type);
  }
  for (const e of RACK_EQUIPMENT) {
    assert.equal(rackDeviceTypeOfSvg(e.svg), e.device);
    assert.match(e.svg, /data-vellum-rack-device=/);
  }
  assert.equal(rackDeviceTypeOfSvg('<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>'), undefined);
  // A picked icon wins over a leftover device field.
  assert.equal(rackUnitDevice({ rackUnit: { u: 1, device: 'switch' }, iconSvg: '<svg viewBox="0 0 24 24"></svg>' }), null);
  assert.equal(rackUnitDevice({ rackUnit: { u: 1, device: 'switch' } })?.options.ports, 24);
  assert.equal(rackUnitDevice({ rackUnit: { u: 1 }, iconSvg: legacy.server })?.type, 'server');
  assert.equal(rackUnitDevice({ iconSvg: legacy.server }), null, 'only rack units are devices');
  // Unknown types and option values fall back rather than failing.
  assert.equal(rackUnitDevice({ rackUnit: { u: 1, device: 'toaster' } }), null);
  assert.equal(rackUnitDevice({ rackUnit: { u: 1, device: 'switch', options: { ports: 47 } } })?.options.ports, 24);
});

test('choosing equipment names placeholder labels, keeps real ones, and carries shared options over', () => {
  reset();
  const u = unit('rack-u3');
  const sw = { ...u, ...rackUnitDevicePatch(u, 'switch', { ports: 48 }) };
  assert.equal(sw.label, 'Network switch');
  assert.equal(sw.rackUnit!.device, 'switch');
  assert.equal(sw.rackUnit!.options!.ports, 48);
  const panel = { ...sw, ...rackUnitDevicePatch(sw, 'patch-panel') };
  assert.equal(panel.label, 'Patch panel', 'an equipment name is still a placeholder');
  assert.equal(panel.rackUnit!.options!.ports, 48, 'a port count both offer carries over');
  const router = { ...panel, ...rackUnitDevicePatch(panel, 'router') };
  assert.equal(router.rackUnit!.options!.ports, 4, 'one the router lacks falls back to its default');
  const named = { ...router, label: 'Floor 2 edge' };
  const server = { ...named, ...rackUnitDevicePatch(named, 'server') };
  assert.equal(server.label, 'Floor 2 edge');
  const tall = { ...server, rackUnit: { ...server.rackUnit!, span: 2, labelSide: 'over' as const } };
  const icon = { ...tall, ...rackUnitIconPatch(tall, { iconSvg: '<svg viewBox="0 0 24 24"></svg>' }, 'EC2') };
  assert.deepEqual(icon.rackUnit, { u: 3, span: 2 });
  assert.equal(icon.label, 'Floor 2 edge');
  assert.equal(rackUnitDevice(icon), null);
});

test('equipment labels float beside the rack (right by default), to the left, or over the device', () => {
  reset();
  fill('rack-u4', 'server');
  const rack = unit('rack');
  const server = unit('rack-u4');
  const { rail } = rackLayout(rack);
  const right = rackTextLayout(server, rack);
  near(right.x, rack.x + rack.w + RACK_LABEL_GAP);
  assert.equal(right.align, 'left');
  const leftUnit = { ...server, rackUnit: { ...server.rackUnit!, labelSide: 'left' as const } };
  const left = rackTextLayout(leftUnit, rack);
  near(left.x + left.w, rack.x - RACK_LABEL_GAP);
  assert.equal(left.align, 'right');
  near(server.x - rail, rack.x);
  const over = rackTextLayout({ ...server, rackUnit: { ...server.rackUnit!, labelSide: 'over' } }, rack);
  assert.deepEqual([over.x, over.w, over.align], [server.x, server.w, 'center']);
  // An ordinary icon keeps its label inside the slot, beside the icon.
  const icon = { ...unit('rack-u6'), iconSvg: '<svg viewBox="0 0 24 24"></svg>' };
  const beside = rackTextLayout(icon, rack);
  assert.ok(beside.x > icon.x && beside.x + beside.w <= icon.x + icon.w);
  assert.equal(beside.align, 'left');
});

test('equipment, options, spans, label sides and interfaces survive YAML; bad values fall back one field at a time', () => {
  let shapes = createRack('rack', 0, 0, 8);
  shapes = syncRacks(shapes.map((s) =>
    s.id === 'rack-u2'
      ? { ...s, ...rackUnitDevicePatch(s, 'switch', { ports: 48 }, 2), rackUnit: { u: 2, span: 2, device: 'switch', options: { ports: 48, portType: 'rj45', uplinks: 4, uplinkType: 'sfp', psu: 0 }, labelSide: 'left' as const } }
      : s,
  ));
  // SVG sanitisation needs a browser; the device draws from rackUnit.device.
  shapes = shapes.map((s) => ({ ...s, iconSvg: undefined }));
  const read = yamlToDiagram(diagramToYaml(diagram(shapes)));
  assert.deepEqual(read.shapes.find((s) => s.id === 'rack-u2')!.rackUnit, { u: 2, span: 2, device: 'switch', options: { ports: 48, portType: 'rj45', uplinks: 4, uplinkType: 'sfp', psu: 0 }, labelSide: 'left' });
  assert.equal(read.shapes.find((s) => s.id === 'rack-u3')!.rackUnit!.hidden, true);
  const port = read.shapes.find((s) => s.id === 'rack-u2-port-48')!;
  assert.deepEqual(port.rackPort, { group: 'port', n: 48, kind: 'rj45', side: 'bottom' });
  assert.equal(port.parent, 'rack-u2');
  assert.deepEqual(syncRacks(read.shapes), read.shapes, 'a loaded document is already in sync');
  const bad = yamlToDiagram(
    diagramToYaml(diagram(shapes))
      .replace('device: switch', 'device: toaster')
      .replace('group: port\n      n: 48', 'group: port\n      n: -3'),
  );
  const u2 = bad.shapes.find((s) => s.id === 'rack-u2')!;
  assert.equal(u2.rackUnit!.u, 2);
  assert.equal(u2.rackUnit!.span, 2);
  assert.equal(u2.rackUnit!.device, undefined);
});

test('copying one piece of equipment out of its rack makes an icon of it', () => {
  reset();
  fill('rack-u2', 'patch-panel');
  st().setSelected('rack-u2');
  st().duplicateSelection();
  const copy = unit(st().selectedIds[0]);
  assert.equal(copy.kind, 'icon');
  assert.equal(copy.rackUnit, undefined);
  assert.equal(rackDeviceTypeOfSvg(copy.iconSvg), 'patch-panel');
});

test('covered slots hide their connectors only while covered', () => {
  reset();
  st().addConnector({ id: 'c', from: { shape: 'rack-u6', anchor: 'right' }, to: { x: 500, y: 0 }, routing: 'straight' });
  fill('rack-u5', 'server');
  // A connected slot blocks the span, so cover it the way an old file might.
  st().updateShape('rack-u5', { rackUnit: { ...unit('rack-u5').rackUnit!, span: 2 } });
  assert.equal(visibleItemIds(st().diagram.shapes, st().diagram.connectors, 'both').has('c'), false);
  st().updateShape('rack-u5', { rackUnit: { ...unit('rack-u5').rackUnit!, span: 1 } });
  assert.equal(visibleItemIds(st().diagram.shapes, st().diagram.connectors, 'both').has('c'), true);
});

test('device artwork serialises with its marker and only rack paint', () => {
  for (const spec of RACK_DEVICE_SPECS) {
    const svg = rackDeviceSvg(spec.type, undefined, spec.span);
    assert.match(svg, new RegExp(`^<svg [^>]*viewBox="0 0 160 ${24 * spec.span}" data-vellum-rack-device="${spec.type}">`));
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    const parsed = parseIconSvg(svg, 'u1')!;
    assert.ok(parsed, spec.type);
    assert.match(parsed.inner, /stroke="currentColor"/);
  }
});

const children = (id: string, hidden = false) => rackChildren(st().diagram.shapes, id, hidden);
const ports = (id: string, hidden = false) => getRackInterfaces(st().diagram.shapes, id, hidden);

test('every catalogue device lays out cleanly at any size, with distinct interfaces inside its face', () => {
  const ids = new Set(RACK_EQUIPMENT.map((e) => e.id));
  assert.equal(ids.size, RACK_DEVICE_SPECS.length);
  for (const legacy of ['rack-server', 'rack-switch', 'rack-patch-panel', 'rack-ups', 'rack-blank'])
    assert.ok(ids.has(legacy), `${legacy} keeps its library id`);
  for (const spec of RACK_DEVICE_SPECS) {
    for (const o of spec.options) assert.ok(o.values.includes(o.default), `${spec.type}.${o.key} default is offered`);
    const options = rackDeviceOptions(spec);
    const device = { type: spec.type, spec, options };
    for (const [w, h] of [[224, 28 * spec.span], [600, 40 * spec.span], [80, 10 * spec.span]]) {
      const face = rackDeviceFace(device, w, h, spec.span);
      const keys = new Set(face.ports.map((p) => `${p.group}:${p.n}`));
      assert.equal(keys.size, face.ports.length, `${spec.type}: no interface listed twice`);
      for (const p of face.ports) {
        assert.ok([p.x, p.y, p.w, p.h].every(Number.isFinite), `${spec.type}: finite port`);
        assert.ok(p.x >= -1e-6 && p.y >= -1e-6 && p.x + p.w <= w + 1e-6 && p.y + p.h <= h + 1e-6, `${spec.type} ${p.group} ${p.n} inside ${w}×${h}`);
      }
      if (w === 224)
        for (let i = 0; i < face.ports.length; i++)
          for (let j = i + 1; j < face.ports.length; j++) {
            const a = face.ports[i], b = face.ports[j];
            const overlap = a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
            assert.ok(!overlap, `${spec.type}: ${a.group} ${a.n} and ${b.group} ${b.n} overlap`);
          }
      assert.equal(face.slots.length, rackModuleCount(spec, options), `${spec.type} has a slot per module`);
      for (const slot of face.slots)
        for (const type of spec.modules!.types) {
          const mf = rackModuleFace(type, device, slot.w, slot.h, h / spec.span);
          for (const p of mf.ports) assert.ok(p.x + p.w <= slot.w + 1e-6 && p.y + p.h <= slot.h + 1e-6, `${type} port inside its slot`);
        }
    }
  }
});

test('fitted equipment gets one shape per interface, with stable ids, names and cable sides', () => {
  reset();
  assert.equal(st().setRackUnitDevice('rack-u4', 'switch'), true);
  const list = ports('rack-u4');
  assert.equal(list.length, 24 + 4 + 1 + 1);
  assert.deepEqual(list.slice(0, 3).map((p) => [p.id, p.label, p.rackPort!.side ?? 'top', p.kind, p.parent]), [
    ['rack-u4-port-1', 'Port 1', 'top', 'service', 'rack-u4'],
    ['rack-u4-port-2', 'Port 2', 'bottom', 'service', 'rack-u4'],
    ['rack-u4-port-3', 'Port 3', 'top', 'service', 'rack-u4'],
  ]);
  assert.deepEqual(list.filter((p) => p.rackPort!.group !== 'port').map((p) => p.label), ['Uplink 1', 'Uplink 2', 'Uplink 3', 'Uplink 4', 'Console', 'Mgmt']);
  const body = rackDeviceBox(unit('rack-u4'));
  for (const p of list) assert.ok(p.x >= body.x && p.y >= body.y && p.x + p.w <= body.x + body.w && p.y + p.h <= body.y + body.h + 1e-9);
  assert.equal(syncRacks(st().diagram.shapes), st().diagram.shapes, 'in sync after fitting');
  // Interfaces travel with the rack, rotation included.
  st().updateShape('rack', { x: 300, rotation: 90 });
  const moved = ports('rack-u4');
  assert.deepEqual(moved.map((p) => p.id), list.map((p) => p.id));
  assert.ok(moved.every((p) => p.rotation === 90));
  const c = { x: moved[0].x + moved[0].w / 2, y: moved[0].y + moved[0].h / 2 };
  assert.equal(pickShapeAt(c, st().diagram.shapes, effectiveZMap(st().diagram.shapes, []))?.id, 'rack-u4-port-1');
});

test('an option change hides the interfaces it removes and restores the same ones, cables and all', () => {
  reset();
  st().setRackUnitDevice('rack-u4', 'switch');
  st().updateShape('rack-u4-port-20', { label: 'To core', meta: { stratumId: 'p20' } });
  st().addConnector({ id: 'c', from: { shape: 'rack-u4-port-20', anchor: 'top' }, to: { x: 500, y: 0 }, routing: 'straight' });
  const visible = () => visibleItemIds(st().diagram.shapes, st().diagram.connectors, 'both');
  assert.equal(st().setRackDeviceOption('rack-u4', 'ports', 16), true);
  assert.equal(ports('rack-u4').filter((p) => p.rackPort!.group === 'port').length, 16);
  assert.equal(unit('rack-u4-port-20').rackPort!.hidden, true);
  assert.equal(visible().has('c'), false);
  assert.ok(ports('rack-u4', true).some((p) => p.id === 'rack-u4-port-20'));
  // Uplinks keep their own identities when the access port count changes.
  assert.equal(unit('rack-u4-uplink-1').rackPort!.hidden, undefined);
  assert.equal(st().setRackDeviceOption('rack-u4', 'ports', 48), true);
  const back = unit('rack-u4-port-20');
  assert.equal(back.rackPort!.hidden, undefined);
  assert.equal(back.label, 'To core');
  assert.deepEqual(back.meta, { stratumId: 'p20' });
  assert.equal(visible().has('c'), true);
  assert.equal(st().setRackDeviceOption('rack-u4', 'ports', 47), false, 'only catalogue values');
  assert.equal(st().setRackDeviceOption('rack-u4', 'ports', 48), false, 'no-op is not an edit');
  st().undo();
  assert.equal(unit('rack-u4-port-20').rackPort!.hidden, true);
});

test('a cable on an interface meets it on its cable side, whatever anchor was stored', () => {
  reset();
  st().setRackUnitDevice('rack-u4', 'switch');
  const top = unit('rack-u4-port-1');
  const bottom = unit('rack-u4-port-2');
  for (const anchor of ['left', 'auto', [0.9, 0.9]] as const) {
    const t = resolveEndpointPoint({ shape: top.id, anchor: anchor as never }, { x: 999, y: 999 }, st().diagram.shapes)!;
    assert.deepEqual([t.x, t.y], [top.x + top.w / 2, top.y]);
    const b = resolveEndpointPoint({ shape: bottom.id, anchor: anchor as never }, { x: -999, y: -999 }, st().diagram.shapes)!;
    assert.deepEqual([b.x, b.y], [bottom.x + bottom.w / 2, bottom.y + bottom.h]);
  }
  // One connection point each; the switch offers just its two ends.
  assert.deepEqual(smartAnchorPoints(top, true).map((p) => [p.fx, p.fy]), [[0.5, 0]]);
  assert.deepEqual(smartAnchorPoints(bottom, true).map((p) => [p.fx, p.fy]), [[0.5, 1]]);
  assert.deepEqual(smartAnchorPoints(unit('rack-u4'), true).map((p) => [p.fx, p.fy]), [[0, 0.5], [1, 0.5]]);
  st().setRackUnitDevice('rack-u6', 'blank');
  assert.equal(smartAnchorPoints(unit('rack-u6'), false).length, 8);
});

test('modules fill a chassis with linkable cards, blades, nodes and controllers', () => {
  reset(createRack('rack', 0, 0, 24));
  assert.equal(st().setRackUnitDevice('rack-u2', 'chassis-switch'), true);
  assert.equal(unit('rack-u2').rackUnit!.span, 7, 'catalogue height when the U above are free');
  const cards = children('rack-u2').filter((s) => s.rackModule);
  assert.deepEqual(cards.map((c) => [c.id, c.label, c.rackModule!.type]), [
    ['rack-u2-slot-1', 'Slot 1', 'card-rj45-48'],
    ['rack-u2-slot-2', 'Slot 2', 'card-rj45-48'],
    ['rack-u2-slot-3', 'Slot 3', 'supervisor'],
    ['rack-u2-slot-4', 'Slot 4', 'supervisor'],
    ['rack-u2-slot-5', 'Slot 5', 'card-rj45-48'],
    ['rack-u2-slot-6', 'Slot 6', 'card-rj45-48'],
  ]);
  assert.equal(children('rack-u2-slot-1').length, 48);
  assert.equal(unit('rack-u2-slot-1-port-7').parent, 'rack-u2-slot-1');
  assert.equal(ports('rack-u2').length, 48 * 4 + 2 * (8 + 3));
  // A different card: its ports replace the old ones, which stay stored.
  st().addConnector({ id: 'c', from: { shape: 'rack-u2-slot-1-port-40', anchor: 'top' }, to: { x: 900, y: 0 }, routing: 'straight' });
  assert.equal(st().setRackModuleType('rack-u2-slot-1', 'card-qsfp-8'), true);
  assert.equal(children('rack-u2-slot-1').length, 8);
  assert.equal(unit('rack-u2-slot-1-port-40').rackPort!.hidden, true);
  assert.equal(unit('rack-u2-slot-1-port-1').rackPort!.kind, 'qsfp');
  // Fewer slots hide whole modules, ports and all.
  st().setRackDeviceOption('rack-u2', 'slots', 4);
  assert.equal(unit('rack-u2-slot-5').rackModule!.hidden, true);
  assert.equal(unit('rack-u2-slot-5-port-1').rackPort!.hidden, true);
  // Blades and controllers are named for what they are.
  st().setRackUnitDevice('rack-u12', 'blade-chassis');
  assert.equal(children('rack-u12').filter((s) => s.rackModule).length, 16);
  assert.equal(unit('rack-u12-slot-3').label, 'Blade 3');
  st().setRackUnitDevice('rack-u22', 'storage-array');
  assert.deepEqual(children('rack-u22').filter((s) => s.rackModule).map((s) => s.label), ['Controller A', 'Controller B']);
  assert.deepEqual(children('rack-u22-slot-2').map((p) => p.label), ['Host 1', 'Host 2', 'Host 3', 'Host 4', 'Mgmt']);
});

test('fitting tall equipment takes the room there is, and a picked icon or a shelf item keeps its own', () => {
  reset();
  st().updateShape('rack-u6', { label: 'Reserved' });
  assert.equal(st().setRackUnitDevice('rack-u3', 'blade-chassis'), true);
  assert.equal(unit('rack-u3').rackUnit!.span, 3, 'up to the reserved U');
  st().setRackUnitDevice('rack-u8', 'shelf');
  const item = unit('rack-u8-slot-1');
  assert.equal(item.label, 'Item 1');
  st().updateShape(item.id, rackUnitIconPatch(item, { iconSvg: '<svg viewBox="0 0 24 24"></svg>' }, 'Mac mini', true));
  assert.equal(unit(item.id).label, 'Mac mini');
  assert.equal(unit(item.id).rackModule!.type, 'item');
  assert.equal(st().setRackUnitDevice('rack-u20', 'switch'), false, 'no such U');
});

test('Delete keeps every interface and module: it renames, empties or clears around them', () => {
  reset();
  st().setRackUnitDevice('rack-u4', 'switch');
  st().updateShape('rack-u4-port-3', { label: 'Uplink to core', meta: { stratumId: 'p3' } });
  st().addConnector({ id: 'c', from: { shape: 'rack-u4-port-3', anchor: 'top' }, to: { x: 500, y: 0 }, routing: 'straight' });
  st().setSelected('rack-u4-port-3');
  st().deleteSelection();
  assert.equal(unit('rack-u4-port-3').label, 'Port 3');
  assert.deepEqual(unit('rack-u4-port-3').meta, { stratumId: 'p3' });
  assert.equal(st().diagram.connectors.length, 1);
  // Clearing the unit hides its interfaces; refitting brings them back.
  const count = st().diagram.shapes.length;
  st().setSelected('rack-u4');
  st().deleteSelection();
  assert.equal(st().diagram.shapes.length, count);
  assert.equal(unit('rack-u4-port-3').rackPort!.hidden, true);
  assert.equal(st().diagram.connectors[0].from.shape, 'rack-u4-port-3');
  st().setRackUnitDevice('rack-u4', 'switch');
  assert.equal(unit('rack-u4-port-3').rackPort!.hidden, undefined);
  // A module empties instead of leaving.
  st().setRackUnitDevice('rack-u7', 'multi-node');
  st().setSelected('rack-u7-slot-2');
  st().deleteSelection();
  assert.equal(unit('rack-u7-slot-2').rackModule!.type, 'blank');
  assert.equal(unit('rack-u7-slot-2-nic-1').rackPort!.hidden, true);
  // Removing the rack removes everything in it.
  st().setSelected('rack');
  st().deleteSelection();
  assert.equal(st().diagram.shapes.length, 0);
});

test('copying a rack brings its equipment along; an interface or a unit alone leaves interfaces behind', () => {
  reset();
  st().setRackUnitDevice('rack-u4', 'switch');
  st().setRackUnitDevice('rack-u2', 'patch-panel');
  st().addConnector({ id: 'patch', from: { shape: 'rack-u4-port-2', anchor: 'top' }, to: { shape: 'rack-u2-port-1', anchor: 'top' }, routing: 'straight' });
  const all = st().diagram.shapes;
  const copyable = (ids: string[]) => rackCopyableIds(expandAllDescendants(new Set(ids), all), all);
  assert.equal(copyable(['rack']).size, all.length);
  assert.deepEqual([...copyable(['rack-u4-port-1'])], []);
  assert.deepEqual([...copyable(['rack-u4'])], ['rack-u4']);
  st().setSelected('rack');
  st().duplicateSelection();
  const copy = st().diagram.shapes.find((s) => s.kind === 'rack' && s.id !== 'rack')!;
  const units = getRackUnits(st().diagram.shapes, copy.id);
  const copiedSwitch = units.find((u) => u.rackUnit!.u === 4)!;
  assert.equal(ports(copiedSwitch.id).length, 30);
  assert.ok(ports(copiedSwitch.id).every((p) => !p.id.startsWith('rack-u4')));
  const cable = st().diagram.connectors.find((c) => c.id !== 'patch')!;
  assert.ok(ports(copiedSwitch.id).some((p) => 'shape' in cable.from && p.id === cable.from.shape));
  assert.deepEqual(syncRacks(st().diagram.shapes), st().diagram.shapes);
});

test('clicks land on the innermost interface or module, and the device between them', () => {
  reset(createRack('rack', 0, 0, 12));
  st().setRackUnitDevice('rack-u2', 'switch');
  st().setRackUnitDevice('rack-u5', 'multi-node');
  const all = st().diagram.shapes;
  const z = effectiveZMap(all, []);
  const centre = (s: Shape) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
  assert.equal(pickShapeAt(centre(unit('rack-u2-port-9')), all, z)?.id, 'rack-u2-port-9');
  const sw = unit('rack-u2');
  assert.equal(pickShapeAt({ x: sw.x + sw.w * 0.03, y: sw.y + sw.h / 2 }, all, z)?.id, 'rack-u2', 'the ear is the device');
  assert.equal(pickShapeAt(centre(unit('rack-u5-slot-3-nic-1')), all, z)?.id, 'rack-u5-slot-3-nic-1');
  const node = unit('rack-u5-slot-3');
  assert.equal(pickShapeAt({ x: node.x + node.w / 2, y: node.y + node.h * 0.3 }, all, z)?.id, 'rack-u5-slot-3');
});

test('unreadable rack fields fall back one at a time instead of dropping the shape', async () => {
  const { parseShapes } = await import('../src/store/schema');
  const base = { kind: 'service', layer: 'blueprint', x: 0, y: 0, w: 10, h: 10, parent: 'rack-u4' };
  const [unitShape, mod, port, plain] = parseShapes([
    { ...base, id: 'u', rackUnit: { u: 4, device: 'switch', span: 0, options: 'many', labelSide: 'up' } },
    { ...base, id: 'm', rackModule: { slot: 2, type: 'toaster', hidden: 'no' } },
    { ...base, id: 'p', rackPort: { group: 'port', n: 3, kind: 'x'.repeat(40), side: 'left' } },
    { ...base, id: 'q', rackPort: { group: '', n: 3 } },
  ]);
  assert.deepEqual(unitShape.rackUnit, { u: 4, device: 'switch', span: undefined, options: undefined, labelSide: undefined });
  assert.deepEqual(mod.rackModule, { slot: 2, type: undefined, hidden: undefined });
  assert.deepEqual(port.rackPort, { group: 'port', n: 3, kind: undefined, side: undefined });
  assert.equal(plain.rackPort, undefined);
  // An unknown option value reads as the catalogue default.
  const odd = { ...unit('rack-u4'), rackUnit: { u: 4, device: 'switch', options: { ports: 47, poe: 'maybe' } } } as Shape;
  assert.equal(rackUnitDevice(odd)!.options.ports, 24);
});

test('a device keeps the same slots and interfaces at any height it is squeezed or stretched to', () => {
  for (const spec of RACK_DEVICE_SPECS) {
    const options = rackDeviceOptions(spec);
    const device = { type: spec.type, spec, options };
    const keys = (rows: number) => {
      const face = rackDeviceFace(device, 224, 28 * rows - 2, rows);
      assert.equal(face.slots.length, rackModuleCount(spec, options), `${spec.type} at ${rows}U keeps every slot`);
      for (const s of face.slots) assert.ok(s.w > 0 && s.h > 0, `${spec.type} at ${rows}U: slot ${s.slot} has room`);
      return face.ports.map((p) => `${p.group}:${p.n}`).sort().join();
    };
    const natural = keys(spec.span);
    for (let rows = 1; rows <= Math.max(4, spec.span + 2); rows++)
      assert.equal(keys(rows), natural, `${spec.type} at ${rows}U has the same interfaces`);
  }
});

test('fitting from a search applies the options and height it named, in one undo step', () => {
  reset();
  const before = st().past.length;
  assert.equal(
    st().setRackUnitDevice('rack-u4', 'switch', { options: { ports: 48, portType: 'sfp', uplinks: 7 }, span: 3 }),
    true,
  );
  const fitted = unit('rack-u4').rackUnit!;
  assert.equal(fitted.device, 'switch');
  assert.equal(fitted.span, 3);
  assert.equal(fitted.options!.ports, 48);
  assert.equal(fitted.options!.portType, 'sfp');
  // Not a catalogue value: left at what the switch would have had.
  assert.notEqual(fitted.options!.uplinks, 7);
  assert.equal(ports('rack-u4').filter((p) => p.rackPort!.group === 'port').length, 48);
  assert.ok(ports('rack-u4').every((p) => p.rackPort!.group !== 'port' || p.rackPort!.kind === 'sfp'));
  assert.equal(st().past.length, before + 1);
  st().undo();
  assert.equal(unit('rack-u4').rackUnit!.device, undefined);
  // The height is clamped to the room: a UPS at U6 stops a 4U server at 2U.
  st().setRackUnitDevice('rack-u6', 'ups');
  assert.equal(st().setRackUnitDevice('rack-u4', 'server', { span: 4 }), true);
  assert.equal(unit('rack-u4').rackUnit!.span, 2);
  assert.equal(st().setRackUnitDevice('rack-u2', 'server', { span: Number.NaN }), true);
  assert.equal(unit('rack-u2').rackUnit!.span ?? 1, 1);
});
