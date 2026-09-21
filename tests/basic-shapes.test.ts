import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BASIC_SHAPES,
  SHAPE_PRESETS,
  basicShapeFromDrop,
} from '../src/editor/shapes/catalog';
import { closedFreeformGeometry } from '../src/editor/shapes/freeform';
import {
  polygonShapeOutline,
  closedOutlinePath,
  presetPath,
} from '../src/editor/canvas/presetPaths';
import { shapeAnchorPoint } from '../src/editor/canvas/routing';
import { pointInShape, fromShapeLocal } from '../src/editor/canvas/projection';
import { parseShapes } from '../src/store/schema';
import { diagramToYaml, yamlToDiagram } from '../src/store/persist';
import type { Shape, DiagramState } from '../src/store/types';

const outline = [
  { x: 20, y: 30 },
  { x: 180, y: 30 },
  { x: 180, y: 90 },
  { x: 80, y: 90 },
  { x: 80, y: 190 },
  { x: 20, y: 190 },
];
const shape: Shape = {
  id: 'custom',
  kind: 'polygon',
  layer: 'blueprint',
  strokeWidth: 2,
  ...closedFreeformGeometry(outline)!,
};

test('Basic Shapes adds at least twenty options, with valid shared click/drop geometry', () => {
  assert.ok(BASIC_SHAPES.length >= 29);
  assert.equal(
    new Set(BASIC_SHAPES.map((s) => s.id)).size,
    BASIC_SHAPES.length,
  );
  for (const spec of BASIC_SHAPES)
    assert.deepEqual(basicShapeFromDrop({ basicShapeId: spec.id }), spec);
  assert.equal(basicShapeFromDrop({ basicShapeId: 'missing' }), null);
  assert.equal(basicShapeFromDrop({ kind: 'script' }), null);
  for (const preset of SHAPE_PRESETS)
    for (const [w, h] of [
      [120, 90],
      [600, 30],
      [25, 400],
      [2, 2],
    ]) {
      const pts = polygonShapeOutline(10, 20, w, h, { preset });
      assert.ok(pts.length >= 3, preset);
      assert.ok(
        pts.every((p) => p.every(Number.isFinite)),
        preset,
      );
      const path = presetPath(preset, 10, 20, w, h);
      assert.match(path, /Z$/);
      assert.ok(!/NaN|Infinity/.test(path), preset);
      assert.equal(
        parseShapes([{ ...shape, polygonPreset: preset }])[0].polygonPreset,
        preset,
      );
    }
});

test('freeform closes an open stroke, ignores clicks/lines, simplifies straight edges and normalizes resize geometry', () => {
  assert.equal(closedFreeformGeometry([{ x: 1, y: 1 }]), null);
  assert.equal(
    closedFreeformGeometry([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 30, y: 30 },
    ]),
    null,
  );
  const g = closedFreeformGeometry([
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 40 },
  ])!;
  assert.equal(g.polygonVertices!.length, 3);
  const pts = polygonShapeOutline(g.x, g.y, g.w * 3, g.h * 2, {
    vertices: g.polygonVertices,
  });
  assert.deepEqual(pts, [
    [10, 10],
    [100, 10],
    [100, 70],
  ]);
  assert.match(closedOutlinePath(pts), / L 100 70 Z$/);
});

test('freeform picking respects concavities, rotation and mirrors', () => {
  assert.equal(pointInShape({ x: 45, y: 150 }, shape), true);
  assert.equal(pointInShape({ x: 140, y: 150 }, shape), false);
  const transformed = { ...shape, rotation: 45, flipH: true };
  assert.equal(
    pointInShape(fromShapeLocal({ x: 155, y: 150 }, transformed), transformed),
    true,
  );
  assert.equal(
    pointInShape(fromShapeLocal({ x: 60, y: 150 }, transformed), transformed),
    false,
  );
});

test('freeform anchors project onto drawn edges and survive saving and anisotropic resizing', () => {
  const triangle: Shape = {
    ...shape,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    polygonVertices: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  };
  assert.deepEqual(
    shapeAnchorPoint(triangle, 'right', null, [triangle]),
    [100, 50],
  );
  const resized = { ...triangle, w: 400, h: 300 };
  assert.deepEqual(
    shapeAnchorPoint(resized, 'right', null, [resized]),
    [200, 150],
  );
  const d: DiagramState = {
    version: '1.0',
    meta: { title: 'Freeform' },
    shapes: [resized],
    connectors: [],
    annotations: [],
  };
  const roundtrip = yamlToDiagram(diagramToYaml(d));
  assert.deepEqual(
    roundtrip.shapes[0].polygonVertices,
    resized.polygonVertices,
  );
  assert.equal(roundtrip.shapes[0].strokeWidth, 2);
  const invalid = parseShapes([
    {
      ...shape,
      polygonVertices: [
        { x: Infinity, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    },
  ]);
  assert.equal(invalid[0].polygonVertices, undefined);
});
