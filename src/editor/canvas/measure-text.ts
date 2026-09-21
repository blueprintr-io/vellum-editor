// Text-shape measurement.
//
// A `kind: 'text'` shape's bounding box always shrink-wraps to its rendered
// text. There are two modes:
//
//   1. autoSize=true (default after a bare-click drop) - both axes follow
//      content. Width = longest line; height = lines × lineHeight. No wrap;
//      explicit `\n` is the only line break.
//
//   2. autoSize=false (after the user drags the left/right edge to set a
//      wrap width) - width is pinned to shape.w; height auto-grows as the
//      text wraps to fit. Top/bottom edges become no-ops because the only
//      way to "shorten" text is to delete some.
//
// Corner-resize on a text shape is a special handler in Canvas.tsx - it
// scales fontSize, then this measurer computes the new w/h. We don't track
// fontSize separately from the bbox; the bbox is always derived.
//
// Implementation: a single offscreen <div> per page, mutated in place. We
// match the renderer's font setup (fontFamily, fontSize, fontWeight,
// lineHeight 1.2) so measureText agrees with what Shape.tsx will paint.

import type { TextDirection } from '@/store/types';

/** Is this direction one of the vertical (column) variants? */
export function isVerticalDir(dir: TextDirection | undefined): boolean {
  return dir === 'vertical' || dir === 'vertical-upright';
}

/** Map a `TextDirection` to the CSS pair that realises it. Shared by the
 *  renderer (Shape.tsx), the inline editor, the offscreen measurer, and the
 *  export flattener so every surface lays text out identically.
 *
 *  - horizontal       → normal rows.
 *  - vertical         → vertical-rl, glyphs ROTATED 90° (text-orientation:
 *                       mixed) so the line reads sideways.
 *  - vertical-upright → vertical-rl, glyphs UPRIGHT + stacked
 *                       (text-orientation: upright). */
export function textDirectionCss(dir: TextDirection | undefined): {
  writingMode: 'horizontal-tb' | 'vertical-rl';
  textOrientation: 'mixed' | 'upright' | undefined;
} {
  if (dir === 'vertical') {
    return { writingMode: 'vertical-rl', textOrientation: 'mixed' };
  }
  if (dir === 'vertical-upright') {
    return { writingMode: 'vertical-rl', textOrientation: 'upright' };
  }
  return { writingMode: 'horizontal-tb', textOrientation: undefined };
}

/** Line-height used for vertical columns. In vertical writing-mode line-height
 *  controls the CROSS axis (column thickness), not the gap between stacked
 *  glyphs - and a value > 1 leaves half-leading on each side of the line box
 *  that pushes the glyph off-centre within its own column (the "not centred"
 *  bug). 1 keeps the line box ≈ the glyph so flex-centring lands the column
 *  dead-centre, and a too-narrow box overflows symmetrically instead of
 *  clipping one side. */
export const VERTICAL_LINE_HEIGHT = 1;

/** Negative tracking applied to UPRIGHT vertical text. text-orientation:
 *  upright gives every glyph a full ideographic advance (~1.27em), which
 *  reads as cavernous gaps between stacked Latin letters. In vertical
 *  writing-mode letter-spacing acts along the inline (vertical) axis, so a
 *  small negative em value tightens the stack back toward natural leading
 *  without the per-font guesswork an absolute px value would need. Rotated
 *  (mixed) text keeps normal kerning along its sideways line, so this is
 *  upright-only. */
export const VERTICAL_UPRIGHT_LETTER_SPACING = '-0.15em';

/** Full set of CSS overrides that realise a vertical `TextDirection` on a
 *  text-bearing element. Returns `{}` for horizontal so callers can spread it
 *  unconditionally. Pairs with measureText (same line-height + tracking) so
 *  the auto-fit box matches the painted column. */
export function verticalTextStyle(dir: TextDirection | undefined): {
  writingMode?: 'vertical-rl';
  textOrientation?: 'mixed' | 'upright';
  lineHeight?: number;
  letterSpacing?: string;
} {
  if (!isVerticalDir(dir)) return {};
  const { textOrientation } = textDirectionCss(dir);
  return {
    writingMode: 'vertical-rl',
    textOrientation,
    lineHeight: VERTICAL_LINE_HEIGHT,
    letterSpacing:
      dir === 'vertical-upright' ? VERTICAL_UPRIGHT_LETTER_SPACING : undefined,
  };
}

