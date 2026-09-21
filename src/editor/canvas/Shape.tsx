import { PartitionHandles } from '@/editor/notation/PartitionHandles';
import { parseIconSvg } from './icon-svg';
import { RackBody, RackUnitBody } from '@/editor/rack/RackShape';
import { CalloutHandles } from '@/editor/notation/CalloutHandles';
import { NativeShapeBody, NativeShapeText } from '@/editor/notation/NativeShape';
import { calloutTextBox } from '@/editor/notation/geometry';
import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Shape as ShapeT, LabelAnchor, TableCell } from '@/store/types';
import { useEditor } from '@/store/editor';
import { isAssetSrc, resolveShapeSrc } from '@/lib/doc-assets';
import { isMonochromeSvg } from '@/icons/recolorable';
import {
  defaultRecolorMode,
  recolorIconSvg,
  type IconRecolorMode,
} from '@/icons/recolor';
import { useManifest } from '@/icons/manifest';
import { resolveSwatchColor } from '@/editor/swatches';
import { mdToHtml, mdToPlain } from '@/lib/inline-marks';
import {
  jitterDiamond,
  jitterEllipse,
  jitterFoldedRect,
  jitterRoundedRect,
} from './sketch';
import { requestIconSilhouette } from './silhouette';
import { presetPath, polygonVertices, polygonShapeOutline, closedOutlinePath } from './presetPaths';
import {
  mirrorTransform,
  shapeSupportsRotation,
  toShapeLocal,
} from './projection';
import {
  TEXT_BOX_PAD_X,
  isVerticalDir,
  verticalTextStyle,
} from './measure-text';
import { ContainerIconFlyout } from '../chrome/icons/ContainerIconFlyout';
import { isAnimatedRasterDataUrl } from '../gif';
import { PrismCtx } from './PrismDefs';
import {
  PRISM_PULSE_KEYTIMES,
  PRISM_PULSE_SECONDS,
  PRISM_PULSE_SPLINES,
  PRISM_PULSE_VALUES,
  prismGradientId,
  resolvePrismStroke,
} from './prism';

type Props = {
  shape: ShapeT;
};

/** Resolve a CSS colour (hex, rgb()/rgba(), or var(--*)) to RGB triplets in
 *  the 0..1 range that feColorMatrix wants. Returns null when the input
 *  isn't recognisable - caller skips the tint filter entirely in that case.
 *
 *  var() values are resolved against `document.documentElement` at call
 *  time, so a theme switch repaints with the new tint provided the calling
 *  component re-renders (Shape subscribes to `theme` for exactly this). */
function cssColorToRgb01(value: string): { r: number; g: number; b: number } | null {
  if (!value) return null;
  let v = value.trim();
  if (v.startsWith('var(')) {
    if (typeof document === 'undefined') return null;
    const inner = v.slice(4, -1).trim();
    // Strip a fallback if present: "var(--x, #fff)" → "--x".
    const name = inner.split(',')[0].trim();
    const computed = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    if (!computed) return null;
    v = computed;
  }
  if (v.startsWith('#')) {
    return hexToRgb01(v);
  }
  if (v.startsWith('rgb')) {
    return rgbStringToRgb01(v);
  }
  return null;
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '');
  let r: number, g: number, b: number;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6 || h.length === 8) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    return null;
  }
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r: r / 255, g: g / 255, b: b / 255 };
}

function rgbStringToRgb01(s: string): { r: number; g: number; b: number } | null {
  const m = s.match(/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (!m) return null;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r: r / 255, g: g / 255, b: b / 255 };
}

/** SVG `points` string for a `kind: 'polygon'` shape. Delegates to the
 *  shared `polygonVertices` so the drawn edge and the connector/smart-
 *  anchor outline (routing.ts) are derived from one source and can't
 *  drift apart. */
function polygonPoints(
  x: number,
  y: number,
  w: number,
  h: number,
  sides: number,
  star: boolean,
): string {
  return polygonVertices(x, y, w, h, sides, star)
    .map(([px, py]) => `${px},${py}`)
    .join(' ');
}

/** Pure-render shape. Selection halos + corner handles are rendered by
 *  Canvas as an overlay layer - Shape doesn't know whether it's selected.
 *  Pointer events are owned by Canvas; Shape just needs a hit-able body. */
