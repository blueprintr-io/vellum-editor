import type { ShapePreset } from '@/editor/shapes/catalog';
import type { RackConfig, RackUnit } from '@/editor/rack/model';
import type { Notation, Callout } from '@/editor/notation/catalog';
/* Vellum types.
 *
 * RULE: in-memory state === serialised state.
 * No DTOs. No toJSON(). The Zustand store holds shapes that match the YAML/JSON
 * structure exactly. Save = yaml.stringify(state.diagram). Load = state.diagram = yaml.parse(file).
 *
 * ONE carve-out: serialised files additionally carry a derived `graph:`
 * section (+ `graphHash`) - a terse diagrams-as-code view of the connectors,
 * generated at save and reconciled + stripped at load. It never exists in
 * memory, so this type file stays the full truth. See store/graph.ts.
 *
 * Connectors store NO waypoints - paths are derived in render every frame from
 * current shape positions. Manual waypoints only when explicitly added.
 */

export type ShapeKind =
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'polygon'
  | 'service'
  | 'group'
  | 'container'
  | 'note'
  | 'text'
  | 'image'
  | 'freehand'
  | 'icon'
  | 'table'
  | 'rack';

/** Provenance + license metadata attached to a `kind: 'icon'` shape. We embed
 *  this on the shape (rather than looking it up from the catalog at render
 *  time) because:
 *    1. The diagram file must remain self-attributing - exporting a .vellum
 *       to someone else shouldn't depend on them having the same icon packs.
 *    2. Iconify icons may live in a collection that isn't bundled at all.
 *    3. The AttributionsPanel walks the document; it shouldn't need to resolve
 *       catalog entries to know what notices to render. */
export type IconAttribution = {
  /** 'vendor' icons are immutable trademarks (AWS, GCP, etc).
   *  'iconify' icons follow their collection's license - usually permissive. */
  source: 'vendor' | 'iconify';
  /** Stable id within the source - `aws/ec2` for vendor, `mdi:database` for iconify. */
  iconId: string;
  /** Human-readable rights holder shown in the AttributionsPanel. */
  holder: string;
  /** SPDX id ("Apache-2.0", "MIT") for iconify, or "Trademark" for vendor. */
  license: string;
  /** Where the asset originally came from - official asset page or icon-set repo. */
  sourceUrl: string;
  /** Vendor-only - link to brand guidelines so users can verify usage rules. */
  guidelinesUrl?: string;
};

/** Transform locks recorded when an icon is dropped. Vendor icons set all
 *  three; Iconify icons typically only lock aspect (most permissive licenses
 *  allow recolor + rotation). */
export type IconConstraints = {
  /** What the source asset's licence says about recolouring. NOT enforced:
   *  the renderer recolours any icon the user tints (see
   *  `src/icons/recolor.ts`), and the inspector shows the .tint row
   *  unconditionally. Kept on the shape because it's a true fact about the
   *  asset that a future export-compliance report or a per-shape opt-out
   *  would want, and because dropping it would break older saved files. */
  lockColors: boolean;
  /** Enforced - resize keeps the icon's aspect ratio. */
  lockAspect: boolean;
  /** Enforced - the rotation handle isn't drawn. */
  lockRotation: boolean;
};

/** The four Blueprintr brand ramps, ported verbatim from Blueprintr.io's
 *  `--*-prism-gradient` tokens. Each is a five-stop PALINDROME (start → mid →
 *  peak → mid → start) at 0/25/50/75/100%. The palindrome is required,
 *  not decoration: because the tile ends on the colour it started with, the
 *  SVG paint server can use `spreadMethod="repeat"` and scroll forever
 *  without a visible seam. Do NOT "simplify" the ramps to three stops.
 *
 *  The stop colours themselves live in `editor/canvas/prism.ts`, not here, so
 *  a palette retune ships without touching a single saved file. */
export type PrismPalette = 'vellum' | 'stratum' | 'podium' | 'continuum';

/** Scroll cadence for a prism stroke. `'static'` paints the ramp with no
 *  motion at all - still a gradient, just parked mid-ramp. The three moving
 *  speeds map to fixed periods in `editor/canvas/prism.ts` (30s / 18s / 9s),
 *  where `'normal'` = 18s is Blueprintr's canonical cadence.
 *
 *  Deliberately a closed enum rather than a free number: every distinct
 *  period costs one more `<linearGradient>`, and a bounded set is what lets
 *  the renderer mount all of them once and never re-key them. A re-keyed SMIL
 *  node restarts its timeline, so a numeric speed slider would visibly
 *  re-phase every prism shape on the canvas mid-drag. */
export type PrismSpeed = 'static' | 'slow' | 'normal' | 'fast';

