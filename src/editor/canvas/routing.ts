import { notationGeometry } from '@/editor/notation/geometry';
/* Connector routing - anchor resolution + path computation.
 *
 * RULE: connectors store no waypoints by default. Paths are computed every
 * frame from current shape positions. If the user manually bends a connector,
 * we DO store explicit waypoints and the renderer threads them.
 *
 * v1 routing: straight (direct), curved (cubic Bezier), orthogonal (elbow).
 *
 * Elbow routing notes - the contract enforced by `buildOrthogonalPolyline`:
 *   1. Each endpoint exits/enters along its anchor's edge normal (so the
 *      line meets the shape perpendicular to its edge).
 *   2. Segments are strictly axis-aligned (no diagonals).
 *   3. The line never re-enters its own source/target shape - when the two
 *      anchor directions are parallel, we extend past both endpoints before
 *      bending so the path always exits cleanly.
 *   4. The polyline is collapsed to remove collinear midpoints and zero-
 *      length segments before being handed to the renderer / hit-tester. */

import { routeOrthogonalSegments } from './orthogonal-edit';

import type {
  Anchor,
  Connector,
  ConnectorEndpoint,
  Shape,
} from '@/store/types';
import {
  getIconSilhouette,
  silhouettePixelIsBoundary,
  silhouetteRayHit,
} from './silhouette';
import { polygonShapeOutline, type Pt } from './presetPaths';
import {
  routeOrthogonal,
  routeOrthogonalThroughWaypoints,
  type CardinalDir,
  type ElbowEndpoint,
  type Rect,
} from './elbow';
// Rotation math is shared with the pointer hit-tests (projection.ts) so the
// sign convention - clockwise positive, matching SVG's `rotate(deg cx cy)` -
// can never drift between "where the connector lands" and "what the cursor
// is over".
import { fromShapeLocal, mirrorShapePoint, shapeMirror, shapeRotation, toShapeLocal } from './projection';

export type ResolvedAnchor = Exclude<Anchor, 'auto'>;

/** Coerce ANY value into a usable anchor. Every helper below assumes a
 *  well-formed one, but stored anchors don't all arrive via `parseDiagram`:
 *  a persisted workspace rehydrates without re-validation while the store
 *  version is unchanged, and embed props / the public API hand us whatever
 *  the host built. So a bound endpoint can turn up with `anchor` missing
 *  outright, holding a stale or hand-edited string, or carrying a NaN in
 *  its tuple.
 *
 *  Cardinals and finite `[fx, fy]` pairs pass through untouched; anything
 *  else resolves to the bbox centre. Centre rather than an arbitrary
 *  cardinal because it sits inside every outline - so the ray-cast branches
 *  in `unmirroredShapeAnchorPoint` all terminate on it - and because the
 *  line then visibly points AT the shape instead of confidently claiming an
 *  edge the file never specified. Matches the fallback the clipboard path
 *  already picks for an unresolvable anchor (`endpointToFloating`,
 *  store/editor.ts).
 *
 *  Render-time only: nothing here rewrites the stored connector, so a file
 *  that loads and saves keeps the anchor it came in with. */
export function resolvedAnchorOrCentre(anchor: unknown): ResolvedAnchor {
  if (
    anchor === 'top' ||
    anchor === 'right' ||
    anchor === 'bottom' ||
    anchor === 'left'
  ) {
    return anchor;
  }
  if (
    Array.isArray(anchor) &&
    anchor.length === 2 &&
    Number.isFinite(anchor[0]) &&
    Number.isFinite(anchor[1])
  ) {
    return [anchor[0], anchor[1]];
  }
  return [0.5, 0.5];
}

/** Cast a ray from the shape centre `(cx, cy)` toward bbox-point
 *  `(tx, ty)` and return the OUTERMOST crossing with the closed outline
 *  `loop` (the visible silhouette in that direction). Mirrors what the
 *  ellipse/diamond closed-form math and the icon silhouette ray-cast do,
 *  but for an arbitrary polygon / preset edge loop. Null when the ray
 *  misses (degenerate box) so the caller can fall back to the bbox. */
function rayOutlineHit(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  loop: Pt[],
): [number, number] | null {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return null;
  let bestT = -1;
  for (let i = 0; i < loop.length; i++) {
    const [ax, ay] = loop[i];
    const [bx, by] = loop[(i + 1) % loop.length];
    const ex = bx - ax;
    const ey = by - ay;
    // Solve  C + t·D = A + u·E  for t >= 0, u in [0, 1].
    const denom = dx * ey - dy * ex;
    if (denom === 0) continue; // parallel
    const t = ((ax - cx) * ey - (ay - cy) * ex) / denom;
    const u = ((ax - cx) * dy - (ay - cy) * dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1 && t > bestT) bestT = t;
  }
  if (bestT < 0) return null;
  return [cx + dx * bestT, cy + dy * bestT];
}

/** Classify an anchor as horizontal-axis (left/right) or vertical-axis
 *  (top/bottom) for routing decisions. Cardinal anchors are obvious;
 *  fractional anchors are classified by whichever component sits on the
 *  shape's edge (fx == 0 or 1 → horizontal; fy == 0 or 1 → vertical).
 *
 *  When the shape has been rotated, the *world-space* axis the anchor exits
 *  along has rotated with it. We snap the rotated exit direction back to the
 *  nearest cardinal axis so the curve / elbow router still has a clean
 *  horizontal-or-vertical answer to bias against. (45°-rotated shapes pick
 *  whichever axis comes out marginally larger after rotation; that's
 *  arbitrary but stable.) */
export function anchorAxis(
  a: ResolvedAnchor,
  rotation = 0,
): 'horizontal' | 'vertical' | 'unknown' {
  const dir = anchorOutDir(a, rotation);
  if (!dir) return 'unknown';
  return Math.abs(dir[0]) >= Math.abs(dir[1]) ? 'horizontal' : 'vertical';
}

/** Project an anchor onto the original outline, then mirror the resulting
 * point with the body. Fractions retain their identity across flips; only
 * their displayed positions change. Rotation is applied by the caller. */
export function shapeAnchorPoint(
  shape: Shape,
  anchor: ResolvedAnchor,
): [number, number] {
  const [x, y] = unmirroredShapeAnchorPoint(shape, anchor);
  const p = mirrorShapePoint({ x, y }, shape);
  return [p.x, p.y];
}

