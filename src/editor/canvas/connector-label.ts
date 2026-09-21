/** Geometry shared between a connector's label and its drag-to-bend handles.
 *
 *  These two affordances used to fight over the same pixels. A label defaults
 *  to `labelPosition = 0.5` - the arclength midpoint of the line - and a bend
 *  handle sits at the midpoint of each segment, so on any straight or
 *  orthogonal connector the label's paper rect lands exactly on top of the
 *  handle you'd grab to add an elbow. Whichever one hit-testing preferred, the
 *  other became unreachable, and no ordering rule fixes that because both are
 *  legitimate targets at the same coordinate.
 *
 *  So don't arbitrate - separate. `bendHandlePoint` slides the handle along
 *  its own segment until it clears the label rect. Handles only render while
 *  the connector is selected, so the shift is invisible: the handle simply
 *  appears somewhere grabbable, and the label keeps its position. Nothing
 *  jumps, nothing is hidden, and no modifier is involved.
 *
 *  The label box is here too, because the renderer (`Connector.tsx`), the
 *  hit-tester (`Canvas.tsx`) and the handle placement all have to agree on it
 *  to the pixel. It was already duplicated across the first two.
 */

export type Pt = { x: number; y: number };

/** Axis-aligned half-extents of the paper-coloured rect painted behind a
 *  connector label. Mono at fontSize 10 - the 7px/char advance and the 6px
 *  side padding are what `Connector.tsx` actually paints, so hit zone and
 *  visible gap in the line stay identical at every zoom (the box is world
 *  units; the label scales with the canvas). */
export type LabelBox = {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
};

export function labelBoxAt(plain: string, cx: number, cy: number): LabelBox {
  return {
    cx,
    cy,
    halfW: plain.length * 3.5 + 6,
    halfH: 9,
  };
}

/** Screen-pixel clearances, divided by zoom at the call site so both stay
 *  constant on screen while the label box does not. */
export const BEND_HANDLE_END_CLEARANCE_PX = 14;
export const BEND_HANDLE_LABEL_GAP_PX = 9;

/** Liang–Barsky: the `[t0, t1]` slice of segment `a→b` that lies inside
 *  `box`, or null when the segment misses it entirely. */
function segmentBoxInterval(
  a: Pt,
  b: Pt,
  box: LabelBox,
): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [
    a.x - (box.cx - box.halfW),
    box.cx + box.halfW - a.x,
    a.y - (box.cy - box.halfH),
    box.cy + box.halfH - a.y,
  ];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this slab - outside it means the segment misses.
      if (q[i] < 0) return null;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

/** Where the drag-to-bend handle for segment `a→b` should sit - for both
 *  painting and hit-testing, which must use this same answer or the user is
 *  aiming at a dot that isn't where the click lands.
 *
 *  Default is the segment midpoint. When a label covers it, the handle slides
 *  to whichever edge of the label rect is nearer the middle, `gap` clear of
 *  it. Two guards on that slide:
 *
 *  - It never comes within `endClearance` of either end of the segment, where
 *    the endpoint and waypoint handles live. A segment too short to host a
 *    handle at all returns null and simply shows none - its ends are already
 *    covered in grabbable controls.
 *
 *  - If the label covers so much of the segment that neither edge is
 *    reachable (a long label on a short line), the handle stays at the
 *    midpoint and overlaps. It wins the hit-test there, costing the label one
 *    small disc; the label is grabbable everywhere else, and deselecting the
 *    connector disarms the handle and gives the label back whole.
 */
export function bendHandlePoint(
  a: Pt,
  b: Pt,
  box: LabelBox | null,
  opts: { endClearance: number; gap: number },
): Pt | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len <= 0) return null;

  const margin = opts.endClearance / len;
  if (margin * 2 >= 1) return null;
  const tMin = margin;
  const tMax = 1 - margin;
  const at = (t: number): Pt => ({ x: a.x + dx * t, y: a.y + dy * t });
  const mid = Math.min(tMax, Math.max(tMin, 0.5));

  if (!box) return at(mid);

  // Grow the box by the gap so the handle's own circle clears the rect
  // rather than kissing it.
  const inside = segmentBoxInterval(a, b, {
    cx: box.cx,
    cy: box.cy,
    halfW: box.halfW + opts.gap,
    halfH: box.halfH + opts.gap,
  });
  if (!inside) return at(mid);

  const [t0, t1] = inside;
  if (mid <= t0 || mid >= t1) return at(mid);

  // `t0` / `t1` sit exactly on the grown box boundary, so they're the closest
  // clear points on either side. Each is only usable if it's still inside the
  // end-clearance window - a boundary that got clamped inward would land back
  // under the label.
  const clear: number[] = [];
  if (t0 >= tMin) clear.push(t0);
  if (t1 <= tMax) clear.push(t1);
  if (clear.length === 0) return at(mid);

  clear.sort((p, q) => Math.abs(p - 0.5) - Math.abs(q - 0.5));
  return at(clear[0]);
}
