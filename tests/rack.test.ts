import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
const svgDom = new JSDOM();
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: svgDom.window.DOMParser });
test.after(() => svgDom.window.close());
import {
  createRack,
  getRackUnits,
  rackHeightPatch,
  rackLayout,
  rackUnitBox,
  syncRacks,
} from '../src/editor/rack/model';
import { RACK_EQUIPMENT } from '../src/editor/rack/catalog';
import { parseDiagram } from '../src/store/schema';
import { diagramToYaml, yamlToDiagram } from '../src/store/persist';
import { pickShapeAt } from '../src/editor/canvas/pick';
import { effectiveZMap } from '../src/editor/canvas/z-order';
import { shapeAnchorWorldPoint } from '../src/editor/canvas/routing';
import { shapeVisibleInMode, visibleItemIds } from '../src/store/layers';
import { parseIconSvg } from '../src/editor/canvas/icon-svg';
import type { DiagramState, Shape } from '../src/store/types';

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
const { insertLibraryShape, insertBundle, rackUnitTarget } =
  await import('../src/editor/insert');
const st = () => useEditor.getState();
const diagram = (shapes: Shape[]): DiagramState => ({
  version: '1.0',
  meta: {},
  shapes,
  connectors: [],
  annotations: [],
});
const reset = () => {
  st().loadDiagram(diagram([]), null);
  useEditor.setState({
    readOnly: false,
    layerMode: 'both',
    activeLayer: 'blueprint',
  });
};

test('icon insertion cannot target a rack hidden inside a collapsed subprocess', () => {
  reset();
  const rack = createRack('rack', 0, 0, 12);
  rack[0].parent = 'subprocess';
  st().addShapes([
    {
      id: 'subprocess',
      kind: 'container',
      x: 0,
      y: 0,
      w: 500,
      h: 600,
      layer: 'blueprint',
      notation: { type: 'bpmn-subprocess', collapsed: true },
    },
    ...rack,
  ]);
  const unit = getRackUnits(st().diagram.shapes, 'rack')[0];
  st().setSelected(unit.id);
  assert.equal(rackUnitTarget(), undefined);
  assert.equal(
    rackUnitTarget({ x: unit.x + unit.w / 2, y: unit.y + unit.h / 2 }),
    undefined,
  );
  st().updateShape('subprocess', {
    notation: { type: 'bpmn-subprocess', collapsed: false },
  });
  assert.equal(rackUnitTarget()?.id, unit.id);
});

test('changing U count preserves row pitch through compact header sizes', () => {
  const rack = createRack('rack', 0, 0, 12)[0];
  const pitch = rackLayout(rack).unitH;
  for (const units of [1, 3, 6, 12, 42, 100]) {
    const changed = { ...rack, ...rackHeightPatch(rack, units) };
    assert.ok(Math.abs(rackLayout(changed).unitH - pitch) < 1e-6);
  }
});

test('tiny and anisotropic rack resizing keeps every U inside the frame', () => {
  for (const [w, h] of [
    [2, 2],
    [500, 12],
    [12, 500],
    [1800, 2400],
  ]) {
    const shapes = createRack('rack', 10, 20, 100);
    const sized = syncRacks(
      shapes.map((s) => (s.kind === 'rack' ? { ...s, w, h } : s)),
    );
    for (const u of getRackUnits(sized, 'rack')) {
      assert.ok(u.x >= 10 && u.y >= 20);
      assert.ok(u.x + u.w <= 10 + w + 1e-6 && u.y + u.h <= 20 + h + 1e-6);
    }
  }
  assert.equal(getRackUnits(createRack('r', 0, 0, Infinity), 'r').length, 12);
});

test('unit wrapping and grouping cannot reparent a rack U or replace its link identity', () => {
  reset();
  st().addShapes(createRack('rack', 0, 0, 6));
  st().makeContainer('rack-u1');
  st().setSelected(['rack-u1', 'rack-u2']);
  st().groupSelection();
  assert.equal(st().diagram.shapes.length, 7);
  assert.equal(
    st().diagram.shapes.find((s) => s.id === 'rack-u1')?.parent,
    'rack',
  );
});

