/* foreignObject → native SVG text, measured from an actual layout.
 *
 * Labels, body text, table cells and container titles render on the canvas
 * as HTML inside <foreignObject> so the browser word-wraps them. That HTML
 * doesn't survive export: <img>-based rasterization renders foreignObject
 * inconsistently across engines (blank on WebKit in several versions), and
 * most non-browser SVG consumers (vector editors, slide apps) ignore it
 * outright.
 *
 * The previous flattener guessed: one <text> per newline, centred, no
 * wrapping. This one MEASURES. Each foreignObject's HTML is cloned into an
 * offscreen host of the same size (same inline styles, same fonts, same
 * document → identical layout), then every character's client rect is read
 * back through a Range. Characters group into lines by their vertical
 * position, lines into runs by computed font/colour/decoration, and each
 * run becomes a <tspan> pinned at its measured x. Baselines come from the
 * glyph rect top plus the font's ascent, measured once per font with a
 * zero-size inline-block probe (an inline-block's bottom edge sits on the
 * baseline) - exact, and immune to line-height.
 *
 * The result reproduces the on-screen wrap, alignment, inline marks
 * (**bold** / *italic* / __underline__), letter-spacing and vertical
 * writing modes to sub-pixel accuracy in any SVG renderer. */

const SVG_NS = 'http://www.w3.org/2000/svg';

type Run = {
  x: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  color: string;
  letterSpacing: string;
  decoration: string;
  /** Product of every ancestor's `opacity` up to the host (1 = opaque). */
  opacity: number;
  /** Effective `text-transform`, applied to the run text on emit. */
  textTransform: string;
};

type Line = {
  /** Inline-axis position of the line's first glyph (x for horizontal,
   *  y for vertical columns). */
  start: number;
  /** Block-axis centre used to bucket characters into lines (y-mid for
   *  horizontal, x-mid for vertical). */
  mid: number;
  /** Top of the first glyph's content box (horizontal lines only). */
  top: number;
  /** Baseline for horizontal lines (glyph top + font ascent); column
   *  centre x for vertical columns. */
  baseline: number;
  runs: Run[];
};

type Measured = {
  vertical: boolean;
  textOrientation: string;
  lines: Line[];
};

function runStyle(textNode: Text, host: HTMLElement): Omit<Run, 'x' | 'text'> {
  const el = textNode.parentElement ?? host;
  const cs = getComputedStyle(el);
  // text-decoration doesn't inherit as a computed value; it PROPAGATES
  // from any ancestor box, and opacity compounds down the tree. Walk up to
  // the host collecting both.
  let decoration = 'none';
  let opacity = 1;
  for (let n: Element | null = el; n && n !== host.parentElement; n = n.parentElement) {
    const ncs = getComputedStyle(n);
    if (decoration === 'none') {
      const d = ncs.textDecorationLine;
      if (d && d !== 'none') decoration = d;
    }
    const o = parseFloat(ncs.opacity);
    if (Number.isFinite(o) && o < 1) opacity *= o;
  }
  return {
    fontFamily: cs.fontFamily,
    fontSize: parseFloat(cs.fontSize) || 13,
    fontWeight: cs.fontWeight || '400',
    fontStyle: cs.fontStyle || 'normal',
    color: cs.color || '#000',
    letterSpacing: cs.letterSpacing === 'normal' ? '' : cs.letterSpacing,
    decoration,
    opacity,
    textTransform: cs.textTransform || 'none',
  };
}

/** Apply a CSS `text-transform` to the characters of one run. Glyph
 *  rects were measured on the transformed text, so the emitted text must
 *  match what was laid out. */
function applyTextTransform(text: string, transform: string): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, pre, ch) => pre + ch.toUpperCase());
    default:
      return text;
  }
}

function sameRun(a: Omit<Run, 'x' | 'text'>, b: Omit<Run, 'x' | 'text'>): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    a.letterSpacing === b.letterSpacing &&
    a.decoration === b.decoration &&
    a.opacity === b.opacity &&
    a.textTransform === b.textTransform
  );
}