function unmirroredShapeAnchorPoint(
  shape: Shape,
  rawAnchor: ResolvedAnchor,
): [number, number] {
  // Total by construction - the declared `[number, number]` is a promise
  // this function has to keep at runtime, because `shapeAnchorPoint`
  // destructures whatever comes back. Three paths below would otherwise
  // hand back `undefined` for an anchor outside the union: the notation
  // fraction lookup, the `cardinal[...]` translation for non-rect geometry
  // (which then recurses on the undefined until the stack blows), and the
  // closing cardinal switch, which has no default and simply falls off the
  // end. Any of the three took the canvas down with a TypeError.
  const anchor = resolvedAnchorOrCentre(rawAnchor);
  const { x, y, w, h } = shape;
  if (shape.notation) {
    const fraction = Array.isArray(anchor) ? anchor : ({top:[.5,0],right:[1,.5],bottom:[.5,1],left:[0,.5]} as const)[anchor];
    if (shape.notation.type === 'uml-lifeline' && fraction[1]*h >= Math.min(50,h*.3)) return [x+w/2,y+fraction[1]*h];
    return rayOutlineHit(x+w/2,y+h/2,x+fraction[0]*w,y+fraction[1]*h,notationGeometry(shape).outline) ?? [x+fraction[0]*w,y+fraction[1]*h];
  }
  // A framed icon IS its frame for connector geometry - the line meets the
  // circle/square outline, not the icon's rasterized silhouette. circle →
  // ellipse math; square → plain bbox (identical to a rect). Bare icons
  // (no frame) keep the silhouette path below.
  const geomKind: Shape['kind'] =
    shape.kind === 'icon' && shape.frame === 'circle'
      ? 'ellipse'
      : shape.kind === 'icon' && shape.frame === 'square'
        ? 'rect'
        : shape.kind;
  if (Array.isArray(anchor)) {
    // Fractional anchors are computed against the actual shape outline so
    // ellipses and diamonds anchor on their curve, not on the bbox.
    const fx = anchor[0];
    const fy = anchor[1];
    if (geomKind === 'icon') {
      // Icons aren't rectangular - push the anchor onto the rasterized
      // silhouette so connectors meet the visible glyph, not the bbox edge.
      // While the silhouette is still building (first paint after drop) we
      // fall through to the bbox and re-route on the subscriber notify.
      const sil = getIconSilhouette(shape.iconAttribution?.iconId);
      if (sil) {
        // If the caller already supplied a fraction that resolves to a
        // silhouette boundary pixel (smart-anchor outline walks, autoAnchor
        // ray-cast results), don't re-cast - return it as-is. Otherwise
        // multiple inputs that sit ON the silhouette would collapse to the
        // same radially-outermost ray hit, which is what made smart-anchor
        // dots in concave coves "jump" to wing-tip-like features on commit.
        if (silhouettePixelIsBoundary(sil, fx, fy)) {
          return [x + fx * w, y + fy * h];
        }
        const hit = silhouetteRayHit(sil, fx, fy);
        if (hit) return [x + hit.fx * w, y + hit.fy * h];
      }
    }
    if (geomKind === 'ellipse') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      // Direction from centre to bbox-position.
      const tx = x + fx * w;
      const ty = y + fy * h;
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx === 0 && dy === 0) return [cx, cy];
      // Scale onto the ellipse: solve t such that (dx*t/rx)^2 + (dy*t/ry)^2 = 1.
      const k = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
      if (k === 0) return [cx, cy];
      return [cx + dx / k, cy + dy / k];
    }
    if (geomKind === 'diamond') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const tx = x + fx * w;
      const ty = y + fy * h;
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx === 0 && dy === 0) return [cx, cy];
      // Diamond outline: |dx|/(w/2) + |dy|/(h/2) = 1.
      const k = Math.abs(dx) / (w / 2) + Math.abs(dy) / (h / 2);
      if (k === 0) return [cx, cy];
      return [cx + dx / k, cy + dy / k];
    }
    if (geomKind === 'polygon') {
      // Project the bbox-fraction onto the actual edge loop (n-gon / star
      // vertices or the cloud / callout / semicircle outline) by ray-
      // casting from the centre - same idea as the diamond closed form,
      // generalised. Without this the smart-anchor dots (and connector
      // ends) sit on the bbox, floating off the visible shape.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const hit = rayOutlineHit(
        cx,
        cy,
        x + fx * w,
        y + fy * h,
        polygonShapeOutline(x, y, w, h, {
          vertices: shape.polygonVertices,
          preset: shape.polygonPreset,
          callout: shape.callout,
          sides: shape.sides,
          star: shape.polygonStar,
        }),
      );
      return hit ?? [x + fx * w, y + fy * h];
    }
    return [x + fx * w, y + fy * h];
  }
  // Cardinal anchors on non-rect shapes also need outline coercion. The
  // simplest path is to translate to a fractional anchor and reuse the
  // outline math above.
  const cardinal: Record<Exclude<ResolvedAnchor & string, never>, [number, number]> = {
    top: [0.5, 0],
    right: [1, 0.5],
    bottom: [0.5, 1],
    left: [0, 0.5],
  };
  if (
    geomKind === 'ellipse' ||
    geomKind === 'diamond' ||
    geomKind === 'polygon' ||
    geomKind === 'icon'
  ) {
    return unmirroredShapeAnchorPoint(shape, cardinal[anchor as 'top']);
  }
  switch (anchor) {
    case 'top':
      return [x + w / 2, y];
    case 'right':
      return [x + w, y + h / 2];
    case 'bottom':
      return [x + w / 2, y + h];
    case 'left':
      return [x, y + h / 2];
  }
}

/** `shapeAnchorPoint` lifted into WORLD space: the local anchor position
 *  rotated about the bbox centre by the shape's (visual) rotation. This is
 *  where the anchor dot is drawn and where a bound connector actually meets
 *  the shape, so it's the point to compare a world-space cursor against.
 *  Same rotation step `resolveEndpointPoint` applies to bound endpoints -
 * kept as a standalone helper for the callers (port hover / capture /
 *  latch) that have a shape in hand and no connector. Goes through
 *  `fromShapeLocal` so it uses exactly the frame the pointer hit-tests and
 *  `nearestSmartAnchor` use. */
export function shapeAnchorWorldPoint(
  shape: Shape,
  anchor: ResolvedAnchor,
): [number, number] {
  const [lx, ly] = shapeAnchorPoint(shape, anchor);
  const world = fromShapeLocal({ x: lx, y: ly }, shape);
  return [world.x, world.y];
}