function ShapeImpl({ shape }: Props) {
  // Subscribe to theme so the JS-side colour helpers (cssColorToRgb01 used
  // by the image-tint filter, anything else that resolves a CSS variable)
  // recompute on theme switch. CSS-side var() values would re-paint
  // automatically, but feColorMatrix takes raw numbers we have to resolve
  // ourselves. Reading the value triggers the subscription - we don't need
  // the local binding for anything else.
  useEditor((s) => s.theme);
  // Subscribe to the icon manifest so parametric-vendor lookups (lucide's
  // stroke-width slider, future pack capabilities) re-render once the async
  // fetch resolves. Not gated on `kind === 'icon'` because hooks must run
  // unconditionally - the cost is one re-render per Shape on manifest load,
  // amortised across the session. The hook also kicks off loadManifest()
  // on first mount so a diagram that opens straight to lucide icons (no
  // picker interaction) still triggers the load.
  const manifest = useManifest();
  // Two related flags:
  //  - onNotesLayer: any shape on the Notes layer. Drives the red glow filter
  //    so EVERY object on Notes (including sticky-notes) reads as belonging to
  //    the layer. The glow colour is fixed in the SVG filter (#notes-glow) -
  //    independent of any per-shape stroke override, by design.
  //  - notesSketchy: the red sketchy treatment (red ink + handwriting font +
  //    jittered outlines). Excludes kind==='note' because sticky-notes keep
  //    their own yellow-paper / brown-ink identity - they're a specific shape
  //    living ON the Notes layer, not a generic Notes object.
  const onNotesLayer = shape.layer === 'notes';
  const notesSketchy = onNotesLayer && shape.kind !== 'note';
  // Notes keep the hand-drawn sticky-note look; everything else is refined,
  // unless it's on the Notes layer in which case we sketch it too.
  const sketchy = shape.kind === 'note' || notesSketchy;
  // Default stroke colour: regular ink everywhere. Notes-layer shapes used
  // to default to yellow ink but the yellow stroke read as "highlighted",
  // not "annotation" - the yellow font + halo already brand the layer.
  // Explicit user overrides via the inspector still win.
  const defaultInk = 'var(--ink)';
  // Resolve stored colours through the swatch palette: a saved `var(--*)`
  // passes through unchanged; a saved legacy hex (#fee2e2 etc.) is remapped
  // to its var so existing diagrams autoswitch when the user toggles theme.
  // Custom hexes the user picked outside the palette also pass through.
  const resolvedStroke = resolveSwatchColor(shape.stroke, 'stroke');
  const resolvedFill = resolveSwatchColor(shape.fill, 'fill');
  const stroke = resolvedStroke ?? defaultInk;
  // Prism gradient stroke. `strokePaint` is the OUTLINE-only paint; `stroke` /
  // `resolvedStroke` stay flat colours on purpose, because four downstream
  // consumers feed them into a CSS `color` property, where an SVG `url(#…)`
  // paint reference is ILLEGAL:
  //    icon glyph tint  → style.color
  //    table cell text  → foreignObject HTML
  //    labelColor       → HTML color + <text> fill
  //    the inline editors (InlineLabelEditor / InlineCellEditor)
  // With no gradient set `strokePaint` IS `stroke`, byte for byte - that
  // identity is what makes the flat-stroke path a guaranteed no-op.
  //
  // Note this reads `shape.kind` via resolvePrismStroke, not the destructured
  // `kind` - that binding doesn't exist yet at this point in the function.
  const prism = useContext(PrismCtx);
  const prismStroke = resolvePrismStroke(shape);
  const gradId = prismStroke
    ? prismGradientId(prismStroke.palette, prismStroke.speed)
    : null;
  const strokePaint = gradId ? `url(#${gradId})` : stroke;
  const prismPulsing = !!prismStroke?.pulse && !prism.reduced && prism.animate;
  const accent = notesSketchy ? 'var(--notes-ink)' : 'var(--refined)';
  // Default fill = the paper colour so a "no fill" shape blends with the
  // canvas in either theme. Explicit user overrides still win.
  const fill = resolvedFill ?? 'var(--paper)';
  const strokeWidth = shape.strokeWidth ?? 1.25;
  // Stroke style → strokeDasharray. Same dash pattern as connectors so
  // visual rhyme between a dashed shape outline and a dashed connector
  // landed nearby. Sketchy paths render via per-segment <path> elements
  // (jitter*) so we apply the dasharray on each, plus on the clean
  // non-sketchy renderers below.
  const strokeDash =
    shape.strokeStyle === 'dashed'
      ? '6 4'
      : shape.strokeStyle === 'dotted'
        ? '1.5 4'
        : undefined;
  const fontFamily =
    shape.fontFamily ??
    (sketchy ? 'var(--font-sketch)' : 'var(--font-body)');
  // `shape.fontSize` is the explicit override set by the inline-editor
  // flyout's size field. Undefined falls back to the kind default so unsized
  // shapes keep their old look.
  const fontSize = shape.fontSize ?? (sketchy ? 18 : 13);
  const labelWeight = sketchy ? 400 : 500;

  // During a live resize the geometry can transiently have negative w/h while
  // the user drags through zero. Keep the rect renderable by normalising to
  // positive dims for layout - pointer-up commits the normalised values.
  const rawW = shape.w;
  const rawH = shape.h;
  const w = Math.abs(rawW);
  const h = Math.abs(rawH);
  const x = rawW < 0 ? shape.x + rawW : shape.x;
  const y = rawH < 0 ? shape.y + rawH : shape.y;
  const { kind, label, sublabel, icon, seed = 1, src: rawSrc } = shape;

  // `asset:<sha256>` srcs resolve through the document's content-addressed
  // registry (lib/doc-assets.ts); plain data:/http srcs pass through. The
  // registry subscription only notifies when the assets record itself is
  // replaced (register/prune - rare), and the resolved data URL is
  // memoised so multi-MB base64 strings aren't rebuilt per render. A ref
  // with no matching entry resolves undefined → placeholder rect below.
  const docAssets = useEditor((s) =>
    isAssetSrc(rawSrc) ? s.diagram.assets : undefined,
  );
  const src = useMemo(
    () => resolveShapeSrc(rawSrc, docAssets),
    [rawSrc, docAssets],
  );

  // Containers position their label relative to their ICON anchor child -
  // pull its geometry from the store so the label tracks live during a
  // child resize. Selector returns null for non-containers so the
  // subscription is a no-op.
  //
  // Resolve EXCLUSIVELY through the explicit anchorId stamped at container
  // creation. We deliberately don't fall back to "first icon-kind child by
  // parent" - that fallback caused a bug where dragging an icon into an
  // empty container silently promoted that icon to the container's
  // anchor, even though the user never picked it as the main icon.
  //
  // Critically: only `kind === 'icon'` children count. A container holding
  // a child container / image / group is NOT carrying an icon anchor -
  // pinning the label to the right-of-child in that case put the parent's
  // text floating mid-canvas next to whatever happened to be parented
  // first. The right-of-icon anchor falls back to a top-left-of-container
  // position when there's no icon (handled below in containerLabel).
  const containerChild = useEditor((s) => {
    if (kind !== 'container') return null;
    if (shape.anchorId === undefined) return null;
    const anchor = s.diagram.shapes.find((sh) => sh.id === shape.anchorId);
    // Defensive: ignore stale anchorId pointing at a shape that no
    // longer belongs to this container (e.g., released by drag-out), or
    // an anchorId that points at a non-icon kind (the user replaced the
    // icon with something else, or a save predating the kind check).
    if (anchor && anchor.parent === shape.id && anchor.kind === 'icon') {
      return anchor;
    }
    return null;
  });

  // Icons need a rasterized silhouette so connectors anchor to the visible
  // glyph instead of the bbox. Idempotent - only the first instance of each
  // iconId actually triggers work; the canvas re-renders via the silhouette
  // subscription once the mask lands.
  useEffect(() => {
    if (kind === 'icon') {
      requestIconSilhouette(shape.iconAttribution?.iconId, shape.iconSvg);
    }
  }, [kind, shape.iconAttribution?.iconId, shape.iconSvg]);

  // Cell-level edit pointer - read upfront so the table body branch can
  // suppress the cell currently under InlineCellEditor.
  const editingCell = useEditor((s) => s.editingCell);
  const selectedCell = useEditor((s) => s.selectedCell);
  // BLUEPRINTR_SHAPE_READONLY_PATCH_SUBSCRIBE
  // Read-only viewer slot. Used below to drop the wrap-mode
  // `overflow:auto` so the public reader / Stratum picker never
  // paints a scrollbar inside a text shape. Re-applied on every
  // setup:vellum by scripts/patches/vellum-shape-readonly.mjs.
  const readOnlyEmbed = useEditor((s) => s.readOnly);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);
  // Pointerdown coords on the cell overlay - used to distinguish a click
  // (cell-select) from a drag (table-translate). The canvas's pointerup
  // path doesn't expose its own no-movement flag back here, so we keep a
  // local copy and compare in onClick.
  const cellDownRef = useRef<{ x: number; y: number } | null>(null);

  let body: React.ReactNode = null;
  if (kind === 'rack') {
    body = <RackBody shape={shape} stroke={strokePaint} fill={fill} color={shape.textColor ?? resolvedStroke ?? defaultInk} />;
  } else if (shape.rackUnit) {
    body = <RackUnitBody shape={shape} stroke={strokePaint} fill={fill} color={shape.textColor ?? resolvedStroke ?? defaultInk} />;
  } else if (shape.notation) {
    body = <NativeShapeBody shape={shape} stroke={strokePaint} fill={fill} />;
  } else if (kind === 'rect' || kind === 'service') {
    if (notesSketchy) {
      // Jittered rounded rect for the Notes-layer hand-drawn feel. Paint the
      // fill as a separate clean rect underneath so the jittered outline rides
      // on top - the jitter paths are open contours, no fill-rule trickery
      // needed. Corner radius is generous (10) on Notes - chunky markers on
      // sticker paper, not technical CAD.
      const noteRx = 10;
      const paths = jitterRoundedRect(x, y, w, h, noteRx, seed, 1.15);
      body = (
        <g>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            rx={noteRx}
            fill={fill}
            fillOpacity={shape.fillOpacity}
            stroke="none"
          />
          {paths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={strokePaint}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDash}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      );
    } else {
      // Per-shape corner radius wins over the kind default; clamp to
      // min(w,h)/2 so the user can crank the slider to "pill / circle"
      // without producing a malformed rect.
      const kindDefaultRx = kind === 'service' ? 8 : 4;
      const requested =
        shape.cornerRadius !== undefined ? shape.cornerRadius : kindDefaultRx;
      const rx = Math.max(0, Math.min(requested, Math.min(w, h) / 2));
      body = (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={rx}
          fill={fill}
          fillOpacity={shape.fillOpacity}
          stroke={strokePaint}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDash}
        />
      );
    }
  } else if (kind === 'ellipse') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    if (notesSketchy) {
      const paths = jitterEllipse(cx, cy, rx, ry, seed, 1.45);
      body = (
        <g>
          <ellipse
            cx={cx}
            cy={cy}
            rx={rx}
            ry={ry}
            fill={fill}
            fillOpacity={shape.fillOpacity}
            stroke="none"
          />
          {paths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={strokePaint}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDash}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      );
    } else {
      body = (
        <ellipse
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          fill={fill}
          fillOpacity={shape.fillOpacity}
          stroke={strokePaint}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDash}
        />
      );
    }
  } else if (kind === 'diamond') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const pts = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
    if (notesSketchy) {
      const paths = jitterDiamond(x, y, w, h, seed, 1.15);
      body = (
        <g>
          <polygon
            points={pts}
            fill={fill}
            fillOpacity={shape.fillOpacity}
            stroke="none"
          />
          {paths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={strokePaint}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDash}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      );
    } else {
      body = (
        <polygon
          points={pts}
          fill={fill}
          fillOpacity={shape.fillOpacity}
          stroke={strokePaint}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDash}
        />
      );
    }
  } else if (kind === 'polygon') {
    // Triangle / pentagon / hexagon / star, etc. - plus the curved presets
    // (cloud / callout / semicircle) that ride this kind. All bbox-filled
    // like the diamond so connectors + AABB hit-test (which both work off
    // x/y/w/h) need no special-casing. `round` linejoin keeps acute star
    // tips and the callout's tail from shooting miter spikes past the bbox.
    const common = {
      fill,
      fillOpacity: shape.fillOpacity,
      stroke: strokePaint,
      strokeWidth,
      strokeDasharray: strokeDash,
      strokeLinejoin: 'round' as const,
    };
    body = shape.polygonVertices ? (
      <path data-freeform-outline="" d={closedOutlinePath(polygonShapeOutline(x,y,w,h,{vertices:shape.polygonVertices}))} fillRule="evenodd" {...common} />
    ) : shape.polygonPreset ? (
      <path d={presetPath(shape.polygonPreset, x, y, w, h, shape.callout)} {...common} />
    ) : (
      <polygon
        points={polygonPoints(
          x,
          y,
          w,
          h,
          shape.sides ?? 3,
          shape.polygonStar === true,
        )}
        {...common}
      />
    );
  } else if (kind === 'group') {
    // Groups render as a transparent hit zone by default - the dashed bounding
    // box only appears on hover or selection (overlay rendered by Canvas).
    body = (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill="rgba(0,0,0,0.001)"
        stroke="none"
      />
    );
  } else if (kind === 'container') {
    // Containers render as a visible frame so the user can see the boundary
    // they're dropping things into. The hit zone is the full bbox so a click
    // on the empty interior selects the container; a click on a child still
    // resolves to the child (Canvas's shapeUnder doesn't walk container
    // parents). Stroke + fill are overridable like any other shape, with a
    // hairline default that's visible against either theme's paper.
    const containerStroke = resolvedStroke ?? 'var(--ink-muted)';
    // Prism overrides the frame's paint but not its dash - a dashed prism
    // frame is a legitimate compound look, and `.dash → solid` is still there
    // for a clean unbroken ramp.
    const containerStrokePaint = gradId ? `url(#${gradId})` : containerStroke;
    // Default container body: theme-aware ink + 5% opacity. Splitting the
    // alpha out of the fill string (the previous default baked it into a
    // `rgba(0,0,0,0.02)` literal) lets the user crank the wash up via the
    // new `.fill α` slider all the way to fully opaque without having to
    // fight a hard-coded alpha. `var(--ink)` flips with the theme so the
    // wash reads correctly on both light and dark canvases. 5% is meant
    // to read as "barely-there shading on the canvas" - enough to hint
    // at the frame's interior without competing with the contents.
    const containerFill = resolvedFill ?? 'var(--ink)';
    const CONTAINER_DEFAULT_FILL_OPACITY = 0.05;
    const containerFillOpacity =
      shape.fillOpacity ?? CONTAINER_DEFAULT_FILL_OPACITY;
    // Container dash: dashed by default ("frame, not body"). Solid is the
    // explicit "I want a hard boundary" override; dotted is the third axis.
    // Stroke colour overrides do NOT flip the default to solid - the dashed
    // identity reads as "container", so a recoloured frame should stay
    // dashed unless the user explicitly picks `solid`.
    const containerDash =
      shape.strokeStyle === 'solid'
        ? undefined
        : shape.strokeStyle === 'dotted'
          ? '1.5 4'
          : '6 4';
    if (notesSketchy) {
      const containerRx = 10;
      const paths = jitterRoundedRect(x, y, w, h, containerRx, seed, 1.15);
      body = (
        <g>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            rx={containerRx}
            fill={containerFill}
            fillOpacity={containerFillOpacity}
            stroke="none"
          />
          {paths.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={containerStrokePaint}
              strokeWidth={shape.strokeWidth ?? 1}
              strokeDasharray={containerDash}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
      );
    } else {
      // Per-shape corner radius wins over the container default; clamp to
      // min(w,h)/2 so a large radius on a thin container doesn't render as
      // an over-rounded sliver.
      const containerDefaultRx = 6;
      const containerRequested =
        shape.cornerRadius !== undefined
          ? shape.cornerRadius
          : containerDefaultRx;
      const containerRx = Math.max(
        0,
        Math.min(containerRequested, Math.min(w, h) / 2),
      );
      body = (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={containerRx}
          fill={containerFill}
          fillOpacity={containerFillOpacity}
          stroke={containerStrokePaint}
          strokeWidth={shape.strokeWidth ?? 1}
          strokeDasharray={containerDash}
        />
      );
    }
  } else if (kind === 'freehand') {
    // Freehand pen output. Points are stored relative to (x, y) so we offset
    // them at render time. Render as a smooth Catmull-Rom-derived path so the
    // line reads like an actual pen stroke instead of a jagged polyline.
    const pts = (shape.points ?? []).map((p) => ({ x: p.x + x, y: p.y + y }));
    const d = pts.length >= 2 ? buildSmoothPath(pts) : '';
    body = d ? (
      <path
        d={d}
        fill="none"
        // Bypasses the shared `stroke` binding (freehand defaults to --ink,
        // not defaultInk), so it needs its own prism branch. No bbox maths
        // required - the infinite world-space tiling already covers a
        // smoothed path that overshoots shape.w/h.
        stroke={gradId ? `url(#${gradId})` : (resolvedStroke ?? 'var(--ink)')}
        strokeWidth={shape.strokeWidth ?? 2}
        strokeDasharray={strokeDash}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : null;
  } else if (kind === 'image') {
    // Embedded image (paste / drag-in). Body is the bitmap; fall back to a
    // hatched placeholder if no src is set. CSS filters give us a quick
    // grayscale/sepia/invert/blur without dragging in a full filter pipeline.
    const filterMap: Record<string, string> = {
      grayscale: 'grayscale(100%)',
      sepia: 'sepia(85%)',
      invert: 'invert(100%)',
      blur: 'blur(3px)',
    };
    const cssFilter = shape.imageFilter ? filterMap[shape.imageFilter] : undefined;
    // Roundiness - mirror the rect's clamp `min(w,h)/2` so cranking the
    // slider high produces a circle instead of overshoot artefacts.
    const cr = shape.cornerRadius;
    const clampedR = cr ? Math.max(0, Math.min(cr, Math.min(w, h) / 2)) : 0;
    const clipId = clampedR > 0 ? `img-clip-${shape.id}` : null;
    // Tint - duotone-style luminance mapping. We resolve the swatch first
    // so a stored `var(--stroke-blue)` flips with theme; same hex-recogniser
    // legacy diagrams use elsewhere. `undefined` / 'transparent' / 'none'
    // → skip the filter entirely.
    const tintRaw = shape.imageTint;
    const isMeaningfulTint =
      !!tintRaw && tintRaw !== 'transparent' && tintRaw !== 'none';
    const tintResolved = isMeaningfulTint
      ? resolveSwatchColor(tintRaw, 'stroke') ?? tintRaw
      : null;
    const tintRgb = tintResolved ? cssColorToRgb01(tintResolved) : null;
    const tintFilterId = tintRgb ? `img-tint-${shape.id}` : null;
    body = src ? (
      <g>
        {(clipId || tintFilterId) && (
          <defs>
            {clipId && (
              <clipPath id={clipId}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={clampedR}
                  ry={clampedR}
                />
              </clipPath>
            )}
            {tintFilterId && tintRgb && (
              // Luminance-driven duotone: feColorMatrix #1 collapses the
              // image to its luminance channel (replicated across RGB so
              // the next matrix can scale uniformly). Matrix #2 then maps
              // luminance L to (L*R, L*G, L*B), painting darks → black,
              // mids → mid-tint, brights → tint. Alpha is preserved
              // throughout so the bbox stays untainted by the operation.
              <filter
                id={tintFilterId}
                colorInterpolationFilters="sRGB"
                x="-2%"
                y="-2%"
                width="104%"
                height="104%"
              >
                <feColorMatrix
                  type="matrix"
                  values={`
                    0.299 0.587 0.114 0 0
                    0.299 0.587 0.114 0 0
                    0.299 0.587 0.114 0 0
                    0     0     0     1 0
                  `}
                />
                <feColorMatrix
                  type="matrix"
                  values={`
                    ${tintRgb.r} 0 0 0 0
                    0 ${tintRgb.g} 0 0 0
                    0 0 ${tintRgb.b} 0 0
                    0 0 0 1 0
                  `}
                />
              </filter>
            )}
          </defs>
        )}
        {isAnimatedRasterDataUrl(src) ? (
          /* Animated raster (pasted GIFs). Chrome stopped animating GIFs
           * inside SVG <image href=…> a few releases back, so we route
           * them through a <foreignObject> wrapping an HTML <img> - that
           * path animates reliably across browsers. SVG-side filters
           * (tint) don't apply through foreignObject, but the css filter
           * presets (grayscale/sepia/invert/blur) and the corner-radius
           * round-out apply directly to the inner <img> via inline style. */
          <foreignObject x={x} y={y} width={w} height={h}>
            <img
              src={src}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'fill',
                display: 'block',
                borderRadius: clampedR || undefined,
                filter: cssFilter,
              }}
              draggable={false}
            />
          </foreignObject>
        ) : (
          <image
            x={x}
            y={y}
            width={w}
            height={h}
            href={src}
            // `none` lets the bitmap stretch to fill the bbox, matching what
            // dragging a directional resize handle implies. Hold shift while
            // resizing to scale uniformly.
            preserveAspectRatio="none"
            clipPath={clipId ? `url(#${clipId})` : undefined}
            filter={tintFilterId ? `url(#${tintFilterId})` : undefined}
            style={cssFilter ? { filter: cssFilter } : undefined}
          />
        )}
      </g>
    ) : (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={clampedR || undefined}
        ry={clampedR || undefined}
        fill="rgba(0,0,0,0.04)"
        stroke="var(--ink-muted)"
        strokeDasharray="4 3"
        strokeWidth={1}
      />
    );
  } else if (kind === 'icon') {
    // Vendor / Iconify icon. SVG markup is sanitized at ingest (vendor pack
    // at build time, iconify in resolveIcon). We embed the inner contents
    // inside a fresh nested <svg> sized to the shape's bbox AND carrying the
    // source's viewBox so the contents scale with the wrapper. Without the
    // viewBox the icon would render at its natural pixel size regardless of
    // the bbox - visible as "resize moves the selection halo but not the
    // icon itself." SVG-in-SVG keeps it crisp at any zoom - no rasterization.
    //
    // Recolouring: `style={{ color: tint }}` on the wrapper reaches every
    // `currentColor` reference inside the icon. Artwork that paints with
    // hard-coded colours instead is first rewritten by recolorIconSvg to
    // reference `currentColor` (see below), so the same one mechanism
    // covers monochrome sets, multi-colour vendor art and user imports
    // alike. parseIconSvg also rewrites every element id and `url(#…)` ref
    // inside the SVG to be unique to THIS shape instance. The build script
    // already scopes ids per-icon-catalog-entry - but if the user drops the
    // same Lambda icon twice, both shape instances would share the same
    // scoped ids, and SVG's document-scoped id namespace would again merge
    // their gradients. Stamping the shape id into the id prefix keeps each
    // instance independent.
    // Manifest lookup - `m` flags an icon the build script already rewrote
    // to `currentColor`, `mt` records the chromatic hue it replaced. O(n) in
    // the manifest, but n is bounded and this only fires on icon renders.
    const manifestEntry =
      shape.iconAttribution?.iconId
        ? manifest?.icons.find((e) => e.id === shape.iconAttribution?.iconId)
        : undefined;
    const manifestEntryMono = manifestEntry?.m === true;
    // Monochrome detection runs on the ORIGINAL markup - it's what decides
    // which recolour mode suits the icon, so it has to see the artwork as
    // authored, not as already-rewritten.
    const monoIcon = isMonochromeSvg(shape.iconSvg) || manifestEntryMono;
    // Auto tint: when the user hasn't picked a custom colour, prefer the
    // icon's original chromatic hue if the build script recorded one
    // (AWS Architecture brand colours, branded logos…). Falls back to
    // var(--ink) for strict-grey icons (Red Hat, lucide) so they adapt
    // to the active theme.
    const autoTint = manifestEntry?.mt ?? 'var(--ink)';
    // Glyph tint source. Bare icons keep the legacy coupling - the tint
    // IS `stroke` - so existing diagrams render unchanged. Once framed,
    // `stroke` is the frame's border, so the glyph recolour reads the
    // dedicated `iconTint` instead (the two must not share a field or the
    // inspector's `.tint` and `.stroke` would fight). Undefined either way
    // falls through to autoTint (natural) - still the encapsulation
    // default until the user picks a glyph tint from `.tint`.
    const iconTintColor = shape.frame
      ? resolveSwatchColor(shape.iconTint, 'stroke')
      : resolvedStroke;
    // Recolour mode. Any icon can be recoloured - trademark colours are no
    // longer a gate, so the old `iconConstraints.lockColors` check is gone
    // (the field still rides along on the shape and still drives the
    // attribution badge; it just doesn't veto paint any more).
    //
    // An explicit `iconRecolor` wins. Otherwise picking a tint is itself
    // the opt-in, and the mode is chosen to suit the artwork - flat for a
    // monochrome glyph, tonal for multi-colour art whose structure would
    // be destroyed by flattening. Null = leave the markup alone, which is
    // what an untinted icon gets and therefore what every diagram saved
    // before this feature renders as.
    const recolorMode: IconRecolorMode | null =
      shape.iconRecolor ?? (iconTintColor ? defaultRecolorMode(monoIcon) : null);
    // Rewrite the artwork so every hard-coded paint answers to the
    // wrapper's `color` below. Memoised inside recolorIconSvg, and always
    // against a copy - `shape.iconSvg` keeps the original, so dropping the
    // tint restores the icon exactly.
    const iconMarkup =
      shape.iconSvg && recolorMode
        ? recolorIconSvg(shape.iconSvg, recolorMode)
        : shape.iconSvg;
    // parseIconSvg also rewrites every element id and `url(#…)` reference
    // inside the SVG to be unique to THIS shape instance - see its own note.
    const parsed = iconMarkup ? parseIconSvg(iconMarkup, shape.id) : null;
    // Three cases:
    //   1. user picked a tint → honour it.
    //   2. a recolour is active, or the icon is monochrome (so it paints
    //      through `currentColor` already), and no user tint → fall back to
    //      var(--ink) so the icon adapts to the active theme. Without this,
    //      monochrome icons rendered black-on-dark (and a copy / duplicate
    //      inherited that black). Tying the default to --ink also means a
    //      theme flip live-recolours the icon without saving anything.
    //   3. untouched multi-colour art → no `color` at all; the wrapper rule
    //      would be a no-op for paint that never references currentColor.
    const tint =
      iconTintColor ?? (recolorMode || monoIcon ? autoTint : undefined);
    // Parametric packs (currently only lucide) ship single-stroke icons whose
    // stroke-width is user-adjustable. The vendor key is in the first
    // segment of `iconAttribution.iconId` ("lucide/activity"); look it up in
    // the in-memory manifest for the capability flag. Vendor packs (AWS,
    // Cisco, etc.) leave capabilities undefined → parametricStrokeWidth stays
    // undefined → no style override, baked-in stroke widths render as authored.
    //
    // The width cascades through the wrapper `<svg>`'s inline style, hits the
    // import-time `<g>` (which omits stroke-width on purpose) and propagates
    // to the path. Default 2 = lucide's native design weight; the inspector
    // slider writes `shape.strokeWidth` which we then honour. The same field
    // already drives body-shape outline width - reuse is safe because icon
    // bodies don't render an outline.
    const iconVendorKey = shape.iconAttribution?.iconId?.split('/')[0];
    const iconVendorParametric =
      iconVendorKey != null &&
      manifest?.vendors[iconVendorKey]?.capabilities?.parametric === true;
    const parametricStrokeWidth = iconVendorParametric
      ? (shape.strokeWidth ?? 2)
      : undefined;
    // Rotation now is on the OUTER <g> wrapper for the shape so
    // every kind (icon, rect, ellipse, text, image, …) rotates with the same
    // mechanism. The body itself doesn't need a transform here - the outer
    // wrapper takes care of it. We keep this comment block as a pointer for
    // future debugging: if a label looks wrong on a rotated icon, look at
    // the wrapper's transform attribute (search for `shapeTransform` in this
    // file), not the body builders.
    //
    // Encapsulation frame. When `shape.frame` is set the icon shape renders
    // as a circle/square BODY (styled by fill/stroke exactly like a
    // rect/ellipse) with the glyph inset inside it. The frame - not the
    // silhouette - is the connector outline (routing.ts keys off
    // `shape.frame` via geomKind). The inset keeps the glyph off the stroke;
    // circle uses a tighter box so the glyph stays within the circle's
    // inscribed square with breathing room.
    const frame = shape.frame;
    const fcx = x + w / 2;
    const fcy = y + h / 2;
    const innerSide = frame
      ? Math.min(w, h) * (frame === 'circle' ? 0.6 : 0.66)
      : 0;
    const ix = frame ? fcx - innerSide / 2 : x;
    const iy = frame ? fcy - innerSide / 2 : y;
    const iw = frame ? innerSide : w;
    const ih = frame ? innerSide : h;
    const frameEl = !frame ? null : frame === 'circle' ? (
      <ellipse
        cx={fcx}
        cy={fcy}
        rx={w / 2}
        ry={h / 2}
        fill={fill}
        fillOpacity={shape.fillOpacity}
        stroke={strokePaint}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDash}
      />
    ) : (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={Math.min(w, h) * 0.08}
        fill={fill}
        fillOpacity={shape.fillOpacity}
        stroke={strokePaint}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDash}
      />
    );
    body = parsed ? (
      <g>
        {frameEl}
        <svg
          // Force-remount on icon swap. React's dangerouslySetInnerHTML
          // update path is supposed to clear and replace innerHTML when
          // the __html string changes, but the SVG-namespace handling has
          // historically been flaky - when the user double-clicks to
          // swap a container's anchor icon, the previous icon's parsed
          // children were sometimes hanging on in the DOM, so the new
          // icon visually "drew over" the old one. Keying on the iconId
          // (plus an iconSvg-length disambiguator for user-uploaded
          // SVGs that share the synthetic `user/...` namespace) makes
          // React unmount the old <svg> and mount a fresh one - clean
          // tree, no ghost content. The key change happens iff the icon
          // actually changes, so re-renders for unrelated reasons (a
          // resize, a tint flip) keep the same node and stay cheap.
          key={`${shape.iconAttribution?.iconId ?? 'no-id'}:${shape.iconSvg?.length ?? 0}`}
          x={ix}
          y={iy}
          width={iw}
          height={ih}
          // viewBox transports the source coord system into the new wrapper.
          // Falls back to 0 0 width height (1:1) if the source had no viewBox
          // - better than nothing, but some icons may render off-centre.
          viewBox={parsed.viewBox ?? `0 0 ${parsed.width} ${parsed.height}`}
          // preserveAspectRatio meets the bbox without distortion. With aspect
          // locked at the resize layer, w/h stay proportional anyway; this
          // mainly catches the case where an old file had a non-square icon.
          preserveAspectRatio="xMidYMid meet"
          overflow="visible"
          // Default `fill` for monochrome icons. parseIconSvg drops the root
          // <svg>'s attributes (it returns only inner markup), so the
          // `fill="currentColor"` the build script writes onto the source
          // root gets thrown away. Re-applying it here on the WRAPPER means
          // every descendant path without its own explicit fill inherits
          // `currentColor` via SVG attribute inheritance - and the
          // `style.color` cascade below then resolves currentColor to the
          // user's tint. Without this, Red Hat icons (which paint by
          // omission - no fill attr at all, paths default to black) render
          // as fixed black and ignore the tint slider. Non-monochrome
          // icons leave fill alone so their baked-in brand colours stand.
          fill={monoIcon || recolorMode ? 'currentColor' : undefined}
          // Opt the glyph out of the prism pulse. `stroke-opacity` inherits,
          // and it passes straight through a nested <svg> - the same
          // inheritance the parametric stroke-width above relies on. Without
          // this pin, a framed lucide icon (whose paths paint with
          // `stroke="currentColor"` and no fill) would breathe in lockstep
          // with its frame, when only the OUTLINE is meant to pulse. Pinned
          // on the wrapper rather than the paths so any stroke-opacity baked
          // into the sanitized icon markup still wins, as it did before.
          strokeOpacity={1}
          style={
            tint || parametricStrokeWidth != null
              ? {
                  ...(tint ? { color: tint } : null),
                  ...(parametricStrokeWidth != null ? { strokeWidth: parametricStrokeWidth } : null),
                }
              : undefined
          }
          dangerouslySetInnerHTML={{ __html: parsed.inner }}
        />
      </g>
    ) : (
      // Fallback: empty placeholder if the shape somehow lost its svg
      // (e.g. saved file from before the icon feature shipped). Still draw
      // the frame so an encapsulated-then-broken icon keeps its outline.
      <g>
        {frameEl}
        <rect
          x={ix}
          y={iy}
          width={iw}
          height={ih}
          fill="rgba(0,0,0,0.04)"
          stroke="var(--ink-muted)"
          strokeDasharray="4 3"
          strokeWidth={1}
          // Placeholder chrome, not the outline - see the glyph <svg> above.
          strokeOpacity={1}
        />
      </g>
    );
  } else if (kind === 'note') {
    // Sticky note with a folded top-left corner. The page silhouette is a
    // rect minus the top-left triangle (size = `fold`). The triangle area
    // shows the back-of-paper colour so the corner reads as "peeled forward."
    // The diagonal connecting (x+fold, y) → (x, y+fold) is the crease - it
    // appears naturally in the body outline path. Fold size scales with the
    // smaller bbox dimension so tiny stickers don't get an oversized fold.
    const fold = Math.max(8, Math.min(18, Math.min(w, h) * 0.18));
    const bodyPath =
      `M ${x + fold} ${y} ` +
      `L ${x + w} ${y} ` +
      `L ${x + w} ${y + h} ` +
      `L ${x} ${y + h} ` +
      `L ${x} ${y + fold} ` +
      `Z`;
    // Folded flap - a darker triangle filling the original corner footprint.
    // Sits BEHIND the page so the page's diagonal crease line draws over its
    // hypotenuse, giving a clean fold seam.
    const flapPath =
      `M ${x} ${y} ` +
      `L ${x + fold} ${y} ` +
      `L ${x} ${y + fold} ` +
      `Z`;
    const outline = jitterFoldedRect(x, y, w, h, fold, seed, 1.0);
    body = (
      <g>
        {/* Back-of-paper triangle (slightly darker than body - a paper-fold
         *  shadow, not a hard contrast edge). */}
        <path
          d={flapPath}
          fill="#f0d97a"
          fillOpacity={shape.fillOpacity}
          stroke="none"
        />
        {/* Page body - clean fill so the inner area reads as solid sticker
         *  paper; the jittered outline rides on top. */}
        <path
          d={bodyPath}
          fill="var(--note-bg)"
          fillOpacity={shape.fillOpacity}
          stroke="none"
        />
        {/* Hand-drawn outline + crease (the diagonal is part of the outline
         *  path, so the crease comes for free at the same wobble). */}
        {outline.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="var(--note-ink)"
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
    );
  } else if (kind === 'table') {
    // Outer rect + (rows-1) horizontal + (cols-1) vertical gridlines. Cells
    // render via foreignObject so per-cell anchor (3×3 grid alignment) maps
    // onto a flexbox without re-implementing layout math twice.
    //
    // tableLayout() is the single source of truth for cell positions -
    // honours `rowHeights` / `colWidths` weights so user resizes carry
    // through to text positioning, gridlines, hover overlays, and the
    // canvas's hit-test math.
    const layout = tableLayout({ ...shape, x, y, w, h });
    const { rows, cols, rowEdges, colEdges, rowSizes, colSizes } = layout;
    // All three table stroke sites (outer frame + both gridline families)
    // take the same paint, so the frame and the rules read as one continuous
    // world-space ramp rather than three independently-fitted ones.
    const tableStroke = strokePaint;
    const tableFill = fill;
    const internalStrokeWidth = Math.max(0.5, strokeWidth * 0.7);
    const tableCellAnchor = shape.cellAnchor ?? 'center';
    const cellTextColor =
      shape.textColor ??
      resolvedStroke ??
      (onNotesLayer ? 'var(--notes-ink)' : 'var(--ink)');

    // Header tints - slight shade behind row 0 / col 0 cells so they read as
    // headers without yelling. Tied to var(--ink) at low alpha so light/dark
    // themes both look right.
    const headerTint = 'rgba(127,127,127,0.10)';

    const internalLines: React.ReactNode[] = [];
    for (let r = 1; r < rows; r++) {
      const ly = rowEdges[r];
      internalLines.push(
        <line
          key={`hr-${r}`}
          x1={x}
          y1={ly}
          x2={x + w}
          y2={ly}
          stroke={tableStroke}
          strokeWidth={internalStrokeWidth}
          strokeDasharray={strokeDash}
        />,
      );
    }
    for (let c = 1; c < cols; c++) {
      const lx = colEdges[c];
      internalLines.push(
        <line
          key={`vc-${c}`}
          x1={lx}
          y1={y}
          x2={lx}
          y2={y + h}
          stroke={tableStroke}
          strokeWidth={internalStrokeWidth}
          strokeDasharray={strokeDash}
        />,
      );
    }

    // Per-cell renders: header bg, per-cell fill, and text via foreignObject.
    const cellEls: React.ReactNode[] = [];
    for (let r = 0; r < rows; r++) {
      const row = shape.cells?.[r];
      const cellY = rowEdges[r];
      const cellH_ = rowSizes[r];
      const isHeaderRow = !!shape.headerRow && r === 0;
      for (let c = 0; c < cols; c++) {
        const cell: TableCell | null | undefined = row?.[c] ?? null;
        const cellX = colEdges[c];
        const cellW_ = colSizes[c];
        const isHeaderCol = !!shape.headerCol && c === 0;
        const isHeader = isHeaderRow || isHeaderCol;
        const isEditing =
          editingCell?.shapeId === shape.id &&
          editingCell.row === r &&
          editingCell.col === c;
        // Header tint OR per-cell fill OR (nothing). Per-cell fill wins so
        // a user explicitly painting a cell can override header treatment.
        // Resolve through the swatch palette so per-cell legacy hexes also
        // autoswitch with the theme.
        const fillVal =
          resolveSwatchColor(cell?.fill, 'fill') ??
          (isHeader ? headerTint : undefined);
        if (fillVal) {
          cellEls.push(
            <rect
              key={`cf-${r}-${c}`}
              x={cellX}
              y={cellY}
              width={cellW_}
              height={cellH_}
              fill={fillVal}
            />,
          );
        }
        // Skip text render for the cell currently under InlineCellEditor -
        // the editor paints transparent over it; otherwise the committed
        // text shows through and ghosts the typing cursor.
        if (isEditing) continue;
        const txt = cell?.text;
        if (!txt) continue;
        const anchor = collapseAnchorForCell(
          cell?.anchor ?? tableCellAnchor,
        );
        const cellAlign = anchorToFlex(anchor);
        const cellFontFamily =
          cell?.fontFamily ?? fontFamily;
        const cellFontSize = cell?.fontSize ?? fontSize;
        const cellColor = cell?.textColor ?? cellTextColor;
        const cellWeight = isHeader ? 600 : 400;
        cellEls.push(
          <foreignObject
            key={`ct-${r}-${c}`}
            x={cellX}
            y={cellY}
            width={Math.max(cellW_, 0)}
            height={Math.max(cellH_, 0)}
            style={{ pointerEvents: 'none', overflow: 'hidden' }}
          >
            <div
              {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: cellAlign.alignItems,
                justifyContent: cellAlign.justifyContent,
                textAlign: cellAlign.textAlign,
                padding: '4px 6px',
                fontFamily: cellFontFamily,
                fontSize: cellFontSize,
                fontWeight: cellWeight,
                color: cellColor,
                lineHeight: 1.2,
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
                whiteSpace: 'pre-wrap',
                boxSizing: 'border-box',
              }}
            >
              {/* Inline marks (**bold** / *italic* / __underline__) render
               *  through mdToHtml exactly like every other text-bearing
               *  shape. Rendering `{txt}` raw was the other half of the
               *  "Bold does nothing in a table cell" bug: even once the
               *  editor started committing markers, the cell painted them
               *  literally. Wrapped in a single block child for the same
               *  reason the body text is - inline elements dropped straight
               *  into a flex parent each become a flex item and <br> stops
               *  breaking lines. */}
              <div
                {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
                style={{ minWidth: 0, maxWidth: '100%' }}
                dangerouslySetInnerHTML={{ __html: mdToHtml(txt) }}
              />
            </div>
          </foreignObject>,
        );
      }
    }

    // Cell selection / hover overlays - drawn over the body but under the
    // gridlines so the grid stays crisp. Selection ring is accent-coloured
    // + slightly thicker; hover is a faint accent wash.
    const overlayRects: React.ReactNode[] = [];
    const hoverIsThis =
      hoverCell &&
      // suppress hover overlay when the user is editing or selecting this
      // exact cell - duplicating the highlight reads as a render bug.
      !(
        (editingCell?.shapeId === shape.id &&
          editingCell.row === hoverCell.row &&
          editingCell.col === hoverCell.col) ||
        (selectedCell?.shapeId === shape.id &&
          selectedCell.row === hoverCell.row &&
          selectedCell.col === hoverCell.col)
      );
    if (hoverIsThis && hoverCell) {
      overlayRects.push(
        <rect
          key="hover"
          x={colEdges[hoverCell.col]}
          y={rowEdges[hoverCell.row]}
          width={colSizes[hoverCell.col]}
          height={rowSizes[hoverCell.row]}
          fill="rgba(31,111,235,0.06)"
          stroke="rgba(31,111,235,0.35)"
          strokeWidth={1}
          // Pin the opacity so the cell affordance doesn't inherit the prism
          // pulse from the wrapper <g> - chrome shouldn't breathe. No-op when
          // the shape isn't pulsing.
          strokeOpacity={1}
          pointerEvents="none"
        />,
      );
    }
    if (
      selectedCell?.shapeId === shape.id &&
      selectedCell.row < rows &&
      selectedCell.col < cols
    ) {
      overlayRects.push(
        <rect
          key="sel"
          x={colEdges[selectedCell.col]}
          y={rowEdges[selectedCell.row]}
          width={colSizes[selectedCell.col]}
          height={rowSizes[selectedCell.row]}
          fill="rgba(31,111,235,0.10)"
          stroke="var(--accent)"
          strokeWidth={1.4}
          // See the hover rect above - chrome opts out of the prism pulse.
          strokeOpacity={1}
          pointerEvents="none"
        />,
      );
    }

    // Interactive overlay - sits ON TOP so cell-level pointer events
    // resolve to it. Translates pointer position into (row, col) and
    // routes to hover / select / dblclick handlers. Single-click only
    // promotes a cell to selectedCell when the table is already selected
    // (otherwise the user's first click should select the table itself,
    // matching every other shape kind). The actual selection of the
    // table happens through the canvas's normal pointerdown flow - we
    // only HANDLE the cell-routing intent here.
    //
    // Hit-test uses the same weighted layout the renderer uses so resized
    // rows/cols pick up correctly. Closure over the live `layout` (and the
    // constituent edge arrays) - captured at render time, valid until
    // next render which itself recomputes from latest weights.
    const hitCellFromEvent = (
      e: React.PointerEvent | React.MouseEvent,
    ): { row: number; col: number } => {
      const el = e.currentTarget as SVGRectElement;
      // Client → this rect's own user space via the inverse screen CTM.
      // The overlay is inside the shape's rotated <g>, so the CTM
      // carries pan + zoom + rotation and the result is directly in the
      // table's LOCAL frame (x..x+w, y..y+h) - exactly what rowEdges /
      // colEdges are expressed in. The old bounding-rect fraction only
      // worked un-rotated: getBoundingClientRect() is the axis-aligned
      // envelope of the rotated rect, so on a rotated table the fraction
      // pointed at the wrong cell.
      let wx: number;
      let wy: number;
      const ctm = el.getScreenCTM?.();
      if (ctm) {
        const local = new DOMPoint(e.clientX, e.clientY).matrixTransform(
          ctm.inverse(),
        );
        wx = local.x;
        wy = local.y;
      } else {
        // No CTM (detached / non-browser) - fall back to the envelope math,
        // which is exact whenever the table isn't rotated.
        const rect = el.getBoundingClientRect();
        wx = x + ((e.clientX - rect.left) / rect.width) * w;
        wy = y + ((e.clientY - rect.top) / rect.height) * h;
      }
      let cc = cols - 1;
      for (let i = 0; i < cols; i++) {
        if (wx < colEdges[i + 1]) {
          cc = i;
          break;
        }
      }
      let rr = rows - 1;
      for (let i = 0; i < rows; i++) {
        if (wy < rowEdges[i + 1]) {
          rr = i;
          break;
        }
      }
      return {
        row: Math.max(0, Math.min(rows - 1, rr)),
        col: Math.max(0, Math.min(cols - 1, cc)),
      };
    };
    const interactiveOverlay = (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="rgba(0,0,0,0.001)"
        // pointer-events: all so this catches mouse moves even though
        // it's transparent.
        pointerEvents="all"
        onPointerMove={(e) => {
          const hit = hitCellFromEvent(e);
          if (!hoverCell || hoverCell.row !== hit.row || hoverCell.col !== hit.col) {
            setHoverCell(hit);
          }
        }}
        onPointerLeave={() => setHoverCell(null)}
        onPointerDown={(e) => {
          cellDownRef.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          // Drag-vs-click filter - if the user moved more than the
          // canvas's drag threshold between pointerdown and click, treat
          // it as a drag (which the canvas already handled) and don't
          // promote a cell to selected. 4px / no-zoom-scaling roughly
          // matches the canvas's DRAG_THRESHOLD; exact parity isn't needed
          // for this overlay.
          const d = cellDownRef.current;
          cellDownRef.current = null;
          if (
            d &&
            (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4)
          ) {
            return;
          }
          // Only promote to cell-select when the host table is already
          // selected - otherwise let the canvas's normal click-to-select
          // path run by NOT preventing default / not stopping propagation.
          // useEditor.getState() reads the live selection without
          // re-subscribing this overlay on every selection change.
          const st = useEditor.getState();
          if (!st.selectedIds.includes(shape.id)) return;
          const hit = hitCellFromEvent(e);
          st.setSelectedCell({ shapeId: shape.id, row: hit.row, col: hit.col });
          // Don't stopPropagation - the canvas pointerup already ran by
          // the time onClick fires, so it doesn't matter for selection;
          // and we want shape-level keybindings (Esc, Delete, etc.) to
          // still operate against the table when a cell is highlighted.
        }}
        onDoubleClick={(e) => {
          // Double-click → enter cell-edit mode. The canvas's own
          // dblclick handler already does the same routing, but it
          // depends on the user clicking near the centre of the
          // shape's bbox; with the overlay catching events first, the
          // computation is local + reliable.
          const hit = hitCellFromEvent(e);
          useEditor
            .getState()
            .setEditingCell({ shapeId: shape.id, row: hit.row, col: hit.col });
          e.stopPropagation();
        }}
      />
    );

    body = (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill={tableFill}
          fillOpacity={shape.fillOpacity}
          stroke={tableStroke}
          strokeWidth={strokeWidth}
          strokeDasharray={strokeDash}
          rx={2}
        />
        {cellEls}
        {overlayRects}
        {internalLines}
        {interactiveOverlay}
      </g>
    );
  } else if (kind === 'text') {
    // Text shape - fill paints body bg; stroke draws the box outline (now
    // properly distinct from text colour, which is on `textColor`). With
    // no overrides the body stays a transparent hit zone so plain labels
    // float without a frame.
    const hasFill =
      shape.fill !== undefined &&
      shape.fill !== 'transparent' &&
      shape.fill !== 'none';
    const hasStroke =
      shape.stroke !== undefined &&
      shape.stroke !== 'transparent' &&
      shape.stroke !== 'none';
    // A prism gradient is itself a request for an outline: a text shape that
    // has one but no explicit stroke colour must still paint a box. Without
    // this the rect gets stroke="none" AND strokeWidth={0}, and the gradient
    // is invisible - the one kind where the choke-point substitution alone
    // isn't enough.
    const paintsStroke = hasStroke || gradId !== null;
    body = (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        // Use the resolved (theme-aware) values so legacy-hex text shapes
        // also autoswitch - the hasFill/hasStroke flags above only check
        // for "is there a value at all", which is unchanged by resolution.
        fill={hasFill ? (resolvedFill as string) : 'rgba(0,0,0,0.001)'}
        // Only honour fillOpacity when there's an actual user-picked fill;
        // the 0.001-alpha hit zone path stays exactly as-is so a
        // text shape with no fill remains an invisible click target.
        fillOpacity={hasFill ? shape.fillOpacity : undefined}
        stroke={paintsStroke ? strokePaint : 'none'}
        strokeWidth={paintsStroke ? strokeWidth : 0}
        strokeDasharray={paintsStroke ? strokeDash : undefined}
        rx={4}
      />
    );
  }

  // Label colour:
  //   1) explicit `textColor` override - applies to every kind
  //   2) note → its dedicated brown
  //   3) "auto" (undefined textColor) → follows the shape's stroke when one
  //      is set, otherwise the layer default. Matches user expectation that
  //      a recoloured outline should bring its label along.
  //   4) Notes-layer non-note → red (matches stroke)
  //   5) everything else → ink
  const labelColor =
    shape.textColor ??
    (kind === 'note'
      ? '#5b4a14'
      : resolvedStroke ??
        (onNotesLayer ? 'var(--notes-ink)' : 'var(--ink)'));

  // While the inline editor is overlaying this shape, suppress the
  // underlying label/body painting - otherwise the committed text shows
  // through the editor's now-transparent background and ghosts the
  // typing cursor. Other shapes paint normally; only the actively-edited
  // one drops its label.
  const isEditingThis = useEditor((s) => s.editingShapeId === shape.id);

  // Multi-line label support - split on \n. Default anchor depends on kind:
  // icons + images get their text BELOW the body so the picture isn't
  // obscured; everything else is centred. Frames (group + container) skip
  // this branch - their label is in `groupLabel` below.
  //
  // Wrapping: when the label is anchored *inside* the shape (anchor 'center'
  // - the default for rect/ellipse/diamond/text), we render via SVG
  // foreignObject + an HTML div so word-wrap actually fires. SVG <text> by
  // itself doesn't wrap; users got clipped one-liners. For external anchors
  // (above/below/left/right) we keep the plain <text> path since wrapping
  // there would either need a fixed wrap-width (we don't have one) or look
  // strange.
  const labelAnchor =
    shape.labelAnchor ??
    (kind === 'icon' || kind === 'image' ? 'below' : 'center');
  // Body-bearing shapes store text in `body`. An outside anchor promotes
  // that text to the label position when no separate label is set, so
  // choosing 'above' or 'below' moves the text outside the shape.
  const isOutsideAnchor =
    labelAnchor === 'above' ||
    labelAnchor === 'below' ||
    labelAnchor === 'left' ||
    labelAnchor === 'right' ||
    labelAnchor === 'outside-top-left' ||
    labelAnchor === 'outside-top-right' ||
    labelAnchor === 'outside-bottom-left' ||
    labelAnchor === 'outside-bottom-right';
  const isBodyBearing =
    kind === 'rect' ||
    kind === 'ellipse' ||
    kind === 'diamond' ||
    kind === 'polygon' ||
    kind === 'note' ||
    kind === 'service';
  // Basic geometric primitives - `label` is suppressed entirely; only `body`
  // is ever painted. The labelAnchor field still drives where body text
  // lands (inside cells via bodyEl, outside slots via the promotion path).
  const isBasicShape =
    kind === 'rect' ||
    kind === 'ellipse' ||
    kind === 'diamond' ||
    kind === 'polygon';
  // Body text - when set, takes over the inside of the shape (wrapped).
  // When body is set, the label moves to its anchor; if the anchor was
  // 'center' (the inside-text default), we visually nudge the label to
  // sit ABOVE the body so the two don't overlap.
  const body_ = shape.body;
  // PROMOTION: outside-anchor + body-bearing + body-set → treat the body
  // string as the label so it lands at the outside slot. The inside body
  // render is suppressed below to prevent a double paint. The `!label`
  // guard is dropped for basic shapes since they never render `label`
  // anyway, so body should win regardless of whether label is set.
  const promoteBodyToLabel =
    isOutsideAnchor && isBodyBearing && !!body_ && (isBasicShape || !label);
  const effectiveLabel = promoteBodyToLabel ? body_ : label;
  // SVG <text> can't render inline marks (no `<b>` inside `<text>` - would
  // need <tspan>s with explicit weight/style), so the outside-anchor path
  // uses the plain-stripped form. Inside-foreignObject paths render marks
  // via dangerouslySetInnerHTML further down.
  const lines = effectiveLabel ? mdToPlain(effectiveLabel).split('\n') : [];
  const layout = computeLabelLayout(shape, x, y, w, h, fontSize, !!sublabel);
  // `center` is the only fully-inside anchor that wraps via foreignObject -
  // every other inside-* / corner anchor uses the <text> path because we
  // pin to a single edge / corner and don't care about wrap-width.
  const labelIsInside = labelAnchor === 'center';
  // `kind: 'text'` is deliberately NOT here: a text shape's one string is
  // in `label`, which is also the only field InlineLabelEditor writes. When
  // text shapes rendered `body` too, a shape carrying both painted them
  // stacked - the imported string underneath, the user's edit on top. The
  // store + schema now fold any stray `body` into `label` on the way in, so
  // this set is body-bearing kinds only.
  const showBodyInside = !!body_ && isBodyBearing && !promoteBodyToLabel;
  // Text shape rendering - three autoSize modes:
  //   true   (shrink): bbox = text bbox (via store autoFit). No wrap.
  //   false  (wrap):   bbox.w pinned, h grows. Text wraps to bbox.w.
  //   'fit':           bbox preserved, fontSize derived to fit. No wrap.
  // Only the 'wrap' mode actually wraps; the other two render text flush
  // top-left at fontSize and let it overflow visually if it's somehow
  // wider than the bbox (shouldn't happen - autoFit keeps them aligned).
  const isAutoSizingText =
    kind === 'text' && shape.autoSize !== undefined;
  const isWrapMode = shape.autoSize === false;
  // Text orientation applies to `kind: 'text'` shapes AND the interior body
  // of basic body-bearing kinds (rect / ellipse / diamond / polygon / note /
  // service). verticalTextStyle bundles the writing-mode + text-orientation +
  // line-height + tracking that the measurer + inline editor also use, so the
  // box, the typing caret, and the committed glyphs all agree. For
  // `kind: 'text'` a vertical direction also drives applyTextAutoFit's
  // shrink-wrap.
  const dirSupported = kind === 'text' || isBodyBearing;
  const textDir = dirSupported ? shape.textDirection : undefined;
  const isVerticalText = kind === 'text' && isVerticalDir(textDir);
  const isVerticalBody = isVerticalDir(textDir);
  const vTextStyle = verticalTextStyle(textDir);
  // Text shapes default to centred alignment so short lines / one-word
  // annotations don't look glued to the left edge with empty space on the
  // right (which read as "padding too much on the right" before - the bbox
  // padding is symmetric, but left-aligned text leaves the right gap visible).
  // textAlign is overridable per-shape via the flyout toolbar.
  const textAlign: 'left' | 'center' | 'right' =
    shape.textAlign ?? (kind === 'text' ? 'center' : 'left');
  // Basic shapes never render their `label` - the only path that paints at
  // the label slot for them is body promotion (effectiveLabel === body_).
  const labelEl = !isEditingThis && effectiveLabel && kind !== 'group' && kind !== 'container' && kind !== 'table' && !(isBasicShape && !promoteBodyToLabel) && (
    isAutoSizingText ? (
      <foreignObject
        // Inset by TEXT_BOX_PAD_X horizontally so a stroke applied to the
        // text shape doesn't paint flush against the glyphs. The bbox
        // outer dimensions (which the body rect / stroke uses) stay at
        // shape.x / shape.w; the text content area is the inner inset.
        x={x + TEXT_BOX_PAD_X}
        y={y}
        width={Math.max(w - 2 * TEXT_BOX_PAD_X, 0)}
        height={Math.max(h, 0)}
        // overflow:visible on the foreignObject - scrollbars (if any) are
        // applied to the inner div instead, since several browsers ignore
        // CSS `overflow` on foreignObject elements directly.
        style={{ pointerEvents: 'none', overflow: 'visible' }}
      >
        <div
          {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
          style={{
            width: '100%',
            // height:100% only in WRAP mode so the inner div fills the
            // bbox. In SHRINK-WRAP mode the bbox
            // already matches text height, so an explicit 100% would
            // just stretch the line-box pointlessly. Alignment along the
            // writing axis is driven by textAlign so each line is
            // centred / left / right inside the inner div.
            //
            // Vertical text fills the height too so textAlign - which in
            // vertical-rl aligns glyphs along the (now vertical) inline
            // axis - has room to distribute top / centre / bottom.
            height: isWrapMode || isVerticalText ? '100%' : undefined,
            padding: 0,
            margin: 0,
            fontFamily,
            fontSize,
            fontWeight: labelWeight,
            color: labelColor,
            lineHeight: 1.2,
            textAlign,
            // Vertical directions rotate (mixed) or stack-upright the column.
            // Spread last so the writing-mode + tighter line-height/tracking
            // override the horizontal lineHeight above; {} for horizontal.
            ...vTextStyle,
            whiteSpace: isWrapMode ? 'pre-wrap' : 'pre',
            wordBreak: isWrapMode ? 'break-word' : 'normal',
            overflowWrap: isWrapMode ? 'break-word' : 'normal',
            // The bbox now grows with content (no height cap in
            // applyTextAutoFit), so wrap-mode text never overflows in
            // practice. overflow:auto stays as a safety valve for legacy
            // docs saved back when the store capped h at 800px - those
            // shapes re-measure (and un-cap) on their first edit.
            // BLUEPRINTR_SHAPE_READONLY_PATCH_OVERFLOW
            overflow: isWrapMode
              ? readOnlyEmbed
                ? 'hidden'
                : 'auto'
              : 'visible',
            boxSizing: 'content-box',
          }}
          // Render bold/italic/underline marks. mdToHtml emits only b/i/u/br
          // tags + escaped text - never user HTML.
          dangerouslySetInnerHTML={{ __html: mdToHtml(effectiveLabel) }}
        />
      </foreignObject>
    ) : labelIsInside && !showBodyInside ? (
      // Wrapping inside-shape label - foreignObject + flex centring.
      <foreignObject
        x={x}
        y={y}
        width={Math.max(w, 0)}
        height={Math.max(h, 0)}
        style={{ pointerEvents: 'none', overflow: 'visible' }}
      >
        <div
          // xmlns is required for foreignObject HTML to render reliably across
          // Safari + Firefox. React strips it on `div`s by default - wire it
          // through xmlns explicitly.
          {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '4px 8px',
            fontFamily,
            fontSize,
            fontWeight: labelWeight,
            color: labelColor,
            lineHeight: 1.2,
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
            whiteSpace: 'pre-wrap',
            boxSizing: 'border-box',
          }}
        >
          {/* Single block wrapper around the inline-mark HTML - see the body
           *  renderer for the full rationale. A <b>/<i>/<u> run injected
           *  directly into this flex container becomes its own flex item, so
           *  a trailing <br> stops breaking the line and the formatted run
           *  collides with the next line. Wrapping keeps inline flow intact. */}
          <div
            {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
            style={{ minWidth: 0, maxWidth: '100%' }}
            dangerouslySetInnerHTML={{ __html: mdToHtml(effectiveLabel) }}
          />
        </div>
      </foreignObject>
    ) : (
      <g style={{ pointerEvents: 'none' }}>
        {lines.map((line, i) => (
          <text
            key={i}
            x={layout.x}
            y={layout.lineY(i, lines.length)}
            textAnchor={layout.textAnchor}
            fontFamily={fontFamily}
            fontSize={fontSize}
            fontWeight={labelWeight}
            fill={labelColor}
          >
            {line}
          </text>
        ))}
      </g>
    )
  );

  // Body text element - wrapping HTML inside foreignObject. The body's
  // alignment tracks `labelAnchor` for inside anchors (center / corners),
  // so the inspector's anchor picker actually moves body text instead of
  // pinning it forever to the centre. Outside anchors (above / below /
  // left / right) make no sense for an interior wrapping body, so those
  // collapse to centred - the user's heading floats outside the shape via
  // labelEl, the body stays inside.
  //
  // For basic shapes (rect / ellipse / diamond / note / service) the
  // inline editor writes to `body`, so without this wiring the user sees
  // the anchor picker do nothing on the interior text they just typed -
  // which was the bug being fixed here.
  const bodyAlign = (() => {
    // Mapping rule: each anchor picks one cell of a 3x3 grid, then chooses
    // inside vs outside. The body always is inside, so:
    //   - inside-* / corner anchors → align body to that cell
    //   - center                    → centred
    //   - outside-* / cardinal      → label hangs outside the bbox; body
    //                                 keeps its centred default so the
    //                                 outside heading isn't competing with
    //                                 a strangely-aligned interior block.
    // Flex axes here are: alignItems = vertical, justifyContent = horizontal.
    switch (labelAnchor) {
      case 'top-left':
        return {
          alignItems: 'flex-start' as const,
          justifyContent: 'flex-start' as const,
          textAlign: 'left' as const,
        };
      case 'inside-top':
        return {
          alignItems: 'flex-start' as const,
          justifyContent: 'center' as const,
          textAlign: 'center' as const,
        };
      case 'top-right':
        return {
          alignItems: 'flex-start' as const,
          justifyContent: 'flex-end' as const,
          textAlign: 'right' as const,
        };
      case 'inside-left':
        return {
          alignItems: 'center' as const,
          justifyContent: 'flex-start' as const,
          textAlign: 'left' as const,
        };
      case 'inside-right':
        return {
          alignItems: 'center' as const,
          justifyContent: 'flex-end' as const,
          textAlign: 'right' as const,
        };
      case 'bottom-left':
        return {
          alignItems: 'flex-end' as const,
          justifyContent: 'flex-start' as const,
          textAlign: 'left' as const,
        };
      case 'inside-bottom':
        return {
          alignItems: 'flex-end' as const,
          justifyContent: 'center' as const,
          textAlign: 'center' as const,
        };
      case 'bottom-right':
        return {
          alignItems: 'flex-end' as const,
          justifyContent: 'flex-end' as const,
          textAlign: 'right' as const,
        };
      // 'center' + every outside anchor (above/below/left/right/outside-*
      // corners): body stays centred inside the shape's bbox while the
      // label hangs outside.
      default:
        return {
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
          textAlign: 'center' as const,
        };
    }
  })();
  // If a label is also present and was inside, we leave room at the top for
  // it (label rides above the body in that case).
  const calloutBody = shape.polygonPreset === 'callout' ? calloutTextBox(shape) : {x,y,w,h};
  const bodyEl = showBodyInside && !isEditingThis && (
    <foreignObject
      x={calloutBody.x}
      y={calloutBody.y}
      width={Math.max(calloutBody.w, 0)}
      height={Math.max(calloutBody.h, 0)}
      style={{ pointerEvents: 'none', overflow: 'visible' }}
    >
      <div
        {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: bodyAlign.alignItems,
          // shape.textAlign (set by the flyout's align toggle) overrides
          // the anchor-derived horizontal alignment so the user can make
          // a centre-anchored body left-aligned. Falls back to the anchor
          // default. justifyContent must follow textAlign so a one-word
          // line still hugs the chosen edge.
          justifyContent: shape.textAlign
            ? shape.textAlign === 'left'
              ? 'flex-start'
              : shape.textAlign === 'right'
                ? 'flex-end'
                : 'center'
            : bodyAlign.justifyContent,
          textAlign: shape.textAlign ?? bodyAlign.textAlign,
          padding: labelEl && labelIsInside ? '22px 8px 6px' : '6px 8px',
          fontFamily,
          fontSize,
          fontWeight: 400,
          color: labelColor,
          lineHeight: 1.3,
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          whiteSpace: 'pre-wrap',
          boxSizing: 'border-box',
        }}
      >
        {/* Inner wrapper holds the inline-mark HTML. It MUST be a single
         *  block child of the flex container: injecting <b>/<i>/<u> + <br>
         *  straight into a flex parent makes each inline ELEMENT its own
         *  flex item laid out in a row, so the <br> after a bold run stops
         *  breaking the line - the bold text and the next line render
         *  side-by-side (reported as "bolding ignores the newline"). Wrapping
         *  restores normal inline flow inside one block; the flex parent only
         *  positions this block. min-width:0 lets it shrink so word-wrap still
         *  fires under justify-content; the typography is inherited from the
         *  parent. */}
        <div
          {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
          style={{
            minWidth: 0,
            // Vertical body text: rotate / stack only the inner text block so
            // the OUTER flex container keeps centring it (a writing-mode on a
            // flex container would flip its main/cross axes). The flex parent
            // positions this block; this block flows the glyphs vertically.
            // For vertical the column sizes to its own content (no maxWidth
            // clamp + no flex-shrink) so flex-centring lands it dead-centre
            // and a too-narrow box overflows symmetrically instead of
            // clipping the left edge. Horizontal keeps maxWidth:100% so body
            // text still wraps inside the box.
            maxWidth: isVerticalBody ? 'none' : '100%',
            flexShrink: isVerticalBody ? 0 : undefined,
            ...vTextStyle,
          }}
          dangerouslySetInnerHTML={{ __html: mdToHtml(body_) }}
        />
      </div>
    </foreignObject>
  );

  const sublabelEl = sublabel && (
    <text
      x={x + w / 2}
      y={y + h / 2 + 14}
      textAnchor="middle"
      fontFamily={sketchy ? 'var(--font-sketch)' : 'var(--font-mono)'}
      fontSize={sketchy ? 14 : 10}
      fill="var(--ink-muted)"
      style={{ pointerEvents: 'none' }}
    >
      {sublabel}
    </text>
  );

  // Containers anchor their label according to `labelAnchor` (default
  // 'right-of-icon' so the legacy "name to the right of the child" reads as
  // before). Other anchors compute their position relative to the container
  // frame's bbox the same way labelEl does for non-frame shapes.
  //
  // Groups keep the legacy top-edge pill always - they don't carry an
  // explicit `labelAnchor` model.
  const containerAnchor =
    kind === 'container'
      ? shape.labelAnchor ?? 'right-of-icon'
      : null;
  const containerLabel = (() => {
    if (kind !== 'container' || !label) return null;
    if (containerAnchor === 'right-of-icon') {
      if (containerChild) {
        return {
          x: containerChild.x + Math.abs(containerChild.w) + 12,
          y:
            containerChild.y +
            Math.abs(containerChild.h) / 2 +
            fontSize * 0.35,
          anchor: 'start' as const,
        };
      }
      // No icon child - anchor the label in the container's top-left,
      // PAD inset on both axes. Previously this branch parked the label
      // on the icon-row centreline (PAD + 20 from the top) so dropping
      // an icon in later wouldn't nudge it down - but with no icon
      // actually present that left ~32px of dead space above the text.
      // Better to look right NOW; if the user later adds an icon the
      // label re-centres against it. SVG `text` y is the baseline, so we
      // push the baseline down by ~one ascender from the top inset to
      // get a visible PAD of clear space above the cap-height.
      // A child container / nested group inside this container no longer
      // gets the parent's title pinned to its right edge - the title sits
      // in the parent container's top-left where it belongs.
      const PAD = 12;
      return {
        x: x + PAD,
        y: y + PAD + fontSize * 0.85,
        anchor: 'start' as const,
      };
    }
    if (containerAnchor === 'top-left') {
      return {
        x: x + 8,
        y: y + fontSize + 4,
        anchor: 'start' as const,
      };
    }
    if (containerAnchor === 'top-right') {
      return {
        x: x + w - 8,
        y: y + fontSize + 4,
        anchor: 'end' as const,
      };
    }
    if (containerAnchor === 'bottom-left') {
      return {
        x: x + 8,
        y: y + h - 6,
        anchor: 'start' as const,
      };
    }
    if (containerAnchor === 'bottom-right') {
      return {
        x: x + w - 8,
        y: y + h - 6,
        anchor: 'end' as const,
      };
    }
    if (containerAnchor === 'above') {
      return { x: x + w / 2, y: y - 6, anchor: 'middle' as const };
    }
    if (containerAnchor === 'below') {
      return {
        x: x + w / 2,
        y: y + h + fontSize + 2,
        anchor: 'middle' as const,
      };
    }
    if (containerAnchor === 'left') {
      return {
        x: x - 8,
        y: y + h / 2 + fontSize * 0.35,
        anchor: 'end' as const,
      };
    }
    if (containerAnchor === 'right') {
      return {
        x: x + w + 8,
        y: y + h / 2 + fontSize * 0.35,
        anchor: 'start' as const,
      };
    }
    if (containerAnchor === 'center') {
      return {
        x: x + w / 2,
        y: y + h / 2 + fontSize * 0.35,
        anchor: 'middle' as const,
      };
    }
    if (containerAnchor === 'inside-top') {
      return { x: x + w / 2, y: y + fontSize + 4, anchor: 'middle' as const };
    }
    if (containerAnchor === 'inside-bottom') {
      return { x: x + w / 2, y: y + h - 6, anchor: 'middle' as const };
    }
    if (containerAnchor === 'inside-left') {
      return {
        x: x + 8,
        y: y + h / 2 + fontSize * 0.35,
        anchor: 'start' as const,
      };
    }
    if (containerAnchor === 'inside-right') {
      return {
        x: x + w - 8,
        y: y + h / 2 + fontSize * 0.35,
        anchor: 'end' as const,
      };
    }
    // Outside corners - sit just past the bbox at the matching corner.
    if (containerAnchor === 'outside-top-left') {
      return { x: x - 6, y: y - 6, anchor: 'end' as const };
    }
    if (containerAnchor === 'outside-top-right') {
      return { x: x + w + 6, y: y - 6, anchor: 'start' as const };
    }
    if (containerAnchor === 'outside-bottom-left') {
      return {
        x: x - 6,
        y: y + h + fontSize + 2,
        anchor: 'end' as const,
      };
    }
    if (containerAnchor === 'outside-bottom-right') {
      return {
        x: x + w + 6,
        y: y + h + fontSize + 2,
        anchor: 'start' as const,
      };
    }
    // right-of-icon fallback when there's no child yet → legacy top-edge pill.
    return null;
  })();
  const groupLabel = !isEditingThis && (kind === 'group' || kind === 'container') && label && (
    containerLabel ? (() => {
      // Container labels render inline marks (bold/italic/underline) the same
      // way other text-bearing shapes do - foreignObject + mdToHtml. SVG
      // <text> by itself can't render the <b>/<i>/<u> tags and a bare {label}
      // would show users their raw `**asterisks**`.
      //
      // Position translation: SVG text uses (baseline-y, text-anchor). The
      // foreignObject is widened generously and the inner div's textAlign +
      // overflow:visible reproduces the same visual anchor with overflow
      // allowed to escape the bbox (so a long label past the container edge
      // still reads). Vertical shift = -fontSize * 0.85 to move the div top
      // up by one ascender so the rendered baseline lands on containerLabel.y.
      const FO_WIDTH = Math.max(w, 600);
      const ascender = fontSize * 0.85;
      const foX =
        containerLabel.anchor === 'middle'
          ? containerLabel.x - FO_WIDTH / 2
          : containerLabel.anchor === 'end'
            ? containerLabel.x - FO_WIDTH
            : containerLabel.x;
      const textAlign =
        containerLabel.anchor === 'middle'
          ? 'center'
          : containerLabel.anchor === 'end'
            ? 'right'
            : 'left';
      return (
        <foreignObject
          x={foX}
          y={containerLabel.y - ascender}
          width={FO_WIDTH}
          height={fontSize * 1.4}
          style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
          <div
            {...{ xmlns: 'http://www.w3.org/1999/xhtml' }}
            style={{
              fontFamily,
              fontSize,
              fontWeight: labelWeight,
              color: labelColor,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              textAlign,
            }}
            dangerouslySetInnerHTML={{ __html: mdToHtml(label) }}
          />
        </foreignObject>
      );
    })() : (() => {
      // Legacy group pill - strip inline-mark markers so the rect width and
      // visible text don't include raw `**` / `*` / `__` chars.
      const plain = mdToPlain(label);
      return (
        <g>
          <rect
            x={x + 8}
            y={y - 9}
            width={plain.length * 6.5 + 12}
            height={18}
            fill="var(--paper)"
            rx={3}
          />
          <text
            x={x + 14}
            y={y + 4}
            fontFamily={sketchy ? 'var(--font-sketch)' : 'var(--font-mono)'}
            fontSize={sketchy ? 14 : 10}
            fontWeight={500}
            fill={accent}
          >
            {plain}
          </text>
        </g>
      );
    })()
  );

  // 3-letter icon glyph for service tiles.
  const iconEl = icon && kind === 'service' && (
    <g transform={`translate(${x + 10}, ${y + 8})`}>
      <rect width={18} height={18} rx={3} fill={accent} opacity={sketchy ? 0.85 : 1} />
      <text
        x={9}
        y={13}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        fontSize={9}
        fontWeight={700}
        fill="#fff"
      >
        {icon}
      </text>
    </g>
  );

  // Empty containers offer a small "+" affordance in the top-left so the
  // user can attach an icon without hunting through the inspector.
  //
  // Gated on four conditions:
  //   1. Shape is a container.
  //   2. The container has no anchored child yet.
  //   3. The container has no label yet.
  //   4. The container is currently selected.
  //
  // The label gate (3) makes the + a *first-touch* affordance only - once
  // the user has typed a name into the container, the canvas reads as
  // labelled-but-iconless and the floating + becomes visual noise pinned
  // on top of intentional content. Adding an icon at that point is a
  // deliberate edit, not a quick capture, so it routes through the
  // inspector's "Add icon" button instead.
  //
  // The selection gate (4) matters because the empty-container "+" reads
  // as chrome on the container's body - leaving it visible while
  // unselected makes the canvas look chronically half-finished. Once any
  // container is adopted-into via drag-drop, the + disappears regardless
  // of selection (condition 2). Selection state is the only reason Shape
  // needs to know whether it's selected; everything else (halos, handles)
  // stays in Canvas's overlay layer per the file-level note above.
  // The "+" only suppresses when there's already an icon-kind anchor child.
  // Containers holding child containers / images / groups (anything that
  // isn't a `kind: 'icon'`) still need the affordance - those children are
  // contents of the container, not its anchor icon. `containerChild` was
  // narrowed earlier in the file to icon-kind only, so we can drive the
  // affordance straight from it.
  const isSelected = useEditor((s) =>
    kind === 'container' && !shape.notation && !containerChild
      ? s.selectedIds.includes(shape.id)
      : false,
  );
  const showAddIcon =
    kind === 'container' && !shape.notation && !containerChild && !label && isSelected;
  const [flyoutAnchor, setFlyoutAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  // If selection is dropped while the flyout is open, close the flyout -
  // otherwise it floats over a now-deselected container which is confusing.
  // Skip when the container HAS an anchor child: that path opened via
  // double-click, not via the +, so it shouldn't be tied to selection.
  useEffect(() => {
    if (kind === 'container' && !shape.notation && !containerChild && !isSelected && flyoutAnchor) {
      setFlyoutAnchor(null);
    }
  }, [kind, containerChild, isSelected, flyoutAnchor]);

  // Listen for `vellum:open-icon-picker`. Two dispatch shapes:
  //   - containers → `{ containerId }`: Canvas's dblclick on the anchor
  //     icon, the on-canvas "+" affordance, and the inspector button.
  //   - standalone icon shapes → `{ iconId }`: the inspector's
  //     "Change icon" button (ShapeInspector IconBranch).
  // Filter on this shape's id so each Shape only reacts to its own event.
  // Registered only for the two kinds that can host the flyout, to keep
  // the event traffic narrow.
  useEffect(() => {
    if (kind !== 'container' && kind !== 'icon') return;
    const onPick = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        containerId?: string;
        iconId?: string;
        x: number;
        y: number;
      }>).detail;
      if (!detail) return;
      const mine =
        (kind === 'container' && detail.containerId === shape.id) ||
        (kind === 'icon' && detail.iconId === shape.id);
      if (!mine) return;
      setFlyoutAnchor({ x: detail.x, y: detail.y });
    };
    window.addEventListener('vellum:open-icon-picker', onPick);
    return () => window.removeEventListener('vellum:open-icon-picker', onPick);
  }, [kind, shape.id]);

  // Table affordances
  // Hover-triggered "+" buttons at every row gap (left edge) and column gap
  // (top edge), PLUS drag-to-resize handles on every interior gridline.
  // Show when the table is hovered or selected so the user can approach
  // via either intent. Render N+1 row markers and N+1 col markers,
  // including the top/bottom/left/right edges.
  const isTableSelected = useEditor((s) =>
    kind === 'table' ? s.selectedIds.includes(shape.id) : false,
  );
  const insertTableRow = useEditor((s) => s.insertTableRow);
  const insertTableCol = useEditor((s) => s.insertTableCol);
  const updateShapeLive = useEditor((s) => s.updateShapeLive);
  const commitHistory = useEditor((s) => s.commitHistory);
  const [tableHover, setTableHover] = useState(false);
  const showTableAffordances = kind === 'table' && (tableHover || isTableSelected);
  const tableAffordances = (() => {
    if (!showTableAffordances || kind !== 'table') return null;
    // Use the same layout helper the renderer uses - affordance positions
    // track resized rows/cols so the handle for a custom-sized row appears
    // on the visible boundary, not the equal-division phantom.
    const tl = tableLayout({ ...shape, x, y, w, h });
    const HANDLE_R = 7;
    const EDGE_OFFSET = 14;
    // Row insert handles - N+1 along the LEFT edge, anchored at the
    // weighted row boundary positions.
    const rowHandles: React.ReactNode[] = [];
    for (let i = 0; i <= tl.rows; i++) {
      const cy = tl.rowEdges[i];
      const cx = x - EDGE_OFFSET;
      rowHandles.push(
        <TableInsertHandle
          key={`tr-${i}`}
          cx={cx}
          cy={cy}
          r={HANDLE_R}
          title={
            i === 0
              ? 'Insert row at top'
              : i === tl.rows
                ? 'Insert row at bottom'
                : `Insert row above row ${i + 1}`
          }
          onClick={() => insertTableRow(shape.id, i)}
        />,
      );
    }
    // Col insert handles - N+1 along the TOP edge.
    const colHandles: React.ReactNode[] = [];
    for (let i = 0; i <= tl.cols; i++) {
      const cx = tl.colEdges[i];
      const cy = y - EDGE_OFFSET;
      colHandles.push(
        <TableInsertHandle
          key={`tc-${i}`}
          cx={cx}
          cy={cy}
          r={HANDLE_R}
          title={
            i === 0
              ? 'Insert column at left'
              : i === tl.cols
                ? 'Insert column at right'
                : `Insert column before column ${i + 1}`
          }
          onClick={() => insertTableCol(shape.id, i)}
        />,
      );
    }
    // Drag-to-resize handles - one per INTERIOR gridline. Each handle is
    // a thin invisible strip along the gridline that the user grabs and
    // drags to repartition the two adjacent rows / columns. The cursor
    // changes to row-resize / col-resize on hover so the affordance is
    // discoverable without needing a visible handle marker (the gridline
    // itself is the handle).
    const resizeHandles: React.ReactNode[] = [];
    for (let i = 1; i < tl.rows; i++) {
      resizeHandles.push(
        <RowResizeHandle
          key={`rr-${i}`}
          shape={shape}
          index={i}
          x={x}
          y={tl.rowEdges[i]}
          w={w}
          updateShapeLive={updateShapeLive}
          commitHistory={commitHistory}
        />,
      );
    }
    for (let i = 1; i < tl.cols; i++) {
      resizeHandles.push(
        <ColResizeHandle
          key={`cr-${i}`}
          shape={shape}
          index={i}
          x={tl.colEdges[i]}
          y={y}
          h={h}
          updateShapeLive={updateShapeLive}
          commitHistory={commitHistory}
        />,
      );
    }
    return (
      <g>
        {resizeHandles}
        {rowHandles}
        {colHandles}
      </g>
    );
  })();

  // Hover hit-zone: a slightly enlarged transparent rect around the table
  // bbox so leaving the table body for an affordance handle (which sits
  // outside the bbox) doesn't immediately fire pointerleave. Only attached
  // when kind === 'table' so other shapes don't pay the listener cost.
  const tableHoverZone = kind === 'table' && (
    <rect
      x={x - 24}
      y={y - 24}
      width={w + 48}
      height={h + 48}
      fill="rgba(0,0,0,0.001)"
      stroke="none"
      pointerEvents="all"
      onPointerEnter={() => setTableHover(true)}
      onPointerLeave={() => setTableHover(false)}
      // The body / cells handle clicks. This rect is purely for hover
      // tracking; do not preventDefault or stop propagation so canvas
      // pointerdown still resolves to the underlying table.
    />
  );

  const containerAddIcon = showAddIcon ? (
    <g
      transform={`translate(${x + 10}, ${y + 10})`}
      style={{ cursor: 'pointer' }}
      onPointerDown={(e) => {
        // Stop the canvas pointerdown from beginning a select / drag
        // gesture against the underlying container.
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        // Anchor the flyout at the click point, in screen coords. Using the
        // event's clientX/clientY (rather than computing the +'s screen
        // position from world coords + viewport transform) avoids re-doing
        // the projection math here and keeps the flyout pinned exactly
        // where the user clicked at any zoom level.
        setFlyoutAnchor({ x: e.clientX, y: e.clientY });
      }}
    >
      <circle
        cx={9}
        cy={9}
        r={9}
        fill="var(--bg-subtle)"
        stroke="var(--border)"
        strokeWidth={1}
      />
      <path
        d="M9 4v10M4 9h10"
        stroke="var(--fg-muted)"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <title>Add an icon to this container</title>
    </g>
  ) : null;

  // Rotation transform for the shape - body, label, icon, sublabel,
  // selection-relative children all spin together inside the axis-aligned
  // bbox. The bbox itself (x/y/w/h) does NOT change; rotation is purely
  // visual. We deliberately keep the AABB un-rotated so:
  //   - resize handles still attach to the bbox corners the user sees in
  //     screen space (the SelectionOverlay separately rotates the corner
  //     handles back into the right spots - see Canvas.tsx)
  //   - marquee containment + parent-aware drop math continue to use a
  //     simple AABB instead of an oriented-bounding-box every frame
  //   - the file format keeps a single `rotation` scalar instead of having
  //     to persist a 4-corner polygon
  // Groups intentionally don't rotate: they're invisible hit boxes whose
  // children are independent shapes (rotating the group's <g> doesn't follow
  // the children, so a half-rotated group is a worse UX than none). Every
  // other kind - freehand included, its path is inside this same <g> - spins
  // with the transform. `shapeSupportsRotation` is the shared rule so the
  // renderer, the chrome and hit-testing can't disagree.
  const shapeRotation = shape.rotation ?? 0;
  const supportsRotation = shapeSupportsRotation(shape);
  const shapeRotateCx = shape.x + shape.w / 2;
  const shapeRotateCy = shape.y + shape.h / 2;
  const shapeTransform =
    supportsRotation && shapeRotation && Number.isFinite(shapeRotation)
      ? `rotate(${shapeRotation} ${shapeRotateCx} ${shapeRotateCy})`
      : undefined;

  // Breathing pulse. `stroke-opacity` is an INHERITED presentation attribute
  // and nothing inside a shape body sets it (the canvas's own overlay layer
  // does, but that is in Canvas.tsx, not here), so ONE <animate> on a
  // wrapper drives every stroked descendant - one SMIL timeline per pulsing
  // shape instead of one per jitter path / table gridline.
  //
  // Deliberately not a filter-based glow: the root <g> below already carries
  // filter="url(#notes-glow)" for Notes-layer shapes and `filter` is
  // single-valued, so a prism glow would silently clobber the Notes drop
  // shadow. A glow is a clean follow-up once an extra <g> is nested.
  // Mirror (⇧H / ⇧V) wraps the BODY only - labels, sublabels and the table's
  // cell text are siblings below and stay readable through a flip. It sits
  // INSIDE the rotation transform, which is the order that makes flipping a
  // rotated shape a true mirror of what's on screen (`flipSelection` negates
  // `rotation` to match). Reflecting about the shape's own centre maps the
  // bbox onto itself, so the selection halo and handles need no changes.
  const bodyMirror = mirrorTransform(shape);

  const bodyPainted = prismPulsing ? (
    <g
      data-vellum-prism="pulse"
      // Base value is 1, NOT the floor, so any frozen render (a PNG export, a
      // renderer without SMIL) shows the outline at full strength rather than
      // at the trough.
      strokeOpacity={1}
    >
      <animate
        attributeName="stroke-opacity"
        values={PRISM_PULSE_VALUES}
        keyTimes={PRISM_PULSE_KEYTIMES}
        calcMode="spline"
        keySplines={PRISM_PULSE_SPLINES}
        dur={`${PRISM_PULSE_SECONDS}s`}
        begin="0s"
        repeatCount="indefinite"
      />
      {body}
    </g>
  ) : (
    body
  );

  return (
    <>
    <g
      data-shape-id={shape.id}
      transform={shapeTransform}
      // Every shape on the Notes layer gets the faint red halo - including
      // sticky-notes (kind: 'note'). The halo colour is fixed in the SVG
      // filter (#notes-glow uses var(--notes-glow), never the per-shape
      // stroke) so a user's stroke override doesn't drag the glow off-red.
      // Group-kind shapes are invisible hit zones - skip the filter so an
      // empty group doesn't draw a glowing rectangle.
      filter={onNotesLayer && kind !== 'group' ? 'url(#notes-glow)' : undefined}
      // Opacity cascades to body, label, sublabel, and any embedded icon
      // markup together - that's why we apply it on the wrapping <g> rather
      // than per-element. Undefined = fully opaque (let SVG default win).
      opacity={shape.opacity ?? undefined}
    >
      {tableHoverZone}
      {bodyMirror ? <g transform={bodyMirror}>{bodyPainted}</g> : bodyPainted}
      {shape.notation ? <NativeShapeText shape={shape} color={labelColor} editing={isEditingThis} /> : !shape.rackUnit && kind !== 'rack' && bodyEl}
      {!shape.rackUnit && iconEl}
      {!shape.notation && !shape.rackUnit && kind !== 'rack' && labelEl}
      {!shape.notation && !shape.rackUnit && kind !== 'rack' && kind !== 'group' && kind !== 'container' && sublabelEl}
      {!shape.notation && groupLabel}
      {containerAddIcon}
      {tableAffordances}
      {flyoutAnchor && (
        // ContainerIconFlyout portals to document.body, so rendering it
        // inside the <g> here is fine - React lifts it out of the SVG tree.
        // `kind` is fixed per Shape, so it decides the target: an icon
        // shape replaces its own glyph in place; a container adds/swaps
        // its anchor icon. (flyoutAnchor is only ever set for these two.)
        <ContainerIconFlyout
          target={
            kind === 'icon'
              ? { kind: 'icon', iconShapeId: shape.id }
              : { kind: 'container', containerId: shape.id }
          }
          anchor={flyoutAnchor}
          onClose={() => setFlyoutAnchor(null)}
        />
      )}
    </g>
    {shape.polygonPreset === 'callout' && <g transform={shapeTransform}><CalloutHandles shape={shape} /></g>}
    {shape.notation && <g transform={shapeTransform}><PartitionHandles shape={shape} /></g>}
    </>
  );
}

