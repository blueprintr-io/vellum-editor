/** The colour picker's library: ready-made colours to browse or search.
 *
 *  - Spectrum: 20 families × 11 shades, generated in OKLCH so each step is
 *    an even perceptual move and the families line up (every "500" has
 *    about the same weight). The recipe is below; the hexes are derived
 *    once, the first time the library opens.
 *  - Named: the CSS named colours, so "tomato" or "cornflower blue" finds
 *    the colour everyone knows by that name.
 *  - Colour-blind safe: sets designed to stay distinct under the common
 *    colour-vision deficiencies - the Okabe–Ito palette and Paul Tol's
 *    bright and muted schemes.
 *
 *  Library colours are plain `#rrggbb`, like any other picked colour: they
 *  don't follow the theme the way the swatch row's presets do. */

import { oklchToHex, rgbToHsl, hexToRgb } from './colour';
import { CSS_COLOUR_NAMES, cssNameOf } from './colour-names';

export type LibraryColour = {
  /** Display name: `Blue 500`, `Cornflower blue`, `Vermillion`. */
  name: string;
  hex: string;
  /** Other words search should match: aliases, the CSS spelling. */
  aliases?: string;
};

export type LibraryRow = { label: string; colours: LibraryColour[] };

export type LibraryGroup = {
  id: 'spectrum' | 'named' | 'accessible';
  title: string;
  /** `ramp`: labelled rows, one per family. `grid`: one wrapping grid. */
  layout: 'ramp' | 'grid';
  rows: LibraryRow[];
};

export const SPECTRUM_STEPS = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

// OKLCH lightness for each step. Hues whose most vivid form is light
// (yellows) lift the middle of the ramp; see `lift` below.
const LIGHTNESS = [
  0.975, 0.94, 0.885, 0.815, 0.725, 0.64, 0.565, 0.495, 0.43, 0.37, 0.28,
];
// Share of a family's peak chroma at each step: tints and shades are
// quieter than the middle, as in a hand-made ramp.
const CHROMA = [0.1, 0.22, 0.42, 0.66, 0.88, 1, 0.98, 0.9, 0.78, 0.66, 0.5];
// Neutrals keep their faint tint most of the way down.
const NEUTRAL_CHROMA = [0.25, 0.35, 0.5, 0.7, 0.9, 1, 1, 1, 1, 0.95, 0.85];
// How much of `lift` each step takes, and how much of `drift`.
const LIFT_WEIGHT = [0, 0.1, 0.3, 0.6, 0.85, 1, 0.8, 0.5, 0.3, 0.15, 0];
const DRIFT_WEIGHT = [0, 0, 0, 0, 0, 0, 0.2, 0.45, 0.7, 0.85, 1];

type Family = {
  name: string;
  /** OKLCH hue angle. */
  hue: number;
  /** Peak chroma, at step 500. Out-of-gamut steps lose chroma, not hue. */
  chroma: number;
  /** Lightness added at the middle steps. */
  lift?: number;
  /** Hue change reached at step 950. Yellows turn toward orange as they
   *  darken, or their shades go olive. */
  drift?: number;
  neutral?: boolean;
  /** Extra search words. */
  aliases?: string;
};

const FAMILIES: Family[] = [
  { name: 'Red', hue: 27, chroma: 0.235, aliases: 'scarlet' },
  { name: 'Orange', hue: 49, chroma: 0.2, lift: 0.04, drift: -8, aliases: 'tangerine' },
  { name: 'Amber', hue: 72, chroma: 0.18, lift: 0.1, drift: -18, aliases: 'gold mustard' },
  { name: 'Yellow', hue: 96, chroma: 0.2, lift: 0.18, drift: -22, aliases: 'lemon' },
  { name: 'Lime', hue: 128, chroma: 0.2, lift: 0.12, drift: -4, aliases: 'chartreuse' },
  { name: 'Green', hue: 148, chroma: 0.19, lift: 0.04, aliases: 'grass leaf' },
  { name: 'Emerald', hue: 163, chroma: 0.16, lift: 0.02, aliases: 'jade' },
  { name: 'Teal', hue: 183, chroma: 0.13, lift: 0.02, aliases: 'turquoise' },
  { name: 'Cyan', hue: 212, chroma: 0.14, lift: 0.03, aliases: 'aqua' },
  { name: 'Sky', hue: 236, chroma: 0.16, aliases: 'azure light blue' },
  { name: 'Blue', hue: 260, chroma: 0.2, aliases: 'cobalt' },
  { name: 'Indigo', hue: 276, chroma: 0.21, aliases: 'navy' },
  { name: 'Violet', hue: 292, chroma: 0.24, aliases: 'lavender' },
  { name: 'Purple', hue: 305, chroma: 0.26, aliases: 'plum' },
  { name: 'Fuchsia', hue: 322, chroma: 0.28, aliases: 'magenta' },
  { name: 'Pink', hue: 352, chroma: 0.22, aliases: 'rose' },
  { name: 'Rose', hue: 12, chroma: 0.23, aliases: 'raspberry' },
  { name: 'Slate', hue: 257, chroma: 0.04, neutral: true, aliases: 'grey gray blue grey' },
  { name: 'Grey', hue: 264, chroma: 0.012, neutral: true, aliases: 'gray neutral' },
  { name: 'Stone', hue: 60, chroma: 0.012, neutral: true, aliases: 'grey gray warm taupe' },
];

