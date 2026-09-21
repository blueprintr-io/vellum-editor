/* Export options - the pure half of the image-export pipeline.
 *
 * Everything in this module is DOM-free so it runs under `node --test`
 * (see tests/export-options.test.ts). The DOM-touching halves live in
 * `fonts.ts` (webfont embedding), `flatten.ts` (foreignObject → <text>)
 * and `../canvas-export.ts` (clone + crop + scrub); byte-level format
 * work (PNG chunks, PDF, ZIP) is in `binary.ts`. */

/** What paints behind the diagram.
 *  - `paper` - the canvas paper the user is looking at: the Settings
 *                    paper override when one is set, else the theme token.
 *  - `transparent` - alpha-transparent (PNG / WebP / SVG only; JPG, PDF
 *                    and GIF have no alpha channel and fall back to `paper`).
 *  - `white` - plain #ffffff regardless of theme.
 *  - `custom` - `ExportPrefs.customColor`. */
export type ExportBackground = 'paper' | 'transparent' | 'white' | 'custom';
export type RasterFormat = 'png' | 'jpg' | 'webp';
export type ImageFormat = RasterFormat | 'svg' | 'pdf' | 'gif';
export type ExportFormat = 'vellum' | ImageFormat;
/** Which theme's tokens colour the export. `current` = what's on screen. */
export type ExportTheme = 'current' | 'light' | 'dark';
/** What region to crop to. `viewport` = exactly what's on screen now. */
export type ExportArea = 'diagram' | 'selection' | 'viewport';

export const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpg', 'webp', 'svg', 'pdf', 'gif'];
export const RASTER_FORMATS: readonly RasterFormat[] = ['png', 'jpg', 'webp'];

/** User-tunable export settings. Persisted on the editor store so the
 *  dialog (and the one-click Copy button) remember the last choice. */
export interface ExportPrefs {
  /** Output pixels per world unit for raster formats. 2× is the retina
   *  default; 1× matches the on-screen size at 100% zoom. */
  scale: number;
  /** Margin around the content bbox, in world units (= pixels at 1×). */
  padding: number;
  background: ExportBackground;
  /** Colour used when `background === 'custom'`. Any CSS colour. */
  customColor: string;
  /** SVG only - inline the webfonts the diagram uses as data: URLs so the
   *  file renders with the same faces outside the editor. */
  embedFonts: boolean;
  /** Last image format picked in the dialog; "Export image…" reopens on it. */
  format: ImageFormat;
  /** JPG / WebP encoder quality, 0.5–1. */
  quality: number;
  theme: ExportTheme;
  /** Legacy persisted preference. Editable source now requires explicit
   *  consent for each export; defaults and clipboard exports omit it. */
  embedSource: boolean;
}

export const DEFAULT_EXPORT_PREFS: ExportPrefs = {
  scale: 2,
  padding: 24,
  background: 'paper',
  customColor: '#ffffff',
  embedFonts: true,
  format: 'png',
  quality: 0.92,
  theme: 'current',
  embedSource: false,
};

export const SCALE_OPTIONS: readonly number[] = [1, 2, 3, 4];
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 16;
export const MAX_PADDING = 400;
export const MIN_QUALITY = 0.5;

/** Hard ceiling per side for a 2D canvas in Chromium / Firefox. Above
 *  this `toBlob` returns null (or the canvas silently goes blank). */
export const MAX_RASTER_EDGE = 16384;
/** Hard ceiling on total pixels - ~400 MB of RGBA is where even a desktop
 *  browser starts failing allocations. */
export const MAX_RASTER_PIXELS = 100_000_000;
/** Safari (and memory on weaker machines) gets uncomfortable well before
 *  the hard ceiling - the dialog warns past this. */
export const LARGE_RASTER_EDGE = 8192;

/** CSS reference pixel density. A 1× export prints at the same physical
 *  size as the 100%-zoom canvas; the DPI stamp scales with the export. */
export const BASE_DPI = 96;

const BACKGROUNDS: readonly ExportBackground[] = ['paper', 'transparent', 'white', 'custom'];
const THEMES: readonly ExportTheme[] = ['current', 'light', 'dark'];

