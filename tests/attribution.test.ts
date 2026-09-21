import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAttributions, getShapeAttribution, hasAttributableIcons } from '../src/icons/attribution';
import { assignRackUnitIcon, createRack } from '../src/editor/rack/model';
import type { DiagramState, Shape } from '../src/store/types';

test('rack conversion preserves attribution collection, including hidden units', () => {
  const rack = createRack('rack', 0, 0, 2);
  const source: Shape = { id: 'art', kind: 'icon', x: 400, y: 0, w: 40, h: 40, layer: 'blueprint', iconSvg: '<svg><rect width="4" height="4" /></svg>', iconAttribution: { source: 'vendor', iconId: 'vendor:device', holder: 'Example vendor', guidelinesUrl: 'https://example.com/brand' } };
  const result = assignRackUnitIcon([...rack, source], [], 'art', 'rack-u2')!;
  const unit = result.shapes.find(s => s.id === 'rack-u2')!;
  assert.equal(unit.kind, 'service');
  unit.rackUnit = { u: 2, hidden: true };
  const diagram: DiagramState = { version: '1.0', meta: {}, shapes: result.shapes, connectors: [], annotations: [] };
  assert.equal(hasAttributableIcons(diagram), true);
  assert.deepEqual(getShapeAttribution(unit), source.iconAttribution);
  assert.deepEqual(collectAttributions(diagram).vendors, [{ holder: 'Example vendor', guidelinesUrls: ['https://example.com/brand'], count: 1 }]);
});

test('collection notices include artwork on containers and service shapes', () => {
  const attribution = { source: 'iconify', iconId: 'set:item', holder: 'Author', license: 'CC-BY-4.0', sourceUrl: 'https://example.com/icons' } as const;
  const diagram = { version: '1.0', meta: {}, connectors: [], annotations: [], shapes: ['service', 'container'].map((kind, i) => ({ id: `${i}`, kind, x: 0, y: 0, w: 10, h: 10, layer: 'blueprint', iconAttribution: attribution })) } as DiagramState;
  assert.equal(collectAttributions(diagram).collections[0].count, 2);
});
