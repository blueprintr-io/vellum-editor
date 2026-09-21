/* Line jumps - a connector with `hop` on bridges over the lines it crosses
 * instead of cutting straight through them.
 *
 * WHO HOPS. For every pair of crossing connectors A and B, A hops over B when
 *   A.hop && (!B.hop || A paints above B).
 * So a lone hop line always bridges whatever it crosses, and when both lines
 * hop the one higher in the z-order bridges and the lower one stays straight
 * - never both, which would leave a gap with nothing going over it.
 *
 * GEOMETRY. Hops are measured along each STROKE the renderer draws (one line,
 * or the centre + the two offset lines of a bidirectional pair), in arclength
 * from the stroke's start. Each hop is a true semicircle, only just wide
 * enough to clear the line it crosses. It always bulges up, or left on a
 * vertical line, whichever way the connector happens to run, so a column of
 * hops reads as one consistent treatment.
 *
 * A hop is dropped (the lines just cross) where it can't be drawn cleanly:
 * too close to an endpoint or its marker, across an elbow's rounded corner,
 * or where the lines are so nearly parallel that the hop would run on.
 * Crossings so close that their hops would overlap share one wider
 * semicircle.
 *
 * Pure and React-free: importable from the node test runner
 * (`tests/line-jumps.test.ts`).
 */

import type { Connector, EndpointMarker, Shape } from '@/store/types';
import {
  connectorPolyline,
  offsetPolyline,
  resolveConnectorPath,
  sampleCurvedPolyline,
} from './routing';
import { subscribeSilhouettes } from './silhouette';

type XY = { x: number; y: number };

/** One hop along a stroke: the semicircle leaves the line `start` px along
 *  it and lands back on it at `end`. */
export type Hop = { start: number; end: number };

/** Hops per stroke, indexed like `connectorStrokes`. */
export type ConnectorHops = Hop[][];

/** Everything the jump pass needs to know about one connector. */
export type JumpLine = {
  conn: Connector;
  /** See `connectorStrokes`. A line that doesn't hop only ever needs its
   *  centre line, so `jumpLineFor` gives it just that. */
  strokes: XY[][];
  strokeWidth: number;
};

export const DEFAULT_CONNECTOR_STROKE_WIDTH = 1.25;

/** Corner radius the renderer rounds elbows with (`polylineToRoundedPath`'s
 *  default). A hop must stay off the rounded part of a corner. */
const ELBOW_CORNER_RADIUS = 8;

/** Most work one pass may do, counted in box and segment-pair tests rather
 *  than time so the answer is the same on every machine. A diagram past it
 *  draws every crossing flat: all or nothing, so hops never go missing from
 *  some lines and not others. Sized so a pass stays inside a frame; a
 *  realistic diagram (hundreds of lines, dozens of crossings each) uses a
 *  small fraction. */
export const LINE_JUMP_WORK_BUDGET = 500_000;

/** Work charged per crossing found, for placing, sorting, merging and
 *  checking its hop - measured at roughly this many segment-pair tests. */
const CROSSING_WORK = 8;

/** Segments per run in a polyline's box index. */
const INDEX_CHUNK = 8;

/** Curve samples per cubic for a hopping curved line - it is drawn from the
 *  polyline, so it needs more than the hit-tester's 24 to stay smooth. */
const JUMP_CURVE_SAMPLES = 64;

/** Space between the crossing line's edge and the hop's inner edge. */
const HOP_CLEARANCE = 2;
/** Smallest hop radius - below this it stops reading as a hop at 100%. */
const HOP_MIN_RADIUS = 4;
/** Straight line a hop keeps from an endpoint (past any marker). */
const HOP_END_CLEARANCE = 4;
/** A crossing shallower than this (sin of the angle, ~15°) gets no bridge. */
const HOP_MIN_SIN = 0.26;
/** Most a bridge may turn along a curve before it no longer reads as one. */
const HOP_MAX_TURN = Math.PI / 6;
/** A polyline vertex turning more than this is a corner, not curve sampling. */
const CORNER_TURN = Math.PI / 18;

/** The pull-back from a shape each end marker needs so it doesn't sink into
 *  the outline. Shared with Connector.tsx so the jump pass measures exactly
 *  the line that gets drawn. */
export function markerSetback(
  marker: EndpointMarker,
  floating: boolean,
  strokeWidth: number,
): number {
  if (floating) return 0;
  // Chevron tip sits AT the line endpoint (no body past the tip), so a
  // small fixed setback leaves a visual gap before the shape.
  if (marker === 'arrow') return 2;
  // Filled triangle extends ~strokeWidth past the line endpoint (see
  // taperedRefX in <Marker />), so pull the line back further for the
  // same visual gap before the shape.
  if (marker === 'triangle') return strokeWidth + 2;
  // 'none', 'circle', 'dot', 'diamond' have 0 setback (centered on boundary or clean end)
  return 0;
}

