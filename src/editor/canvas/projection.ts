/* Screen ↔ world projection + hit-test helpers.
 *
 * The canvas renders shapes/connectors inside a transform group:
 *    <g transform="translate(panX panY) scale(zoom)">…world content…</g>
 *
 * Pointer events arrive in CLIENT coordinates. We translate them through the
 * SVG element's bounding rect to get pixel-relative coords, then unproject to
 * world coords with the inverse transform. Keep both sides pure - Canvas owns
 * pan/zoom and just hands them in.
 */

import type { Connector, LabelAnchor, Shape } from '@/store/types';
import { expandAllDescendants, shapeIndex } from '@/store/hierarchy';

export type Pt = { x: number; y: number };
export type ViewportTransform = { pan: Pt; zoom: number };

export function clientToScreen(
  e: { clientX: number; clientY: number },
  rect: DOMRect,
): Pt {
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function screenToWorld(p: Pt, t: ViewportTransform): Pt {
  return { x: (p.x - t.pan.x) / t.zoom, y: (p.y - t.pan.y) / t.zoom };
}

export function worldToScreen(p: Pt, t: ViewportTransform): Pt {
  return { x: p.x * t.zoom + t.pan.x, y: p.y * t.zoom + t.pan.y };
}

/** Quantize the angle of the vector `from → to` to the nearest multiple of
 *  `stepDeg`, preserving its length. Used by the line/arrow tools when the
 *  user holds cmd/ctrl: the cursor's distance from the start is kept, but the
 *  bearing is locked onto a 5°/15°/45° grid so axis-aligned and isometric
 *  lines come out exactly straight. Returns `to` unchanged if the vector has
 *  zero length (would otherwise produce NaN from atan2). */
export function snapPointToAngle(from: Pt, to: Pt, stepDeg: number): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return to;
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: from.x + dist * Math.cos(snapped),
    y: from.y + dist * Math.sin(snapped),
  };
}

/** Axis-aligned bounding-box for a shape. Notes/diamonds/ellipses all share
 *  the same x/y/w/h envelope - selection / marquee hit-test uses the AABB. */
