/* Orthogonal ("elbow") connector routing.
 *
 * Routes axis-aligned paths using conditional geometry cases.
 *
 * BEHAVIOURAL CONTRACT.
 *
 *   1. Endpoints. Each end has:
 *      - a perimeter point P where the line attaches
 *      - an outward cardinal direction D ∈ {W, N, E, S} (the shape side
 *        the line exits/enters; null = "auto" = pick from geometry)
 *      - optionally a shape rectangle R (for routing around)
 *
 *   2. Jetty. The line travels J pixels perpendicular to the shape edge
 *      before any bend is allowed (J = 20 by default - large enough to
 *      clear typical arrowheads + give a readable "exits this side" cue).
 *      We don't bend within J of either endpoint.
 *
 *   3. Routing rules, by exit-direction pair.
 *
 *      a) Perpendicular (one H, one V): single L-bend at the corner of
 *         (source-jetty point's H-axis, target-jetty point's V-axis) or
 *         vice versa. Two segments.
 *
 *      b) Same axis, anti-parallel, target ahead in source's exit
 *         direction: Z-bend with a midline halfway between the two jetty
 *         points along the shared axis. Three segments. ("Source exits
 *         east, target accepts on west, target is east of source" - the
 *         common left-to-right flow.)
 *
 *      c) Same axis, anti-parallel, target behind in source's exit
 *         direction: U-detour around the perpendicular axis. The detour
 *         rail clears BOTH shapes in the perpendicular axis (using the
 *         shape rectangles to know how tall/wide they are - without
 *         rect info, falls back to a fixed offset). Four segments.
 *
 *      d) Same axis, same direction, target ahead: staple. Run past the
 *         farther shape edge in the exit direction, bend perpendicular
 *         to target's level, bend back inward to enter. Three segments.
 *
 *      e) Same axis, same direction, target behind: counter-staple. Out
 *         from source on the exit direction, perpendicular detour past
 *         BOTH shapes, then in toward target. Four segments. (Rare -
 * comes up when both endpoints face the same way but the target
 *         is "behind" the source's exit, e.g. both face east but target
 *         is to the west.)
 *
 *   4. Collapse. After building the over-specified polyline, drop
 *      zero-length segments and points that are collinear with their
 *      neighbours. The renderer / hit-tester sees only meaningful
 *      bends, never duplicate or in-line waypoints.
 *
 *   5. Waypoint mode. When the user has manually bent the line by
 *      dragging waypoints, we DON'T use the auto-router above. Instead
 *      each waypoint is treated as a "hint" - a single coordinate
 *      driving one bend. Consecutive segments alternate orientation
 *      (H, V, H, V, …). The first segment's orientation is determined
 *      by where the first hint sits relative to the source endpoint:
 *      - If the hint's x equals the source point's x → vertical first.
 *      - If the hint's y equals the source point's y → horizontal first.
 *      - Else: pick whichever axis the hint lies "off" the source's
 *        perpendicular channel (target lies inside source's y-range →
 *        approach must be horizontal; etc.). This is the heuristic
 *        users expect when dragging waypoints.
 *
 *      User waypoints that sit OFF an axis (both dx and dy nonzero from
 *      the previous point) get an automatic axis-aligned bend inserted
 *      so the rendered line stays orthogonal.
 *
 * NOT YET MODELLED. Port constraints (per-side blocked exits), self-loops,
 * the "three or more shape" routing search. These are open work; the
 * router degrades gracefully on each (no constraint = all sides allowed,
 * self-loop = degenerate single point, etc.). */

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; w: number; h: number };

export type CardinalDir = 'left' | 'top' | 'right' | 'bottom';

export type ElbowEndpoint = {
  /** Where the line attaches (perimeter point, world coords). */
  point: Point;
  /** Shape bounds, or null for a floating endpoint. */
  rect: Rect | null;
  /** Side of the shape the line exits/enters. Null = "auto", inferred
   *  from rectangle geometry against the other endpoint. */
  dir: CardinalDir | null;
};

/** Default jetty distance - the perpendicular stub length each end runs
 *  before any bend is allowed. 20 units clears typical arrowhead glyphs and gives a
 *  readable "this came out of that side" cue. */
export const DEFAULT_JETTY = 20;

/** Build an orthogonal polyline from `from` to `to`. Returns the points
 *  of an axis-aligned multi-segment line. Always at least 2 points (the
 *  endpoints); typically 3–6 with bends.
 *
 *  See the module-level "BEHAVIOURAL CONTRACT" doc for routing rules. */