export function isBidirectional(conn: Connector): boolean {
  return (
    conn.relationship === 'bpmn-conversation-link' || conn.bidirectional === true
  );
}

/** Perpendicular distance of each line of a bidirectional pair from centre. */
export function bidirectionalOffset(strokeWidth: number): number {
  return Math.max(2, strokeWidth + 2);
}

/** Resolved endpoints as `resolveConnectorPath` returns them. */
type ResolvedPath = NonNullable<ReturnType<typeof resolveConnectorPath>>;

/** The strokes a connector paints, as polylines: `[centre]`, or
 *  `[centre, forward, reverse]` for a bidirectional pair. `polyline` is the
 *  connector's ordinary polyline; a curved line is resampled more finely so
 *  it can be drawn from the points. */
export function connectorStrokes(
  conn: Connector,
  path: ResolvedPath,
  polyline: XY[],
  strokeWidth: number,
): XY[][] {
  const centre =
    conn.routing === 'curved'
      ? sampleCurvedPolyline(
          path.fx,
          path.fy,
          path.tx,
          path.ty,
          path.fromAnchor,
          path.toAnchor,
          conn.waypoints,
          path.fromRot,
          path.toRot,
          JUMP_CURVE_SAMPLES,
        )
      : polyline;
  if (!isBidirectional(conn)) return [centre];
  const off = bidirectionalOffset(strokeWidth);
  return [centre, offsetPolyline(centre, off), offsetPolyline(centre, -off)];
}

/** A connector's route depends only on the connector and the shapes its ends
 *  are bound to, and the store replaces those objects rather than mutating
 *  them - so a route worked out once holds until one of the three changes.
 *  The one outside input is an icon's traced outline, which lands
 *  asynchronously; `routeEpoch` moves on when one does. */
type CachedLine = {
  from: Shape | undefined;
  to: Shape | undefined;
  epoch: number;
  line: JumpLine | null;
};
const lineCache = new WeakMap<Connector, CachedLine>();
const shapeIndexes = new WeakMap<readonly Shape[], Map<string, Shape>>();
let routeEpoch = 0;
subscribeSilhouettes(() => {
  routeEpoch++;
});

function boundShape(
  ep: Connector['from'],
  byId: Map<string, Shape>,
): Shape | undefined {
  return 'shape' in ep ? byId.get(ep.shape) : undefined;
}

/** Resolve a connector the way Connector.tsx does (marker setbacks and all)
 *  into the input the jump pass needs. Null when an endpoint can't resolve -
 * the renderer draws nothing for it either. Reuses the previous answer
 *  while the connector and its end shapes are unchanged (see `CachedLine`),
 *  so a pass after an edit only re-routes the lines that edit touched. */
export function jumpLineFor(conn: Connector, shapes: Shape[]): JumpLine | null {
  let byId = shapeIndexes.get(shapes);
  if (!byId) {
    byId = new Map();
    // First match wins, as `shapes.find` does in the router.
    for (const sh of shapes) if (!byId.has(sh.id)) byId.set(sh.id, sh);
    shapeIndexes.set(shapes, byId);
  }
  const from = boundShape(conn.from, byId);
  const to = boundShape(conn.to, byId);
  const hit = lineCache.get(conn);
  if (hit && hit.from === from && hit.to === to && hit.epoch === routeEpoch) {
    return hit.line;
  }
  const line = routeJumpLine(conn, shapes);
  lineCache.set(conn, { from, to, epoch: routeEpoch, line });
  return line;
}