/** Auto-anchor: where on the shape's edge should this connector attach so the
 *  line points at the other endpoint. Returns a fractional anchor `[fx, fy]`
 *  computed by intersecting the centre→target ray with the shape's bounding
 *  box - the result is a continuous point on the edge rather than a snap to
 *  one of four cardinals.
 *
 *  Library shapes that declare anchor points should clamp `auto` to the
 *  declared set - v2 refinement.
 */
export function autoAnchor(
  from: Shape,
  toCenter: { x: number; y: number },
): ResolvedAnchor {
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  // Cast against the original body: undo rotation, then its mirror. The
  // returned fraction is stored in that original frame; shapeAnchorPoint
  // reapplies the mirror when resolving it onto the displayed outline.
  const local = mirrorShapePoint(toShapeLocal(toCenter, from), from);
  const dx = local.x - fcx;
  const dy = local.y - fcy;
  if (dx === 0 && dy === 0) return 'right';

  // Icons: ray-cast through the rasterized silhouette so the auto anchor
  // lands on the visible glyph rather than the bbox edge. Project the target
  // direction onto a unit-square target point on the bbox edge first, then
  // hand that fractional coord to the silhouette walker - same shape of
  // input shapeAnchorPoint takes.
  // Framed icons skip the silhouette ray-cast: their auto anchor is the
  // bbox-edge intersection below, which `shapeAnchorPoint` then coerces
  // onto the circle (square needs no coercion). Same flow actual ellipses
  // use - autoAnchor returns a bbox fraction, the curve math is in
  // shapeAnchorPoint.
  const fromFramed = from.kind === 'icon' && from.frame !== undefined;
  if (from.kind === 'icon' && !fromFramed) {
    const sil = getIconSilhouette(from.iconAttribution?.iconId);
    if (sil) {
      // Project the ray onto the bbox edge to get an [0..1] target coord.
      const hxBbox = from.w / 2;
      const hyBbox = from.h / 2;
      const txT = dx === 0 ? Infinity : (dx > 0 ? hxBbox : -hxBbox) / dx;
      const tyT = dy === 0 ? Infinity : (dy > 0 ? hyBbox : -hyBbox) / dy;
      const tEdge = Math.min(txT, tyT);
      const fxTarget = (dx * tEdge + hxBbox) / from.w;
      const fyTarget = (dy * tEdge + hyBbox) / from.h;
      const hit = silhouetteRayHit(sil, fxTarget, fyTarget);
      if (hit) {
        return [
          Math.max(0, Math.min(1, hit.fx)),
          Math.max(0, Math.min(1, hit.fy)),
        ] as ResolvedAnchor;
      }
    }
    // Silhouette not ready (or no hit) - fall through to bbox math below.
  }

  // Half-extents from the shape's centre. We intersect the ray from the
  // centre out toward `toCenter` with the bounding box's four edges and pick
  // the smallest positive `t` - that's where the line exits the shape.
  const hx = from.w / 2;
  const hy = from.h / 2;

  // Ray: (fcx, fcy) + t * (dx, dy). Find smallest t > 0 such that the point
  // lies on the box boundary.
  const tx = dx === 0 ? Infinity : (dx > 0 ? hx : -hx) / dx;
  const ty = dy === 0 ? Infinity : (dy > 0 ? hy : -hy) / dy;
  const t = Math.min(tx, ty);

  // Hit point relative to centre.
  const hitX = dx * t;
  const hitY = dy * t;

  // Convert to fractional [0..1, 0..1] anchor coords.
  const fx = (hitX + hx) / from.w;
  const fy = (hitY + hy) / from.h;
  // Clamp to [0..1] - guards against floating-point overshoot on perfectly
  // axis-aligned rays.
  const cfx = Math.max(0, Math.min(1, fx));
  const cfy = Math.max(0, Math.min(1, fy));
  return [cfx, cfy] as ResolvedAnchor;
}

/** Snap to the nearest of the 8 standard outer-edge anchors: 4 cardinals
 *  (top/right/bottom/left) + 4 corners (NW/NE/SW/SE as fractional tuples).
 *  Used by the click-commit connector flow so that drops on a shape without
 *  smart anchors land on a discrete, predictable anchor rather than a
 *  continuous perimeter point.
 *
 *  Rotation-aware: we un-rotate the cursor into the shape's local frame, do
 *  the nearest-neighbour search in local coords against shapeAnchorPoint's
 *  output (which is also local), and return the unrotated anchor descriptor.
 *  Callers convert back to world via the usual resolveEndpointPoint pipeline. */
export function nearest8Anchor(
  shape: Shape,
  cursor: { x: number; y: number },
): ResolvedAnchor {
  const local = toShapeLocal(cursor, shape);
  const candidates: ResolvedAnchor[] = [
    'top',
    'right',
    'bottom',
    'left',
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
  let best: ResolvedAnchor = 'top';
  let bestD2 = Infinity;
  for (const a of candidates) {
    const [px, py] = shapeAnchorPoint(shape, a);
    const dx = local.x - px;
    const dy = local.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = a;
    }
  }
  return best;
}

/** The router needs the outward direction AFTER mirroring, while saved
 * connector anchors continue to refer to the original shape frame. */
function mirroredAnchor(shape: Shape, anchor: ResolvedAnchor): ResolvedAnchor {
  const { h, v } = shapeMirror(shape);
  if (Array.isArray(anchor)) {
    return h || v ? [h ? 1 - anchor[0] : anchor[0], v ? 1 - anchor[1] : anchor[1]] : anchor;
  }
  if (h && anchor === 'left') return 'right';
  if (h && anchor === 'right') return 'left';
  if (v && anchor === 'top') return 'bottom';
  if (v && anchor === 'bottom') return 'top';
  return anchor;
}

/** Resolve the displayed endpoint after mirror and rotation. The returned
 * anchor describes the mirrored exit side for routing, not a new stored
 * attachment. The opposite endpoint supplies the target for auto anchors. */
