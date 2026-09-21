import {
  notationPartitions,
  dragPartition,
} from '../src/editor/notation/partitions';
import { NativeShapeText } from '../src/editor/notation/NativeShape';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  NOTATION_CATALOG,
  notationShape,
  RELATIONSHIPS,
} from '../src/editor/notation/catalog';
import {
  notationGeometry,
  calloutGeometry,
  dragCallout,
} from '../src/editor/notation/geometry';
import { NativeShapeBody } from '../src/editor/notation/NativeShape';
import { shapeAnchorPoint } from '../src/editor/canvas/routing';
import { parseShapes, parseConnectors } from '../src/store/schema';
import { diagramToYaml, yamlToDiagram } from '../src/store/persist';
import type { Shape, Connector, DiagramState } from '../src/store/types';

test('every native symbol renders valid world geometry at small, wide and tall sizes', () => {
  for (const d of NOTATION_CATALOG)
    for (const [w, h] of [
      [2, 2],
      [120, 90],
      [600, 70],
      [50, 500],
    ]) {
      const shape = { ...notationShape(d.id, 's', 10, 20, 'blueprint')!, w, h };
      const g = notationGeometry(shape);
      assert.ok(g.parts.length, d.id);
      assert.ok(g.outline.length >= 3, d.id);
      assert.ok(
        g.parts.every((p) => !/NaN|Infinity/.test(p.d)),
        d.id,
      );
      assert.ok(
        g.outline.every((p) => p.every(Number.isFinite)),
        d.id,
      );
      assert.deepEqual(parseShapes([shape])[0].notation, shape.notation);
    }
});
test('anisotropic resizing keeps outline, compartments and BPMN marker strokes constant', () => {
  for (const type of [
    'uml-class',
    'bpmn-task',
    'bpmn-start',
    'bpmn-exclusive',
    'flow-document',
  ]) {
    const shape = notationShape(type, 's', 10, 10, 'blueprint')!;
    shape.strokeWidth = 2;
    const before = renderToStaticMarkup(
      createElement(NativeShapeBody, { shape, stroke: '#222', fill: '#fff' }),
    );
    const after = renderToStaticMarkup(
      createElement(NativeShapeBody, {
        shape: { ...shape, w: shape.w * 4, h: shape.h * 1.3 },
        stroke: '#222',
        fill: '#fff',
      }),
    );
    assert.deepEqual(
      [...after.matchAll(/stroke-width="([^"]+)"/g)].map((m) => m[1]),
      [...before.matchAll(/stroke-width="([^"]+)"/g)].map((m) => m[1]),
    );
    assert.ok(!after.includes('scale('));
    assert.notEqual(before, after);
  }
});
test('callout tail width and length stay fixed through resize and stay inside bounds', () => {
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    for (const [w, h] of [
      [120, 90],
      [500, 400],
      [9, 3],
    ]) {
      const b = { x: 40, y: 70, w, h };
      const g = calloutGeometry(b, {
        side,
        position: 0,
        tip: 1,
        width: 28,
        length: 24,
      });
      assert.ok(
        g.outline.every(
          ([x, y]) =>
            x >= 40 - 1e-8 &&
            x <= 40 + w + 1e-8 &&
            y >= 70 - 1e-8 &&
            y <= 70 + h + 1e-8,
        ),
      );
      if (w >= 120) {
        assert.equal(g.width, 28);
        assert.equal(g.length, 24);
      }
    }
  }
});
test('tail dragging moves its tip and preserves the speech bubble across all sides', () => {
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const s: Shape = {
      id: 'c',
      kind: 'polygon',
      polygonPreset: 'callout',
      x: 100,
      y: 200,
      w: 240,
      h: 180,
      layer: 'blueprint',
      callout: { side },
    };
    const before = calloutGeometry(s, s.callout);
    const tip: [number, number] = [...before.tip];
    if (side === 'top') tip[1] -= 40;
    if (side === 'bottom') tip[1] += 40;
    if (side === 'left') tip[0] -= 40;
    if (side === 'right') tip[0] += 40;
    const changed = { ...s, ...dragCallout(s, 'tip', tip) };
    const after = calloutGeometry(changed, changed.callout);
    assert.deepEqual(after.body, before.body);
    assert.deepEqual(after.tip, tip);
    assert.equal(after.length, 64);
  }
});
test('gateway/event/flowchart anchors are on the actual outline after resize', () => {
  const gateway = {
    ...notationShape('bpmn-exclusive', 'g', 100, 200, 'blueprint')!,
    w: 200,
    h: 80,
  };
  assert.deepEqual(shapeAnchorPoint(gateway, 'right'), [300, 240]);
  const diagonal = shapeAnchorPoint(gateway, [1, 1]);
  assert.ok(
    Math.abs((diagonal[0] - 200) / 100 + (diagonal[1] - 240) / 40 - 1) < 1e-6,
  );
  const event = {
    ...notationShape('bpmn-start', 'e', 100, 200, 'blueprint')!,
    w: 200,
    h: 80,
  };
  assert.deepEqual(shapeAnchorPoint(event, 'right'), [240, 240]);
  const callout: Shape = {
    id: 'c',
    kind: 'polygon',
    polygonPreset: 'callout',
    x: 0,
    y: 0,
    w: 200,
    h: 120,
    layer: 'blueprint',
    callout: { side: 'right', length: 30 },
  };
  const left = shapeAnchorPoint(callout, 'left');
  assert.ok(Math.abs(left[0]) < 1e-6);
});
test('native metadata and all UML/BPMN relationships round-trip through YAML', () => {
  const a = notationShape('uml-class', 'a', 0, 0, 'blueprint')!;
  a.notation = {
    ...a.notation!,
    attributes: '+ id: UUID\n- secret: string',
    operations: '+ save(): void',
    stereotype: 'entity',
  };
  const b = notationShape('bpmn-task', 'b', 350, 100, 'blueprint')!;
  b.notation = {
    ...b.notation!,
    taskType: 'service',
    loop: 'parallel',
    compensation: true,
  };
  const connectors: Connector[] = RELATIONSHIPS.map((r, i) => ({
    id: `c${i}`,
    from: { shape: 'a', anchor: 'auto' },
    to: { shape: 'b', anchor: 'auto' },
    routing: 'orthogonal',
    fromLabel: '1',
    toLabel: '0..*',
    ...r.patch,
  }));
  const diagram: DiagramState = {
    version: '1.0',
    meta: { title: 'Notation roundtrip' },
    shapes: [a, b],
    connectors,
    annotations: [],
  };
  const result = yamlToDiagram(diagramToYaml(diagram));
  assert.deepEqual(result.shapes, diagram.shapes);
  assert.deepEqual(result.connectors, parseConnectors(connectors));
});
test('invalid optional notation degrades without losing the rest of an old diagram', () => {
  const s = notationShape('uml-class', 'a', 0, 0, 'blueprint')!;
  const parsed = parseShapes([
    { ...s, notation: { type: 'unknown' }, callout: { length: -1 } },
  ])[0];
  assert.equal(parsed.id, 'a');
  assert.equal(parsed.notation, undefined);
  assert.equal(parsed.callout, undefined);
});