/** Lay the foreignObject's HTML out in `host` and read every glyph back. */
function measureHost(host: HTMLElement, doc: Document): Measured {
  // Merge adjacent text nodes up front: the per-line probe below splits and
  // re-normalizes, and normalize() merging two ORIGINAL siblings mid-walk
  // would detach a node we still hold a reference to.
  host.normalize();
  const hostRect = host.getBoundingClientRect();
  // Vertical text carries writing-mode on the text div or an inner wrapper;
  // any descendant with a vertical writing-mode flips the block.
  const vEl = Array.from(host.querySelectorAll<HTMLElement>('*')).find((d) =>
    (getComputedStyle(d).writingMode || '').startsWith('vertical'),
  );
  const vertical = !!vEl;
  const textOrientation = vEl ? getComputedStyle(vEl).textOrientation : 'mixed';

  const lines: Line[] = [];
  const range = doc.createRange();
  const walker = doc.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.nodeValue ?? '';
    if (!text) continue;
    const style = runStyle(node, host);
    let offset = 0;
    for (const ch of text) {
      const len = ch.length;
      const start = offset;
      offset += len;
      // Newlines never paint; U+200B is the zero-width space mdToHtml uses
      // to escape literal markdown markers.
      if (ch === '\n' || ch === '\r' || ch === '​') continue;
      range.setStart(node, start);
      range.setEnd(node, start + len);
      const rects = range.getClientRects();
      const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      // Collapsed whitespace and invisible glyphs report a zero-size box;
      // emitting them would shift later glyphs in the same run.
      if (r.width === 0 && r.height === 0) continue;
      if (!vertical && r.width === 0) continue;
      if (vertical && r.height === 0) continue;
      const mid = vertical
        ? (r.left + r.right) / 2 - hostRect.left
        : (r.top + r.bottom) / 2 - hostRect.top;
      const inlineStart = vertical ? r.top - hostRect.top : r.left - hostRect.left;
      let line = lines[lines.length - 1];
      const tol = Math.max(1.5, style.fontSize * 0.35);
      if (!line || Math.abs(line.mid - mid) > tol) {
        line = {
          start: inlineStart,
          mid,
          top: r.top - hostRect.top,
          baseline: 0,
          runs: [],
        };
        lines.push(line);
      }
      let run = line.runs[line.runs.length - 1];
      if (!run || !sameRun(run, style)) {
        run = { x: inlineStart, text: '', ...style };
        line.runs.push(run);
      }
      run.text += ch;
    }
  }

  // Baselines. A glyph's client rect is the font's content box (ascent +
  // descent, independent of line-height), so baseline = rect top + ascent.
  // The ascent is measured once per font with a 0×0 inline-block probe -
  // an inline-block's bottom edge sits on the baseline - inside an
  // absolutely positioned span so it can't disturb the actual layout.
  // (Inserting the probe into the text itself at each line start was the
  // previous approach; at a soft-wrap boundary the zero-width probe was
  // laid out at the END of the previous line and every wrapped line
  // collapsed onto the one above it.)
  if (!vertical) {
    const ascentCache = new Map<string, number>();
    const ascentFor = (run: Run): number => {
      const key = `${run.fontFamily}|${run.fontSize}|${run.fontWeight}|${run.fontStyle}`;
      let a = ascentCache.get(key);
      if (a !== undefined) return a;
      const wrap = doc.createElement('span');
      wrap.style.cssText =
        'position:absolute;left:0;top:0;white-space:pre;line-height:normal;letter-spacing:normal;';
      wrap.style.fontFamily = run.fontFamily;
      wrap.style.fontSize = `${run.fontSize}px`;
      wrap.style.fontWeight = run.fontWeight;
      wrap.style.fontStyle = run.fontStyle;
      const sample = doc.createTextNode('Hg');
      wrap.appendChild(sample);
      const probe = doc.createElement('span');
      probe.style.cssText =
        'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
      wrap.appendChild(probe);
      host.appendChild(wrap);
      range.selectNodeContents(sample);
      const glyphTop = range.getBoundingClientRect().top;
      a = probe.getBoundingClientRect().bottom - glyphTop;
      wrap.remove();
      if (!Number.isFinite(a) || a <= 0) a = run.fontSize * 0.8;
      ascentCache.set(key, a);
      return a;
    };
    for (const line of lines) {
      line.baseline = line.top + ascentFor(line.runs[0]);
    }
  } else {
    for (const line of lines) {
      line.baseline = line.mid;
    }
  }
  range.detach?.();
  return { vertical, textOrientation, lines };
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Build the replacement <g> for one measured foreignObject. */
function buildTextGroup(
  doc: Document,
  m: Measured,
  fx: number,
  fy: number,
): SVGGElement | null {
  if (m.lines.length === 0) return null;
  const g = doc.createElementNS(SVG_NS, 'g');
  for (const line of m.lines) {
    const textEl = doc.createElementNS(SVG_NS, 'text');
    // Consecutive spaces inside a run are actual (pre / pre-wrap); stop the
    // SVG renderer collapsing them.
    textEl.setAttribute('xml:space', 'preserve');
    textEl.style.whiteSpace = 'pre';
    if (m.vertical) {
      textEl.style.writingMode = 'vertical-rl';
      textEl.style.textOrientation =
        m.textOrientation === 'upright' ? 'upright' : 'mixed';
      // In vertical-rl the inline axis is y: the column's centre line is x
      // and the first glyph starts at the measured top.
      textEl.setAttribute('x', fmt(fx + line.baseline));
      textEl.setAttribute('y', fmt(fy + line.start));
      textEl.setAttribute('dominant-baseline', 'central');
    } else {
      textEl.setAttribute('x', fmt(fx + line.start));
      textEl.setAttribute('y', fmt(fy + line.baseline));
    }
    line.runs.forEach((run, i) => {
      const tspan = doc.createElementNS(SVG_NS, 'tspan');
      if (i > 0) {
        // Pin every run at its measured inline position so a fallback
        // face with different advances can't drift the later runs.
        if (m.vertical) tspan.setAttribute('y', fmt(fy + run.x));
        else tspan.setAttribute('x', fmt(fx + run.x));
      }
      tspan.setAttribute('font-family', run.fontFamily);
      tspan.setAttribute('font-size', fmt(run.fontSize));
      if (run.fontWeight !== '400') tspan.setAttribute('font-weight', run.fontWeight);
      if (run.fontStyle !== 'normal') tspan.setAttribute('font-style', run.fontStyle);
      tspan.setAttribute('fill', run.color);
      if (run.letterSpacing) tspan.setAttribute('letter-spacing', run.letterSpacing);
      if (run.decoration !== 'none') tspan.setAttribute('text-decoration', run.decoration);
      if (run.opacity < 1) tspan.setAttribute('fill-opacity', fmt(run.opacity));
      tspan.textContent = applyTextTransform(run.text, run.textTransform);
      textEl.appendChild(tspan);
    });
    g.appendChild(textEl);
  }
  return g;
}

