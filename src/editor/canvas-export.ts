/* Shared canvas-export prep. Every image export (PNG / JPG / SVG / GIF,
 * the clipboard copy and the dialog preview) runs through
 * `prepareCanvasClone`: find the live canvas, measure the content in WORLD
 * units, clone + crop + scrub, resolve theme tokens, flatten foreignObject
 * labels into measured native text, and bake animation state.
 *
 * Design notes (each of these was a shipped bug):
 *  - The crop is computed in world coordinates by inverting the pan/zoom
 *    transform, so the output is the same at 25% and 400% zoom. The old
 *    screen-pixel crop made export resolution depend on the zoom level.
 *  - Padding is in world units too (= px at 1×), user-tunable.
 *  - The background is the colour the user is LOOKING at - the live
 *    canvas's computed background, which honours the Settings → Paper
 *    override - not the bare theme token.
 *  - `var()` is resolved in EVERY attribute, not just colours: the
 *    `font-family="var(--font-mono)"` attributes on connector labels were
 *    left unresolved and rasterized in the default serif.
 *  - Root-level overlays (measurements, marquee, pen preview) are removed,
 *    not just the ones inside the content group. */

import { PRISM_PARKED_PHASE, PRISM_PERIOD_UNITS } from './canvas/prism';
import { flattenForeignObjects } from './export/flatten';
import { embedFonts, type EmbedResult } from './export/fonts';
import type { ExportTheme } from './export/options';
import { SOURCE_TYPE, SVG_SOURCE_ID } from './export/source';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Bake prism animation to a fixed phase on an export clone.
 *
 *  SMIL renders at t=0 in `<img>`-based rasterisation - the PNG/JPG path
 *  loads the serialized SVG into a DETACHED `new Image()` and calls
 *  `drawImage` exactly once, so a declarative timeline never advances. And
 *  t=0 on a PALINDROMIC ramp is the seam: a flat wall of the palette's first
 *  colour, which reads as "the gradient didn't export". Parking at
 *  `PRISM_PARKED_PHASE` instead gives a deterministic mid-ramp blend,
 *  byte-identical across exports and identical to what a reduced-motion user
 *  already sees on screen.
 *
 *  Idempotent - the `remove()` calls are no-ops on a second pass - so the GIF
 *  path can safely re-apply it per frame over an already-frozen clone. */
export function applyPrismState(
  clone: SVGSVGElement,
  phase01: number,
  strokeOpacity: number,
) {
  for (const g of Array.from(
    clone.querySelectorAll('[data-vellum-prism="grad"]'),
  )) {
    const period =
      Number(g.getAttribute('data-vellum-prism-period')) || PRISM_PERIOD_UNITS;
    // A `static`-speed gradient carries seconds=0: the user explicitly asked
    // it not to scroll, so it stays at the parked phase no matter what the
    // caller sweeps. Stripping its (nonexistent) SMIL is still a no-op, and
    // re-asserting the parked transform keeps the attribute deterministic.
    const seconds = Number(g.getAttribute('data-vellum-prism-seconds'));
    const phase = seconds > 0 ? phase01 : PRISM_PARKED_PHASE;
    g.querySelectorAll('animateTransform').forEach((n) => n.remove());
    g.setAttribute('gradientTransform', `translate(${period * phase} 0)`);
  }
  for (const el of Array.from(
    clone.querySelectorAll('[data-vellum-prism="pulse"]'),
  )) {
    el.querySelectorAll('animate').forEach((n) => n.remove());
    el.setAttribute('stroke-opacity', String(strokeOpacity));
  }
}