const { syncBoundaryEvents, hiddenByCollapsedAncestor, validateNotation } =
  await import('../src/editor/notation/model');
test('boundary events follow activity move/resize and can slide on an edge', () => {
  const host = notationShape('bpmn-task', 'task', 100, 200, 'blueprint')!;
  const boundary = {
    ...notationShape(
      'bpmn-boundary',
      'timer',
      host.x + 90,
      host.y + host.h - 22,
      'blueprint',
    )!,
    parent: 'task',
  };
  const attached = syncBoundaryEvents([host, boundary], [])[1];
  assert.equal(attached.y + attached.h / 2, host.y + host.h);
  const wider = { ...host, x: 300, w: 300 };
  const moved = syncBoundaryEvents([wider, attached], [host, attached])[1];
  assert.equal(moved.y + 22, wider.y + wider.h);
  assert.equal(
    moved.x + 22,
    wider.x + wider.w * attached.notation!.boundaryAnchor![0],
  );
  const sliding = syncBoundaryEvents(
    [wider, { ...moved, x: 500 }],
    [wider, moved],
  )[1];
  assert.equal(sliding.x, 500);
  assert.equal(sliding.notation!.boundaryAnchor![1], 1);
});
test('collapsed subprocess hides only its descendants, even through nested lanes', () => {
  const parent = notationShape('bpmn-subprocess', 'p', 0, 0, 'blueprint')!;
  parent.notation!.collapsed = true;
  const child = {
    ...notationShape('bpmn-task', 'c', 30, 30, 'blueprint')!,
    parent: 'p',
  };
  const outside = notationShape('uml-class', 'out', 0, 0, 'blueprint')!;
  const byId = new Map([parent, child, outside].map((s) => [s.id, s]));
  assert.equal(hiddenByCollapsedAncestor(parent, byId), false);
  assert.equal(hiddenByCollapsedAncestor(child, byId), true);
  assert.equal(hiddenByCollapsedAncestor(outside, byId), false);
});
test('BPMN checks catch cross-pool sequence flows, event direction and unattached boundaries', () => {
  const poolA = notationShape('bpmn-pool', 'pa', 0, 0, 'blueprint')!,
    poolB = notationShape('bpmn-pool', 'pb', 0, 400, 'blueprint')!;
  const from = {
    ...notationShape('bpmn-end', 'a', 30, 30, 'blueprint')!,
    parent: 'pa',
  };
  const to = {
    ...notationShape('bpmn-start', 'b', 30, 430, 'blueprint')!,
    parent: 'pb',
  };
  const boundary = notationShape('bpmn-boundary', 'be', 0, 0, 'blueprint')!;
  const c: Connector = {
    id: 'c',
    from: { shape: 'a', anchor: 'auto' },
    to: { shape: 'b', anchor: 'auto' },
    routing: 'straight',
    relationship: 'bpmn-sequence',
  };
  const d: DiagramState = {
    version: '1.0',
    meta: { title: 'Bad BPMN' },
    shapes: [poolA, poolB, from, to, boundary],
    connectors: [c],
    annotations: [],
  };
  const issues = validateNotation(d);
  assert.ok(issues.some((i) => i.message.includes('cross pools')));
  assert.ok(issues.some((i) => i.message.includes('outgoing sequence')));
  assert.ok(issues.some((i) => i.message.includes('incoming sequence')));
  assert.ok(issues.some((i) => i.id === 'be'));
});
test('sequence lifeline anchors can land anywhere along the dashed line', () => {
  const life = notationShape('uml-lifeline', 'l', 100, 100, 'blueprint')!;
  assert.deepEqual(shapeAnchorPoint(life, [1, 0.75]), [170, 340]);
  assert.deepEqual(shapeAnchorPoint(life, [0, 0.5]), [170, 260]);
});