test('rack U slots are unique top-level shape targets, numbered from the bottom', () => {
  const shapes = createRack('rack', 100, 200, 42);
  const units = getRackUnits(shapes, 'rack');
  assert.equal(shapes[0].kind, 'rack');
  assert.equal(units.length, 42);
  assert.equal(new Set(shapes.map((s) => s.id)).size, 43);
  assert.ok(units.every((s) => s.kind === 'service' && s.parent === 'rack'));
  assert.ok(units[0].y > units[41].y);
  for (const s of units)
    assert.equal(
      pickShapeAt(
        { x: s.x + s.w / 2, y: s.y + s.h / 2 },
        shapes,
        effectiveZMap(shapes, []),
      )?.id,
      s.id,
    );
  assert.equal(
    pickShapeAt({ x: 110, y: 208 }, shapes, effectiveZMap(shapes, []))?.id,
    'rack',
  );
});
test('resize, rotation and numbering preserve unit identities, metadata, and connection anchors', () => {
  let shapes = createRack('rack', 100, 100, 12);
  shapes[1] = {
    ...shapes[1],
    label: 'Switch',
    meta: { integration: { stratumId: 'stratum-one' } },
    iconSvg: RACK_EQUIPMENT[1].svg,
  };
  const original = shapes[1];
  shapes = syncRacks(
    shapes.map((s) =>
      s.id === 'rack'
        ? {
            ...s,
            x: 400,
            y: 300,
            w: 440,
            h: 640,
            rotation: 90,
            rack: { units: 12, numbering: 'top-down' },
          }
        : s,
    ),
  );
  const unit = shapes[1];
  assert.equal(unit.id, original.id);
  assert.equal(unit.iconSvg, original.iconSvg);
  assert.deepEqual(unit.meta, original.meta);
  assert.deepEqual(
    { x: unit.x, y: unit.y, w: unit.w, h: unit.h, rotation: unit.rotation },
    rackUnitBox(shapes[0], 1),
  );
  const right = shapeAnchorWorldPoint(unit, 'right');
  assert.ok(Math.abs(right[0] - (unit.x + unit.w / 2)) < 0.001);
  assert.ok(Math.abs(right[1] - (unit.y + unit.h / 2 + unit.w / 2)) < 0.001);
  assert.equal(syncRacks(shapes), shapes, 'normalization must be idempotent');
});
test('reducing height retains upper equipment, IDs and links, and raising height restores them', () => {
  reset();
  st().addShapes(createRack('rack', 0, 0, 12));
  st().updateShape('rack-u12', {
    label: 'Backup',
    iconSvg: RACK_EQUIPMENT[0].svg,
    meta: { stratumId: 's12' },
  });
  st().addConnector({
    id: 'c',
    from: { shape: 'rack-u12', anchor: 'right' },
    to: { shape: 'rack-u1', anchor: 'right' },
    routing: 'orthogonal',
  });
  const upper = st().diagram.shapes.find((s) => s.id === 'rack-u12')!;
  st().updateShape('rack', rackHeightPatch(st().diagram.shapes[0], 6));
  assert.equal(getRackUnits(st().diagram.shapes, 'rack').length, 6);
  assert.equal(getRackUnits(st().diagram.shapes, 'rack', true).length, 12);
  assert.equal(
    visibleItemIds(st().diagram.shapes, st().diagram.connectors, 'both').has(
      'c',
    ),
    false,
  );
  st().updateShape('rack', rackHeightPatch(st().diagram.shapes[0], 12));
  const restored = st().diagram.shapes.find((s) => s.id === upper.id)!;
  assert.equal(restored.iconSvg, upper.iconSvg);
  assert.deepEqual(restored.meta, upper.meta);
  assert.equal(
    visibleItemIds(st().diagram.shapes, st().diagram.connectors, 'both').has(
      'c',
    ),
    true,
  );
  assert.equal(st().diagram.connectors[0].from.shape, upper.id);
});
test('rack and hidden U data survive YAML and workspace-compatible parsing', () => {
  const shapes = createRack('rack', 10, 20, 12);
  shapes[12] = { ...shapes[12], meta: { stratumId: 'keep-me' } };
  const small = syncRacks(
    shapes.map((s) =>
      s.id === 'rack' ? { ...s, ...rackHeightPatch(s, 6) } : s,
    ),
  );
  const read = yamlToDiagram(diagramToYaml(diagram(small)));
  assert.deepEqual(
    JSON.parse(JSON.stringify(read.shapes)),
    JSON.parse(JSON.stringify(small)),
  );
  assert.equal(shapeVisibleInMode(read.shapes[12], 'both'), false);
  const minimal = parseDiagram(diagram([{ ...shapes[0], rack: undefined }]));
  assert.equal(getRackUnits(minimal.shapes, 'rack').length, 12);
});
test('native rack insertion, U equipment changes and height changes have complete undo steps', () => {
  reset();
  insertLibraryShape(
    { id: 'rack-12u', label: '12U rack', glyph: '', libName: 'Racks' },
    { x: 400, y: 300 },
  );
  const rack = st().diagram.shapes.find((s) => s.kind === 'rack')!;
  const u = getRackUnits(st().diagram.shapes, rack.id)[0];
  st().setSelected(u.id);
  insertLibraryShape({
    id: 'rack-switch',
    label: 'Network switch',
    glyph: '',
    libName: 'Racks',
  });
  assert.equal(st().diagram.shapes.length, 13);
  assert.ok(st().diagram.shapes.find((s) => s.id === u.id)?.iconSvg);
  st().undo();
  assert.equal(
    st().diagram.shapes.find((s) => s.id === u.id)?.iconSvg,
    undefined,
  );
  st().undo();
  assert.equal(st().diagram.shapes.length, 0);
  st().redo();
  st().updateShape(rack.id, rackHeightPatch(rack, 24));
  assert.equal(getRackUnits(st().diagram.shapes, rack.id).length, 24);
  st().undo();
  assert.equal(getRackUnits(st().diagram.shapes, rack.id).length, 12);
});
test('duplicate and clipboard reassign every U identity and bind copied connections only to copied units', () => {
  for (const action of ['duplicate', 'paste', 'bundle'] as const) {
    reset();
    st().addShapes(createRack('rack', 0, 0, 6));
    st().addConnector({
      id: 'link',
      from: { shape: 'rack-u1', anchor: 'right' },
      to: { shape: 'rack-u2', anchor: 'right' },
      routing: 'orthogonal',
    });
    st().setSelected('rack');
    if (action === 'duplicate') st().duplicateSelection();
    else if (action === 'paste') {
      st().copySelection();
      st().paste();
    } else
      insertBundle({
        label: 'Rack',
        glyph: '',
        shapes: st().diagram.shapes,
        connectors: st().diagram.connectors,
      });
    const copy = st().diagram.shapes.find(
      (s) => s.kind === 'rack' && s.id !== 'rack',
    )!;
    const units = getRackUnits(st().diagram.shapes, copy.id);
    assert.equal(units.length, 6, action);
    assert.ok(units.every((s) => !s.id.startsWith('rack-u')));
    assert.equal(new Set(st().diagram.shapes.map((s) => s.id)).size, 14);
    const c = st().diagram.connectors.find((c) => c.id !== 'link')!;
    assert.ok(units.some((s) => 'shape' in c.from && s.id === c.from.shape));
    assert.ok(units.some((s) => 'shape' in c.to && s.id === c.to.shape));
  }
});
test('Delete on a U clears its equipment while preserving identity and connector, Delete on rack removes its children', () => {
  reset();
  st().addShapes(createRack('rack', 0, 0, 6));
  st().updateShape('rack-u1', {
    iconSvg: RACK_EQUIPMENT[0].svg,
    label: 'Server',
    meta: { stratumId: 'one' },
  });
  st().addConnector({
    id: 'link',
    from: { shape: 'rack-u1', anchor: 'right' },
    to: { shape: 'rack-u2', anchor: 'right' },
    routing: 'orthogonal',
  });
  st().setSelected('rack-u1');
  st().deleteSelection();
  const unit = st().diagram.shapes.find((s) => s.id === 'rack-u1')!;
  assert.ok(unit);
  assert.equal(unit.iconSvg, undefined);
  assert.deepEqual(unit.meta, { stratumId: 'one' });
  assert.equal(st().diagram.connectors[0].from.shape, unit.id);
  st().undo();
  assert.equal(
    st().diagram.shapes.find((s) => s.id === unit.id)?.label,
    'Server',
  );
  st().setSelected('rack');
  st().deleteSelection();
  assert.equal(st().diagram.shapes.length, 0);
});
test('copying just one U detaches an ordinary icon without creating stray rack slots', () => {
  reset();
  st().addShapes(createRack('rack', 0, 0, 6));
  st().updateShape('rack-u1', { iconSvg: RACK_EQUIPMENT[0].svg });
  st().setSelected('rack-u1');
  st().duplicateSelection();
  const copy = st().diagram.shapes.find((s) => s.id === st().selectedIds[0])!;
  assert.equal(copy.parent, undefined);
  assert.equal(copy.rackUnit, undefined);
  assert.equal(copy.kind, 'icon');
  assert.equal(st().diagram.shapes.length, 8);
});
test('all equipment SVGs retain their paint and use independent instance IDs', () => {
  for (const e of RACK_EQUIPMENT) {
    const p = parseIconSvg(e.svg, 'u1')!;
    assert.ok(p);
    assert.match(p.inner, /stroke="currentColor"/);
    assert.match(p.inner, /fill="none"/);
  }
  const svg =
    '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>';
  assert.notEqual(parseIconSvg(svg, 'a')!.inner, parseIconSvg(svg, 'b')!.inner);
});