export function shapeAABB(s: Shape): { x: number; y: number; w: number; h: number } {
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

/* ── Rotation ──────────────────────────────────────────────────────────────
 *
 * A shape's bbox (x/y/w/h) is stored AXIS-ALIGNED and `rotation` is applied
 * purely at render time as `rotate(deg cx cy)` about the bbox centre (see
 * Shape.tsx). Every pointer hit-test therefore has to happen in the shape's
 * LOCAL frame: un-rotate the world cursor about the same centre by the same
 * angle, then run the plain AABB math. Rotation is an isometry, so a test
 * done this way is exactly the test against the visible rotated box - the
 * "mouseover area" tracks the shape the user sees instead of staying stuck
 * on the un-rotated bbox.
 *
 * All the helpers below funnel through `rotatePoint` / `toShapeLocal` so the
 * sign convention (clockwise-positive, matching SVG) can never drift between
 * the renderer, the routing code and the hit-tests. */

/** Rotate `p` around `c` by `deg` degrees (clockwise positive - the same
 *  convention SVG's `rotate(deg cx cy)` uses). Identity for `deg === 0`. */
export function rotatePoint(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Single source of truth for "can this kind be rotated?", shared by the
 *  renderer (Shape.tsx wraps the body in `rotate(deg cx cy)`), the selection
 *  chrome (rotate handle, hover ring, measurement badge) and hit-testing.
 *  It used to be spelled out inline in six places, which is how freehand
 *  ended up rotatable in some of them and not others.
 *
 *  Only GROUPS opt out: a group is an invisible hit box whose members are
 *  independent shapes, so rotating the frame's <g> leaves the children
 *  behind and a half-rotated group is worse than none. Freehand DOES rotate
 * - its path is inside the same <g> as every other body, so the
 *  transform carries it for free. */
export function shapeSupportsRotation(s: { kind: Shape['kind'] }): boolean {
  return s.kind !== 'group';
}

/** The rotation (degrees) a shape is actually RENDERED with. Any stray
 *  `rotation` on a kind that doesn't rotate must be ignored by hit-testing
 *  too - otherwise the pointer would test against a tilt the user can't
 *  see. Non-finite → 0. */
export function shapeRotation(s: Shape): number {
  if (!shapeSupportsRotation(s)) return 0;
  const r = s.rotation ?? 0;
  return Number.isFinite(r) ? r : 0;
}

/** Single source of truth for "can this kind's body be mirrored?", shared
 *  by the renderer and by `flipSelection`.
 *
 *  Three kinds opt out:
 *    - TABLE, because its cell text is painted inside the body - a mirror
 *      would write every cell backwards.
 *    - GROUP, for the same reason it can't rotate: the frame is an
 *      invisible hit box and its members are independent shapes.
 *    - FREEHAND, because a stroke's whole shape IS its `points`. It mirrors
 *      by rewriting them (`mirrorFreehandPoints`), so honouring a flag as
 *      well would apply the flip twice. */
export function shapeSupportsMirror(s: { kind: Shape['kind'] }): boolean {
  return s.kind !== 'rack' && s.kind !== 'table' && s.kind !== 'group' && s.kind !== 'freehand';
}

/** The mirror a shape is actually RENDERED with - the `shapeRotation` rule
 *  applied to `flipH`/`flipV`, so a stray flag on a kind that can't mirror
 *  is ignored everywhere at once instead of in the renderer alone. */
export function shapeMirror(s: {
  kind: Shape['kind'];
  flipH?: boolean;
  flipV?: boolean;
}): { h: boolean; v: boolean } {
  if (!shapeSupportsMirror(s)) return { h: false, v: false };
  return { h: s.flipH === true, v: s.flipV === true };
}

/** Reflect a point in the unrotated shape frame, matching the body's SVG
 *  mirror. This is its own inverse: use it both before rotating an anchor
 *  into world space and after unrotating a cursor into the original body. */
export function mirrorShapePoint(p: Pt, s: Shape): Pt {
  const { h, v } = shapeMirror(s);
  if (!h && !v) return p;
  return {
    x: h ? 2 * s.x + s.w - p.x : p.x,
    y: v ? 2 * s.y + s.h - p.y : p.y,
  };
}

/** SVG transform that mirrors a shape's body about its own centre, or
 *  `undefined` when it isn't mirrored. The bbox stays unchanged, but points
 *  on the body must follow the mirror too (see `mirrorShapePoint`). */
export function mirrorTransform(
  s: {
    kind: Shape['kind'];
    x: number;
    y: number;
    w: number;
    h: number;
    flipH?: boolean;
    flipV?: boolean;
  },
): string | undefined {
  const { h, v } = shapeMirror(s);
  if (!h && !v) return undefined;
  const tx = h ? 2 * (s.x + s.w / 2) : 0;
  const ty = v ? 2 * (s.y + s.h / 2) : 0;
  return `translate(${tx} ${ty}) scale(${h ? -1 : 1} ${v ? -1 : 1})`;
}

/* ── Freehand paths ─────────────────────────────────────────────────
 *
 * A pen stroke keeps its whole path in `points`, stored relative to the
 * shape ORIGIN (x, y); `w`/`h` are just the envelope the pen swept. Nothing
 * re-derives the path from the box, so every transform that moves a box has
 * to carry the points itself - which is exactly what resize and flip
 * forgot to do: the selection frame stretched and the stroke sat there at
 * the size it was drawn. */

/** Scale a stroke's points by the same factors the bbox was scaled by.
 *  `startPoints`/`startGeom` are the gesture-start snapshot, so a drag
 *  composes from the original path every frame instead of compounding the
 *  previous frame's rounding.
 *
 *  Negative extents pass straight through: dragging a handle past the
 *  opposite edge gives a negative factor, which mirrors the stroke on the
 *  same frame the box flips. A zero START extent scales that axis by 1 -
 * a dead-straight stroke has no width to stretch, and dividing by it would
 *  hand back NaN. */
export function scaleFreehandPoints(
  startPoints: readonly Pt[],
  startGeom: { w: number; h: number },
  next: { w: number; h: number },
): Pt[] {
  const sx = startGeom.w === 0 ? 1 : next.w / startGeom.w;
  const sy = startGeom.h === 0 ? 1 : next.h / startGeom.h;
  return startPoints.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

/** Re-base points after the ORIGIN moves without the stroke moving - i.e.
 *  when `normalizeRect` folds a mid-drag negative w/h back into a positive
 *  box. Points are origin-relative, so they have to absorb the inverse
 *  delta or the stroke jumps by the width of its own bbox on release. */
export function rebaseFreehandPoints(
  points: readonly Pt[],
  from: Pt,
  to: Pt,
): Pt[] {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  if (dx === 0 && dy === 0) return points as Pt[];
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Mirror a stroke inside its own (unchanged) bbox. `flipSelection` mirrors
 *  every member's POSITION about the selection centre, which is a no-op for
 *  a lone shape and never touches geometry - fine for a rect, useless for
 *  a stroke, whose shape is the only thing there is to mirror. */
export function mirrorFreehandPoints(
  points: readonly Pt[],
  box: { w: number; h: number },
  axis: 'horizontal' | 'vertical',
): Pt[] {
  return axis === 'horizontal'
    ? points.map((p) => ({ x: box.w - p.x, y: p.y }))
    : points.map((p) => ({ x: p.x, y: box.h - p.y }));
}

/** Centre of the shape's bbox - the pivot every rotation transform uses. */
export function shapeCenter(s: Shape): Pt {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/** Un-rotate a world-space point into `s`'s local (axis-aligned) frame so it
 *  can be compared against the raw x/y/w/h bbox. Identity when the shape
 *  isn't rotated, so un-rotated shapes pay nothing. */
export function toShapeLocal(p: Pt, s: Shape): Pt {
  const rot = shapeRotation(s);
  return rot ? rotatePoint(p, shapeCenter(s), -rot) : p;
}

/** Local-space point → world space (the inverse of `toShapeLocal`). Used to
 *  hand back a position that was computed against the un-rotated bbox
 *  (an anchor dot, say) in the coordinates the cursor is in. */
export function fromShapeLocal(p: Pt, s: Shape): Pt {
  const rot = shapeRotation(s);
  return rot ? rotatePoint(p, shapeCenter(s), rot) : p;
}

/** Point inside a shape's bbox (world coords), honouring rotation - the
 *  point is un-rotated into the shape's local frame first, so the hit zone
 *  is the rotated box the user sees. For ellipse / diamond we accept the
 *  bbox as the hit zone; a perfect hit-test isn't worth its cost here. */
export function pointInShape(p: Pt, s: Shape): boolean {
  const q = toShapeLocal(p, s);
  if (s.kind === 'polygon' && s.polygonVertices?.length) {
    const mirror = shapeMirror(s);
    const px = mirror.h ? 2*s.x+s.w-q.x : q.x;
    const py = mirror.v ? 2*s.y+s.h-q.y : q.y;
    const vertices = s.polygonVertices;
    const tolerance = Math.max(1,(s.strokeWidth ?? 1.5)/2);
    let inside = false;
    for (let i=0,j=vertices.length-1;i<vertices.length;j=i++) {
      const ax = s.x+vertices[j].x*s.w, ay = s.y+vertices[j].y*s.h;
      const bx = s.x+vertices[i].x*s.w, by = s.y+vertices[i].y*s.h;
      const dx = bx-ax, dy = by-ay;
      const t = Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy || 1)));
      if ((px-ax-t*dx)**2+(py-ay-t*dy)**2 <= tolerance*tolerance) return true;
      if ((ay > py) !== (by > py) && px < (bx-ax)*(py-ay)/(by-ay)+ax) inside = !inside;
    }
    return inside;
  }
  return q.x >= s.x && q.x <= s.x + s.w && q.y >= s.y && q.y <= s.y + s.h;
}

/** True when `p` lies within `band` world units of `s`'s (rotated) bbox -
 * either inside it (distance 0) or up to `band` units outside any edge.
 *  Same local-frame convention as `pointInShape` so approach detection stays
 *  consistent with the rest of the snap stack. */
export function pointNearShape(p: Pt, s: Shape, band: number): boolean {
  const q = toShapeLocal(p, s);
  const dx = Math.max(s.x - q.x, 0, q.x - (s.x + s.w));
  const dy = Math.max(s.y - q.y, 0, q.y - (s.y + s.h));
  return dx * dx + dy * dy <= band * band;
}

/** Width of the edge-snap band, in world units. Used by the connector tools:
 *  a pointer-down inside the band counts as "drawing from the edge" and
 *  binds the from-side to the shape; a click deeper inside (in the
 *  interior, beyond the band) draws an orphaned line over the shape with
 *  no source snap.
 *
 *  Sized to 14 world units - comfortable to hit at default zoom (≈ a fat
 *  finger on a tooled handle) but doesn't swallow the interior of
 *  small shapes. The interior fallback (`pointInShapeInterior`) clamps
 *  the band so it never collapses an inset rectangle into a negative
 *  size - small shapes effectively ARE all edge, and there's no
 *  "interior" to draw an orphaned line over. */
export const EDGE_SNAP_BAND = 14;

/** True when `p` lies within `band` units of any edge of `s` and inside
 *  the (rotated) bbox. Used for from-side snap on connector tools so the
 *  user has to grab the shape's outline to bind, not just any pixel inside. */
export function pointInShapeEdgeBand(p: Pt, s: Shape, band: number): boolean {
  if (!pointInShape(p, s)) return false;
  // Min width / height - shapes smaller than 2*band on either axis are
  // entirely "edge" by definition; pretend the interior is empty so the
  // user can still bind to a small shape by clicking anywhere inside it.
  if (s.w < band * 2 || s.h < band * 2) return true;
  const q = toShapeLocal(p, s);
  return (
    q.x - s.x <= band ||
    s.x + s.w - q.x <= band ||
    q.y - s.y <= band ||
    s.y + s.h - q.y <= band
  );
}

/** Distance-based "near centre" test for the fightable target-snap. The
 *  user can drag into the shape's middle to bind the connector's
 *  destination at the centre anchor `[0.5, 0.5]` instead of the auto
 *  perimeter anchor.
 *
 *  The centre zone is sized AS A FRACTION OF THE SHAPE'S DIMENSIONS - a
 *  small target around the geometric centre, not "everything that isn't
 *  edge". A previous implementation shrank the AABB by `EDGE_SNAP_BAND` on
 *  every side, which made the centre zone swallow nearly the body
 *  of any reasonably-sized shape and caused connectors drawn over a box to
 *  slam into the centre anchor whenever the cursor wandered inside.
 *  Sizing relative to the shape means tiny shapes get a tiny centre target
 *  (and large shapes a larger but still bounded one), so the user has to
 *  deliberately aim for the middle to invoke the centre snap.
 *
 *  - `CENTER_FRACTION` = half-extent as a fraction of each side. 0.18
 *    → centre target spans ~36% of the shape's width/height.
 *  - `CENTER_MIN` = floor in world units, so usable on shapes that are
 *    just barely big enough to have a centre zone at all.
 *  - `CENTER_MAX` = ceiling, so a 1000-wide container's centre zone stays
 *    a manageable target instead of growing without bound.
 *
 *  Returns false when the centre half-extent can't fit inside `band` of
 *  the shape's edge - those shapes are "all edge" and have no separate
 *  centre zone, matching `pointInShapeEdgeBand`'s small-shape rule. */
export function pointInShapeCenterZone(p: Pt, s: Shape, band: number): boolean {
  const CENTER_FRACTION = 0.18;
  const CENTER_MIN = 10;
  const CENTER_MAX = 40;
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  const halfW = Math.min(CENTER_MAX, Math.max(CENTER_MIN, w * CENTER_FRACTION));
  const halfH = Math.min(CENTER_MAX, Math.max(CENTER_MIN, h * CENTER_FRACTION));
  // Keep the centre zone strictly inside the edge band - otherwise a
  // pointer hovering near the perimeter of a small shape would qualify as
  // BOTH edge and centre and the ordering between them would matter.
  if (halfW > w / 2 - band || halfH > h / 2 - band) return false;
  const cx = s.x + w / 2;
  const cy = s.y + h / 2;
  // The centre zone is a bbox-aligned rectangle, so it rotates with the
  // shape - test in the local frame like every other bbox hit-test.
  const q = toShapeLocal(p, s);
  return Math.abs(q.x - cx) <= halfW && Math.abs(q.y - cy) <= halfH;
}

/** Marquee rect → set of shape ids whose AABB is *fully contained* in the rect.
 *  Partial overlap does NOT select.
 *
 *  Reason: Vellum targets dense, overlapping-container diagrams. Partial-overlap
 *  selection silently grabs parent containers and makes "marquee + delete"
 *  destructive in surprising ways. Fully-contained makes the marquee a precise
 *  tool - you have to enclose what you want. */
export function shapesInMarquee(
  rect: { x: number; y: number; w: number; h: number },
  shapes: Shape[],
): string[] {
  const x1 = Math.min(rect.x, rect.x + rect.w);
  const y1 = Math.min(rect.y, rect.y + rect.h);
  const x2 = Math.max(rect.x, rect.x + rect.w);
  const y2 = Math.max(rect.y, rect.y + rect.h);
  return shapes
    .filter((s) => {
      // Normalise the shape's AABB in case w/h are transiently negative
      // mid-resize.
      const sx1 = Math.min(s.x, s.x + s.w);
      const sy1 = Math.min(s.y, s.y + s.h);
      const sx2 = Math.max(s.x, s.x + s.w);
      const sy2 = Math.max(s.y, s.y + s.h);
      return sx1 >= x1 && sy1 >= y1 && sx2 <= x2 && sy2 <= y2;
    })
    .map((s) => s.id);
}

/** Marquee rect → set of connector ids that are fully captured.
 *
 *  A connector is "captured" only if every point it materially depends on is
 *  inside the rect:
 *   - For each endpoint:
 *     - bound endpoint  → the bound shape must itself be in `containedShapeIds`
 *       (i.e. the shape was fully contained - we ride along with it)
 *     - floating endpoint → the literal point must be inside the rect
 *   - Every user waypoint must be inside the rect
 *
 *  Rationale: this keeps "marquee + delete" predictable. If you fully enclose
 *  two shapes, the connector between them comes along. If you only enclose
 *  one end, the connector stays - you didn't ask for it. */
export function connectorsInMarquee(
  rect: { x: number; y: number; w: number; h: number },
  connectors: Connector[],
  containedShapeIds: ReadonlySet<string>,
): string[] {
  const x1 = Math.min(rect.x, rect.x + rect.w);
  const y1 = Math.min(rect.y, rect.y + rect.h);
  const x2 = Math.max(rect.x, rect.x + rect.w);
  const y2 = Math.max(rect.y, rect.y + rect.h);
  const ptInside = (p: { x: number; y: number }) =>
    p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
  const endpointInside = (
    ep: Connector['from'],
  ): boolean => {
    if ('shape' in ep) return containedShapeIds.has(ep.shape);
    return ptInside(ep);
  };
  return connectors
    .filter((c) => {
      if (!endpointInside(c.from)) return false;
      if (!endpointInside(c.to)) return false;
      if (c.waypoints) {
        for (const w of c.waypoints) {
          if (!ptInside(w)) return false;
        }
      }
      return true;
    })
    .map((c) => c.id);
}

/** Distance from point to a path's polyline approximation. v1 just checks AABB
 *  inflated by hit-radius - accurate enough for connector picking when paired
 *  with the fat-stroke hit target the connector renders. */
export function nearSegment(
  p: Pt,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  threshold: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - ax;
    const ddy = p.y - ay;
    return ddx * ddx + ddy * ddy <= threshold * threshold;
  }
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return ddx * ddx + ddy * ddy <= threshold * threshold;
}

/** Resize-handle hit zones: 4 corners + 4 edge midpoints. Edge handles let the
 *  user resize along a single axis (drag the right edge to widen, etc.). They
 *  pair naturally with corner handles - a corner moves both axes, an edge
 *  moves only one. */
export type Handle =
  | 'nw'
  | 'ne'
  | 'sw'
  | 'se'
  | 'n'
  | 's'
  | 'e'
  | 'w';
export const HANDLE_KINDS: Handle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];

