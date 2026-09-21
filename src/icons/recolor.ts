/* Universal icon recolour - rewrite ANY icon's paint to the user's tint.
 *
 *  The original tint path only ever worked for icons that already painted
 *  with `currentColor`: the canvas sets `style.color` on the wrapper <svg>
 *  and the cascade does the rest. That covers Lucide and the packs the
 *  build script pre-rewrote, and nothing else - a multi-colour AWS glyph, a
 *  brand logo, or a user-imported SVG has hard-coded paint that the wrapper
 *  colour can never reach, so the swatch was hidden and the icon was stuck.
 *
 *  This module closes that gap by rewriting the markup itself before it
 *  reaches the canvas. Every concrete paint value is re-expressed in terms
 *  of `currentColor`, which puts the icon back under the wrapper's
 *  `color` - so the tint itself stays a CSS value (`var(--ink)`, a swatch
 *  var), keeps flipping with the theme, and keeps surviving export
 *  (canvas-export copies the computed `color` onto the exported root). The
 *  markup never learns what colour the user picked; it only carries how
 *  much of it each shape should take.
 *
 *  Two modes, because "recolour" means two different things:
 *
 *    solid - every paint becomes the tint. One flat colour. Right for a
 *            glyph-shaped icon; turns a background-plus-knockout icon into
 *            an unreadable blob.
 *
 *    shade - every paint becomes a MIX of the tint and the canvas paper,
 *            weighted by how dark the ORIGINAL colour was. The icon's
 *            internal light/dark structure survives as a tonal ramp of a
 *            single hue (a duotone stamp), which is what keeps an AWS
 *            service icon - coloured tile, white glyph - reading as a
 *            tinted tile with a paper-coloured glyph instead of a solid
 *            rectangle.
 *
 *  `shade` mixes toward paper rather than toward transparency on purpose.
 *  Icon artwork is composed by STACKING: the glyph is an opaque shape drawn
 *  over the tile, not a hole cut in it. Fading the glyph out just reveals
 *  the tile behind it and the icon collapses to a flat square - so the
 *  light end of the ramp has to be a colour, and the only colour that reads
 *  as "background" at any tint and in either theme is the paper itself.
 *
 *  Three paint locations are handled, and each is rewritten WHERE IT IS
 *  so CSS precedence is preserved exactly (inline style > <style> rule >
 *  presentation attribute):
 *
 *    1. presentation attributes - fill="#f90"
 *    2. inline styles - style="fill:#f90"
 *    3. <style> rule bodies - .cls-1{fill:#f90}   (~15% of the packs;
 *       every Illustrator-exported vendor icon uses these)
 *
 *  Rewrites are spliced in by offset, never re-serialised, so untouched
 *  markup comes through byte-identical - valueless attributes, entity
 *  escapes and quote styles all survive for the id-uniquifier that runs
 *  after us in `parseIconSvg`.
 *
 *  This runs at RENDER time on a copy; `shape.iconSvg` keeps the pristine
 *  original, so clearing the tint restores the icon exactly. */

/** How a tint is applied to an icon's markup. Persisted on the shape as
 *  `iconRecolor`; absent means "whatever suits this icon" - see
 *  `defaultRecolorMode`. */
export type IconRecolorMode = 'solid' | 'shade';

/* ── Tuning ──────────────────────────────────────────────────────────── */

/** The light end of the `shade` ramp. Canvas.tsx pins
 *  `--icon-recolor-base` to the effective paper (honouring a Settings →
 *  Paper override, which is an inline background rather than a token
 *  change); `--paper` is the fallback for anything rendered outside the
 *  canvas root. */
const SHADE_BASE = 'var(--icon-recolor-base, var(--paper))';

/** Below this the mix is indistinguishable from the tint itself, so we
 *  emit a plain `currentColor` and keep the markup clean. */
const FULL_TINT = 0.999;

/** Artwork whose darkest tone is still lighter than this has no dark end
 *  for the ramp to anchor on - mixing it toward paper would dissolve the
 *  icon. Painted flat instead. */
const MIN_RAMP_RANGE = 0.15;

