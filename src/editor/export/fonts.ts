/* Webfont embedding for exports.
 *
 * The rasterizer loads the serialized SVG into a detached <img>, which is a
 * separate document with no access to the editor's stylesheets - so
 * `font-family: 'Outfit'` resolves to whatever the OS has installed (nothing,
 * for our self-hosted faces) and every label falls back to a system serif /
 * sans. Same story for a standalone .svg opened anywhere else.
 *
 * Fix: read the page's own @font-face rules, keep only the faces the export
 * actually uses (family + weight + style + the unicode-range subsets that
 * cover the characters present), fetch each woff2 once, and inline them as
 * data: URLs in a <style> at the top of the clone. */

import {
  nearestWeight,
  parseFamilyList,
  parseUnicodeRange,
  rangesCoverAny,
} from './options';

export interface FontFaceRule {
  family: string;
  /** Inclusive weight range - `[400, 400]` for a single weight, `[100, 900]`
   *  for a variable face declared as `font-weight: 100 900`. */
  weight: [number, number];
  style: string;
  unicodeRange: Array<[number, number]>;
  /** First `url(...)` in the `src` descriptor, resolved against the sheet. */
  url: string;
  format: string | null;
}

/** Text that needs a face: one entry per (family, weight, style) triple
 *  with the codepoints it paints. */
export interface FontUsage {
  family: string;
  weight: number;
  style: string;
  codepoints: Set<number>;
}

function normFamily(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

function parseWeightRange(v: string): [number, number] {
  const t = v.trim().toLowerCase();
  if (!t || t === 'normal') return [400, 400];
  if (t === 'bold') return [700, 700];
  const parts = t.split(/\s+/).map((p) => parseFloat(p));
  if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
    return [Math.min(parts[0], parts[1]), Math.max(parts[0], parts[1])];
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? [n, n] : [400, 400];
}

function parseSrc(src: string, baseHref: string | null): { url: string; format: string | null } | null {
  // `url("…") format("woff2"), url("…") format("woff")` - take the first
  // url() we can resolve; fontsource lists woff2 first.
  const re = /url\((["']?)([^)"']+)\1\)(?:\s*format\((["']?)([^)"']+)\3\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[2].trim();
    if (raw.startsWith('data:')) return { url: raw, format: m[4] ?? null };
    try {
      const url = new URL(raw, baseHref ?? (typeof location !== 'undefined' ? location.href : undefined)).href;
      return { url, format: m[4] ?? null };
    } catch {
      continue;
    }
  }
  return null;
}

/** Every @font-face the page has declared, across all same-origin
 *  stylesheets. Cross-origin sheets throw on `cssRules` and are skipped. */
export function collectFontFaceRules(doc: Document = document): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const family = st.getPropertyValue('font-family');
      const src = st.getPropertyValue('src');
      if (!family || !src) continue;
      const parsed = parseSrc(src, sheet.href);
      if (!parsed) continue;
      out.push({
        family: normFamily(family),
        weight: parseWeightRange(st.getPropertyValue('font-weight')),
        style: (st.getPropertyValue('font-style') || 'normal').trim().toLowerCase(),
        unicodeRange: parseUnicodeRange(st.getPropertyValue('unicode-range') || ''),
        url: parsed.url,
        format: parsed.format,
      });
    }
  }
  return out;
}

/** Effective presentation value for an SVG text node: nearest ancestor
 *  attribute or inline style, up to (and including) the root. */
function inherited(el: Element, attr: string, prop: string): string {
  let node: Element | null = el;
  while (node) {
    const style = node.getAttribute('style');
    if (style) {
      const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
      if (m) return m[1].trim();
    }
    const v = node.getAttribute(attr);
    if (v) return v.trim();
    node = node.parentElement;
  }
  return '';
}

function weightNumber(v: string): number {
  const t = v.trim().toLowerCase();
  if (!t || t === 'normal') return 400;
  if (t === 'bold') return 700;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 400;
}

/** Walk the clone's <text>/<tspan> nodes and tally which (family, weight,
 *  style) each character needs. Only the FIRST family in a stack that has
 *  an @font-face rule counts - that's the one the browser will use; the
 *  generic fallbacks after it never need embedding. */
export function collectTextUsage(
  root: Element,
  rules: readonly FontFaceRule[],
): FontUsage[] {
  const known = new Set(rules.map((r) => r.family));
  const byKey = new Map<string, FontUsage>();
  const texts = Array.from(root.querySelectorAll('text, tspan'));
  for (const el of texts) {
    // Own text only - a <text> with <tspan> children contributes the
    // stray whitespace between tspans, which is harmless.
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.nodeValue ?? '')
      .join('');
    if (!own.trim()) continue;
    const stack = parseFamilyList(inherited(el, 'font-family', 'font-family'));
    const family = stack.map(normFamily).find((f) => known.has(f));
    if (!family) continue;
    const weight = weightNumber(inherited(el, 'font-weight', 'font-weight'));
    const style = (inherited(el, 'font-style', 'font-style') || 'normal').toLowerCase();
    const key = `${family}|${weight}|${style}`;
    let u = byKey.get(key);
    if (!u) {
      u = { family, weight, style, codepoints: new Set() };
      byKey.set(key, u);
    }
    for (const ch of own) {
      const cp = ch.codePointAt(0);
      if (cp !== undefined && !/\s/.test(ch)) u.codepoints.add(cp);
    }
  }
  return Array.from(byKey.values());
}