export function resolveEndpointPoint(
  ep: ConnectorEndpoint,
  other: ConnectorEndpoint,
  shapes: Shape[],
): {
  x: number;
  y: number;
  anchor: ResolvedAnchor | null;
  rotation: number;
} | null {
  if ('shape' in ep) {
    const sh = shapes.find((s) => s.id === ep.shape);
    if (!sh) return null;
    // A bound endpoint carrying no anchor at all means here what it means
    // at the parse boundary (schema.ts defaults it to `'auto'`): use the
    // edge facing the other end. Values that are present but unrecognised
    // fall through to `resolvedAnchorOrCentre`.
    let anchor: Anchor = ep.anchor ?? 'auto';
    if (anchor === 'auto') {
      const otherCenter = endpointCenter(other, shapes);
      // autoAnchor is rotation-aware internally - pass world-space center.
      if (!otherCenter) anchor = 'right';
      else anchor = autoAnchor(sh, otherCenter);
    }
    // Coerce rather than cast: the stored value may be none of the things
    // the type claims, and `mirroredAnchor` / `anchorOutDir` downstream both
    // assume it is one of them.
    const resolved = resolvedAnchorOrCentre(anchor);
    const [lx, ly] = shapeAnchorPoint(sh, resolved);
    const world = fromShapeLocal({ x: lx, y: ly }, sh);
    return { x: world.x, y: world.y, anchor: mirroredAnchor(sh, resolved), rotation: shapeRotation(sh) };
  }
  return { x: ep.x, y: ep.y, anchor: null, rotation: 0 };
}

function endpointCenter(
  ep: ConnectorEndpoint,
  shapes: Shape[],
): { x: number; y: number } | null {
  if ('shape' in ep) {
    const sh = shapes.find((s) => s.id === ep.shape);
    if (!sh) return null;
    return { x: sh.x + sh.w / 2, y: sh.y + sh.h / 2 };
  }
  return { x: ep.x, y: ep.y };
}

/** Resolve both endpoints of a connector, returning their world coords + the
 *  resolved anchors (null for floating endpoints).
 *
 *  Note on elbow stability: we DO NOT snap the endpoint POINT to the cardinal
 *  edge midpoint here, even for orthogonal routing. The elbow router
 *  (`buildOrthogonalPolyline`) already uses `anchorOutDir` to derive a
 *  cardinal exit direction from a fractional anchor - that's enough to keep
 *  the bend topology stable. Snapping the POINT additionally would cause the
 *  visible endpoint to JUMP to the edge midpoint every time the cursor
 *  crosses a 45° boundary while dragging a connected shape; the line would
 *  visibly "tick" between two positions on the shape edge. Keeping the
 *  fractional point lets the line slide smoothly along the edge while the
 *  elbow direction stays cardinal-stable. */
export function resolveConnectorPath(
  conn: Connector,
  shapes: Shape[],
  fromSetback = 0,
  toSetback = 0,
): {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  fromAnchor: ResolvedAnchor | null;
  toAnchor: ResolvedAnchor | null;
  /** Rotation (degrees) of the shape each endpoint is bound to, or 0 for
   *  floating endpoints. The router uses these to rotate anchor exit
   *  directions back into world space. */
  fromRot: number;
  toRot: number;
  /** Bounding rectangle of the source/target shape, when the endpoint is
   *  attached to one. Null for floating endpoints. The orthogonal router
   *  uses these to clear shape bounds when picking a detour rail. */
  fromRect: Rect | null;
  toRect: Rect | null;
} | null {
  const fp = resolveEndpointPoint(conn.from, conn.to, shapes);
  const tp = resolveEndpointPoint(conn.to, conn.from, shapes);
  if (!fp || !tp) return null;

  let fx = fp.x;
  let fy = fp.y;
  let tx = tp.x;
  let ty = tp.y;

  if (fromSetback > 0 || toSetback > 0) {
    const dxRaw = tx - fx;
    const dyRaw = ty - fy;
    const distRaw = Math.sqrt(dxRaw * dxRaw + dyRaw * dyRaw);

    let fDir = anchorOutDir(fp.anchor, fp.rotation);
    let tDir = anchorOutDir(tp.anchor, tp.rotation);

    if (conn.routing === 'straight' || conn.routing == null) {
      if (distRaw > 0) {
        fDir = [dxRaw / distRaw, dyRaw / distRaw];
        tDir = [-dxRaw / distRaw, -dyRaw / distRaw];
      }
    }

    if (fromSetback > 0) {
      if (fDir) {
        fx += fDir[0] * fromSetback;
        fy += fDir[1] * fromSetback;
      } else if (distRaw > fromSetback) {
        fx += (dxRaw / distRaw) * fromSetback;
        fy += (dyRaw / distRaw) * fromSetback;
      }
    }

    if (toSetback > 0) {
      if (tDir) {
        tx += tDir[0] * toSetback;
        ty += tDir[1] * toSetback;
      } else if (distRaw > toSetback) {
        tx -= (dxRaw / distRaw) * toSetback;
        ty -= (dyRaw / distRaw) * toSetback;
      }
    }
  }

  return {
    fx,
    fy,
    tx,
    ty,
    fromAnchor: fp.anchor,
    toAnchor: tp.anchor,
    fromRot: fp.rotation,
    toRot: tp.rotation,
    fromRect: rectForEndpoint(conn.from, shapes),
    toRect: rectForEndpoint(conn.to, shapes),
  };
}

/** Look up the source/target shape from a connector endpoint. Returns
 *  null for floating endpoints (those that store an explicit point
 *  rather than a shape reference). The rect is in WORLD coordinates -
 * what the orthogonal router needs to clear when picking detour rails. */
function rectForEndpoint(
  endpoint: ConnectorEndpoint,
  shapes: Shape[],
): Rect | null {
  if ('shape' in endpoint && endpoint.shape) {
    const s = shapes.find((sh) => sh.id === endpoint.shape);
    if (s) return { x: s.x, y: s.y, w: s.w, h: s.h };
  }
  return null;
}

/** Edge-normal direction for a resolved anchor - the unit vector pointing OUT
 *  of the shape at that anchor, in world space. Cardinal anchors are obvious;
 *  fractional anchors pick whichever cardinal axis they're closest to (the
 *  "dominant" edge), which lines up with how `auto` anchors are computed.
 *
 *  When the shape has been rotated, the world-space exit direction is the
 *  shape-local cardinal direction rotated by `rotation` degrees and then
 *  *snapped back* to the nearest cardinal axis - the elbow router is
 *  axis-aligned in WORLD space, so a 45°-rotated diamond's "right" edge has
 *  to commit to either right or down (whichever the rotation pushes it
 *  closer to). 0° rotation passes through unchanged.
 *
 *  Returns `null` for floating endpoints - the orthogonal router falls back
 *  to a target-direction guess in that case. */