export interface PrepareOptions {
  /** Margin around the content bbox, in world units. Default 24. */
  padding?: number;
  /** Resolved CSS colour to paint behind the diagram, or `null` for
   *  transparent. A function receives the effective paper colour (under
   *  the export theme) and returns the colour - use it when the choice
   *  depends on the paper. When omitted, `withBackground` decides (legacy). */
  background?: string | null | ((paperColour: string) => string | null);
  /** Legacy switch - `true` paints the effective paper colour, `false`
   *  leaves the export transparent. Ignored when `background` is given. */
  withBackground?: boolean;
  /** `'freeze'` (default) parks every prism gradient at a fixed mid-ramp
   *  phase and strips its SMIL nodes - correct for anything rasterised
   *  through `<img>`, where a timeline never advances anyway. `'keep'`
   *  leaves the `<animate*>` nodes intact and inlines the connector-flow
   *  keyframes so an exported standalone `.svg` genuinely animates when
   *  opened in a browser. The GIF path passes `'freeze'` and then re-bakes
   *  a per-frame phase. */
  animation?: 'freeze' | 'keep';
  /** Restrict the export to these shape / connector ids (selection-only).
   *  `null` / omitted exports everything visible. */
  ids?: ReadonlySet<string> | null;
  /** Keep the dot / gridline backdrop the user has switched on. */
  includeGrid?: boolean;
  /** Suppress the `alert()` on an empty canvas - callers that present
   *  their own UI (the export dialog) pass `true`. */
  silent?: boolean;
  /** Colour the export with another theme's tokens, read from the
   *  stylesheets (`themeTokens`) - the live document is never touched. */
  theme?: ExportTheme;
  /** Crop to an explicit world-space rectangle (e.g. the viewport) instead
   *  of the content bbox. Padding is NOT added - the rect is used as is. */
  cropRect?: { x: number; y: number; w: number; h: number } | null;
  doc?: Document;
}

export type CanvasClonePrep = {
  /** Cropped, scrubbed, var-inlined SVG clone with the content group's
   *  pan/zoom transform removed - user units are world units. The caller
   *  serializes it (per-frame for GIF, once for PNG/JPG/SVG). */
  clone: SVGSVGElement;
  /** 1× size in world units, padding included. Multiply by the export
   *  scale for the bitmap size. */
  w: number;
  h: number;
  viewBox: { x: number; y: number; w: number; h: number };
  /** The paper colour the user sees on screen (Settings override or theme
   *  token), resolved to a concrete colour. */
  paperColour: string;
  /** What was painted behind the diagram - `null` when transparent. */
  background: string | null;
};

/** Why `prepareCanvasClone` returned null. */
export type ExportEmptyReason = 'no-canvas' | 'empty' | 'nothing-selected';

/** The live canvas element. `data-vellum-canvas` is the stable hook; the
 *  width="100%" fallback covers hosts that mount an older Canvas. */
export function getCanvasSvg(doc: Document = document): SVGSVGElement | null {
  return (
    (doc.querySelector('svg[data-vellum-canvas]') as SVGSVGElement | null) ??
    (doc.querySelector('svg[width="100%"]') as SVGSVGElement | null)
  );
}

/** The paper colour actually painted behind the canvas right now. Reads
 *  the live element's computed background (which is `canvasPaper ??
 *  var(--paper)`) so a Settings → Paper override is honoured; falls back
 *  to the theme token, then white. Never returns a transparent value. */
export function effectivePaperColour(
  svg: SVGSVGElement | null = getCanvasSvg(),
): string {
  const doc = svg?.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  if (svg) {
    const bg = win.getComputedStyle(svg).backgroundColor;
    if (bg && !isTransparent(bg)) return bg;
  }
  const token = win
    .getComputedStyle(doc.documentElement)
    .getPropertyValue('--paper')
    .trim();
  return token && !isTransparent(token) ? token : '#ffffff';
}

function isTransparent(c: string): boolean {
  const t = c.trim().toLowerCase();
  if (!t || t === 'transparent' || t === 'none') return true;
  const m = /^rgba?\(\s*[\d.]+\s*,?\s*[\d.]+\s*,?\s*[\d.]+\s*[,/]\s*([\d.]+%?)\s*\)$/.exec(t);
  return !!m && parseFloat(m[1]) === 0;
}

/** Content roots: the shape / connector groups that are direct children of
 *  the pan/zoom group. Nested `data-shape-id` nodes don't exist today, but
 *  scoping to direct children keeps the crop accurate if that changes. */
