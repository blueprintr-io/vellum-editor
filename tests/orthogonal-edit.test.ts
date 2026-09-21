import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { moveOrthogonalSegment, routeOrthogonalSegments, simplifyOrthogonal } from '../src/editor/canvas/orthogonal-edit';
import { routeOrthogonal, type CardinalDir, type Rect, type ElbowEndpoint, type Point } from '../src/editor/canvas/elbow';
import { buildPath, connectorPolyline, resolveConnectorPath } from '../src/editor/canvas/routing';
import { diagramToYaml, yamlToDiagram } from '../src/store/persist';
import type { Connector, DiagramState, Shape } from '../src/store/types';

const from: ElbowEndpoint = { point: { x: 220, y: 240 }, rect: { x: 100, y: 200, w: 120, h: 80 }, dir: 'right' };
const to: ElbowEndpoint = { point: { x: 500, y: 440 }, rect: { x: 500, y: 400, w: 120, h: 80 }, dir: 'left' };
const z = [{ x: 220, y: 240 }, { x: 360, y: 240 }, { x: 360, y: 440 }, { x: 500, y: 440 }];

function orthogonal(points: Point[]) {
  assert.ok(points.length >= 2);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
    assert.ok(a.x === b.x || a.y === b.y, `diagonal ${JSON.stringify(points)}`);
    assert.notDeepEqual(a, b);
  }
}

test('middle segment slides on one axis without moving either endpoint', () => {
  const moved = moveOrthogonalSegment(z, 1, { x: 60, y: 87 });
  assert.deepEqual(moved, [z[0], { x: 420, y: 240 }, { x: 420, y: 440 }, z[3]]);
  assert.deepEqual(routeOrthogonalSegments(from, to, moved.slice(1, -1)), moved);
  assert.equal(z[1].x, 360, 'does not mutate pointer-down snapshot');
});

test('end segment grows a dogleg and retains both attachments', () => {
  const moved = moveOrthogonalSegment(z, 0, { x: 99, y: -80 });
  assert.deepEqual(moved, [z[0], { x: 240, y: 240 }, { x: 240, y: 160 }, { x: 360, y: 160 }, z[2], z[3]]);
  assert.deepEqual(routeOrthogonalSegments(from, to, moved.slice(1, -1)), moved);
});

test('straight elbow gains two terminal stubs and an offset rail', () => {
  const end = { ...to, point: { x: 500, y: 240 }, rect: { x: 500, y: 200, w: 120, h: 80 } };
  const moved = moveOrthogonalSegment([from.point, end.point], 0, { x: 0, y: -80 });
  assert.deepEqual(moved, [from.point, { x: 240, y: 240 }, { x: 240, y: 160 }, { x: 480, y: 160 }, { x: 480, y: 240 }, end.point]);
  assert.deepEqual(routeOrthogonalSegments(from, end, moved.slice(1, -1)), moved);
});

test('moving along a segment or back to its starting rail is a no-op', () => {
  assert.deepEqual(moveOrthogonalSegment(z, 1, { x: 0, y: 200 }), z);
  assert.deepEqual(moveOrthogonalSegment(z, 1, { x: 4, y: 200 }, 6), z);
  assert.equal(moveOrthogonalSegment(z, 1, { x: 4, y: 200 }, 0)[1].x, 364);
});

test('aligned segments lose redundant corners instead of leaving spikes', () => {
  const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 100 }, { x: 80, y: 100 }, { x: 80, y: 200 }, { x: 120, y: 200 }];
  assert.deepEqual(moveOrthogonalSegment(points, 1, { x: 37, y: 0 }, 6), [points[0], { x: 80, y: 0 }, points[4], points[5]]);
  assert.deepEqual(simplifyOrthogonal([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 }]), [{ x: 0, y: 0 }, { x: 0, y: 50 }]);
});

test('shape movement stretches only the terminal legs and retains the manual rail', () => {
  const movedFrom = { ...from, point: { x: 260, y: 280 }, rect: { ...from.rect!, x: 140, y: 240 } };
  assert.deepEqual(routeOrthogonalSegments(movedFrom, to, z.slice(1, -1)), [movedFrom.point, { x: 360, y: 280 }, z[2], to.point]);
});