function spectrumRow(f: Family): LibraryRow {
  return {
    label: f.name,
    colours: SPECTRUM_STEPS.map((step, i) => ({
      name: `${f.name} ${step}`,
      hex: oklchToHex(
        LIGHTNESS[i] + (f.lift ?? 0) * LIFT_WEIGHT[i],
        f.chroma * (f.neutral ? NEUTRAL_CHROMA : CHROMA)[i],
        f.hue + (f.drift ?? 0) * DRIFT_WEIGHT[i],
      ),
      aliases: f.aliases,
    })),
  };
}

/** One entry per colour: Aqua/Cyan and Fuchsia/Magenta share a hex, and
 *  the second name becomes an alias. Sorted greys first (dark → light),
 *  then around the hue wheel, light → dark within each hue band, so the
 *  grid reads as a gradient rather than an alphabet. */
function namedColours(): LibraryColour[] {
  const byHex = new Map<string, LibraryColour>();
  for (const [name, hex] of CSS_COLOUR_NAMES) {
    const css = cssNameOf(name);
    const spellings = css.includes('grey') ? `${css} ${css.replace('grey', 'gray')} ${name.replace('grey', 'gray')}` : css;
    const prior = byHex.get(hex);
    if (prior) prior.aliases = `${prior.aliases ?? ''} ${name} ${spellings}`.trim();
    else byHex.set(hex, { name, hex, aliases: spellings });
  }
  const key = (c: LibraryColour) => {
    const { h, s, l } = rgbToHsl(hexToRgb(c.hex));
    return s < 0.12 ? [0, 0, l] : [1, Math.floor(((h + 15) % 360) / 30), -l];
  };
  return [...byHex.values()].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

const OKABE_ITO: LibraryColour[] = [
  { name: 'Orange', hex: '#e69f00' },
  { name: 'Sky blue', hex: '#56b4e9' },
  { name: 'Bluish green', hex: '#009e73' },
  { name: 'Yellow', hex: '#f0e442' },
  { name: 'Blue', hex: '#0072b2' },
  { name: 'Vermillion', hex: '#d55e00' },
  { name: 'Reddish purple', hex: '#cc79a7' },
  { name: 'Black', hex: '#000000' },
];

const TOL_BRIGHT: LibraryColour[] = [
  { name: 'Blue', hex: '#4477aa' },
  { name: 'Cyan', hex: '#66ccee' },
  { name: 'Green', hex: '#228833' },
  { name: 'Yellow', hex: '#ccbb44' },
  { name: 'Red', hex: '#ee6677' },
  { name: 'Purple', hex: '#aa3377' },
  { name: 'Grey', hex: '#bbbbbb' },
];

const TOL_MUTED: LibraryColour[] = [
  { name: 'Indigo', hex: '#332288' },
  { name: 'Cyan', hex: '#88ccee' },
  { name: 'Teal', hex: '#44aa99' },
  { name: 'Green', hex: '#117733' },
  { name: 'Olive', hex: '#999933' },
  { name: 'Sand', hex: '#ddcc77' },
  { name: 'Rose', hex: '#cc6677' },
  { name: 'Wine', hex: '#882255' },
  { name: 'Purple', hex: '#aa4499' },
];

const accessibleRow = (label: string, colours: LibraryColour[]): LibraryRow => ({
  label,
  colours: colours.map((c) => ({
    ...c,
    aliases: `${label} colour blind colorblind accessible safe`,
  })),
});

let groups: LibraryGroup[] | null = null;

/** Every library group, built on first use. */
export function colourLibrary(): LibraryGroup[] {
  groups ??= [
    {
      id: 'spectrum',
      title: 'Spectrum',
      layout: 'ramp',
      rows: FAMILIES.map(spectrumRow),
    },
    {
      id: 'named',
      title: 'Named colours',
      layout: 'grid',
      rows: [{ label: 'Named', colours: namedColours() }],
    },
    {
      id: 'accessible',
      title: 'Colour-blind safe',
      layout: 'ramp',
      rows: [
        accessibleRow('Okabe–Ito', OKABE_ITO),
        accessibleRow('Tol bright', TOL_BRIGHT),
        accessibleRow('Tol muted', TOL_MUTED),
      ],
    },
  ];
  return groups;
}

/** How many colours the library holds, for the search box's placeholder. */
export function libraryCount(): number {
  return colourLibrary().reduce(
    (n, g) => n + g.rows.reduce((m, r) => m + r.colours.length, 0),
    0,
  );
}

export type LibraryMatch = LibraryColour & { group: string };

/** Colours whose name, aliases, group, row or hex contain every word of
 *  `query`, in library order. "blue 500", "warm grey", "#ff6", "okabe". */
export function searchLibrary(query: string, limit = 80): LibraryMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: LibraryMatch[] = [];
  for (const g of colourLibrary()) {
    for (const row of g.rows) {
      for (const c of row.colours) {
        const hay = `${c.name} ${c.aliases ?? ''} ${row.label} ${g.title} ${c.hex}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) {
          out.push({ ...c, group: g.id === 'accessible' ? row.label : g.title });
          if (out.length === limit) return out;
        }
      }
    }
  }
  return out;
}