/** Which declared faces satisfy a usage: the family's closest weight (a
 *  variable face whose range contains the weight wins outright), the
 *  matching style when one exists (else normal - browsers synthesise
 *  oblique), and only the unicode-range subsets that cover the characters. */
export function selectFaces(
  usage: FontUsage,
  rules: readonly FontFaceRule[],
): FontFaceRule[] {
  const family = rules.filter((r) => r.family === usage.family);
  if (family.length === 0) return [];
  const styled = family.filter((r) => r.style === usage.style);
  const pool = styled.length ? styled : family.filter((r) => r.style === 'normal');
  if (pool.length === 0) return [];
  const covering = pool.filter(
    (r) => usage.weight >= r.weight[0] && usage.weight <= r.weight[1],
  );
  let chosen: FontFaceRule[];
  if (covering.length) {
    chosen = covering;
  } else {
    const weights = Array.from(new Set(pool.map((r) => r.weight[0])));
    const w = nearestWeight(weights, usage.weight);
    chosen = pool.filter((r) => r.weight[0] === w);
  }
  return chosen.filter((r) => rangesCoverAny(r.unicodeRange, usage.codepoints));
}

const fontDataCache = new Map<string, Promise<string | null>>();

function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

function mimeFor(url: string, format: string | null): string {
  const f = (format ?? '').toLowerCase();
  if (f.includes('woff2') || /\.woff2(\?|$)/i.test(url)) return 'font/woff2';
  if (f.includes('woff') || /\.woff(\?|$)/i.test(url)) return 'font/woff';
  if (f.includes('truetype') || /\.ttf(\?|$)/i.test(url)) return 'font/ttf';
  if (f.includes('opentype') || /\.otf(\?|$)/i.test(url)) return 'font/otf';
  return 'application/octet-stream';
}

/** Fetch a face once and hand back a `data:` URL (memoised per URL for the
 *  session - a 4× export of the same diagram shouldn't re-download Outfit). */
function fontDataUrl(rule: FontFaceRule): Promise<string | null> {
  if (rule.url.startsWith('data:')) return Promise.resolve(rule.url);
  let p = fontDataCache.get(rule.url);
  if (!p) {
    p = fetch(rule.url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return `data:${mimeFor(rule.url, rule.format)};base64,${toBase64(buf)}`;
      })
      .catch((err) => {
        console.warn('[vellum export] could not embed font', rule.url, err);
        return null;
      });
    fontDataCache.set(rule.url, p);
  }
  return p;
}

/** Soft ceiling on embedded font bytes (base64-expanded). Past this the
 *  remaining faces are left to fall back rather than producing a 20 MB
 *  SVG - the dialog surfaces the count. */
export const MAX_EMBED_BYTES = 6 * 1024 * 1024;

export interface EmbedResult {
  css: string;
  faces: number;
  bytes: number;
  /** Faces skipped because the byte budget ran out or the fetch failed. */
  skipped: number;
}

/** Build the `@font-face` CSS for every face the clone's text needs. */
export async function buildEmbeddedFontCss(
  root: Element,
  rules: readonly FontFaceRule[] = collectFontFaceRules(),
): Promise<EmbedResult> {
  const usages = collectTextUsage(root, rules);
  const wanted = new Map<string, FontFaceRule>();
  for (const u of usages) {
    for (const r of selectFaces(u, rules)) wanted.set(r.url + '|' + r.weight.join('-') + '|' + r.style, r);
  }
  const faces = Array.from(wanted.values());
  const data = await Promise.all(faces.map((r) => fontDataUrl(r)));
  let css = '';
  let bytes = 0;
  let count = 0;
  let skipped = 0;
  faces.forEach((r, i) => {
    const d = data[i];
    if (!d) {
      skipped++;
      return;
    }
    if (bytes + d.length > MAX_EMBED_BYTES) {
      skipped++;
      return;
    }
    bytes += d.length;
    count++;
    const weight =
      r.weight[0] === r.weight[1] ? String(r.weight[0]) : `${r.weight[0]} ${r.weight[1]}`;
    const fmt = r.format ? ` format("${r.format}")` : '';
    const ur = r.unicodeRange.length
      ? `unicode-range:${r.unicodeRange
          .map(([lo, hi]) =>
            lo === hi
              ? `U+${lo.toString(16).toUpperCase()}`
              : `U+${lo.toString(16).toUpperCase()}-${hi.toString(16).toUpperCase()}`,
          )
          .join(',')};`
      : '';
    css += `@font-face{font-family:"${r.family}";font-weight:${weight};font-style:${r.style};font-display:block;${ur}src:url(${d})${fmt};}\n`;
  });
  return { css, faces: count, bytes, skipped };
}

/** Inline the needed @font-face rules into `clone` (a <style> right after
 *  the clone's own token <style>). Safe to call on a clone that has no
 *  webfont text - it's a no-op then. */
export async function embedFonts(clone: SVGSVGElement): Promise<EmbedResult> {
  const result = await buildEmbeddedFontCss(clone);
  if (result.css) {
    const style = clone.ownerDocument.createElementNS(
      'http://www.w3.org/2000/svg',
      'style',
    );
    style.setAttribute('data-vellum-fonts', '');
    style.textContent = result.css;
    // After the token style if present, else first.
    const anchor = clone.querySelector(':scope > style');
    if (anchor && anchor.nextSibling) clone.insertBefore(style, anchor.nextSibling);
    else if (anchor) clone.appendChild(style);
    else clone.insertBefore(style, clone.firstChild);
  }
  return result;
}
