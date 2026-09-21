/* Connector attachment anchors.
 *
 * MODEL (as of the always-on rework):
 *   - Every non-freehand shape ALWAYS exposes the same 8 FIXED anchors -
 * 4 corners + 4 edge midpoints - regardless of the smart-anchor
 *     toggle. This is the predictable set users expect.
 *   - "Smart anchors" are now ADDITIVE: when a shape opts in (per-shape
 *     `smartAnchor`, a group-cascade, or the workspace global), N extra
 *     points are added ON TOP of the fixed 8 → 8 + N total. N is
 *     `smartAnchorCount` (default 8), constrained to [MIN, MAX].
 *   - The extra points are distributed by perimeter arc-length INTO THE
 *     GAPS between the fixed 8 (proportional to gap length, evenly inside
 *     each gap) so they never sit on top of a fixed anchor and the union
 *     reads as evenly spaced.
 *
 * Snapping rule: a connector dropped over a non-freehand shape locks to
 *   its NEAREST anchor in this set - no edge-band / centre-zone fall-
 *   through. Fixed points are always there, so this is now universal.
 *
 * Visual fidelity: dots render at `shapeAnchorPoint` projections, NOT raw
 *   bbox positions, so they sit on the actual visible outline (silhouette
 *   for icons, curve for ellipse, diagonal for diamond, actual edge for
 *   polygons). Where the dot appears is exactly where the connector lands.
 */

import type { Anchor, Shape } from '@/store/types';
import { fromShapeLocal, pointNearShape, toShapeLocal } from './projection';
import { shapeAnchorPoint } from './routing';

/** Default and bounds for the ADDITIVE smart-anchor count (the extra
 *  points layered on top of the always-present fixed 8). */
export const SMART_ANCHOR_DEFAULT_COUNT = 8;
export const SMART_ANCHOR_MIN = 4;
export const SMART_ANCHOR_MAX = 64;

/** Reveal radius used by the canvas while a connector drag is in flight:
 *  shapes whose AABB is within this many SCREEN pixels of the cursor
 *  surface their anchor dots even before the cursor crosses the bbox.
 *  The caller divides by `zoom` to convert to world units so the
 *  "approach feel" stays consistent regardless of zoom. */
export const SMART_ANCHOR_PROXIMITY_BAND = 48;

/** The 8 fixed anchors every non-freehand shape always exposes, as
 *  fractional `[fx, fy]` in shape-local bbox space, in clockwise
 *  perimeter order starting at the top-left corner:
 *  TL → top-mid → TR → right-mid → BR → bottom-mid → BL → left-mid.
 *  Projected onto the actual outline by `shapeAnchorPoint`, so on a
 *  triangle / cloud / ellipse they land on the visible edge, not the
 *  bbox. Matches the set `nearest8Anchor` (routing.ts) uses for click-
 *  commit - that behaviour is now the universal default. */
export const FIXED_ANCHOR_FRACTIONS: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
];

export function getSmartAnchorCount(
  shape: Pick<Shape, 'smartAnchorCount'>,
  globalDefault: number = SMART_ANCHOR_DEFAULT_COUNT,
): number {
  const fallback = clampSmartAnchorCount(globalDefault);
  const n = shape.smartAnchorCount ?? fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(SMART_ANCHOR_MIN, Math.min(SMART_ANCHOR_MAX, Math.floor(n)));
}

export function clampSmartAnchorCount(n: number): number {
  if (!Number.isFinite(n)) return SMART_ANCHOR_DEFAULT_COUNT;
  return Math.max(SMART_ANCHOR_MIN, Math.min(SMART_ANCHOR_MAX, Math.floor(n)));
}

/** Walk the bbox perimeter parametrised by t in [0, 1), where t=0 is
 *  top-left and increases clockwise. Returns shape-local fractional
 *  [fx, fy]. Each side's slice of t is proportional to its physical
 *  length, so equal steps in t produce equal physical spacing. */
function perimeterToFractional(
  t: number,
  w: number,
  h: number,
): [number, number] {
  const u = ((t % 1) + 1) % 1;
  const perim = 2 * (w + h);
  const aTop = w / perim;
  const aRight = (w + h) / perim;
  const aBottom = (2 * w + h) / perim;
  if (u < aTop) return [u / aTop, 0];
  if (u < aRight) return [1, (u - aTop) / (aRight - aTop)];
  if (u < aBottom) return [1 - (u - aRight) / (aBottom - aRight), 1];
  return [0, 1 - (u - aBottom) / (1 - aBottom)];
}

