/* Sketchy primitives - placeholder for rough.js.
 *
 * Custom hand-rolled jitter, no external dep. Visual target: marker-on-paper
 * look - bowed edges with a visible double-stroke, deterministic per-shape
 * via a `seed` so the wobble doesn't dance on re-render.
 *
 * Three layered techniques:
 *   - Per-pass independent RNG: pass 0 and pass 1 draw from separate streams,
 *     so the two strokes wobble independently rather than tracing each other.
 *   - Pass-1 amplification: second pass uses a slightly larger jitter amp so
 *     it reads as a distinct over-trace, giving the dual-stroke marker feel.
 *   - Bowing on long edges: control point sits perpendicular to the segment
 *     by an amount proportional to length - long edges drift, short edges
 *     stay nearly straight (matches how a hand wanders more on a long pull).
 */

/** Mulberry32 - simple seedable PRNG so sketch shapes are stable across renders. */
export function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-pass jitter sampler. Independent RNG per pass so the two strokes
 *  wobble independently; pass 1 gets a 25% bigger amp so it reads as an
 *  over-trace, not a copy. 7919 is just an arbitrary prime - anything that
 *  decorrelates the stream works. */
function passJ(seed: number, pass: number, amp: number): () => number {
  const r = mulberry32(seed + pass * 7919);
  const a = amp * (pass === 0 ? 1 : 1.25);
  return () => (r() - 0.5) * a * 2;
}

/** Quadratic control point for a "bowed" edge - perpendicular offset from
 *  the segment midpoint, magnitude scaled by edge length. Plus a small
 *  absolute jitter so micro-edges still get character. The signed jitter
 *  sample decides bow direction (in vs out), so adjacent edges curve
 *  independently rather than all bowing the same way.
 *
 *  bowK ≈ 0.025 → a 100px edge bows up to ~2.5px at peak amp. Tunable per
 *  caller (the sticky-note fold crease passes a smaller bowK so the diagonal
 *  reads as a fold, not a curved tear). */
function bowedCtrl(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  j: () => number,
  bowK = 0.025,
): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector - sign chosen so positive bow curves to the
  // RIGHT of the travel direction; with j() signed, we get both sides.
  const px = -dy / len;
  const py = dx / len;
  const bow = j() * len * bowK;
  return [
    (x1 + x2) / 2 + px * bow + j() * 0.4,
    (y1 + y2) / 2 + py * bow + j() * 0.4,
  ];
}

/** Two-pass jittered rect with bowed edges - same target as rough.js
 *  default `roughness: 1` but tuned for Vellum's marker look. */
export function jitterRect(
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 1,
  amp = 1.5,
): string[] {
  const sides: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const j = passJ(seed, pass, amp);
    const x1 = x + j(),
      y1 = y + j();
    const x2 = x + w + j(),
      y2 = y + j();
    const x3 = x + w + j(),
      y3 = y + h + j();
    const x4 = x + j(),
      y4 = y + h + j();
    const [c1x, c1y] = bowedCtrl(x1, y1, x2, y2, j);
    const [c2x, c2y] = bowedCtrl(x2, y2, x3, y3, j);
    const [c3x, c3y] = bowedCtrl(x3, y3, x4, y4, j);
    const [c4x, c4y] = bowedCtrl(x4, y4, x1, y1, j);
    sides.push(
      `M ${x1} ${y1} ` +
        `Q ${c1x} ${c1y} ${x2} ${y2} ` +
        `Q ${c2x} ${c2y} ${x3} ${y3} ` +
        `Q ${c3x} ${c3y} ${x4} ${y4} ` +
        `Q ${c4x} ${c4y} ${x1} ${y1}`,
    );
  }
  return sides;
}

/** Two-pass jittered ROUNDED rect - wobbly outline with arc-cut corners.
 *  Used on the Notes layer so rect / service / container shapes read as a
 *  marker pass on a sticker rather than a sharp-edged technical drawing.
 *  Corner arcs use a Q-curve through the would-be sharp vertex (close enough
 *  to a circular arc at this jitter amplitude); straight edges get the bow
 *  treatment. */