function anchorOutDir(
  anchor: ResolvedAnchor | null,
  rotation = 0,
): [number, number] | null {
  if (anchor == null) return null;
  let dx: number;
  let dy: number;
  if (anchor === 'top') {
    dx = 0;
    dy = -1;
  } else if (anchor === 'bottom') {
    dx = 0;
    dy = 1;
  } else if (anchor === 'right') {
    dx = 1;
    dy = 0;
  } else if (anchor === 'left') {
    dx = -1;
    dy = 0;
  } else {
    // Fractional - pick whichever axis the anchor is closer to an edge on.
    const [fx, fy] = anchor;
    const distLeft = fx;
    const distRight = 1 - fx;
    const distTop = fy;
    const distBottom = 1 - fy;
    const minH = Math.min(distLeft, distRight);
    const minV = Math.min(distTop, distBottom);
    if (minH <= minV) {
      dx = distLeft <= distRight ? -1 : 1;
      dy = 0;
    } else {
      dx = 0;
      dy = distTop <= distBottom ? -1 : 1;
    }
  }
  if (!rotation) return [dx, dy];
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wx = dx * cos - dy * sin;
  const wy = dx * sin + dy * cos;
  // Snap the rotated direction back to the nearest cardinal so the elbow
  // router (which assumes pure horizontal/vertical exits) keeps a clean
  // single-axis decision.
  if (Math.abs(wx) >= Math.abs(wy)) {
    return [wx >= 0 ? 1 : -1, 0];
  }
  return [0, wy >= 0 ? 1 : -1];
}

/** Build a strict orthogonal polyline from `from` to `to`. The actual
 *  routing logic is in `./elbow`; this wrapper adapts Vellum's
 *  ResolvedAnchor format to that module's CardinalDir + Rect inputs.
 *
 *  Pass `fromRect` / `toRect` for shape-aware detour math (the rail
 *  in the "loop around" cases will hug the shapes' actual bounds).
 *  Without rects the router falls back to a fixed offset - fine for
 *  free endpoints, slightly less tight for shape-attached ones. */
export function buildOrthogonalPolyline(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  fromRot = 0,
  toRot = 0,
  fromRect: Rect | null = null,
  toRect: Rect | null = null,
): { x: number; y: number }[] {
  const from: ElbowEndpoint = {
    point: { x: fx, y: fy },
    rect: fromRect,
    dir: anchorToCardinal(fromAnchor, fromRot),
  };
  const to: ElbowEndpoint = {
    point: { x: tx, y: ty },
    rect: toRect,
    dir: anchorToCardinal(toAnchor, toRot),
  };
  return routeOrthogonal(from, to);
}

/** Convert a Vellum ResolvedAnchor to the elbow router's CardinalDir.
 *  Cardinal anchors map directly. Fractional anchors pick the dominant
 *  edge (whichever is closer to the perimeter on each axis), then snap
 *  the resulting outward direction back to a cardinal after rotation -
 * same logic as `anchorOutDir`, but expressed as a side rather than
 *  a unit vector. Returns null for null anchors so the router can
 *  decide on its own. */
function anchorToCardinal(
  anchor: ResolvedAnchor | null,
  rotation: number,
): CardinalDir | null {
  if (anchor == null) return null;
  const dir = anchorOutDir(anchor, rotation);
  if (!dir) return null;
  const [dx, dy] = dir;
  if (dx > 0) return 'right';
  if (dx < 0) return 'left';
  if (dy > 0) return 'bottom';
  return 'top';
}

export function buildPath(
  routing: Connector['routing'],
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  waypoints?: { x: number; y: number }[],
  fromRot = 0,
  toRot = 0,
  fromRect: Rect | null = null,
  toRect: Rect | null = null,
  waypointMode?: Connector['waypointMode'],
): string {
  // Manual waypoints win - thread the line through them in order. Duplicates
  // come out first, so a bend parked on an endpoint can't leave a
  // tangent-less stub for the spline or the arrowhead to trip over.
  if (waypoints && waypoints.length > 0) {
    const pts = dedupePoints([
      { x: fx, y: fy },
      ...waypoints,
      { x: tx, y: ty },
    ]);
    if (routing === 'orthogonal') {
      const ortho = buildOrthogonalThroughWaypoints(
        fx,
        fy,
        tx,
        ty,
        fromAnchor,
        toAnchor,
        waypoints,
        fromRot,
        toRot,
        fromRect,
        toRect,
        waypointMode,
      );
      return polylineToRoundedPath(ortho);
    }
    if (routing === 'curved') {
      return catmullRomToBezier(pts);
    }
    // straight = polyline
    return polylineToPath(pts);
  }

  if (routing === 'orthogonal') {
    const pts = buildOrthogonalPolyline(
      fx,
      fy,
      tx,
      ty,
      fromAnchor,
      toAnchor,
      fromRot,
      toRot,
      fromRect,
      toRect,
    );
    return polylineToRoundedPath(pts);
  }
  if (routing === 'curved') {
    // Without waypoints a "curved" line only really has one tangent to choose;
    // bias the control points along the from/to anchor axes so the curve
    // leaves and enters the shape edges naturally.
    const fromHoriz =
      fromAnchor == null || anchorAxis(fromAnchor, fromRot) !== 'vertical';
    const toHoriz =
      toAnchor == null || anchorAxis(toAnchor, toRot) !== 'vertical';
    const dx = (tx - fx) * 0.5;
    const dy = (ty - fy) * 0.5;
    const c1 = fromHoriz ? `${fx + dx} ${fy}` : `${fx} ${fy + dy}`;
    const c2 = toHoriz ? `${tx - dx} ${ty}` : `${tx} ${ty - dy}`;
    return `M ${fx} ${fy} C ${c1}, ${c2}, ${tx} ${ty}`;
  }
  return `M ${fx} ${fy} L ${tx} ${ty}`;
}

/** Build the polyline points the renderer would draw for this connector at
 *  the given resolved endpoints / anchors. Same routing decisions as
 *  `buildPath`, but returned as discrete (x, y) vertices instead of an SVG
 *  path string - so hit-testers and label positioners can do arclength /
 *  point-projection math against the actual rendered geometry.
 *
 *  Kept thin: it dispatches to `buildOrthogonalPolyline` /
 *  `buildOrthogonalThroughWaypoints` / `sampleCurvedPolyline` /
 *  straight-with-waypoints. Any future routing mode (e.g. spline) gets one
 *  extra branch here and label/drag math updates for free. */