export function handlePosition(s: Shape, h: Handle): Pt {
  switch (h) {
    case 'nw':
      return { x: s.x, y: s.y };
    case 'ne':
      return { x: s.x + s.w, y: s.y };
    case 'sw':
      return { x: s.x, y: s.y + s.h };
    case 'se':
      return { x: s.x + s.w, y: s.y + s.h };
    case 'n':
      return { x: s.x + s.w / 2, y: s.y };
    case 's':
      return { x: s.x + s.w / 2, y: s.y + s.h };
    case 'e':
      return { x: s.x + s.w, y: s.y + s.h / 2 };
    case 'w':
      return { x: s.x, y: s.y + s.h / 2 };
  }
}

/** True for the 4 edge midpoint handles. Used to suppress them when uniform-
 *  scale is forced (icons with locked aspect can't resize on a single axis). */
export function isEdgeHandle(h: Handle): boolean {
  return h === 'n' || h === 's' || h === 'e' || h === 'w';
}

/** Apply a corner- or edge-handle drag to a shape's geometry. The grabbed
 *  corner / edge moves with the cursor; the opposite side stays fixed.
 *  Negative w/h is allowed during drag and normalised on commit. */
export function applyHandleDrag(
  s: { x: number; y: number; w: number; h: number },
  h: Handle,
  worldDx: number,
  worldDy: number,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h: H } = s;
  if (h === 'nw') {
    x += worldDx;
    y += worldDy;
    w -= worldDx;
    H -= worldDy;
  } else if (h === 'ne') {
    y += worldDy;
    w += worldDx;
    H -= worldDy;
  } else if (h === 'sw') {
    x += worldDx;
    w -= worldDx;
    H += worldDy;
  } else if (h === 'se') {
    w += worldDx;
    H += worldDy;
  } else if (h === 'n') {
    y += worldDy;
    H -= worldDy;
  } else if (h === 's') {
    H += worldDy;
  } else if (h === 'e') {
    w += worldDx;
  } else if (h === 'w') {
    x += worldDx;
    w -= worldDx;
  }
  return { x, y, w, h: H };
}