export function jitterRoundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  seed = 1,
  amp = 1.5,
): string[] {
  // Clamp radius so it never overruns the bbox - a 20×20 sticker shouldn't
  // try to round a 10px corner with r=14 and end up inverting the path.
  const rad = Math.max(0, Math.min(r, w / 2 - 1, h / 2 - 1));
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const j = passJ(seed, pass, amp);
    const tlEnd: [number, number] = [x + j(), y + rad + j()];
    const tlCtrl: [number, number] = [x + j(), y + j()];
    const tlStart: [number, number] = [x + rad + j(), y + j()];
    const trStart: [number, number] = [x + w - rad + j(), y + j()];
    const trCtrl: [number, number] = [x + w + j(), y + j()];
    const trEnd: [number, number] = [x + w + j(), y + rad + j()];
    const brStart: [number, number] = [x + w + j(), y + h - rad + j()];
    const brCtrl: [number, number] = [x + w + j(), y + h + j()];
    const brEnd: [number, number] = [x + w - rad + j(), y + h + j()];
    const blStart: [number, number] = [x + rad + j(), y + h + j()];
    const blCtrl: [number, number] = [x + j(), y + h + j()];
    const blEnd: [number, number] = [x + j(), y + h - rad + j()];

    // Bow the four straight edges; corners stay as Q-arcs through the
    // would-be sharp vertex so the rounding still reads as a rounded corner.
    const [topCx, topCy] = bowedCtrl(
      tlStart[0],
      tlStart[1],
      trStart[0],
      trStart[1],
      j,
    );
    const [rgtCx, rgtCy] = bowedCtrl(
      trEnd[0],
      trEnd[1],
      brStart[0],
      brStart[1],
      j,
    );
    const [botCx, botCy] = bowedCtrl(
      brEnd[0],
      brEnd[1],
      blStart[0],
      blStart[1],
      j,
    );
    const [lftCx, lftCy] = bowedCtrl(
      blEnd[0],
      blEnd[1],
      tlEnd[0],
      tlEnd[1],
      j,
    );

    let d = `M ${tlStart[0]} ${tlStart[1]}`;
    d += ` Q ${topCx} ${topCy} ${trStart[0]} ${trStart[1]}`;
    d += ` Q ${trCtrl[0]} ${trCtrl[1]} ${trEnd[0]} ${trEnd[1]}`;
    d += ` Q ${rgtCx} ${rgtCy} ${brStart[0]} ${brStart[1]}`;
    d += ` Q ${brCtrl[0]} ${brCtrl[1]} ${brEnd[0]} ${brEnd[1]}`;
    d += ` Q ${botCx} ${botCy} ${blStart[0]} ${blStart[1]}`;
    d += ` Q ${blCtrl[0]} ${blCtrl[1]} ${blEnd[0]} ${blEnd[1]}`;
    d += ` Q ${lftCx} ${lftCy} ${tlEnd[0]} ${tlEnd[1]}`;
    d += ` Q ${tlCtrl[0]} ${tlCtrl[1]} ${tlStart[0]} ${tlStart[1]}`;
    out.push(d);
  }
  return out;
}

/** Sticky-note silhouette: rect with the top-left corner peeled back. The
 *  diagonal crease (p5 → p1) gets a much smaller bow factor so it reads as
 *  a paper fold, not a curved tear. */