function contentRoots(contentG: Element, ids?: ReadonlySet<string> | null): Element[] {
  const all = Array.from(
    contentG.querySelectorAll(':scope > [data-shape-id], :scope > [data-connector-id]'),
  );
  if (!ids) return all;
  return all.filter((el) => {
    const id = el.getAttribute('data-shape-id') ?? el.getAttribute('data-connector-id');
    return id != null && ids.has(id);
  });
}

/** Find the content `<g transform="translate(pan) scale(zoom)">` - the
 *  first direct child group carrying a transform. */
function findContentGroup(svg: SVGSVGElement): SVGGElement | null {
  return (
    (Array.from(svg.children).find(
      (c) => c.localName === 'g' && c.hasAttribute('transform'),
    ) as SVGGElement | undefined) ?? null
  );
}

function styleProp(el: Element, prop: string): string | null {
  const style = el.getAttribute('style');
  if (!style) return null;
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
  return m ? m[1].trim() : null;
}

/** How far painted pixels can extend past an element's geometry bbox
 *  (`getBoundingClientRect` on SVG ignores stroke, markers and filters).
 *  Half the widest stroke, half the largest arrowhead, a few px for
 *  round joins / sketchy overshoot, plus the notes drop-shadow offset. */
function paintBleed(root: Element): number {
  let maxStroke = 0;
  let markerPx = 0;
  const consider = (el: Element) => {
    const strokeAttr = el.getAttribute('stroke') ?? styleProp(el, 'stroke');
    if (strokeAttr !== 'none') {
      const sw = el.getAttribute('stroke-width') ?? styleProp(el, 'stroke-width');
      if (sw) {
        const n = parseFloat(sw);
        if (Number.isFinite(n)) maxStroke = Math.max(maxStroke, n);
      }
    }
    if (el.localName === 'marker') {
      const mw = parseFloat(el.getAttribute('markerWidth') ?? '0') || 0;
      const mh = parseFloat(el.getAttribute('markerHeight') ?? '0') || 0;
      markerPx = Math.max(markerPx, mw, mh);
    }
  };
  consider(root);
  root.querySelectorAll('*').forEach(consider);
  const hasFilter =
    root.hasAttribute('filter') || root.querySelector('[filter]') !== null;
  // CSS blur on images (`style="filter: blur(4px)"`) spreads ~2× its radius.
  let blur = 0;
  const blurRe = /blur\(\s*([\d.]+)px\s*\)/i;
  const scanBlur = (el: Element) => {
    const st = el.getAttribute('style');
    if (!st) return;
    const m = blurRe.exec(st);
    if (m) blur = Math.max(blur, parseFloat(m[1]) * 2);
  };
  scanBlur(root);
  root.querySelectorAll('[style]').forEach(scanBlur);
  return maxStroke / 2 + markerPx / 2 + 3 + (hasFilter ? 4 : 0) + blur;
}

/** Custom properties of `theme`, read straight from the stylesheets -
 * the `:root` block carries the dark defaults, `html.theme-light` the
 *  light overrides (tokens.css). Values that reference other tokens
 *  (`--paper: var(--slate)`) are resolved within the map. Reading the
 *  rules instead of toggling `html.theme-light` keeps the live document
 *  untouched: a class flip kicks off the chrome's colour transitions and
 *  can flash the UI through the other theme. */
