import { memo } from 'react';
import type {
  Connector as ConnectorT,
  EndpointMarker,
  Shape,
} from '@/store/types';
import { resolveSwatchColor } from '@/editor/swatches';
import { mdToPlain } from '@/lib/inline-marks';
import { useEditor } from '@/store/editor';
import {
  buildPath,
  connectorPolyline,
  offsetPolyline,
  pointAtFraction,
  polylineEndDirection,
  polylineToRoundedPath,
  resolveConnectorPath,
} from './routing';
import { labelBoxAt } from './connector-label';
import {
  bidirectionalOffset,
  connectorStrokes,
  hoppedPath,
  isBidirectional,
  markerSetback,
  strokeCornerRadius,
  type ConnectorHops,
} from './line-jumps';

type Props = {
  conn: ConnectorT;
  shapes: Shape[];
  selected: boolean;
  /** Line-jump bridges per stroke (see line-jumps.ts). The canvas works them
   *  out because they depend on every other connector. */
  hops?: ConnectorHops;
};

function ConnectorImpl({ conn, shapes, selected, hops }: Props) {
  // Suppress the rendered label while the inline editor overlays this
  // connector - otherwise the editor's transparent background would show
  // the committed label painted underneath, ghosting the cursor.
  const beingEdited = useEditor((s) => s.editingConnectorId === conn.id);
  const strokeWidth = conn.strokeWidth ?? 1.25;

  const fromFloating = !('shape' in conn.from);
  const toFloating = !('shape' in conn.to);
  // The `dangling` flag (floating endpoint whose shape was deleted) is kept in
  // the data model for file compatibility, but is no longer surfaced visually
  // - orphaned endpoints just read as ordinary floating lines now.
  const fromMarker: EndpointMarker = conn.fromMarker ?? 'none';
  const toMarker: EndpointMarker = conn.toMarker ?? 'arrow';
  // Dotted lines render via zero-length dashes with a round linecap: each
  // "dash" collapses to a strokeWidth-diameter circle. Dashed/solid keep
  // butt so segment ends stay flat against shape boundaries.
  const linecap = conn.style === 'dotted' ? 'round' : 'butt';

  const path = resolveConnectorPath(
    conn,
    shapes,
    markerSetback(fromMarker, fromFloating, strokeWidth),
    markerSetback(toMarker, toFloating, strokeWidth),
  );
  if (!path) return null;
  const fromPt = { x: path.fx, y: path.fy };
  const toPt = { x: path.tx, y: path.ty };

  // Resolve through the swatch palette so a connector saved with a legacy
  // stroke hex (#1f6feb etc.) routes to its theme-aware var() and
  // autoswitches when the user toggles theme. var()/transparent/none/
  // unrecognised hexes pass through unchanged.
  const stroke = resolveSwatchColor(conn.stroke, 'stroke') ?? 'var(--ink)';

  const pathD = buildPath(
    conn.routing,
    path.fx,
    path.fy,
    path.tx,
    path.ty,
    path.fromAnchor,
    path.toAnchor,
    conn.waypoints,
    path.fromRot,
    path.toRot,
    path.fromRect,
    path.toRect,
    conn.waypointMode,
  );

  // Per-end marker size override. Undefined = "auto" - falls back to the
  // legacy strokeWidth-relative sizing inside <Marker /> so existing diagrams
  // render unchanged. When set, the marker is sized in user-space px and is
  // fully decoupled from `strokeWidth`.
  const fromMarkerSize = conn.fromMarkerSize;
  const toMarkerSize = conn.toMarkerSize;

  // Per-connector marker IDs so colour follows the stroke. Size goes into the
  // id too - markers are referenced by URL and SVG caches them per id, so two
  // arrows with different sizes need different ids or the second silently
  // re-uses the first definition.
  const fromMarkerId = `mk-${conn.id}-from`;
  const toMarkerId = `mk-${conn.id}-to`;
  // Bidirectional draws a second, mirrored line, and a marker there faces the
  // other way - same shape, own `orient`, so it needs its own definition.
  const fromMarkerAltId = `mk-${conn.id}-from-alt`;
  const toMarkerAltId = `mk-${conn.id}-to-alt`;

  // Dash pattern is the user's `.style` choice. Solid lines can't animate
  // (nothing to march), so when `.animated` is on we treat 'solid' as if
  // it were 'dashed' - the inspector also hides 'solid' from the .style
  // picker in that mode so the on-screen result matches the user's
  // selection. Forward/reverse flow CSS classes match the pattern so the
  // marching dashes loop seamlessly (shift = dash + gap).
  const animated = conn.animated === true;
  const bidirectional = isBidirectional(conn);
  const dashStyle: 'solid' | 'dashed' | 'dotted' = animated
    ? conn.style === 'dotted'
      ? 'dotted'
      : 'dashed'
    : conn.style ?? 'solid';
  // Dotted spacing scales with stroke width so thicker lines get
  // proportionally more breathing room between dots. At default
  // strokeWidth (1.25) this yields gap=5, matching the legacy look.
  const dotGap = strokeWidth * 4;
  const dash =
    dashStyle === 'dashed' ? '5 3' : dashStyle === 'dotted' ? `0 ${dotGap}` : '0';
  const flowFwdClass = animated
    ? dashStyle === 'dotted'
      ? 'vellum-flow-dotted-fwd'
      : 'vellum-flow-dashed-fwd'
    : undefined;
  const flowRevClass = animated
    ? dashStyle === 'dotted'
      ? 'vellum-flow-dotted-rev'
      : 'vellum-flow-dashed-rev'
    : undefined;
  // Marching-dot keyframes shift by `--vellum-flow-period` per cycle so the
  // pattern loops seamlessly regardless of the strokeWidth-scaled gap.
  // Dashed uses a fixed period (5+3 = 8) and ignores this variable.
  const flowStyle =
    animated && dashStyle === 'dotted'
      ? ({ ['--vellum-flow-period' as string]: `${dotGap}px` } as React.CSSProperties)
      : undefined;

  // Label position - sample the actual rendered polyline at the stored
  // fraction (default 0.5 = midpoint of arclength). For straight lines this
  // matches the old `(from+to)/2` behaviour; for elbow / curved lines it
  // sits the label ON the line instead of at the geometric midpoint of the
  // endpoint pair (which was off-line for orthogonal routing).
  const polyline = connectorPolyline(
    conn,
    path.fx,
    path.fy,
    path.tx,
    path.ty,
    path.fromAnchor,
    path.toAnchor,
    path.fromRot,
    path.toRot,
    path.fromRect,
    path.toRect,
  );
  const labelPt = pointAtFraction(polyline, conn.labelPosition ?? 0.5);
  const mx = labelPt.x;
  const my = labelPt.y;

  // Arrowhead aim. SVG's `orient="auto"` uses the path's tangent AT the
  // endpoint, which is the wrong sample for a marker with length: the barbs
  // reach `size` px back down the line, so on anything that curves through
  // its last stretch - a hand-bent connector, an elbow's rounded corner -
  // the head ends up rotated off the stroke it is supposed to cap, with one
  // barb lying along the line. Aiming along the span the head actually
  // covers keeps the two agreeing. It also sidesteps `auto` having no
  // tangent to work with when the final segment is degenerate, where
  // browsers fall back to whatever control point is left and can point the
  // head backwards. Straight and orthogonal lines measure the same either
  // way, so this is a no-op for most diagrams. Null (a connector with no
  // extent) falls back to letting SVG aim it.
  const aimOrient = (
    which: 'start' | 'end',
    marker: EndpointMarker,
    size: number | undefined,
  ) => {
    if (marker === 'none') return undefined;
    const dir = polylineEndDirection(
      polyline,
      which,
      resolveMarkerSize(marker, strokeWidth, size),
    );
    if (!dir) return 'auto-start-reverse';
    return `${(Math.atan2(dir.y, dir.x) * 180) / Math.PI}`;
  };
  // A start marker faces back out of the line, which is exactly the outward
  // direction `polylineEndDirection` returns - the same convention SVG's
  // `auto-start-reverse` encodes.
  const fromOrient = aimOrient('start', fromMarker, fromMarkerSize);
  const toOrient = aimOrient('end', toMarker, toMarkerSize);

  // Line jumps. A stroke with bridges is redrawn from its polyline with the
  // bumps spliced in; a stroke without keeps exactly the path it always had.
  // Bridges never reach an end, so the markers and their aim are unaffected.
  const strokes =
    hops && hops.some((h) => h.length > 0)
      ? connectorStrokes(conn, path, polyline, strokeWidth)
      : null;
  const strokeD = (i: number): string | null => {
    const h = hops?.[i];
    const pts = strokes?.[i];
    return h && h.length > 0 && pts
      ? hoppedPath(pts, h, strokeCornerRadius(conn))
      : null;
  };
  const bodyD = strokeD(0) ?? pathD;

  // The connector body stays a clean smooth path on every layer - the
  // hand-drawn character on Notes comes from the chevron arrowhead, not
  // from displacing the line. (We tried feTurbulence + feDisplacementMap
  // here previously; at typical zooms it read as jagged, not "drawn".)
  return (
    <g
      data-connector-id={conn.id}
      opacity={conn.opacity ?? undefined}
    >
      <defs>
        {fromMarker !== 'none' && (
          <Marker
            id={fromMarkerId}
            tipAligned={!!conn.relationship}
            kind={fromMarker}
            stroke={stroke}
            strokeWidth={strokeWidth}
            size={fromMarkerSize}
            orient={fromOrient}
          />
        )}
        {toMarker !== 'none' && (
          <Marker
            id={toMarkerId}
            tipAligned={!!conn.relationship}
            kind={toMarker}
            stroke={stroke}
            strokeWidth={strokeWidth}
            size={toMarkerSize}
            orient={toOrient}
          />
        )}
        {/* Mirrored copies for the reverse line: same marker, aimed at the
         *  other end of the connector. */}
        {bidirectional && fromMarker !== 'none' && (
          <Marker
            id={fromMarkerAltId}
            tipAligned={!!conn.relationship}
            kind={fromMarker}
            stroke={stroke}
            strokeWidth={strokeWidth}
            size={fromMarkerSize}
            orient={toOrient}
          />
        )}
        {bidirectional && toMarker !== 'none' && (
          <Marker
            id={toMarkerAltId}
            tipAligned={!!conn.relationship}
            kind={toMarker}
            stroke={stroke}
            strokeWidth={strokeWidth}
            size={toMarkerSize}
            orient={fromOrient}
          />
        )}
      </defs>
      {/* Fat invisible hit target - 12px wide for click selection. Always
       *  the centred path so the click zone matches the visible centre even
       *  when bidirectional renders two offset lines. */}
      <path d={bodyD} fill="none" stroke="transparent" strokeWidth={12} />
      {!bidirectional && (
        <path
          d={bodyD}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
          markerStart={
            fromMarker !== 'none' ? `url(#${fromMarkerId})` : undefined
          }
          markerEnd={toMarker !== 'none' ? `url(#${toMarkerId})` : undefined}
          strokeLinecap={linecap}
          strokeLinejoin="round"
          className={flowFwdClass}
          style={flowStyle}
        />
      )}
      {bidirectional &&
        (() => {
          // Two parallel offset polylines, each rendered as its own path.
          // Offset distance scales gently with stroke width so a thick
          // line gets enough separation to read as a pair rather than one
          // smeared stroke. The path is built from the offset polyline so
          // both sides track endpoint motion / shape moves automatically
          // (connectorPolyline already resolves anchors per render).
          const offset = bidirectionalOffset(strokeWidth);
          const forwardPts = offsetPolyline(polyline, offset);
          const reversePts = offsetPolyline(polyline, -offset);
          const isOrtho = conn.routing === 'orthogonal';
          const forwardD =
            strokeD(1) ??
            (isOrtho
              ? polylineToRoundedPath(forwardPts)
              : forwardPts
                  .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
                  .join(' '));
          const reverseD =
            strokeD(2) ??
            (isOrtho
              ? polylineToRoundedPath(reversePts)
              : reversePts
                  .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
                  .join(' '));
          return (
            <>
              {/* Forward line - keeps the original from/to markers and
               *  flows from→to when animated. */}
              <path
                d={forwardD}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeDasharray={dash}
                markerStart={
                  fromMarker !== 'none' ? `url(#${fromMarkerId})` : undefined
                }
                markerEnd={
                  toMarker !== 'none' ? `url(#${toMarkerId})` : undefined
                }
                strokeLinecap={linecap}
                strokeLinejoin="round"
                className={flowFwdClass}
                style={flowStyle}
              />
              {/* Reverse line - markers swapped so the pair reads as a
               *  two-way flow; dash march goes the opposite direction. */}
              <path
                d={reverseD}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeDasharray={dash}
                markerStart={
                  toMarker !== 'none' ? `url(#${toMarkerAltId})` : undefined
                }
                markerEnd={
                  fromMarker !== 'none' ? `url(#${fromMarkerAltId})` : undefined
                }
                strokeLinecap={linecap}
                strokeLinejoin="round"
                className={flowRevClass}
                style={flowStyle}
              />
            </>
          );
        })()}
      {selected && (
        <path
          d={bodyD}
          fill="none"
          stroke="var(--refined)"
          strokeWidth={3}
          opacity={0.25}
          strokeLinecap={linecap}
          strokeLinejoin="round"
        />
      )}
      {/* Label rect = the "paper-coloured" box behind the text. This is the
       *  visible "gap" in the line under a label. Strict-truthy + trim guard
       *  here defends against a connector whose `label` was set to a stray
       *  whitespace string (NBSP, lone space) by an over-eager commit path -
 * without the trim, the gap-rect would persist after the user "deleted"
       *  the label and the line wouldn't visibly reconnect. */}
      {(() => {
        if (beingEdited) return null;
        // Strip inline-markdown markers (`**bold**` etc.) for the displayed
        // text + bbox math. SVG <text> can't render marks anyway and the raw
        // marker chars would inflate the rect width relative to what users
        // see. Inline-mark rendering on connector labels is a known limit -
        // foreignObject would buy it but trades the SVG hit-testing model.
        const plain = mdToPlain(conn.label);
        if (!plain || !plain.trim()) return null;
        // Same box the hit-tester uses and the same box the bend handles keep
        // clear of - one definition, in connector-label.ts.
        const box = labelBoxAt(plain, 0, 0);
        return (
          <g
            transform={`translate(${mx}, ${my})`}
            data-connector-label-id={conn.id}
            // No `cursor` here on purpose. The label rect is the topmost
            // pointer-events node in the connector layer (the port dots and
            // waypoint handles painted above it are pointerEvents="none"), so
            // an inline cursor on this group wins over the SVG root's computed
            // cursor for every pixel of the rect - including the pixels where
            // a connection point or an endpoint handle is sitting on top and
            // is what the click will actually grab. Canvas.tsx derives the
            // cursor from resolved hover state ('grab' for a label, 'crosshair'
            // for a port), which is the only place that knows who won.
            style={{ pointerEvents: 'auto' }}
          >
            <rect
              x={-box.halfW}
              y={-box.halfH}
              width={box.halfW * 2}
              height={box.halfH * 2}
              fill="var(--paper)"
              rx={3}
            />
            <text
              x={0}
              y={4}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={10}
              fill="var(--ink-muted)"
              // Pointer events on the rect are enough - the text inside
              // would otherwise capture clicks and split hit handling
              // between two SVG nodes, which complicates the bbox check
              // in connectorLabelUnder.
              style={{ pointerEvents: 'none' }}
            >
              {plain}
            </text>
          </g>
        );
      })()}
      {(['from','to'] as const).map(end => {
        const label = conn[end === 'from' ? 'fromLabel' : 'toLabel'];
        if (!label) return null;
        const at = end === 'from' ? fromPt : toPt;
        const dir = polylineEndDirection(polyline, end === 'from' ? 'start' : 'end', 24) ?? {x:1,y:0};
        const length = Math.hypot(dir.x,dir.y) || 1;
        const dx=dir.x/length, dy=dir.y/length;
        return <text key={end} data-relationship-label={end} x={at.x-dx*26-dy*12} y={at.y-dy*26+dx*12} textAnchor="middle" fontFamily="var(--font-body)" fontSize={11} fill={stroke} stroke="var(--paper)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{label}</text>;
      })}
      {selected && (
        <g style={{ pointerEvents: 'none' }}>
          {/* From-end: open circle = floating, filled = bound. Symmetric so
           *  direction reads at a glance. */}
          <circle
            cx={fromPt.x}
            cy={fromPt.y}
            r={4}
            fill={fromFloating ? 'var(--paper)' : 'var(--refined)'}
            stroke={fromFloating ? 'var(--refined)' : 'var(--paper)'}
            strokeWidth={1.5}
          />
          <circle
            cx={toPt.x}
            cy={toPt.y}
            r={4}
            fill={toFloating ? 'var(--paper)' : 'var(--refined)'}
            stroke={toFloating ? 'var(--refined)' : 'var(--paper)'}
            strokeWidth={1.5}
          />
        </g>
      )}
    </g>
  );
}

