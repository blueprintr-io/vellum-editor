/* Prism gradients - Blueprintr's brand gradient language ported to SVG.
 *
 * Stop colours are copied verbatim from Blueprintr.io's `--*-prism-gradient`
 * tokens. Every ramp is PALINDROMIC (a 3-colour brand ramp mirrored back to
 * its start) - that's what lets the paint server use `spreadMethod="repeat"`
 * and scroll forever with no visible seam. Do not "simplify" them to 3 stops.
 *
 * This module is deliberately React-free so the renderer (PrismDefs.tsx,
 * Shape.tsx), the inspector, canvas-export.ts and gif.ts all import ONE copy
 * of the timing constants - gif.ts's FLOW_CONFIG comment already documents
 * what happens when animation constants get duplicated across CSS and TS.
 */
import type { PrismPalette, PrismSpeed, Shape } from '@/store/types';

export const PRISM_PALETTE_IDS: readonly PrismPalette[] = [
  'vellum',
  'stratum',
  'podium',
  'continuum',
];

/** Tooltip text for the inspector chips. Named after the Blueprintr surface
 *  each ramp brands, so a user who has seen blueprintr.io recognises them. */
export const PRISM_LABELS: Record<PrismPalette, string> = {
  vellum: 'vellum - violet → sky → emerald',
  stratum: 'stratum - bronze → gold',
  podium: 'podium - navy → ice',
  continuum: 'continuum - violet → fuchsia',
};

/** [offset, hex] pairs. Five stops, palindromic, evenly spaced. */
export const PRISM_STOPS: Record<
  PrismPalette,
  readonly (readonly [number, string])[]
> = {
  vellum: [
    [0, '#7c3aed'], // violet-600
    [0.25, '#0ea5e9'], // sky-500
    [0.5, '#10b981'], // emerald-500 (peak)
    [0.75, '#0ea5e9'], // sky-500
    [1, '#7c3aed'], // violet-600 - wrap
  ],
  stratum: [
    [0, '#78350f'], // amber-900
    [0.25, '#d97706'], // amber-600
    [0.5, '#fbbf24'], // amber-400 (peak)
    [0.75, '#d97706'],
    [1, '#78350f'],
  ],
  podium: [
    [0, '#1e3a8a'], // blue-900
    [0.25, '#3b82f6'], // blue-500
    [0.5, '#93c5fd'], // blue-300 (peak)
    [0.75, '#3b82f6'],
    [1, '#1e3a8a'],
  ],
  continuum: [
    [0, '#2e1065'], // violet-950
    [0.25, '#9333ea'], // purple-600
    [0.5, '#d946ef'], // fuchsia-500 (peak)
    [0.75, '#9333ea'],
    [1, '#2e1065'],
  ],
};

/** One ramp period in canvas WORLD units. A typical 160–220px shape spans
 *  ~55–80% of a period, so you read a genuine sweep across it rather than a
 *  flat sample (period too long) or a busy rainbow (period too short). */
export const PRISM_PERIOD_UNITS = 280;

/** Seconds per full cycle. `normal` = Blueprintr's canonical 18s. The timing
 *  function is always linear - easing an infinite scroll pumps visibly. 0
 *  means "emit no animateTransform at all". */
export const PRISM_SECONDS: Record<PrismSpeed, number> = {
  static: 0,
  slow: 30,
  normal: 18,
  fast: 9,
};

export const PRISM_SPEED_IDS: readonly PrismSpeed[] = [
  'static',
  'slow',
  'normal',
  'fast',
];

/** Phase used for reduced-motion parking AND for frozen raster exports.
 *  1/8 of a cycle is the exact analogue of Blueprintr's reduced-motion
 *  `background-position: 25% 50%` on a 0%→200% sweep - a mid-ramp blend,
 *  deliberately NOT the seam. Parking at 0 on a palindromic ramp would render
 *  a flat wall of the palette's first colour. */
export const PRISM_PARKED_PHASE = 0.125;

/* Pulse envelope. Blueprintr's `bp-shape-reveal-pulse` is 0 → peak → 0, and
 * it's a ONE-SHOT `forwards` animation. Looped verbatim the outline vanishes
 * completely for a beat every cycle and reads as a flicker bug - so the floor
 * is raised to 0.45. The held 20%/55% plateau and the cubic-bezier(0.22, 1,
 * 0.36, 1) feel are kept exactly. */
export const PRISM_PULSE_SECONDS = 2.4;
export const PRISM_PULSE_FLOOR = 0.45;
export const PRISM_PULSE_VALUES = `${PRISM_PULSE_FLOOR};1;1;${PRISM_PULSE_FLOOR}`;
export const PRISM_PULSE_KEYTIMES = '0;0.2;0.55;1';
/** n−1 = 3 splines for 4 values. The linear middle spline holds the plateau
 *  flat between 20% and 55%. */