/** `applyHandleDrag` plus the two resize modifiers:
 *    - `lockAspect` (⇧Shift): keep the start width:height ratio. For corners
 *      the axis the cursor pushed further drives the scale; for edges the
 *      dragged axis drives and the perpendicular axis is derived (and
 *      centred on the start centre line).
 *    - `fromCenter` (⌘/Ctrl): the side opposite the grabbed handle mirrors
 *      the drag instead of staying fixed - the shape grows/shrinks about its
 *      centre. For edge handles this means both edges of that axis move.
 *  Aspect is resolved first, then the anchor (corner / edge / centre) is
 *  re-derived so the right point stays put. Negative w/h is still allowed
 *  mid-drag and normalised on commit, same as `applyHandleDrag`. */
export function applyHandleDragConstrained(
  s: { x: number; y: number; w: number; h: number },
  handle: Handle,
  worldDx: number,
  worldDy: number,
  opts: { fromCenter?: boolean; lockAspect?: boolean } = {},
): { x: number; y: number; w: number; h: number } {
  const startW = s.w;
  const startH = s.h;
  const base = applyHandleDrag(s, handle, worldDx, worldDy);
  let w = base.w;
  let hh = base.h;
  let x = base.x;
  let y = base.y;

  const edge = isEdgeHandle(handle);
  const horiz = handle === 'e' || handle === 'w';

  // Aspect lock - derive the constrained axis from the master axis.
  if (opts.lockAspect && startW !== 0 && startH !== 0) {
    const aspect = startW / startH; // width per unit height
    let masterIsWidth: boolean;
    if (edge) {
      masterIsWidth = horiz; // dragged axis is master
    } else {
      // Corner: whichever axis moved more (relative to start) drives.
      masterIsWidth = Math.abs(w) / startW >= Math.abs(hh) / startH;
    }
    if (masterIsWidth) {
      hh = (Math.sign(hh) || 1) * (Math.abs(w) / aspect);
    } else {
      w = (Math.sign(w) || 1) * (Math.abs(hh) * aspect);
    }
  }

  const cx = s.x + startW / 2;
  const cy = s.y + startH / 2;

  // Horizontal anchor.
  if (opts.fromCenter) {
    w = startW + 2 * (w - startW);
    x = cx - w / 2;
  } else if (handle === 'ne' || handle === 'se' || handle === 'e') {
    x = s.x; // grabbed the right side → left edge stays put
  } else if (handle === 'nw' || handle === 'sw' || handle === 'w') {
    x = s.x + startW - w; // grabbed the left side → right edge stays put
  } else if (opts.lockAspect) {
    x = cx - w / 2; // n/s with aspect derived a width → centre it
  } else {
    x = s.x;
    w = startW; // n/s, no aspect → width untouched
  }

  // Vertical anchor.
  if (opts.fromCenter) {
    hh = startH + 2 * (hh - startH);
    y = cy - hh / 2;
  } else if (handle === 'sw' || handle === 'se' || handle === 's') {
    y = s.y; // grabbed the bottom → top edge stays put
  } else if (handle === 'nw' || handle === 'ne' || handle === 'n') {
    y = s.y + startH - hh; // grabbed the top → bottom edge stays put
  } else if (opts.lockAspect) {
    y = cy - hh / 2; // e/w with aspect derived a height → centre it
  } else {
    y = s.y;
    hh = startH; // e/w, no aspect → height untouched
  }

  return { x, y, w, h: hh };
}