/** Layout pin for the multi-line label. Anchor defaults are kind-driven:
 *    - icon / image → `below`   (don't paint over the picture)
 *    - text         → `center`  (the body IS the label)
 *    - everything else → `center` unless the user overrides
 *
 *  Returning a `lineY(i, total)` callback lets the caller stagger lines
 *  consistently across anchors without duplicating the y-math four ways.
 */
function computeLabelLayout(
  shape: ShapeT,
  x: number,
  y: number,
  w: number,
  h: number,
  fontSize: number,
  hasSublabel: boolean,
): {
  x: number;
  textAnchor: 'start' | 'middle' | 'end';
  lineY: (i: number, total: number) => number;
} {
  const anchor =
    shape.labelAnchor ??
    (shape.kind === 'icon' || shape.kind === 'image' ? 'below' : 'center');

  switch (anchor) {
    case 'below': {
      return {
        x: x + w / 2,
        textAnchor: 'middle',
        lineY: (i) => y + h + fontSize + 2 + i * fontSize * 1.15,
      };
    }
    case 'above': {
      return {
        x: x + w / 2,
        textAnchor: 'middle',
        // Stack upward so the bottom-most line sits closest to the body.
        lineY: (i, total) =>
          y - 6 - (total - 1 - i) * fontSize * 1.15,
      };
    }
    case 'right': {
      return {
        x: x + w + 8,
        textAnchor: 'start',
        lineY: (i, total) =>
          y + h / 2 + (i - (total - 1) / 2) * fontSize * 1.15 + fontSize * 0.35,
      };
    }
    case 'left': {
      return {
        x: x - 8,
        textAnchor: 'end',
        lineY: (i, total) =>
          y + h / 2 + (i - (total - 1) / 2) * fontSize * 1.15 + fontSize * 0.35,
      };
    }
    // Inside-the-bbox corner anchors. Lines stack downward from the top
    // edge for top-* and upward from the bottom edge for bottom-*, so
    // multi-line labels grow toward the centre rather than spilling
    // out of the corner.
    case 'top-left': {
      return {
        x: x + 8,
        textAnchor: 'start',
        lineY: (i) => y + fontSize + 4 + i * fontSize * 1.15,
      };
    }
    case 'top-right': {
      return {
        x: x + w - 8,
        textAnchor: 'end',
        lineY: (i) => y + fontSize + 4 + i * fontSize * 1.15,
      };
    }
    case 'bottom-left': {
      return {
        x: x + 8,
        textAnchor: 'start',
        lineY: (i, total) =>
          y + h - 6 - (total - 1 - i) * fontSize * 1.15,
      };
    }
    case 'bottom-right': {
      return {
        x: x + w - 8,
        textAnchor: 'end',
        lineY: (i, total) =>
          y + h - 6 - (total - 1 - i) * fontSize * 1.15,
      };
    }
    // Inside edge midpoints - pinned to the matching edge but centred on
    // the perpendicular axis. Multi-line labels grow inward (top → down,
    // bottom → up) so they never spill across the opposite edge.
    case 'inside-top': {
      return {
        x: x + w / 2,
        textAnchor: 'middle',
        lineY: (i) => y + fontSize + 4 + i * fontSize * 1.15,
      };
    }
    case 'inside-bottom': {
      return {
        x: x + w / 2,
        textAnchor: 'middle',
        lineY: (i, total) =>
          y + h - 6 - (total - 1 - i) * fontSize * 1.15,
      };
    }
    case 'inside-left': {
      return {
        x: x + 8,
        textAnchor: 'start',
        lineY: (i, total) =>
          y + h / 2 + (i - (total - 1) / 2) * fontSize * 1.15 + fontSize * 0.35,
      };
    }
    case 'inside-right': {
      return {
        x: x + w - 8,
        textAnchor: 'end',
        lineY: (i, total) =>
          y + h / 2 + (i - (total - 1) / 2) * fontSize * 1.15 + fontSize * 0.35,
      };
    }
    // Outside corners - symmetric to the inside-corner anchors but the
    // label hangs OFF the corner. fontSize+4 of clearance from the edge
    // mirrors `above`/`below`.
    case 'outside-top-left': {
      return {
        x: x - 6,
        textAnchor: 'end',
        // Stack upward - bottom-most line sits closest to the body, like
        // `above` does.
        lineY: (i, total) =>
          y - 6 - (total - 1 - i) * fontSize * 1.15,
      };
    }
    case 'outside-top-right': {
      return {
        x: x + w + 6,
        textAnchor: 'start',
        lineY: (i, total) =>
          y - 6 - (total - 1 - i) * fontSize * 1.15,
      };
    }
    case 'outside-bottom-left': {
      return {
        x: x - 6,
        textAnchor: 'end',
        lineY: (i) => y + h + fontSize + 2 + i * fontSize * 1.15,
      };
    }
    case 'outside-bottom-right': {
      return {
        x: x + w + 6,
        textAnchor: 'start',
        lineY: (i) => y + h + fontSize + 2 + i * fontSize * 1.15,
      };
    }
    case 'right-of-icon':
    case 'center':
    default: {
      return {
        x: x + w / 2,
        textAnchor: 'middle',
        lineY: (i, total) =>
          y +
          h / 2 +
          (hasSublabel ? -4 : 4) +
          (i - (total - 1) / 2) * fontSize * 0.95,
      };
    }
  }
}