test('rack swaps move whole unit identities and commit one undo entry', () => {
  reset();
  st().addShapes(createRack('rack',0,0,12));
  st().updateShape('rack-u1',{label:'Server',iconSvg:RACK_EQUIPMENT[0].svg,fill:'#00ff00',meta:{stratumId:'server-stratum'}});
  st().updateShape('rack-u3',{label:'Switch',iconSvg:RACK_EQUIPMENT[1].svg,strokeWidth:3,meta:{stratumId:'switch-stratum'}});
  st().addConnector({id:'wire',from:{shape:'rack-u1',anchor:'right'},to:{shape:'rack-u3',anchor:'left'},routing:'straight'});
  st().setSelected('rack-u1');
  const before=structuredClone(st().diagram), history=st().past.length;
  st().swapRackUnits('rack-u1','rack-u3');
  const server=st().diagram.shapes.find(s=>s.id==='rack-u1')!;
  const network=st().diagram.shapes.find(s=>s.id==='rack-u3')!;
  assert.equal(server.rackUnit!.u,3);
  assert.equal(network.rackUnit!.u,1);
  assert.equal(server.label,'Server');
  assert.equal(server.iconSvg,RACK_EQUIPMENT[0].svg);
  assert.deepEqual(server.meta,{stratumId:'server-stratum'});
  assert.equal(server.fill,'#00ff00');
  assert.equal(network.strokeWidth,3);
  assert.deepEqual(network.meta,{stratumId:'switch-stratum'});
  assert.deepEqual(st().diagram.connectors[0].from,{shape:'rack-u1',anchor:'right'});
  assert.deepEqual(st().diagram.connectors[0].to,{shape:'rack-u3',anchor:'left'});
  assert.equal(st().past.length,history+1);
  const after=structuredClone(st().diagram);
  st().undo();
  assert.deepEqual(st().diagram,before);
  st().redo();
  assert.deepEqual(st().diagram,after);
});