/** Normalise a possibly-negative geometry to positive w/h with adjusted x/y. */
export function normalizeRect(g: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = g;
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { x, y, w, h };
}

/** Cursor for a corner or edge handle, accounting for negative-w/h flips. NW
 *  becomes NE if width has gone negative, etc. Edge handles only flip across
 *  their relevant axis. */
/** The 9 inside-grid anchor positions valid for a container's iconAnchor.
 *  Keeping the type narrow at the helper level catches outside-* / cardinal
 *  values that would otherwise silently fall through to the top-left
 *  fallback. The inspector picker only emits these. */
export type IconAnchorPosition =
  | 'top-left'
  | 'inside-top'
  | 'top-right'
  | 'inside-left'
  | 'center'
  | 'inside-right'
  | 'bottom-left'
  | 'inside-bottom'
  | 'bottom-right';

/** Padding between the container frame and its anchor icon. Matches
 *  Shape.tsx's PAD constant for the right-of-icon label slot - keep them
 *  numerically synced so a top-left icon doesn't sit in a different inset
 *  than the legacy default. */
export const CONTAINER_ICON_PAD = 12;

/** Compute world-space (x, y) for a container's anchor child given the
 *  container's bbox + the requested icon anchor + the child's own size.
 *  Honours the 12px CONTAINER_ICON_PAD inset on every side so the icon
 *  doesn't touch the frame border. Centred anchors don't get the inset
 *  applied to the secondary axis (e.g. 'top' centres horizontally, but
 *  pads from the top edge).
 *
 *  Used at:
 *    - container resize (translate the anchor child to maintain its slot)
 *    - inspector iconAnchor change (re-snap the child to the new slot)
 *    - container creation if `iconAnchor` is provided up front (currently
 *      undefined → legacy top-left). */
