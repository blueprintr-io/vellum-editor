import assert from 'node:assert/strict';
import test from 'node:test';

/** Line jumps (`.hop`): which connector bridges which, where the bridges go,
 *  how they're drawn, and that the setting sticks for the next line drawn.
 *
 *  The store half runs against the actual store in Node, so the same
 *  Map-backed localStorage shim as snap-settings.test.ts goes in before the
 *  store is imported. */
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

const {
  computeLineJumps,
  hoppedPath,
  jumpLineFor,
  reuseUnchangedHops,
} = await import('../src/editor/canvas/line-jumps');
const { polylineToRoundedPath } = await import('../src/editor/canvas/routing');
const { useEditor } = await import('../src/store/editor');

import type { Connector } from '../src/store/types';
import type { JumpLine } from '../src/editor/canvas/line-jumps';

type XY = { x: number; y: number };

function conn(partial: Partial<Connector> & Pick<Connector, 'id'>): Connector {
  return {
    from: { x: 0, y: 0 },
    to: { x: 10, y: 0 },
    routing: 'straight',
    toMarker: 'none',
    ...partial,
  } as Connector;
}

/** A jump line with hand-built geometry, for cases the router can't be
 *  talked into producing exactly. */
function line(c: Connector, pts: XY[], strokeWidth = 1.25): JumpLine {
  return { conn: c, strokes: [pts], strokeWidth };
}

const horizontal = (id: string, extra: Partial<Connector> = {}) =>
  jumpLineFor(
    conn({ id, from: { x: 0, y: 100 }, to: { x: 200, y: 100 }, ...extra }),
    [],
  )!;
const vertical = (id: string, x = 100, extra: Partial<Connector> = {}) =>
  jumpLineFor(
    conn({ id, from: { x, y: 0 }, to: { x, y: 200 }, ...extra }),
    [],
  )!;

/* ── who hops ─────────────────────────────────────────────────────────── */

test('a hop line bridges a plain line it crosses; the plain line stays flat', () => {
  const jumps = computeLineJumps([vertical('v'), horizontal('h', { hop: true })]);
  assert.equal(jumps.has('v'), false);
  const [hops] = jumps.get('h')!;
  assert.equal(hops.length, 1);
  // Centred on the crossing, 100px along.
  assert.ok(Math.abs((hops[0].start + hops[0].end) / 2 - 100) < 1e-9);
  assert.ok(hops[0].start > 80 && hops[0].end < 120);
});

test('when both lines hop, only the one painted on top bridges', () => {
  const lower = horizontal('lower', { hop: true });
  const upper = vertical('upper', 100, { hop: true });
  const jumps = computeLineJumps([lower, upper]);
  assert.equal(jumps.has('lower'), false);
  assert.equal(jumps.get('upper')![0].length, 1);

  // Swap the stacking and the other one hops.
  const swapped = computeLineJumps([upper, lower]);
  assert.equal(swapped.has('upper'), false);
  assert.equal(swapped.get('lower')![0].length, 1);
});

test('a hop line under a plain line still bridges it', () => {
  const jumps = computeLineJumps([horizontal('h', { hop: true }), vertical('v')]);
  assert.equal(jumps.get('h')![0].length, 1);
});

test('nothing is computed when no connector hops', () => {
  assert.equal(computeLineJumps([horizontal('h'), vertical('v')]).size, 0);
});

/* ── where bridges go ─────────────────────────────────────────────────── */

test('no bridge within reach of an endpoint or its marker', () => {
  // Crossing 5px from the start: the hop would begin before the line does.
  const nearStart = computeLineJumps([
    vertical('v', 5),
    horizontal('h', { hop: true }),
  ]);
  assert.equal(nearStart.has('h'), false);
  // 30px from an arrowhead end: clear of the line, but inside the marker's room.
  const nearArrow = computeLineJumps([
    vertical('v', 180),
    horizontal('h', { hop: true, toMarker: 'arrow', toMarkerSize: 16 }),
  ]);
  assert.equal(nearArrow.has('h'), false);
});

test('a hop is small: just wide enough to clear the line it crosses', () => {
  const [hop] = computeLineJumps([vertical('v'), horizontal('h', { hop: true })]).get('h')![0];
  assert.equal(hop.end - hop.start, 8);
});

test('lines crossing so close their hops would overlap share one', () => {
  const jumps = computeLineJumps([
    vertical('a', 95),
    vertical('b', 101),
    horizontal('h', { hop: true }),
  ]);
  const [hops] = jumps.get('h')!;
  assert.equal(hops.length, 1);
  assert.ok(hops[0].start < 95 && hops[0].end > 101);
});

test('lines crossing a little apart get a hop each', () => {
  const jumps = computeLineJumps([
    vertical('a', 95),
    vertical('b', 105),
    horizontal('h', { hop: true }),
  ]);
  assert.equal(jumps.get('h')![0].length, 2);
});