test('cross-rack swaps preserve IDs, stratum metadata and equipment while adopting destination geometry', () => {
  reset();
  st().addShapes([...createRack('a',30,40,8),...createRack('b',400,100,16)]);
  st().updateShape('b',{w:400,rotation:25,rack:{units:16,numbering:'top-down'},layer:'notes'});
  st().updateShape('a-u2',{label:'Router',iconSvg:RACK_EQUIPMENT[1].svg,meta:{stratumId:'router'},iconAttribution:{holder:'Test fixture',iconId:'router',license:'CC0-1.0',source:'iconify',sourceUrl:'https://example.test/router'}});
  st().updateShape('b-u5',{meta:{stratumId:'reserved'}});
  const ids=st().diagram.shapes.map(s=>s.id).sort();
  st().swapRackUnits('a-u2','b-u5');
  const all=st().diagram.shapes;
  const moved=all.find(s=>s.id==='a-u2')!;
  const empty=all.find(s=>s.id==='b-u5')!;
  assert.deepEqual(all.map(s=>s.id).sort(),ids);
  assert.equal(getRackUnits(all,'a').length,8);
  assert.equal(getRackUnits(all,'b').length,16);
  assert.equal(moved.parent,'b');
  assert.equal(moved.rackUnit!.u,5);
  assert.equal(moved.layer,'notes');
  assert.equal(moved.iconAttribution!.iconId,'router');
  assert.deepEqual(moved.meta,{stratumId:'router'});
  assert.deepEqual(Object.fromEntries(Object.keys(rackUnitBox(all.find(s=>s.id==='b')!,5)).map(k=>[k,moved[k as keyof Shape]])),rackUnitBox(all.find(s=>s.id==='b')!,5));
  assert.equal(empty.parent,'a');
  assert.equal(empty.rackUnit!.u,2);
  assert.equal(empty.label,'U2');
  assert.deepEqual(empty.meta,{stratumId:'reserved'});
  assert.equal(empty.iconSvg,undefined);
  assert.deepEqual(syncRacks(all),all);
  // SVG sanitization needs a browser; the pointer tests also reload artwork.
  const loaded=yamlToDiagram(diagramToYaml({...st().diagram,shapes:st().diagram.shapes.map(s=>({...s,iconSvg:undefined,iconAttribution:undefined}))}));
  assert.equal(loaded.shapes.find(s=>s.id==='a-u2')!.rackUnit!.u,5);
  assert.equal(loaded.shapes.find(s=>s.id==='a-u2')!.parent,'b');
  st().updateShape('b',{x:600});
  assert.equal(st().diagram.shapes.find(s=>s.id==='a-u2')!.x,moved.x+200);
});