export function computeContainerIconPosition(
  container: { x: number; y: number; w: number; h: number },
  child: { w: number; h: number },
  anchor: LabelAnchor | undefined,
): { x: number; y: number } {
  const PAD = CONTAINER_ICON_PAD;
  const innerLeft = container.x + PAD;
  const innerTop = container.y + PAD;
  const innerRight = container.x + container.w - PAD - child.w;
  const innerBottom = container.y + container.h - PAD - child.h;
  const innerCenterX = container.x + (container.w - child.w) / 2;
  const innerCenterY = container.y + (container.h - child.h) / 2;
  // Map outside / cardinal anchors to top-left - they're meaningless for an
  // INSIDE-the-container icon and the user shouldn't be able to pick them
  // via the inspector either, but defensive fallback.
  switch (anchor) {
    case 'inside-top':
      return { x: innerCenterX, y: innerTop };
    case 'top-right':
      return { x: innerRight, y: innerTop };
    case 'inside-left':
      return { x: innerLeft, y: innerCenterY };
    case 'center':
      return { x: innerCenterX, y: innerCenterY };
    case 'inside-right':
      return { x: innerRight, y: innerCenterY };
    case 'bottom-left':
      return { x: innerLeft, y: innerBottom };
    case 'inside-bottom':
      return { x: innerCenterX, y: innerBottom };
    case 'bottom-right':
      return { x: innerRight, y: innerBottom };
    case 'top-left':
    default:
      return { x: innerLeft, y: innerTop };
  }
}