/** Animated multi-stop gradient painted onto a shape's OUTLINE - never its
 *  fill, never its label.
 *
 *  Undefined on a Shape means today's behaviour exactly: the outline is
 *  painted with the flat `stroke` colour and nothing about the render
 *  changes. `stroke` is NOT cleared when a gradient is set - it keeps driving
 *  the label colour, the table cell text colour and the icon glyph tint, all
 *  of which are CSS `color` values where an SVG `url(#…)` paint reference is
 *  illegal, and it's what the outline falls back to when the gradient is
 *  removed.
 *
 *  Prism stops are literal brand hex, so this is the one paint in Vellum that
 *  doesn't follow the light/dark toggle. Deliberate - Blueprintr's own prism
 *  doesn't theme-flip either, and literal hex keeps exports independent of
 *  the theme-token whitelist in canvas-export.ts. */
export type StrokeGradient = {
  /** Which brand ramp. Required - a gradient with no palette is meaningless.
   *  The zod schema `.catch`es an unrecognised value back to `'vellum'`
   *  rather than rejecting, because a rejected parse blanks the whole
   *  diagram (the persist `migrate` callback collapses any throwing payload
   *  to an empty document). */
  palette: PrismPalette;
  /** Scroll cadence. Undefined = `'normal'` (18s). */
  speed?: PrismSpeed;
  /** Breathing envelope on the outline - `stroke-opacity` cycles
   *  0.45 → 1 → 1 → 0.45 over 2.4s with Blueprintr's held 20%/55% plateau.
   *  Undefined / false = constant full strength. Independent of `speed`, so
   *  "scrolling, no breathing" and "parked, breathing" are both reachable. */
  pulse?: boolean;
};

export type Layer = 'notes' | 'blueprint';

/** Writing direction for text content - see `Shape.textDirection`. The CSS
 *  mapping (writing-mode + text-orientation) is in `textDirectionCss`. */
export type TextDirection = 'horizontal' | 'vertical' | 'vertical-upright';

/** Where text sits inside (or relative to) a bounding box.
 *
 *  Two parallel families - pick a 3×3 grid cell, then pick whether it sits
 *  inside or outside the bbox:
 *   - INSIDE 3×3 grid (text tucks INTO the box):
 *       `top-left` `inside-top` `top-right`
 *       `inside-left` `center` `inside-right`
 *       `bottom-left` `inside-bottom` `bottom-right`
 *   - OUTSIDE 3×3 grid (text hangs off the box - no inside-center
 *     equivalent because that's just `center`):
 *       `outside-top-left` `above` `outside-top-right`
 *       `left` ▢ `right`
 *       `outside-bottom-left` `below` `outside-bottom-right`
 *
 *  `right-of-icon` is container-only - it sits to the right of the
 *  container's anchor icon child rather than the bbox.
 *
 *  Why two families? Body-bearing kinds (rect/ellipse/diamond/note/service)
 *  read inside-* as "align body inside" and outside-* / cardinal as "label
 *  outside, body stays centred". Without the explicit inside variants users
 *  couldn't pin body text to the top edge inside the shape - picking 'above'
 *  moved the label outside but left the body stranded in the middle.
 *
 *  Tables reuse this enum for `cellAnchor` (table-default cell alignment)
 *  AND for `TableCell.anchor` (per-cell override). Outside-* anchors don't
 *  make sense inside a cell (text can't hang outside a cell wall) so the
 *  table renderer collapses them to `center` for cells. */
export type LabelAnchor =
  | 'center'
  | 'below'
  | 'above'
  | 'left'
  | 'right'
  | 'right-of-icon'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'inside-top'
  | 'inside-bottom'
  | 'inside-left'
  | 'inside-right'
  | 'outside-top-left'
  | 'outside-top-right'
  | 'outside-bottom-left'
  | 'outside-bottom-right';

/** A single cell in a `kind: 'table'` shape.
 *
 *  Sparse-friendly: a missing cell (or a cell that is `null` / `undefined` in
 *  `cells[r]`) renders as empty. We keep this object - instead of just a
 *  string - so each cell can hold its own anchor + lightweight typography
 *  overrides without bloating Shape with one field per axis. */
export type TableCell = {
  /** Plain text content. Multi-line not currently supported (cells are
   *  single-line input boxes); a `\n` would render as a literal character. */
  text?: string;
  /** Per-cell text anchor override. Falls back to `Shape.cellAnchor`, which
   *  itself falls back to `'center'`. Outside-* anchors collapse to
   *  `'center'` at render time - see LabelAnchor's notes. */
  anchor?: LabelAnchor;
  /** Per-cell text colour. Cell renderer uses this; falls back to the
   *  table's `textColor`/`stroke`/layer-default. */
  textColor?: string;
  /** Per-cell font family override. */
  fontFamily?: string;
  /** Per-cell font size override (px in world coords). */
  fontSize?: number;
  /** Per-cell fill colour. Painted as a rect inside the cell behind the
   *  text - independent of the table's overall fill. */
  fill?: string;
};