let _measureEl: HTMLDivElement | null = null;

function getMeasureEl(): HTMLDivElement {
  if (_measureEl && document.body.contains(_measureEl)) return _measureEl;
  if (typeof document === 'undefined') {
    throw new Error('measureText: no DOM (called from a non-browser context)');
  }
  const el = document.createElement('div');
  // Off-screen but rendered (display:none would not lay out, so dimensions
  // would all read 0). visibility:hidden + position:absolute keeps it out
  // of pointer hit-testing and accessibility tree without breaking layout.
  Object.assign(el.style, {
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    top: '0',
    left: '0',
    // Box sizing: the editor renders the text in a div with no padding
    // outside its outline; we mirror exactly so screen-space math agrees.
    padding: '0',
    margin: '0',
    border: '0',
    // contenteditable's default is white-space: pre-wrap. For autoSize=true
    // we override to `pre` (no wrap). Set per-call.
    boxSizing: 'content-box',
  });
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  _measureEl = el;
  return el;
}

export type MeasureInput = {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** When set: max-width in CSS px; text wraps to fit. Undefined = no wrap
   *  (autoSize mode), longest line drives width. */
  maxWidth?: number;
  /** Writing direction. Vertical variants measure under
   *  `writing-mode: vertical-rl`; the returned w/h are the ACTUAL pixel box
   *  (the browser does the rotation / stacking) so callers don't swap axes
   *  themselves. Vertical text never wraps, so `maxWidth` is ignored.
   *  Undefined = horizontal. */
  direction?: TextDirection;
};

export type MeasureResult = {
  /** Required width (px) - at least 1 so an empty text shape still has
   *  a non-degenerate bbox. */
  w: number;
  /** Required height (px) - fontSize × lineHeight × line count, at minimum
   *  one line worth. */
  h: number;
};

/** Measure a text run as it would render in the inline editor + Shape.tsx
 *  text path. Returns the bounding box the shape should adopt. */
export function measureText(input: MeasureInput): MeasureResult {
  const el = getMeasureEl();
  el.style.fontFamily = input.fontFamily;
  el.style.fontSize = `${input.fontSize}px`;
  el.style.fontWeight = String(input.fontWeight);
  el.style.lineHeight = String(TEXT_LINE_HEIGHT);
  const vertical = isVerticalDir(input.direction);
  if (vertical) {
    // Vertical: glyphs flow down each column, columns stack right-to-left.
    // We don't support wrapping a column to a height, so always `pre` and
    // let both axes grow with content. The browser computes the rotated
    // box; offsetWidth = total column span, offsetHeight = longest column.
    // text-orientation distinguishes rotated-sideways (mixed) from
    // upright-stacked, which change the glyph metrics - so the measurer
    // must match the renderer's choice or the auto-fit box would be wrong.
    el.style.writingMode = 'vertical-rl';
    el.style.textOrientation =
      input.direction === 'vertical-upright' ? 'upright' : 'mixed';
    // Match the renderer's vertical line-height + tracking so the auto-fit
    // box equals the painted column (see verticalTextStyle).
    el.style.lineHeight = String(VERTICAL_LINE_HEIGHT);
    el.style.letterSpacing =
      input.direction === 'vertical-upright'
        ? VERTICAL_UPRIGHT_LETTER_SPACING
        : 'normal';
    el.style.whiteSpace = 'pre';
    el.style.wordBreak = 'normal';
    el.style.maxWidth = 'none';
    el.style.width = 'auto';
    el.style.maxHeight = 'none';
    el.style.height = 'auto';
  } else {
    el.style.writingMode = 'horizontal-tb';
    el.style.textOrientation = 'mixed';
    el.style.letterSpacing = 'normal';
    if (input.maxWidth !== undefined && input.maxWidth > 0) {
      el.style.whiteSpace = 'pre-wrap';
      el.style.wordBreak = 'break-word';
      el.style.maxWidth = `${input.maxWidth}px`;
      el.style.width = `${input.maxWidth}px`;
    } else {
      el.style.whiteSpace = 'pre';
      el.style.wordBreak = 'normal';
      el.style.maxWidth = 'none';
      el.style.width = 'auto';
    }
    el.style.maxHeight = 'none';
    el.style.height = 'auto';
  }
  // Empty text still needs a one-line-tall box so the editor caret has a
  // visible target. A zero-width-space gives the box height without a
  // visible glyph; on commit InlineLabelEditor strips it before writing.
  el.textContent = input.text === '' ? '​' : input.text;
  // One line's thickness - the minimum the cross axis can be. Horizontal
  // pins height to it (one row tall); vertical pins width to it (one column
  // wide), since an empty vertical column still needs a caret target.
  const lineThickness = Math.ceil(input.fontSize * 1.2);
  if (vertical) {
    const w = Math.max(lineThickness, el.offsetWidth);
    const h = Math.max(1, el.offsetHeight);
    return { w, h };
  }
  const w = Math.max(1, el.offsetWidth);
  const h = Math.max(lineThickness, el.offsetHeight);
  return { w, h };
}

