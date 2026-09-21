import type { Connector, Shape } from '@/store/types';
import { shapeSupportsRotation } from './projection';
import {
  connectorPolyline,
  pointAtFraction,
  resolveConnectorPath,
} from './routing';

type Point = { x: number; y: number };

type MeasurementsOverlayProps = {
  /** Shapes that passed the active layer filter. */
  shapes: Shape[];
  /** Connectors that passed the active layer + endpoint visibility filter. */
  connectors: Connector[];
  /** Full shape list used to resolve connector endpoints. */
  allShapes: Shape[];
  zoom: number;
};

/** Measurements stay readable without implying false sub-tenth precision.
 *  Whole values render without a trailing decimal; transformed/imported
 *  geometry can still surface one decimal place when it is meaningful. */
export function formatPixelValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function shapeMeasurementLabel(
  shape: Pick<Shape, 'w' | 'h'>,
): string {
  return `${formatPixelValue(shape.w)} × ${formatPixelValue(shape.h)} px`;
}

/** Bottom-centre of the shape's visual axis-aligned bounds. Rotation does
 *  not change the stored width/height measurement, but it can push a corner
 *  below the unrotated box; accounting for that keeps the badge outside the
 *  painted object. */
export function shapeMeasurementPosition(
  shape: Shape,
  zoom: number,
): Point {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const supportsRotation = shapeSupportsRotation(shape);
  const degrees =
    supportsRotation && Number.isFinite(shape.rotation)
      ? shape.rotation ?? 0
      : 0;
  const radians = (degrees * Math.PI) / 180;
  const halfW = Math.abs(shape.w) / 2;
  const halfH = Math.abs(shape.h) / 2;
  const visualHalfHeight =
    Math.abs(halfW * Math.sin(radians)) +
    Math.abs(halfH * Math.cos(radians));

  // Icons/images put their names below by default, and any shape can opt in
  // to a bottom/outside-bottom label. Clear the full text block before the
  // measurement badge rather than covering the caption. Font geometry stays
  // in world units; only the final breathing room is screen-stable.
  const labelAnchor =
    shape.labelAnchor ??
    (shape.kind === 'icon' || shape.kind === 'image' ? 'below' : 'center');
  const hasBottomLabel =
    labelAnchor === 'below' ||
    labelAnchor === 'outside-bottom-left' ||
    labelAnchor === 'outside-bottom-right';
  const bodyBearing =
    shape.kind === 'rect' ||
    shape.kind === 'ellipse' ||
    shape.kind === 'diamond' ||
    shape.kind === 'polygon' ||
    shape.kind === 'note' ||
    shape.kind === 'service';
  const basicShape =
    shape.kind === 'rect' ||
    shape.kind === 'ellipse' ||
    shape.kind === 'diamond' ||
    shape.kind === 'polygon';
  const body = shape.body?.trim();
  const label = shape.label?.trim();
  const promoteBody =
    hasBottomLabel &&
    bodyBearing &&
    Boolean(body) &&
    (basicShape || !label);
  const bottomText = hasBottomLabel ? (promoteBody ? body : label) : undefined;
  const lineCount = bottomText ? bottomText.split('\n').length : 0;
  const fontSize =
    shape.fontSize ?? (shape.kind === 'note' || shape.layer === 'notes' ? 18 : 13);
  const labelClearance =
    lineCount > 0 ? lineCount * fontSize * 1.15 + 4 / safeZoom : 0;

  return {
    x: cx,
    y: cy + visualHalfHeight + labelClearance + 16 / safeZoom,
  };
}

/** Length of the logical routed centreline rather than the endpoint chord.
 *  Waypoints, orthogonal elbows, and sampled curves are all included; marker
 *  setbacks and cosmetic corner rounding intentionally do not change the
 *  diagram-space size of the connector. */
export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += Math.hypot(
      points[i + 1].x - points[i].x,
      points[i + 1].y - points[i].y,
    );
  }
  return total;
}