export function themeTokens(doc: Document, theme: 'light' | 'dark'): Map<string, string> {
  const base = new Map<string, string>();
  const light = new Map<string, string>();
  const collect = (rule: CSSStyleRule, into: Map<string, string>) => {
    const st = rule.style;
    for (let i = 0; i < st.length; i++) {
      const name = st[i];
      if (name.startsWith('--')) into.set(name, st.getPropertyValue(name).trim());
    }
  };
  const walk = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) {
        const sel = rule.selectorText;
        if (/(^|,)\s*:root\s*($|,)/.test(sel)) collect(rule, base);
        else if (/(^|,)\s*html\.theme-light\s*($|,)/.test(sel)) collect(rule, light);
      } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
        walk((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      continue;
    }
  }
  const map = theme === 'light' ? new Map([...base, ...light]) : base;
  // Resolve token → token references inside the map.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [name, value] of map) {
      if (!value.includes('var(')) continue;
      const next = value.replace(VAR_RE, (m, ref: string, fallback?: string) => {
        const v = map.get(ref);
        if (v !== undefined && v !== '') return v;
        return fallback?.trim() || m;
      });
      if (next !== value) {
        map.set(name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return map;
}

/** Does the live canvas paint its paper from the theme token (as opposed
 *  to a Settings → Paper override)? The inline style is
 *  `background: canvasPaper ?? var(--paper)`. */
function paperFollowsTheme(svg: SVGSVGElement): boolean {
  const inline = svg.getAttribute('style') ?? '';
  return !/background[^;]*:/.test(inline) || /var\(\s*--paper/.test(inline);
}

/** World-space rectangle currently visible in the canvas element. */
export function viewportWorldRect(
  doc: Document = document,
): { x: number; y: number; w: number; h: number } | null {
  const svg = getCanvasSvg(doc);
  const g = svg ? findContentGroup(svg) : null;
  const ctm = g?.getScreenCTM();
  if (!svg || !g || !ctm) return null;
  const r = svg.getBoundingClientRect();
  const inv = ctm.inverse();
  const a = new DOMPoint(r.left, r.top).matrixTransform(inv);
  const b = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Theme tokens mirrored into a `<style>` on the clone. Attribute-level
 *  `var()` refs are substituted outright (below); this block covers any
 *  CSS that still mentions a token, e.g. inlined keyframes. */
const TOKEN_VARS = [
  '--paper',
  '--paper-grid',
  '--slate',
  '--ink',
  '--ink-muted',
  '--accent',
  '--accent-rgb',
  '--accent-deep',
  '--accent-emphasis',
  '--sketch',
  '--refined',
  '--bg',
  '--bg-subtle',
  '--bg-overlay',
  '--bg-emphasis',
  '--border',
  '--fg',
  '--fg-muted',
  '--note-bg',
  '--note-ink',
  '--notes-ink',
  '--notes-glow',
  '--mono',
  '--font-body',
  '--font-mono',
  '--font-sketch',
];

const VAR_RE = /var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/gi;

/** Substitute every `var(--x[, fallback])` in `raw` with its value from
 *  `lookup` (the export theme's tokens, else the live canvas's computed
 *  style). Loops so a fallback that is itself a `var()` resolves too.
 *  Unknown tokens with no fallback are left as-is. */
function makeVarResolver(lookup: (name: string) => string) {
  return (raw: string): string => {
    let out = raw;
    for (let pass = 0; pass < 4 && out.includes('var('); pass++) {
      const next = out.replace(VAR_RE, (match, name: string, fallback?: string) => {
        const v = lookup(name).trim();
        if (v) return v;
        if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
        return match;
      });
      if (next === out) break;
      out = next;
    }
    return out;
  };
}

/** Inline style props that only mean something in the editor. */
const EDITOR_STYLE_PROPS = ['cursor', 'pointer-events', 'user-select', 'touch-action'];

function scrubEditorAttributes(el: Element) {
  for (const attr of Array.from(el.attributes)) {
    const n = attr.name;
    if (
      n === 'tabindex' ||
      n === 'role' ||
      n === 'pointer-events' ||
      n.startsWith('aria-') ||
      n.startsWith('on')
    ) {
      el.removeAttribute(n);
    }
  }
  const style = el.getAttribute('style');
  if (style) {
    const kept = style
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !EDITOR_STYLE_PROPS.some((p) => s.toLowerCase().startsWith(p + ':')));
    if (kept.length) el.setAttribute('style', kept.join('; '));
    else el.removeAttribute('style');
  }
}

/** CSS text for the connector-flow animation (keyframes + classes) so a
 *  `'keep'` SVG animates its marching dashes outside the editor. */
function flowAnimationCss(doc: Document): string {
  let css = '';
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSKeyframesRule) {
          if (rule.name.includes('vellum-connector-flow')) css += rule.cssText + '\n';
        } else if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes('.vellum-flow-')) css += rule.cssText + '\n';
        } else if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) {
          walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    walk(rules);
  }
  return css;
}