export const Shape = memo(ShapeImpl);

/** Single "+" handle rendered for table row/col insertion. Filled accent
 *  circle so it pops against any cell fill, with a subtle stroke for
 *  contrast on tinted headers. Title attribute drives the native tooltip.
 *  Click stops propagation so the underlying canvas doesn't begin a select
 *  / drag gesture against the table. */
function TableInsertHandle({
  cx,
  cy,
  r,
  title,
  onClick,
}: {
  cx: number;
  cy: number;
  r: number;
  title: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <g
      style={{ cursor: 'pointer' }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={hover ? 'var(--accent)' : 'var(--bg-subtle)'}
        stroke="var(--accent)"
        strokeWidth={1}
      />
      <path
        d={`M ${cx - r * 0.55} ${cy} L ${cx + r * 0.55} ${cy} M ${cx} ${cy - r * 0.55} L ${cx} ${cy + r * 0.55}`}
        stroke={hover ? '#fff' : 'var(--accent)'}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
      <title>{title}</title>
    </g>
  );
}

/** Drag-resize handle for the gridline between row `index-1` and row
 *  `index`. Renders as an invisible thin strip ON the gridline; cursor
 *  is row-resize so the affordance is felt without a visible glyph
 *  cluttering the table chrome. Drag updates `rowHeights` weights via
 *  updateShapeLive so the gesture is fluid (no history per pointermove);
 *  commitHistory snapshots once on pointerup. */
function RowResizeHandle({
  shape,
  index,
  x,
  y,
  w,
  updateShapeLive,
  commitHistory,
}: {
  shape: ShapeT;
  index: number;
  x: number;
  y: number;
  w: number;
  updateShapeLive: (id: string, patch: Partial<ShapeT>) => void;
  commitHistory: () => void;
}) {
  const dragRef = useRef<{
    startY: number;
    startWeights: number[];
    rowSum: number;
    above: number; // weights[index-1]
    below: number; // weights[index]
    shapeH: number;
    pointerId: number;
    /** Set on the first live write; pointerup commits only then, so a
     *  press-and-release on the gridline leaves no history entry. */
    moved: boolean;
  } | null>(null);
  const STRIP_PX = 6; // half-thickness of the hit zone on each side of the line
  return (
    <rect
      x={x}
      y={y - STRIP_PX}
      width={w}
      height={STRIP_PX * 2}
      // Transparent fill so the gridline underneath shows through, but
      // pointer-events: all so we still capture the drag.
      fill="rgba(0,0,0,0.001)"
      pointerEvents="all"
      style={{ cursor: 'row-resize' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const rows = Math.max(1, Math.floor(shape.rows ?? 3));
        const startWeights = padTableWeights(shape.rowHeights, rows);
        const rowSum = startWeights.reduce((a, b) => a + b, 0) || 1;
        // No history call here. commitHistory pushes the pre-state that the
        // store captures on the gesture's FIRST live write - at pointerdown
        // nothing has been written yet, so a call at this point no-ops (and
        // that is exactly what this handler used to do: the resize was
        // silently unundoable). The commit is at pointerup.
        dragRef.current = {
          startY: e.clientY,
          startWeights,
          rowSum,
          above: startWeights[index - 1],
          below: startWeights[index],
          shapeH: shape.h,
          pointerId: e.pointerId,
          moved: false,
        };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        // Convert screen-pixel delta into weight delta. Screen-pixel ≈
        // world-pixel × zoom; we read zoom off the live store so user
        // zoom changes mid-drag stay correct. The math collapses to:
        //   worldDelta = pixelDelta / zoom
        //   fractionDelta = worldDelta / shape.h
        //   weightDelta = fractionDelta × rowSum
        const z = useEditor.getState().zoom;
        const pxDelta = e.clientY - d.startY;
        const worldDelta = pxDelta / z;
        const fractionDelta = worldDelta / d.shapeH;
        let weightDelta = fractionDelta * d.rowSum;
        // Clamp so neither adjacent row collapses below a 12px-equivalent
        // weight. Keeps the table usable mid-drag without per-frame size
        // checks.
        const minW = (12 / d.shapeH) * d.rowSum;
        const newAbove = Math.max(minW, d.above + weightDelta);
        const newBelow = Math.max(minW, d.below - weightDelta);
        // Re-derive weightDelta after clamp so the sum stays constant.
        weightDelta = newAbove - d.above;
        const next = d.startWeights.slice();
        next[index - 1] = d.above + weightDelta;
        next[index] = d.below - weightDelta;
        // Defensive: if either side hit the clamp, recompute using newAbove/
        // newBelow directly (they already sum to the original above+below).
        next[index - 1] = newAbove;
        next[index] = newBelow;
        // Use the live (no-history) mutation - commit happens on pointerup.
        // Avoid void return type issues: TS allows omitting fields not in
        // ShapeT; rowHeights is a known optional field on Shape.
        d.moved = true;
        updateShapeLive(shape.id, { rowHeights: next });
      }}
      onPointerUp={(e) => {
        if (!dragRef.current) return;
        const { pointerId: pid, moved } = dragRef.current;
        dragRef.current = null;
        (e.currentTarget as Element).releasePointerCapture?.(pid);
        // Seal the gesture as one undo step - same seam as every canvas
        // drag. Skipped for a press that never moved.
        if (moved) commitHistory();
      }}
      onPointerCancel={(e) => {
        if (!dragRef.current) return;
        const { pointerId: pid, moved } = dragRef.current;
        dragRef.current = null;
        (e.currentTarget as Element).releasePointerCapture?.(pid);
        if (moved) commitHistory();
      }}
    />
  );
}

/** Sibling of RowResizeHandle but on the X axis. Splitting them as two
 *  components instead of one parameterised one keeps the cursor + axis
 *  math obvious at the read site; the duplication is ~30 lines. */
function ColResizeHandle({
  shape,
  index,
  x,
  y,
  h,
  updateShapeLive,
  commitHistory,
}: {
  shape: ShapeT;
  index: number;
  x: number;
  y: number;
  h: number;
  updateShapeLive: (id: string, patch: Partial<ShapeT>) => void;
  commitHistory: () => void;
}) {
  const dragRef = useRef<{
    startX: number;
    startWeights: number[];
    colSum: number;
    left: number;
    right: number;
    shapeW: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);
  const STRIP_PX = 6;
  return (
    <rect
      x={x - STRIP_PX}
      y={y}
      width={STRIP_PX * 2}
      height={h}
      fill="rgba(0,0,0,0.001)"
      pointerEvents="all"
      style={{ cursor: 'col-resize' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const cols = Math.max(1, Math.floor(shape.cols ?? 3));
        const startWeights = padTableWeights(shape.colWidths, cols);
        const colSum = startWeights.reduce((a, b) => a + b, 0) || 1;
        // See RowResizeHandle: no history call at pointerdown - the commit
        // is at pointerup, once there is a captured pre-state to push.
        dragRef.current = {
          startX: e.clientX,
          startWeights,
          colSum,
          left: startWeights[index - 1],
          right: startWeights[index],
          shapeW: shape.w,
          pointerId: e.pointerId,
          moved: false,
        };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        const z = useEditor.getState().zoom;
        const pxDelta = e.clientX - d.startX;
        const worldDelta = pxDelta / z;
        const fractionDelta = worldDelta / d.shapeW;
        const minW = (12 / d.shapeW) * d.colSum;
        const newLeft = Math.max(minW, d.left + fractionDelta * d.colSum);
        const newRight = Math.max(minW, d.right + d.left - newLeft);
        const next = d.startWeights.slice();
        next[index - 1] = newLeft;
        next[index] = newRight;
        d.moved = true;
        updateShapeLive(shape.id, { colWidths: next });
      }}
      onPointerUp={(e) => {
        if (!dragRef.current) return;
        const { pointerId: pid, moved } = dragRef.current;
        dragRef.current = null;
        (e.currentTarget as Element).releasePointerCapture?.(pid);
        if (moved) commitHistory();
      }}
      onPointerCancel={(e) => {
        if (!dragRef.current) return;
        const { pointerId: pid, moved } = dragRef.current;
        dragRef.current = null;
        (e.currentTarget as Element).releasePointerCapture?.(pid);
        if (moved) commitHistory();
      }}
    />
  );
}

/** Pad / truncate a table-weight array to length `n`, dropping
 *  zero/negative/non-finite entries to 1. Same logic as inside
 *  `tableLayout`; exposed here because the resize handles need the
 *  pre-normalised weights to compute deltas. */
function padTableWeights(src: number[] | undefined, n: number): number[] {
  const out = new Array(n).fill(1) as number[];
  if (!src) return out;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[i] = v;
  }
  return out;
}