/** Perimeter-t (arc-length fraction, clockwise from top-left) of each of
 *  the 8 fixed anchors, for a `w`×`h` bbox. */
function fixedAnchorPerimeterTs(w: number, h: number): number[] {
  const width = w > 0 ? w : 1;
  const height = h > 0 ? h : 1;
  const perim = 2 * (width + height);
  return [
    0, // TL
    (0.5 * width) / perim, // top-mid
    width / perim, // TR
    (width + 0.5 * height) / perim, // right-mid
    (width + height) / perim, // BR
    (1.5 * width + height) / perim, // bottom-mid
    (2 * width + height) / perim, // BL
    (2 * width + 1.5 * height) / perim, // left-mid
  ];
}

/** The N additive smart anchors, distributed across the 8 gaps between
 *  the fixed anchors. Each gap gets a share of N proportional to its
 *  perimeter length (largest-remainder rounding so the total is exactly
 *  N), then those points are spaced evenly STRICTLY INSIDE the gap so
 *  they never coincide with a fixed anchor. Returns fractional [fx, fy]. */
export function additiveSmartFractions(
  count: number,
  w: number,
  h: number,
): [number, number][] {
  const n = clampSmartAnchorCount(count);
  const fixedTs = fixedAnchorPerimeterTs(w, h);
  const k = fixedTs.length;
  const gapLen = fixedTs.map((t, i) => {
    const next = i + 1 < k ? fixedTs[i + 1] : 1 + fixedTs[0];
    return next - t;
  });
  // Largest-remainder apportionment of n across the gaps by length.
  const quota = gapLen.map((g) => g * n);
  const base = quota.map((q) => Math.floor(q));
  let assigned = base.reduce((s, b) => s + b, 0);
  const order = quota
    .map((q, i) => ({ i, frac: q - Math.floor(q) }))
    .sort((a, b) => b.frac - a.frac);
  for (let j = 0; assigned < n; j++, assigned++) {
    base[order[j % k].i] += 1;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    const m = base[i];
    if (m === 0) continue;
    const a = fixedTs[i];
    const b = i + 1 < k ? fixedTs[i + 1] : 1 + fixedTs[0];
    for (let j = 1; j <= m; j++) {
      const t = a + ((b - a) * j) / (m + 1);
      out.push(perimeterToFractional(t, w, h));
    }
  }
  return out;
}

/** True when this shape exposes the fixed anchor set + (when on) the
 *  additive smart anchors. Only freehand is excluded - its bbox is a
 *  stroke envelope, not a body to anchor against. Every other kind
 *  (incl. groups) always carries the 8 fixed anchors, so this gate is
 *  what the canvas uses to decide a shape strict-snaps connectors.
 *
 *  The `_shapes` / `_globalOn` params are kept for call-site
 *  compatibility with the pre-rework signature; they no longer affect
 *  the result (anchors are universal now - the toggle only governs the
 *  *additive* extras, see `shapeWantsExtraAnchors`). */
export function effectiveShapeHasSmartAnchors(
  shape: Shape,
  _shapes?: readonly Shape[],
  _globalOn?: boolean,
): boolean {
  return shape.kind !== 'freehand';
}

/** Non-cascading variant - same universal rule. Kept as a distinct
 *  export because SelectionOverlay wants a per-shape answer that doesn't
 *  need the shapes array. */
export function shapeHasSmartAnchors(
  shape: Pick<Shape, 'kind'>,
  _globalOn?: boolean,
): boolean {
  return shape.kind !== 'freehand';
}

/** Whether the shape gets the ADDITIVE smart anchors on top of the fixed
 *  8. This is the actual toggle: explicit per-shape `smartAnchor`, else a
 *  group-ancestor cascade, else the workspace global. Freehand never
 *  gets extras (it has no anchors at all). */
export function shapeWantsExtraAnchors(
  shape: Shape,
  shapes: readonly Shape[],
  globalOn: boolean,
): boolean {
  if (shape.kind === 'freehand') return false;
  if (shape.smartAnchor === true) return true;
  if (shape.smartAnchor === false) return false;
  let cursorId: string | undefined = shape.parent;
  for (let i = 0; i < 8 && cursorId; i++) {
    const parent: Shape | undefined = shapes.find((s) => s.id === cursorId);
    if (!parent) break;
    if (parent.kind === 'group' && parent.smartAnchor === true) return true;
    cursorId = parent.parent;
  }
  return globalOn;
}

/** True iff `shape` is contained (at any depth) inside a group that the
 *  supplied predicate would consider "active". Used by the anchor render
 *  gate to make a child light up when its wrapping group is selected or
 *  hovered. */