/** Prepare a rasterization-ready clone of the live Vellum canvas. Returns
 *  null (and, unless `silent`, surfaces an alert) if the canvas isn't
 *  mounted yet or there is nothing to export. */
export function prepareCanvasClone(opts: PrepareOptions = {}): CanvasClonePrep | null {
  const doc = opts.doc ?? document;
  const win = doc.defaultView ?? window;
  const tokens =
    opts.theme && opts.theme !== 'current' ? themeTokens(doc, opts.theme) : null;
  const svgEl = getCanvasSvg(doc);
  const fail = (reason: ExportEmptyReason) => {
    if (!opts.silent) {
      alert(
        reason === 'no-canvas'
          ? 'Canvas not ready.'
          : reason === 'nothing-selected'
            ? 'Nothing to export - the selection is empty.'
            : 'Nothing to export - the canvas is empty.',
      );
    }
    return null;
  };
  if (!svgEl) return fail('no-canvas');
  const liveContent = findContentGroup(svgEl);
  if (!liveContent) return fail('no-canvas');

  const roots = contentRoots(liveContent, opts.ids);
  if (roots.length === 0) return fail(opts.ids ? 'nothing-selected' : 'empty');

  // ── Content bbox in WORLD units ──────────────────────────────────────
  // getBoundingClientRect is screen-space; the content group's screen CTM
  // (viewBox × pan × zoom) inverted maps it back to world. No rotation in
  // that matrix, so two corners suffice.
  const ctm = liveContent.getScreenCTM();
  if (!ctm) return fail('no-canvas');
  const toWorld = ctm.inverse();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of roots) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const a = new DOMPoint(r.left, r.top).matrixTransform(toWorld);
    const b = new DOMPoint(r.right, r.bottom).matrixTransform(toWorld);
    const bleed = paintBleed(el);
    minX = Math.min(minX, Math.min(a.x, b.x) - bleed);
    minY = Math.min(minY, Math.min(a.y, b.y) - bleed);
    maxX = Math.max(maxX, Math.max(a.x, b.x) + bleed);
    maxY = Math.max(maxY, Math.max(a.y, b.y) + bleed);
  }
  if (!Number.isFinite(minX)) return fail(opts.ids ? 'nothing-selected' : 'empty');

  const pad = Math.max(0, opts.padding ?? 24);
  let vbX: number;
  let vbY: number;
  let w: number;
  let h: number;
  if (opts.cropRect) {
    // Explicit region (the viewport): exactly what was asked for, no
    // padding. Content outside it is clipped by the viewBox.
    vbX = Math.round(opts.cropRect.x);
    vbY = Math.round(opts.cropRect.y);
    w = Math.max(1, Math.round(opts.cropRect.w));
    h = Math.max(1, Math.round(opts.cropRect.h));
  } else {
    vbX = Math.floor(minX - pad);
    vbY = Math.floor(minY - pad);
    w = Math.max(1, Math.ceil(maxX + pad) - vbX);
    h = Math.max(1, Math.ceil(maxY + pad) - vbY);
  }

  // ── Colours ──────────────────────────────────────────────────────────
  const paperColour =
    tokens && paperFollowsTheme(svgEl)
      ? tokens.get('--paper') || effectivePaperColour(svgEl)
      : effectivePaperColour(svgEl);
  const background =
    typeof opts.background === 'function'
      ? opts.background(paperColour)
      : opts.background !== undefined
        ? opts.background
        : opts.withBackground
          ? paperColour
          : null;

  // ── Clone + crop ─────────────────────────────────────────────────────
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const contentIndex = Array.from(svgEl.children).indexOf(liveContent);
  const contentClone = clone.children[contentIndex] as SVGGElement;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('viewBox', `${vbX} ${vbY} ${w} ${h}`);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.removeAttribute('preserveAspectRatio');
  clone.removeAttribute('data-vellum-canvas');
  // The live root carries `background: canvasPaper ?? var(--paper)` inline
  // - it would paint over a transparent export. The background rect below
  // is the single source of truth.
  clone.removeAttribute('style');
  // Anything the live SVG inherits from the page - the body's font stack,
  // the chrome text colour behind `currentColor` icons - must travel with
  // the clone; the <img> / standalone document has no page to inherit from.
  const liveCs = win.getComputedStyle(svgEl);
  if (liveCs.fontFamily) clone.setAttribute('font-family', liveCs.fontFamily);
  if (liveCs.fontSize) clone.setAttribute('font-size', liveCs.fontSize);
  if (liveCs.color) clone.setAttribute('color', liveCs.color);
  // World units: drop the pan/zoom.
  contentClone.removeAttribute('transform');

  // Root-level scrub: keep <defs>/<style>, the grid backdrop (if asked),
  // and the content group. Everything else is editor chrome.
  for (const child of Array.from(clone.children)) {
    if (child === contentClone) continue;
    if (child.localName === 'defs' || child.localName === 'style') continue;
    const isGrid =
      child.localName === 'rect' && child.getAttribute('fill') === 'url(#dotgrid)';
    if (isGrid && opts.includeGrid) {
      child.setAttribute('x', String(vbX));
      child.setAttribute('y', String(vbY));
      child.setAttribute('width', String(w));
      child.setAttribute('height', String(h));
      continue;
    }
    child.remove();
  }
  // The dot-grid pattern is pinned to screen space with a pan/zoom
  // patternTransform; with the content transform gone it must sit in
  // world space, which is the pattern's own coordinate system.
  clone.querySelectorAll('pattern[patternTransform]').forEach((p) => {
    p.removeAttribute('patternTransform');
  });

  // Content scrub: selection halos, hover rings, marquee, in-flight
  // previews, pen path, measurements - anything that isn't a shape or
  // connector root. With `ids`, unselected roots go too.
  for (const child of Array.from(contentClone.children)) {
    const isShape = child.hasAttribute('data-shape-id');
    const isConn = child.hasAttribute('data-connector-id');
    if (!isShape && !isConn) {
      child.remove();
      continue;
    }
    if (opts.ids) {
      const id = child.getAttribute('data-shape-id') ?? child.getAttribute('data-connector-id');
      if (id == null || !opts.ids.has(id)) child.remove();
    }
  }

  clone.querySelectorAll('[data-export-exclude]').forEach(el => el.remove());

  // ── Theme tokens + var() resolution ──────────────────────────────────
  const cs = win.getComputedStyle(svgEl);
  const rootCs = win.getComputedStyle(doc.documentElement);
  const tokenValue = (v: string) =>
    tokens?.get(v) || cs.getPropertyValue(v).trim() || rootCs.getPropertyValue(v).trim();
  const inlineVars = TOKEN_VARS.map((v) => `${v}: ${tokenValue(v)};`).join(' ');
  const styleEl = doc.createElementNS(SVG_NS, 'style');
  styleEl.setAttribute('data-vellum-tokens', '');
  let styleText = `:root, svg { ${inlineVars} }`;
  if ((opts.animation ?? 'freeze') === 'keep') {
    styleText += '\n' + flowAnimationCss(doc);
  }
  styleEl.textContent = styleText;
  clone.insertBefore(styleEl, clone.firstChild);

  // Background rect - inside the viewBox, behind grid + content. An actual
  // element (rather than a CSS background on the root) so standalone SVG
  // viewers honour it too.
  if (background) {
    const bgRect = doc.createElementNS(SVG_NS, 'rect');
    bgRect.setAttribute('data-vellum-export-bg', '');
    bgRect.setAttribute('x', String(vbX));
    bgRect.setAttribute('y', String(vbY));
    bgRect.setAttribute('width', String(w));
    bgRect.setAttribute('height', String(h));
    bgRect.setAttribute('fill', background);
    // After defs/style, before the grid rect and content.
    const firstContent = Array.from(clone.children).find(
      (c) => c.localName !== 'defs' && c.localName !== 'style',
    );
    clone.insertBefore(bgRect, firstContent ?? null);
  }

  // foreignObject labels → measured native text. Runs BEFORE var
  // resolution: the HTML's inline `color: var(--ink)` etc. resolve through
  // computed style while it lays out in the live document.
  flattenForeignObjects(clone, doc, tokens);

  // Resolve var() refs in every attribute + inline style. Standalone SVG
  // rasterizers don't honour var() in attribute values, only inside
  // <style> blocks and style="" attributes - and even those lack the
  // editor's :root definitions.
  const resolveVars = makeVarResolver(tokenValue);
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('var(')) {
        el.setAttribute(attr.name, resolveVars(attr.value));
      }
    }
    // <style> rule bodies too. A standalone rasterizer honours var() there
    // syntactically but has none of the editor's :root definitions, so an
    // unresolved token silently invalidates the declaration. Icon
    // packs exported from Illustrator carry their paint in exactly these
    // blocks, which is where an icon recolour ends up for them.
    if (el.localName === 'style' && el.textContent?.includes('var(')) {
      el.textContent = resolveVars(el.textContent);
    }
    scrubEditorAttributes(el);
  }

  if ((opts.animation ?? 'freeze') === 'freeze') {
    applyPrismState(clone, PRISM_PARKED_PHASE, 1);
  }

  return {
    clone,
    w,
    h,
    viewBox: { x: vbX, y: vbY, w, h },
    paperColour,
    background,
  };
}