function routeJumpLine(conn: Connector, shapes: Shape[]): JumpLine | null {
  const strokeWidth = conn.strokeWidth ?? DEFAULT_CONNECTOR_STROKE_WIDTH;
  const path = resolveConnectorPath(
    conn,
    shapes,
    markerSetback(conn.fromMarker ?? 'none', !('shape' in conn.from), strokeWidth),
    markerSetback(conn.toMarker ?? 'arrow', !('shape' in conn.to), strokeWidth),
  );
  if (!path) return null;
  const polyline = connectorPolyline(
    conn,
    path.fx,
    path.fy,
    path.tx,
    path.ty,
    path.fromAnchor,
    path.toAnchor,
    path.fromRot,
    path.toRot,
    path.fromRect,
    path.toRect,
  );
  return {
    conn,
    // The finer curve resample and a bidirectional pair's offset lines are
    // only for drawing hops; a line that doesn't hop is just something to
    // cross, and its ordinary polyline is enough for that.
    strokes:
      conn.hop === true
        ? connectorStrokes(conn, path, polyline, strokeWidth)
        : [polyline],
    strokeWidth,
  };
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Bounding box of `pts[from..to]` inclusive. */
function boxOf(pts: XY[], from = 0, to = pts.length - 1): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = from; i <= to; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** A polyline with the box of each run of `INDEX_CHUNK` segments, so the
 *  crossing search only tests segments in runs whose boxes overlap. Run `k`
 *  covers segments `k * INDEX_CHUNK` up to the next run. */
type IndexedLine = { pts: XY[]; box: Box; runs: Box[] };

function indexLine(pts: XY[]): IndexedLine {
  const runs: Box[] = [];
  for (let k = 0; k < pts.length - 1; k += INDEX_CHUNK) {
    runs.push(boxOf(pts, k, Math.min(k + INDEX_CHUNK, pts.length - 1)));
  }
  return { pts, box: boxOf(pts), runs };
}

/** What's left of the pass's work allowance. */
type Work = { left: number };

/** Thrown to abandon a pass that has used up its allowance. */
const OVER_BUDGET = new Error('line-jump work budget exceeded');

function spend(work: Work): void {
  if (--work.left < 0) throw OVER_BUDGET;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function cumulativeLengths(pts: XY[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return cum;
}

/** Where `line` crosses `other`, as arclength along `line`, with the sine of
 *  the crossing angle. An end of `other` resting on `line` is a meeting, not
 *  a crossing, and is skipped. */
function crossings(
  line: IndexedLine,
  cum: number[],
  other: IndexedLine,
  work: Work,
): { s: number; sin: number }[] {
  const out: { s: number; sin: number }[] = [];
  const a = line.pts;
  const b = other.pts;
  const last = b.length - 2;
  for (let ra = 0; ra < line.runs.length; ra++) {
    const runA = line.runs[ra];
    spend(work);
    if (!boxesOverlap(runA, other.box)) continue;
    const aEnd = Math.min((ra + 1) * INDEX_CHUNK, a.length - 1);
    for (let rb = 0; rb < other.runs.length; rb++) {
      const runB = other.runs[rb];
      spend(work);
      if (!boxesOverlap(runA, runB)) continue;
      const bEnd = Math.min((rb + 1) * INDEX_CHUNK, b.length - 1);
      for (let i = ra * INDEX_CHUNK; i < aEnd; i++) {
        const p = a[i];
        const r = { x: a[i + 1].x - p.x, y: a[i + 1].y - p.y };
        const minX = Math.min(p.x, a[i + 1].x);
        const maxX = Math.max(p.x, a[i + 1].x);
        const minY = Math.min(p.y, a[i + 1].y);
        const maxY = Math.max(p.y, a[i + 1].y);
        if (maxX < runB.minX || minX > runB.maxX || maxY < runB.minY || minY > runB.maxY) {
          continue;
        }
        const rLen = Math.hypot(r.x, r.y);
        if (rLen === 0) continue;
        for (let j = rb * INDEX_CHUNK; j < bEnd; j++) {
          spend(work);
          const q0 = b[j];
          const q1 = b[j + 1];
          if (
            Math.max(q0.x, q1.x) < minX ||
            Math.min(q0.x, q1.x) > maxX ||
            Math.max(q0.y, q1.y) < minY ||
            Math.min(q0.y, q1.y) > maxY
          ) {
            continue;
          }
          const q = { x: q1.x - q0.x, y: q1.y - q0.y };
          const qLen = Math.hypot(q.x, q.y);
          if (qLen === 0) continue;
          const denom = r.x * q.y - r.y * q.x;
          const sin = Math.abs(denom) / (rLen * qLen);
          if (sin < 1e-6) continue;
          const wx = q0.x - p.x;
          const wy = q0.y - p.y;
          const t = (wx * q.y - wy * q.x) / denom;
          const u = (wx * r.y - wy * r.x) / denom;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          if ((j === 0 && u < 1e-6) || (j === last && u > 1 - 1e-6)) continue;
          out.push({ s: cum[i] + t * rLen, sin });
        }
      }
    }
  }
  return out;
}

/** Arclength spans a bridge may not overlap: every elbow corner's rounded
 *  part, and every sharp bend. */
function forbiddenSpans(pts: XY[], cum: number[], cornerRadius: number): Hop[] {
  const out: Hop[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const inLen = cum[i] - cum[i - 1];
    const outLen = cum[i + 1] - cum[i];
    if (inLen === 0 || outLen === 0) continue;
    const r = cornerRadius > 0 ? Math.min(cornerRadius, inLen / 2, outLen / 2) : 0;
    if (r > 0) {
      out.push({ start: cum[i] - r, end: cum[i] + r });
    } else if (turnAt(pts, i) > CORNER_TURN) {
      out.push({ start: cum[i], end: cum[i] });
    }
  }
  return out;
}

function turnAt(pts: XY[], i: number): number {
  const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
  const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
  return Math.abs(((b - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
}

/** Room an end marker takes up along the line, conservatively: explicit size,
 *  or the largest strokeWidth-relative default any marker kind uses. */
function markerRoom(marker: EndpointMarker, size: number | undefined, sw: number): number {
  return marker === 'none' ? 0 : size ?? sw * 10;
}

/** A line as something to cross: its centre, indexed, and how wide a band
 *  it paints. */
type Band = { centre: IndexedLine; halfWidth: number; hop: boolean };

/** Index of the first entry in non-decreasing `cum` greater than `v`. */
function firstAbove(cum: number[], v: number): number {
  let lo = 0;
  let hi = cum.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Hops for one stroke of the line at `self` in paint order, over every line
 *  it should hop: anything else, less hopping lines painted above it. */
function hopsForStroke(
  line: JumpLine,
  stroke: IndexedLine,
  bands: Band[],
  self: number,
  work: Work,
): Hop[] {
  const pts = stroke.pts;
  if (pts.length < 2) return [];
  const sw = line.strokeWidth;
  const cum = cumulativeLengths(pts);
  const total = cum[cum.length - 1];

  const spans: Hop[] = [];
  for (let j = 0; j < bands.length; j++) {
    const ob = bands[j];
    // Hopping lines painted above this one hop over it instead.
    if (j === self || (ob.hop && j > self)) continue;
    spend(work);
    if (!boxesOverlap(stroke.box, ob.centre.box)) continue;
    for (const c of crossings(stroke, cum, ob.centre, work)) {
      if (c.sin < HOP_MIN_SIN) continue;
      // Radius clears the crossed line's footprint along this one (wider
      // the more obliquely it crosses) plus this line's own half-stroke.
      const r = Math.max(HOP_MIN_RADIUS, ob.halfWidth / c.sin + sw / 2 + HOP_CLEARANCE);
      spans.push({ start: c.s - r, end: c.s + r });
    }
  }
  if (spans.length === 0) return [];
  work.left -= spans.length * CROSSING_WORK;
  spans.sort((a, b) => a.start - b.start);

  const merged: Hop[] = [];
  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    if (prev && sp.start < prev.end) {
      prev.end = Math.max(prev.end, sp.end);
    } else {
      merged.push({ ...sp });
    }
  }

  const conn = line.conn;
  const fromRoom = markerRoom(conn.fromMarker ?? 'none', conn.fromMarkerSize, sw);
  const toRoom = markerRoom(conn.toMarker ?? 'arrow', conn.toMarkerSize, sw);
  // A bidirectional pair's reverse line carries the markers swapped, so both
  // of its ends need room for either.
  const bidir = isBidirectional(conn);
  const startLimit = (bidir ? Math.max(fromRoom, toRoom) : fromRoom) + HOP_END_CLEARANCE;
  const endLimit = total - (bidir ? Math.max(fromRoom, toRoom) : toRoom) - HOP_END_CLEARANCE;
  const corners = forbiddenSpans(pts, cum, strokeCornerRadius(conn));

  return merged.filter((h) => {
    if (h.start < startLimit || h.end > endLimit) return false;
    if (corners.some((c) => c.start <= h.end && c.end >= h.start)) return false;
    // A curve may bend a little under a hop, but not so much that the
    // semicircle's chord cuts visibly across it.
    let turn = 0;
    for (let i = Math.max(1, firstAbove(cum, h.start)); i < pts.length - 1 && cum[i] < h.end; i++) {
      turn += turnAt(pts, i);
    }
    return turn <= HOP_MAX_TURN;
  });
}

/** Work out every hop on the canvas. `lines` must be in paint order, bottom
 *  first - it decides who hops when two hopping lines cross. Only connectors
 *  that actually get a hop appear in the result, and none do once the pass
 *  runs past `budget` (see `LINE_JUMP_WORK_BUDGET`). */
export function computeLineJumps(
  lines: JumpLine[],
  budget: number = LINE_JUMP_WORK_BUDGET,
): Map<string, ConnectorHops> {
  const out = new Map<string, ConnectorHops>();
  if (!lines.some((l) => l.conn.hop === true)) return out;

  const bands: Band[] = lines.map((l) => ({
    centre: indexLine(l.strokes[0] ?? []),
    halfWidth: isBidirectional(l.conn)
      ? bidirectionalOffset(l.strokeWidth) + l.strokeWidth / 2
      : l.strokeWidth / 2,
    hop: l.conn.hop === true,
  }));

  const work: Work = { left: budget };
  try {
    lines.forEach((line, i) => {
      if (!bands[i].hop) return;
      const hops = line.strokes.map((stroke, k) =>
        hopsForStroke(line, k === 0 ? bands[i].centre : indexLine(stroke), bands, i, work),
      );
      if (hops.some((h) => h.length > 0)) out.set(line.conn.id, hops);
    });
  } catch (err) {
    if (err !== OVER_BUDGET) throw err;
    return new Map();
  }
  return out;
}

function sameHops(a: ConnectorHops, b: ConnectorHops): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j].start !== b[i][j].start || a[i][j].end !== b[i][j].end) return false;
    }
  }
  return true;
}

/** Carry over the previous pass's hop arrays wherever nothing changed, so a
 *  memoised connector whose bridges didn't move doesn't re-render. */
export function reuseUnchangedHops(
  prev: ReadonlyMap<string, ConnectorHops>,
  next: Map<string, ConnectorHops>,
): Map<string, ConnectorHops> {
  for (const [id, hops] of next) {
    const old = prev.get(id);
    if (old && sameHops(old, hops)) next.set(id, old);
  }
  return next;
}

/** Point `s` px along a polyline. */
function pointAlong(pts: XY[], cum: number[], s: number): XY {
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= s) {
      const len = cum[i] - cum[i - 1];
      const t = len === 0 ? 0 : (s - cum[i - 1]) / len;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      };
    }
  }
  return pts[pts.length - 1];
}

