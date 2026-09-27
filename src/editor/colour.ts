/** Colour maths and parsing for the colour picker. Pure and DOM-free, so the
 *  store, tests and hosts can use it.
 *
 *  Everything the picker writes is a lower-case `#rrggbb` literal (see
 *  custom-palette.ts `normaliseHex`); the other models here exist to edit
 *  and read that value. */

import { normaliseHex } from './custom-palette';
import { cssNamedColour } from './colour-names';

export type Rgb = { r: number; g: number; b: number };
/** Hue in degrees [0, 360); saturation and value in [0, 1]. */
export type Hsv = { h: number; s: number; v: number };
/** Hue in degrees [0, 360); saturation and lightness in [0, 1]. */
export type Hsl = { h: number; s: number; l: number };

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

/** Wrap an angle into [0, 360). */
export const wrapHue = (h: number) => ((h % 360) + 360) % 360;

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (c: number) =>
    Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const d = max - Math.min(rr, gg, bb);
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
  }
  return { h: wrapHue(h * 60), s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const f = (n: number) => {
    const k = (n + wrapHue(h) / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return { r: f(5), g: f(3), b: f(1) };
}

export function rgbToHsl(rgb: Rgb): Hsl {
  const { h, s: sv, v } = rgbToHsv(rgb);
  const l = v * (1 - sv / 2);
  const s = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb({ h, s: v === 0 ? 0 : 2 * (1 - l / v), v });
}

export const hexToHsv = (hex: string) => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: Hsv) => rgbToHex(hsvToRgb(hsv));

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Black or white, whichever reads better on `hex` - for a check mark or
 *  label drawn on a swatch. */
export function inkOn(hex: string): '#000000' | '#ffffff' {
  return luminance(hex) > 0.4 ? '#000000' : '#ffffff';
}

/** OKLCH (L 0…1, C ≥ 0, h degrees) to `#rrggbb`. Out-of-gamut colours keep
 *  their lightness and hue and lose chroma until they fit sRGB, which is
 *  how the library's generated ramps stay vivid without clipping to a
 *  different hue. */
export function oklchToHex(L: number, C: number, h: number): string {
  const toLinear = (c: number) => {
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  };
  const inGamut = (rgb: number[]) =>
    rgb.every((c) => c >= -0.0005 && c <= 1.0005);
  let lin = toLinear(C);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(toLinear(mid))) lo = mid;
      else hi = mid;
    }
    lin = toLinear(lo);
  }
  const gamma = (c: number) => {
    const x = clamp(c, 0, 1);
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  };
  return rgbToHex({
    r: gamma(lin[0]) * 255,
    g: gamma(lin[1]) * 255,
    b: gamma(lin[2]) * 255,
  });
}

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const FUNC_RE = new RegExp(
  String.raw`^(rgba?|hsla?)\(\s*(${NUM})(%|deg)?\s*[,\s]\s*(${NUM})(%)?\s*[,\s]\s*(${NUM})(%)?\s*(?:[,/]\s*${NUM}%?\s*)?\)$`,
  'i',
);
const TRIPLET_RE = new RegExp(
  String.raw`^(${NUM})\s*[,\s]\s*(${NUM})\s*[,\s]\s*(${NUM})$`,
);

/** Read whatever the user typed or pasted as a colour, as `#rrggbb`, or null.
 *  Accepts hex with or without `#` (3 or 6 digits), `rgb()` / `rgba()`
 *  (alpha dropped: opacity has its own control), `hsl()` / `hsla()`, a bare
 *  `r, g, b` triplet, and CSS colour names (`tomato`, `rebeccapurple`). */
export function parseColour(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const hex = normaliseHex(t.startsWith('#') ? t : `#${t}`);
  if (hex) return hex;
  const named = cssNamedColour(t.replace(/[\s_-]+/g, ''));
  if (named) return named;
  const fn = FUNC_RE.exec(t);
  if (fn) {
    const [, kind, a, aUnit, b, bUnit, c, cUnit] = fn;
    if (kind.startsWith('rgb')) {
      const ch = (v: string, pct?: string) =>
        pct ? (parseFloat(v) / 100) * 255 : parseFloat(v);
      if (aUnit === 'deg') return null;
      return rgbToHex({ r: ch(a, aUnit), g: ch(b, bUnit), b: ch(c, cUnit) });
    }
    if (aUnit === '%') return null;
    return rgbToHex(
      hslToRgb({
        h: wrapHue(parseFloat(a)),
        s: clamp(parseFloat(b) / 100, 0, 1),
        l: clamp(parseFloat(c) / 100, 0, 1),
      }),
    );
  }
  const tri = TRIPLET_RE.exec(t);
  if (tri) {
    const [r, g, b] = tri.slice(1).map(Number);
    if ([r, g, b].every((n) => n >= 0 && n <= 255)) return rgbToHex({ r, g, b });
  }
  return null;
}