test('a shallow crossing gets no bridge', () => {
  const shallow = jumpLineFor(
    conn({ id: 's', from: { x: 0, y: 90 }, to: { x: 200, y: 110 } }),
    [],
  )!;
  assert.equal(computeLineJumps([shallow, horizontal('h', { hop: true })]).size, 0);
});

test('a line that ends on another is meeting it, not crossing it', () => {
  const tee = jumpLineFor(
    conn({ id: 't', from: { x: 100, y: 0 }, to: { x: 100, y: 100 } }),
    [],
  )!;
  assert.equal(computeLineJumps([tee, horizontal('h', { hop: true })]).size, 0);
});

test('a bridge never lands on an elbow corner', () => {
  const elbow = conn({ id: 'e', routing: 'orthogonal', hop: true });
  // Right 200px, then down 200px; the corner is rounded over 8px each side.
  const pts = [
    { x: 0, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 300 },
  ];
  const nearCorner = computeLineJumps([vertical('v', 190), line(elbow, pts)]);
  assert.equal(nearCorner.has('e'), false);
  const midSegment = computeLineJumps([vertical('v', 100), line(elbow, pts)]);
  assert.equal(midSegment.get('e')![0].length, 1);
});

test('a bidirectional hop line bridges on both of its lines', () => {
  const jumps = computeLineJumps([
    vertical('v'),
    horizontal('h', { hop: true, bidirectional: true }),
  ]);
  const hops = jumps.get('h')!;
  assert.equal(hops.length, 3);
  for (const stroke of hops) assert.equal(stroke.length, 1);
});

test('a bidirectional line is a wider obstacle than a single one', () => {
  const single = computeLineJumps([vertical('v'), horizontal('h', { hop: true })]);
  const pair = computeLineJumps([
    vertical('v', 100, { bidirectional: true }),
    horizontal('h', { hop: true }),
  ]);
  const span = (m: typeof single) => {
    const [h] = m.get('h')![0];
    return h.end - h.start;
  };
  assert.ok(span(pair) > span(single));
});

/* ── cost ─────────────────────────────────────────────────────────────── */

test('past its work budget the pass draws every crossing flat', () => {
  const lines = [vertical('a', 60), vertical('b', 140), horizontal('h', { hop: true })];
  assert.equal(computeLineJumps(lines, Infinity).get('h')![0].length, 2);
  // All or nothing: not one hop, rather than some lines hopping and some not.
  assert.equal(computeLineJumps(lines, 5).size, 0);
});

test('a long curved line finds the same crossings through the box index', () => {
  // A wide S-curve (dozens of samples, several index runs) crossing a comb
  // of verticals: every one it spans gets a hop, well clear of the others.
  const curve = jumpLineFor(
    conn({ id: 'k', routing: 'curved', hop: true, from: { x: 0, y: 0 }, to: { x: 1000, y: 400 } }),
    [],
  )!;
  const comb = [100, 300, 500, 700, 900].map((x) =>
    jumpLineFor(conn({ id: `v${x}`, from: { x, y: -50 }, to: { x, y: 450 } }), [])!,
  );
  const [hops] = computeLineJumps([...comb, curve]).get('k')!;
  assert.equal(hops.length, 5);
});

test('a route is worked out once and reused until the line or its shapes change', () => {
  const a = { id: 'A', kind: 'rect', x: 0, y: 0, w: 50, h: 50, layer: 'blueprint' } as never;
  const b = { id: 'B', kind: 'rect', x: 200, y: 0, w: 50, h: 50, layer: 'blueprint' } as never;
  const c = conn({ id: 'c', from: { shape: 'A', anchor: 'right' }, to: { shape: 'B', anchor: 'left' } });
  const first = jumpLineFor(c, [a, b]);
  // A new shapes array holding the same shapes: same route, same object.
  assert.equal(jumpLineFor(c, [a, b]), first);
  // Moving an end shape replaces its object, so the route is redone.
  const moved = { ...(b as object), x: 300 } as never;
  const again = jumpLineFor(c, [a, moved])!;
  assert.notEqual(again, first);
  assert.ok(again.strokes[0][again.strokes[0].length - 1].x > 290);
});

/* ── drawing ──────────────────────────────────────────────────────────── */

test('with no hops the path is exactly the one the renderer always drew', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 180, y: 80 },
  ];
  assert.equal(hoppedPath(pts, [], 8), polylineToRoundedPath(pts));
  assert.equal(hoppedPath(pts, [], 0), 'M 0 0 L 100 0 L 100 80 L 180 80');
});

/** The top of the one semicircle in `d`, worked out from the arc command:
 *  sweep-flag 1 turns clockwise on screen (y down), so its apex sits on the
 *  counter-clockwise normal of the chord; sweep 0 on the other side. */
function apex(d: string): XY {
  const m = /L (\S+) (\S+) A (\S+) \S+ 0 0 ([01]) (\S+) (\S+)/.exec(d)!;
  const [ax, ay, r, sweep, bx, by] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  const dx = (bx - ax) / (2 * r);
  const dy = (by - ay) / (2 * r);
  const n = sweep === 1 ? { x: dy, y: -dx } : { x: -dy, y: dx };
  return { x: (ax + bx) / 2 + n.x * r, y: (ay + by) / 2 + n.y * r };
}