function finite(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Validate + clamp a persisted (or otherwise untrusted) prefs object.
 *  Unknown keys are dropped, missing keys fall back to the defaults, and
 *  numbers are clamped into range so a hand-edited localStorage entry
 *  can't ask for a 40k-pixel export. */
export function sanitizeExportPrefs(raw: unknown): ExportPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const background = BACKGROUNDS.includes(r.background as ExportBackground)
    ? (r.background as ExportBackground)
    : DEFAULT_EXPORT_PREFS.background;
  const customColor =
    typeof r.customColor === 'string' && r.customColor.trim()
      ? r.customColor.trim()
      : DEFAULT_EXPORT_PREFS.customColor;
  const format = IMAGE_FORMATS.includes(r.format as ImageFormat)
    ? (r.format as ImageFormat)
    : DEFAULT_EXPORT_PREFS.format;
  const theme = THEMES.includes(r.theme as ExportTheme)
    ? (r.theme as ExportTheme)
    : DEFAULT_EXPORT_PREFS.theme;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, finite(r.scale, DEFAULT_EXPORT_PREFS.scale))),
    padding: Math.round(
      Math.min(MAX_PADDING, Math.max(0, finite(r.padding, DEFAULT_EXPORT_PREFS.padding))),
    ),
    background,
    customColor,
    embedFonts: bool(r.embedFonts, DEFAULT_EXPORT_PREFS.embedFonts),
    format,
    quality: Math.min(1, Math.max(MIN_QUALITY, finite(r.quality, DEFAULT_EXPORT_PREFS.quality))),
    theme,
    embedSource: bool(r.embedSource, DEFAULT_EXPORT_PREFS.embedSource),
  };
}

/** Formats with an alpha channel. Everything else resolves a transparent
 *  request to the paper colour. */
export function supportsAlpha(format: ImageFormat): boolean {
  return format === 'png' || format === 'webp' || format === 'svg';
}

export function isRasterFormat(format: ExportFormat): format is RasterFormat {
  return format === 'png' || format === 'jpg' || format === 'webp';
}

/** Formats that can carry the embedded `.vellum` source. */
export function supportsEmbeddedSource(format: ImageFormat): boolean {
  return format === 'png' || format === 'svg';
}

/** Formats with an encoder quality knob. */
export function hasQuality(format: ExportFormat): boolean {
  return format === 'jpg' || format === 'webp';
}

export function mimeTypeFor(format: RasterFormat): 'image/png' | 'image/jpeg' | 'image/webp' {
  return format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
}

export function formatLabel(format: ExportFormat): string {
  return format === 'vellum' ? '.vellum' : format.toUpperCase();
}

/** Output bitmap size for a 1× content size at `scale`. Never below 1px. */
export function rasterSize(
  w: number,
  h: number,
  scale: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** Largest scale ≤ `scale` whose output still fits `maxEdge` on both
 *  sides. Returns `scale` unchanged when it already fits. */
export function clampScaleToEdge(
  w: number,
  h: number,
  scale: number,
  maxEdge: number = MAX_RASTER_EDGE,
): number {
  const longest = Math.max(w, h);
  if (longest <= 0) return scale;
  const cap = maxEdge / longest;
  return Math.min(scale, cap);
}

/** Largest scale ≤ `scale` that satisfies both the per-side and the total
 *  pixel ceilings. */
export function clampScale(
  w: number,
  h: number,
  scale: number,
  limits: { maxEdge?: number; maxPixels?: number } = {},
): number {
  const byEdge = clampScaleToEdge(w, h, scale, limits.maxEdge ?? MAX_RASTER_EDGE);
  const area = w * h;
  if (area <= 0) return byEdge;
  const byArea = Math.sqrt((limits.maxPixels ?? MAX_RASTER_PIXELS) / area);
  return Math.max(MIN_SCALE, Math.min(byEdge, byArea));
}

/** Scale that makes a 1× width of `baseW` come out at `targetW` pixels. */
export function scaleForWidth(baseW: number, targetW: number): number {
  if (baseW <= 0 || !Number.isFinite(targetW) || targetW <= 0) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetW / baseW));
}

/** DPI stamped on raster exports: 96 × scale, so an export occupies the
 *  same physical size on a page whatever scale was picked. */