/** Default font metrics for a `kind: 'text'` shape - mirrored exactly in
 *  InlineLabelEditor and Shape.tsx so the measurement, the editor, and the
 *  committed render agree. Update all three in lockstep if defaults change.
 *
 *  TEXT_DEFAULT_FONT_SIZE stays at 13 because it's the fallback fontSize
 *  for body text on rect/ellipse/diamond/note/service shapes too - a global
 *  bump would make every existing diagram's interior text resize. The text
 *  TOOL itself drops shapes with an explicit `fontSize` attached at creation
 *  time (28 for bare click, derived-from-height for drag-create) so the
 *  text-tool default is bigger without disturbing other kinds. */
export const TEXT_DEFAULT_FONT_FAMILY = 'var(--font-body)';
export const TEXT_DEFAULT_FONT_SIZE = 13;
export const TEXT_DEFAULT_FONT_WEIGHT = 500;

/** Default fontSize for a bare-click text-tool drop. Larger than the body-
 *  text default because text shapes are usually annotations / headings, not
 *  inline body copy. Drag-created text shapes derive their fontSize from
 *  the dragged box height instead. */
export const TEXT_DEFAULT_TOOL_FONT_SIZE = 28;

/** Horizontal breathing room between the bbox edge and the rendered glyphs.
 *  Without this gap, applying a stroke to a text shape paints the outline
 *  flush against the letters. Vertical pad stays at 0 because the line-
 *  height multiplier (1.2) already gives glyphs visual headroom. World
 *  units (CSS px at 1× zoom) - the renderer divides by zoom for screen-
 *  consistent visuals.
 *
 *  Honoured by:
 *    - applyTextAutoFit (bbox = text + 2×pad in shrink-wrap mode; fontSize
 *      derives from bbox MINUS 2×pad in fit/wrap modes).
 *    - Shape.tsx text rendering (foreignObject inset by pad).
 *    - InlineLabelEditor (contenteditable inset by pad). */
export const TEXT_BOX_PAD_X = 4;

/** Extra width given to a SHRINK-WRAP (autoSize=true) text shape's bbox
 *  beyond the rendered glyph width. Without this slack the box is exactly
 *  the width of the longest line, so any inward edge drag immediately
 *  cuts into the text and engages wrap mode - users perceived this as
 *  "I just touched the resize bar and the text wrapped". The slack lets
 *  the user nudge the edge inward by ~SHRINK_WRAP_SLACK px before wrap
 *  actually has to kick in. The visual padding (TEXT_BOX_PAD_X) is
 *  unaffected - text still sits PAD_X from the edge; this is added on
 *  top so the bbox just looks slightly roomier. */
export const SHRINK_WRAP_SLACK = 24;

/** Line-height multiplier for horizontal text. The offscreen measuring
 *  element and Shape.tsx's foreignObject both paint at this ratio, so one
 *  line of text occupies `fontSize × TEXT_LINE_HEIGHT` px. Exported so the
 *  n/s resize floor in Canvas.tsx can express "at least one line tall"
 *  without re-hardcoding the number. */
export const TEXT_LINE_HEIGHT = 1.2;
