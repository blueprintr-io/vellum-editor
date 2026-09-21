/** Segment editing is separate from the legacy waypoint router. Stored
 * corners describe the user's route; only the terminal legs follow shapes.
 * Unedited documents keep their original waypoint interpretation. */
import { DEFAULT_JETTY, routeOrthogonal, type ElbowEndpoint, type Point } from './elbow';

const EPS = 0.01;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;
const horizontal = (a: Point, b: Point) => same(a.y, b.y);

/** Drop duplicate/collinear corners, including bends folded back onto a
 * neighbouring segment. A stack handles several disappearing bends at once. */
export function simplifyOrthogonal(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    if (out.length && same(out.at(-1)!.x, point.x) && same(out.at(-1)!.y, point.y)) continue;
    while (out.length > 1) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if (!((same(a.x, b.x) && same(b.x, point.x)) ||
        (same(a.y, b.y) && same(b.y, point.y)))) break;
      out.pop();
    }
    if (!out.length || !same(out.at(-1)!.x, point.x) || !same(out.at(-1)!.y, point.y)) {
      out.push({ ...point });
    }
  }
  return out;
}

/** Move the grabbed segment perpendicular to itself, from the pointer-down
 * snapshot. Endpoints stay attached; end segments gain short connecting legs.
 * Alignment snaps remove bends, and never depend on the number of mouse events. */
export function moveOrthogonalSegment(
  points: readonly Point[],
  index: number,
  delta: Point,
  snapTolerance = 0,
): Point[] {
  if (index < 0 || index >= points.length - 1) return points.map(p => ({ ...p }));
  const a = points[index];
  const b = points[index + 1];
  const h = horizontal(a, b);
  const axis = h ? 'y' : 'x';
  let position = a[axis] + delta[axis];
  // Snap to neighbouring parallel rails, including the original position.
  const rails = [a[axis], points[index - 1]?.[axis], points[index + 2]?.[axis]];
  let distance = snapTolerance;
  for (const rail of rails) {
    if (rail !== undefined && Math.abs(position - rail) <= distance) {
      distance = Math.abs(position - rail);
      position = rail;
    }
  }
  if (same(position, a[axis])) return points.map(p => ({ ...p }));
  const out = points.map(p => ({ ...p }));
  const shiftedA = { ...a, [axis]: position };
  const shiftedB = { ...b, [axis]: position };
  const along = h ? 'x' : 'y';
  const length = Math.abs(b[along] - a[along]);
  const stub = Math.min(DEFAULT_JETTY, length / 3);
  const sign = Math.sign(b[along] - a[along]);
  const replacement: Point[] = [];
  if (index === 0) {
    const lead = { ...a, [along]: a[along] + sign * stub };
    replacement.push({ ...a }, lead, { ...lead, [axis]: position });
  } else replacement.push(shiftedA);
  if (index === points.length - 2) {
    const lead = { ...b, [along]: b[along] - sign * stub };
    replacement.push({ ...lead, [axis]: position }, lead, { ...b });
  } else replacement.push(shiftedB);
  out.splice(index, 2, ...replacement);
  return simplifyOrthogonal(out);
}

/** Connect a moved/rebound endpoint to a retained rail. Usually this is a
 * single leg. When the rail is behind the shape, use the shape-aware router
 * for that terminal section instead of reversing through the shape. */
function terminalLeg(endpoint: ElbowEndpoint, corner: Point, next: Point): Point[] {
  const incomingH = !horizontal(corner, next);
  const p = endpoint.point;
  const d = endpoint.dir;
  const exitH = d ? d === 'left' || d === 'right' : incomingH;
  if (incomingH === exitH) {
    if (incomingH) corner.y = p.y;
    else corner.x = p.x;
    // A shape can move over a retained corner. Slide that corner along its
    // rail to the outside of the shape before asking the router to join it;
    // routing to a point inside the shape has no valid solution.
    const r = endpoint.rect;
    if (r && corner.x > r.x - EPS && corner.x < r.x + r.w + EPS &&
      corner.y > r.y - EPS && corner.y < r.y + r.h + EPS) {
      if (incomingH) corner.y = next.y >= p.y ? r.y + r.h + DEFAULT_JETTY : r.y - DEFAULT_JETTY;
      else corner.x = next.x >= p.x ? r.x + r.w + DEFAULT_JETTY : r.x - DEFAULT_JETTY;
    }
    const travel = incomingH ? corner.x - p.x : corner.y - p.y;
    const sign = d === 'left' || d === 'top' ? -1 : 1;
    const aligned = incomingH ? same(corner.y, p.y) : same(corner.x, p.x);
    // Marker setback shortens the painted stub by a few pixels. It must not
    // cause a different route from the handle/hit-test geometry.
    if (aligned && (!d || travel * sign > EPS)) return [{ ...p }, { ...corner }];
  }
  const targetDir = incomingH
    ? (p.x <= corner.x ? 'left' : 'right')
    : (p.y <= corner.y ? 'top' : 'bottom');
  return routeOrthogonal(endpoint, { point: corner, rect: null, dir: targetDir });
}

export function routeOrthogonalSegments(
  from: ElbowEndpoint,
  to: ElbowEndpoint,
  waypoints: readonly Point[],
): Point[] {
  // A connector can be changed to curved, edited, then changed back to
  // elbow. Its stored corners may no longer share axes. Insert joins here
  // without rewriting the saved data or ever painting a diagonal.
  const expanded: Point[] = [];
  for (const point of waypoints) {
    const previous = expanded.at(-1);
    if (previous && !same(previous.x, point.x) && !same(previous.y, point.y)) {
      const nextH = expanded.length > 1
        ? !horizontal(expanded[expanded.length - 2], previous)
        : from.dir === 'top' || from.dir === 'bottom';
      expanded.push(nextH ? { x: point.x, y: previous.y } : { x: previous.x, y: point.y });
    }
    expanded.push({ ...point });
  }
  const corners = simplifyOrthogonal(expanded);
  if (corners.length < 2) {
    // A single L-corner still conveys intent. Give each end its existing
    // axis; terminalLeg also covers rebinding it onto a different side.
    if (corners.length === 1) {
      const corner = corners[0];
      const lead = terminalLeg(from, corner, to.point);
      const tail = terminalLeg(to, { ...corner }, lead.at(-2) ?? from.point);
      const reversed = tail.reverse();
      const a = lead.at(-1)!;
      const b = reversed[0];
      const bridge = same(a.x, b.x) || same(a.y, b.y) ? [] : [{ x: a.x, y: b.y }];
      return simplifyOrthogonal([...lead, ...bridge, ...reversed]);
    }
    return routeOrthogonal(from, to);
  }
  const lead = terminalLeg(from, corners[0], corners[1]);
  const tail = terminalLeg(to, corners[corners.length - 1], corners[corners.length - 2]);
  return simplifyOrthogonal([...lead, ...corners.slice(1, -1), ...tail.reverse()]);
}