/** Inline the webfonts the clone's text uses. Async (fetches the woff2
 *  files once per session). See export/fonts.ts. */
export function embedCanvasFonts(clone: SVGSVGElement): Promise<EmbedResult> {
  return embedFonts(clone);
}

/** Tuck the diagram's own `.vellum` YAML into the SVG as `<metadata>`, so
 *  the file reopens as an editable diagram (export/source.ts reads it). */
export function attachSourceMetadata(clone: SVGSVGElement, yaml: string): void {
  const doc = clone.ownerDocument;
  clone.querySelector(`metadata#${SVG_SOURCE_ID}`)?.remove();
  const meta = doc.createElementNS(SVG_NS, 'metadata');
  meta.setAttribute('id', SVG_SOURCE_ID);
  meta.setAttribute('data-type', SOURCE_TYPE);
  meta.textContent = yaml;
  const anchor = Array.from(clone.children).find(
    (c) => c.localName !== 'defs' && c.localName !== 'style',
  );
  clone.insertBefore(meta, anchor ?? null);
}

const imageDataCache = new Map<string, Promise<string | null>>();

/** An <img>-loaded SVG can't fetch `blob:` or remote URLs - any `<image>`
 *  not already a `data:` URL would render empty. Fetch each one once (same
 *  origin, or CORS-permitting) and inline it. Failures are left in place
 *  and reported in the result so the caller can warn. */