export function connectorPolyline(
  conn: Connector,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  fromRot = 0,
  toRot = 0,
  fromRect: Rect | null = null,
  toRect: Rect | null = null,
): { x: number; y: number }[] {
  const wp = conn.waypoints;
  if (conn.routing === 'orthogonal') {
    return wp && wp.length > 0
      ? buildOrthogonalThroughWaypoints(
          fx,
          fy,
          tx,
          ty,
          fromAnchor,
          toAnchor,
          wp,
          fromRot,
          toRot,
          fromRect,
          toRect,
          conn.waypointMode,
        )
      : buildOrthogonalPolyline(
          fx,
          fy,
          tx,
          ty,
          fromAnchor,
          toAnchor,
          fromRot,
          toRot,
          fromRect,
          toRect,
        );
  }
  if (conn.routing === 'curved') {
    return sampleCurvedPolyline(
      fx,
      fy,
      tx,
      ty,
      fromAnchor,
      toAnchor,
      wp,
      fromRot,
      toRot,
    );
  }
  // straight: from → optional waypoints → to.
  return dedupePoints([{ x: fx, y: fy }, ...(wp ?? []), { x: tx, y: ty }]);
}

/** Two points closer than this are the same point as far as routing is
 *  concerned - sub-pixel at any usable zoom. */
const COINCIDENT_EPS = 0.01;

/** Drop consecutive points that sit on top of each other, keeping the first
 *  and last vertex.
 *
 *  A duplicate is invisible in the drawn line but poisons everything derived
 *  from it: a spline segment between two identical points has no tangent, so
 *  it renders as a small spur past the endpoint and hands `orient="auto"` a
 *  direction pulled off the leftover control point - which is how an
 *  arrowhead ends up pointing back down its own line. Users make these
 *  routinely by dropping a bend handle onto an endpoint. */
export function dedupePoints(
  pts: { x: number; y: number }[],
  eps: number = COINCIDENT_EPS,
): { x: number; y: number }[] {
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) > eps) out.push(pts[i]);
  }
  // Never collapse to a single point - a zero-length connector still needs
  // two vertices for the renderer and the direction math.
  if (out.length < 2) out.push(pts[pts.length - 1]);
  return out;
}

/** Past this much cumulative turn we have left the end of the line and are
 *  describing a different part of it, so the measurement stops. 45 deg
 *  clears an elbow's 90 deg corners while still averaging along a curve,
 *  whose sampled vertices turn a degree or two apiece. */
const END_DIRECTION_MAX_TURN = Math.PI / 4;

/** Which way a polyline points at one end, measured over `span` of
 *  arclength rather than at the terminal vertex itself. Returns a unit
 *  vector aimed OUT of the line at that end - along the direction of travel
 *  at `'end'`, against it at `'start'`, which is how a start-marker faces -
 * or null if the polyline has no extent at all.
 *
 *  This is what an arrowhead should be aimed with, and it is not what
 *  `orient="auto"` uses. SVG aims a marker with the path's instantaneous
 *  tangent at the endpoint, but an arrowhead is not a point: its barbs reach
 *  `size` px back along the line, and what reads as "aligned" is the
 *  direction the stroke runs over that whole span. On a line that curves
 *  through its last few px - the common case for a hand-bent connector - the
 *  two differ enough that one barb lies down along the stroke and the head
 *  looks crumpled.
 *
 *  Walking a span also makes the answer defined where the tangent is simply
 *  unavailable: a degenerate final segment leaves `orient="auto"` guessing,
 *  and browsers do not guess alike. */
export function polylineEndDirection(
  pts: { x: number; y: number }[],
  which: 'start' | 'end',
  span: number,
): { x: number; y: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const tipIdx = which === 'end' ? n - 1 : 0;
  const step = which === 'end' ? -1 : 1;
  const tip = pts[tipIdx];
  const minDot = Math.cos(END_DIRECTION_MAX_TURN);

  // Direction of the first segment with any length - the reference the turn
  // budget is measured against, and the answer if nothing longer qualifies.
  let ref: { x: number; y: number } | null = null;
  // Farthest point reached so far that is still describing this end.
  let far = tip;
  let walked = 0;

  // Walk inward, one vertex at a time: `nearer` is the vertex we came from
  // (tip side), `farther` the one we are stepping to.
  for (let i = tipIdx + step; i >= 0 && i < n; i += step) {
    const farther = pts[i];
    const nearer = pts[i - step];
    const len = Math.hypot(nearer.x - farther.x, nearer.y - farther.y);
    if (len <= COINCIDENT_EPS) continue;
    const dir = {
      x: (nearer.x - farther.x) / len,
      y: (nearer.y - farther.y) / len,
    };
    // Past the turn budget this segment belongs to a different stretch of
    // line, so stop before it.
    if (!ref) ref = dir;
    else if (dir.x * ref.x + dir.y * ref.y < minDot) break;
    if (walked + len >= span) {
      // Land exactly `span` from the tip so the answer does not depend on how
      // densely the curve happened to be sampled.
      const t = (span - walked) / len;
      far = {
        x: nearer.x + (farther.x - nearer.x) * t,
        y: nearer.y + (farther.y - nearer.y) * t,
      };
      break;
    }
    walked += len;
    far = farther;
  }

  const dx = tip.x - far.x;
  const dy = tip.y - far.y;
  const chord = Math.hypot(dx, dy);
  // A chord that collapsed means the line doubled back on itself inside the
  // span; the adjacent segment is then the only accurate answer.
  if (chord <= COINCIDENT_EPS) return ref;
  return { x: dx / chord, y: dy / chord };
}

/** Per-segment + cumulative arclengths for a polyline. Used by both the
 *  point-at-fraction lookup and the nearest-fraction-to-point projection so
 *  they agree on what "halfway" means even for very short segments. */
function polylineMetrics(pts: { x: number; y: number }[]): {
  segLen: number[];
  cumLen: number[];
  total: number;
} {
  const segLen: number[] = [];
  const cumLen: number[] = [0];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const d = Math.hypot(dx, dy);
    segLen.push(d);
    total += d;
    cumLen.push(total);
  }
  return { segLen, cumLen, total };
}