let clipSeq = 0;

function ensureDefs(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector(':scope > defs') as SVGDefsElement | null;
  if (!defs) {
    defs = svg.ownerDocument.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}

function addClip(
  svg: SVGSVGElement,
  x: number,
  y: number,
  w: number,
  h: number,
  rx: number,
): string {
  const doc = svg.ownerDocument;
  const id = `vellum-export-clip-${++clipSeq}`;
  const clip = doc.createElementNS(SVG_NS, 'clipPath');
  clip.setAttribute('id', id);
  const rect = doc.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', fmt(x));
  rect.setAttribute('y', fmt(y));
  rect.setAttribute('width', fmt(w));
  rect.setAttribute('height', fmt(h));
  if (rx > 0) {
    rect.setAttribute('rx', fmt(rx));
    rect.setAttribute('ry', fmt(rx));
  }
  clip.appendChild(rect);
  ensureDefs(svg).appendChild(clip);
  return id;
}

/** Animated-GIF images render through a foreignObject <img> on the canvas
 *  (SVG <image> stops animating them in Chrome). A static export can use a
 *  plain <image>: same box, same CSS filter, corner radius via clipPath. */
function replaceImageForeignObject(
  svg: SVGSVGElement,
  fo: SVGForeignObjectElement,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const doc = svg.ownerDocument;
  const image = doc.createElementNS(SVG_NS, 'image');
  image.setAttribute('x', fmt(x));
  image.setAttribute('y', fmt(y));
  image.setAttribute('width', fmt(w));
  image.setAttribute('height', fmt(h));
  image.setAttribute('href', img.getAttribute('src') ?? '');
  image.setAttribute('preserveAspectRatio', 'none');
  const radius = parseFloat(img.style.borderRadius) || 0;
  if (radius > 0) {
    image.setAttribute('clip-path', `url(#${addClip(svg, x, y, w, h, radius)})`);
  }
  if (img.style.filter) image.style.filter = img.style.filter;
  fo.replaceWith(image);
}

/** Replace every <foreignObject> in `svg` with measured native text (or an
 *  <image> for wrapped bitmaps). `svg` must be a detached clone - the live
 *  canvas keeps its foreignObjects. Layout happens in `doc` (the editor's
 *  document, so fonts and theme tokens resolve). */
export function flattenForeignObjects(
  svg: SVGSVGElement,
  doc: Document = document,
  /** Custom properties to resolve `var()` against instead of the live
   *  theme - set on the measuring container so `color: var(--ink)` etc.
   *  compute with the export theme's values. */
  tokens: ReadonlyMap<string, string> | null = null,
): void {
  const fos = Array.from(svg.querySelectorAll('foreignObject')) as SVGForeignObjectElement[];
  if (fos.length === 0) return;

  // One offscreen container for every host so the browser lays them all
  // out in a single pass; per-glyph reads afterwards are then cheap.
  const container = doc.createElement('div');
  container.setAttribute('data-vellum-export-measure', '');
  container.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;visibility:hidden;pointer-events:none;contain:layout style;z-index:-1;';
  if (tokens) {
    for (const [name, value] of tokens) container.style.setProperty(name, value);
  }
  const hosts: Array<{ fo: SVGForeignObjectElement; host: HTMLElement | null; x: number; y: number; w: number; h: number }> = [];

  for (const fo of fos) {
    const x = parseFloat(fo.getAttribute('x') || '0') || 0;
    const y = parseFloat(fo.getAttribute('y') || '0') || 0;
    const w = parseFloat(fo.getAttribute('width') || '0') || 0;
    const h = parseFloat(fo.getAttribute('height') || '0') || 0;
    const img = fo.querySelector('img') as HTMLImageElement | null;
    if (img && !(fo.textContent ?? '').trim()) {
      hosts.push({ fo, host: null, x, y, w, h });
      continue;
    }
    if (!(fo.textContent ?? '').trim() || w <= 0) {
      hosts.push({ fo, host: null, x, y, w, h });
      continue;
    }
    const host = doc.createElement('div');
    host.style.cssText = `position:absolute;left:-100000px;top:0;width:${w}px;height:${h}px;overflow:visible;`;
    for (const child of Array.from(fo.childNodes)) {
      host.appendChild(doc.importNode(child, true));
    }
    container.appendChild(host);
    hosts.push({ fo, host, x, y, w, h });
  }
  doc.body.appendChild(container);

  try {
    for (const entry of hosts) {
      const { fo, host, x, y, w, h } = entry;
      if (!host) {
        const img = fo.querySelector('img') as HTMLImageElement | null;
        if (img && w > 0 && h > 0) replaceImageForeignObject(svg, fo, img, x, y, w, h);
        else fo.remove();
        continue;
      }
      const measured = measureHost(host, doc);
      const g = buildTextGroup(doc, measured, x, y);
      if (!g) {
        fo.remove();
        continue;
      }
      // The canvas clips table cells (overflow:hidden) and wrap-mode text
      // shapes (overflow:auto) to their box; mirror that with a clipPath so
      // overflowing lines don't suddenly appear in the export.
      const overflow = (fo.style.overflow || fo.getAttribute('overflow') || '').toLowerCase();
      if ((overflow === 'hidden' || overflow === 'auto' || overflow === 'scroll') && h > 0) {
        g.setAttribute('clip-path', `url(#${addClip(svg, x, y, w, h, 0)})`);
      }
      // Carry transforms/opacity set directly on the foreignObject.
      const tf = fo.getAttribute('transform');
      if (tf) g.setAttribute('transform', tf);
      const op = fo.getAttribute('opacity');
      if (op) g.setAttribute('opacity', op);
      fo.replaceWith(g);
    }
  } finally {
    container.remove();
  }
}