test('shape and relationship catalog ids never collide', () => {
  const ids = [
    ...NOTATION_CATALOG.map((d) => d.id),
    ...RELATIONSHIPS.map((r) => r.id),
  ];
  assert.equal(new Set(ids).size, ids.length);
});

test('all notation shapes retain editable titles, including filled initial markers', () => {
  for (const d of NOTATION_CATALOG) {
    const shape = {
      ...notationShape(d.id, 'title', 0, 0, 'blueprint')!,
      label: 'Example',
      body: 'Example',
    };
    assert.ok(
      notationGeometry(shape).texts.some(
        (r) => r.role === 'title' && r.text.includes('Example'),
      ),
      d.id,
    );
  }
  const shape = {
    ...notationShape('uml-initial', 'initial', 0, 0, 'blueprint')!,
    body: 'Ready',
    w: 200,
    h: 200,
  };
  const rendered = renderToStaticMarkup(
    createElement(NativeShapeText, { shape, color: 'blue' }),
  );
  assert.match(rendered, /Ready/);
  assert.match(rendered, /fill="var\(--paper\)"/);
});

test('callout tips overhang every edge, change sides and survive YAML without moving the bubble', () => {
  let shape: Shape = {
    id: 'c',
    kind: 'polygon',
    polygonPreset: 'callout',
    x: 300,
    y: 200,
    w: 240,
    h: 180,
    layer: 'blueprint',
  };
  const body = calloutGeometry(shape).body;
  const targets: [number, number][] = [
    [100, 440],
    [780, 450],
    [800, 240],
    [400, 80],
    [100, 250],
  ];
  for (const point of targets) {
    shape = { ...shape, ...dragCallout(shape, 'tip', point) };
    const g = calloutGeometry(shape, shape.callout);
    for (const key of ['x', 'y', 'w', 'h'] as const)
      assert.ok(Math.abs(g.body[key] - body[key]) < 1e-8);
    assert.ok(Math.hypot(g.tip[0] - point[0], g.tip[1] - point[1]) < 1e-8);
    assert.ok(
      g.outline.every(
        ([x, y]) =>
          x >= shape.x - 1e-8 &&
          x <= shape.x + shape.w + 1e-8 &&
          y >= shape.y - 1e-8 &&
          y <= shape.y + shape.h + 1e-8,
      ),
    );
    const loaded = parseShapes([shape])[0];
    assert.deepEqual(loaded.callout, shape.callout);
  }
  const top = { ...shape, ...dragCallout(shape, 'base', [400, 195]) };
  assert.equal(top.callout?.side, 'top');
});