/** Point on a polyline at fraction `f` of total arclength (clamped to
 *  [0, 1]). Degenerate polylines (length 0 or 1, or zero total length)
 *  fall back to the first vertex so callers always get a finite point. */
export function pointAtFraction(
  pts: { x: number; y: number }[],
  f: number,
): { x: number; y: number } {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return pts[0];
  const { segLen, cumLen, total } = polylineMetrics(pts);
  if (total === 0) return pts[0];
  const target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < segLen.length; i++) {
    // First segment whose end-arclength is past the target wins. Equality
    // is OK - t collapses to 1.0 and we return that vertex exactly.
    if (cumLen[i + 1] >= target) {
      const t = segLen[i] === 0 ? 0 : (target - cumLen[i]) / segLen[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
  }
  return pts[pts.length - 1];
}

/** Project world point `p` onto the closest segment of `pts` and return
 *  the fraction of total arclength at the projection. Used to translate
 *  "the user dragged the label here" into a stored `labelPosition`. */
export function nearestFractionOnPolyline(
  pts: { x: number; y: number }[],
  p: { x: number; y: number },
): number {
  if (pts.length < 2) return 0;
  const { segLen, cumLen, total } = polylineMetrics(pts);
  if (total === 0) return 0;
  let bestDist = Infinity;
  let bestFrac = 0;
  for (let i = 0; i < segLen.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    // Classic point-on-segment projection clamped to [0, 1] of the segment.
    const t =
      len2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
          );
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < bestDist) {
      bestDist = d;
      bestFrac = (cumLen[i] + t * segLen[i]) / total;
    }
  }
  return bestFrac;
}

function polylineToPath(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

/** Render a polyline as an SVG path with rounded corners at every interior
 *  bend. We step back from each bend vertex by `radius` along the incoming
 *  segment, then step forward by the same along the outgoing segment, and
 *  bridge the two with a quadratic Bézier whose control point is the bend
 *  vertex itself. For two axis-aligned segments at 90°, the Q-curve is
 *  visually indistinguishable from a circular arc but a fraction of the
 *  math to emit.
 *
 *  Radius is clamped to half the shorter incident segment so tight bends
 *  (e.g. ones with two short legs) don't over-curve and overshoot the next
 *  vertex.
 *
 *  Hit-testing keeps using the sharp polyline - the rounding is purely
 *  cosmetic, so click-to-add-bend / label-drag math stays exact. */
const DEFAULT_CORNER_RADIUS = 8;
export function polylineToRoundedPath(
  pts: { x: number; y: number }[],
  radius: number = DEFAULT_CORNER_RADIUS,
): string {
  if (pts.length < 3) return polylineToPath(pts);
  const parts: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inDx = cur.x - prev.x;
    const inDy = cur.y - prev.y;
    const outDx = next.x - cur.x;
    const outDy = next.y - cur.y;
    const inLen = Math.hypot(inDx, inDy);
    const outLen = Math.hypot(outDx, outDy);
    // Skip degenerate vertices (zero-length incident segment) - emit a
    // straight L through them so the path stays continuous.
    if (inLen === 0 || outLen === 0) {
      parts.push(`L ${cur.x} ${cur.y}`);
      continue;
    }
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const entry = {
      x: cur.x - (inDx / inLen) * r,
      y: cur.y - (inDy / inLen) * r,
    };
    const exit = {
      x: cur.x + (outDx / outLen) * r,
      y: cur.y + (outDy / outLen) * r,
    };
    parts.push(`L ${entry.x} ${entry.y}`);
    parts.push(`Q ${cur.x} ${cur.y} ${exit.x} ${exit.y}`);
  }
  const last = pts[pts.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(' ');
}

/** Offset every vertex of `pts` perpendicular to its local tangent by
 *  `dist` user-space units. The perpendicular at each vertex is the
 *  average of the incoming and outgoing segment tangents - works for both
 *  smooth (curved) polylines and orthogonal ones. Positive `dist` offsets
 *  to the LEFT of the from→to direction (90° CCW rotation of the tangent
 *  in y-down screen coords); negative goes RIGHT.
 *
 *  Used by the bidirectional connector style to produce two parallel
 *  polylines from one routed path. Not pixel-perfect for tight 90° elbows
 *  (the corner offset uses the bisector, not a proper miter intersection),
 *  but visually fine at the small offsets bidirectional uses (~3–4px). */
export function offsetPolyline(
  pts: { x: number; y: number }[],
  dist: number,
): { x: number; y: number }[] {
  if (pts.length < 2 || dist === 0) return pts.map((p) => ({ ...p }));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = i > 0 ? pts[i - 1] : null;
    const next = i < pts.length - 1 ? pts[i + 1] : null;
    let tx = 0;
    let ty = 0;
    if (prev) {
      const dx = pts[i].x - prev.x;
      const dy = pts[i].y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      tx += dx / len;
      ty += dy / len;
    }
    if (next) {
      const dx = next.x - pts[i].x;
      const dy = next.y - pts[i].y;
      const len = Math.hypot(dx, dy) || 1;
      tx += dx / len;
      ty += dy / len;
    }
    const tLen = Math.hypot(tx, ty) || 1;
    tx /= tLen;
    ty /= tLen;
    // Perpendicular (90° CCW in y-down): (-ty, tx).
    out.push({
      x: pts[i].x + -ty * dist,
      y: pts[i].y + tx * dist,
    });
  }
  return out;
}

/** Same as the private waypoint-expansion routine, exposed so the canvas hit
 *  layer can build the same axis-aligned polyline the renderer draws. Walks
 *  start → waypoints → end and inserts an L-bend between any adjacent pair
 *  with both dx and dy nonzero. */
export function buildOrthogonalThroughWaypoints(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  waypoints: { x: number; y: number }[],
  fromRot = 0,
  toRot = 0,
  fromRect: Rect | null = null,
  toRect: Rect | null = null,
  waypointMode?: Connector['waypointMode'],
): { x: number; y: number }[] {
  const from: ElbowEndpoint = {
    point: { x: fx, y: fy },
    rect: fromRect,
    dir: anchorToCardinal(fromAnchor, fromRot),
  };
  const to: ElbowEndpoint = {
    point: { x: tx, y: ty },
    rect: toRect,
    dir: anchorToCardinal(toAnchor, toRot),
  };
  return waypointMode === 'segments'
    ? routeOrthogonalSegments(from, to, waypoints)
    : routeOrthogonalThroughWaypoints(from, to, waypoints);
}