export async function inlineExternalImages(
  clone: SVGSVGElement,
): Promise<{ inlined: number; failed: number }> {
  const images = Array.from(clone.querySelectorAll('image'));
  let inlined = 0;
  let failed = 0;
  await Promise.all(
    images.map(async (img) => {
      const attr = img.hasAttribute('href') ? 'href' : 'xlink:href';
      const href = img.getAttribute('href') ?? img.getAttribute('xlink:href') ?? '';
      if (!href || href.startsWith('data:')) return;
      let p = imageDataCache.get(href);
      if (!p) {
        p = fetch(href)
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then(
            (blob) =>
              new Promise<string>((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result));
                fr.onerror = () => reject(fr.error);
                fr.readAsDataURL(blob);
              }),
          )
          .catch((err) => {
            console.warn('[vellum export] could not inline image', href, err);
            return null;
          });
        // blob: URLs are revoked by their owners - don't cache those.
        if (!href.startsWith('blob:')) imageDataCache.set(href, p);
      }
      const data = await p;
      if (data) {
        img.setAttribute(attr, data);
        inlined++;
      } else {
        failed++;
      }
    }),
  );
  return { inlined, failed };
}

/** Serialize a prepared clone. `standalone` prepends the XML declaration
 *  for on-disk `.svg` files. */
export function serializeSvg(clone: SVGSVGElement, standalone = false): string {
  const xml = new XMLSerializer().serializeToString(clone);
  return standalone ? `<?xml version="1.0" encoding="UTF-8"?>\n${xml}` : xml;
}
