import type { Callout } from '@/editor/notation/catalog';
import { calloutGeometry } from '@/editor/notation/geometry';
// Path-based "basic shape" presets that ride the `kind: 'polygon'` shape
// (and its already-wired render / inspector / hit-test / connector gates)
// instead of each needing its own ShapeKind. They are NOT regular n-gons -
// cloud/callout have curves, semicircle is a half-ellipse - so they can't
// go through the plain n-gon vertex list. Each generator emits an SVG path
// `d` in ABSOLUTE world coords (not a unit path + scale transform): a scale
// transform would distort `strokeWidth` non-uniformly and break the
// world-unit stroke convention every other shape uses. Everything fills
// the bbox exactly, so an edge drag just restretches it - same contract as
// the diamond and the n-gon polygon.
//
// `polygonShapeOutline` exposes the SAME geometry as a point loop so
// connector anchoring / smart-anchor dots project onto the visible edge
// (routing.ts) instead of the bbox - render and anchor read one source.

import type { ShapePreset } from '@/editor/shapes/catalog';
export type { ShapePreset } from '@/editor/shapes/catalog';

export type Pt = [number, number];

/** Regular n-gon / star vertices, generated on a unit circle (first vertex
 *  at top) then mapped so the tight bbox FILLS [x..x+w]×[y..y+h] - a
 *  triangle reads apex-top / base-full-width like the diamond. Shared by
 *  the renderer (Shape.tsx) and the anchor projector so the dot lands
 *  exactly on the drawn edge. `sides` clamped to >= 3. */
export function polygonVertices(
  x: number,
  y: number,
  w: number,
  h: number,
  sides: number,
  star: boolean,
): Pt[] {
  const n = Math.max(3, Math.round(sides));
  const count = star ? n * 2 : n;
  const raw: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = star && i % 2 === 1 ? 0.5 : 1;
    raw.push([Math.cos(ang) * r, Math.sin(ang) * r]);
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [px, py] of raw) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const sx = w / (maxX - minX || 1);
  const sy = h / (maxY - minY || 1);
  return raw.map(([px, py]) => [x + (px - minX) * sx, y + (py - minY) * sy]);
}

/** Cloud = the outer hull of a ring of overlapping circles ("puffs"),
 *  authored in a unit box (0..1, y down) and ordered clockwise. Modelling
 *  it as an actual circle-union (rather than hand-placed arcs) is what gives
 *  the clean cartoon look: each puff contributes one convex bump and
 *  adjacent puffs meet at their true circle intersection, so every valley
 *  is a natural rounded notch. `[cx, cy, r]` per puff; the hull is sampled
 *  to a polyline and the bbox map turns the circles into proportional
 *  ellipses so it still fills any aspect ratio. */
const CLOUD_PUFFS: [number, number, number][] = [
  [0.17, 0.52, 0.15], // left
  [0.34, 0.36, 0.2], // top-left
  [0.57, 0.3, 0.25], // top-center - biggest / tallest
  [0.78, 0.4, 0.19], // top-right
  [0.88, 0.58, 0.14], // right
  [0.7, 0.74, 0.19], // bottom-right
  [0.45, 0.8, 0.2], // bottom-center
  [0.24, 0.74, 0.17], // bottom-left
];

/** Sampled cloud-hull points (world coords). One convex arc per puff,
 *  trimmed at the true circle–circle intersection with each neighbour. */