/** Anchor on a shape:
 *  - `'auto'`  → resolved at render to the cardinal edge facing the other endpoint
 *  - `'top' | 'right' | 'bottom' | 'left'` → fixed cardinal
 *  - `[fx, fy]` → fractional [0..1, 0..1] in shape-local coords (library shapes
 *                 declare these for service-specific anchor points)
 */
export type Anchor =
  | 'auto'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | [number, number];

export type Shape = {
  /** Rack frame and individually linkable U slot, respectively. */
  rack?: RackConfig;
  rackUnit?: RackUnit;
  /** Native UML/BPMN/flowchart geometry and editable notation options. */
  notation?: Notation;
  /** Parametric callout tail, in world units and edge fractions. */
  callout?: Callout;
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  sublabel?: string;
  /** 3-letter glyph for service tiles (`λ`, `RDS`, etc.) */
  icon?: string;
  layer: Layer;
  /** Legacy/optional. The fidelity UX has been removed; the field is kept
   *  optional so existing files load. New shapes don't set it. */
  fidelity?: number;
  /** Stable seed for the sketchy treatment (notes only nowadays). */
  seed?: number;
  /** For `kind === 'image'` - base64 data URL or remote src. */
  src?: string;
  /** For `kind === 'image'` - preset visual filter applied at render time.
   *  `none` (default) shows the image as-is. */
  imageFilter?: 'none' | 'grayscale' | 'sepia' | 'invert' | 'blur';
  /** For `kind === 'image'` - duotone-style tint colour. When set, the
   *  renderer composes a feColorMatrix filter that maps the image's
   *  luminance onto a gradient from black → tint, producing a coloured
   *  silhouette / wash. Stacks with `imageFilter` (the chained CSS filter
   *  runs first, then the tint matrix). Undefined / 'none' / 'transparent'
   *  → no tint, image renders unchanged. */
  imageTint?: string;
  /** For `kind === 'freehand'` - points relative to the shape origin (x, y).
   *  The polyline is rendered as a smooth path; w/h is the bounding box. */
  points?: { x: number; y: number }[];
  /** For `kind === 'polygon'` - number of sides of the regular n-gon
   *  (3 = triangle, 5 = pentagon, 6 = hexagon, …). When `polygonStar` is
   *  set this is the number of star points instead. The polygon is computed
   *  on a unit circle (first vertex at top) then scaled to FILL the bbox, so
   *  a triangle reads apex-top / base-full-width like the diamond does -
 * resizing the box just restretches it. Required at render for
   *  `kind === 'polygon'`; optional in the type only because Shape unions
   *  every kind. Renderer clamps to >= 3. */
  sides?: number;
  /** For `kind === 'polygon'` - a curved/parametric preset that overrides
   *  the n-gon geometry: a cloud, a speech callout, or a semicircle. These
   *  aren't polygons but ride the polygon kind so they reuse its render /
   *  inspector / hit-test / connector wiring. When set, `sides` /
   *  `polygonStar` are ignored. Undefined = regular n-gon. */
  polygonPreset?: ShapePreset;
  /** Closed freeform outline in normalized (0–1) bounding-box coordinates. */
  polygonVertices?: { x: number; y: number }[];
  /** For `kind === 'polygon'` - render as a star (alternating outer/inner
   *  radius) with `sides` points rather than a convex n-gon. Undefined /
   *  false = plain regular polygon. */
  polygonStar?: boolean;
  /** For `kind === 'table'` - number of rows. Defaults to 3 at creation; the
   *  field is required at render time but typed optional because Shape unions
   *  every kind. */
  rows?: number;
  /** For `kind === 'table'` - number of columns. Defaults to 3. */
  cols?: number;
  /** For `kind === 'table'` - cells addressed as `cells[row][col]`. Sparse:
   *  a missing row or cell renders as empty. Each cell carries its own text
   *  + anchor + light typography overrides - see `TableCell`. The legacy
   *  `string[][]` shape is migrated on parse so older save files load. */
  cells?: (TableCell | null)[][];
  /** For `kind === 'table'` - default text anchor for cells that don't
   *  override via `cell.anchor`. Defaults to `'center'` at render. Distinct
   *  axis from `labelAnchor` (which applies to the shape's own optional
   *  title - though tables don't currently render their `label`). */
  cellAnchor?: LabelAnchor;
  /** For `kind === 'table'` - render the first row with header treatment
   *  (bold + slight bg shade). Default false. */
  headerRow?: boolean;
  /** For `kind === 'table'` - render the first column with header treatment.
   *  Default false. */
  headerCol?: boolean;
  /** For `kind === 'table'` - relative row weights. Length should match
   *  `rows`; sparse / missing entries are treated as 1. Renderer normalises
   *  by sum so absolute units don't matter - `[2,1,1]` and `[200,100,100]`
   *  produce the same layout. Undefined = equal-weight rows. Survives
   *  shape resize because weights are fractional. */
  rowHeights?: number[];
  /** For `kind === 'table'` - relative column weights. Same shape as
   *  `rowHeights` but along the x axis. */
  colWidths?: number[];
  /** Group membership. When set, this shape belongs to the group with this id;
   *  selecting a member selects its top-level ancestor group, dragging the
   *  group drags all members. The group itself is a `kind: 'group'` shape with
   *  this field unset (or pointing at a parent group for nested groups). */
  parent?: string;
  /** For `kind === 'container'` - the id of the shape that the container's
   *  label anchors to (the original wrapped child). Stamped at creation by
   *  `makeContainer`; subsequent shapes adopted into the container are
   *  siblings, not anchors. Without this stamp, label positioning would
   *  re-pick whichever child happens to be earliest in the shape array,
   *  which shifts as adoption changes membership. */
  anchorId?: string;
  /** Stroke colour override. CSS colour string (`#1f6feb`, `transparent`,
   *  `var(--ink)`). When undefined the renderer picks based on fidelity/layer. */
  stroke?: string;
  /** Fill colour override. CSS colour string. `'none'` / `'transparent'` are both
   *  honoured for "no fill". Undefined = fidelity-driven default. */
  fill?: string;
  /** Stroke width in px. Undefined = fidelity-driven default (1.25–1.4). */
  strokeWidth?: number;
  /** Solid vs dashed vs dotted line treatment for the body outline. Same axis
   *  as Connector.style. Undefined = `'solid'`. */
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  /** Animated prism gradient for the body outline, replacing the flat
   *  `stroke` colour. Undefined = flat `stroke` - the only behaviour before
   *  this field existed, and still the default.
   *
   *  Honoured for `kind` in rect / service / ellipse / diamond / polygon /
   *  container / freehand / table / text, and for `icon` only when `frame` is
   *  set (a bare icon's `stroke` is its glyph tint, not an outline). Ignored
   *  for `group` (paints `stroke="none"`), `image` (no outline for an actual
   *  bitmap) and `note` (its brown `var(--note-ink)` is a fixed identity).
   *  The single gate is `shapeSupportsPrismStroke()` in
   *  editor/canvas/prism.ts - the renderer and the inspector both call it, so
   *  neither can drift and the panel never offers a control that would paint
   *  nothing.
   *
   *  Rendered as `stroke="url(#vellum-prism-<palette>-<speed>)"` against the
   *  shared defs in editor/canvas/PrismDefs.tsx. Combines with `strokeStyle`
   *  (a dashed prism frame is a legitimate look) and with `strokeWidth`.
   *  See `StrokeGradient` for why `stroke` is kept alongside it. */
  strokeGradient?: StrokeGradient;
  /** Corner radius in user-space px applied to `kind: 'rect'` (and `'service'`)
   *  on the Blueprint layer. Undefined = the kind's default (4 for rect, 8 for
   *  service). The renderer clamps to `min(w, h) / 2` so dragging the slider
   *  high never produces a malformed shape - at the cap, a square reads as a
   *  pill / circle which matches user expectation. Notes-layer rects keep their
   *  baked-in chunky 10 regardless of this field, since the sticker-paper look
   *  doesn't take a clean radius parameter. */
  cornerRadius?: number;
  /** Body text - the wrapping interior text of a shape, distinct from `label`
   *  which is the anchor-positioned heading. When set, body always renders
   *  centred + word-wrapped inside the shape's bbox; `label` keeps its anchor
   *  position. For backwards compat with shapes that use `label` as the
   *  inside text, body falls back to label when undefined.
   *
   *  NOT honoured for `kind === 'text'`. A text shape has exactly one string
   *  and it is in `label` - that's the field the text tool writes, the
   *  field InlineLabelEditor edits, and the field measureText sizes from.
   *  Importers and generators that set `body` on a text shape produced boxes
   *  that rendered one string but edited another (the editor opened empty,
   *  and committing painted the typed text *over* the original). The store
   *  now folds any incoming `body` into `label` on the way in - see
   *  `applyTextAutoFit` in store/editor.ts and `ShapeSchema` in
   *  store/schema.ts. */
  body?: string;
  /** Optional CSS font-family for the label. One of the curated picker
   *  presets, or any custom value. Undefined = the kind's default. */
  fontFamily?: string;
  /** Optional font-size in px applied to the label / body text. Undefined =
   *  the kind's default (18 for sketchy/notes, 13 elsewhere). Set via the
   *  inline-editor flyout while editing a label. */
  fontSize?: number;
  /** Horizontal alignment of label / body text inside the shape. Undefined =
   *  the kind's default - 'center' for `kind === 'text'` (so typed lines look
   *  balanced inside the bbox without the user having to reach for an align
   *  button) and unset (renderer-default 'center') for body-bearing kinds.
   *  Drives both the rendered text-anchor / textAlign in Shape.tsx AND the
   *  inline editor's textAlign in InlineLabelEditor, so commit doesn't visibly
   *  jump. Surfaced via the alignment toggle in FloatingTextToolbar. */
  textAlign?: 'left' | 'center' | 'right';
  /** Where the label sits relative to the shape's body. Undefined = the
   *  kind's default - `below` for icon/image, `right-of-icon` for container,
   *  `center` for everything else. The on-canvas inline editor reads this
   *  field too, so the typing position mirrors the committed position.
   *
   *  See `LabelAnchor` below for the full mapping rationale. */
  labelAnchor?: LabelAnchor;
  /** For `kind === 'container'` only - positions the anchor icon child
   *  inside the frame using the same 3×3 grid as labelAnchor. Resizing the
   *  container or changing this field repositions the child at the matching
   *  corner, edge or centre. Undefined preserves the legacy `top-left`
   *  placement. The renderer and inspector also use `top-left` for values
   *  outside the inside-grid subset of LabelAnchor. */
  iconAnchor?: LabelAnchor;
  /** For `kind === 'text'` only - three ways the bbox + fontSize relate:
   *
   *    `true` (or undefined): SHRINK-WRAP mode. Bbox follows the rendered
   *      text exactly (longest line × line count). No wrap; user types
   *      \n to break a line. fontSize is user-set or default. Created by
   *      bare-clicking the text tool.
   *
   *    `false`: WRAP mode. Width is pinned (set by edge-dragging the
   *      shape); text wraps to that width; height auto-grows with the
   *      wrapped content. fontSize is user-set or default. Created by
   *      drag-creating the text shape, or by edge-dragging an existing
   *      text shape.
   *
   *    `'fit'`: FIT mode. Both axes are user-set (the bbox is whatever
   *      the user dragged); fontSize is auto-DERIVED from the bbox to
   *      make the text fill the box while preserving text aspect ratio.
   *      "Box drives font, not the other way around." Created by
   *      corner-dragging a text shape. The bbox stays put even as the
   *      user types more text - fontSize shrinks to keep text fitting.
   *
   *  See Canvas.tsx resize handlers + applyTextAutoFit for the modes. */
  autoSize?: boolean | 'fit';
  /** For `kind === 'text'` only - a user-pinned MINIMUM height in user-space
   *  px, set by dragging the shape's top or bottom edge.
   *
   *  Every autoSize mode derives `h` from the rendered text, so before this
   *  existed the n/s resize handles were dead: the store's autoFit recomputed
   *  the height on the next mutation and the box snapped straight back. That
   *  made "drag the bottom edge down to give this caption some room" -
 * a thing every other shape kind can do - impossible on a text box.
   *
   *  `minH` is a FLOOR, not a pin: `applyTextAutoFit` takes
   *  `max(measured, minH)`, so the box still grows past it when the text
   *  outgrows the dragged height (text is never clipped), and dragging the
   *  edge back up shrink-wraps again once minH drops below the measured
   *  height. Undefined = pure content-driven height, the old behaviour. */
  minH?: number;
  /** Writing direction of the typed text. Applies to `kind === 'text'`
   *  shapes AND to the interior `body` of basic body-bearing kinds
   *  (rect / ellipse / diamond / polygon / note / service).
   *
   *    `undefined` / `'horizontal'`: normal left-to-right rows that stack
   *      top-to-bottom (the default).
   *
   *    `'vertical'`: CSS `writing-mode: vertical-rl` with
   *      `text-orientation: mixed` - the line is ROTATED 90° so it
   *      reads sideways (axis labels, CJK-style columns). "hello" tips onto
   *      its side.
   *
   *    `'vertical-upright'`: `writing-mode: vertical-rl` with
   *      `text-orientation: upright` - each glyph stays UPRIGHT and the
   *      characters stack top-to-bottom (h / e / l / l / o). Reads like a
   *      marquee / spine label.
   *
   *  For `kind === 'text'` a vertical direction always SHRINK-WRAPS both
   *  axes: there's no "wrap to a width" gesture for a column, so
   *  applyTextAutoFit re-fits the bbox to the rendered column(s) on every
   *  edit. For body-bearing kinds the bbox is user-sized, so the vertical
   *  text just flows inside the fixed box. Honoured in lockstep by
   *  measureText, applyTextAutoFit, Shape.tsx (text + body paths),
   *  InlineLabelEditor, and the export flattener - see `textDirectionCss`.
   *  Surfaced via the orientation picker in FloatingTextToolbar. */
  textDirection?: TextDirection;
  /** Opacity 0..1. Undefined = fully opaque. Applied as the SVG `opacity`
   *  attribute on the shape's group, so it cascades to body, label, and any
   *  embedded icon together. */
  opacity?: number;
  /** Fill-only opacity 0..1. Undefined = the fill is fully opaque (modulo
   *  whatever the parent `opacity` cascades). Distinct from `opacity` -
 * `opacity` fades the shape including stroke + label, whereas
   *  `fillOpacity` only attenuates the body fill so a user can wash out a
   *  rectangle's interior while keeping the outline + text crisp. Composed
   *  multiplicatively with the parent `opacity` per the SVG spec. */
  fillOpacity?: number;
  /** Unified z-order. Higher = drawn on top. Auto-assigned on creation from a
   *  monotonic counter so the most-recently-drawn item naturally sits above
   *  everything else. Send-to-front / send-to-back manipulate this. */
  z?: number;
  /** Label / text colour. Distinct from `stroke` (which is a body outline)
   *  so labelled rectangles can have one outline colour and another text
   *  colour. Undefined = the kind's default. */
  textColor?: string;
  /** For `kind === 'icon'` - raw `<svg>` markup, embedded so the diagram
   *  remains portable + offline-renderable without requiring the icon pack to
   *  be re-fetched on load. Sanitized at ingest time (stripped of <script>,
   *  external refs, event handlers). */
  iconSvg?: string;
  /** For `kind === 'icon'` - provenance + license (see `IconAttribution`).
   *  Required when kind is 'icon'; the canvas reducers and AttributionsPanel
   *  both rely on it. Optional in the type only because Shape unions all kinds. */
  iconAttribution?: IconAttribution;
  /** For `kind === 'icon'` - transform locks. Read by every transform reducer
   *  before applying ops; missing = behave like a regular shape (escape hatch
   *  for icons users have explicitly unlocked, future feature). */
  iconConstraints?: IconConstraints;
  /** Encapsulation frame. When set on a `kind: 'icon'` shape, the icon is
   *  drawn inset inside a circle / square that becomes the shape's ACTUAL
   *  outline: `fill`/`stroke` style the frame and connectors attach to its
   *  perimeter (circle → ellipse math, square → box) instead of the icon's
   *  rasterized silhouette. Undefined = bare icon (silhouette anchoring, no
   *  body). This is NOT a group or container - the icon shape itself *is*
   *  the frame: one shape, one id, no parent. */
  frame?: 'circle' | 'square';
  /** Glyph tint for an ENCAPSULATED icon (`frame` set). Bare icons keep the
   *  legacy coupling where the tint is in `stroke`; once framed, `stroke`
   *  is the frame's border, so the recolour has to move to its own field or
   *  the two controls would fight over one value. Undefined = natural
   *  (autoTint) - the encapsulation default. Only read for `kind: 'icon'`
   *  with a frame, and for artwork assigned to a rack U; ignored otherwise. */
  iconTint?: string;
  /** How `iconTint` / `stroke` is painted onto the icon's artwork.
   *
   *  Undefined = natural: the icon renders with whatever paint it shipped
   *  with, and only the `currentColor` references inside it (if any) follow
   *  the tint. That's the pre-recolour behaviour and what every saved
   *  diagram gets on load, so nothing repaints itself under an upgrade.
   *
   *  Set it - or just pick a tint, which selects a mode implicitly - and the
   *  renderer rewrites the icon's markup so ALL of its paint answers to the
   *  tint:
   *    'solid' - one flat colour across the icon.
   *    'shade' - the tint carried at per-shape opacities derived from the
   *              original artwork's luminance, so a multi-colour icon keeps
   *              its internal structure (and a knockout glyph stays knocked
   *              out) instead of flattening into a silhouette.
   *
   *  The rewrite happens at render time against a copy - `iconSvg` always
   *  holds the pristine original, so clearing the tint restores the icon
   *  exactly. See `src/icons/recolor.ts`. */
  iconRecolor?: 'solid' | 'shade';
  /** Rotation in degrees, applied at render time as a transform around the
   *  shape's center. Honoured for every kind except `group` - see
   *  `shapeSupportsRotation`. Undefined / 0 = no rotation. The bbox
   *  (x/y/w/h) stays AXIS-ALIGNED - rotation only spins the contents inside
   *  it. This deliberately keeps the selection halo and resize handles
   *  predictable: a rotated AWS icon still has a square selection box you can
   *  drag to resize, instead of a tilted oriented bbox that would have to
   *  re-derive aspect math at every angle. */
  rotation?: number;
  /** Mirror the shape's BODY about its own centre - horizontally (`flipH`)
   *  and/or vertically (`flipV`). What ⇧H / ⇧V and the context menu's Flip
   *  commands write.
   *
   *  Stored rather than baked because most bodies have no geometry to bake
   *  it into: an image is a bitmap and an icon is embedded markup, so
   *  "mirrored" can only ever be a render-time transform. (Freehand is the
   *  exception - a stroke's whole shape is in `points`, so it mirrors by
   *  rewriting them and never sets these flags. `shapeSupportsMirror` is the
   *  rule.)
   *
   *  Body only: labels, sublabels and table cell text are rendered as
   *  siblings of the body and stay readable through a flip. The bbox is
   *  unchanged - a mirror maps the box onto itself. Anchors follow the
   *  mirrored body; their stored fractions refer to the original outline.
   *
   *  Composes with `rotation`, which is applied OUTSIDE the mirror. Flipping
   *  a rotated shape therefore also negates `rotation`, which is what makes
   *  the result an actual mirror of what was on screen. */
  flipH?: boolean;
  flipV?: boolean;
  /** When true, the shape exposes a configurable grid of "smart anchor"
   *  points around its perimeter that connectors snap to. Per-shape opt-in
   *  is here; the global default is in the editor store
   *  (`smartAnchorsGlobal`). The two combine as: this field, when set, wins;
   *  otherwise the global default applies. Toggled from the shape inspector
   *  header so every kind (rect, ellipse, icon, container, image, …) can
   *  surface smart anchors without a per-kind UI branch. */
  smartAnchor?: boolean;
  /** Number of smart-anchor points distributed evenly around this shape's
   *  bbox perimeter. Undefined defaults to 8 (corners + edge midpoints -
 * the legacy layout). User adjusts via +/- while the shape is selected;
   *  range is clamped to [SMART_ANCHOR_MIN, SMART_ANCHOR_MAX]. Only
   *  meaningful when `smartAnchor` (or the global default) is on. */
  smartAnchorCount?: number;
  meta?: Record<string, unknown>;
};