/** Label text + midpoint + a stable unit normal for placing the badge just
 *  off the route. Prefer the upper side (or left side for vertical runs) so
 *  reversing a connector does not make its measurement jump across it. */
export function polylineMeasurement(
  points: Point[],
): { label: string; point: Point; normal: Point } | null {
  if (points.length === 0) return null;
  const point = pointAtFraction(points, 0.5);
  const before = pointAtFraction(points, 0.49);
  const after = pointAtFraction(points, 0.51);
  let dx = after.x - before.x;
  let dy = after.y - before.y;
  let tangentLength = Math.hypot(dx, dy);

  // A midpoint can land on a run of duplicate points. Fall back to the first
  // non-degenerate segment so the label still clears the route.
  if (tangentLength === 0) {
    for (let i = 0; i < points.length - 1; i += 1) {
      dx = points[i + 1].x - points[i].x;
      dy = points[i + 1].y - points[i].y;
      tangentLength = Math.hypot(dx, dy);
      if (tangentLength > 0) break;
    }
  }

  let normal =
    tangentLength > 0
      ? { x: -dy / tangentLength, y: dx / tangentLength }
      : { x: 0, y: -1 };
  if (normal.y > 0 || (Math.abs(normal.y) < 0.001 && normal.x > 0)) {
    normal = { x: -normal.x, y: -normal.y };
  }

  return {
    label: `${formatPixelValue(polylineLength(points))} px`,
    point,
    normal,
  };
}

export function connectorMeasurement(
  connector: Connector,
  shapes: Shape[],
): { label: string; point: Point; normal: Point } | null {
  const path = resolveConnectorPath(connector, shapes);
  if (!path) return null;

  const points = connectorPolyline(
    connector,
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
  return polylineMeasurement(points);
}

/** Non-interactive canvas chrome for the kebab-menu Measurements option.
 *  It is as a direct child of the pan/zoom content group, so export's
 *  existing chrome scrub removes it automatically. Badge dimensions divide
 *  by zoom to remain a steady screen size while their anchors stay in world
 *  coordinates and follow live resize/reroute updates. */
export function MeasurementsOverlay({
  shapes,
  connectors,
  allShapes,
  zoom,
}: MeasurementsOverlayProps) {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  return (
    <g
      data-vellum-measurements=""
      pointerEvents="none"
      aria-hidden="true"
    >
      {shapes.map((shape) => {
        const position = shapeMeasurementPosition(shape, safeZoom);
        return (
          <MeasurementBadge
            key={`shape-measurement-${shape.id}`}
            x={position.x}
            y={position.y}
            label={shapeMeasurementLabel(shape)}
            zoom={safeZoom}
          />
        );
      })}
      {connectors.map((connector) => {
        const measurement = connectorMeasurement(connector, allShapes);
        if (!measurement) return null;
        // A connector's own text label sits on the route midpoint. Give the
        // measurement extra clearance when both labels share that area.
        const gap = (connector.label?.trim() ? 24 : 13) / safeZoom;
        return (
          <MeasurementBadge
            key={`connector-measurement-${connector.id}`}
            x={measurement.point.x + measurement.normal.x * gap}
            y={measurement.point.y + measurement.normal.y * gap}
            label={measurement.label}
            zoom={safeZoom}
          />
        );
      })}
    </g>
  );
}

export function MeasurementBadge({
  x,
  y,
  label,
  zoom,
}: {
  x: number;
  y: number;
  label: string;
  zoom: number;
}) {
  const fontSize = 10 / zoom;
  const height = 18 / zoom;
  // The label uses the mono font, so a small character-width estimate gives
  // the backdrop a stable fit without a DOM measurement pass per object.
  const width = (label.length * 6.2 + 12) / zoom;

  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={4 / zoom}
        fill="var(--bg-overlay)"
        fillOpacity={0.94}
        stroke="var(--border)"
        strokeWidth={0.75 / zoom}
      />
      <text
        x={0}
        y={0}
        fill="var(--fg)"
        fontFamily="var(--font-mono)"
        fontSize={fontSize}
        fontWeight={500}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {label}
      </text>
    </g>
  );
}