/** SVG arc for one hop: a semicircle from `a` to `b` (both on the line). */
function hopArc(a: XY, b: XY): string {
  const r = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  if (r === 0) return '';
  // Bulge toward the upper-left: up on a horizontal line, left on a vertical
  // one, whichever way the connector runs. The normal (dy, -dx) is the
  // clockwise-on-screen side, which is SVG's sweep-flag 1; when that points
  // down or right, sweep the other way.
  const sweep = b.y - a.y - (b.x - a.x) > 0 ? 0 : 1;
  return `A ${r} ${r} 0 0 ${sweep} ${b.x} ${b.y}`;
}

/** Corner radius `hoppedPath` should round a connector's bends with - the
 *  same rounding the renderer gives it without hops. */
export function strokeCornerRadius(conn: Connector): number {
  return conn.routing === 'orthogonal' ? ELBOW_CORNER_RADIUS : 0;
}

/** Draw a stroke with its hops. With no hops this is the same path
 *  `polylineToRoundedPath` (cornerRadius > 0) or a plain polyline draws. */
export function hoppedPath(pts: XY[], hops: Hop[], cornerRadius: number): string {
  if (pts.length === 0) return '';
  const cum = cumulativeLengths(pts);
  const n = pts.length;
  const parts: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  let h = 0;
  let i = 1;
  while (i < n) {
    const last = i === n - 1;
    const inLen = cum[i] - cum[i - 1];
    const outLen = last ? 0 : cum[i + 1] - cum[i];
    const r =
      !last && cornerRadius > 0 && inLen > 0 && outLen > 0
        ? Math.min(cornerRadius, inLen / 2, outLen / 2)
        : 0;
    if (h < hops.length && hops[h].start <= cum[i] - r) {
      const hop = hops[h++];
      const a = pointAlong(pts, cum, hop.start);
      const b = pointAlong(pts, cum, hop.end);
      parts.push(`L ${a.x} ${a.y}`, hopArc(a, b));
      // The hop replaces any gentle curve samples it spans.
      while (i < n - 1 && cum[i] <= hop.end) i++;
      continue;
    }
    const cur = pts[i];
    if (r > 0) {
      const prev = pts[i - 1];
      const next = pts[i + 1];
      parts.push(
        `L ${cur.x - ((cur.x - prev.x) / inLen) * r} ${cur.y - ((cur.y - prev.y) / inLen) * r}`,
        `Q ${cur.x} ${cur.y} ${cur.x + ((next.x - cur.x) / outLen) * r} ${cur.y + ((next.y - cur.y) / outLen) * r}`,
      );
    } else {
      parts.push(`L ${cur.x} ${cur.y}`);
    }
    i++;
  }
  return parts.join(' ');
}