/** Curated font picker - five Google Fonts plus the body default. */
export const FONT_PRESETS: { label: string; value: string }[] = [
  { label: 'Default', value: 'var(--font-body)' },
  { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
  { label: 'Lora', value: "'Lora', Georgia, serif" },
  { label: 'JetBrains', value: "'JetBrains Mono', ui-monospace, monospace" },
  { label: 'Patrick', value: "'Patrick Hand', cursive" },
  { label: 'Architect', value: "'Architects Daughter', cursive" },
];

/** Connector endpoint - either bound to a shape (with an anchor) OR a free
 *  floating world-space point (when the line was drawn into empty canvas).
 *
 *  The optional `dangling` flag on the floating variant marks an endpoint that
 *  USED to be bound to a shape that has since been deleted. The endpoint's
 *  (x, y) snapshots the last-known anchor position so the line stays put
 *  visually. The flag is retained for file compatibility but is NO LONGER
 *  surfaced visually - the old red broken-link indicator was removed, so an
 *  orphaned floating endpoint now reads as an ordinary floating line (see the
 *  note in Connector.tsx).
 *
 *  A DIFFERENT failure mode - a *bound* endpoint whose `shape` id no longer
 *  exists in the diagram (e.g. a hand-edited or legacy file) - does not render
 *  at all: `resolveEndpointPoint` returns null and the path is dropped.
 *  Those are not silently swallowed: `collectDanglingRefs` (store/schema.ts)
 *  reports them, the load parsers console-warn, and the YAML dialog shows a
 *  non-blocking warning after Apply. */
export type ConnectorEndpoint =
  | { shape: string; anchor: Anchor }
  | { x: number; y: number; dangling?: boolean };

/** What the connector renders at each end:
 *  - `none`     = bare line (line tool default)
 *  - `arrow`    = open chevron (arrow tool default)
 *  - `triangle` = solid filled triangle (traditional arrowhead)
 *  - `dot`      = small filled circle
 *  - `circle`   = small open circle
 *  - `diamond`  = filled diamond (UML-ish aggregation)
 */
export type EndpointMarker =
  | 'none'
  | 'arrow'
  | 'triangle'
  | 'dot'
  | 'circle'
  | 'diamond'
  | 'hollow-triangle'
  | 'hollow-diamond'
  | 'slash';

export type Connector = {
  relationship?: string;
  fromLabel?: string;
  toLabel?: string;
  id: string;
  from: ConnectorEndpoint;
  to: ConnectorEndpoint;
  /** Layer membership - same axis as Shape.layer. A connector with no layer
   *  field (legacy diagrams) defaults to 'blueprint' at render time so old
   *  files don't accidentally render on the Notes layer. New connectors
   *  inherit the active layer at creation time, which matches user mental
   *  model: drawing arrows while in Notes mode produces Notes arrows. */
  layer?: Layer;
  /** `straight` = direct line, `orthogonal` = elbow, `curved` = soft S-curve.
   *  When `waypoints` are set, the path bends through them in order. */
  routing: 'straight' | 'curved' | 'orthogonal';
  /** Optional user-added bend points. Path is rendered
   *  from-side → ...waypoints → to-side. */
  waypoints?: { x: number; y: number }[];
  /** Segment-edited elbows store route corners. Absent = legacy waypoint
   * interpretation, so opening an existing diagram never reroutes its bends. */
  waypointMode?: 'segments';
  /** Endpoint markers. Defaults: `from = none`, `to = arrow` for arrow tool;
   *  both `none` for line tool. */
  fromMarker?: EndpointMarker;
  toMarker?: EndpointMarker;
  /** Endpoint marker size in user-space (canvas) pixels - independent of
   *  `strokeWidth`. Undefined = "auto", which falls back to the legacy
   *  strokeWidth-relative sizing (so old diagrams render unchanged). The
   *  inspector exposes one slider per end so the user can have e.g. a small
   *  dot on the from-side and a large arrowhead on the to-side without
   *  inflating the line itself. */
  fromMarkerSize?: number;
  toMarkerSize?: number;
  label?: string;
  /** Where along the rendered path the label sits, as a fraction in [0..1]
   *  of the polyline's arclength. Undefined defaults to 0.5 (the midpoint).
   *  Set by drag-the-label interactions; persists with the connector. */
  labelPosition?: number;
  /** Solid vs dashed vs dotted line treatment. */
  style?: 'solid' | 'dashed' | 'dotted';
  /** Marching-dash flow animation along the line, oriented from→to.
   *  Implemented as an animated stroke-dashoffset on a forced dash pattern,
   *  so toggling this on visually overrides `style` with a flowing dash. */
  animated?: boolean;
  /** Render as two parallel lines offset perpendicular to the path. The
   *  marker layout follows: bottom (from→to) line keeps the connector's
   *  from/to markers; top (to→from) line is mirrored so the pair reads as
   *  a bidirectional flow. Combines with `animated` - each line marches
   *  in its own direction. */
  bidirectional?: boolean;
  /** Line jumps: bridge over the connectors this one crosses instead of
   *  cutting through them. Where two hopping lines cross, only the one higher
   *  in the z-order hops. Geometry in `editor/canvas/line-jumps.ts`. */
  hop?: boolean;
  /** Stroke colour override; arrowhead fill follows. Undefined = fidelity-driven. */
  stroke?: string;
  /** Stroke width in px. Undefined = fidelity-driven default (1.25–1.4). */
  strokeWidth?: number;
  /** Opacity 0..1. Undefined = fully opaque. Applied as the SVG `opacity`
   *  attribute on the connector's group so it cascades to line + endpoints
   *  + label together. */
  opacity?: number;
  /** Unified z-order - same axis as Shape.z. */
  z?: number;
  /** Frame membership - same axis as Shape.parent, and like a shape's it can
   *  point at either a `kind: 'container'` or a `kind: 'group'`. The two are
   *  set by different rules:
   *
   *    - CONTAINER - geometric adoption. When BOTH resolved endpoints fall
   *      inside a container's bbox the line becomes that container's child,
   *      so it moves, duplicates and deletes together with the container and
   *      never lingers as an orphan after the container is removed. Purely
   *      derived from geometry, re-evaluated on every commit.
   *    - GROUP - explicit intent, stamped by `groupSelection` and cleared by
   *      `ungroupSelection`. The reconcile pass never touches it, so a
   *      grouped line stays in its group wherever the user drags it.
   *
   *  Persisted either way, so a reopened file keeps the relationship without
   *  a reconcile pass. */
  parent?: string;
  meta?: Record<string, unknown>;
};

export type Annotation = {
  id: string;
  kind: 'comment' | 'todo';
  shape?: string;
  text: string;
  meta?: Record<string, unknown>;
};

/** One entry in the document's content-addressed asset registry - the
 *  raw base64 payload (no `data:` prefix) plus its MIME. Keyed by the
 *  SHA-256 hex of the DECODED bytes. See lib/doc-assets.ts. */
export type DiagramAssetEntry = {
  mime: string;
  data: string;
};

/** This is the file shape verbatim - save adds the derived `graph:` +
 *  `graphHash` projection on top (store/graph.ts), which load strips. */
export type DiagramState = {
  version: '1.0';
  meta: {
    title?: string;
    defaults?: { fidelity?: number; cornerRadius?: number };
  };
  shapes: Shape[];
  connectors: Connector[];
  annotations: Annotation[];
  /** Content-addressed binary payloads referenced by shapes as
   *  `src: asset:<sha256>`. Absent on docs with no large images -
 * asset-free docs serialize byte-identically to the legacy format.
   *  Deliberately NOT versioned: older editors (looseObject parse)
   *  round-trip this key untouched and show placeholders for refs. */
  assets?: Record<string, DiagramAssetEntry>;
};

export type ToolKey =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'  // container
  | '9'  // freehand pen
  | 'f'  // closed freeform shape
  | 'l'  // laser pointer (rebound from K → L 2026-04-27)
  | 't'  // table - basic grid shape, out-of-band like L/N
  | 'n'; // sticky-note (contextual - only surfaced when Notes layer is active)

export type ToolDef = {
  /** Stable internal id (e.g. 'select', 'rect', 'aws-lambda'). */
  tool: string;
  /** Display label for tooltips. */
  label: string;
  /** Built-in icon name OR a custom-glyph token. */
  icon: string;
  /** True when the slot is a user binding (rebound from the default). */
  custom?: boolean;
};

export type LayerMode = 'notes' | 'both' | 'blueprint';

export type Theme = 'dark' | 'light';

export type HotkeyBindings = Record<ToolKey, ToolDef>;