export function dpiForScale(scale: number): number {
  return Math.round(BASE_DPI * scale);
}

/** Resolve the user's background choice to a concrete CSS colour, or
 *  `null` for transparent. Formats without an alpha channel (JPG, PDF,
 *  GIF) never return null - a transparent request falls back to the
 *  paper colour, which is what the user is looking at, rather than
 *  baking the encoder's default (black). */
export function resolveBackground(opts: {
  background: ExportBackground;
  customColor: string;
  paperColour: string;
  format: ImageFormat;
}): string | null {
  const { background, customColor, paperColour, format } = opts;
  switch (background) {
    case 'transparent':
      return supportsAlpha(format) ? null : paperColour;
    case 'white':
      return '#ffffff';
    case 'custom':
      return customColor.trim() || '#ffffff';
    case 'paper':
    default:
      return paperColour;
  }
}

/** `2040 × 1120 px` - the readout under the preview. */
export function formatDimensions(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)} px`;
}

/** Turn a diagram title into a safe download filename with `ext`
 *  (no leading dot). Strips path separators and control characters,
 *  collapses whitespace, falls back to `untitled`. */
export function exportFilename(title: string | undefined, ext: string): string {
  const safe = sanitizeFilenameBase(title);
  return `${safe}.${ext.replace(/^\./, '')}`;
}

/** The filename without extension, sanitised the same way. */
export function sanitizeFilenameBase(title: string | undefined): string {
  const base = (title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return base || 'untitled';
}

/** Strip a known image extension so a user-edited filename field can be
 *  re-suffixed when the format changes. */
export function stripImageExtension(name: string): string {
  return name.replace(/\.(png|jpe?g|webp|svg|pdf|gif|zip|vellum)$/i, '');
}

/** Parse a CSS `unicode-range` descriptor value into inclusive codepoint
 *  intervals. Handles single points (`U+131`), ranges (`U+0-FF`) and
 *  wildcards (`U+4??`). Unparseable tokens are skipped. */
export function parseUnicodeRange(value: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tok of value.split(',')) {
    const t = tok.trim().toUpperCase();
    if (!t) continue;
    const m = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/.exec(t);
    if (!m) continue;
    const [, a, b] = m;
    if (a.includes('?')) {
      const lo = parseInt(a.replace(/\?/g, '0'), 16);
      const hi = parseInt(a.replace(/\?/g, 'F'), 16);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
      continue;
    }
    const lo = parseInt(a, 16);
    const hi = b ? parseInt(b, 16) : lo;
    if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
  }
  return out;
}

/** True if any of `codepoints` falls inside one of `ranges`. An empty
 *  `ranges` list means "no restriction" (the @font-face had no
 *  unicode-range descriptor) and always matches. */
export function rangesCoverAny(
  ranges: ReadonlyArray<readonly [number, number]>,
  codepoints: Iterable<number>,
): boolean {
  if (ranges.length === 0) return true;
  for (const cp of codepoints) {
    for (const [lo, hi] of ranges) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

/** Pick the face weight the browser would use for `desired` from the
 *  weights a family actually ships - the CSS Fonts 4 matching rule:
 *  ≤400 prefers lighter faces first, ≥500 prefers heavier first, and the
 *  400/500 pair are each other's first fallback. */
export function nearestWeight(available: readonly number[], desired: number): number {
  if (available.length === 0) return desired;
  if (available.includes(desired)) return desired;
  const sorted = [...available].sort((a, b) => a - b);
  const below = sorted.filter((w) => w < desired);
  const above = sorted.filter((w) => w > desired);
  const lighter = below.length ? below[below.length - 1] : undefined;
  const heavier = above.length ? above[0] : undefined;
  if (desired === 400 && available.includes(500)) return 500;
  if (desired === 500 && available.includes(400)) return 400;
  if (desired <= 400) return lighter ?? heavier ?? desired;
  return heavier ?? lighter ?? desired;
}

/** Split a CSS `font-family` list into bare family names (quotes and
 *  surrounding whitespace removed). `"'Outfit', system-ui"` →
 *  `['Outfit', 'system-ui']`. */
export function parseFamilyList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** Human-readable size for the dialog (`1.2 MB`, `340 KB`). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