export function jitterFoldedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  fold: number,
  seed = 1,
  amp = 1.2,
): string[] {
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const j = passJ(seed, pass, amp);
    const p1: [number, number] = [x + fold + j(), y + j()]; // top edge start (after fold)
    const p2: [number, number] = [x + w + j(), y + j()]; // top-right
    const p3: [number, number] = [x + w + j(), y + h + j()]; // bottom-right
    const p4: [number, number] = [x + j(), y + h + j()]; // bottom-left
    const p5: [number, number] = [x + j(), y + fold + j()]; // left edge end (above fold)

    const [c12x, c12y] = bowedCtrl(p1[0], p1[1], p2[0], p2[1], j);
    const [c23x, c23y] = bowedCtrl(p2[0], p2[1], p3[0], p3[1], j);
    const [c34x, c34y] = bowedCtrl(p3[0], p3[1], p4[0], p4[1], j);
    const [c45x, c45y] = bowedCtrl(p4[0], p4[1], p5[0], p5[1], j);
    // Crease: tiny bow factor - folds are essentially straight, only
    // micro-wobble from j() so the line doesn't read as CAD.
    const [c51x, c51y] = bowedCtrl(p5[0], p5[1], p1[0], p1[1], j, 0.005);

    let d = `M ${p1[0]} ${p1[1]}`;
    d += ` Q ${c12x} ${c12y} ${p2[0]} ${p2[1]}`;
    d += ` Q ${c23x} ${c23y} ${p3[0]} ${p3[1]}`;
    d += ` Q ${c34x} ${c34y} ${p4[0]} ${p4[1]}`;
    d += ` Q ${c45x} ${c45y} ${p5[0]} ${p5[1]}`;
    d += ` Q ${c51x} ${c51y} ${p1[0]} ${p1[1]}`;
    out.push(d);
  }
  return out;
}

/** Two-pass jittered diamond with bowed edges. Used by Notes-layer diamonds
 *  so they get the same hand-drawn feel as rects + ellipses. */
export function jitterDiamond(
  x: number,
  y: number,
  w: number,
  h: number,
  seed = 1,
  amp = 1.5,
): string[] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const out: string[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const j = passJ(seed, pass, amp);
    const top: [number, number] = [cx + j(), y + j()];
    const right: [number, number] = [x + w + j(), cy + j()];
    const bot: [number, number] = [cx + j(), y + h + j()];
    const left: [number, number] = [x + j(), cy + j()];
    const [c1x, c1y] = bowedCtrl(top[0], top[1], right[0], right[1], j);
    const [c2x, c2y] = bowedCtrl(right[0], right[1], bot[0], bot[1], j);
    const [c3x, c3y] = bowedCtrl(bot[0], bot[1], left[0], left[1], j);
    const [c4x, c4y] = bowedCtrl(left[0], left[1], top[0], top[1], j);
    out.push(
      `M ${top[0]} ${top[1]} ` +
        `Q ${c1x} ${c1y} ${right[0]} ${right[1]} ` +
        `Q ${c2x} ${c2y} ${bot[0]} ${bot[1]} ` +
        `Q ${c3x} ${c3y} ${left[0]} ${left[1]} ` +
        `Q ${c4x} ${c4y} ${top[0]} ${top[1]}`,
    );
  }
  return out;
}

/** Hand-drawn ellipse outline - one confident stroke that closes a bit
 *  past the start AND extends in the tangent direction past the closure,
 *  giving the visible "flap" of a hand-drawn circle.
 *
 *  Construction:
 *   1. Three SVG `A` arc segments tracing 360°+overshoot. Sharing rx/ry
 *      across segments keeps the tangent C1-continuous at every join (no
 *      polygon "hard edges" - `A` is a TRUE elliptical arc, unlike the Q
 *      approximation we previously used).
 *   2. A short straight line continuing from the arc's endpoint in the
 *      forward tangent direction. THIS is the visible imperfection - a
 *      tangent extension leaves the circle (the curve falls away from
 *      its own tangent), so the line pokes outside the ring as a small
 *      "tail". Without it, the angle overshoot only doubles the stroke
 *      onto itself and reads as a perfect circle.
 *
 *  Single pass on purpose: a hand draws a circle in one continuous motion
 *  (pen never lifts). A concentric second stroke read as "deliberate
 *  double-line", not "casual sketch". Returns `string[]` so callers
 *  iterate uniformly with the polygon primitives.
 *
 *  Why three arc segments? SVG's `large-arc-flag` is binary; an arc > 180°
 *  in a single segment is awkward to parameterize with overshoot. Three
 *  × ~120° each keeps every segment safely < 180° (flag=0). */