export function hasActiveGroupAncestor(
  shape: Shape,
  shapes: readonly Shape[],
  isActive: (groupId: string) => boolean,
): boolean {
  let cursorId: string | undefined = shape.parent;
  for (let i = 0; i < 8 && cursorId; i++) {
    const parent: Shape | undefined = shapes.find((s) => s.id === cursorId);
    if (!parent) break;
    if (parent.kind === 'group' && isActive(parent.id)) return true;
    cursorId = parent.parent;
  }
  return false;
}

/** Mirrored, unrotated anchor points for a shape, paired with their original fractional
 *  `[fx, fy]` so callers can hand the fraction back to the connector
 *  model as an Anchor tuple. Always the fixed 8; plus the additive smart
 *  points when `wantsExtra`. Every point is run through
 *  `shapeAnchorPoint`, which projects fractional anchors onto the actual
 *  outline (ellipse curve, diamond/polygon edge, icon silhouette) - so
 *  the dot is exactly where the connector commits.
 *
 *  The additive count is resolved per-shape via `getSmartAnchorCount`:
 *  the shape's own `smartAnchorCount` wins, falling back to
 *  `globalDefault` (the workspace `smartAnchorCountGlobal`) when unset.
 *  Callers pass the workspace global, NOT a pre-resolved value -
 * resolving here is what keeps the canvas dots and connector snapping
 *  in sync with the inspector's ± control (which edits the per-shape
 *  `smartAnchorCount`).
 *
 *  Rotation is NOT pre-applied; the dot renderer wraps these in a
 *  rotation-aware <g> and the connector pipeline rotates separately. */
export function smartAnchorPoints(
  shape: Shape,
  wantsExtra: boolean,
  globalDefault: number = SMART_ANCHOR_DEFAULT_COUNT,
): { fx: number; fy: number; x: number; y: number }[] {
  if (shape.kind === 'freehand') return [];
  const fr: [number, number][] = [...FIXED_ANCHOR_FRACTIONS];
  if (wantsExtra) {
    fr.push(
      ...additiveSmartFractions(
        getSmartAnchorCount(shape, globalDefault),
        shape.w,
        shape.h,
      ),
    );
  }
  return fr.map(([fx, fy]) => {
    const [x, y] = shapeAnchorPoint(shape, [fx, fy]);
    return { fx, fy, x, y };
  });
}

/** Nearest anchor on `shape` to a world-space cursor. With the default
 *  `maxDist` of Infinity the snap is unconditional whenever the shape is
 *  the active target - anchors take precedence over every other snap mode.
 *  Pass a finite world-space `maxDist` to require the cursor be within that
 *  radius of an anchor.
 *  Returns null for freehand (no anchors) or when the nearest anchor is
 *  beyond `maxDist`. `globalDefault` is the workspace fallback; the
 *  per-shape count is resolved inside `smartAnchorPoints`.
 *
 *  Rotation: `smartAnchorPoints` is in the shape's LOCAL frame (the dot
 *  overlay rotates it as a whole), so the cursor is un-rotated into that
 *  frame for the nearest-neighbour search - rotation preserves distances,
 *  so `maxDist` means the same thing either way - and the winning point is
 *  rotated back so the returned `x`/`y` is the WORLD position of the dot the
 *  user sees (callers draw the connector preview there and measure the
 *  cursor→port distance from it). */
export function nearestSmartAnchor(
  shape: Shape,
  cursor: { x: number; y: number },
  wantsExtra: boolean,
  globalDefault: number = SMART_ANCHOR_DEFAULT_COUNT,
  maxDist: number = Infinity,
): { anchor: Anchor; x: number; y: number } | null {
  const points = smartAnchorPoints(shape, wantsExtra, globalDefault);
  if (points.length === 0) return null;
  const local = toShapeLocal(cursor, shape);
  let best: { anchor: Anchor; x: number; y: number; d2: number } | null = null;
  for (const p of points) {
    const dx = p.x - local.x;
    const dy = p.y - local.y;
    const d2 = dx * dx + dy * dy;
    if (!best || d2 < best.d2) {
      best = { anchor: [p.fx, p.fy] as Anchor, x: p.x, y: p.y, d2 };
    }
  }
  if (!best) return null;
  if (Number.isFinite(maxDist) && best.d2 > maxDist * maxDist) return null;
  const world = fromShapeLocal({ x: best.x, y: best.y }, shape);
  return { anchor: best.anchor, x: world.x, y: world.y };
}