test('moving the shape beyond the manual rail detours without reversing through it', () => {
  const movedFrom = { ...from, point: { x: 420, y: 240 }, rect: { ...from.rect!, x: 300 } };
  const points = routeOrthogonalSegments(movedFrom, to, z.slice(1, -1));
  orthogonal(points);
  assert.deepEqual(points[0], movedFrom.point);
  assert.ok(points[1].x >= 440);
  assert.deepEqual(points.at(-1), to.point);
  assert.ok(points.some(p => p.x === 360 && p.y === 440));
});

test('segment edits and terminal movement stay orthogonal in both axes', () => {
  for (const transpose of [false, true]) {
    const swap = (p: Point) => transpose ? { x: p.y, y: p.x } : p;
    const ends = [from, to].map(e => transpose ? {
      point: swap(e.point), dir: e.dir === 'right' ? 'bottom' as const : 'top' as const,
      rect: { x: e.rect!.y, y: e.rect!.x, w: e.rect!.h, h: e.rect!.w },
    } : e);
    for (let i = 0; i < z.length - 1; i++) {
      for (const offset of [-200, -80, 0, 80, 200]) {
        const moved = moveOrthogonalSegment(z.map(swap), i, { x: offset, y: offset });
        orthogonal(moved);
        const routed = routeOrthogonalSegments(ends[0], ends[1], moved.slice(1, -1));
        orthogonal(routed);
        assert.deepEqual(routed[0], ends[0].point);
        assert.deepEqual(routed.at(-1), ends[1].point);
      }
    }
  }
});

const shapes: Shape[] = [
  { id: 'a', kind: 'rect', ...from.rect!, layer: 'blueprint' },
  { id: 'b', kind: 'rect', ...to.rect!, layer: 'blueprint' },
];
const base: Connector = { id: 'c', from: { shape: 'a', anchor: 'right' }, to: { shape: 'b', anchor: 'left' }, routing: 'orthogonal' };
function geometry(c: Connector, shapesNow = shapes) {
  const p = resolveConnectorPath(c, shapesNow)!;
  const args = [p.fx, p.fy, p.tx, p.ty, p.fromAnchor, p.toAnchor, c.waypoints, p.fromRot, p.toRot, p.fromRect, p.toRect, c.waypointMode] as const;
  return {
    path: buildPath(c.routing, ...args),
    poly: connectorPolyline(c, p.fx, p.fy, p.tx, p.ty, p.fromAnchor, p.toAnchor, p.fromRot, p.toRot, p.fromRect, p.toRect),
  };
}

test('save/load preserves legacy and segment-edited connectors, including metadata', () => {
  const connectors: Connector[] = [base, { ...base, id: 'legacy', waypoints: [{ x: 410, y: 120 }, { x: 440, y: 360 }] },
    { ...base, id: 'edited', waypointMode: 'segments', waypoints: z.slice(1, -1), label: 'keep me', labelPosition: 0.7, fromMarker: 'circle', toMarker: 'triangle' },
    { ...base, id: 'curve', routing: 'curved', waypoints: [{ x: 410, y: 120 }] },
    { ...base, id: 'line', routing: 'straight' }];
  const diagram: DiagramState = { version: '1.0', meta: { title: 'compatibility' }, shapes, connectors, annotations: [] };
  const before = structuredClone(diagram);
  const loaded = yamlToDiagram(diagramToYaml(diagram));
  assert.deepEqual(diagram, before, 'rendering/serialization do not rewrite the document');
  assert.deepEqual(loaded.connectors, connectors);
  assert.deepEqual(loaded.connectors.map(c => geometry(c)), connectors.map(c => geometry(c)));
  assert.equal(loaded.connectors[1].waypointMode, undefined);
  assert.deepEqual(geometry(base).poly, routeOrthogonal(from, to));
  assert.deepEqual(geometry(connectors[2]).poly, z);
});