export function routeOrthogonal(
  from: ElbowEndpoint,
  to: ElbowEndpoint,
  jetty: number = DEFAULT_JETTY,
): Point[] {
  const Ds = resolveDir(from, to);
  const Dt = resolveDir(to, from);

  // Jetty-stub points: where the path is allowed to first bend.
  const P0 = from.point;
  const Pe = to.point;
  const P1 = stepInDir(P0, Ds, jetty);
  const PeIn = stepInDir(Pe, Dt, jetty);

  // Evaluate L, Z, staple and detour candidates. A fixed corner can force
  // a path backwards through a shape when the target is behind the exit.
  // scoreRoute checks both jetty directions, shape crossings and folds.
  // Stable ordering breaks ties without changing existing valid routes.
  const candidates = candidateMidRoutes(
    P1,
    PeIn,
    Ds,
    Dt,
    from.rect,
    to.rect,
    jetty,
  );

  let best: Point[] | null = null;
  let bestCost = Infinity;
  for (const mid of candidates) {
    // Assemble: source perimeter -> source jetty stub -> mid bends ->
    // target jetty stub -> target perimeter. Collapse drops duplicate or
    // collinear points so the caller sees only actual bends. Defold
    // rewrites any 180-degree vertex into a perpendicular stairstep -
    // guards against the line ever overlapping itself.
    const pts = defold(collapse([P0, P1, ...mid, PeIn, Pe]), jetty);
    const cost = scoreRoute(pts, Ds, Dt, from.rect, to.rect, jetty);
    if (cost < bestCost) {
      bestCost = cost;
      best = pts;
    }
  }

  // `candidateMidRoutes` always yields at least the two L-corners, so
  // `best` is never null in practice; the fallback keeps the signature
  // total rather than leaning on that.
  return best ?? defold(collapse([P0, P1, PeIn, Pe]), jetty);
}

// =====================================================================
// Candidate generation + scoring
// =====================================================================

/** Penalty that dwarfs any geometric cost, so a route that satisfies the
 *  hard rules always beats one that doesn't - while still ranking the
 *  rule-breakers against each other, which is what keeps the router
 *  total for degenerate inputs (overlapping shapes, coincident
 *  endpoints) instead of returning nothing. */
const VIOLATION = 1e6;

/** What one bend is worth in path-length terms. High enough that we
 *  never trade a corner for a few pixels, low enough that a big detour
 *  can't win just by being straighter. */
const BEND_COST = 90;

/** Soft charge for a segment that clears a shape but runs inside its
 *  jetty margin - a detour rail grazing a shape's edge is legal but
 *  reads as a near-miss. Finite on purpose: when nothing clears, the
 *  grazing route is still the answer. Worth ~1.8 bends, so we will take
 *  a moderately longer way round for actual breathing room but not an
 *  absurd one. */
const CLEARANCE_COST = 160;

/** Interior bend points for every route shape worth considering.
 *  Returned in preference order - earlier entries win ties. */