/* ── Port capture ────────────────────────────────────────────────────────
 *
 * The connector snap stack used to resolve its target purely by containment
 * (`shapeUnder`: whose AABB holds the cursor) and only THEN ask that one
 * shape for its nearest anchor. Two facts made a nested shape's ports
 * unreachable:
 *
 *   1. Anchors sit ON the boundary, so aiming at a child's corner / edge-mid
 *      puts the cursor a few px OUTSIDE that child's AABB - containment
 *      falls through to the enclosing container.
 *   2. With the magnet on the anchor probe runs with `maxDist = Infinity`,
 *      so the wrongly-resolved outer shape then locks the endpoint onto one
 *      of ITS anchors, however far away that is.
 *
 * `capturePortNear` inverts the order inside a tight radius: any shape with
 * an anchor within `captureDist` of the cursor can win the target outright,
 * regardless of what contains the cursor. Outside that radius it returns
 * null and the caller keeps the existing containment behaviour - so dragging
 * into the middle of a container still binds to the container, and the only
 * thing that changed is that a deliberate aim at a visible dot now lands.
 */

/** SCREEN-px radius within which an anchor dot captures a connector endpoint
 *  outright - the radius that means "the user is acting on this specific
 *  port". Stays comfortably under the grid step (24) so it reads as a
 *  deliberate aim rather than a wide pull. Divided by `zoom` at the call
 *  site, and narrowed per shape by `portCaptureDistFor` on the click path. */
export const PORT_CAPTURE_PX = 14;

/** SCREEN-px radius an ALREADY-captured port holds on to the endpoint for,
 *  once capture has happened. Hysteresis: without it, a cursor hovering the
 *  capture boundary flip-flops between the child's port and the container's
 *  auto-anchor on alternate frames, which reads as jitter. Only widens an
 *  existing capture - a nearer port still wins immediately. */
export const PORT_RELEASE_PX = 22;

/** SCREEN-px slack inside which two candidate ports count as tied. Ties go
 *  to the INNERMOST shape (deepest in the parent chain, then smallest, then
 *  topmost). Matters when a child sits flush against its container's edge,
 *  where both anchor sets nearly coincide and raw distance can't separate
 *  them - the user is aiming at the child. */
export const PORT_TIE_SLACK_PX = 4;

/** Ceiling on how much of a shape a single port's capture radius may claim,
 *  as a fraction of the shape's SHORTER side.
 *
 *  Anchors ring the perimeter, so a flat radius scales badly downward: on a
 *  44×44 icon, 14px around each of the eight fixed anchors covers the whole
 *  thing, and once the icon is selected there's no body left to grab - every
 *  press starts a connector instead of a drag. Clamping to a fraction of the
 *  shape keeps an actual interior on small shapes while leaving normal-sized
 *  ones at the full radius (anything ≥ ~64px on its short side is
 *  unaffected). */
export const PORT_CAPTURE_SHAPE_FRACTION = 0.22;

/** Floor for the clamp above, in SCREEN px (divided by `zoom` at the call
 *  site, same convention as the radii). Below this a port on a tiny shape
 *  would be unhittable, which is a worse failure than a cramped body. */
export const PORT_CAPTURE_MIN_PX = 7;

/** How long (ms) the cursor must rest on an anchor dot before a dragged
 *  connector end snaps to it ("hover-to-connect") while Shape Snapping is
 *  off. Without Grid Snapping there's no capture radius around dots, so this
 *  deliberate hover is the only way an end reaches one; with it, the end
 *  jumps between grid points and can't be rested on a dot, so
 *  `PORT_CAPTURE_PX` proximity capture applies instead. */
export const PORT_DWELL_MS = 500;

/** The same wait with Shape Snapping on - twice as fast, since that mode is
 *  asking for snapping. */
export const PORT_DWELL_SNAP_MS = 250;

/** SCREEN-px radius that counts as resting "right over" a dot for that hover.
 *  The hovered dot draws 3.75 px plus a 1.75 px ring, so 5 px is the dot
 *  itself - nothing around it pulls. Divided by `zoom` at the call site. */
export const PORT_DWELL_PX = 5;

/** Effective capture radius for one shape: the caller's radius, narrowed so
 *  it never eats more than `PORT_CAPTURE_SHAPE_FRACTION` of the shape's
 *  shorter side, and never drops below `minDist`. All world units. */