/** Default marker size factors (in stroke widths) - the values the renderer
 *  used historically when `markerUnits="strokeWidth"`. We now always render
 *  in `userSpaceOnUse`, but when the user hasn't picked an explicit size we
 *  multiply these factors by the connector's stroke width so existing
 *  diagrams render byte-identical to the pre-decouple behaviour. */
const MARKER_DEFAULT_FACTOR: Record<Exclude<EndpointMarker, 'none'>, number> = {
  'hollow-triangle': 10,
  'hollow-diamond': 10,
  slash: 7,
  arrow: 7,
  triangle: 7,
  diamond: 7,
  dot: 5,
  circle: 5,
};

/** Resolve the rendered marker size (user-space px) for a given marker kind +
 *  connector stroke width + optional explicit override. Centralised so the
 *  renderer and the inspector slider's "auto" thumb position agree. */
export function resolveMarkerSize(
  kind: Exclude<EndpointMarker, 'none'>,
  strokeWidth: number,
  override: number | undefined,
): number {
  if (override !== undefined) return override;
  return strokeWidth * MARKER_DEFAULT_FACTOR[kind];
}

/** Single endpoint marker definition. The viewBox is fixed at `0 0 10 10`,
 *  with the *tip* sitting at refX (where the line meets the marker) and the
 *  marker facing the line outward. The marker size is always resolved in
 *  user-space px so it's fully decoupled from `strokeWidth` - when no
 *  explicit size is given we fall back to `strokeWidth × factor` (preserves
 *  legacy visuals). */
