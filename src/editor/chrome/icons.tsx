/* Vellum chrome icons. Hand-rolled SVG - no lucide-react dependency, since the
 * mock established a specific stroke weight (1.25) and pen-tool feel that
 * doesn't quite match Lucide. Add icons here as needed. */

export const I = {
  cursor: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2l8 8-3.5.5L6 14 3 2z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.12"
      />
    </svg>
  ),
  rect: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="9"
        stroke="currentColor"
        strokeWidth="1.25"
        rx="1"
      />
    </svg>
  ),
  ellipse: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <ellipse
        cx="8"
        cy="8"
        rx="5.5"
        ry="4.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  ),
  diamond: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2l6 6-6 6-6-6 6-6z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  ),
  arrow: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 8h11m0 0l-3-3m3 3l-3 3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  line: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 13.5l11-11"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  text: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4V3h10v1M8 3v10M6 13h4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  more: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="2.5"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <rect
        x="9"
        y="2.5"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <rect
        x="2.5"
        y="9"
        width="4.5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <circle
        cx="11.25"
        cy="11.25"
        r="2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M11.25 10v2.5M10 11.25h2.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  lock: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M5 7V5a3 3 0 016 0v2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  ),
  /** Chevron-down - used by the tabs-bar collapse button. Points DOWN
   *  because the affordance is "send this to the bottom edge". */
  chevronDown: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 6l5 5 5-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  /** Chevron-up - restores a collapsed tabs bar. Points UP for the
   *  "bring this back into view" gesture. */
  chevronUp: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 10l5-5 5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  /** Snap toggle (top-bar). Horseshoe magnet - two parallel prongs joined
   *  by an arc at the bottom, with short caps at the prong tips that read
   *  as "the bits that pull stuff in". Works at 16px. */
  magnet: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 13V8a4.5 4.5 0 019 0v5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M3.5 13h2M10.5 13h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="M3.5 10.5h2M10.5 10.5h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  search: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M11 11l3 3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  zoomIn: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 8h8M8 4v8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  zoomOut: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 8h8"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  publish: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 2l4 4M8 2l-4 4M8 2v9M3 13h10"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  share: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M5.8 7l4.4-2M5.8 9l4.4 2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  ),
  themeLight: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  themeDark: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M13 9.5A6 6 0 016.5 3 6 6 0 1013 9.5z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  ),
  menu: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 5h10M3 8h10M3 11h10"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  moreVert: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="3.5" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.3" fill="currentColor" />
    </svg>
  ),
  empty: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="3"
        y="3"
        width="10"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray="2 2"
        opacity="0.5"
      />
    </svg>
  ),
  laser: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" fill="currentColor" />
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1" opacity="0.6" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  pen: () => (
    /* Classic fountain-pen silhouette pointing down-left at 45°: rectangular
     * barrel along the upper-right diagonal, a tapered nib triangle at the
     * lower-left tip, and a short cap-band line where the body meets the nib.
     * Reads unambiguously as "pen" at 16px. */
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      {/* barrel */}
      <path
        d="M14 2l-1-1-7 7 2 2 7-7-1-1z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      {/* nib */}
      <path
        d="M6 8l-3 5 5-3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      {/* nib slit */}
      <path
        d="M5 10l1 1"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  promote: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 13V3m0 0L4 7m4-4l4 4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  demote: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 3v10m0 0l-4-4m4 4l4-4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  /** Two stacked rounded squares - the universal "copy" idiom. Used by the
   *  top-right Copy-as-PNG action. The back document is drawn as an L-shape
   *  + small right tab so it reads as "an outline peeking out behind the
   *  front rect" without needing a fill to mask the overlap. */
  copy: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect
        x="5"
        y="5"
        width="9"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M3 11V3.5A.5.5 0 013.5 3h7a.5.5 0 01.5.5V5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  /** Container glyph - a dashed frame with a small shape anchored top-left.
   *  Reads as "frame around stuff" without competing visually with the rect
   *  tool icon. Used for the 8 hotkey slot. */
  container: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="2"
        y="3"
        width="12"
        height="11"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray="2 2"
      />
      <rect
        x="3.5"
        y="4.5"
        width="3.5"
        height="3"
        rx="0.6"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="currentColor"
        fillOpacity="0.18"
      />
    </svg>
  ),
  /** "+" glyph in a circle - used for tips, the container "add icon"
   *  affordance, and any other "fill me in" entry point. */
  plusCircle: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 5v6M5 8h6"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  /** Lightbulb - left affordance on the contextual tip-toast (TipToast.tsx).
   *  Outline-only at currentColor so the toast's 35% opacity wrapper tints
   *  it the same as the tip body without a separate fill colour to manage. */
  lightbulb: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.75c-2.35 0-4 1.7-4 3.85 0 1.45.75 2.45 1.5 3.2.55.55.85 1 .85 1.7v.75h3.3v-.75c0-.7.3-1.15.85-1.7.75-.75 1.5-1.75 1.5-3.2 0-2.15-1.65-3.85-4-3.85z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M6.35 12.75h3.3M7 14.25h2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
  /** "?" in a circle - bottom-left tips button. */
  helpCircle: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M6.25 6.25c0-1 .8-1.75 1.75-1.75s1.75.75 1.75 1.75c0 .9-.6 1.3-1.1 1.6-.4.25-.65.5-.65 1.05V9"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11" r="0.65" fill="currentColor" />
    </svg>
  ),
  /** Table glyph - outer rect + one inner row line + one inner column line.
   *  Reads as "grid" without competing with the container icon's dashed-frame
   *  silhouette. Used for the T hotkey slot. */
  table: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="9"
        stroke="currentColor"
        strokeWidth="1.25"
        rx="1"
      />
      <path
        d="M2.5 7h11M2.5 10h11M6.5 3.5v9M10 3.5v9"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  ),
  /** Sticky-note glyph for the Notes-layer contextual toolbar button.
   *  Folded corner cues "note", flat lines hint at written content. */
  /* Draw-layer toggle glyphs. Both are a two-sheet stack - the ghosted sheet
   * behind says "layer", the front sheet says WHICH layer. Shape carries the
   * meaning as well as colour does, so the toggle still reads for anyone who
   * can't tell the blue state from the yellow one. */
  layerBlueprint: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M5.75 2.75h7.5v7.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.4"
      />
      <rect
        x="2.75"
        y="5.25"
        width="8"
        height="8"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      {/* Grid rule - the blueprint-paper tell. Thinner than the sheet so the
       *  outline still reads as the dominant form at 16px. */}
      <path
        d="M6.75 5.25v8M2.75 9.25h8"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.7"
      />
    </svg>
  ),
  layerNotes: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M5.75 2.75h7.5v7.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.4"
      />
      {/* Front sheet with the bottom-right corner turned up - the sticky-note
       *  tell, and the same fold language as the `note` tool glyph. */}
      <path
        d="M4 5.25h5.5a1.25 1.25 0 011.25 1.25v3.75L7.25 13.25H4a1.25 1.25 0 01-1.25-1.25V6.5A1.25 1.25 0 014 5.25z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M10.75 10.25H7.25v3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  ),
  note: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 2.5h7.5L13 5v8.5H3V2.5z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 2.5V5H13"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M5 8h5M5 10.5h4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  ),
};