function cloudHull(x: number, y: number, w: number, h: number): Pt[] {
  const n = CLOUD_PUFFS.length;
  const gx = CLOUD_PUFFS.reduce((s, p) => s + p[0], 0) / n;
  const gy = CLOUD_PUFFS.reduce((s, p) => s + p[1], 0) / n;
  // Boundary node shared by puff i and puff i+1: the circle–circle
  // intersection on the side facing away from the cloud centroid.
  const node = (i: number): Pt => {
    const [x1, y1, r1] = CLOUD_PUFFS[i];
    const [x2, y2, r2] = CLOUD_PUFFS[(i + 1) % n];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = Math.hypot(dx, dy);
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const hh = Math.sqrt(Math.max(0, r1 * r1 - a * a));
    const mx = x1 + (a * dx) / d;
    const my = y1 + (a * dy) / d;
    const p1: Pt = [mx - (dy / d) * hh, my + (dx / d) * hh];
    const p2: Pt = [mx + (dy / d) * hh, my - (dx / d) * hh];
    const far = (p: Pt) => (p[0] - gx) ** 2 + (p[1] - gy) ** 2;
    return far(p1) >= far(p2) ? p1 : p2;
  };
  const fx = (u: number) => x + u * w;
  const fy = (v: number) => y + v * h;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const [cx, cy, r] = CLOUD_PUFFS[i];
    const from = node((i - 1 + n) % n);
    const to = node(i);
    const a0 = Math.atan2(from[1] - cy, from[0] - cx);
    const a1 = Math.atan2(to[1] - cy, to[0] - cx);
    // Walk the arc that bulges away from the centroid (through the puff's
    // outward apex). atan2 is y-down, so increasing angle runs clockwise
    // on screen - the same direction as the puff loop.
    let sweep = a1 - a0;
    while (sweep <= 0) sweep += Math.PI * 2;
    const apex = Math.atan2(cy - gy, cx - gx);
    let rel = apex - a0;
    while (rel < 0) rel += Math.PI * 2;
    if (rel > sweep) sweep -= Math.PI * 2;
    const steps = Math.max(
      4,
      Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 56),
    );
    for (let s = 0; s <= steps; s++) {
      const ang = a0 + (sweep * s) / steps;
      out.push([fx(cx + r * Math.cos(ang)), fy(cy + r * Math.sin(ang))]);
    }
  }
  return out;
}

/** Semicircle outline: the dome sampled as a polyline. The closing
 *  segment (last→first) is the flat diameter. */
function semicircleOutline(x: number, y: number, w: number, h: number): Pt[] {
  const cx = x + w / 2;
  const by = y + h;
  const rx = w / 2;
  const out: Pt[] = [];
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI; // 0 → π, left base over the top
    out.push([cx - rx * Math.cos(t), by - h * Math.sin(t)]);
  }
  return out;
}