export const PRISM_PULSE_SPLINES = '0.22 1 0.36 1;0 0 1 1;0.22 1 0.36 1';

/** Soft cap: past this many prism shapes we keep the colours and drop the
 *  motion. A translating paint server repaints every referencing element each
 *  frame and can't be promoted to a compositor layer, so the cost is actual and
 *  scales with the number of referencing elements. */
export const PRISM_MAX_ANIMATED = 80;

/** SVG caches paint servers by id - Connector.tsx documents the exact bug
 *  (two markers of different size sharing an id, the second silently reusing
 *  the first's definition). So the id must encode every parameter that varies
 *  the definition: palette and speed, and nothing else does. */
export function prismGradientId(
  palette: PrismPalette,
  speed: PrismSpeed = 'normal',
): string {
  return `vellum-prism-${palette}-${speed}`;
}

/** Kind-only gate - used at CREATION time (defaultShapeFromTool / insert.ts)
 *  where `frame` doesn't exist yet, so icons return false. */
export function shapeKindSupportsPrismStroke(kind: Shape['kind']): boolean {
  switch (kind) {
    case 'rect':
    case 'service':
    case 'ellipse':
    case 'diamond':
    case 'polygon':
    case 'container':
    case 'freehand':
    case 'table':
    case 'rack':
    case 'text':
      return true;
    // group  → paints stroke="none"; there is no outline to gradient.
    // image  → paints no outline for an actual bitmap.
    // note   → hard-codes var(--note-ink) at width 1.1 and ignores
    //          shape.stroke entirely; brown ink on yellow paper IS the
    //          sticky-note's identity.
    // icon   → only when framed. See shapeSupportsPrismStroke.
    default:
      return false;
  }
}

/** THE gate. The renderer and the inspector both call this, so the panel can
 *  never offer a control that would silently paint nothing. */
export function shapeSupportsPrismStroke(shape: Shape): boolean {
  if (shape.kind === 'icon') return shape.frame !== undefined;
  return shapeKindSupportsPrismStroke(shape.kind);
}

export type ResolvedPrism = {
  palette: PrismPalette;
  speed: PrismSpeed;
  pulse: boolean;
};

/** null unless the shape both HAS a gradient and is a kind that can paint
 *  one. Returning null is what makes the flat-stroke path byte-identical to
 *  what it was before this feature landed. */
export function resolvePrismStroke(shape: Shape): ResolvedPrism | null {
  const g = shape.strokeGradient;
  if (!g || !g.palette || !PRISM_STOPS[g.palette]) return null;
  if (!shapeSupportsPrismStroke(shape)) return null;
  return {
    palette: g.palette,
    speed: g.speed && g.speed in PRISM_SECONDS ? g.speed : 'normal',
    pulse: g.pulse === true,
  };
}

/** CSS equivalent of a palette, for the inspector's preview chips. A
 *  `url(#…)` reference paints NOTHING as a CSS background, so the picker
 *  needs its own preview string built from the same stop constants. */
export function prismCssPreview(p: PrismPalette): string {
  const stops = PRISM_STOPS[p]
    .map(([o, hex]) => `${hex} ${o * 100}%`)
    .join(', ');
  return `linear-gradient(90deg, ${stops})`;
}

/** Solve cubic-bezier(x1, y1, x2, y2) for y at a given x. Newton with 8
 *  iterations - ample over a 0..1 domain and far cheaper than a lookup
 *  table. */
function bezierY(
  x: number,
  [x1, y1, x2, y2]: [number, number, number, number],
): number {
  const cx = (t: number) =>
    3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
  const cy = (t: number) =>
    3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
  const dcx = (t: number) =>
    3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
  let t = x;
  for (let i = 0; i < 8; i++) {
    const d = dcx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= (cx(t) - x) / d;
    t = Math.min(1, Math.max(0, t));
  }
  return cy(t);
}

const PULSE_TIMES = [0, 0.2, 0.55, 1];
const PULSE_SPLINES: [number, number, number, number][] = [
  [0.22, 1, 0.36, 1],
  [0, 0, 1, 1],
  [0.22, 1, 0.36, 1],
];

/** Evaluate the pulse envelope at phase 0..1. Used by the GIF baker so a
 *  baked `stroke-opacity` matches the SMIL curve exactly rather than
 *  approximating it. */
export function prismPulseAt(phase01: number): number {
  const t = ((phase01 % 1) + 1) % 1;
  const vals = [PRISM_PULSE_FLOOR, 1, 1, PRISM_PULSE_FLOOR];
  let i = 0;
  while (i < 3 && t > PULSE_TIMES[i + 1]) i++;
  const span = PULSE_TIMES[i + 1] - PULSE_TIMES[i];
  const local = span > 0 ? (t - PULSE_TIMES[i]) / span : 0;
  const e = bezierY(local, PULSE_SPLINES[i]);
  return vals[i] + (vals[i + 1] - vals[i]) * e;
}
