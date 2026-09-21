import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, Shape } from '../src/store/types';
import type { PersonalLibraryEntry } from '../src/store/editor';

/** Programmatic insertion - the path a picker-tile click and a launcher pick
 *  share. The contract:
 *
 *   - a shape lands CENTRED on the requested point (the drop branches
 *     centre on the cursor; a click centres on the viewport);
 *   - inserting onto a spot that already holds a shape with the same
 *     top-left cascades down-right in paste-offset steps, so repeated
 *     clicks never stack invisibly;
 *   - the shape is selected and (for catalog items) stamped into Recent;
 *   - a personal-library bundle is re-id'd, its connectors follow the new
 *     ids, and its bounding box is what gets centred.
 *
 *  Runs against the actual store in Node - the recovery adapter
 *  stores preferences through localStorage, and Node's stub throws on
 *  setItem, so a Map-backed one goes in before the import. */
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
const {
  insertBasicShape,
  insertBundle,
  insertLibraryShape,
  insertBareShape,
  placeAt,
} = await import('../src/editor/insert');

const st = () => useEditor.getState();

/** Empty the diagram so each test starts from a blank canvas. */
function reset() {
  useEditor.setState((s) => ({
    diagram: { ...s.diagram, shapes: [], connectors: [] },
  }));
  st().setSelected(null);
}

const last = (): Shape => {
  const shapes = st().diagram.shapes;
  return shapes[shapes.length - 1];
};

test('placeAt centres on the point and only nudges when the spot is taken', () => {
  reset();
  assert.deepEqual(placeAt({ x: 100, y: 100 }, 40, 20), { x: 80, y: 90 });
  useEditor.setState((s) => ({
    diagram: {
      ...s.diagram,
      shapes: [
        { id: 'r', kind: 'rect', x: 80, y: 90, w: 40, h: 20, layer: 'blueprint' } as Shape,
      ],
    },
  }));
  assert.deepEqual(placeAt({ x: 100, y: 100 }, 40, 20), { x: 104, y: 114 });
});

test('insertLibraryShape lands a centred service tile, selects it, records Recent', () => {
  reset();
  insertLibraryShape(
    { id: 'lambda', label: 'Lambda', glyph: 'λ', libName: 'AWS' },
    { x: 400, y: 300 },
  );
  const s = last();
  assert.equal(s.kind, 'service');
  assert.equal(s.label, 'Lambda');
  assert.equal(s.icon, 'λ');
  // 130×64 centred on (400, 300).
  assert.equal(s.x, 400 - 65);
  assert.equal(s.y, 300 - 32);
  assert.deepEqual(st().selectedIds, [s.id]);
  assert.equal(st().recentShapes[0]?.key, 'library:lambda');
});

test('repeated inserts on the same point cascade instead of stacking', () => {
  reset();
  const at = { x: 400, y: 300 };
  insertLibraryShape({ id: 'a', label: 'A', glyph: 'A', libName: 'L' }, at);
  insertLibraryShape({ id: 'a', label: 'A', glyph: 'A', libName: 'L' }, at);
  insertLibraryShape({ id: 'a', label: 'A', glyph: 'A', libName: 'L' }, at);
  const xs = st().diagram.shapes.map((s) => s.x);
  const ys = st().diagram.shapes.map((s) => s.y);
  assert.deepEqual(xs, [335, 359, 383]);
  assert.deepEqual(ys, [268, 292, 316]);
});

test('insertBasicShape mirrors the basic-shape drop: polygon, no label, own seed', () => {
  reset();
  insertBasicShape({ sides: 5, star: true }, { x: 200, y: 200 });
  const star = last();
  assert.equal(star.kind, 'polygon');
  assert.equal(star.label, '');
  assert.equal(star.sides, 5);
  assert.equal(star.polygonStar, true);
  assert.equal(star.polygonPreset, undefined);
  assert.equal(typeof star.seed, 'number');
  // 120×90 centred on (200, 200).
  assert.equal(star.x, 140);
  assert.equal(star.y, 155);
  assert.deepEqual(st().selectedIds, [star.id]);

  insertBasicShape({ preset: 'cloud' }, { x: 600, y: 200 });
  const cloud = last();
  assert.equal(cloud.polygonPreset, 'cloud');
  assert.equal(cloud.sides, undefined);
});

test('insertBareShape still centres and cascades', () => {
  reset();
  insertBareShape('rect', { x: 100, y: 100 });
  insertBareShape('rect', { x: 100, y: 100 });
  const [a, b] = st().diagram.shapes;
  assert.equal(a.x, 30);
  assert.equal(a.y, 60);
  assert.equal(b.x, 54);
  assert.equal(b.y, 84);
});