/** Outlines are authored in a unit box, then mapped to world coordinates. */
function basicOutline(preset: ShapePreset, w: number, h: number): Pt[] {
  const arrow: Pt[] = [
    [0, 0.3],
    [0.6, 0.3],
    [0.6, 0],
    [1, 0.5],
    [0.6, 1],
    [0.6, 0.7],
    [0, 0.7],
  ];
  switch (preset) {
    case 'right-triangle':
      return [
        [0, 0],
        [1, 1],
        [0, 1],
      ];
    case 'parallelogram':
      return [
        [0.22, 0],
        [1, 0],
        [0.78, 1],
        [0, 1],
      ];
    case 'trapezoid':
      return [
        [0.2, 0],
        [0.8, 0],
        [1, 1],
        [0, 1],
      ];
    case 'cross':
      return [
        [0.33, 0],
        [0.67, 0],
        [0.67, 0.33],
        [1, 0.33],
        [1, 0.67],
        [0.67, 0.67],
        [0.67, 1],
        [0.33, 1],
        [0.33, 0.67],
        [0, 0.67],
        [0, 0.33],
        [0.33, 0.33],
      ];
    case 'chevron':
      return [
        [0, 0],
        [0.6, 0],
        [1, 0.5],
        [0.6, 1],
        [0, 1],
        [0.4, 0.5],
      ];
    case 'right-arrow':
      return arrow;
    case 'left-arrow':
      return arrow.map(([u, v]) => [1 - u, v]);
    case 'up-arrow':
      return arrow.map(([u, v]) => [v, 1 - u]);
    case 'down-arrow':
      return arrow.map(([u, v]) => [v, u]);
    case 'double-arrow':
      return [
        [0, 0.5],
        [0.28, 0],
        [0.28, 0.3],
        [0.72, 0.3],
        [0.72, 0],
        [1, 0.5],
        [0.72, 1],
        [0.72, 0.7],
        [0.28, 0.7],
        [0.28, 1],
      ];
    case 'quarter-circle':
      return [
        [0, 1],
        ...Array.from({ length: 33 }, (_, i): Pt => {
          const a = ((i / 32) * Math.PI) / 2;
          return [Math.sin(a), 1 - Math.cos(a)];
        }),
      ];
    case 'heart': {
      const points = Array.from({ length: 97 }, (_, i): Pt => {
        const a = (i / 96) * 2 * Math.PI;
        return [
          16 * Math.sin(a) ** 3,
          -(
            13 * Math.cos(a) -
            5 * Math.cos(2 * a) -
            2 * Math.cos(3 * a) -
            Math.cos(4 * a)
          ),
        ];
      });
      const minY = Math.min(...points.map((p) => p[1]));
      const maxY = Math.max(...points.map((p) => p[1]));
      return points.map(([u, v]) => [
        (u + 16) / 32,
        (v - minY) / (maxY - minY),
      ]);
    }
    case 'teardrop': {
      const points: Pt[] = [[0, 0]];
      // Rounded lower-right body meets a pointed upper-left corner.
      for (let i = 0; i <= 48; i++) {
        const a = -Math.PI / 2 + (i / 48) * Math.PI * 1.5;
        points.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]);
      }
      return points;
    }
    case 'capsule': {
      const rx = Math.min(w, h) / 2 / Math.max(w, 1),
        ry = Math.min(w, h) / 2 / Math.max(h, 1);
      const out: Pt[] = [];
      for (const [cx, cy, a] of [
        [1 - rx, ry, -Math.PI / 2],
        [1 - rx, 1 - ry, 0],
        [rx, 1 - ry, Math.PI / 2],
        [rx, ry, Math.PI],
      ]) {
        for (let i = 0; i <= 16; i++)
          out.push([
            cx + rx * Math.cos(a + ((i / 16) * Math.PI) / 2),
            cy + ry * Math.sin(a + ((i / 16) * Math.PI) / 2),
          ]);
      }
      return out;
    }
    default:
      return [];
  }
}

/** Shared closed outline for rendering and connector attachment. */
export function polygonShapeOutline(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: {
    preset?: ShapePreset;
    sides?: number;
    star?: boolean;
    callout?: Callout;
    vertices?: { x: number; y: number }[];
  },
): Pt[] {
  if (opts.vertices && opts.vertices.length >= 3)
    return opts.vertices.map((p) => [x + p.x * w, y + p.y * h]);
  if (opts.preset === 'cloud') return cloudHull(x, y, w, h);
  if (opts.preset === 'callout')
    return calloutGeometry({ x, y, w, h }, opts.callout).outline;
  if (opts.preset === 'semicircle') return semicircleOutline(x, y, w, h);
  if (opts.preset)
    return basicOutline(opts.preset, w, h).map(([u, v]) => [
      x + u * w,
      y + v * h,
    ]);
  return polygonVertices(x, y, w, h, opts.sides ?? 3, opts.star === true);
}

export function closedOutlinePath(outline: Pt[]): string {
  return outline.length >= 3
    ? `M ${outline.map((p) => p.join(' ')).join(' L ')} Z`
    : '';
}

export function presetPath(
  preset: ShapePreset,
  x: number,
  y: number,
  w: number,
  h: number,
  callout?: Callout,
): string {
  if (preset === 'semicircle')
    return `M ${x} ${y + h} A ${w / 2} ${h} 0 0 1 ${x + w} ${y + h} Z`;
  if (preset === 'callout')
    return calloutGeometry({ x, y, w, h }, callout).path;
  return closedOutlinePath(polygonShapeOutline(x, y, w, h, { preset }));
}