test('rotated and mirrored callout adjustments preserve the world position of the bubble', () => {
  const world = (s: Shape, point: [number, number]) => {
    const cx = s.x + s.w / 2,
      cy = s.y + s.h / 2;
    const x = (point[0] - cx) * (s.flipH ? -1 : 1),
      y = (point[1] - cy) * (s.flipV ? -1 : 1);
    const a = ((s.rotation ?? 0) * Math.PI) / 180;
    return [
      cx + x * Math.cos(a) - y * Math.sin(a),
      cy + x * Math.sin(a) + y * Math.cos(a),
    ];
  };
  for (const rotation of [0, 35, 90, 200])
    for (const flipH of [false, true])
      for (const flipV of [false, true]) {
        const s: Shape = {
          id: 'c',
          kind: 'polygon',
          polygonPreset: 'callout',
          x: 300,
          y: 200,
          w: 240,
          h: 180,
          layer: 'blueprint',
          rotation,
          flipH,
          flipV,
        };
        const a = calloutGeometry(s).body;
        const next = { ...s, ...dragCallout(s, 'tip', [150, 490]) };
        const b = calloutGeometry(next, next.callout).body;
        const before = world(s, [a.x, a.y]),
          after = world(next, [b.x, b.y]);
        assert.ok(
          Math.hypot(before[0] - after[0], before[1] - after[1]) < 1e-8,
        );
      }
});

test('flowchart compartments resize independently, constrain text and persist', () => {
  let s = notationShape('flow-predefined-process', 'p', 100, 200, 'blueprint')!;
  s = { ...s, ...dragPartition(s, 'left', s.x + 35, s.y) };
  s = { ...s, ...dragPartition(s, 'right', s.x + s.w - 27, s.y) };
  assert.equal(notationPartitions(s).left, 35);
  assert.equal(notationPartitions(s).right, 27);
  const r = notationGeometry(s).texts.find((r) => r.role === 'title')!;
  assert.ok(r.x >= s.x + 35 && r.x + r.w <= s.x + s.w - 27);
  assert.deepEqual(parseShapes([s])[0].notation, s.notation);
  const small = notationPartitions({ ...s, w: 20, h: 10 });
  assert.ok(small.left + small.right <= 17.00001);
  const storage = notationShape(
    'flow-internal-storage',
    's',
    100,
    200,
    'blueprint',
  )!;
  const adjusted = { ...storage, ...dragPartition(storage, 'top', 100, 230) };
  assert.equal(notationPartitions(adjusted).top, 30);
});