export function cursorForHandle(h: Handle, w: number, H: number): string {
  if (h === 'n' || h === 's') return 'ns-resize';
  if (h === 'e' || h === 'w') return 'ew-resize';
  const flipX = w < 0;
  const flipY = H < 0;
  let key: Handle = h;
  if (flipX) {
    if (key === 'nw') key = 'ne';
    else if (key === 'ne') key = 'nw';
    else if (key === 'sw') key = 'se';
    else key = 'sw';
  }
  if (flipY) {
    if (key === 'nw') key = 'sw';
    else if (key === 'sw') key = 'nw';
    else if (key === 'ne') key = 'se';
    else key = 'ne';
  }
  return key === 'nw' || key === 'se' ? 'nwse-resize' : 'nesw-resize';
}

/** Frame padding the store keeps between a `kind: 'group'` frame and the
 *  bounding box of its members. The store recalculates every group's box
 *  from its members on EVERY mutation, so a group's own x/y/w/h are
 *  derived, not stored - writing them directly is a no-op that the next
 *  recalculation undoes. `planBoxEdit` therefore drives a group's box by
 *  transforming its members, using this pad to land the recalculated frame
 *  exactly on the requested numbers. */
export const GROUP_FRAME_PAD = 12;

/** Smallest bbox a typed dimension can produce. Handle drags allow negative
 *  w/h mid-gesture (normalised on commit); a typed value has no "mid" - it
 *  commits immediately, so 0 / negative would leave an unclickable shape
 *  with no way back except undo. */
export const MIN_BOX_SIZE = 1;

export type BoxEdit = { x?: number; y?: number; w?: number; h?: number };

/** Plan a DIRECT bbox edit - the numeric `.x .y .w .h` fields in the
 *  inspector's ADVANCED section - as the shape patches an equivalent
 *  on-canvas drag would have produced.
 *
 *  Typing a number into a box is not the same operation as `updateShape(id,
 *  { w })`, because three kinds carry their geometry in their children:
 *
 *    - GROUP - the frame is derived from its members (see GROUP_FRAME_PAD).
 *      Members are translated AND scaled about the frame's inner box, so the
 *      store's recalculation lands back on exactly the requested numbers.
 *    - CONTAINER - the frame is user-sized, and matches the canvas gesture:
 *      moving it carries every descendant along; RESIZING it moves nothing
 *      except the anchor icon, and the box is clamped so it can never crop a
 *      member (same rule as the resize drag).
 *    - TEXT - w/h are derived from the rendered glyphs every mutation. A
 *      typed width means "wrap to this width" (`autoSize: false` + `w`, what
 *      the e/w edge drag writes) and a typed height means "at least this
 *      tall" (`minH`, what the n/s edge drag writes). Writing `h` directly
 *      would be reverted by the next auto-fit.
 *
 *  Icons whose licence locks their aspect ratio scale uniformly - one typed
 *  axis drives both, exactly as the corner handle does.
 *
 *  Pure: takes the shape list, returns patches. `translated` is the id set
 *  that moved rigidly, so the caller can carry connector waypoints along the
 *  same way a drag or a nudge does. */