test('insertBundle centres the bbox, re-ids shapes, and remaps connector ends', () => {
  reset();
  const entry: PersonalLibraryEntry = {
    label: 'Pair',
    glyph: 'PAI',
    shapes: [
      { id: 'a', kind: 'rect', x: 0, y: 0, w: 100, h: 50, layer: 'blueprint' } as Shape,
      { id: 'b', kind: 'rect', x: 200, y: 0, w: 100, h: 50, layer: 'blueprint' } as Shape,
    ],
    connectors: [
      {
        id: 'c',
        from: { shape: 'a', anchor: 'auto' },
        to: { shape: 'b', anchor: 'auto' },
        routing: 'straight',
      } as Connector,
    ],
  };
  insertBundle(entry, { x: 500, y: 400 });
  const shapes = st().diagram.shapes;
  const conns = st().diagram.connectors;
  assert.equal(shapes.length, 2);
  assert.equal(conns.length, 1);
  // Fresh ids - the library entry is never mutated or reused verbatim.
  assert.notEqual(shapes[0].id, 'a');
  assert.notEqual(shapes[1].id, 'b');
  assert.equal(entry.shapes[0].x, 0);
  // Bundle bbox is 300×50; centred on (500, 400) → top-left (350, 375).
  assert.equal(Math.min(shapes[0].x, shapes[1].x), 350);
  assert.equal(Math.max(shapes[0].x + shapes[0].w, shapes[1].x + shapes[1].w), 650);
  assert.equal(shapes[0].y, 375);
  // Connector follows the new ids.
  const c = conns[0];
  assert.ok('shape' in c.from && c.from.shape === shapes[0].id);
  assert.ok('shape' in c.to && c.to.shape === shapes[1].id);
  assert.notEqual(c.id, 'c');
  // The bundle is the selection afterwards.
  assert.deepEqual([...st().selectedIds].sort(), [...shapes.map((s) => s.id), ...conns.map((c) => c.id)].sort());
});

test('native UML/BPMN insertion uses geometry and one undo step inside a pool',()=>{
  st().loadDiagram({version:'1.0',meta:{title:'notation'},shapes:[{id:'pool',kind:'container',x:0,y:0,w:600,h:400,layer:'blueprint',notation:{type:'bpmn-pool'}}],connectors:[],annotations:[]},null);
  insertLibraryShape({id:'bpmn-task',label:'Task',glyph:'',libName:'BPMN'},{x:250,y:200});
  const task=last();
  assert.equal(task.notation?.type,'bpmn-task');assert.equal(task.kind,'rect');assert.equal(task.parent,'pool');
  st().undo();assert.deepEqual(st().diagram.shapes.map(s=>s.id),['pool']);
  st().redo();assert.equal(last().parent,'pool');
});
test('boundary insertion attaches to the selected task, survives duplicate, and undo restores geometry',()=>{
  reset();
  insertLibraryShape({id:'bpmn-task',label:'Task',glyph:'',libName:'BPMN'},{x:250,y:200});
  const task=last();
  insertLibraryShape({id:'bpmn-boundary',label:'Boundary',glyph:'',libName:'BPMN'});
  const boundary=last();assert.equal(boundary.parent,task.id);assert.equal(boundary.y+boundary.h/2,task.y+task.h);
  st().updateShape(task.id,{w:300,x:400});
  const moved=st().diagram.shapes.find(s=>s.id===boundary.id)!;
  assert.equal(moved.x+moved.w/2,400+300*boundary.notation!.boundaryAnchor![0]);
  st().undo();assert.equal(st().diagram.shapes.find(s=>s.id===boundary.id)!.x,boundary.x);
  st().setSelected(task.id);st().duplicateSelection();
  const copies=st().diagram.shapes.filter(s=>s.id!==task.id&&s.id!==boundary.id);
  assert.equal(copies.length,2);
  const copiedHost=copies.find(s=>s.notation?.type==='bpmn-task')!;
  assert.equal(copies.find(s=>s.notation?.type==='bpmn-boundary')!.parent,copiedHost.id);
});
test('relationship palette binds selected shapes and insertion is undoable',()=>{
  reset();insertBareShape('rect',{x:100,y:100});const a=last();insertBareShape('rect',{x:400,y:100});const b=last();st().setSelected([a.id,b.id]);
  insertLibraryShape({id:'uml-generalization',label:'Generalization',glyph:'',libName:'UML'});
  const c=st().diagram.connectors.at(-1)!;assert.equal(c.toMarker,'hollow-triangle');assert.deepEqual(c.from,{shape:a.id,anchor:'auto'});
  st().undo();assert.equal(st().diagram.connectors.length,0);
});