test('expanded notation has distinct geometry, editable names and non-scaling strokes', () => {
  for (const d of NOTATION_CATALOG) {
    const s = notationShape(d.id,'s',10,20,'blueprint')!;
    const original = renderToStaticMarkup(createElement(NativeShapeBody,{shape:s,stroke:'#222',fill:'#fff'}));
    const resized = renderToStaticMarkup(createElement(NativeShapeBody,{shape:{...s,w:s.w*3,h:s.h*2},stroke:'#222',fill:'#fff'}));
    assert.deepEqual([...original.matchAll(/stroke-width="([^"]+)"/g)].map(m=>m[1]), [...resized.matchAll(/stroke-width="([^"]+)"/g)].map(m=>m[1]),d.id);
    assert.ok(notationGeometry(s).texts.some(r=>r.role==='title'),d.id);
  }
  const shapes = ['uml-port','uml-input-pin','uml-provided-interface','uml-required-interface','uml-send-signal','uml-accept-signal','uml-entry-point','uml-exit-point','uml-terminate','uml-timing','bpmn-conversation','bpmn-sub-conversation','bpmn-choreography-task','bpmn-data-input','bpmn-data-output','bpmn-event-exclusive-start','bpmn-event-parallel-start','flow-sequential-access-storage','flow-magnetic-disk'].map(type=>notationGeometry(notationShape(type,'s',0,0,'blueprint')!).parts.map(p=>`${p.d}|${p.fill}`).join(';'));
  // Some standard symbols deliberately share outlines (entry point and
  // provided interface), so compare the variants whose details must differ.
  assert.notEqual(shapes[0],shapes[1]);
  assert.notEqual(shapes[2],shapes[3]);
  assert.notEqual(shapes[4],shapes[5]);
  assert.notEqual(shapes[6],shapes[7]);
  assert.notEqual(shapes[10],shapes[11]);
  assert.notEqual(shapes[13],shapes[14]);
  assert.notEqual(shapes[15],shapes[16]);
});

test('choreography participant settings and timing durations change geometry and survive YAML', () => {
  const s = notationShape('bpmn-choreography-task','choreo',10,20,'blueprint')!;
  s.notation = {...s.notation!,participantTop:'Buyer',participantBottom:'Seller',initiatingParticipant:'bottom',participantTopMultiple:true};
  const g = notationGeometry(s);
  assert.ok(g.texts.some(r=>r.text==='Buyer'));
  assert.ok(g.texts.some(r=>r.text==='Seller'));
  assert.equal(g.parts.filter(p=>p.fill==='shade').length,1);
  const original = notationGeometry({...s,notation:{...s.notation,initiatingParticipant:'top'}});
  assert.notEqual(g.parts.find(p=>p.fill==='shade')!.d,original.parts.find(p=>p.fill==='shade')!.d);
  const timing = notationShape('uml-timing','timing',0,0,'blueprint')!;
  const before = notationGeometry(timing);
  timing.notation = {...timing.notation!,timingSteps:[{state:'Waiting',duration:1},{state:'Active',duration:9}]};
  const after = notationGeometry(timing);
  assert.notDeepEqual(before.parts,after.parts);
  assert.ok(after.texts.some(r=>r.text==='Waiting'));
  assert.ok(after.texts.some(r=>r.text==='10'));
  const d:DiagramState={version:'1.0',meta:{title:'Extended notation'},shapes:[s,timing],connectors:[],annotations:[]};
  assert.deepEqual(yamlToDiagram(diagramToYaml(d)).shapes.map(s=>s.notation),d.shapes.map(s=>s.notation));
});

test('timing step input rejects invalid or zero durations', async () => {
  const {parseTimingSteps} = await import('../src/editor/notation/timing');
  assert.deepEqual(parseTimingSteps('Queued: 0.5\nRunning: 3'),[{state:'Queued',duration:.5},{state:'Running',duration:3}]);
  for(const value of ['', 'Idle','Idle: 0','Idle: -2',': 2','Idle: Infinity',Array(101).fill('Idle: 1').join('\n')]) assert.equal(parseTimingSteps(value),null);
});