function candidateMidRoutes(
  P1: Point,
  PeIn: Point,
  Ds: CardinalDir,
  Dt: CardinalDir,
  fromRect: Rect | null,
  toRect: Rect | null,
  jetty: number,
): Point[][] {
  const out: Point[][] = [];
  const sameAxis = axisOf(Ds) === axisOf(Dt);

  // 1. Nothing between the stubs. Only meaningful when the jetty points
  //    already share an axis; collapse turns it into a straight run.
  out.push([]);

  // 2. Mid-rail Z first when both ends exit on the same axis - that is
  //    the classic shape for the common "source exits east,
  //    target accepts on west" flow, and listing it ahead of the
  //    L-corners preserves the symmetric bend users already have.
  if (sameAxis) {
    if (axisOf(Ds) === 'h') {
      const m = midpoint(P1.x, PeIn.x);
      out.push([
        { x: m, y: P1.y },
        { x: m, y: PeIn.y },
      ]);
    } else {
      const m = midpoint(P1.y, PeIn.y);
      out.push([
        { x: P1.x, y: m },
        { x: PeIn.x, y: m },
      ]);
    }
  }

  // 3. The two single-bend L corners.
  out.push([{ x: PeIn.x, y: P1.y }]);
  out.push([{ x: P1.x, y: PeIn.y }]);

  // 4. Z / staple / U detours along every rail worth trying: the two
  //    jetty coordinates, their midpoint, each shape's cleared edges,
  //    and the union rails that clear BOTH shapes. This is the superset
  //    of the rails the old case table computed in `perpendicularRail`
  //    plus the "extend past the far shape" staple coordinate.
  for (const y of railValues(
    [P1.y, PeIn.y, midpoint(P1.y, PeIn.y)],
    [computeTopClear(fromRect, toRect, jetty), computeBottomClear(fromRect, toRect, jetty)],
    fromRect ? [fromRect.y - jetty, fromRect.y + fromRect.h + jetty] : [],
    toRect ? [toRect.y - jetty, toRect.y + toRect.h + jetty] : [],
  )) {
    out.push([
      { x: P1.x, y },
      { x: PeIn.x, y },
    ]);
  }
  for (const x of railValues(
    [P1.x, PeIn.x, midpoint(P1.x, PeIn.x)],
    [computeLeftClear(fromRect, toRect, jetty), computeRightClear(fromRect, toRect, jetty)],
    fromRect ? [fromRect.x - jetty, fromRect.x + fromRect.w + jetty] : [],
    toRect ? [toRect.x - jetty, toRect.x + toRect.w + jetty] : [],
  )) {
    out.push([
      { x, y: P1.y },
      { x, y: PeIn.y },
    ]);
  }

  return out;
}

/** Flatten + dedupe rail coordinates, dropping nulls. Order is
 *  preference order: the cheap "line up with an endpoint" rails first,
 *  then the union clearances, then per-shape clearances. */
function railValues(...groups: (number | null)[][]): number[] {
  const seen: number[] = [];
  for (const group of groups) {
    for (const v of group) {
      if (v === null || !isFinite(v)) continue;
      if (seen.some((s) => Math.abs(s - v) < 0.5)) continue;
      seen.push(v);
    }
  }
  return seen;
}

/** Lower is better. Hard-rule breaches are charged `VIOLATION` each so
 *  they can never be traded against length; the remainder is bend count
 *  plus Manhattan length. */
function scoreRoute(
  pts: Point[],
  Ds: CardinalDir,
  Dt: CardinalDir,
  fromRect: Rect | null,
  toRect: Rect | null,
  jetty: number,
): number {
  if (pts.length < 2) return VIOLATION * 10;
  let cost = 0;

  // Rule 2 in the contract: strictly axis-aligned.
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = Math.abs(pts[i + 1].x - pts[i].x);
    const dy = Math.abs(pts[i + 1].y - pts[i].y);
    if (dx > 0.5 && dy > 0.5) cost += VIOLATION;
    cost += dx + dy;
  }

  // Rule 1 (the jetty) at both ends: the line must actually leave the
  // source along its exit normal, and arrive at the target along the
  // inward normal of the side it is entering, before anything bends.
  const outVec = dirVector(Ds);
  const first = { a: pts[0], b: pts[1] };
  const outProj =
    (first.b.x - first.a.x) * outVec.x + (first.b.y - first.a.y) * outVec.y;
  if (outProj < jetty - 0.5) cost += VIOLATION;

  const inVec = dirVector(Dt);
  const last = { a: pts[pts.length - 2], b: pts[pts.length - 1] };
  const inProj =
    (last.a.x - last.b.x) * inVec.x + (last.a.y - last.b.y) * inVec.y;
  if (inProj < jetty - 0.5) cost += VIOLATION;

  // Rule 3: never re-enter either shape. Softly discourage skimming one
  // too: same test against the shape inflated by (just under) a jetty.
  // The first and last segments ARE the jetty stubs, so they sit inside
  // their own shape's margin by construction and are exempt from the
  // soft test for that shape.
  const margin = jetty * 0.9;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (segmentEntersRect(a, b, fromRect)) cost += VIOLATION;
    if (segmentEntersRect(a, b, toRect)) cost += VIOLATION;
    if (i !== 0 && segmentEntersRect(a, b, inflate(fromRect, margin))) {
      cost += CLEARANCE_COST;
    }
    if (
      i !== pts.length - 2 &&
      segmentEntersRect(a, b, inflate(toRect, margin))
    ) {
      cost += CLEARANCE_COST;
    }
  }

  // A fold means the line retraces itself. `defold` normally removes
  // these; charging for any survivor keeps them from winning.
  for (let i = 1; i < pts.length - 1; i++) {
    const inDx = Math.sign(pts[i].x - pts[i - 1].x);
    const inDy = Math.sign(pts[i].y - pts[i - 1].y);
    const outDx = Math.sign(pts[i + 1].x - pts[i].x);
    const outDy = Math.sign(pts[i + 1].y - pts[i].y);
    if ((inDx !== 0 && inDx === -outDx) || (inDy !== 0 && inDy === -outDy)) {
      cost += VIOLATION;
    }
  }

  cost += (pts.length - 2) * BEND_COST;
  return cost;
}