/** Sample a curved-routed connector into a polyline for hit-testing. The
 *  rendered path is either a single cubic Bezier (no waypoints) or a Catmull-
 *  Rom spline through waypoints - both reduce to per-segment cubics. We
 *  evaluate each cubic at SAMPLES + 1 points and concatenate. The result is
 *  what the click hit-tester walks: previously it fell back to a straight-
 *  line check, which is why clicking near the bulge of a curved line missed.
 *
 *  SAMPLES = 24 per segment is overkill for crisp clicks at any zoom; the
 *  cost is negligible (we only sample on click, not per frame). */
const CURVE_SAMPLES_PER_SEGMENT = 24;

export function sampleCurvedPolyline(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  fromAnchor: ResolvedAnchor | null,
  toAnchor: ResolvedAnchor | null,
  waypoints: { x: number; y: number }[] | undefined,
  fromRot = 0,
  toRot = 0,
  /** Samples per cubic. Line jumps draw the curve FROM this polyline, so
   *  they ask for more than the hit-tester needs to keep it smooth. */
  samples = CURVE_SAMPLES_PER_SEGMENT,
): { x: number; y: number }[] {
  if (waypoints && waypoints.length > 0) {
    // Exactly the cubics `catmullRomToBezier` emits - shared so the sampled
    // polyline (hit-testing, labels, arrowhead aim) can never describe a
    // different curve than the one on screen.
    const pts = dedupePoints([
      { x: fx, y: fy },
      ...waypoints,
      { x: tx, y: ty },
    ]);
    if (pts.length === 2) {
      return sampleCubic(
        pts[0],
        { x: pts[0].x + (pts[1].x - pts[0].x) * 0.5, y: pts[0].y },
        { x: pts[1].x - (pts[1].x - pts[0].x) * 0.5, y: pts[1].y },
        pts[1],
        samples,
      );
    }
    const out: { x: number; y: number }[] = [pts[0]];
    for (const seg of catmullRomSegments(pts)) {
      const curve = sampleCubic(seg.from, seg.c1, seg.c2, seg.to, samples);
      // First sample of every segment duplicates the previous segment's last
      // sample - skip it to keep the polyline tight.
      for (let j = 1; j < curve.length; j++) out.push(curve[j]);
    }
    return out;
  }
  // Single-segment cubic. Control points biased along anchor exit axes so
  // the curve leaves/enters the shape naturally - same rule the renderer uses.
  const fromHoriz =
    fromAnchor == null || anchorAxis(fromAnchor, fromRot) !== 'vertical';
  const toHoriz =
    toAnchor == null || anchorAxis(toAnchor, toRot) !== 'vertical';
  const dx = (tx - fx) * 0.5;
  const dy = (ty - fy) * 0.5;
  const c1 = fromHoriz
    ? { x: fx + dx, y: fy }
    : { x: fx, y: fy + dy };
  const c2 = toHoriz ? { x: tx - dx, y: ty } : { x: tx, y: ty - dy };
  return sampleCubic({ x: fx, y: fy }, c1, c2, { x: tx, y: ty }, samples);
}

function sampleCubic(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  samples = CURVE_SAMPLES_PER_SEGMENT,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
      y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
    });
  }
  return out;
}

/** Tension 0.5 gives a natural, slightly-loose curve. */
const CR_TENSION = 0.5;

/** `Pt` in this module's neighbours is the tuple form; connector geometry is
 *  all `{x, y}`, so name that once for the spline types below. */
type XY = { x: number; y: number };
type CubicSegment = { from: XY; c1: XY; c2: XY; to: XY };

/** Cubic Bezier segments of a Catmull-Rom spline through `pts`. One segment
 *  per adjacent pair; the spline passes through every point.
 *
 *  TERMINAL HANDLES: an interior control handle spans two segments
 *  (`|p2 - p0|`), so the textbook shortcut of *doubling* the endpoint
 *  (`p0 = p1`) leaves the first and last segments with roughly half the
 *  handle everyone else gets. A short outer handle crams that segment's
 *  whole turn into the last few percent of the curve: the stroke hooks as it
 *  reaches its endpoint, and - because SVG aims `orient="auto"` markers with
 *  the tangent AT the endpoint - the arrowhead ends up pointing along that
 *  hook instead of along the line you can actually see arriving. Reflecting
 *  the neighbour through the endpoint gives terminal segments an
 *  interior-scale handle, so the curve runs straight out of its endpoints
 *  and the tangent there describes the visible stroke.
 *
 *  Reflection preserves the terminal tangent's DIRECTION (both forms are
 *  parallel to the terminal chord) - it only lengthens the handle. So this
 *  is a curvature fix, not a re-aim: straight and near-straight connectors
 *  render as before. */
export function catmullRomSegments(
  pts: { x: number; y: number }[],
): CubicSegment[] {
  const reflect = (p: XY, pivot: XY): XY => ({
    x: 2 * pivot.x - p.x,
    y: 2 * pivot.y - p.y,
  });
  const out: CubicSegment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p0 = pts[i - 1] ?? reflect(p2, p1);
    const p3 = pts[i + 2] ?? reflect(p1, p2);
    out.push({
      from: p1,
      c1: {
        x: p1.x + ((p2.x - p0.x) * CR_TENSION) / 3,
        y: p1.y + ((p2.y - p0.y) * CR_TENSION) / 3,
      },
      c2: {
        x: p2.x - ((p3.x - p1.x) * CR_TENSION) / 3,
        y: p2.y - ((p3.y - p1.y) * CR_TENSION) / 3,
      },
      to: p2,
    });
  }
  return out;
}

/** Catmull-Rom spline through `pts`, emitted as SVG path commands. */
function catmullRomToBezier(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    // No interior points - fall back to a soft S-curve between the two points
    // so the line still reads as "curved".
    const [a, b] = pts;
    const dx = b.x - a.x;
    return `M ${a.x} ${a.y} C ${a.x + dx * 0.5} ${a.y}, ${b.x - dx * 0.5} ${b.y}, ${b.x} ${b.y}`;
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (const seg of catmullRomSegments(pts)) {
    d += ` C ${seg.c1.x} ${seg.c1.y}, ${seg.c2.x} ${seg.c2.y}, ${seg.to.x} ${seg.to.y}`;
  }
  return d;
}
