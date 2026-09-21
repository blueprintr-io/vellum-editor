/** Single source of truth for fill/stroke colour swatches.
 *
 *  Each swatch has an `id` (its logical identity), a `cssVar` (the storage
 *  form - what gets persisted on shapes/connectors so that theme switches
 *  flow through CSS automatically), and the literal hexes for both themes.
 *  The hexes exist for two reasons:
 *
 *    1. `resolveSwatchColor()` uses them to recognise legacy hex values that
 *       predate the var()-based palette and route them to the same var,
 *       so existing diagrams autoswitch when the user toggles theme.
 *
 *    2. The inspector's active-state detection compares the saved value
 *       against any of {cssVar, lightHex, darkHex} so a shape painted in
 *       one theme still highlights the right swatch when viewed in the
 *       other.
 *
 *  Why store `var(...)` strings on shapes at all? Because SVG attributes
 *  resolve CSS variables natively at paint time - no render-side branching
 *  required for new shapes. The only branching we keep is the legacy hex
 *  remap, which earns its keep on diagrams from before this change. */

export type Swatch = {
  /** Stable identity. Not stored anywhere - purely for code that wants to
   *  refer to a swatch by name (e.g. in tests or future tools). */
  id: string;
  label: string;
  /** What ends up on `shape.fill` / `shape.stroke`. CSS-var form so SVG
   *  resolves it against the theme automatically. */
  cssVar: string;
  /** Literal value the var resolves to in light mode. Used for legacy-hex
   *  recognition only - the renderer never reads this directly. */
  lightHex: string;
  /** Literal value the var resolves to in dark mode. Same role as
   *  lightHex - recognition, not rendering. */
  darkHex: string;
};

/** Theme-aware swatches that flip through CSS vars on their own; we never
 *  remap these. Listed here so the inspector's active-state matcher can tell
 *  "default" / "ink" / "paper" / "mono" apart from the legacy hex values
 *  the named-colour swatches used to take. */
export const STATIC_SWATCH_VALUES = new Set<string>([
  'var(--ink)',
  'var(--paper)',
  'var(--mono)',
]);

/** Coloured fills. Both hexes line up with what tokens.css writes for
 *  --fill-{name} under each theme - keep them in sync if you tweak either
 *  one.
 *
 *  Ordered by colour-wheel position (red → orange → amber → green → teal →
 *  blue → indigo → violet → pink) so the swatch row reads as a continuous
 *  hue gradient. */
export const FILL_SWATCHES: Swatch[] = [
  { id: 'red', label: 'red', cssVar: 'var(--fill-red)', lightHex: '#fee2e2', darkHex: '#4a2424' },
  { id: 'orange', label: 'orange', cssVar: 'var(--fill-orange)', lightHex: '#ffedd5', darkHex: '#4a3318' },
  { id: 'amber', label: 'amber', cssVar: 'var(--fill-amber)', lightHex: '#fff3c4', darkHex: '#4a3f1c' },
  { id: 'green', label: 'green', cssVar: 'var(--fill-green)', lightHex: '#dcfce7', darkHex: '#1f4332' },
  { id: 'teal', label: 'teal', cssVar: 'var(--fill-teal)', lightHex: '#ccfbf1', darkHex: '#1a4a44' },
  { id: 'blue', label: 'blue', cssVar: 'var(--fill-blue)', lightHex: '#dbeafe', darkHex: '#1f2f4a' },
  { id: 'indigo', label: 'indigo', cssVar: 'var(--fill-indigo)', lightHex: '#e0e7ff', darkHex: '#2a2f4a' },
  { id: 'violet', label: 'violet', cssVar: 'var(--fill-violet)', lightHex: '#f3e8ff', darkHex: '#3a224a' },
  { id: 'pink', label: 'pink', cssVar: 'var(--fill-pink)', lightHex: '#fce7f3', darkHex: '#4a223a' },
];

/** Coloured strokes. Same conventions as FILL_SWATCHES. The light values are
 *  the original Vellum stroke palette so legacy diagrams resolve correctly. */