test('same-unit, unavailable-target and read-only swaps leave the diagram and history untouched', () => {
  reset();
  st().addShapes([...createRack('a',0,0,4),...createRack('b',400,0,8)]);
  st().updateShape('b',rackHeightPatch(st().diagram.shapes.find(s=>s.id==='b')!,4));
  const check=(target:string)=>{
    const before=st().diagram,depth=st().past.length;
    st().swapRackUnits('a-u1',target);
    assert.equal(st().diagram,before);
    assert.equal(st().past.length,depth);
  };
  for(const id of ['a-u1','missing','a','b-u8'])check(id);
  useEditor.setState({readOnly:true});
  check('a-u2');
  useEditor.setState({readOnly:false,layerMode:'blueprint'});
  st().updateShape('b',{layer:'notes'});
  check('b-u1');
  useEditor.setState({layerMode:'both'});
  st().addShape({id:'sub',kind:'container',x:390,y:0,w:350,h:400,layer:'notes',notation:{type:'bpmn-subprocess',collapsed:true}});
  st().updateShape('b',{parent:'sub'});
  check('b-u1');
});

const looseIcon = (): Shape => ({
  id:'loose',kind:'icon',x:400,y:100,w:80,h:80,layer:'blueprint',
  iconSvg:RACK_EQUIPMENT[0].svg,label:'Edge server',body:'Serial 123',stroke:'#123456',
  meta:{serial:'123',stratumId:'icon-stratum'},
  iconAttribution:{holder:'Test fixture',iconId:'server',license:'CC0-1.0',source:'iconify',sourceUrl:'https://example.test/server'},
});