/** Unit vector pointing out of the shape along `d`. */
function dirVector(d: CardinalDir): Point {
  switch (d) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    case 'bottom':
      return { x: 0, y: 1 };
  }
}

/** Grow a rect by `by` on all sides. Null in, null out. */
function inflate(rect: Rect | null, by: number): Rect | null {
  if (!rect) return null;
  return {
    x: rect.x - by,
    y: rect.y - by,
    w: rect.w + by * 2,
    h: rect.h + by * 2,
  };
}

/** Does an axis-aligned segment pass through the OPEN interior of
 *  `rect`? Running along the perimeter (which every jetty stub does by
 *  construction) is not a crossing, hence the small inset. */
function segmentEntersRect(a: Point, b: Point, rect: Rect | null): boolean {
  if (!rect) return false;
  const pad = 0.5;
  const x0 = rect.x + pad;
  const x1 = rect.x + rect.w - pad;
  const y0 = rect.y + pad;
  const y1 = rect.y + rect.h - pad;
  if (x1 <= x0 || y1 <= y0) return false;
  if (Math.abs(a.y - b.y) < 0.5) {
    const y = a.y;
    if (y <= y0 || y >= y1) return false;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return hi > x0 && lo < x1;
  }
  const x = a.x;
  if (x <= x0 || x >= x1) return false;
  const lo = Math.min(a.y, b.y);
  const hi = Math.max(a.y, b.y);
  return hi > y0 && lo < y1;
}

/** Build an orthogonal polyline that respects user-placed waypoints. Each
 *  waypoint acts as a "hint" - a single coordinate that constrains one
 *  bend. Segments alternate horizontal / vertical. Off-axis waypoints
 *  get an axis-aligned corner inserted so every segment stays
 *  orthogonal. Trims duplicates. */
export function routeOrthogonalThroughWaypoints(
  from: ElbowEndpoint,
  to: ElbowEndpoint,
  waypoints: Point[],
): Point[] {
  if (waypoints.length === 0) return routeOrthogonal(from, to);

  // Initial orientation for the first segment after the source endpoint.
  // Three signals, in order of preference:
  //   1. The first hint shares the source's x → first segment is V.
  //      (A vertical bend lands exactly at the hint.)
  //   2. The first hint shares the source's y → first segment is H.
  //   3. The source has an exit direction D - use D's axis.
  //   4. Fall back to "longer axis first" relative to the first hint.
  const first = waypoints[0];
  const Ds = resolveDir(from, to);
  let horizontal = pickFirstOrientation(from.point, first, Ds);

  const out: Point[] = [from.point];
  // Track which output indices correspond to USER hints (not synthetic
  // corner bends) so the collapse pass can preserve them. Without this,
  // a hint that lines up collinearly with two synthetic bends would be
  // silently dropped, leaving the rendered line skipping the visible
  // waypoint dot.
  const userIdx = new Set<number>();

  let cursor = { ...from.point };
  for (let i = 0; i < waypoints.length; i++) {
    const hint = waypoints[i];
    // If the hint is already on the current orientation axis, no corner
    // is needed - the line goes directly to the hint and the orientation
    // flips for the next segment.
    if (horizontal && Math.abs(hint.y - cursor.y) < 0.5) {
      cursor = { x: hint.x, y: cursor.y };
      out.push(cursor);
      userIdx.add(out.length - 1);
      horizontal = false;
      continue;
    }
    if (!horizontal && Math.abs(hint.x - cursor.x) < 0.5) {
      cursor = { x: cursor.x, y: hint.y };
      out.push(cursor);
      userIdx.add(out.length - 1);
      horizontal = true;
      continue;
    }
    // Off-axis hint - insert an axis-aligned corner at (cursor's
    // unchanged axis, hint's other axis) so the segment to the hint is
    // orthogonal. Then advance through the hint, and flip orientation.
    if (horizontal) {
      const corner = { x: hint.x, y: cursor.y };
      out.push(corner);
      // Step from corner to the hint (vertical move).
      cursor = { x: hint.x, y: hint.y };
      out.push(cursor);
      userIdx.add(out.length - 1);
      horizontal = false;
    } else {
      const corner = { x: cursor.x, y: hint.y };
      out.push(corner);
      cursor = { x: hint.x, y: hint.y };
      out.push(cursor);
      userIdx.add(out.length - 1);
      horizontal = true;
    }
  }

  // Final segment: from last hint to target endpoint. The target's
  // direction (if known) decides which axis the LAST bend uses - the
  // approach into the target must be perpendicular to the target's edge.
  const Dt = resolveDir(to, from);
  const target = to.point;
  if (Dt) {
    const targetAxis = axisOf(Dt);
    // For a target entered from a horizontal side (left/right), the
    // last segment going INTO the target must be horizontal. So the
    // bend before the target sits at (cursor.x, target.y) when the
    // segment from cursor was vertical, and at (target.x, cursor.y)
    // when it was horizontal.
    if (targetAxis === 'h') {
      // Last incoming segment must be horizontal - y matches target's.
      if (Math.abs(cursor.y - target.y) > 0.5) {
        // Corner at (cursor.x, target.y) so the segment to target is
        // pure horizontal.
        out.push({ x: cursor.x, y: target.y });
      }
    } else {
      // Last incoming segment must be vertical - x matches target's.
      if (Math.abs(cursor.x - target.x) > 0.5) {
        out.push({ x: target.x, y: cursor.y });
      }
    }
  } else {
    // No target direction - insert a corner if the last hint isn't on
    // the same axis as the target along the current orientation.
    if (horizontal && Math.abs(target.y - cursor.y) > 0.5) {
      out.push({ x: target.x, y: cursor.y });
    } else if (!horizontal && Math.abs(target.x - cursor.x) > 0.5) {
      out.push({ x: cursor.x, y: target.y });
    }
  }
  out.push(target);

  return defold(collapse(out, userIdx), DEFAULT_JETTY);
}