const directions: CardinalDir[] = ['left', 'right', 'top', 'bottom'];
function endpoint(rect: Rect, dir: CardinalDir): ElbowEndpoint {
  return { rect, dir, point: {
    x: dir === 'left' ? rect.x : dir === 'right' ? rect.x + rect.w : rect.x + rect.w / 2,
    y: dir === 'top' ? rect.y : dir === 'bottom' ? rect.y + rect.h : rect.y + rect.h / 2,
  } };
}
function pairs() {
  const result: [ElbowEndpoint, ElbowEndpoint][] = [];
  for (const x of [-240, 240, 480]) for (const y of [-200, 0, 200]) {
    for (const a of directions) for (const b of directions) {
      result.push([endpoint({ x: 0, y: 0, w: 120, h: 80 }, a), endpoint({ x, y, w: 120, h: 80 }, b)]);
    }
  }
  return result;
}
function leavesSide(points: Point[], e: ElbowEndpoint) {
  const a = points[0], b = points[1];
  assert.ok(e.dir === 'left' ? b.x < a.x : e.dir === 'right' ? b.x > a.x : e.dir === 'top' ? b.y < a.y : b.y > a.y,
    `reversed ${e.dir} attachment: ${JSON.stringify(points)}`);
}

test('4,224 segment edits, shape moves and rebindings retain orthogonality and attachment direction', () => {
  let count = 0;
  for (const [f, t] of pairs()) {
    const points = routeOrthogonal(f, t);
    for (let i = 0; i < points.length - 1; i++) for (const offset of [-60, 60]) {
      const edited = moveOrthogonalSegment(points, i, { x: offset, y: offset });
      for (const dir of directions) {
        const movedFrom = endpoint({ x: 30, y: 25, w: 120, h: 80 }, dir);
        const result = routeOrthogonalSegments(movedFrom, t, edited.slice(1, -1));
        orthogonal(result);
        assert.deepEqual(result[0], movedFrom.point);
        assert.deepEqual(result.at(-1), t.point);
        leavesSide(result, movedFrom);
        leavesSide([...result].reverse(), t);
        count++;
      }
    }
  }
  assert.equal(count, 4224);
});

test('288 legacy auto/waypoint routes match the pre-change geometry exactly', () => {
  // Digests captured from HEAD's original elbow.ts before this change.
  // Do not update these to bless a routing change: old documents must keep
  // using the legacy branch until the user explicitly edits the connector.
  const auto: Point[][] = [], manual: Point[][] = [];
  for (const [f, t] of pairs()) {
    const shapesNow: Shape[] = [
      { id: 'a', kind: 'rect', ...f.rect!, layer: 'blueprint' },
      { id: 'b', kind: 'rect', ...t.rect!, layer: 'blueprint' },
    ];
    const conn: Connector = { ...base, from: { shape: 'a', anchor: f.dir! }, to: { shape: 'b', anchor: t.dir! } };
    auto.push(geometry(conn, shapesNow).poly);
    manual.push(geometry({ ...conn, waypoints: [{ x: 160, y: -100 }, { x: 200, y: 140 }] }, shapesNow).poly);
  }
  const digest = (routes: Point[][]) => createHash('sha256').update(JSON.stringify(routes)).digest('hex');
  assert.equal(digest(auto), '59e3fdd99aefb55c87a1a601db5b046d9af7add7fd964008758d6b33cbe99f1b');
  assert.equal(digest(manual), '8a7edcf5eb3f184fe479630f837bf3abd75c3f41002e35528fd4e4852ad12e34');
});

test('marker setbacks do not reroute the short legs of an edited elbow', () => {
  const moved = moveOrthogonalSegment(z, 0, { x: 0, y: -80 });
  const rendered = routeOrthogonalSegments({ ...from, point: { x: 222, y: 240 } },
    { ...to, point: { x: 498, y: 440 } }, moved.slice(1, -1));
  assert.deepEqual(rendered.slice(1, -1), moved.slice(1, -1));
});

test('switching an edited curve back to elbow never connects off-axis corners diagonally', () => {
  const waypoints = [{ x: 300, y: 240 }, { x: 400, y: 320 }, { x: 440, y: 380 }];
  const before = structuredClone(waypoints);
  orthogonal(routeOrthogonalSegments(from, to, waypoints));
  assert.deepEqual(waypoints, before);
});