// TRADEMARK-COMPLIANCE: the `aws-lambda` / `aws-rds` glyphs below are
// generic letterform tokens (λ, ellipse stack) - they don't reproduce
// the AWS service-icon trade dress. They're branded only by the tool id
// they bind to; that's nominative use and is fine to keep.
//
// TRADEMARK-REVIEW: vendor icon used in marketing - these tokens render
// as the default 8 + 9 hotkey glyphs in the floating toolbar. For
// marketing screenshots, change the default bindings (DEFAULT_BINDINGS
// in src/store/editor.ts) to generic tools so the toolbar reads as a
// generic editor - or screenshot a state where the user has rebound 8/9
// to non-vendor tools.

/** Library / custom-binding glyphs. These are the tokens used by tool slots
 *  8 + 9 (and any future user binding). For generic library shapes the
 *  caller can pass `glyph` to render a small label; the AWS tokens fall back
 *  to their own dedicated icons.
 */
export function CustomGlyph({
  tool,
  size = 18,
  glyph,
}: {
  tool: string;
  size?: number;
  glyph?: string;
}) {
  if (glyph && tool !== 'aws-lambda' && tool !== 'aws-rds') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
        <rect
          x="2"
          y="2"
          width="14"
          height="14"
          rx="2"
          fill="currentColor"
          opacity="0.18"
        />
        <rect
          x="2"
          y="2"
          width="14"
          height="14"
          rx="2"
          stroke="currentColor"
          strokeWidth="1"
        />
        <text
          x="9"
          y="12"
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={glyph.length > 2 ? 6 : 8}
          fontWeight={700}
          fill="currentColor"
        >
          {glyph.slice(0, 3)}
        </text>
      </svg>
    );
  }
  if (tool === 'aws-lambda') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
        <rect
          x="2"
          y="2"
          width="14"
          height="14"
          rx="2"
          fill="currentColor"
          opacity="0.18"
        />
        <rect
          x="2"
          y="2"
          width="14"
          height="14"
          rx="2"
          stroke="currentColor"
          strokeWidth="1"
        />
        <text
          x="9"
          y="12"
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize="8"
          fontWeight={700}
          fill="currentColor"
        >
          λ
        </text>
      </svg>
    );
  }
  if (tool === 'aws-rds') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
        <ellipse
          cx="9"
          cy="5"
          rx="5"
          ry="2"
          stroke="currentColor"
          strokeWidth="1.1"
        />
        <path
          d="M4 5v8c0 1.1 2.2 2 5 2s5-.9 5-2V5"
          stroke="currentColor"
          strokeWidth="1.1"
        />
        <path
          d="M4 9c0 1.1 2.2 2 5 2s5-.9 5-2"
          stroke="currentColor"
          strokeWidth="1.1"
        />
      </svg>
    );
  }
  return null;
}