// =====================================================================
// Detour-rail clearances
// =====================================================================
//
// Rail coordinates clear one or both endpoint shapes by the jetty margin.
// candidateMidRoutes uses them to build detour candidates, and scoreRoute
// ranks those candidates by endpoint and obstacle constraints.

function computeTopClear(
  a: Rect | null,
  b: Rect | null,
  jetty: number,
): number | null {
  let v: number | null = null;
  if (a) v = a.y - jetty;
  if (b) v = v === null ? b.y - jetty : Math.min(v, b.y - jetty);
  return v;
}
function computeBottomClear(
  a: Rect | null,
  b: Rect | null,
  jetty: number,
): number | null {
  let v: number | null = null;
  if (a) v = a.y + a.h + jetty;
  if (b) v = v === null ? b.y + b.h + jetty : Math.max(v, b.y + b.h + jetty);
  return v;
}
function computeLeftClear(
  a: Rect | null,
  b: Rect | null,
  jetty: number,
): number | null {
  let v: number | null = null;
  if (a) v = a.x - jetty;
  if (b) v = v === null ? b.x - jetty : Math.min(v, b.x - jetty);
  return v;
}
function computeRightClear(
  a: Rect | null,
  b: Rect | null,
  jetty: number,
): number | null {
  let v: number | null = null;
  if (a) v = a.x + a.w + jetty;
  if (b) v = v === null ? b.x + b.w + jetty : Math.max(v, b.x + b.w + jetty);
  return v;
}

// =====================================================================
// Direction inference
// =====================================================================

/** Resolve the cardinal exit direction for `e`. If the endpoint declares
 *  one, use it. Otherwise pick the side of `e.rect` closest to `other`'s
 *  endpoint, as that's the side a user would naturally drag a connector
 *  from when no anchor is locked.
 *
 *  Without rects (free endpoint, no other shape), default to a horizontal
 *  axis pointing toward the other point - keeps the path readable. */
function resolveDir(e: ElbowEndpoint, other: ElbowEndpoint): CardinalDir {
  if (e.dir) return e.dir;
  if (e.rect) {
    // Pick whichever side of the rect the OTHER endpoint sits closest
    // to. "Top" if other is most clearly above; "left" if most clearly
    // left, etc. This ties auto-anchoring to the relative positions
    // when no port is fixed.
    const r = e.rect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = other.point.x - cx;
    const dy = other.point.y - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? 'right' : 'left';
    }
    return dy >= 0 ? 'bottom' : 'top';
  }
  // Free endpoint with no rect - derive from the other point's location.
  const dx = other.point.x - e.point.x;
  const dy = other.point.y - e.point.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