export const STROKE_SWATCHES: Swatch[] = [
  { id: 'red', label: 'red', cssVar: 'var(--stroke-red)', lightHex: '#c83e1d', darkHex: '#f7755a' },
  { id: 'orange', label: 'orange', cssVar: 'var(--stroke-orange)', lightHex: '#ea580c', darkHex: '#fb923c' },
  { id: 'amber', label: 'amber', cssVar: 'var(--stroke-amber)', lightHex: '#e09f3e', darkHex: '#f5c277' },
  { id: 'green', label: 'green', cssVar: 'var(--stroke-green)', lightHex: '#2e8b57', darkHex: '#5fc285' },
  { id: 'teal', label: 'teal', cssVar: 'var(--stroke-teal)', lightHex: '#0d9488', darkHex: '#5fc2b8' },
  { id: 'blue', label: 'blue', cssVar: 'var(--stroke-blue)', lightHex: '#1f6feb', darkHex: '#6aa4ff' },
  { id: 'indigo', label: 'indigo', cssVar: 'var(--stroke-indigo)', lightHex: '#4f46e5', darkHex: '#818cf8' },
  { id: 'violet', label: 'violet', cssVar: 'var(--stroke-violet)', lightHex: '#7f3fbf', darkHex: '#b07ce0' },
  { id: 'pink', label: 'pink', cssVar: 'var(--stroke-pink)', lightHex: '#db2777', darkHex: '#f0689f' },
];

/** Ids of the named-colour swatches (red…pink). These are the only swatches
 *  whose fill and stroke ladders differ - paper/ink rungs are identical
 *  across kinds, and `mono` has no ladder. The fill shade picker uses this
 *  to decide which swatches get the saturated "stroke-level" second row
 *  (see StyleControls.tsx): a desaturated fill ladder can never reach the
 *  vivid stroke hue, so for these colours we expose the stroke ladder as a
 *  pickable fill. */
export const NAMED_SWATCH_IDS: ReadonlySet<string> = new Set(
  FILL_SWATCHES.map((s) => s.id),
);

/** Shade rungs. The base swatch above sits at -300 (or -200 in light mode);
 *  the ladder exposes 5 cells - lightest tint to deepest - that the user can
 *  reach by right-clicking a swatch or clicking its chevron. Each rung resolves
 *  through tokens.css `--{kind}-{colour}-{rung}` so theme-switch flips them
 *  alongside the base swatch (the "remember the dark/light versions" rule). */
export const SHADE_RUNGS = ['100', '200', '300', '400', '500'] as const;
export type ShadeRung = (typeof SHADE_RUNGS)[number];

/** Build the ladder var name for a swatch + rung. Centralised so the renderer
 *  resolver and the picker UI agree on the spelling. */
export function shadeVar(
  kind: 'fill' | 'stroke',
  colour: string,
  rung: ShadeRung,
): string {
  return `var(--${kind}-${colour}-${rung})`;
}

/** All five shade values for a given swatch, in light → deep order. The
 *  picker uses this to render a row of cells; the renderer uses it to
 *  identify whether a stored value is part of a ladder (so the chevron
 *  badges the right swatch as "active"). */
export function shadeLadder(
  kind: 'fill' | 'stroke',
  colour: string,
): { rung: ShadeRung; cssVar: string }[] {
  return SHADE_RUNGS.map((r) => ({ rung: r, cssVar: shadeVar(kind, colour, r) }));
}

// Build hex → cssVar lookup tables once. Lower-cased so a saved "#FEE2E2"
// matches the canonical "#fee2e2" entry. The renderer hits these on every
// frame so the cost matters; a Map of literal strings is cheaper than
// scanning the array for each shape.
const FILL_HEX_TO_VAR = buildHexLookup(FILL_SWATCHES);
const STROKE_HEX_TO_VAR = buildHexLookup(STROKE_SWATCHES);

function buildHexLookup(swatches: Swatch[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of swatches) {
    m.set(s.lightHex.toLowerCase(), s.cssVar);
    m.set(s.darkHex.toLowerCase(), s.cssVar);
  }
  return m;
}

/** Map a stored colour value to its theme-aware form.
 *
 *  - `var(--*)` and falsy / "transparent" / "none" pass through unchanged
 * - they're already theme-aware (or intentionally not coloured).
 *  - A hex that matches a known light- OR dark-mode swatch hex returns the
 *    matching `var(...)` so it autoswitches.
 *  - Custom hexes the user entered via the colour picker pass through
 *    unchanged - we don't have a logical identity for them, so we honour
 *    the literal choice.
 *
 *  Call this from renderers (Shape, Connector, anywhere a saved colour
 *  string hits an SVG attribute) AND from the inspector's active-state
 *  matcher so legacy hex-stored shapes both autoswitch and light up the
 *  right swatch cell. */
export function resolveSwatchColor(
  value: string | undefined,
  kind: 'fill' | 'stroke',
): string | undefined {
  if (!value) return value;
  if (value === 'transparent' || value === 'none') return value;
  if (value.startsWith('var(')) return value;
  const lookup = kind === 'fill' ? FILL_HEX_TO_VAR : STROKE_HEX_TO_VAR;
  return lookup.get(value.toLowerCase()) ?? value;
}