/** Ceiling on the ramp's gain, expressed as the smallest denominator it
 *  will divide by. Without it, pale artwork gets its few points of
 *  luminance spread stretched across the tint→paper range and reads
 *  as a high-contrast stencil that looks nothing like the original. */
const MIN_RAMP_DENOM = 0.35;

/** The paint channels we rewrite, each with the opacity channel that
 *  modulates it. `stop-color` covers gradient stops - an icon that paints
 *  through `fill="url(#grad)"` is recoloured by rewriting the gradient's
 *  stops, and `currentColor` inside a <stop> resolves against the gradient
 *  element's inherited colour, which is our wrapper's tint. */
const CHANNELS: ReadonlyArray<readonly [paint: string, opacity: string]> = [
  ['fill', 'fill-opacity'],
  ['stroke', 'stroke-opacity'],
  ['stop-color', 'stop-opacity'],
];

/* ── Colour parsing ──────────────────────────────────────────────────── */

export type Rgba = { r: number; g: number; b: number; a: number };

/** Paint values that name no colour - they either inherit, disable the
 *  channel, or are already under the tint. Left untouched by the rewrite,
 *  and excluded from the shade ramp. */
function isNonColorPaint(v: string): boolean {
  const t = v.trim().toLowerCase();
  return (
    t === '' ||
    t === 'none' ||
    t === 'transparent' ||
    t === 'inherit' ||
    t === 'initial' ||
    t === 'unset' ||
    t === 'currentcolor' ||
    t === 'context-fill' ||
    t === 'context-stroke' ||
    t.startsWith('url(')
  );
}

/** Enough of the CSS named colours to keep the Node-side fallback accurate
 *  for the values icon sets actually ship. In the browser the canvas probe
 *  below handles the full 148 plus every functional syntax, so this table
 *  only carries the common names. */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff',
  magenta: '#ff00ff', fuchsia: '#ff00ff', silver: '#c0c0c0', gray: '#808080',
  grey: '#808080', maroon: '#800000', olive: '#808000', green: '#008000',
  purple: '#800080', teal: '#008080', navy: '#000080', orange: '#ffa500',
  gold: '#ffd700', pink: '#ffc0cb', brown: '#a52a2a', indigo: '#4b0082',
  violet: '#ee82ee', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', whitesmoke: '#f5f5f5',
  ghostwhite: '#f8f8ff', snow: '#fffafa', ivory: '#fffff0',
  dimgray: '#696969', dimgrey: '#696969', darkblue: '#00008b',
  darkgreen: '#006400', darkred: '#8b0000', royalblue: '#4169e1',
  steelblue: '#4682b4', slategray: '#708090', slategrey: '#708090',
  crimson: '#dc143c', tomato: '#ff6347', salmon: '#fa8072',
};

/** Lazily-built 1x1 canvas used to normalise arbitrary CSS colour syntax.
 *  `undefined` = not attempted yet, `null` = unavailable (Node / tests). */
let _probe: CanvasRenderingContext2D | null | undefined;

function getProbe(): CanvasRenderingContext2D | null {
  if (_probe !== undefined) return _probe;
  _probe = null;
  try {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      _probe = c.getContext('2d');
    }
  } catch {
    _probe = null;
  }
  return _probe;
}

/** Normalise via the browser's own colour parser. Assigning an invalid
 *  value to `fillStyle` is a silent no-op, so we probe twice from opposite
 *  sentinels: agreeing results mean the value parsed, disagreeing results
 *  mean it was rejected. */
function canvasNormalize(value: string): string | null {
  const ctx = getProbe();
  if (!ctx) return null;
  try {
    ctx.fillStyle = '#000000';
    ctx.fillStyle = value;
    const a = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = value;
    const b = ctx.fillStyle;
    return a === b && typeof a === 'string' ? a : null;
  } catch {
    return null;
  }
}