export function portCaptureDistFor(
  shape: Pick<Shape, 'w' | 'h'>,
  captureDist: number,
  minDist: number,
): number {
  const shortSide = Math.min(Math.abs(shape.w), Math.abs(shape.h));
  if (!(shortSide > 0)) return captureDist;
  const scaled = shortSide * PORT_CAPTURE_SHAPE_FRACTION;
  return Math.max(Math.min(captureDist, scaled), Math.min(captureDist, minDist));
}

export type PortCapture = {
  shape: Shape;
  anchor: Anchor;
  x: number;
  y: number;
  /** World-space cursor→anchor distance, so callers can apply hysteresis. */
  dist: number;
};

/** Nearest anchor on ANY nearby shape, or null when nothing is close enough.
 *  All distances are world units - callers divide their screen-px constants
 *  by `zoom` first, the same convention the rest of the snap stack uses.
 *
 *  Groups are skipped: they never render their own bbox dots (the anchor
 *  overlay filters them out and cascades to their children instead), so
 *  capturing onto an invisible port would be unexplainable. Containers DO
 *  render dots and stay eligible. Freehand has no anchors at all.
 *
 *  `filter` narrows the candidate set - used to keep the port-click gesture
 *  on already-selected shapes, and to keep an endpoint drag from capturing
 *  the shape its opposite end is bound to. */
export function capturePortNear(
  cursor: { x: number; y: number },
  shapes: readonly Shape[],
  opts: {
    captureDist: number;
    /** World-units floor for the per-shape clamp (see `portCaptureDistFor`).
     *  Omit to disable the clamp entirely and use `captureDist` flat - the
     *  connector-drag paths want the full radius on every shape, since
     *  there's no competing "grab the body" gesture mid-drag. */
    minCaptureDist?: number;
    tieSlack?: number;
    globalDefault?: number;
    wantsExtra: (shape: Shape) => boolean;
    filter?: (shape: Shape) => boolean;
  },
): PortCapture | null {
  const { captureDist, minCaptureDist, wantsExtra, filter } = opts;
  const tieSlack = opts.tieSlack ?? 0;
  const globalDefault = opts.globalDefault ?? SMART_ANCHOR_DEFAULT_COUNT;
  if (!(captureDist > 0)) return null;

  const hits: PortCapture[] = [];
  for (const s of shapes) {
    if (s.kind === 'freehand' || s.kind === 'group') continue;
    if (filter && !filter(s)) continue;
    // Per-shape radius - the flat one, narrowed on small shapes so their
    // ports don't swallow the body (see portCaptureDistFor).
    const dist =
      minCaptureDist === undefined
        ? captureDist
        : portCaptureDistFor(s, captureDist, minCaptureDist);
    // AABB-band prefilter before the (much costlier) anchor projection -
    // anchors never sit outside the bbox, so this is a safe superset.
    if (!pointNearShape(cursor, s, dist)) continue;
    const near = nearestSmartAnchor(
      s,
      cursor,
      wantsExtra(s),
      globalDefault,
      dist,
    );
    if (!near) continue;
    hits.push({
      shape: s,
      anchor: near.anchor,
      x: near.x,
      y: near.y,
      dist: Math.hypot(near.x - cursor.x, near.y - cursor.y),
    });
  }
  if (hits.length === 0) return null;

  let best = hits[0];
  for (const h of hits) if (h.dist < best.dist) best = h;
  if (tieSlack <= 0) return best;
  const tied = hits.filter((h) => h.dist <= best.dist + tieSlack);
  // Fast path - the overwhelmingly common case is a single candidate, and
  // it skips building the parent map entirely.
  if (tied.length === 1) return tied[0];

  const byId = new Map(shapes.map((s) => [s.id, s]));
  const depthOf = (s: Shape): number => {
    let depth = 0;
    let cur: Shape | undefined = s;
    for (let i = 0; i < 16 && cur?.parent; i++) {
      cur = byId.get(cur.parent);
      if (!cur) break;
      depth++;
    }
    return depth;
  };
  let winner = tied[0];
  let winnerDepth = depthOf(winner.shape);
  for (const h of tied.slice(1)) {
    const depth = depthOf(h.shape);
    if (depth !== winnerDepth) {
      if (depth > winnerDepth) {
        winner = h;
        winnerDepth = depth;
      }
      continue;
    }
    const area = Math.abs(h.shape.w) * Math.abs(h.shape.h);
    const winnerArea = Math.abs(winner.shape.w) * Math.abs(winner.shape.h);
    if (area !== winnerArea) {
      if (area < winnerArea) winner = h;
      continue;
    }
    if ((h.shape.z ?? 0) > (winner.shape.z ?? 0)) winner = h;
  }
  return winner;
}