function Marker({
  id,
  kind,
  tipAligned,
  stroke,
  strokeWidth,
  size,
  orient,
}: {
  id: string;
  kind: EndpointMarker;
  tipAligned?: boolean;
  stroke: string;
  strokeWidth: number;
  /** User-space px override. Undefined = `strokeWidth × kind-default-factor`. */
  size: number | undefined;
  /** Facing, in degrees, measured by the caller from the line's own geometry
   *  over the span this marker covers - see `polylineEndDirection`. Falls
   *  back to SVG's endpoint tangent when the caller has nothing to measure. */
  orient: string | undefined;
}) {
  if (kind === 'none') return null;
  const px = resolveMarkerSize(kind, strokeWidth, size);
  // For the filled triangle, pull refX into the marker body just enough
  // that the arrow's half-height at refX equals the line's half-stroke.
  // Without this, the line's stroke-cap (`strokeWidth` tall) pokes through
  // the triangle's zero-height tip as a visible stub. Geometry:
  //   half-height(x) = (10 - x) / 2  in viewBox units
  //                  = (10 - x) * px / 20  in user units
  //   set equal to strokeWidth / 2 → refX = 10 - 10 * strokeWidth / px.
  // Capped at 0 so a thick line on a tiny marker doesn't pull refX negative.
  const taperedRefX = Math.max(
    0,
    10 - (10 * strokeWidth) / Math.max(px, 0.0001),
  );
  const common = {
    id,
    viewBox: '0 0 10 10',
    markerUnits: 'userSpaceOnUse' as const,
    orient: orient ?? 'auto-start-reverse',
    markerWidth: px,
    markerHeight: px,
  };
  if (kind === 'arrow') {
    // Open two-stroke chevron. Two separate <path> elements (rather than
    // one M-L-L path) so each stroke renders its own round cap; the
    // overlapping caps at (10, 5) close the tip cleanly. Stroke-width in
    // viewBox units is computed so the rendered chevron is ~1× the
    // connector strokeWidth in user space, regardless of marker-size
    // override. `overflow="visible"` lets the round caps spill the
    // half-stroke past the viewBox without clipping. refX=10 → chevron
    // tip sits exactly at the line endpoint.
    const chevronW = (10 * strokeWidth) / Math.max(px, 0.0001);
    return (
      <marker {...common} refX={10} refY={5} overflow="visible">
        <path
          d="M 0 0 L 10 5"
          fill="none"
          stroke={stroke}
          strokeWidth={chevronW}
          strokeLinecap="round"
        />
        <path
          d="M 0 10 L 10 5"
          fill="none"
          stroke={stroke}
          strokeWidth={chevronW}
          strokeLinecap="round"
        />
      </marker>
    );
  }
  if (kind === 'hollow-triangle' || kind === 'hollow-diamond' || kind === 'slash') {
    const outlineWidth = (10 * strokeWidth) / Math.max(px, .0001);
    const d = kind === 'hollow-triangle' ? 'M 0 0 L 10 5 L 0 10 Z' : kind === 'hollow-diamond' ? 'M 0 5 L 5 0 L 10 5 L 5 10 Z' : 'M 3 0 L 7 10';
    return <marker {...common} refX={kind === 'slash' ? 5 : 10} refY={5} overflow="visible"><path d={d} fill={kind === 'slash' ? 'none' : 'var(--paper)'} stroke={stroke} strokeWidth={outlineWidth} strokeLinejoin="miter" /></marker>;
  }
  if (kind === 'triangle') {
    return (
      <marker {...common} refX={taperedRefX} refY={5}>
        <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
      </marker>
    );
  }
  if (kind === 'dot') {
    return (
      <marker {...common} refX={5} refY={5}>
        <circle cx={5} cy={5} r={3.5} fill={stroke} />
      </marker>
    );
  }
  if (kind === 'circle') {
    return (
      <marker {...common} refX={tipAligned ? 9.25 : 5} refY={5}>
        <circle
          cx={5}
          cy={5}
          r={3.5}
          fill="var(--paper)"
          stroke={stroke}
          strokeWidth={1.5}
        />
      </marker>
    );
  }
  if (kind === 'diamond') {
    return (
      <marker {...common} refX={tipAligned ? 10 : 5} refY={5}>
        <path d="M 0 5 L 5 0 L 10 5 L 5 10 z" fill={stroke} />
      </marker>
    );
  }
  return null;
}

export const Connector = memo(ConnectorImpl);