/** Resolve a table shape's cell layout - pixel edges + sizes for rows and
 *  columns. Reads `rowHeights` / `colWidths` weights when present; falls
 *  back to equal-weight rows/cols. The math is centralised so renderer +
 *  editor + canvas (dblclick/right-click hit-testing) all agree on which
 *  cell a coordinate belongs to.
 *
 *  - rows / cols: clamped ≥ 1 (matches what every other table fn does).
 *  - rowEdges / colEdges: length = rows+1 / cols+1. First entry = shape.x/y,
 *    last = shape.x+w / y+h. Used for gridline positioning + cell box math.
 *  - rowSizes / colSizes: length = rows / cols, in pixels. */
export function tableLayout(shape: ShapeT): {
  rows: number;
  cols: number;
  rowEdges: number[];
  colEdges: number[];
  rowSizes: number[];
  colSizes: number[];
} {
  const rows = Math.max(1, Math.floor(shape.rows ?? 3));
  const cols = Math.max(1, Math.floor(shape.cols ?? 3));
  // Pad / truncate the weights array to current rows/cols. Missing entries
  // default to 1 - matches "all equal" intent for new rows.
  const padWeights = (src: number[] | undefined, n: number): number[] => {
    const out = new Array(n).fill(1) as number[];
    if (!src) return out;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      // Reject zero / negative / non-finite weights - they'd produce
      // collapsed cells or NaN edges. Treat them as missing.
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[i] = v;
    }
    return out;
  };
  const rowW = padWeights(shape.rowHeights, rows);
  const colW = padWeights(shape.colWidths, cols);
  const rowSum = rowW.reduce((a, b) => a + b, 0) || 1;
  const colSum = colW.reduce((a, b) => a + b, 0) || 1;
  const rowEdges: number[] = [shape.y];
  const rowSizes: number[] = [];
  let yacc = 0;
  for (let i = 0; i < rows; i++) {
    const sz = (rowW[i] / rowSum) * shape.h;
    yacc += sz;
    rowSizes.push(sz);
    rowEdges.push(shape.y + yacc);
  }
  const colEdges: number[] = [shape.x];
  const colSizes: number[] = [];
  let xacc = 0;
  for (let i = 0; i < cols; i++) {
    const sz = (colW[i] / colSum) * shape.w;
    xacc += sz;
    colSizes.push(sz);
    colEdges.push(shape.x + xacc);
  }
  return { rows, cols, rowEdges, colEdges, rowSizes, colSizes };
}