export function jitterEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed = 1,
  amp = 1.2,
): string[] {
  const j = passJ(seed, 0, amp);
  // Aux RNG for angles + per-segment perturbations so they don't consume
  // from j() (keeps sampling order independent of segment count).
  const auxRng = mulberry32(seed + 7919 + 1);
  const startA = auxRng() * Math.PI * 2;
  // Overshoot past the start so the closure visibly overlaps - the pen kept
  // going for a beat after closing the loop. 5–10° was nearly invisible on
  // large circles (the overlap arc is short relative to the radius);
  // 22–42° produces a clear "second pass over the start" that reads as
  // hand-drawn instead of CAD.
  const overshoot = (22 + auxRng() * 20) * (Math.PI / 180); // 22°–42°
  const endA = startA + Math.PI * 2 + overshoot;
  // Walk the perimeter as N Q-curve segments. Each segment endpoint is
  // sampled on a "wobbly" ellipse - rx/ry get a per-angle radial nudge that
  // SCALES WITH RADIUS so the bumpiness is visible at any size. The control
  // point also gets a radial nudge so the chord doesn't stay perfectly
  // smooth between two nearby endpoints. This is what produces the
  // Hand-drawn "the radius keeps drifting as the pen travels" look
  // instead of a clean three-arc ellipse.
  const N = 12;
  // Wobble magnitude as a FRACTION of the larger radius. Capped (in absolute
  // px below) so giant circles don't get giant bumps. 1.4% reads as
  // "hand-drawn", much more and the shape stops being recognisable.
  const maxR = Math.max(rx, ry);
  const wobbleAbs = Math.min(maxR * 0.014, 9) * (amp / 1.45);
  const radial = () => j() * wobbleAbs;

  // Helper: a perturbed point at angle a.
  const pt = (a: number): [number, number] => [
    cx + (rx + radial()) * Math.cos(a),
    cy + (ry + radial()) * Math.sin(a),
  ];
  const [x0, y0] = pt(startA);

  let d = `M ${x0} ${y0}`;
  let prevA = startA;
  let endX = x0;
  let endY = y0;
  for (let i = 1; i <= N; i++) {
    const a = startA + ((endA - startA) * i) / N;
    const aMid = (prevA + a) / 2;
    // Control-point lift: Q-curve approximating an arc of half-angle h
    // wants the control at radius r/cos(h). Tiny correction for our small
    // segments (h ≈ π/N/2 ≈ 7–8°) but matters - without it the chord
    // bulges INWARD and the ellipse looks slightly polygonal.
    const half = (a - prevA) / 2;
    const lift = 1 / Math.max(Math.cos(half), 0.5);
    const ctrlRx = (rx + radial()) * lift;
    const ctrlRy = (ry + radial()) * lift;
    const ctrlX = cx + ctrlRx * Math.cos(aMid);
    const ctrlY = cy + ctrlRy * Math.sin(aMid);
    const [tx2, ty2] = pt(a);
    d += ` Q ${ctrlX} ${ctrlY} ${tx2} ${ty2}`;
    prevA = a;
    endX = tx2;
    endY = ty2;
  }

  // Forward tangent at the arc endpoint (clockwise motion, SVG y-down).
  // For ellipse (cx + rx·cos a, cy + ry·sin a), d/da is (-rx·sin a, ry·cos a).
  const tx = -rx * Math.sin(endA);
  const ty = ry * Math.cos(endA);
  const tlen = Math.hypot(tx, ty) || 1;
  const tDX = tx / tlen;
  const tDY = ty / tlen;
  // Flap length scales with MAX radius - wide ellipses get proportional
  // flaps instead of the stubby min-radius-scaled tail (which on a long
  // horizontal ellipse read as a "drip" rather than a "kept going past
  // the loop"). Capped so giant circles don't grow giant tails.
  const flapLen =
    Math.max(6, Math.min(34, maxR * 0.08)) + auxRng() * 3;
  // PURE TANGENT extension - no perpendicular drift. Drift breaks C1
  // continuity at the arc/line join, which reads as a "kink" or "drip"
  // (especially bad on elongated ellipses). Pure tangent matches the
  // arc's direction at the endpoint exactly, so the flap reads as a
  // natural continuation that just stops curving - like the pen kept
  // moving past where the loop closed.
  const flapX = endX + tDX * flapLen;
  const flapY = endY + tDY * flapLen;

  d += ` L ${flapX} ${flapY}`;
  return [d];
}