function hexToRgba(hex: string): Rgba | null {
  const h = hex.slice(1);
  const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
  if (h.length === 3 || h.length === 4) {
    return {
      r: expand(h[0]), g: expand(h[1]), b: expand(h[2]),
      a: h.length === 4 ? expand(h[3]) / 255 : 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

/** `h` in degrees, `s`/`l` in 0..1. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hp = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if (hp < 1) [rp, gp, bp] = [c, x, 0];
  else if (hp < 2) [rp, gp, bp] = [x, c, 0];
  else if (hp < 3) [rp, gp, bp] = [0, c, x];
  else if (hp < 4) [rp, gp, bp] = [0, x, c];
  else if (hp < 5) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

/** Split the argument list of a functional colour, tolerating both the
 *  legacy comma form and the modern space/slash form. */
function fnArgs(body: string): string[] {
  return body
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function num(tok: string, scale: number): number {
  if (tok.endsWith('%')) return (parseFloat(tok) / 100) * scale;
  return parseFloat(tok);
}

/** Parse any colour value we might meet in icon markup. Returns null for
 *  values that don't name a colour (callers should have filtered those with
 *  `isNonColorPaint` first) or that we can't understand. */
export function parseColor(value: string): Rgba | null {
  const raw = value.trim();
  if (raw === '') return null;

  const normalized = canvasNormalize(raw) ?? raw;
  const v = normalized.trim().toLowerCase();

  if (v.startsWith('#')) return hexToRgba(v);

  const fn = v.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (fn) {
    const args = fnArgs(fn[2]);
    if (args.length < 3) return null;
    const alpha = args.length > 3 ? num(args[3], 1) : 1;
    if (fn[1].startsWith('rgb')) {
      return {
        r: Math.round(num(args[0], 255)),
        g: Math.round(num(args[1], 255)),
        b: Math.round(num(args[2], 255)),
        a: Number.isFinite(alpha) ? alpha : 1,
      };
    }
    const { r, g, b } = hslToRgb(parseFloat(args[0]), num(args[1], 1), num(args[2], 1));
    return { r, g, b, a: Number.isFinite(alpha) ? alpha : 1 };
  }

  // color(<space> r g b [/ a]) - wide-gamut syntax that Chrome hands back
  // verbatim from the canvas probe. Components are 0..1. We read display-p3
  // as if it were sRGB: the numbers are close enough for a luminance sort,
  // and the value is only ever used to order tones in the shade ramp.
  const fnColor = v.match(/^color\(([^)]*)\)$/);
  if (fnColor) {
    const args = fnArgs(fnColor[1]);
    if (args.length >= 4) {
      const ch = args.slice(1, 4).map((t) => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)));
      if (ch.every((n) => Number.isFinite(n))) {
        const alpha = args.length > 4 ? num(args[4], 1) : 1;
        return {
          r: Math.round(Math.max(0, Math.min(1, ch[0])) * 255),
          g: Math.round(Math.max(0, Math.min(1, ch[1])) * 255),
          b: Math.round(Math.max(0, Math.min(1, ch[2])) * 255),
          a: Number.isFinite(alpha) ? alpha : 1,
        };
      }
    }
  }

  const named = NAMED_COLORS[v];
  return named ? hexToRgba(named) : null;
}

/** WCAG relative luminance - 0 for black, 1 for white. Perceptual rather
 *  than a naive channel average, so the shade ramp orders tones the way the
 *  eye does (a saturated blue reads darker than a saturated yellow). */
export function relativeLuminance(c: { r: number; g: number; b: number }): number {
  const lin = (ch: number) => {
    const s = ch / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/* ── Shade ramp ──────────────────────────────────────────────────────── */

/** Maps a source colour's relative luminance to how much tint (0..1) its
 *  recoloured form should carry; the remainder is paper. */
type Ramp = (lum: number) => number;

/** Build the luminance→tint-weight mapping for `shade`.
 *
 *  The shape is `(1 - L) / (1 - Lmin)`: darkness drives the weight, gained
 *  so the icon's own darkest tone reaches full tint. On ordinary artwork -
 * anything containing a near-black - the gain is ~1 and this is simply
 *  "how dark was it", which keeps two close darks (#111 and #333) close
 *  together instead of stretching them to opposite ends. On paler artwork
 *  the gain opens up so a light logo still lands as a legible tint rather
 *  than washing out into the paper, up to the MIN_RAMP_DENOM ceiling.
 *
 *  Deliberately NOT a full min→max normalisation. That would pin the
 *  lightest tone to pure paper no matter how dark it actually was, turning
 *  a subtly two-toned icon into a high-contrast stencil. */
function buildRamp(lums: number[]): Ramp {
  if (lums.length === 0) return () => 1;
  const range = 1 - Math.min(...lums);
  if (range < MIN_RAMP_RANGE) return () => 1;
  const denom = Math.max(range, MIN_RAMP_DENOM);
  return (lum: number) => Math.max(0, Math.min(1, (1 - lum) / denom));
}

/* ── Declaration helpers ─────────────────────────────────────────────── */

type Decl = { prop: string; value: string };

/** Parse a `style="…"` value or a CSS rule body into ordered declarations.
 *  Unrecognised fragments are dropped rather than preserved verbatim - the
 *  only inputs are icon markup that has already been through DOMPurify, so
 *  malformed declarations are noise, not signal. */
function parseDecls(text: string): Decl[] {
  const out: Decl[] = [];
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const prop = part.slice(0, i).trim();
    if (!prop) continue;
    out.push({ prop, value: part.slice(i + 1).trim() });
  }
  return out;
}

function serializeDecls(decls: Decl[]): string {
  return decls.map((d) => `${d.prop}:${d.value}`).join(';');
}

/** CSS resolves a repeated property to its LAST declaration, and icon sets
 *  lean on that for progressive enhancement (`fill:#101010;fill:color(...)`
 *  ships an sRGB value for old engines and a wide-gamut one for new). Read
 *  and write the last occurrence so we recolour the one that actually
 *  paints - matching on the first would leave the live value untouched. */
function lastDecl(decls: Decl[], prop: string): Decl | undefined {
  for (let i = decls.length - 1; i >= 0; i--) {
    if (decls[i].prop === prop) return decls[i];
  }
  return undefined;
}

/** Round to three places and strip the trailing zeros - keeps the emitted
 *  markup readable in DevTools and shorter in an SVG export. */
function fmtAlpha(a: number): string {
  const clamped = Math.max(0, Math.min(1, a));
  return String(Math.round(clamped * 1000) / 1000);
}

/* ── Paint sites ─────────────────────────────────────────────────────── */

/** One place paint can be declared: an element (attributes + inline style)
 *  or a CSS rule body. `get` resolves through the same precedence the
 *  browser would; `set` writes back to whichever layer the value came from
 *  so we never introduce a declaration that the cascade then ignores. */
type Site = {
  get(prop: string): string | undefined;
  set(prop: string, value: string): void;
  /** Write a paint, optionally with a modern-CSS `enhanced` form layered
   *  over a `base` that every engine understands. Both land where the
   *  cascade will pick `enhanced` when it parses and fall back to `base`
   *  when it doesn't - the same progressive-enhancement pattern icon sets
   *  already use for wide-gamut colour. */
  setPaint(prop: string, base: string, enhanced?: string): void;
};

/** Read the effective paint + opacity at a site, and hand back the writer
 *  for the recoloured result. Returns null when there's nothing to do -
 * the channel inherits, is disabled, or already paints with currentColor. */
function readChannel(
  site: Site,
  paintProp: string,
  opacityProp: string,
): { lum: number | null; apply: (tintWeight: number) => void } | null {
  const paint = site.get(paintProp);
  if (paint === undefined || isNonColorPaint(paint)) return null;
  // A colour we can't decompose is still a colour - `lab()`, a CSS var, an
  // exotic function. Recolour it anyway (the point of this module is
  // that NO icon is off-limits) and just leave it out of the shade survey,
  // where an invented luminance would skew the ramp for everything else.
  const color = parseColor(paint);

  const rawOpacity = site.get(opacityProp);
  const parsedOpacity = rawOpacity === undefined ? 1 : parseFloat(rawOpacity);
  const baseOpacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1;

  return {
    lum: color ? relativeLuminance(color) : null,
    apply: (tintWeight: number) => {
      if (tintWeight >= FULL_TINT) {
        site.setPaint(paintProp, 'currentColor');
      } else {
        const pct = Math.round(tintWeight * 1000) / 10;
        site.setPaint(
          paintProp,
          'currentColor',
          `color-mix(in srgb, currentColor ${pct}%, ${SHADE_BASE})`,
        );
      }
      // Transparency baked into the SOURCE colour (#rrggbbaa, rgba()) has
      // nowhere to go once the paint is a keyword, so fold it into the
      // element's own opacity. The shade ramp is NOT folded in here - it
      // rides in the mix above, because fading a glyph out would just
      // reveal the tile stacked behind it.
      const next = baseOpacity * (color?.a ?? 1);
      if (Math.abs(next - baseOpacity) > 0.001) {
        site.set(opacityProp, fmtAlpha(next));
      }
    },
  };
}

/* ── Splice-based rewriting ──────────────────────────────────────────── */

type Edit = { start: number; end: number; text: string };

function applyEdits(source: string, edits: Edit[]): string {
  if (edits.length === 0) return source;
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Matches an element start tag, skipping over quoted attribute values so a
 *  `>` inside one doesn't end the match early. Requires a letter after `<`,
 *  which excludes comments, CDATA and closing tags. */
const TAG_RE = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** Matches one attribute inside a tag's attribute region. */
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_RULE_RE = /\{([^{}]*)\}/g;

/** Walk every paint site in the markup, handing each to `visit`. When
 *  `edits` is non-null the site's writes are collected into it; pass null
 *  for a read-only pass (the luminance survey that seeds the shade ramp). */
function eachSite(
  markup: string,
  edits: Edit[] | null,
  visit: (site: Site) => void,
): void {
  // ── <style> rule bodies first, so we can skip tags nested in their text.
  const cssSpans: Array<[number, number]> = [];
  STYLE_BLOCK_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = STYLE_BLOCK_RE.exec(markup)) !== null) {
    const content = sm[1];
    const contentStart = sm.index + sm[0].length - content.length - '</style>'.length;
    cssSpans.push([contentStart, contentStart + content.length]);

    CSS_RULE_RE.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = CSS_RULE_RE.exec(content)) !== null) {
      const body = rm[1];
      const bodyStart = contentStart + rm.index + 1;
      const decls = parseDecls(body);
      let dirty = false;
      const set = (prop: string, value: string) => {
        dirty = true;
        const existing = lastDecl(decls, prop);
        if (existing) existing.value = value;
        else decls.push({ prop, value });
      };
      visit({
        get: (prop) => lastDecl(decls, prop)?.value,
        set,
        setPaint: (prop, base, enhanced) => {
          set(prop, base);
          // Appending a second declaration for the same property is the
          // fallback: an engine that can't parse it keeps the first.
          if (enhanced) decls.push({ prop, value: enhanced });
        },
      });
      if (dirty && edits) {
        edits.push({ start: bodyStart, end: bodyStart + body.length, text: serializeDecls(decls) });
      }
    }
  }
  const inCss = (i: number) => cssSpans.some(([s, e]) => i >= s && i < e);

  // ── Element start tags.
  TAG_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TAG_RE.exec(markup)) !== null) {
    if (inCss(tm.index)) continue;
    const attrsRegion = tm[2] ?? '';
    const attrsStart = tm.index + 1 + (tm[1] ?? '').length;

    // Absolute span of each attribute's value, so we can splice in place.
    const attrs = new Map<string, { start: number; end: number; value: string }>();
    ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ATTR_RE.exec(attrsRegion)) !== null) {
      const value = am[2] ?? am[3] ?? am[4] ?? '';
      // Offset of the value within the match, then within the tag.
      const valueOffset = am[0].length - value.length - (am[2] !== undefined || am[3] !== undefined ? 1 : 0);
      const start = attrsStart + am.index + valueOffset;
      attrs.set(am[1].toLowerCase(), { start, end: start + value.length, value });
    }

    const styleAttr = attrs.get('style');
    const styleDecls = styleAttr ? parseDecls(styleAttr.value) : [];
    let styleDirty = false;
    const attrEdits = new Map<string, string>();
    const appended: string[] = [];

    const setStyle = (prop: string, value: string) => {
      styleDirty = true;
      const existing = lastDecl(styleDecls, prop);
      if (existing) existing.value = value;
      else styleDecls.push({ prop, value });
    };

    const set = (prop: string, value: string) => {
      // Write where the value already is, so the cascade keeps
      // resolving to the layer it resolved to before.
      if (lastDecl(styleDecls, prop)) {
        setStyle(prop, value);
        return;
      }
      if (attrs.has(prop)) {
        attrEdits.set(prop, value);
        return;
      }
      // Neither layer declares it. A new presentation attribute is the
      // safe home: nothing else on this element can shadow it, whereas
      // adding to `style` could override a <style> rule we can't see.
      appended.push(` ${prop}="${value}"`);
    };

    visit({
      // Inline style wins over the presentation attribute, matching the
      // cascade. A <style> rule would sit between the two, but it can't be
      // resolved per-element without a selector engine - so a class-styled
      // element is recoloured through its rule body instead (above), which
      // reaches the same pixels.
      get: (prop) => {
        const fromStyle = lastDecl(styleDecls, prop)?.value;
        if (fromStyle !== undefined) return fromStyle;
        return attrs.get(prop)?.value;
      },
      set,
      setPaint: (prop, base, enhanced) => {
        set(prop, base);
        // The enhanced form has to outrank the base one. Inline style beats
        // a presentation attribute, so it always goes there - creating the
        // style attribute if the element had none.
        if (enhanced) setStyle(prop, enhanced);
      },
    });

    if (!edits) continue;
    for (const [prop, value] of attrEdits) {
      const a = attrs.get(prop);
      if (a) edits.push({ start: a.start, end: a.end, text: value });
    }
    if (styleDirty) {
      const serialized = serializeDecls(styleDecls);
      if (styleAttr) {
        edits.push({ start: styleAttr.start, end: styleAttr.end, text: serialized });
      } else {
        appended.push(` style="${serialized}"`);
      }
    }
    if (appended.length > 0) {
      // Insert just before the tag's closing `>` - and before the `/` of a
      // self-closing tag, which the attribute region swallows - so we never
      // disturb the attributes already there.
      let insertAt = tm.index + tm[0].length - 1;
      if (markup[insertAt - 1] === '/') insertAt -= 1;
      edits.push({ start: insertAt, end: insertAt, text: appended.join('') });
    }
  }
}

