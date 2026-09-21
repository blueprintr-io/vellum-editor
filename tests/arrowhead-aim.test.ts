import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catmullRomSegments,
  dedupePoints,
  polylineEndDirection,
  sampleCurvedPolyline,
} from '../src/editor/canvas/routing';

type XY = { x: number; y: number };

const deg = (v: XY) => (Math.atan2(v.y, v.x) * 180) / Math.PI;

/** Angle between two directions, in degrees, ignoring sign. */
function apart(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/* ── dedupePoints ─────────────────────────────────────────────────────── */

test('a bend dropped on an endpoint is dropped from the route', () => {
  const pts = dedupePoints([
    { x: 0, y: 0 },
    { x: 100, y: 50 },
    { x: 100, y: 50 },
  ]);
  assert.deepEqual(pts, [
    { x: 0, y: 0 },
    { x: 100, y: 50 },
  ]);
});

test('dedupePoints keeps two vertices even when every point coincides', () => {
  const pts = dedupePoints([
    { x: 7, y: 7 },
    { x: 7, y: 7 },
  ]);
  assert.equal(pts.length, 2);
});

test('dedupePoints leaves a route with no duplicates alone', () => {
  const input = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  assert.deepEqual(dedupePoints(input), input);
});

/* ── catmullRomSegments ───────────────────────────────────────────────── */

test('terminal spline handles match the scale of interior ones', () => {
  // Evenly spaced points along a line: every handle should come out the same
  // length. Doubling the endpoints (the old form) halved the outer two,
  // which is what put a curvature spike on the endpoints.
  const segs = catmullRomSegments([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 300, y: 0 },
  ]);
  const lengths = segs.flatMap((s) => [
    Math.hypot(s.c1.x - s.from.x, s.c1.y - s.from.y),
    Math.hypot(s.to.x - s.c2.x, s.to.y - s.c2.y),
  ]);
  for (const len of lengths) assert.ok(Math.abs(len - lengths[0]) < 1e-9);
});

test('reflected endpoints keep the terminal tangent DIRECTION', () => {
  // The fix lengthens the outer handles; it must not re-aim them, or every
  // existing curved connector would visibly swing at its ends.
  const pts = [
    { x: 0, y: 0 },
    { x: 120, y: 60 },
    { x: 200, y: 0 },
  ];
  const segs = catmullRomSegments(pts);
  const last = segs[segs.length - 1];
  const tangent = { x: last.to.x - last.c2.x, y: last.to.y - last.c2.y };
  const chord = { x: pts[2].x - pts[1].x, y: pts[2].y - pts[1].y };
  assert.ok(apart(deg(tangent), deg(chord)) < 1e-9);
});

test('the spline passes through every waypoint', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 50, y: 90 },
    { x: 160, y: 20 },
    { x: 240, y: 110 },
  ];
  const segs = catmullRomSegments(pts);
  assert.equal(segs.length, pts.length - 1);
  segs.forEach((s, i) => {
    assert.deepEqual(s.from, pts[i]);
    assert.deepEqual(s.to, pts[i + 1]);
  });
});

/* ── polylineEndDirection ─────────────────────────────────────────────── */

const straight = [
  { x: 0, y: 0 },
  { x: 300, y: 0 },
];

test('a straight line aims the same however far back you measure', () => {
  for (const span of [1, 20, 500]) {
    assert.equal(deg(polylineEndDirection(straight, 'end', span)!), 0);
  }
});

test('the start of a line faces back out of it, like auto-start-reverse', () => {
  assert.equal(Math.abs(deg(polylineEndDirection(straight, 'start', 20)!)), 180);
});

test("an elbow's short final leg keeps its own direction", () => {
  // 60px of horizontal run after a corner, measured with a marker that
  // reaches 200px back. Averaging across the corner would aim the arrowhead
  // diagonally into the shape it is supposed to meet square-on.
  const elbow = [
    { x: 0, y: 0 },
    { x: 0, y: 400 },
    { x: 60, y: 400 },
  ];
  assert.equal(deg(polylineEndDirection(elbow, 'end', 200)!), 0);
});

test('a degenerate final segment does not decide the aim', () => {
  const withStub = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 100, y: 100 },
  ];
  assert.equal(deg(polylineEndDirection(withStub, 'end', 30)!), 45);
});

test('a polyline with no extent has no direction', () => {
  assert.equal(polylineEndDirection([{ x: 5, y: 5 }], 'end', 10), null);
  assert.equal(
    polylineEndDirection([{ x: 5, y: 5 }, { x: 5, y: 5 }], 'end', 10),
    null,
  );
});

test('the aim is read at `span`, not at whatever vertex is nearest', () => {
  // Two samplings of the same corner. A vertex-granular walk would answer
  // differently for each; landing exactly on the span cannot.
  const coarse = [
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
  ];
  const fine = [
    { x: 0, y: 100 },
    { x: 25, y: 100 },
    { x: 50, y: 100 },
    { x: 75, y: 100 },
    { x: 100, y: 100 },
    { x: 130, y: 100 },
    { x: 200, y: 100 },
  ];
  assert.equal(
    deg(polylineEndDirection(coarse, 'end', 120)!),
    deg(polylineEndDirection(fine, 'end', 120)!),
  );
});

/* ── the two together: what the user sees ─────────────────────────────── */

test('a big arrowhead on a curling line aims at the stroke, not past it', () => {
  // A bent connector that turns hard as it reaches its endpoint - the shape
  // that used to render a crumpled head with one barb lying along the line.
  const poly = sampleCurvedPolyline(
    330,
    660,
    250,
    230,
    null,
    null,
    [
      { x: 600, y: 420 },
      { x: 640, y: 250 },
      { x: 470, y: 190 },
      { x: 300, y: 265 },
    ],
  );
  const span = 56; // strokeWidth 8 × the arrow's default size factor
  const aim = deg(polylineEndDirection(poly, 'end', span)!);

  // Everywhere along the span the head covers, the stroke must sit inside
  // the chevron's cone (half-angle atan(0.5) = 26.6°) with room to spare.
  // Allow enough clearance: at ~5° the barb and the line merge into one
  // blob, which is the crumple. Doubled endpoints aimed by SVG's endpoint
  // tangent peaked at 21.7° off - ~5° of clearance. Reflected endpoints
  // aimed across the span peak at 11.8°, so 15° is a budget this geometry
  // passes comfortably and the old rendering could not meet.
  const tip = poly[poly.length - 1];
  for (const back of [span * 0.25, span * 0.5, span * 0.75, span]) {
    const at = pointAtDistanceFromEnd(poly, back);
    const toTip = deg({ x: tip.x - at.x, y: tip.y - at.y });
    assert.ok(
      apart(aim, toTip) < 15,
      `stroke ${back}px back sits ${apart(aim, toTip).toFixed(1)}° off the aim`,
    );
  }
});

/** Walk `dist` back along `pts` from its last vertex. */
function pointAtDistanceFromEnd(pts: XY[], dist: number): XY {
  let walked = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (walked + len >= dist) {
      const t = (dist - walked) / len;
      return {
        x: pts[i].x + (pts[i - 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i - 1].y - pts[i].y) * t,
      };
    }
    walked += len;
  }
  return pts[0];
}