/** Inverse of tableLayout - given a world point, return the (row, col) it
 *  falls in. Clamps to the table's bounds, so a point just outside still
 *  resolves to the edge cell. Returns null only when the shape isn't a
 *  table (defensive - callers usually know already).
 *
 *  Rotation-aware: the row/col edges live in the table's LOCAL frame (the
 *  whole table spins inside its axis-aligned bbox at render time), so the
 *  world point is un-rotated about the bbox centre before the scan - same
 *  convention as every bbox hit-test in projection.ts. */
export function cellAtPoint(
  shape: ShapeT,
  point: { x: number; y: number },
): { row: number; col: number } | null {
  if (shape.kind !== 'table') return null;
  const { rows, cols, rowEdges, colEdges } = tableLayout(shape);
  const local = toShapeLocal(point, shape);
  // Linear scan - table sizes are tiny (single digit row/col counts in
  // practice; even pathological 50×50 is fine). Binary search would buy
  // ~nothing and add complexity.
  let row = rows - 1;
  for (let i = 0; i < rows; i++) {
    if (local.y < rowEdges[i + 1]) {
      row = i;
      break;
    }
  }
  let col = cols - 1;
  for (let i = 0; i < cols; i++) {
    if (local.x < colEdges[i + 1]) {
      col = i;
      break;
    }
  }
  return {
    row: Math.max(0, Math.min(rows - 1, row)),
    col: Math.max(0, Math.min(cols - 1, col)),
  };
}