test('nested library fragments retain assets, links and connector geometry across documents', () => {
  reset();
  const hash = 'a'.repeat(64);
  const asset = { mime: 'image/png', data: 'aGVsbG8=' };
  const shapes: Shape[] = [
    { id: 'image', kind: 'image', parent: 'nested', x: 120, y: 240, w: 20, h: 20, layer: 'blueprint', src: `asset:${hash}` },
    { id: 'nested', kind: 'group', parent: 'outer', x: 110, y: 230, w: 50, h: 50, layer: 'blueprint', anchorId: 'image' },
    { id: 'outer', kind: 'group', x: 100, y: 200, w: 100, h: 100, layer: 'blueprint' },
  ];
  const connector: Connector = { id: 'line', parent: 'nested', layer: 'blueprint', from: { x: 115, y: 235 }, to: { shape: 'image', anchor: 'left' }, waypoints: [{ x: 117, y: 240 }] };
  useEditor.setState(s => ({ diagram: { ...s.diagram, shapes, connectors: [connector], assets: { [hash]: asset, ['b'.repeat(64)]: asset } }, personalLibrary: [] }));
  st().addToLibrary('Nested image', ['outer']);
  const entry = st().personalLibrary[0];
  assert.equal(entry.shapes.length, 3);
  assert.deepEqual(Object.keys(entry.assets ?? {}), [hash]);
  assert.deepEqual(entry.connectors[0].from, { x: 15, y: 35 });
  assert.deepEqual(entry.connectors[0].waypoints, [{ x: 17, y: 40 }]);
  st().newDiagram();
  insertBundle(entry, { x: 300, y: 400 }, 'top-left');
  const inserted = st().diagram;
  const image = inserted.shapes.find(s => s.kind === 'image')!;
  const nested = inserted.shapes.find(s => s.anchorId === image.id)!;
  const outer = inserted.shapes.find(s => s.id === nested.parent)!;
  assert.equal(image.parent, nested.id);
  assert.ok(outer && outer.id !== 'outer');
  assert.deepEqual(inserted.assets?.[hash], asset);
  assert.equal(inserted.connectors[0].parent, nested.id);
  assert.deepEqual(inserted.connectors[0].from, { x: 315, y: 435 });
  assert.deepEqual(inserted.connectors[0].waypoints, [{ x: 317, y: 440 }]);
  assert.equal((inserted.connectors[0].to as { shape: string }).shape, image.id);
  st().undo();
  assert.equal(st().diagram.shapes.length, 0);
  assert.equal(st().diagram.assets?.[hash], undefined);
  st().redo();
  assert.deepEqual(st().diagram.assets?.[hash], asset);
});

test('old library bundles without assets still insert through the shared click path', () => {
  reset();
  const entry = { label: 'Old bundle', glyph: 'OLD', shapes: [{ id: 'old', kind: 'rect', x: 0, y: 0, w: 40, h: 30, layer: 'blueprint' }], connectors: [] };
  insertBundle(entry, { x: 50, y: 60 });
  assert.equal(last().x, 30);
  assert.equal(last().y, 45);
  assert.notEqual(last().id, 'old');
});

test('connector-only library bundles remain selected and undoable after insertion', () => {
  reset();
  useEditor.setState(s => ({ diagram: { ...s.diagram, connectors: [{ id: 'line', from: { x: 10, y: 20 }, to: { x: 110, y: 20 }, waypoints: [{ x: 50, y: 40 }] }] }, personalLibrary: [] }));
  st().addToLibrary('Connector', ['line']);
  const entry = st().personalLibrary[0];
  st().newDiagram();
  insertBundle(entry, { x: 200, y: 300 }, 'top-left');
  const inserted = st().diagram.connectors[0];
  assert.deepEqual(st().selectedIds, [inserted.id]);
  assert.deepEqual(inserted.from, { x: 200, y: 300 });
  assert.deepEqual(inserted.waypoints, [{ x: 240, y: 320 }]);
  st().undo();
  assert.equal(st().diagram.connectors.length, 0);
  st().redo();
  assert.equal(st().diagram.connectors[0].id, inserted.id);
});

test('a library asset collision cannot overwrite unrelated document images', () => {
  reset();
  const hash = 'a'.repeat(64);
  const original = { mime: 'image/png', data: 'b3JpZ2luYWw=' };
  st().registerAssets({ [hash]: original });
  const before = st().diagram;
  const historyLength = st().past.length;
  assert.throws(() => insertBundle({
    shapes: [{ id: 'image', kind: 'image', src: `asset:${hash}`, x: 0, y: 0, w: 40, h: 30, layer: 'blueprint' }],
    connectors: [],
    assets: { [hash]: { mime: 'image/png', data: 'Y29uZmxpY3Q=' } },
  }, { x: 100, y: 100 }), /conflicts with existing image data/);
  assert.equal(st().diagram, before);
  assert.equal(st().past.length, historyLength);
  assert.deepEqual(st().diagram.assets?.[hash], original);
});