// =====================================================================
// Geometry helpers
// =====================================================================

function axisOf(d: CardinalDir): 'h' | 'v' {
  return d === 'left' || d === 'right' ? 'h' : 'v';
}

function stepInDir(p: Point, d: CardinalDir, dist: number): Point {
  switch (d) {
    case 'left':
      return { x: p.x - dist, y: p.y };
    case 'right':
      return { x: p.x + dist, y: p.y };
    case 'top':
      return { x: p.x, y: p.y - dist };
    case 'bottom':
      return { x: p.x, y: p.y + dist };
  }
}

function midpoint(a: number, b: number): number {
  return (a + b) / 2;
}

/** Drop zero-length segments and points that are collinear with their
 *  neighbours. `keep` (optional) marks indices that must be preserved
 *  even if they look collinear - used to protect user waypoints from
 *  being silently dropped when a synthetic bend at the same coordinate
 *  would otherwise eat them.
 *
 *  Always returns at least the first and last points (or a single point
 *  if they coincide). */
function collapse(pts: Point[], keep?: ReadonlySet<number>): Point[] {
  if (pts.length < 3) return dedup(pts);
  const out: Point[] = [pts[0]];
  // Re-map kept indices into the OUTPUT array as we go - without
  // tracking the mapping, a simple `keep.has(i)` against the input
  // index would protect the wrong slot once we start dropping points.
  const keepOut = new Set<number>();
  if (keep?.has(0)) keepOut.add(0);
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    // Zero-length: cur duplicates prev.
    if (
      Math.abs(prev.x - cur.x) < 0.5 &&
      Math.abs(prev.y - cur.y) < 0.5
    ) {
      // Map any kept-flag forward - if we're dropping cur but it was
      // marked, it was meaningless anyway.
      continue;
    }
    // Collinear: prev–cur and cur–next are colinear (both pure-H or
    // both pure-V on the same axis).
    const collinear =
      (Math.abs(prev.y - cur.y) < 0.5 && Math.abs(cur.y - next.y) < 0.5) ||
      (Math.abs(prev.x - cur.x) < 0.5 && Math.abs(cur.x - next.x) < 0.5);
    if (collinear && !keep?.has(i)) {
      continue;
    }
    out.push(cur);
    if (keep?.has(i)) keepOut.add(out.length - 1);
  }
  // Last point - only push if it differs from the previous point.
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.abs(prev.x - last.x) > 0.5 || Math.abs(prev.y - last.y) > 0.5) {
    out.push(last);
  }
  void keepOut; // mapping isn't surfaced - kept here for future debug
  return out;
}

/** Rewrite 180° folds into perpendicular stairsteps so the rendered line
 *  never overlaps itself.
 *
 *  A "fold" is a vertex B with neighbours A and C where AB and BC are
 *  collinear and point in OPPOSITE directions - i.e. the path goes out
 *  to B and immediately reverses, tracing back over its previous segment.
 *  This is the visual artifact the user calls "the line running over
 *  itself": typically caused by a dragged waypoint that sits "behind" the
 *  natural axis of travel, forcing the alternating-H-V waypoint router to
 *  emit a backtrack to reach the target.
 *
 *  Fix: replace [A, B, C, D] with [A, B, B', B''] where B' is `jog` units
 *  perpendicular to AB from B, and B'' = (B'.x|y, C.y|x) - i.e. a parallel
 *  rail offset by `jog` from the fold. The next vertex (D, originally
 *  pts[i+2]) becomes the continuation. The fold vertex B is preserved (it
 *  was the user's waypoint, or a meaningful auto-bend); only the reversal
 *  is rerouted around. Visually: a small "step" in place of a doubled-back
 *  segment.
 *
 *  Jog direction (which side of the fold to step toward) is chosen by
 *  summing the remaining path's net movement on the perpendicular axis -
 * i.e. lean the detour toward wherever the line is heading next, so the
 *  stairstep reads as "tucked into the direction of travel" rather than
 *  jutting away from it. */