test('a hop is a true semicircle from where it leaves the line to where it lands', () => {
  const d = hoppedPath([{ x: 0, y: 0 }, { x: 200, y: 0 }], [{ start: 96, end: 104 }], 0);
  assert.equal(d, 'M 0 0 L 96 0 A 4 4 0 0 1 104 0 L 200 0');
});

test('a hop bulges up over a horizontal line whichever way it runs', () => {
  const hop = [{ start: 96, end: 104 }];
  for (const pts of [
    [{ x: 0, y: 50 }, { x: 200, y: 50 }],
    [{ x: 200, y: 50 }, { x: 0, y: 50 }],
  ]) {
    assert.deepEqual(apex(hoppedPath(pts, hop, 0)), { x: 100, y: 46 });
  }
});

test('a hop bulges left over a vertical line whichever way it runs', () => {
  const hop = [{ start: 96, end: 104 }];
  for (const pts of [
    [{ x: 50, y: 0 }, { x: 50, y: 200 }],
    [{ x: 50, y: 200 }, { x: 50, y: 0 }],
  ]) {
    assert.deepEqual(apex(hoppedPath(pts, hop, 0)), { x: 46, y: 100 });
  }
});

test('unchanged hops keep their identity across passes', () => {
  const first = computeLineJumps([vertical('v'), horizontal('h', { hop: true })]);
  const again = reuseUnchangedHops(
    first,
    computeLineJumps([vertical('v'), horizontal('h', { hop: true })]),
  );
  assert.equal(again.get('h'), first.get('h'));
  const moved = reuseUnchangedHops(
    first,
    computeLineJumps([vertical('v', 120), horizontal('h', { hop: true })]),
  );
  assert.notEqual(moved.get('h'), first.get('h'));
});

/* ── store ────────────────────────────────────────────────────────────── */

const st = () => useEditor.getState();

test('turning .hop on with several connectors selected sets every one', () => {
  st().loadDiagram(
    {
      version: '1.0',
      meta: {},
      shapes: [],
      connectors: [
        conn({ id: 'c1', from: { x: 0, y: 100 }, to: { x: 200, y: 100 } }),
        conn({ id: 'c2', from: { x: 100, y: 0 }, to: { x: 100, y: 200 } }),
      ],
      annotations: [],
    },
    null,
  );
  st().setSelected(['c1', 'c2']);
  st().updateSelection({ hop: true });
  assert.deepEqual(
    st().diagram.connectors.map((c) => c.hop),
    [true, true],
  );
  // …and the line drawn next inherits it.
  assert.equal(st().lastConnectorStyle.hop, true);

  st().updateSelection({ hop: undefined });
  assert.deepEqual(
    st().diagram.connectors.map((c) => c.hop),
    [undefined, undefined],
  );
  assert.equal(st().lastConnectorStyle.hop, undefined);
});

test('.hop set on one connector is remembered for the next', () => {
  st().setSelected('c2');
  st().updateSelection({ hop: true });
  assert.equal(st().diagram.connectors.find((c) => c.id === 'c2')!.hop, true);
  assert.equal(st().lastConnectorStyle.hop, true);
});

test('a mixed selection sets connector-only settings on the connectors, not the shapes', () => {
  st().loadDiagram(
    {
      version: '1.0',
      meta: {},
      shapes: [
        { id: 'r1', kind: 'rect', x: 0, y: 0, w: 50, h: 50, layer: 'blueprint' },
        // Saved by an older build with a stray connector field: kept as-is.
        { id: 'r2', kind: 'rect', x: 80, y: 0, w: 50, h: 50, layer: 'blueprint', hop: true } as never,
      ],
      connectors: [conn({ id: 'c1', from: { x: 0, y: 100 }, to: { x: 200, y: 100 } })],
      annotations: [],
    },
    null,
  );
  // Connector first, so the connector inspector is the one showing.
  st().setSelected(['c1', 'r1', 'r2']);
  st().updateSelection({ hop: true, animated: true, stroke: '#ff0000' });

  const c1 = st().diagram.connectors[0];
  assert.equal(c1.hop, true);
  assert.equal(c1.animated, true);
  const [r1, r2] = st().diagram.shapes as unknown as Record<string, unknown>[];
  assert.equal('hop' in r1, false);
  assert.equal('animated' in r1, false);
  // Shared styles still paint the lot.
  assert.equal(r1.stroke, '#ff0000');
  // Nothing already saved on a shape is stripped.
  assert.equal(r2.hop, true);

  st().updateSelection({ hop: undefined });
  assert.equal(st().diagram.connectors[0].hop, undefined);
  assert.equal((st().diagram.shapes[1] as unknown as Record<string, unknown>).hop, true);
});