/** Outside-* and cardinal anchors don't make sense inside a table cell -
 * text can't hang outside a cell wall - so the cell renderer collapses
 *  those to `'center'`. Inside-* and corner anchors pass through. */
export function collapseAnchorForCell(a: LabelAnchor): LabelAnchor {
  switch (a) {
    case 'above':
    case 'below':
    case 'left':
    case 'right':
    case 'right-of-icon':
    case 'outside-top-left':
    case 'outside-top-right':
    case 'outside-bottom-left':
    case 'outside-bottom-right':
      return 'center';
    default:
      return a;
  }
}

/** Map a (collapsed-for-cell) anchor → flexbox axes. Centralised so the
 *  Shape table renderer and the InlineCellEditor agree on alignment, which
 *  means typing-position == committed-position with no visible jump. */
export function anchorToFlex(a: LabelAnchor): {
  alignItems: 'flex-start' | 'center' | 'flex-end';
  justifyContent: 'flex-start' | 'center' | 'flex-end';
  textAlign: 'left' | 'center' | 'right';
} {
  switch (a) {
    case 'top-left':
      return {
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
        textAlign: 'left',
      };
    case 'inside-top':
      return {
        alignItems: 'flex-start',
        justifyContent: 'center',
        textAlign: 'center',
      };
    case 'top-right':
      return {
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        textAlign: 'right',
      };
    case 'inside-left':
      return {
        alignItems: 'center',
        justifyContent: 'flex-start',
        textAlign: 'left',
      };
    case 'inside-right':
      return {
        alignItems: 'center',
        justifyContent: 'flex-end',
        textAlign: 'right',
      };
    case 'bottom-left':
      return {
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
        textAlign: 'left',
      };
    case 'inside-bottom':
      return {
        alignItems: 'flex-end',
        justifyContent: 'center',
        textAlign: 'center',
      };
    case 'bottom-right':
      return {
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        textAlign: 'right',
      };
    case 'center':
    default:
      return {
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
      };
  }
}

/** Catmull-Rom-to-Bezier smoothing for a polyline. Exposed at module scope so
 *  the in-flight pen preview in Canvas can use it too. */
export function buildSmoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    const [a, b] = pts;
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  const tension = 0.5;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const c1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    const c1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const c2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    const c2y = p2.y - ((p3.y - p1.y) * tension) / 3;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