function defold(pts: Point[], jog: number): Point[] {
  // 3 points is enough to fold: A→B→A retraces over itself. The old guard
  // (< 4) skipped exactly that case, so a connector between coincident /
  // near-coincident endpoints (a self-loop, or two stacked anchors) rendered
  // as a spike that doubled back over its own segment - the one thing the
  // "elbow lines never overlap themselves" rule forbids. The tail handling
  // below re-terminates the rewritten path at the true endpoint.
  if (pts.length < 3) return pts;
  const out: Point[] = [pts[0]];
  let i = 1;
  while (i < pts.length - 1) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inDx = cur.x - prev.x;
    const inDy = cur.y - prev.y;
    const outDx = next.x - cur.x;
    const outDy = next.y - cur.y;
    const vertFold =
      Math.abs(inDx) < 0.5 &&
      Math.abs(outDx) < 0.5 &&
      Math.abs(inDy) > 0.5 &&
      Math.abs(outDy) > 0.5 &&
      Math.sign(inDy) !== Math.sign(outDy);
    const horizFold =
      Math.abs(inDy) < 0.5 &&
      Math.abs(outDy) < 0.5 &&
      Math.abs(inDx) > 0.5 &&
      Math.abs(outDx) > 0.5 &&
      Math.sign(inDx) !== Math.sign(outDx);
    if (!vertFold && !horizFold) {
      out.push(cur);
      i++;
      continue;
    }
    if (vertFold) {
      const dx = jog * laneSign(pts, i, 'h');
      out.push(cur);
      out.push({ x: cur.x + dx, y: cur.y });
      out.push({ x: cur.x + dx, y: next.y });
    } else {
      const dy = jog * laneSign(pts, i, 'v');
      out.push(cur);
      out.push({ x: cur.x, y: cur.y + dy });
      out.push({ x: next.x, y: cur.y + dy });
    }
    // Skip past `next` - its role (the second leg of the fold) is now
    // played by the inserted parallel rail. Resume the walk one beyond it.
    i += 2;
  }
  // Terminate at the true endpoint. Normally the loop leaves i at the last
  // index and we push it - but a fold at the FINAL interior vertex advances
  // i past the end (its second leg was replaced by the inserted rail), so
  // the loop never emits the endpoint. Drop back onto it here so the path
  // always ends AT the target rather than out on the parallel rail. A
  // coordinate check (not an index check) means we never double-push when
  // the loop already terminated cleanly, and never lose the endpoint when a
  // trailing fold overshot it.
  const endPt = pts[pts.length - 1];
  const tailPt = out[out.length - 1];
  if (Math.abs(tailPt.x - endPt.x) > 0.5 || Math.abs(tailPt.y - endPt.y) > 0.5) {
    out.push(endPt);
  }
  return out;
}

/** Sign of the path's net movement after vertex `i` on the given axis.
 *  Used by `defold` to lean the stairstep toward the direction of travel.
 *  Returns +1 on a tie so the jog is always deterministic. */
function laneSign(pts: Point[], i: number, axis: 'h' | 'v'): 1 | -1 {
  let sum = 0;
  for (let k = i + 1; k < pts.length - 1; k++) {
    sum += axis === 'h' ? pts[k + 1].x - pts[k].x : pts[k + 1].y - pts[k].y;
  }
  return sum < -0.5 ? -1 : 1;
}

function dedup(pts: Point[]): Point[] {
  if (pts.length < 2) return pts;
  const out: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    if (Math.abs(prev.x - cur.x) > 0.5 || Math.abs(prev.y - cur.y) > 0.5) {
      out.push(cur);
    }
  }
  return out;
}

// =====================================================================
// Waypoint orientation pick
// =====================================================================

function pickFirstOrientation(
  source: Point,
  firstHint: Point,
  Ds: CardinalDir | null,
): boolean {
  // Strongest signal: source endpoint shares an axis with the hint.
  // If they share x, the segment from source to the hint's x-band is
  // vertical (horizontal=false). If they share y, it's horizontal.
  if (Math.abs(source.x - firstHint.x) < 0.5) return false; // vertical
  if (Math.abs(source.y - firstHint.y) < 0.5) return true; // horizontal
  // Next signal: the source's exit direction picks the axis. Source
  // exiting east/west → first segment horizontal; north/south → vertical.
  if (Ds) return axisOf(Ds) === 'h';
  // Fallback: longer-axis first, so the longest run lays out cleanly.
  return Math.abs(firstHint.x - source.x) >= Math.abs(firstHint.y - source.y);
}