/* ── Entry point ─────────────────────────────────────────────────────── */

const CACHE_MAX = 128;
const _cache = new Map<string, string>();

/** Rewrite `markup` so every hard-coded paint answers to the wrapper's
 *  `color`. Pure - the input string is never mutated. Memoised because the
 *  canvas re-derives an icon shape's markup on every render, and icon SVGs
 *  are shared across shapes. */
export function recolorIconSvg(markup: string, mode: IconRecolorMode): string {
  if (!markup) return markup;
  const key = `${mode}|${markup}`;
  const hit = _cache.get(key);
  if (hit !== undefined) return hit;

  // Pass 1: survey the tones present, so `shade` can gain its ramp to this
  // icon's own darkest tone rather than assuming one.
  let ramp: Ramp = () => 1;
  if (mode === 'shade') {
    const lums: number[] = [];
    eachSite(markup, null, (site) => {
      for (const [paint, opacity] of CHANNELS) {
        const ch = readChannel(site, paint, opacity);
        if (ch && ch.lum !== null) lums.push(ch.lum);
      }
    });
    ramp = buildRamp(lums);
  }

  // Pass 2: rewrite.
  const edits: Edit[] = [];
  eachSite(markup, edits, (site) => {
    for (const [paint, opacity] of CHANNELS) {
      const ch = readChannel(site, paint, opacity);
      if (ch) ch.apply(ch.lum === null ? 1 : ramp(ch.lum));
    }
  });
  const out = applyEdits(markup, edits);

  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next();
    if (!oldest.done) _cache.delete(oldest.value);
  }
  _cache.set(key, out);
  return out;
}

/** The mode to use when the user has tinted an icon but not chosen one.
 *
 *  A monochrome icon has no internal structure for `shade` to preserve, and
 *  a flat fill is what the tint swatch has always meant there, so it gets
 *  `solid`. Multi-colour art gets `shade`, because flattening a background-
 *  plus-knockout icon to one colour destroys the glyph - the single most
 *  likely thing a user is trying to recolour is exactly that shape of icon. */
export function defaultRecolorMode(monochrome: boolean): IconRecolorMode {
  return monochrome ? 'solid' : 'shade';
}
