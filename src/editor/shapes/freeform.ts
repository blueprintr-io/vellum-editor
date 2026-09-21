import type { Shape } from '@/store/types';

type Point = { x: number; y: number };

/** Collapse near-collinear samples without rounding the user's corners. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]);
  const spans: [number, number][] = [[0, points.length - 1]];
  while (spans.length) {
    const [first, last] = spans.pop()!;
    const a = points[first],
      b = points[last],
      dx = b.x - a.x,
      dy = b.y - a.y;
    let farthest = -1,
      distance = tolerance * tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
        ),
      );
      const d = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
      if (d > distance) {
        distance = d;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep.add(farthest);
      spans.push([first, farthest], [farthest, last]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}

/** Closure is implicit in this model and explicit in its SVG path (Z).
 * Normalized vertices preserve geometry when any resize operation changes
 * the bounding box. Tiny clicks/lines are discarded without a history entry.
 */
export function closedFreeformGeometry(
  input: Point[],
  zoom = 1,
): Pick<Shape, 'x' | 'y' | 'w' | 'h' | 'polygonVertices'> | null {
  const finite = input.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const points = simplify(finite, 0.65 / zoom);
  if (points.length < 3 || points.length > 8192) return null;
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  const w = Math.max(...points.map((p) => p.x)) - x,
    h = Math.max(...points.map((p) => p.y)) - y;
  const a = points[0];
  let area = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const b = points[i],
      c = points[i + 1];
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  if (w * zoom < 3 || h * zoom < 3 || area * zoom * zoom < 9) return null;
  return {
    x,
    y,
    w,
    h,
    polygonVertices: points.map((p) => ({
      x: (p.x - x) / w,
      y: (p.y - y) / h,
    })),
  };
}