export function planBoxEdit(
  target: Shape,
  edit: BoxEdit,
  shapes: readonly Shape[],
): {
  patches: { id: string; patch: Partial<Shape> }[];
  dx: number;
  dy: number;
  translated: Set<string>;
} {
  const nx = edit.x ?? target.x;
  const ny = edit.y ?? target.y;
  let nw = Math.max(MIN_BOX_SIZE, edit.w ?? target.w);
  let nh = Math.max(MIN_BOX_SIZE, edit.h ?? target.h);

  // Licence-locked aspect: whichever axis the user typed drives the other,
  // so the ratio survives a typed resize the same way it survives a drag.
  if (target.iconConstraints?.lockAspect && target.w > 0 && target.h > 0) {
    const scale =
      edit.w !== undefined ? nw / target.w : edit.h !== undefined ? nh / target.h : 1;
    nw = Math.max(MIN_BOX_SIZE, target.w * scale);
    nh = Math.max(MIN_BOX_SIZE, target.h * scale);
  }

  const dx = nx - target.x;
  const dy = ny - target.y;
  const resized = nw !== target.w || nh !== target.h;
  const patches: { id: string; patch: Partial<Shape> }[] = [];
  const translated = new Set<string>();

  if (dx === 0 && dy === 0 && !resized) {
    return { patches, dx: 0, dy: 0, translated };
  }

  const descendants = [...expandAllDescendants([target.id], shapes)].filter(
    (id) => id !== target.id,
  );

  if (target.kind === 'group' && descendants.length > 0) {
    // Members bbox - the same subset the store measures when it recalculates
    // the frame (direct children that aren't themselves frames). Nested
    // groups are transformed along with everything else but excluded here,
    // since their own boxes are derived too.
    const members = shapes.filter(
      (s) => s.parent === target.id && s.kind !== 'group',
    );
    const box = members.length > 0 ? members : shapes.filter((s) => descendants.includes(s.id));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of box) {
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + m.w);
      maxY = Math.max(maxY, m.y + m.h);
    }
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const sx = spanX > 0 ? Math.max(MIN_BOX_SIZE, nw - GROUP_FRAME_PAD * 2) / spanX : 1;
    const sy = spanY > 0 ? Math.max(MIN_BOX_SIZE, nh - GROUP_FRAME_PAD * 2) / spanY : 1;
    const byId = shapeIndex(shapes);
    for (const id of descendants) {
      const d = byId(id);
      if (!d) continue;
      const patch: Partial<Shape> = {
        x: nx + GROUP_FRAME_PAD + (d.x - minX) * sx,
        y: ny + GROUP_FRAME_PAD + (d.y - minY) * sy,
        w: d.w * sx,
        h: d.h * sy,
      };
      if (d.kind === 'freehand' && d.points) {
        patch.points = scaleFreehandPoints(d.points, d, {
          w: patch.w!,
          h: patch.h!,
        });
      }
      patches.push({ id, patch });
      if (!resized) translated.add(id);
    }
    // The frame patch is advisory - the store recalculates it from the
    // members we just moved - but writing it keeps the single render before
    // that recalculation from flashing the old box.
    patches.unshift({ id: target.id, patch: { x: nx, y: ny, w: nw, h: nh } });
    if (!resized) translated.add(target.id);
    return { patches, dx, dy, translated };
  }

  if (target.kind === 'container' && descendants.length > 0) {
    const byId = shapeIndex(shapes);
    // Translation carries every descendant; a resize moves none of them.
    for (const id of descendants) {
      const d = byId(id);
      if (!d || (dx === 0 && dy === 0)) continue;
      patches.push({ id, patch: { x: d.x + dx, y: d.y + dy } });
      translated.add(id);
    }
    let bx = nx, by = ny, bw = nw, bh = nh;
    if (resized) {
      // Same clamp as the resize drag: the frame can never crop a member.
      // Measured against the POST-translation positions so a combined
      // move + resize clamps against where the children actually land.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of descendants) {
        const d = byId(id);
        if (!d || id === target.anchorId) continue;
        minX = Math.min(minX, d.x + dx);
        minY = Math.min(minY, d.y + dy);
        maxX = Math.max(maxX, d.x + dx + d.w);
        maxY = Math.max(maxY, d.y + dy + d.h);
      }
      if (isFinite(minX)) {
        if (bx > minX) bx = minX;
        if (by > minY) by = minY;
        if (bx + bw < maxX) bw = maxX - bx;
        if (by + bh < maxY) bh = maxY - by;
      }
    }
    patches.unshift({ id: target.id, patch: { x: bx, y: by, w: bw, h: bh } });
    if (!resized) translated.add(target.id);
    // The anchor icon rides the frame's iconAnchor cell rather than being
    // translated twice - drop any translation patch we already queued for it.
    if (target.anchorId) {
      const anchor = byId(target.anchorId);
      if (anchor) {
        const pos = computeContainerIconPosition(
          { x: bx, y: by, w: bw, h: bh },
          { w: anchor.w, h: anchor.h },
          target.iconAnchor,
        );
        const existing = patches.findIndex((p) => p.id === target.anchorId);
        if (existing >= 0) patches[existing] = { id: target.anchorId, patch: pos };
        else patches.push({ id: target.anchorId, patch: pos });
      }
    }
    return { patches, dx, dy, translated };
  }

  if (target.kind === 'text') {
    // w/h are auto-fit outputs, so write the inputs the edge drags write.
    const patch: Partial<Shape> = { x: nx, y: ny };
    if (edit.w !== undefined && nw !== target.w) {
      patch.autoSize = false;
      patch.w = nw;
    }
    if (edit.h !== undefined && nh !== target.h) patch.minH = nh;
    patches.push({ id: target.id, patch });
    if (!resized) translated.add(target.id);
    return { patches, dx, dy, translated };
  }

  const patch: Partial<Shape> = { x: nx, y: ny, w: nw, h: nh };
  // Freehand's path is its geometry - a typed w/h has to stretch the stroke
  // for the same reason a corner drag does.
  if (target.kind === 'freehand' && target.points && resized) {
    patch.points = scaleFreehandPoints(target.points, target, { w: nw, h: nh });
  }
  patches.push({ id: target.id, patch });
  if (!resized) translated.add(target.id);
  // A plain shape's own descendants can only exist when it is a frame kind,
  // which the branches above already handled - nothing else to move.
  return { patches, dx, dy, translated };
}