test('canvas icon assignment retains the U identity, artwork tint and both sets of connectors', () => {
  reset();
  st().addShapes([...createRack('rack',0,0,6),looseIcon()]);
  st().updateShape('rack-u2',{label:'Old switch',iconSvg:RACK_EQUIPMENT[1].svg,fill:'#abcdef',stroke:'#999999',meta:{stratumId:'unit-stratum'}});
  st().addConnector({id:'icon-wire',from:{shape:'loose',anchor:'right'},to:{shape:'rack-u1',anchor:'left'},routing:'straight'});
  st().addConnector({id:'unit-wire',from:{shape:'rack-u2',anchor:'right'},to:{shape:'loose',anchor:'left'},routing:'straight'});
  const before=structuredClone(st().diagram),depth=st().past.length;
  const oldUnit=st().diagram.shapes.find(s=>s.id==='rack-u2')!;
  assert.equal(st().assignIconToRackUnit('loose','rack-u2'),true);
  const after=st().diagram,unit=after.shapes.find(s=>s.id==='rack-u2')!;
  assert.equal(after.shapes.length,before.shapes.length-1);
  assert.equal(after.shapes.some(s=>s.id==='loose'),false);
  assert.deepEqual(getRackUnits(after.shapes,'rack').map(s=>s.id),getRackUnits(before.shapes,'rack').map(s=>s.id));
  assert.deepEqual(unit,{...oldUnit,icon:undefined,iconSvg:looseIcon().iconSvg,iconAttribution:looseIcon().iconAttribution,iconConstraints:undefined,iconTint:'#123456',iconRecolor:'solid',label:'Edge server',body:'Serial 123',meta:{serial:'123',stratumId:'unit-stratum'}});
  assert.deepEqual(after.connectors[0].from,{shape:'rack-u2',anchor:'right'});
  assert.deepEqual(after.connectors[1].from,{shape:'rack-u2',anchor:'right'});
  assert.deepEqual(after.connectors[1].to,{shape:'rack-u2',anchor:'left'});
  assert.deepEqual(st().selectedIds,['rack-u2']);
  assert.equal(st().past.length,depth+1);
  st().undo();assert.deepEqual(st().diagram,before);
  st().redo();assert.deepEqual(st().diagram,after);
});

test('assignment folds a live canvas drag into one history step and can target behind its icon', () => {
  reset();
  st().addShapes([...createRack('rack',0,0,6),looseIcon()]);
  const before=structuredClone(st().diagram),depth=st().past.length;
  const unit=st().diagram.shapes.find(s=>s.id==='rack-u3')!;
  const p={x:unit.x+unit.w/2,y:unit.y+unit.h/2};
  st().updateShapesLive([{id:'loose',patch:{x:p.x-40,y:p.y-40}}]);
  assert.equal(rackUnitTarget(p),undefined);
  assert.equal(rackUnitTarget(p,['loose'])?.id,'rack-u3');
  assert.equal(st().assignIconToRackUnit('loose','rack-u3',true),true);
  assert.equal(st().past.length,depth);
  st().commitHistory();
  assert.equal(st().past.length,depth+1);
  st().undo();assert.deepEqual(st().diagram,before);
});

test('assignment rejects invalid, hidden and read-only destinations without changing history', () => {
  reset();
  st().addShapes([...createRack('rack',0,0,6),looseIcon()]);
  st().updateShape('rack',rackHeightPatch(st().diagram.shapes[0],3));
  const check=(source:string,target:string)=>{
    const before=st().diagram,depth=st().past.length;
    assert.equal(st().assignIconToRackUnit(source,target),false);
    assert.equal(st().diagram,before);assert.equal(st().past.length,depth);
  };
  for(const id of ['loose','rack','missing','rack-u6'])check('loose',id);
  check('rack-u1','rack-u2');
  useEditor.setState({readOnly:true});check('loose','rack-u1');
  useEditor.setState({readOnly:false,layerMode:'blueprint'});
  st().updateShape('rack',{layer:'notes'});check('loose','rack-u1');
  useEditor.setState({layerMode:'both'});
  st().addShape({id:'sub',kind:'container',x:0,y:0,w:350,h:400,layer:'blueprint',notation:{type:'bpmn-subprocess',collapsed:true}});
  st().updateShape('rack',{parent:'sub'});check('loose','rack-u1');
});
